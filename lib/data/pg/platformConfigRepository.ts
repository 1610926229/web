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
 * ## PROD-1D：事务内原语（**不在接口上**）
 *
 * 本文件另有两个 `export`（`lockPlatformConfigForUpdateTx` / `applyPlatformConfigTx`），
 * 它们**不是** `PlatformConfigRepository` 的方法——那个接口一个字没改，
 * 上面那条「不加 `updateConfig()`」的纪律也没有放宽。它们是
 * `lib/data/pg/platformConfigTransactions.ts` 的 Pg 事务专用的**窄写入器**，
 * 与 `pg/companionRepository.ts` 的 `lockCompanionForFlagsTx` / `applyCompanionFlagsTx`
 * 同一形状：`UPDATE` 只写这一次语义对应的列，绝不整行覆盖。
 * 把它们放在本文件而不是新开一个文件，是因为它们操作的就是这一张表、这一组列；
 * 分散两处迟早会让 `SELECT` 的列与 `UPDATE` 的列各自演化。
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

/**
 * `platform_config` 单行表那一行的 id（DDL 的 `CHECK (id = 1)`）。
 *
 * ⚠️ 与 `PLATFORM_CONFIG_ID`（`lib/constants/platformConfig.ts` 里的 `"platform-config"`）
 * 是**两个不同的东西**：那个是审计表里这份配置的 `targetId`（文本），
 * 这个是数据库单行表的约束锚点（`smallint`）。把两者混起来，锁与更新都会命中 0 行，
 * 而「0 行」在事务里看起来只是「什么都没发生」。
 */
const PLATFORM_CONFIG_ROW_ID = 1;

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

/* ─────────────── 事务内原语（PROD-1D：平台参数的 Pg 写闭包） ─────────────── */

/**
 * 取当前配置并**锁住这一行**（`SELECT … FOR UPDATE`）。
 *
 * ## 返回 `null` 是「数据异常」，不是业务失败
 *
 * 与 `w1Transactions.readPlatformConfigFrom()` 同一取舍：单行表那一行由
 * **种子**保证存在（`seedDatabase` 必插 `id = 1`），读不到说明库被手工改过、
 * 或者种子没跑。调用方据此**抛错**而不是返回一个失败种类——
 * 平台参数是单例，「配置不存在」在业务上不是一个状态（Mock 那边 store 恒有一份）。
 *
 * ## 为什么读配置也要加锁（与 `w1Transactions.readPlatformConfig` 不同）
 *
 * `w1Transactions` 里的 `readPlatformConfig(tx)` 是**普通读**，因为它服务的是
 * 「冻结快照」——读到一个已提交的值即可。本函数服务的是「读—改—写」，两个管理员
 * 同时保存时，第二个必须**等第一个提交之后再读**（读到第一个的结果，而不是两份
 * 都基于同一份旧值各自覆盖）。`FOR UPDATE` 就是这条串行化，与 `lockCompanionForFlagsTx`
 * 同一条理由。
 */
export async function lockPlatformConfigForUpdateTx(db: PgQueryable): Promise<PlatformConfig | null> {
  const rows = await db.query<PlatformConfigRow>(
    `SELECT ${COLUMNS} FROM platform_config WHERE id = $1 FOR UPDATE`,
    [PLATFORM_CONFIG_ROW_ID],
  );
  return rows[0] ? toPlatformConfig(rows[0]) : null;
}

/**
 * 写那六个列（四个时长 + `updated_at` + `updated_by_admin_id`）—— **窄写入**。
 *
 * ## 为什么不整行写
 *
 * 平台参数这四个时长今天是**同一页表单上的同一份配置**，看上去整行写与窄写等价；
 * 但只要将来出现第二个调用点（例如某个只改投诉窗口的运维脚本），整行写就会把
 * 调用方**没有读到**的那三列覆盖回去，而且不报错。窄写让「这次要改什么」与
 * 「落库的列」一一对应。
 *
 * ## `previous` 必须是**锁下读到的那一份**
 *
 * 返回值直接喂给审计快照（`toPlatformConfigAuditSnapshot`），而审计的 before
 * 应当回答「改动前那份值是谁留下的」。传一个事务外读到的陈旧快照进去，
 * 审计会记下一次不存在的改动。
 *
 * ## 归一化：今天恒为 no-op，但保留
 *
 * `normalizePlatformConfig()` 在 Mock 的 `writePlatformConfig()` 里是写入路径的
 * 一部分（补齐旧 store 缺的字段）。这里整张表的四个时长都是 `NOT NULL` + `CHECK`，
 * 不会出现缺失字段，因此归一化**今天什么都改不了**。保留它是为了让两个存储的
 * 返回值形状**逐字段同构**——不这么做，`value.previous` / `value.updated` 在两个
 * 存储上就有了两种组装方式，而差异只会在「哪天真的多出一个可选字段」时暴露。
 *
 * ## 0 行 = 不可能状态
 *
 * 调用方刚在锁下确认过这一行存在；`UPDATE` 命中 0 行只可能是数据被并发删掉了。
 * 与 `w1Transactions` 的同一取舍：此时**抛错**让整段事务回滚，绝不返回一个
 * 「保存成功」。
 */
export async function applyPlatformConfigTx(
  db: PgQueryable,
  previous: PlatformConfig,
  next: PlatformConfig,
): Promise<{ previous: PlatformConfig; updated: PlatformConfig }> {
  const rows = await db.query<{ id: number }>(
    `UPDATE platform_config
        SET exclusive_pool_timeout_minutes = $2,
            public_pool_timeout_minutes = $3,
            completion_auto_approval_minutes = $4,
            complaint_window_minutes = $5,
            updated_at = $6,
            updated_by_admin_id = $7
      WHERE id = $1
    RETURNING id`,
    [
      PLATFORM_CONFIG_ROW_ID,
      next.exclusivePoolTimeoutMinutes,
      next.publicPoolTimeoutMinutes,
      next.completionAutoApprovalMinutes,
      next.complaintWindowMinutes,
      next.updatedAt,
      next.updatedByAdminId,
    ],
  );
  if (!rows[0]) {
    throw new Error("platform_config 更新未命中任何行：单行表那一行在事务中途消失");
  }
  return {
    previous: normalizePlatformConfig(previous),
    updated: normalizePlatformConfig(next),
  };
}
