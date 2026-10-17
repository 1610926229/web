import type { DispatchRepository } from "../dispatchRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";
// ⚠️ `dispatch_records` 的列清单与行 → 领域对象映射从 `w1Rows.ts` 取，**不在这里再写一份**：
// 本轮接单事务（`w1Transactions.ts`）也要读写这张表。
import { DISPATCH_COLUMNS as COLUMNS, toDispatch, type DispatchRow } from "./w1Rows";

/**
 * `DispatchRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/dispatchRepository.ts` 里的接口一个字没改，
 * 服务层、路由、页面都不知道底下换了一个存储。这是 PROD-1B 要证明的
 * 「同一套契约、两个实现」。
 *
 * ## 这一版**只翻译两个读方法**
 *
 * 接口上只有 `listOpenDispatches()` 与 `findDispatchByOrderId()`，因为派单的
 * **每一次写入都发生在原子区段里**（接单要同时改派单与订单、超时清扫要同时改派单
 * 与订单与通知）。那些写入入口是 `mockDispatchRepository` 导出的同步写原语，
 * 由伪事务调用——本文件**刻意不翻译它们**（`createDispatchRecord` /
 * `applyDispatchAccepted` / `applyDispatchToPublic` / `applyDispatchTimedOut`）。
 * 在这里补一个 `updateDispatch()` 就等于开出第二条写入路径，而那条路径没有原子区段、
 * 没有「一个订单只有一条派单记录」的不变量。
 *
 * ## 排序必须自己补，不能依赖 SQL 的偶然顺序
 *
 * Mock 的两处读都是「遍历 Map 的插入顺序」。SQL 表是无序集合，同一份数据两次查询
 * 完全可能给出不同顺序。分页与接单榜都要求顺序确定，因此这里显式补上
 * `ORDER BY id`（派单 id 是主键，天然唯一，是最稳的兜底）——
 * ⚠️ 这会与 Mock 的「插入顺序」不同，是**有意的取舍**：请勿依赖具体先后，
 * 只依赖「同一份数据顺序稳定」。
 *
 * ## 时间类型
 *
 * `created_at` / `updated_at` 等是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成
 * ISO 字符串，因此 `DispatchRecord` 上的时间字段仍然是 `string`，与 Mock 完全一致。
 */

/**
 * 用任意可执行 SQL 的对象造一个派单仓储。
 *
 * **同一个工厂同时产出两种仓储**，这是本层最重要的设计点：
 *
 * - 传进程级执行器 → 普通仓储，每条语句自动提交；
 * - 传 `withTransaction` 给出的 `TxHandle` → **事务内仓储**，与同一事务里的其它写入
 *   共享同一条连接、同一个提交点（接单事务要在同一段里读它、写它）。
 *
 * 两边的接口完全一样，调用方**不需要换一套 API**，只要把 `tx` 传进来。
 */
export function createDispatchRepository(db: PgQueryable): DispatchRepository {
  return {
    async listOpenDispatches() {
      // 两种「还在等人接」的池子。已接 / 已关闭的不进池子列表——
      // 「能被接的单」只有这两类，多带一类就会有人对着一张已接的单再点一次接单。
      // ⚠️ `ORDER BY id` 是**兜底**：Mock 用的是 Map 插入顺序，SQL 没有那层含义，
      //    不补排序则同一份数据两次查询顺序可能不同。
      const rows = await db.query<DispatchRow>(
        `SELECT ${COLUMNS}
           FROM dispatch_records
          WHERE state IN ('exclusive', 'public')
          ORDER BY id`,
      );
      return rows.map(toDispatch);
    },

    async findDispatchByOrderId(orderId) {
      // `order_id` 上有唯一约束（一个订单只有一条派单记录），因此最多一行。
      // 查不到返回 null **是正常情况**：退款订单、管理员手动退款的订单都可能没有派单记录。
      const rows = await db.query<DispatchRow>(
        `SELECT ${COLUMNS} FROM dispatch_records WHERE order_id = $1`,
        [orderId],
      );
      return rows[0] ? toDispatch(rows[0]) : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 * 理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgDispatchRepository: DispatchRepository = createDispatchRepository(lazyPgExecutor());
