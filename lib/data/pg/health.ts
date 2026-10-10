import { describeConnection, PgConfigError, redactDatabaseUrl, requireDatabaseUrl } from "./config";
import type { PgExecutor } from "./executor";
import { loadMigrations, MIGRATION_TABLE } from "./migrate";

/**
 * 数据库健康检查（**仅服务端**）。
 *
 * ## 它**从不抛错**
 *
 * 健康检查的用途是「把状态**报出来**」，不是「中断流程」。连不上库时它返回
 * `ok: false` 加一条错误说明，而不是抛异常——否则调用方（运维脚本、将来的探针接口）
 * 还得自己包一层 try 才能打印出一句人能看懂的话。
 *
 * 「必须连上才能继续」的场景请用 `pool.assertConnectable()`，那个是抛错的。
 *
 * ## 报什么
 *
 * | 字段 | 为什么值得报 |
 * |---|---|
 * | `ok` / `error` | 能不能连上；不能的话**脱敏后**的原因 |
 * | `latencyMs` | 探活往返耗时。数小时不动忽然跳到几秒，比「连不上」更早发现问题 |
 * | `database` / `endpoint` | 连的是哪个库、哪台机器。**多环境切换时最容易搞错的就是这件事** |
 * | `serverVersion` | 报障时对方第一个会问的东西 |
 * | `migrations` | 结构是不是最新的。**连得上但少迁了一条**是最隐蔽的一种不健康 |
 *
 * ## 它是只读的
 *
 * ⚠️ 刻意**不**调用 `migrate()` 里那个 `ensureMigrationTable`：健康检查顺手建一张表，
 * 会让「探活」变成「写操作」，也会把「记账表不存在」这个真实信号悄悄抹掉。
 * 记账表不存在时它按「一条都没迁」报，这才是实话。
 */

export type DatabaseHealth = {
  ok: boolean;
  latencyMs: number;
  /** 实际连上的库名。连不上时为 null */
  database: string | null;
  serverVersion: string | null;
  /** 脱敏后的连接目标（`postgresql://user:***@host:port/db`）。连不上时为 null */
  endpoint: string | null;
  /** 已执行 / 未执行的迁移条数。读不到迁移目录时为 null */
  migrations: { applied: number; pending: number } | null;
  /** 失败原因（**必然脱敏**）。成功时为 null */
  error: string | null;
};

/**
 * 探活一次。
 *
 * @param executor 进程级执行器；传入事务句柄也能跑（本函数只用到 `query`）。
 */
export async function checkDatabaseHealth(executor: PgExecutor): Promise<DatabaseHealth> {
  const startedAt = Date.now();

  let url: string;
  try {
    url = requireDatabaseUrl();
  } catch (error) {
    // 连接串都没配：这不是「连不上」，是「压根没打算连」——但都算不健康
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      database: null,
      serverVersion: null,
      endpoint: null,
      migrations: null,
      error: error instanceof PgConfigError ? error.message : "DATABASE_URL 未配置。",
    };
  }

  const endpoint = redactDatabaseUrl(url);
  const unavailable = (error: string): DatabaseHealth => ({
    ok: false,
    latencyMs: Date.now() - startedAt,
    database: null,
    serverVersion: null,
    endpoint,
    migrations: null,
    error,
  });

  let database: string;
  let serverVersion: string;

  try {
    const rows = await executor.query<{ database: string; server_version: string }>(
      `SELECT current_database() AS database, current_setting('server_version') AS server_version`,
    );
    database = rows[0]?.database ?? "";
    serverVersion = rows[0]?.server_version ?? "";
  } catch (error) {
    return unavailable(describeConnection(url, error));
  }

  const latencyMs = Date.now() - startedAt;

  // 「记账表不存在」与「读不到迁移目录」是**两件不同的事**，不能合并成一个 null：
  // 前者是一个明确的状态（一条都没迁），后者才是「不知道」。
  // 把它们混在一起，会让「这个库压根没迁移过」看起来像「迁移信息不可用」——
  // 而前者恰恰是最需要被一眼看出来的不健康。
  let appliedVersions = new Set<string>();
  try {
    const rows = await executor.query<{ version: string }>(
      `SELECT version FROM ${MIGRATION_TABLE}`,
    );
    appliedVersions = new Set(rows.map((row) => row.version));
  } catch {
    // 连接刚才已经证明是通的，所以这里几乎只可能是「记账表还不存在」
    appliedVersions = new Set();
  }

  let migrations: DatabaseHealth["migrations"] = null;
  try {
    const all = await loadMigrations();
    migrations = {
      applied: appliedVersions.size,
      pending: all.filter((migration) => !appliedVersions.has(migration.version)).length,
    };
  } catch {
    // 读不到迁移目录（部署产物里没带上 db/migrations？）：这才叫「不知道」
    migrations = null;
  }

  return { ok: true, latencyMs, database, serverVersion, endpoint, migrations, error: null };
}

/** 给人和日志看的一行摘要。**不会泄漏密码**：`endpoint` 在探活时已经脱敏。 */
export function formatDatabaseHealth(health: DatabaseHealth): string {
  if (!health.ok) return `数据库不可用：${health.error}`;

  const migrations = health.migrations
    ? `迁移 ${health.migrations.applied} 条已执行 / ${health.migrations.pending} 条待执行`
    : "迁移状态未知";

  return (
    `数据库可用：${health.database}（PostgreSQL ${health.serverVersion}，${health.latencyMs}ms）` +
    `｜${migrations}｜${health.endpoint ?? "连接串未知"}`
  );
}
