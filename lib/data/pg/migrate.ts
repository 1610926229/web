import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describeConnection, PgConfigError, requireDatabaseUrl } from "./config";
import type { PgExecutor, PgQueryable } from "./executor";

/**
 * 版本化 SQL 迁移运行器（**仅服务端**）。
 *
 * ## 为什么是「版本化文件 + 记账表」，而不是运行时 `CREATE TABLE IF NOT EXISTS`
 *
 * 因为两者回答的是**不同的问题**。运行时建表只能保证「表在」，它回答不了：
 *
 * - 这个库现在到底处在哪个版本？（升级到一半失败了怎么办）
 * - 0002 建的那列，0003 改过没有？
 * - 同一份代码在开发库跑过、在测试库没跑过，怎么看出来？
 *
 * 记账表（`schema_migrations`）把「已经执行过哪些」变成**数据**，于是上面三问都有答案。
 * 每一条迁移连同它的记账行在**同一个事务**里提交，所以不存在「表建好了但没记账」
 * 或「记了账但表没建」的中间态——PostgreSQL 的 DDL 是事务性的，这一点能真正做到。
 *
 * ## 记账表自己不是一条迁移
 *
 * 它由运行器**引导创建**，因为运行器必须先能记账，才知道 0001 有没有跑过。
 * 这是它唯一使用 `IF NOT EXISTS` 的地方，理由也仅此一条：
 * 「记账表已经存在」是正常状态，不是异常。**迁移文件里一律不写 `IF NOT EXISTS`**——
 * 那里再叠一层只会让「历史上出过问题、表处于半成品状态」静默通过。
 *
 * ## 三条被证明的性质
 *
 * | 性质 | 靠什么保证 |
 * |---|---|
 * | 空库能一路迁到最新 | 按版本号顺序取全部未执行项 |
 * | 重复执行是幂等的 | 记账表里已有的版本直接跳过，不重新执行 |
 * | 执行顺序固定且不可篡改 | 顺序按版本号数字排序；已执行迁移的 checksum 一旦对不上就报错 |
 *
 * checksum 那一列是**故意**的：迁移文件是历史，改一个字就应该报错，
 * 而不是让两个库各自跑出不同的结构却都显示「已迁移到最新」。
 */

/** 迁移目录。默认是仓库根的 `db/migrations`；可用 `PG_MIGRATIONS_DIR` 覆盖。 */
export function migrationsDir(): string {
  const override = process.env["PG_MIGRATIONS_DIR"];
  // 默认基于 cwd：`pnpm db:migrate` 与 `next dev` 的 cwd 都是仓库根。
  return override ? path.resolve(override) : path.resolve(process.cwd(), "db", "migrations");
}

/** 迁移记账表名。导出给健康检查与清库读——它们要用，但不该各自再写一遍字面量。 */
export const MIGRATION_TABLE = "schema_migrations";

/**
 * 迁移互斥锁的键（任意常量，只要全项目一致）。
 *
 * ⚠️ 用它挡住「两个进程同时迁移」：`pg_advisory_xact_lock` 在事务结束时自动释放，
 * 第二个进程会阻塞到第一个提交，然后读到**最新的**记账表——
 * 于是它看到 0001 已经跑过，跳过，而不是再跑一遍。
 * 没有这把锁，两个进程会双双读到「未执行」，双双去 `CREATE TABLE`，
 * 其中一个拿到「表已存在」的报错。
 */
const MIGRATION_LOCK_KEY = 48201996;

export type Migration = {
  /** 版本号，来自文件名前缀，如 `0001`。同时是记账表的主键 */
  version: string;
  /** 文件名去掉扩展名，如 `0001_favorites` */
  name: string;
  /** SQL 内容的 sha256（换行已归一化）。用于发现「已执行的迁移被改过」 */
  checksum: string;
  sql: string;
};

const FILE_PATTERN = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

/** 换行归一化后再算摘要：否则同一个文件在 Windows（CRLF）与 Linux（LF）上 checksum 不同。 */
function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * 读进全部迁移文件，按**版本号数字**排序。
 *
 * 排序是纯函数、不碰数据库，所以「顺序固定」这件事本身不需要数据库就能验证。
 * 按数字而不是按字符串排：`0010` 与 `0009` 在两种排法下一致，但 `10` 与 `9` 不一致，
 * 而文件名宽度是人的约定、不是代码能强制的东西——按数字排对它免疫。
 */
