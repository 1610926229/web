import { Pool, types } from "pg";
import { describeConnection, PgConfigError, redactDatabaseUrl, requireDatabaseUrl } from "./config";

/**
 * PostgreSQL 连接池（**仅服务端**，进程内单例）。
 *
 * ## 时区：模块加载时的一次全局覆盖（C8 裁定）
 *
 * PostgreSQL 的 `timestamptz` 存的是 UTC，但驱动默认把它解析成 JS 的 `Date`。
 * 一旦 `Date` 漏进业务层，`compareFavoritesNewestFirst` 那种 `a.createdAt < b.createdAt`
 * 的字典序比较就会**静默失效**（两个 `Date` 相比得到 `false`，排序退化成原顺序，
 * 既不报错也不抛错）。所以这里把 1184（TIMESTAMPTZ）的解析器全局改成返回 ISO 字符串，
 * 让仓储边界上的类型与 Mock 实现**完全一致（都是 string）**，上层一个字都不用改。
 *
 *     '2026-09-12T21:18:00.000Z'::timestamptz  →  "2026-09-12T21:18:00.000Z"
 *
 * 写入侧本来就是 ISO 字符串、毫秒精度，因此这是**字节级往返**，不是有损转换。
 * `toISOString()` 固定输出 3 位小数且带 `Z`，定长 + UTC，字典序即时间序。
 *
 * ⚠️ 这是一次**模块级的全局覆盖**：本进程里所有 `pg` 客户端的 1184 都变成字符串。
 *    代价可接受（本仓只有这一处数据库访问），换来的是「时间在边界上永远是 string」这条不变量。
 *    ⚠️ 刻意**不**注册 1114（不带时区的 `timestamp`）：那正是被禁用的列类型，
 *    让它退回 `Date` 反而能在第一次读到时就露馅，而不是假装正常。
 *
 * ## 连接策略（开发 / 测试 / 生产）
 *
 * | 环境 | 池大小默认 | 说明 |
 * |---|---|---|
 * | 生产 | 10 | 按并发请求数给足 |
 * | 开发 / 测试 | 4 | 本地可能同时开着 dev server 与测试进程，池子小一点不容易把连接数用光 |
 *
 * 四个超时都是**显式**的，不依赖驱动的默认值：`connectionTimeoutMillis` 让「库挂了」
 * 在 5 秒内变成一条明确的错误，而不是一个永远挂着的请求；`statement_timeout` 挡住
 * 一条慢查询拖死整个池子；`idle_in_transaction_session_timeout` 挡住
 * 「BEGIN 之后忘了提交」的事务长期占着连接与锁。
 *
 * 三个数值都可以用环境变量覆盖（`PG_POOL_MAX` / `PG_CONNECT_TIMEOUT_MS` /
 * `PG_STATEMENT_TIMEOUT_MS`）。
 */

/** 应用名会出现在 `pg_stat_activity` 里：出问题时能一眼看出连接是谁开的。 */
const APPLICATION_NAME = "chaoge-esports";

types.setTypeParser(types.builtins.TIMESTAMPTZ, (value: string) => new Date(value).toISOString());

let pool: Pool | null = null;

function readPositiveInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function defaultPoolMax(): number {
  // 生产按并发给足；开发/测试共用一台本地库，池子小一点更安全
  const fallback = process.env["NODE_ENV"] === "production" ? 10 : 4;
  return readPositiveInt("PG_POOL_MAX") ?? fallback;
}

/**
 * 取进程级连接池。第一次调用时才真正建池——**模块加载本身不连库**。
 *
 * 这一点是刻意的：`favoriteRepository.ts` 这类文件会静态 import 本模块，
 * 若在 import 期就连库，那么「没配数据库」的普通构建与测试会被连带拖垮。
 * 建池推迟到第一次真正要用的时候，`DATABASE_URL` 缺失就在那一刻 fail-fast。
 */
export function getPool(): Pool {
  if (pool) return pool;

  const url = requireDatabaseUrl();
  const created = new Pool({
    connectionString: url,
    max: defaultPoolMax(),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: readPositiveInt("PG_CONNECT_TIMEOUT_MS") ?? 5_000,
    statement_timeout: readPositiveInt("PG_STATEMENT_TIMEOUT_MS") ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: APPLICATION_NAME,
  });

  // ⚠️ 没有这个监听，空闲连接被数据库单方面掐断时（重启、超时、管理员 kill），
  //    `error` 事件没有接收者，Node 会直接让整个进程退出。
  created.on("error", (error) => {
    console.error(`[pg] 空闲连接出错（${redactDatabaseUrl(url)}）：${error.message}`);
  });

  pool = created;
  return created;
}

/** 关掉连接池。进程退出前、以及测试里需要换库前必须调用。 */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

/**
 * 探测「能不能连上」，连不上时抛出**脱敏后**的明确错误。
 *
 * 与 `health.ts` 的分工：那边返回结构化的健康状态（给人和运维看，不抛错），
 * 这里抛错（给「必须连上才能继续」的调用方用，例如 migrate）。
 */
export async function assertConnectable(): Promise<void> {
  const url = requireDatabaseUrl();
  try {
    await getPool().query("SELECT 1");
  } catch (error) {
    throw new PgConfigError(describeConnection(url, error));
  }
}
