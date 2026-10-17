import type {
  CompanionServiceEvent,
  DerivedServiceEvent,
} from "@/lib/types/companionService";
import type { CompanionServiceRepository } from "../companionServiceRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CompanionServiceRepository` 的 PostgreSQL 实现（PROD-1B · W1）。
 *
 * ## 为什么这里只有读方法，没有 `createServiceEvent()`
 *
 * 服务事件**只在原子区段里诞生**：写它的那一刻必须同时把订单推进到 `serving`
 * 并写下 `servingAt`——少一件，系统就进入自相矛盾的状态（订单说「服务中」而历史里
 * 没有那次服务）。那些区段不能有 `await`，因此写入入口不在本接口上，而在
 * `mockCompanionServiceRepository.ts` 导出的同步写原语 `appendCompanionService()`，
 * 由 `companionOrderTransaction.ts` 的伪事务调用。在接口上开一个 `createServiceEvent()`
 * 就等于开出第二条没有原子区段、也没有「同一 assignment 只记一次」约束的写入路径。
 *
 * ## 两份数据故意分开
 *
 * - `listServiceEvents()`：表里**真的发生过、真的被记下来的**历史；
 * - `listLegacyServiceEvents()`：存量数据里**仍然写得明明白白**的那一次
 *   （订单当前/最终的 `servingAt` + `actualCompanionId`），由读取侧**派生**。
 *
 * 两者形状相近但语义不同，调用方要并集，测试要能分开断言——否则无法区分
 * 「事件真的写进去了」与「碰巧被派生补上了」。派生是**读时不写入**的：
 * 它描述的是存量数据的可获得性，写进表里就等于把「读一次多一条」变成持久化副作用。
 *
 * ## 排序：Mock 没有定义顺序，这里必须自己定一个确定的
 *
 * ⚠️ Mock 两个方法都直接返回 `Map.values()`（插入顺序），**没有调用 `.sort()`**。
 * 插入顺序在 SQL 里**没有对应物**，而「不加 `ORDER BY`」的结果由执行计划决定、
 * 不可复现。因此这里补一个确定且语义自然的顺序：`serving_at ASC, id ASC`。
 * 消费者（`buildCompanionUsage`）本来就是做去重与聚合的并集，不依赖跨来源的相对顺序；
 * 但下一条读这条历史的语句需要一个可复现的行序，这里给它。
 *
 * ## 时间
 *
 * `serving_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成 ISO 字符串，
 * 因此事件上的时间字段仍然是 `string`。派生行的时间直接取自 `orders.serving_at`，
 * 与 Mock 从订单快照读出的是同一个字段。
 */

type CompanionServiceRow = {
  id: string;
  order_id: string;
  companion_id: string;
  dispatch_id: string | null;
  serving_at: string;
  companion_name: string;
  companion_avatar_url: string;
};

type LegacyServiceRow = {
  order_id: string;
  actual_companion_id: string;
  serving_at: string;
  dispatch_id: string | null;
  companion: unknown;
};

const COLUMNS =
  "id, order_id, companion_id, dispatch_id, serving_at, companion_name, companion_avatar_url";

function toCompanionServiceEvent(row: CompanionServiceRow): CompanionServiceEvent {
  return {
    id: row.id,
    orderId: row.order_id,
    companionId: row.companion_id,
    dispatchId: row.dispatch_id,
    servingAt: row.serving_at,
    companionName: row.companion_name,
    companionAvatarUrl: row.companion_avatar_url,
  };
}

/**
 * 从订单的 `companion` jsonb 快照里取公开信息。
 *
 * 与 Mock 的 `order.companion?.name ?? ""` / `?? ""` 等价：快照整个缺失、
 * 或字段不是字符串时，**如实给空串**，由展示层回落到中性文案，
 * 而不是凭空造一个名字（不猜）。
 */
function readCompanionSnapshot(value: unknown): { name: string; avatarUrl: string } {
  if (value !== null && typeof value === "object") {
    const snapshot = value as { name?: unknown; avatarUrl?: unknown };
    return {
      name: typeof snapshot.name === "string" ? snapshot.name : "",
      avatarUrl: typeof snapshot.avatarUrl === "string" ? snapshot.avatarUrl : "",
    };
  }
  return { name: "", avatarUrl: "" };
}

/**
 * 用任意可执行 SQL 的对象造一个服务事件仓储。
 *
 * 与收藏 / 反馈同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储。
 */
export function createCompanionServiceRepository(
  db: PgQueryable,
): CompanionServiceRepository {
  return {
    async listServiceEvents() {
      const rows = await db.query<CompanionServiceRow>(
        `SELECT ${COLUMNS} FROM companion_service_events ORDER BY serving_at ASC, id ASC`,
      );
      return rows.map(toCompanionServiceEvent);
    },

    async listLegacyServiceEvents() {
      // `orders.serving_at` 只保留**当前/最终**那位打手，因此对历史上换过人的存量单，
      // 这里只能派生出**最后**那一位——这正是产品裁定说的「允许是 lower-bound」。
      //
      // ⚠️ 不过滤订单状态：一张服务过、后来全额退款的订单状态是 `refunded`，
      // 但 `serving_at` / `actual_companion_id` 都还在，**照常派生**
      //（「退款影响钱，不改写『这个人曾经服务过我』」）。
      //
      // `dispatch_records.order_id` 上有唯一约束，因此 LEFT JOIN 至多匹配一行，
      // 不会让一条订单派生出两条。
      const rows = await db.query<LegacyServiceRow>(
        `SELECT o.id AS order_id,
                o.actual_companion_id,
                o.serving_at,
                d.id AS dispatch_id,
                o.companion
           FROM orders o
           LEFT JOIN dispatch_records d ON d.order_id = o.id
          WHERE o.serving_at IS NOT NULL
            AND o.actual_companion_id IS NOT NULL
          ORDER BY o.serving_at ASC, o.id ASC`,
      );

      return rows.map((row): DerivedServiceEvent => {
        const snapshot = readCompanionSnapshot(row.companion);
        return {
          orderId: row.order_id,
          companionId: row.actual_companion_id,
          dispatchId: row.dispatch_id,
          servingAt: row.serving_at,
          companionName: snapshot.name,
          companionAvatarUrl: snapshot.avatarUrl,
        };
      });
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、
 * 不建池。理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCompanionServiceRepository: CompanionServiceRepository =
  createCompanionServiceRepository(lazyPgExecutor());
