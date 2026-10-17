import { redactDatabaseUrl, requireDatabaseUrl, requireTestDatabaseUrl } from "./config";
import { getPgExecutor } from "./executor";
import { checkDatabaseHealth, formatDatabaseHealth } from "./health";
import { migrate } from "./migrate";
import { closePool } from "./pool";
import { resetDatabase } from "./reset";
import { seedDatabase } from "./seed";

/**
 * 数据库运维命令入口。
 *
 *     pnpm db:migrate [--target=test]
 *     pnpm db:seed    [--target=test]
 *     pnpm db:reset       --target=test     ← 只认测试库
 *     pnpm db:health  [--target=test]
 *
 * ⚠️ 这几个脚本要跑 TypeScript，因此借用了测试用的 `@/*` 别名解析钩子
 * （见 `package.json`）。仓库里没有别的 TS 运行器，而为此引入一个依赖
 * （tsx / ts-node）是不必要的——Node 24 自己就能剥离类型，缺的只是路径别名。
 *
 * ## `--target=test` 做了什么
 *
 * 只做一件事：把 `TEST_DATABASE_URL` 赋给 `DATABASE_URL`，然后一切照旧。
 * 进程里始终只有**一个**连接池、一个执行器，不存在「刚才那条语句打的是哪个库」
 * 这种需要靠记忆回答的问题。
 *
 * ⚠️ `reset` **没有** `--target=app` 这个选项：连接串指向的库名不以 `_test` 结尾时，
 * 它在 `reset.ts` 里就会被拒绝。这不是提示，是拒绝执行。
 */

const USAGE = `用法：node lib/data/pg/cli.ts <migrate|seed|reset|health> [--target=app|test]

  migrate  把目标库迁移到最新版本（幂等，可重复执行）
  seed     写入预置数据（生产环境拒绝执行）
  reset    清空目标库的数据，保留表结构（只允许测试库）
  health   探活并报告库名、版本、延迟与迁移进度
`;

type Command = "migrate" | "seed" | "reset" | "health";

const COMMANDS: readonly Command[] = ["migrate", "seed", "reset", "health"];

function parseArguments(argv: string[]): { command: Command; target: "app" | "test" } {
  const [command, ...rest] = argv;

  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`未知命令：${command ?? "(空)"}\n\n${USAGE}`);
  }

  let target: "app" | "test" = "app";
  for (const argument of rest) {
    if (argument === "--target=test") target = "test";
    else if (argument === "--target=app") target = "app";
    else throw new Error(`未知参数：${argument}\n\n${USAGE}`);
  }

  if (command === "reset" && target === "app") {
    throw new Error(
      `reset 只能对测试库执行。请使用 --target=test。\n\n${USAGE}`,
    );
  }

  return { command: command as Command, target };
}

async function runCommand(command: Command): Promise<void> {
  const executor = getPgExecutor();

  if (command === "migrate") {
    const result = await migrate(executor);
    console.log(`迁移完成：本次执行 ${result.applied.length} 条，跳过 ${result.skipped.length} 条。`);
    for (const version of result.applied) console.log(`  ✔ ${version}（已执行）`);
    for (const version of result.skipped) console.log(`  · ${version}（已是最新，跳过）`);
    return;
  }

  if (command === "seed") {
    const result = await seedDatabase(executor);
    console.log(
      `预置数据写入完成：收藏 ${result.favorites.inserted} 条新增 / ${result.favorites.skipped} 条已存在；` +
        `反馈 ${result.suggestions.inserted} 条新增 / ${result.suggestions.skipped} 条已存在。`,
    );
    return;
  }

  if (command === "reset") {
    const result = await resetDatabase(executor);
    console.log(`已清空测试库的 ${result.truncated.length} 张表（表结构与迁移记账保留）：`);
    for (const table of result.truncated) console.log(`  ✔ ${table}`);
    return;
  }

  const health = await checkDatabaseHealth(executor);
  console.log(formatDatabaseHealth(health));
  // 探活失败是一条**结论**，不是异常：健康检查本身跑通了。
  // 但进程要以非零码退出，否则 CI 里 `pnpm db:health` 失败了也没人发现。
  if (!health.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const { command, target } = parseArguments(process.argv.slice(2));

  if (target === "test") {
    // 唯一一次「切库」：之后所有代码读的都是 DATABASE_URL，没有第二套路径
    process.env["DATABASE_URL"] = requireTestDatabaseUrl();
  }

  console.log(`[db] ${command} → ${redactDatabaseUrl(requireDatabaseUrl())}`);

  try {
    // ⚠️ `target` 到此已经用完——它唯一的作用就是在上面那一次 swap 里。
    //    传下去会让 `runCommand` 拿着一个「已经不影响行为」的参数，
    //    将来有人以为「传 target 就能切库」，而实际上只有上面那一行才切。
    await runCommand(command);
  } finally {
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(`[db] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  // 出错时也要把连接池关掉，否则进程会挂着不退出
  void closePool();
});
