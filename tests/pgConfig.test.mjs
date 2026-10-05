import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertResetAllowed,
  assertSeedAllowed,
  assertTestDatabase,
  databaseNameOf,
  PgConfigError,
  redactDatabaseUrl,
  readDatabaseUrl,
  requireDatabaseUrl,
  requireTestDatabaseUrl,
} from "../lib/data/pg/config.ts";
import { loadMigrations, MIGRATION_TABLE, migrationsDir } from "../lib/data/pg/migrate.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";

/**
 * PostgreSQL 基础层的**纯逻辑**用例——**不需要数据库**，因此在 `pnpm test` 里永远会跑。
 *
 * 这一组刻意与 `pgFoundation.test.mjs` 分开：那一组要连真库、没配 `TEST_DATABASE_URL`
 * 时整体跳过；而本文件里的守卫（生产环境拒绝 seed/reset、非测试库拒绝 reset）
 * 是**安全性质**，跳过它们等于没有它们。所以它们必须待在一个无条件执行的文件里。
 *
 * ⚠️ 本文件**不碰数据库**：连 `resetDatabase` 的两个用例也只在守卫层被拒绝，
 * 传进去的执行器一旦被调用就会抛错——用来证明「守卫是在碰库**之前**拦下的」。
 */

/** 一个一旦被使用就报错的执行器：守卫若失效，用例会以「不该碰数据库」失败，而不是悄悄连上。 */
const explodingExecutor = {
  async query() {
    throw new Error("守卫失效：破坏性操作在被拒绝之前就碰了数据库");
  },
  async withTransaction() {
    throw new Error("守卫失效：破坏性操作在被拒绝之前就碰了数据库");
  },
};

/** 临时改写环境变量跑一段逻辑，跑完恢复。 */
async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ————————————————————————— 连接串缺失：fail-fast —————————————————————————

test("DATABASE_URL 缺失时 requireDatabaseUrl 立刻抛错，且报错里点名是哪个变量", async () => {
  await withEnv({ DATABASE_URL: undefined }, () => {
    assert.equal(readDatabaseUrl(), null);
    assert.throws(() => requireDatabaseUrl(), (error) => {
      assert.ok(error instanceof PgConfigError, "必须是 PgConfigError，调用方才好单独识别");
      assert.match(error.message, /DATABASE_URL/);
      return true;
    });
  });
});

test("只有空白的连接串等同于没配：不接受「看起来配了、其实连不上」的中间态", async () => {
  await withEnv({ DATABASE_URL: "   " }, () => {
    assert.equal(readDatabaseUrl(), null);
    assert.throws(() => requireDatabaseUrl(), PgConfigError);
  });
});

test("测试库连接串缺失报的是 TEST_DATABASE_URL，不伪装成应用库缺失", async () => {
  await withEnv({ TEST_DATABASE_URL: undefined }, () => {
    assert.throws(() => requireTestDatabaseUrl(), (error) => {
      assert.match(error.message, /TEST_DATABASE_URL/);
      assert.doesNotMatch(error.message, /^DATABASE_URL 未配置/);
      return true;
    });
  });
});

// ————————————————————————— 连接串脱敏 —————————————————————————

test("任何要出日志的连接串都先脱敏：密码换成 ***，主机与库名保留", () => {
  const redacted = redactDatabaseUrl("postgresql://postgres:s3cr3t-pa55@db.internal:5432/chaoge_prod");

  assert.doesNotMatch(redacted, /s3cr3t-pa55/, "密码绝不能出现在输出里");
  assert.match(redacted, /\*\*\*/);
  assert.match(redacted, /db\.internal:5432/);
  assert.match(redacted, /chaoge_prod/);
});

test("解析不了的连接串整体隐藏，不去猜哪一段可能含密码", () => {
  assert.equal(redactDatabaseUrl("这不是一个 URL"), "<无法解析的 DATABASE_URL>");
});

test("databaseNameOf 从连接串里取出库名", () => {
  assert.equal(databaseNameOf("postgresql://u:p@h:5432/chaoge_esports_test"), "chaoge_esports_test");
  assert.equal(databaseNameOf("postgresql://u:p@h:5432/"), null);
  assert.equal(databaseNameOf("坏掉的串"), null);
});

// ————————————————————————— 破坏性操作的守卫 —————————————————————————

test("生产环境拒绝写入预置数据（seed）", async () => {
  await withEnv({ NODE_ENV: "production" }, () => {
    assert.throws(() => assertSeedAllowed(), (error) => {
      assert.ok(error instanceof PgConfigError);
      assert.match(error.message, /生产环境/);
      return true;
    });
  });
});

test("生产环境拒绝清空数据（reset）", async () => {
  await withEnv({ NODE_ENV: "production" }, () => {
    assert.throws(() => assertResetAllowed(), PgConfigError);
  });
});

test("非生产环境默认放行：守卫挡的是生产，不是正常开发", async () => {
  await withEnv({ NODE_ENV: undefined }, () => {
    assert.doesNotThrow(() => assertSeedAllowed());
    assert.doesNotThrow(() => assertResetAllowed());
  });
});

test("库名不是以 _test 结尾就拒绝：判据是**实际要连的库**，不是配置项的名字", () => {
  assert.doesNotThrow(() => assertTestDatabase("postgresql://u:p@h:5432/chaoge_esports_test"));
  assert.doesNotThrow(() => assertTestDatabase("postgresql://u:p@h:5432/chaoge_test"));

  // 这几个都是**真实会出现的误用**：把开发库、生产库、或者一个名字看不出用途的库填进来
  for (const url of [
    "postgresql://u:p@h:5432/chaoge_esports_dev",
    "postgresql://u:p@h:5432/chaoge_esports",
    "postgresql://u:p@h:5432/postgres",
    "postgresql://u:p@h:5432/chaoge_esports_test_backup",
  ]) {
    assert.throws(() => assertTestDatabase(url), PgConfigError, `${url} 不该被放行`);
  }
});

