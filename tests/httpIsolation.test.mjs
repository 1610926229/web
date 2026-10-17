import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resetServerStores } from "./httpReset.mjs";
import { getMockStore, resetAllMockStores } from "../lib/data/mockStore.ts";

/**
 * HTTP 用例隔离机制的**门禁**（DEV-2）。
 *
 * 隔离方案由两半组成，缺一半就不成立，因此两半各有一条门禁盯着：
 *
 * 1. **每个 HTTP 用例文件开跑前重置服务端存储**（`tests/httpReset.mjs`）；
 * 2. **HTTP 文件串行跑**（`package.json` 里的 `--test-concurrency=1`）。
 *
 * 为什么这两件事需要门禁而不是只写在注释里：它们都是**会静默失效**的约束。
 * 新增一个 HTTP 用例文件时忘了接第 1 条，这个文件会照常全绿——只是它绿不绿取决于
 * 前面几十个文件干了什么；有人觉得测试太慢删掉第 2 条，同样不会有任何测试变红，
 * 只会在某次全量里偶尔红一次，然后「重跑一次又好了」。DEV-2 要治的正是这种病，
 * 因此这里把它变成**会立刻红**的断言。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = path.join(ROOT, "tests");

const BASE = process.env.APP_BASE_URL;

// 本文件自己也带 HTTP 用例，因此同样遵守第 1 条——见 tests/httpReset.mjs 的理由。
await resetServerStores();

const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过重置接口的真实可达性用例";

// ————————————————— 一、机制本身：resetAllMockStores —————————————————

test("resetAllMockStores：把整族 store 丢掉，下次取用按预置重建（返回被丢弃的名字）", () => {
  const first = getMockStore("coupon", () => ({ markers: new Set(["seed"]) }));
  const second = getMockStore("level", () => ({ markers: new Set(["seed"]) }));
  first.markers.add("dirty");
  second.markers.add("dirty");

  const dropped = resetAllMockStores();

  assert.ok(dropped.includes("coupon"), `被丢弃的名字里应有 coupon，实际 ${dropped.join(",")}`);
  assert.ok(dropped.includes("level"), `被丢弃的名字里应有 level，实际 ${dropped.join(",")}`);

  const rebuilt = getMockStore("coupon", () => ({ markers: new Set(["seed"]) }));
  assert.notEqual(rebuilt, first, "应当是一个**新建的** store，而不是原来的那份");
  assert.deepEqual([...rebuilt.markers], ["seed"], "重建后只应剩预置内容，脏数据不得残留");
});

test("resetAllMockStores：只动 Mock 存储，globalThis 上的其它东西原样保留", () => {
  // 前缀之外的东西不许被顺手删掉——本函数只该管 Mock 存储，
  // 一旦它变成「清空 globalThis」，将来任何挂在 globalThis 上的东西都会被牵连。
  globalThis.__dev2ProbeKeepMe = { keep: true };
  try {
    resetAllMockStores();
    assert.deepEqual(globalThis.__dev2ProbeKeepMe, { keep: true });
  } finally {
    delete globalThis.__dev2ProbeKeepMe;
  }
});

// ————————————————— 二、门禁：每个 HTTP 用例文件都必须接上重置 —————————————————

/** 真的会去打服务端的那些测试文件：读 `APP_BASE_URL` 的。 */
function httpCapableTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => readFileSync(path.join(TESTS_DIR, name), "utf8").includes("process.env.APP_BASE_URL"))
    .sort();
}

test("每一个带 HTTP 用例的测试文件，都在开跑前重置了服务端存储（DEV-2 隔离机制第 1 条）", () => {
  const files = httpCapableTestFiles();
  assert.ok(files.length >= 20, `带 HTTP 用例的文件应当有二十来个，实际 ${files.length}`);

  for (const name of files) {
    const source = readFileSync(path.join(TESTS_DIR, name), "utf8");
    // ⚠️ 两件事都要：**`await` 过**，而且**顶格写在模块级**（`^` 多行）。
    //    只写 `resetServerStores()` 而不 await，重置会在后台和服务端请求赛跑；
    //    而在文件顶层写了、却把它塞进某个 `test()` 回调里，同样会让同一文件里的
    //    HTTP 用例先于重置执行——两种都是「看起来接了、其实没生效」。
    //    今天 24 个文件全是模块级顶格，所以这里收紧是零成本的。
    assert.match(
      source,
      /^await resetServerStores\(\);/m,
      `${name} 会打服务端却**没有**在模块顶层 await 重置它（漏写 / 漏 await / 写进了 test() 回调，` +
        `都会让这个文件的断言读到前面文件攒下来的状态，失败将无法归因）。` +
        `请在 import 之后、发起任何请求之前写顶格的 await resetServerStores()（见 tests/httpReset.mjs）。`,
    );
  }
});

