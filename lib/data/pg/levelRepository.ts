import type { ConsumptionLevel } from "@/lib/types/level";
import type { LevelRepository } from "../levelRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `LevelRepository` 的 PostgreSQL 实现（PROD-1E · Wave A）—— **只读**。
 *
 * ⚠️ 接口本来就只有 `listLevels()` 一个方法，这里也**只实现它**：消费等级的阈值、
 * 名称与权益由管理者在未来 PC 管理后台配置，本阶段没有写路径。写它们的是预置数据，
 * 不是业务路径——因此这张表只需要「能读、且读到的与 Mock 逐字段一致」。
 *
 * ## 返回**全部**等级，含停用项
 *
 * `enabled = false` 的等级**照样返回**（`mockLevelRepository.ts:45-47`）。
 * 「停用」是「不参与判定」，不是「查不到」；仓储不替调用方筛选，
 * `enabled` 的取舍在 `lib/constants/levels.ts`。一旦在这里 `WHERE enabled`，
 * 「停用等级不参与判定」这条规则就会散落到仓储与页面两处。
 *
 * ## 排序：从 Mock 的**非确定序**收敛到确定序
 *
 * Mock 的 `listLevels` 返回 `Map` 的插入序（`mockLevelRepository.ts:44-48`），
 * 它**不排序**——接口注释也写明「顺序不做保证（判定前会按阈值排序）」。
 * Pg 若不加 `ORDER BY`，行序由执行计划决定，同一份数据两次查询可能不同，
 * 调用方虽然会自己按阈值排，但测试会因此不可复现。
 *
 * 因此这里用 `ORDER BY sort_order, id` 给出稳定行序：先按配置里的**展示顺序**
 * （`sortOrder`），再按 id 兜底。这是对 Mock 非确定序的确定性化，
 * **不是**「Mock 排过序」——判定逻辑仍然自己按 `thresholdAmount` 排序。
 *
 * ## jsonb 与时间
 *
 * `privileges` 是 `jsonb`，驱动**直接返回已解析的数组**，映射时直接赋值，
 * **不做 `JSON.parse`**。`created_at` / `updated_at` 经 `pool.ts` 的解析器钩子
 * 还原成 ISO 字符串，类型与 Mock 一致。
 */

type LevelRow = {
  id: string;
  name: string;
  threshold_amount: number;
  /** jsonb：驱动已解析成 `ConsumptionPrivilege[]`，直接取值。 */
  privileges: ConsumptionLevel["privileges"];
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * 领域对象会读到的**全部**列。
 *
 * `enabled` / `createdAt` / `updatedAt` 都在这里：它们是 `ConsumptionLevel`
 * 这个仓储内部类型的组成部分，只是不会进入对外 DTO（那由 `toLevelView` 一类
 * 纯函数在服务层裁剪，不在仓储）。
 */
const COLUMNS =
  "id, name, threshold_amount, privileges, sort_order, enabled, created_at, updated_at";

function toConsumptionLevel(row: LevelRow): ConsumptionLevel {
  return {
    id: row.id,
    name: row.name,
    thresholdAmount: row.threshold_amount,
    // jsonb 已由驱动解析，直接赋值
    privileges: row.privileges,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 用任意可执行 SQL 的对象造一个等级仓储。
 *
 * 与其它仓储同构：同一个工厂既能产出进程级仓储，也能产出事务内仓储——
 * 将来管理端要做「配置 + 审计」同一事务时不需要换一套 API。
 */
export function createLevelRepository(db: PgQueryable): LevelRepository {
  return {
    async listLevels(): Promise<ConsumptionLevel[]> {
      // `ORDER BY sort_order, id`：对 Mock 的 Map 插入序做**确定性化**（见文件头）。
      // 不加 `WHERE enabled`——停用等级也必须返回。
      const rows = await db.query<LevelRow>(
        `SELECT ${COLUMNS} FROM consumption_levels ORDER BY sort_order, id`,
      );
      return rows.map(toConsumptionLevel);
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgLevelRepository: LevelRepository = createLevelRepository(lazyPgExecutor());
