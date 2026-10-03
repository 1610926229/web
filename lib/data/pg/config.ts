/**
 * PostgreSQL 连接配置与环境策略（**仅服务端**）。
 *
 * ⚠️ 本文件**不 import `pg`**。数据源开关（`isPostgresDataSourceEnabled`）会被
 * `lib/data/favoriteRepository.ts` 这种「选择用哪个实现」的文件引用，让它们顺带把
 * 整个驱动加载进来是没有必要的。
 *
 * ## 与 `lib/config/env.ts` 的关系
 *
 * 环境变量的读法沿用同一个约定（见该文件头）：用**动态 key** 访问 `process.env`，
 * 而不是 `process.env.DATABASE_URL`。打包器会把静态写法在构建期内联成常量，
 * 「构建时没配 DB、运行时配了」这种差异会被悄悄抹掉。
 *
 * 开关本身没有放进 `lib/config/env.ts`：那个文件的职责是「Mock 能力开关」，
 * 而这里是数据源与数据库连接，语义不同，混在一起会让「关掉所有 ENABLE_MOCK_*」
 * 看起来像「关掉数据库」。
 *
 * ## 两个连接串，各自只有一个用途
 *
 * | 变量 | 用途 |
 * |---|---|
 * | `DATABASE_URL` | **运行时**唯一使用的连接串。应用、迁移、seed、health 都读它 |
 * | `TEST_DATABASE_URL` | 只用来**喂给** `DATABASE_URL`——见下面「为什么这样分」 |
 *
 * 进程里**只有一个连接池**（`pool.ts`），它指向 `DATABASE_URL`。
 * 「测试库」不是第二套连接，而是「把 `DATABASE_URL` 指向测试库」这一件事：
 * 测试入口与 `pnpm db:* --target=test` 都会做这一次赋值。
 *
 * ### 为什么这样分，而不是让池子自己按环境挑变量
 *
 * 因为 `reset` 是**破坏性**的，必须有一个能独立于「当前连的是哪个库」的判据。
 * 拆成两个变量之后，守卫变成两条互不相干的检查，两条都必须过：
 *
 * 1. **库名必须以 `_test` 结尾**（`assertTestDatabase`）——它看的是实际要连的那个库，
 *    不是配置项的名字。就算有人把生产连接串填进 `TEST_DATABASE_URL` 也过不了；
 * 2. **不能是生产环境**（`assertResetAllowed`）——`NODE_ENV=production` 一律拒绝。
 *
 * 于是「把生产库清空」在这份代码里**没有可走通的路径**——不是靠人记得别按错。
 */

/** 连接串缺失时的错误。单独一个类型，方便调用方把它和「连不上」区分开。 */
export class PgConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgConfigError";
  }
}

/**
 * 数据源是否切到 PostgreSQL。
 *
 * ⚠️ 判据是**显式的 `DATA_SOURCE` 开关**，不是「`DATABASE_URL` 有没有配」。
 * 这个区别很重要：`.env` 里配着 `DATABASE_URL` 是常态（本地开发要连库），
 * 若拿它的存在当开关，那么任何人 clone 下来跑 `pnpm dev` 都会**悄无声息地**
 * 从 Mock 切到数据库——而按迁移策略，只有事务闭包完整的业务链才允许切。
 *
 * 目前只有 `favorite` 与 `suggestion` 两个仓储读这个开关（PROD-1A 竖切片）。
 */
export function isPostgresDataSourceEnabled(): boolean {
  return process.env["DATA_SOURCE"] === "postgres";
}

/** 当前进程是否跑在生产环境（`next start` / `next build` 会把它设成 `production`）。 */
export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

function readUrl(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : null;
}

/** 运行时连接串。没配或只有空白时返回 null。 */
export function readDatabaseUrl(): string | null {
  return readUrl("DATABASE_URL");
}