export async function loadMigrations(dir: string = migrationsDir()): Promise<Migration[]> {
  const entries = await readdir(dir);
  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const matched = FILE_PATTERN.exec(entry);
    if (!matched) {
      // 只忽略非迁移文件；`.sql` 却不合命名规则的必须报错，否则一个拼错的文件名
      // 会让这条迁移**静默地不执行**，而所有检查都显示正常
      if (entry.endsWith(".sql")) {
        throw new PgConfigError(
          `迁移文件名不符合规范：${entry}。应为 <版本号>_<名字>.sql，例如 0003_add_orders.sql。`,
        );
      }
      continue;
    }

    const [, version] = matched;
    const previous = seen.get(version);
    if (previous) {
      throw new PgConfigError(`迁移版本号重复：${version} 同时出现在 ${previous} 与 ${entry}。`);
    }
    seen.set(version, entry);

    const sql = await readFile(path.join(dir, entry), "utf8");
    migrations.push({ version, name: matched[0].replace(/\.sql$/, ""), checksum: checksumOf(sql), sql });
  }

  return migrations.sort((a, b) => Number.parseInt(a.version, 10) - Number.parseInt(b.version, 10));
}

export type MigrateResult = {
  /** 本次真正执行了的版本号 */
  applied: string[];
  /** 记账表里已有、本次跳过的版本号 */
  skipped: string[];
};

async function ensureMigrationTable(executor: PgQueryable): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version    text COLLATE "C" PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 把目标库迁到最新。
 *
 * 每条迁移单独一个事务（连带它的记账行）：一条失败不影响已经成功的那几条，
 * 重跑时从断点继续。这一点比「全部塞进一个事务」更适合开发期——
 * 后者会让「0003 写错了」连带回滚 0001、0002 已经验证过的结构。
 */
export async function migrate(executor: PgExecutor): Promise<MigrateResult> {
  // 先明确探一次连通性：连不上时给出脱敏后的清楚报错，
  // 而不是让驱动把「ECONNREFUSED」连着连接串一起抛出去
  try {
    await executor.query("SELECT 1");
  } catch (error) {
    throw new PgConfigError(describeConnection(requireDatabaseUrl(), error));
  }

  // ⚠️ 引导记账表必须在**锁内**做，不能直接 `executor.query`。
  //    `CREATE TABLE IF NOT EXISTS` 在两个会话同时判断「不存在」时都会去建，
  //    其中一个会撞上系统目录的唯一索引（`duplicate key value violates … pg_type_typname_nsp_index`）。
  //    这不是理论问题：部署时并行跑两次 migrate、或者开发机上两个终端同时敲，
  //    都会碰上。先拿锁再建，第二个进程进来时表已经在了。
  const applied = await executor.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(tx);
    return tx.query<{ version: string; name: string; checksum: string }>(
      `SELECT version, name, checksum FROM ${MIGRATION_TABLE}`,
    );
  });
  const byVersion = new Map(applied.map((row) => [row.version, row]));

  const migrations = await loadMigrations();

  // 先整体校验再执行任何一个：宁可一条都不跑，也不要跑到一半才发现 0002 被改过
  for (const migration of migrations) {
    const recorded = byVersion.get(migration.version);
    if (recorded && recorded.checksum !== migration.checksum) {
      throw new PgConfigError(
        `迁移 ${migration.name} 的内容与已执行的记录不一致（checksum 不符）。` +
          `迁移文件是历史，已执行过的不能再改——请新增一条迁移来做变更。`,
      );
    }
  }

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (byVersion.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }

    await executor.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);

      // 上锁之后**重新读一次**：另一个进程可能刚好在等锁期间把这条跑完了
      const current = await tx.query<{ version: string }>(
        `SELECT version FROM ${MIGRATION_TABLE} WHERE version = $1`,
        [migration.version],
      );
      if (current.length > 0) {
        result.skipped.push(migration.version);
        return;
      }

      // 迁移 SQL 不含参数，走的是简单查询路径，因此一个文件里可以有多条语句
      await tx.query(migration.sql);
      await tx.query(
        `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
      result.applied.push(migration.version);
    });
  }

  return result;
}

/** 当前库已执行到哪些版本。会**引导**记账表，因此属于写操作，别拿它当探活用。 */
export async function appliedVersions(executor: PgExecutor): Promise<string[]> {
  return executor.withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(tx);
    const rows = await tx.query<{ version: string }>(
      `SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`,
    );
    return rows.map((row) => row.version);
  });
}
