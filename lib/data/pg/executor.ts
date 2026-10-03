import type { Pool, PoolClient } from "pg";
import { getPool } from "./pool";

/**
 * 数据库执行器：把「进程级的一次查询」与「一个事务里的多条语句」收敛成**同一个形状**。
 *
 * ## 为什么要有这一层，而不是让仓储直接调 `pool.query`
 *
 * 因为 `C1` 指出的最大迁移风险不是「SQL 怎么写」，而是**并发模型变了**：
 * Mock 的原子性来自「Node 单线程 + 区段内没有 `await`」，换成数据库后那段代码
 * 里的每个查询都会让出执行权，区段不再原子。唯一正确的替代是**数据库事务**。
 *
 * 于是仓储需要能在两种执行环境里跑同一份实现：
 *
 * - **进程级**：单条语句，自带连接池的自动提交（`pgExecutor.query`）；
 * - **事务内**：一段「读—判断—写」必须整体成功或整体失败的逻辑（`withTransaction(async tx => …)`）。
 *
 * 两者都满足 `PgQueryable`，所以 `createFavoriteRepository(db: PgQueryable)` 这一个工厂
 * 就能同时产出「普通仓储」和「事务内仓储」，**契约一个字都不变**——
 * 这正是 PROD-1A 要证明的第 15 条。
 *
 * ## `query` 返回 `T[]` 而不是驱动的 `QueryResult`
 *
 * 上层只会用到行数组；行数用 `rows.length` 就够了（删除类语句走 `RETURNING`，
 * 不需要单独读 `rowCount`）。把驱动的返回值直接透出去会让 `rowCount: number | null`
 * 这种细节漏进每一个调用点。
 */

/** 能执行 SQL 的最小面。`Pool`、`PoolClient`（事务句柄）都满足它。 */
export type PgQueryable = {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<T[]>;
};

/**
 * 事务句柄。
 *
 * ⚠️ `connectionId` 不是调试用的装饰：一次 `withTransaction` 里的所有语句
 * **必须走同一条连接**，否则 `BEGIN` 开在一条连接上、`COMMIT` 提交在另一条上，
 * 事务根本不存在。它是这条不变量的可观测证明（`pg_backend_pid()`）——
 * 测试拿它来断言「同一个事务 = 同一个连接」，而不是靠读代码相信。
 */
export type TxHandle = PgQueryable & { readonly connectionId: number };

export type PgExecutor = PgQueryable & {
  /** 把一段逻辑放进一个数据库事务。回调抛错 → 整体回滚；正常返回 → 提交。 */
  withTransaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T>;
};

/**
 * 取底层连接在后端的进程号。
 *
 * ⚠️ `processID` 是 `pg` 的**运行时**属性（等于 `pg_backend_pid()`），
 * 但 `@types/pg` 没有为它声明类型（它只声明在连接参数那一侧，名字还叫 `processId`）。
 * 这里显式收窄而不是把整个 client 断言成 `any`——属性名写错时能立刻看出来。
 */
function backendPidOf(client: PoolClient): number {
  const pid = (client as unknown as { processID?: number }).processID;
  return typeof pid === "number" ? pid : -1;
}

function createQueryable(client: Pool | PoolClient): PgQueryable {
  return {
    async query<T>(text: string, values?: readonly unknown[]): Promise<T[]> {
      // readonly unknown[] 不能直接喂给驱动（它要的是可变数组），拷一份最省心
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as T[];
    },
  };
}

function createExecutor(pool: Pool): PgExecutor {
  return {
    ...createQueryable(pool),

    async withTransaction<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let released = false;

      // 归还连接必须幂等：回滚失败要把连接**销毁**，正常路径要把连接**还回池子**，
      // 而「出错」与「提交后」两条路都会走到这里。
      const release = (error?: Error): void => {
        if (released) return;
        released = true;
        client.release(error);
      };

      try {
        await client.query("BEGIN");
      } catch (error) {
        // BEGIN 都没成功：这条连接的状态是未知的，销毁它，不能还给池子
        release(error as Error);
        throw error;
      }

      let result: T;
      try {
        result = await fn({ ...createQueryable(client), connectionId: backendPidOf(client) });
      } catch (error) {
        try {
          await client.query("ROLLBACK");
          release();
        } catch (rollbackError) {
          // 回滚本身失败 → 连接状态未知，销毁它
          release(rollbackError as Error);
        }
        // ⚠️ 抛**原始**错误。回滚失败是次生故障，调用方要看的成因是业务错误那一个；
        //    把它换成回滚错误会让人去查一个根本不是原因的地方。
        throw error;
      }

      try {
        await client.query("COMMIT");
      } catch (error) {
        // 提交阶段失败（例如唯一约束在 COMMIT 时才发现、连接断开）：事务没有生效
        release(error as Error);
        throw error;
      }

      release();
      return result;
    },
  };
}

let executor: PgExecutor | null = null;
let executorPool: Pool | null = null;

/**
 * 进程级执行器。与连接池一样**延迟初始化**——模块加载不连库。
 *
 * ⚠️ 它只在第一次真正执行语句时才去验 `DATABASE_URL`，因此
 * 「没配数据库」的构建与普通测试不会被 import 本身拖垮。
 *
 * ⚠️ 执行器**跟着池子走**：`closePool()` 之后 `getPool()` 会建一个新池，
 * 这时旧执行器抱着的是一条已经 `end()` 的池子，任何查询都会报
 * 「Cannot use a pool after calling end」。按对象身份比对就能自动跟上，
 * 不需要额外暴露一个「重置执行器」的函数给调用方记得去调。
 */
export function getPgExecutor(): PgExecutor {
  const current = getPool();
  if (!executor || executorPool !== current) {
    executor = createExecutor(current);
    executorPool = current;
  }
  return executor;
}

/**
 * 延迟解析的执行器：把「取执行器」推迟到**每次调用**的时候。
 *
 * ⚠️ 这是让仓储可以写成模块级常量（`export const pgFavoriteRepository = …`）的关键。
 * 若在模块加载期就调 `getPgExecutor()`，它会立刻去验 `DATABASE_URL` 并建池——
 * 而 `lib/data/favoriteRepository.ts` 是**静态 import** 这个模块的，
 * 于是任何一次 import（包括没配数据库的构建与测试）都会被拖垮。
 *
 * 代价是每次调用多一层转发，可以忽略；换来的是「模块加载不产生任何副作用」。
 */
export function lazyPgExecutor(): PgExecutor {
  return {
    query: (text, values) => getPgExecutor().query(text, values),
    withTransaction: (fn) => getPgExecutor().withTransaction(fn),
  };
}
