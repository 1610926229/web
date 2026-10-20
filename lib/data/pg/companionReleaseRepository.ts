import type {
  CompanionReleaseRecord,
  CompanionReleaseSource,
} from "@/lib/types/companionRelease";
import type { CompanionReleaseRepository } from "../companionReleaseRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `CompanionReleaseRepository` 的 PostgreSQL 实现（PROD-1B · W1）。
 *
 * ## 为什么这里只有读方法，没有 `createRelease()`
 *
 * 退出历史**只在原子区段里诞生**：写它的那一刻必须同时清掉订单的履约绑定、
 * 把派单打回公共池、给下单用户发通知——四件事少一件，系统就进入自相矛盾的状态
 * （订单说「等待接单」而派单还说「被 A 接了」）。那些区段不能有 `await`，
 * 因此写入入口不在本接口上，而在 `mockCompanionReleaseRepository.ts` 导出的
 * **同步写原语**，由 `companionOrderTransaction.ts` 的伪事务调用。在接口上开一个
 * `createRelease()` 就等于开出第二条写入路径——没有原子区段、没有幂等索引、
 * 也没有「同一次取消只能有一条记录」的约束。
 *
 * ## 幂等键不是实体字段
 *
 * `companion_release_records.idempotency_key` 是**调用方给的串**，Mock 里它只活在
 * store 的 `releaseIdByKey` 索引上，**不在** `CompanionReleaseRecord` 的七个字段里。
 * 因此这里显式列出七列，**不把它读进领域对象**——把它带上去等于让调用方
 * 往历史记录里塞任意内容，而历史记录应当只包含已经发生的事。
 *
 * ## 排序必须完全确定
 *
 * Mock 按 `createdAt` 正序、同刻用 `id` 兜底。SQL 的 `ORDER BY` 没有稳定排序的保证，
 * 必须把这层兜底写进语句——否则「谁先退的」这个本表唯一要回答的问题，
 * 会在同刻两条之间每次刷新给出不同答案。
 *
 * ## 时间
 *
 * `created_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子还原成 ISO 字符串，
 * 因此 `CompanionReleaseRecord.createdAt` 仍然是 `string`，与 Mock 一致。
 */

type CompanionReleaseRow = {
  id: string;
  order_id: string;
  companion_id: string;
  source: CompanionReleaseSource;
  reason: string | null;
  actor_id: string | null;
  created_at: string;
};

const COLUMNS = "id, order_id, companion_id, source, reason, actor_id, created_at";

function toCompanionRelease(row: CompanionReleaseRow): CompanionReleaseRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    companionId: row.companion_id,
    source: row.source,
    reason: row.reason,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个履约退出历史仓储。
 *
 * 与收藏 / 反馈同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储。
 * 退出历史本身只被读（写原语在 Mock 侧的伪事务里），但工厂形状保持一致，
 * 将来事务内要读它时不需要换 API。
 */
export function createCompanionReleaseRepository(
  db: PgQueryable,
): CompanionReleaseRepository {
  return {
    async listReleasesByOrderId(orderId) {
      // 只按 `orderId` 查、**不按打手收窄**：这个问题问的是「这一单上发生过什么」，
      // 而不是「某个打手干过什么」。谁看得到由路由层决定，不由本查询决定。
      const rows = await db.query<CompanionReleaseRow>(
        `SELECT ${COLUMNS} FROM companion_release_records
          WHERE order_id = $1
          ORDER BY created_at ASC, id ASC`,
        [orderId],
      );
      return rows.map(toCompanionRelease);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、
 * 不建池。理由见 `executor.ts` 的 `lazyPgExecutor`。
 */
export const pgCompanionReleaseRepository: CompanionReleaseRepository =
  createCompanionReleaseRepository(lazyPgExecutor());