/** 测试库连接串。只被测试入口与 `--target=test` 用来给 `DATABASE_URL` 赋值。 */
export function readTestDatabaseUrl(): string | null {
  return readUrl("TEST_DATABASE_URL");
}

/**
 * 取运行时连接串，取不到就**立刻抛错**。
 *
 * 这是「`DATABASE_URL` 缺失 → fail-fast」那条要求的落点：宁可进程起不来，
 * 也不要留一个「连不上库但看起来一切正常、所有查询返回空列表」的服务。
 * 空列表和「真的没有数据」在页面上长得一模一样，那是最难查的一类故障。
 */
export function requireDatabaseUrl(): string {
  const url = readDatabaseUrl();
  if (!url) {
    throw new PgConfigError(
      "DATABASE_URL 未配置。请在 .env 里配置它，" +
        "或在不需要数据库时不要设置 DATA_SOURCE=postgres。",
    );
  }
  return url;
}

/**
 * 取测试库连接串，取不到就抛错。
 *
 * ⚠️ 与 `requireDatabaseUrl` 的报错分开写，是为了让「测试库没配」这件事
 * 不伪装成「应用库没配」——两者的修法完全不同。
 */
export function requireTestDatabaseUrl(): string {
  const url = readTestDatabaseUrl();
  if (!url) {
    throw new PgConfigError(
      "TEST_DATABASE_URL 未配置。测试库与应用库是分开的（破坏性操作只允许打测试库），" +
        "请在 .env 里配置它，例如 postgresql://user:password@localhost:5432/<库名>_test。",
    );
  }
  return url;
}

/**
 * 把连接串里的密码抹掉，只留一个能读懂「连的是哪台机器哪个库」的形态。
 *
 * ⚠️ 任何要进日志或错误信息的连接串都必须先过这个函数。
 * `DATABASE_URL` 里带着真实密码，直接把驱动抛出的错误原样透出去，
 * 密码就会顺着接口响应或日志泄漏出去。
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    // 解析不了就整体隐藏：宁可不显示，也不能猜着留下可能含密码的部分
    return "<无法解析的 DATABASE_URL>";
  }
}

/** 连接失败时给人和日志看的说明。**必然经过脱敏**。 */
export function describeConnection(url: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `无法连接 PostgreSQL（${redactDatabaseUrl(url)}）：${reason}`;
}

/** 从连接串里取出库名。取不到返回 null。 */
export function databaseNameOf(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

/**
 * 断言这个连接串指向的是一个**测试库**。
 *
 * 判据是库名以 `_test` 结尾——这是项目自己的命名约定（`chaoge_esports_test`）。
 * 认不出来就拒绝执行，宁可让命令跑不起来，也不能让一次误操作的破坏性语句
 * 落在一个「名字看不出用途」的库上。
 */
export function assertTestDatabase(url: string): void {
  const databaseName = databaseNameOf(url);
  if (!databaseName) {
    throw new PgConfigError("连接串无法解析，拒绝执行破坏性操作。");
  }

  if (!databaseName.endsWith("_test")) {
    throw new PgConfigError(
      `拒绝执行：连接串指向的库是「${databaseName}」，库名不以 _test 结尾。` +
        `本项目的约定是测试库命名必须能一眼认出（例如 chaoge_esports_test）——` +
        `破坏性操作只允许打在这样的库上。`,
    );
  }
}

/** 写入预置数据是否被允许。生产环境一律拒绝。 */
export function assertSeedAllowed(): void {
  if (isProduction()) {
    throw new PgConfigError(
      "生产环境不允许写入预置数据（seed）。预置数据只用于开发与测试；" +
        "生产库的结构由 migration 建立，内容由真实业务产生。",
    );
  }
}

/** 清空库中数据是否被允许。生产环境一律拒绝。 */
export function assertResetAllowed(): void {
  if (isProduction()) {
    throw new PgConfigError(
      "生产环境不允许清空数据（reset）。这是破坏性操作，只在开发与测试环境可用。",
    );
  }
}
