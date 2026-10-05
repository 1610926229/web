import { platformConfigSeed } from "@/lib/mocks/fixtures/platformConfigSeed";
import type { PlatformConfig } from "@/lib/types/platformConfig";
import { normalizePlatformConfig } from "../mockPlatformConfigRepository";
import type { PlatformConfigRepository } from "../platformConfigRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `PlatformConfigRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/platformConfigRepository.ts` 只有
 * 一个读方法 `getConfig()`，这里也**只有这一个方法**。平台参数的写入入口是
 * `lib/data/adminPlatformConfigTransaction.ts` 的伪事务（走 Mock 的同步写原语），
 * 不在本接口上——在这里加 `updateConfig()` 等于开出第二条没有幂等、没有审计的写入路径。
 *
 * ## 单行表
 *
 * `platform_config` 是单行表（`CHECK (id = 1)`），「读当前配置」因此是
 * `SELECT … WHERE id = 1`。没有 Map、没有查询条件、没有 id 参数——按定义只有一份。
 *
 * ## 读边界兜底：与 Mock 逐字对齐
 *
 * Mock 的 `readPlatformConfig()` 并不是「把存的对象原样返回」，它要经过
 * `normalizePlatformConfig()`：四个时长字段若缺失 / 非法就回退到默认值。
 * 这条兜底**只有一个真值源**，本文件直接复用同一个函数，不在这里重写一遍——
 * 重写会造出第二份「默认值是多少」的答案，两处迟早分叉。
 *
 * ⚠️ **读不到行时与 Mock 完全一致**：Mock 的 store 恒不为 null
 * （`createStore()` 用 `normalizePlatformConfig(platformConfigSeed)` 建仓），
 * 因此「没有任何配置记录」在 Mock 里表现为**预置值**而不是空值。
 * 这里照抄同一行为：查不到行就取预置值，再走同一个归一化函数。
 * 刻意**不**抛错、也不返回 null——那会把「参数缺失」变成每个调用方都要处理的
 * 空值路径，而 Mock 从来没有这条路径。
 *
 * ## 时间
 *
 * `updated_at` 是 `timestamptz`，经 `pool.ts` 统一还原成 ISO 字符串，
 * 因此 `PlatformConfig.updatedAt` 仍然是 `string`。
 */

type PlatformConfigRow = {
  exclusive_pool_timeout_minutes: number;
  public_pool_timeout_minutes: number;
  completion_auto_approval_minutes: number;
  complaint_window_minutes: number;
  updated_at: string;
  updated_by_admin_id: string | null;
};

/** `id` 不读：它是单行表的约束锚点，不是领域字段。 */
const COLUMNS =
  "exclusive_pool_timeout_minutes, public_pool_timeout_minutes, " +
  "completion_auto_approval_minutes, complaint_window_minutes, updated_at, updated_by_admin_id";

function toPlatformConfig(row: PlatformConfigRow): PlatformConfig {
  return {
    exclusivePoolTimeoutMinutes: row.exclusive_pool_timeout_minutes,
    publicPoolTimeoutMinutes: row.public_pool_timeout_minutes,
    completionAutoApprovalMinutes: row.completion_auto_approval_minutes,
    complaintWindowMinutes: row.complaint_window_minutes,
    updatedAt: row.updated_at,
    updatedByAdminId: row.updated_by_admin_id,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个平台参数仓储。
 *
 * 与其它 PG 仓储同构：**一个工厂同时产出普通仓储与事务内仓储**。
 * 事务内的读（例如派单冻结超时快照、订单完成冻结投诉窗口）传 `TxHandle` 进来，
 * 就能与同一事务里的写入共享同一条连接、同一个快照。
 */
export function createPlatformConfigRepository(db: PgQueryable): PlatformConfigRepository {
  return {
    async getConfig(): Promise<PlatformConfig> {
      const rows = await db.query<PlatformConfigRow>(
        `SELECT ${COLUMNS} FROM platform_config WHERE id = 1`,
      );
      // 读不到行时取预置值（与 Mock 建仓语义一致），随后走同一个归一化函数。
      // 返回的是一份新对象：调用方改它不会影响存储（与 Mock 的「返回副本」同一保证）。
      const config = rows[0] ? toPlatformConfig(rows[0]) : platformConfigSeed;
      return normalizePlatformConfig(config);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgPlatformConfigRepository: PlatformConfigRepository =
  createPlatformConfigRepository(lazyPgExecutor());