test("HTTP 文件必须串行跑：test 脚本里的 --test-concurrency=1 不得被删（DEV-2 隔离机制第 2 条）", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const script = pkg.scripts?.test ?? "";

  // ⚠️ 用正则而不是 `includes("--test-concurrency=1")`：`--test-concurrency 1`（空格分隔）
  //    是合法的 Node 写法，硬编码等号形式会让一次**等价改写**误红——
  //    那和第 5 条原先硬编码字面量 "404" 是同一个毛病。
  assert.match(
    script,
    /--test-concurrency[= ]+1(?!\d)/,
    "package.json 的 test 脚本丢了 --test-concurrency=1（或等价的 --test-concurrency 1）。" +
      "重置是**全局**的，两个 HTTP 文件同时跑会互相清掉对方的中间状态——这一条与逐文件重置是一套的，" +
      "单独看它「只是让测试变慢」，删掉不会有任何**业务**断言立刻失败，只会在某次全量里偶发一次失败。",
  );
});

// ————————————————— 三、重置接口的形状：POST only、开关关掉时不存在 —————————————————

test("重置接口是 POST only，且由 ENABLE_MOCK_DEBUG 控制（关闭时按「接口不存在」返回 404）", () => {
  const source = readFileSync(path.join(ROOT, "app", "api", "debug", "reset", "route.ts"), "utf8");

  assert.ok(source.includes("export async function POST"), "重置必须是 POST");
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      source.includes(`export async function ${method}`),
      false,
      `重置接口不得导出 ${method}：清空数据不能被一个链接、一次预取触发`,
    );
  }

  // ⚠️ 查**位置**，不只是「出现过」。`api-contract.md` §2.1 第 1 条要求守卫是**第一步**：
  //    把开关判断挪到读 body 或某个未来加的 requireUser() 之后，字符串照样在文件里，
  //    但「未启用时连这个接口存不存在都不该被区分出来」这条保证就没了。
  //
  //    为什么只做静态检查、不去进程内直接把 POST() 调起来断言 404：
  //    **做不到**——route 模块会拉进 `next/headers`，Node 的测试运行器加载不了
  //    （实测 `ERR_MODULE_NOT_FOUND: next/headers imported from lib/auth/session.ts`）。
  //    真·运行时的 404 证据在 `04-acceptance.md` §B（关掉开关另起 3106 实测）与
  //    本文件第 6 条（开着开关实测 200）。
  const post = source.slice(source.indexOf("export async function POST"));
  const head = post.slice(post.indexOf("{") + 1, post.indexOf("{") + 400);
  assert.match(
    head,
    /^\s*if \(!isMockDebugEnabled\(\)\)/,
    "守卫必须是 POST 的第一条语句（先读开关，未启用的分支直接返回），而不是夹在后面的某一行",
  );
  // 断言**错误码**而不是字面量 "404"：写死字面量等于把「实现里必须出现这三个字符」当规范，
  // 换成等价的错误码常量（`ERR.NOT_FOUND`）就会误红。要守的是「开关关闭 = 功能不存在」，
  // 也就是 NOT_FOUND，而不是 FORBIDDEN。
  assert.match(head, /NOT_FOUND/, "关闭时必须按「功能不存在」(NOT_FOUND → 404) 返回，而不是 403 FORBIDDEN");
  assert.equal(head.includes("FORBIDDEN"), false, "关闭时不得返回 403：那等于承认这个接口存在，只是你没权限");
});

// ————————————————— 四、真实可达性：接口确实在跑起来的服务上存在 —————————————————

test("真实服务上 POST /api/debug/reset 真的把服务端存储丢掉了（不只是回一个 200）", { skip: SKIP }, async () => {
  // ① 先让服务端**建一次仓**：随便读一个会落到仓储上的接口。
  //    本文件在模块加载时已经重置过一次，因此此刻服务端的存储是空的——
  //    不能想当然地认为「丢弃清单一定有东西」。
  const warm = await fetch(new URL("/api/home", BASE));
  assert.equal(warm.status, 200);
  await warm.json();

  // ② 再重置：这一次清单里必须出现刚刚被建出来的仓储。
  const response = await fetch(new URL("/api/debug/reset", BASE), { method: "POST" });
  assert.equal(response.status, 200, "服务端应当开着 ENABLE_MOCK_DEBUG，因此这个接口应当存在");

  const payload = await response.json();
  assert.ok(Array.isArray(payload.data.reset), "响应里应当回显被丢弃的 store 名，而不是只给一个 200");
  assert.ok(
    payload.data.reset.length > 0,
    "刚刚读过 /api/home，服务端至少已经建过仓；清单为空说明这次重置没有真的动到存储",
  );

  // ③ 关键的一半：重置**之后**那份存储确实是空的。
  //    中间没有任何请求（HTTP 文件串行跑，这一条才成立），所以再重置一次必须无物可丢。
  //    只断言 ② 的 200 是不够的——一个「永远返回一组名字但什么都不做」的假实现也能过。
  const second = await fetch(new URL("/api/debug/reset", BASE), { method: "POST" });
  const again = await second.json();
  assert.deepEqual(
    again.data.reset,
    [],
    "上一步刚清空过、中间没有任何请求，第二次重置不该还有东西可丢——有的话说明第一次并没有真的丢掉存储。" +
      "⚠️ 这条**假定 3105 上没有别的客户端**：浏览器如果开着这个站点的页面，或另有一个没带 " +
      "--test-concurrency=1 的 HTTP 文件在跑，两次 POST 之间就会被建仓，这里会假红。" +
      "人工验收 04-acceptance.md §C 前请先关掉浏览器里的站点。",
  );
});
