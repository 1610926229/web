import type { CompanionAcceptEvent, DerivedAcceptEvent } from "@/lib/types/companionAccept";
import type { CompanionAcceptRepository } from "../companionAcceptRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CompanionAcceptRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/companionAcceptRepository.ts` 的接口一个字没改。
 *
 * ## 这一版**只翻译两个读方法**
 *
 * 接口上只有 `listAcceptEvents()` 与 `listLegacyAcceptEvents()`。接单事件的写入是
 * **原子区段里的事**（它必须与派单被接走、订单变 `accepted`、通知用户在同一段无 `await`
 * 的代码里完成），入口是 `mockCompanionAcceptRepository` 导出的同步写原语
 * `appendCompanionAccept()`。本文件**刻意不**在这里开一个 `createAcceptEvent()`——
 * 那会变成第二条写入路径，没有原子区段、也没有「同一次接单只写一条」的约束。
 *
 * ## `listLegacyAcceptEvents` 是**读时派生**，不是第二份历史
 *
 * Mock 的 `deriveLegacyAcceptEvents()` 从**派单记录**上把「存量数据里仍然写得明明白白
 * 的那一次接单」读出来：只对 `state === 'accepted'` 且 `accepted_via === 'companion'`
 * 的记录派生一条。SQL 用等价的 `WHERE` 表达，**不写事件表**——
 * 写进去就等于把「读一次多一条」变成持久化副作用。
 *
 * ⚠️ 三个 `accepted_via` 取值刻意不同：`'companion'` 派生、`'staff'` **不派生**
 * （客服直换不是打手的主动接单行为）、`null` **也不派生**（认不出来源就不猜）。
 * 这条保守方向是产品裁定，不是缺陷——宁可让存量接单榜是历史下界。
 *
 * ## 排序
 *
 * Mock 两处都是「遍历 Map 的插入顺序」（事件表只增不改，插入顺序≈接单时间序）。
 * SQL 表无序，因此显式补 `ORDER BY`：事件表用 `accepted_at, id`，派生查询用 `id`。
 * 两次查询同一份数据顺序必然一致；请勿依赖具体先后。
 *
 * ## 时间类型
 *
 * `accepted_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成 ISO 字符串，
 * 因此 `acceptedAt` 仍然是 `string`。
 */

type AcceptEventRow = {
  id: string;
  dispatch_id: string;
  order_id: string;
  companion_id: string;
  accepted_at: string;
};

const COLUMNS = "id, dispatch_id, order_id, companion_id, accepted_at";

function toAcceptEvent(row: AcceptEventRow): CompanionAcceptEvent {
  return {
    id: row.id,
    dispatchId: row.dispatch_id,
    orderId: row.order_id,
    companionId: row.companion_id,
    acceptedAt: row.accepted_at,
  };
}

/**
 * 派生查询的行：`WHERE` 已经把两个可空列收窄成非空，
 * 因此这里把它们声明成 `string`，读出来即可直接构造 `DerivedAcceptEvent`。
 */
type LegacyAcceptRow = {
  id: string;
  order_id: string;
  accepted_by_companion_id: string;
  accepted_at: string;
};

/**
 * 用任意可执行 SQL 的对象造一个接单事件仓储。
 *
 * 与收藏 / 派单同构：**一个工厂产出普通仓储与事务内仓储两种**，接口完全相同。
 * 传 `withTransaction` 给出的 `TxHandle` 进来，就能让「读接单历史」与同一事务里的
 * 其它读取共享同一条连接、同一个快照。
 */
export function createCompanionAcceptRepository(db: PgQueryable): CompanionAcceptRepository {
  return {
    async listAcceptEvents() {
      // 全量、不分页、不按打手收窄：榜单要按打手聚合，查询本身就该是全量的。
      const rows = await db.query<AcceptEventRow>(
        `SELECT ${COLUMNS}
           FROM companion_accept_events
          ORDER BY accepted_at ASC, id ASC`,
      );
      return rows.map(toAcceptEvent);
    },

    async listLegacyAcceptEvents() {
      // 与 `deriveLegacyAcceptEvents()` 逐条件对齐：
      //   1. state === 'accepted'          → 读者必须把 state 当第一道闸
      //   2. acceptedByCompanionId 非空    → IS NOT NULL
      //   3. acceptedAt 非空               → IS NOT NULL
      //   4. acceptedVia === 'companion'   → 只派生打手自己接的那一种（见文件头注释）
      // 返回形状没有 id 列：`DerivedAcceptEvent` 的 id 由派单记录派生，不占用事件表 id 空间。
      const rows = await db.query<LegacyAcceptRow>(
        `SELECT id, order_id, accepted_by_companion_id, accepted_at
           FROM dispatch_records
          WHERE state = 'accepted'
            AND accepted_by_companion_id IS NOT NULL
            AND accepted_at IS NOT NULL
            AND accepted_via = 'companion'
          ORDER BY id`,
      );
      return rows.map(
        (row): DerivedAcceptEvent => ({
          dispatchId: row.id,
          orderId: row.order_id,
          companionId: row.accepted_by_companion_id,
          acceptedAt: row.accepted_at,
        }),
      );
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgCompanionAcceptRepository: CompanionAcceptRepository =
  createCompanionAcceptRepository(lazyPgExecutor());
