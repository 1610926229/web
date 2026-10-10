import {
  assertResetAllowed,
  assertTestDatabase,
  PgConfigError,
  requireDatabaseUrl,
} from "./config";
import type { PgExecutor, PgQueryable } from "./executor";
import { MIGRATION_TABLE } from "./migrate";

/**
 * 测试库的数据重置与结构清空（**仅服务端，且仅测试库**）。
 *
 * ## 两道守卫，缺一不可
 *
 * 1. **库名必须以 `_test` 结尾**（`assertTestDatabase`）——它看的是**实际要连的那个库**，
 *    不是配置项的名字。就算有人把生产连接串填进 `TEST_DATABASE_URL` 也过不了。
 * 2. **不能是生产环境**（`assertResetAllowed`，即 `NODE_ENV=production` 一律拒绝）。
 *
 * 于是「把生产库清空」在这份代码里没有可走通的路径——不是靠人记得别按错。
 *
 * 这与 `.env.example` 里那条说明是同一条纪律：
 * 「真实测试该用独立的测试库，而不是给线上服务开一个清库接口」。
 * 所以这里**不提供任何 HTTP 入口**，只有命令行与测试进程能调用。
 *
 * ## 「重置数据」与「清空结构」是两件事，不要混用
 *
 * | 函数 | 做什么 | 用在哪 |
 * |---|---|---|
 * | `resetDatabase` | 保留表结构与迁移记账，只清数据 | 每个测试文件开始前，回到确定的数据状态 |
 * | `dropDatabaseObjects` | 连表带记账一起删掉 | 只用于迁移测试：证明「空库能一路迁到最新」 |
 *
 * 两者的守卫完全一样。区别只在破坏范围，所以名字必须能一眼分清。
 */

/**
 * 迁移记账表不属于业务数据，重置数据时**必须留着**——否则「已经迁移过」这件事就丢了。
 *
 * ⚠️ 名字从 `migrate.ts` import，**不在这里再写一遍字面量**：
 * 两处各写一份的话，将来改表名只会改一处，另一处会安静地漏掉，
 * 于是「重置数据」把记账表也清掉，或者「清空结构」留下它。
 */

function quoteIdentifier(name: string): string {
  // 标准标识符转义：把内嵌的双引号翻倍再整体包起来。
  // 表名来自系统目录（我们自己建的），但仍然按标识符规则处理，
  // 免得将来出现一个带大写或特殊字符的表名就让整条 SQL 语法错误。
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 列出 `public` 下的表。表名来自系统目录，**不硬编码**——
 * 这样将来新增迁移建了表，重置逻辑自动跟上，不会出现「新表没被清掉、
 * 上一轮的数据留到下一轮」这种最难查的测试污染。
 */
async function listTables(executor: PgQueryable, excludeMigrationTable: boolean): Promise<string[]> {
  const rows = await executor.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'${excludeMigrationTable ? " AND tablename <> $1" : ""}
      ORDER BY tablename`,
    excludeMigrationTable ? [MIGRATION_TABLE] : undefined,
  );
  return rows.map((row) => row.tablename);
}

function assertDestructiveAllowed(): void {
  assertResetAllowed();
  assertTestDatabase(requireDatabaseUrl());
}

/**
 * 清空测试库的**数据**，保留表结构与迁移记账。
 *
 * `TRUNCATE ... RESTART IDENTITY`：连自增序列一起重置，否则第二轮的 id 会从上一轮的
 * 位置继续长下去，「重置之后数据是确定的」就不成立了。
 * 本阶段主键都是 text，`RESTART IDENTITY` 暂时没有作用，但它是这条承诺的一部分，
 * 将来加了自增列不必回来补。
 */
export async function resetDatabase(executor: PgExecutor): Promise<{ truncated: string[] }> {
  assertDestructiveAllowed();

  const tables = await listTables(executor, true);
  if (tables.length === 0) {
    throw new PgConfigError(
      "测试库里一张业务表都没有。请先执行 pnpm db:migrate --target=test 建立结构。",
    );
  }

  await executor.query(
    `TRUNCATE TABLE ${tables.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`,
  );

  return { truncated: tables };
}

/**
 * 删掉测试库里的**全部表**，连迁移记账表一起。
 *
 * ⚠️ 只给迁移测试用：它要回答的问题是「一个**空库**能不能一路迁到最新」，
 * 而 `resetDatabase` 保留了结构，答不了这个问题。
 *
 * ⚠️ 这里用的是运行时 DDL，但**不是**被禁止的那种用法：被禁止的是
 * 「拿运行时 `CREATE TABLE IF NOT EXISTS` 代替正式迁移」——那种做法绕开了记账，
 * 让「库处在哪个版本」无从得知。这里恰恰相反，它删表是为了让记账表**从零开始**，
 * 好让迁移运行器按正式路径重新走一遍。它受与 reset 完全相同的两道守卫约束。
 */
export async function dropDatabaseObjects(executor: PgExecutor): Promise<{ dropped: string[] }> {
  assertDestructiveAllowed();

  const tables = await listTables(executor, false);
  if (tables.length === 0) return { dropped: [] };

  await executor.query(
    `DROP TABLE ${tables.map(quoteIdentifier).join(", ")} CASCADE`,
  );

  return { dropped: tables };
}