test("resetDatabase 在碰数据库**之前**就被拒绝（非测试库）", async () => {
  await withEnv(
    { DATABASE_URL: "postgresql://postgres:pw@localhost:5432/chaoge_esports_dev", NODE_ENV: undefined },
    async () => {
      await assert.rejects(
        () => resetDatabase(explodingExecutor),
        (error) => {
          assert.ok(error instanceof PgConfigError);
          assert.match(error.message, /chaoge_esports_dev/);
          assert.match(error.message, /_test/);
          return true;
        },
      );
    },
  );
});

test("resetDatabase 在生产环境被拒绝，且同样没碰到数据库", async () => {
  await withEnv(
    { DATABASE_URL: "postgresql://postgres:pw@localhost:5432/chaoge_esports_test", NODE_ENV: "production" },
    async () => {
      await assert.rejects(() => resetDatabase(explodingExecutor), /生产环境/);
    },
  );
});

// ————————————————————————— 迁移文件的静态性质 —————————————————————————

test("迁移顺序固定：按版本号数字升序，且与目录里的文件名一一对应", async () => {
  const migrations = await loadMigrations();
  const versions = migrations.map((migration) => migration.version);

  assert.deepEqual(versions, [...versions].sort((a, b) => Number(a) - Number(b)));

  // ⚠️ 下面这条是**结构性**的：加载出来的版本必须与目录里的文件名一一对应。
  // 比「等于某个手写的清单」更能说明问题——手写清单只能证明「我数对了」，
  // 证明不了「没有哪个文件被漏读」。两条一起留着：结构的那条防漏，清单的那条防悄悄变多。
  const dir = migrationsDir();
  const fromFiles = (await readdir(dir))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.split("_")[0])
    .sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(versions, fromFiles, "加载到的版本必须与目录里的迁移文件一一对应");

  // 显式清单：新增一条迁移就要在这里加一项（刻意的。见 tests/pgFoundation.test.mjs 的同名常量）
  assert.deepEqual(versions, ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008"]);
  assert.equal(new Set(versions).size, versions.length, "版本号不能重复");

  // 再读一次必须是同一个结果：顺序来自排序，不是来自 readdir 的返回顺序
  const again = await loadMigrations();
  assert.deepEqual(again.map((m) => m.version), versions);
  assert.deepEqual(again.map((m) => m.checksum), migrations.map((m) => m.checksum));
});

test("迁移文件里不写 CREATE TABLE IF NOT EXISTS：记账表已经保证「跑过就不再跑」", async () => {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql"));
  assert.ok(files.length > 0, "迁移目录里应当有 .sql 文件");

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    // 去掉注释再判断：解释「为什么不这么写」的注释本身不该触发这条断言
    const withoutComments = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    assert.doesNotMatch(
      withoutComments,
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i,
      `${file} 用了 CREATE TABLE IF NOT EXISTS：正式迁移要的是失败时大声报错`,
    );
  }
});

test("记账表的名字只有一个来源：没有任何模块再把那个字面量写第二遍", async () => {
  assert.equal(MIGRATION_TABLE, "schema_migrations");

  // 只断言常量等于某个字符串是**不够**的——那只证明这一个常量对，
  // 证明不了别处没有第二份。reset.ts 曾经就自己写了一遍 `"schema_migrations"`，
  // 那时这条测试照样绿。所以这里直接扫源码：**除了定义处，谁都不许再写这个字面量**。
  const dir = path.resolve("lib/data/pg");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 5, "扫描目录里应当有多个模块，否则这条门禁可能是空扫");

  const definers = [];
  for (const file of files) {
    const source = await readFile(path.join(dir, file), "utf8");
    if (source.includes('"schema_migrations"')) definers.push(file);
  }

  assert.deepEqual(
    definers,
    ["migrate.ts"],
    `"schema_migrations" 这个字面量只允许出现在 migrate.ts 的定义处，实际出现在：${definers.join(", ")}`,
  );
});

// ————————————————————————— 分层未被穿透 —————————————————————————

/**
 * 「换数据源不该改动 Route / Service」这条要求，在**结构上**是可验证的：
 * 服务层与路由层根本不认识 `pg`，它们只依赖仓储接口。
 *
 * 这比「人工检查过没有改」可复现——后者只在写作者记得的时候成立。
 */
test("服务层与路由层不认识 pg：数据源换了，它们一行都不用改", async () => {
  const files = [
    "lib/services/favorites.ts",
    "lib/services/suggestions.ts",
    "lib/services/favoritesHttp.ts",
    "lib/services/suggestionsHttp.ts",
  ];

  for (const file of files) {
    const source = await readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /from\s+"pg"/, `${file} 直接引了驱动`);
    assert.doesNotMatch(source, /lib\/data\/pg/, `${file} 直接引了 PostgreSQL 实现`);
    assert.doesNotMatch(source, /DATA_SOURCE/, `${file} 自己判断数据源：切换点应当只有一个`);
  }
});

test("浏览器侧的薄客户端不会把驱动打进产物（*Http.ts 不碰仓储层）", async () => {
  for (const file of ["lib/services/favoritesHttp.ts", "lib/services/suggestionsHttp.ts"]) {
    const source = await readFile(path.resolve(file), "utf8");
    assert.doesNotMatch(source, /@\/lib\/data\//, `${file} 引了服务端仓储层`);
  }
});
