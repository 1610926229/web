import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPANION_BACK_TO_USER_HREF,
  COMPANION_BACK_TO_USER_LABEL,
} from "../lib/constants/companionConsole.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-6.1 FIX-1「打手工作台补一个返回用户端的入口」的源码结构门禁。
 *
 * ## 为什么是「读源码」而不是「跑组件」
 *
 * 本项目的测试跑在 `node --test` 上，Node 只剥 TypeScript 类型、**不剥 JSX**
 * （见 `CLAUDE.md` 的测试说明），因此组件行为测不了——那部分靠人工验收。
 * 而这一批要守的东西恰好**全部是结构事实**，用源码门禁比渲染测试更合适：
 *
 * - 入口**只有一处**（统一顶栏），不是每个页面各写一个；
 * - 它挂在 `(console)` 这一层的 layout 上，因此该路由组里的**每一个**页面都有它；
 * - 用户端不会因为共用组件而错误地长出工作台顶栏；
 * - 它是一次**界面导航**，不是退出登录、不是换身份、不碰会话。
 *
 * 前三件事是「少写一处」类的缺陷：复制按钮的做法在**今天**看起来完全正常，
 * 只在下一批新增页面时露馅（新页面漏了按钮，而且没有一个测试会红）。
 * 因此这里按「清单全等」断言，而不是断言「某处存在」。
 *
 * ## 与已有测试的分工（刻意不重复）
 *
 * 「没有第二套打手身份 / Cookie / 会话」「守卫走 `requireUser()`、
 * 访问判定只有 `resolveCompanionAccess()` 一处」已经由
 * `tests/companionAccess.test.mjs` 与 `tests/devIdentity.test.mjs` 逐条钉住。
 * 本文件只补两件事：**FIX-1 的改动面没有碰它们**，以及**入口本身**的结构。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONSOLE_CONSTANTS = path.join(ROOT, "lib", "constants", "companionConsole.ts");
const HEADER = path.join(ROOT, "components", "companion", "CompanionHeader.tsx");
const LAYOUT = path.join(ROOT, "app", "companion", "(console)", "layout.tsx");
const TAB_BAR = path.join(ROOT, "components", "common", "TabBar.tsx");

const APP_DIR = path.join(ROOT, "app");
const COMPONENT_DIR = path.join(ROOT, "components");
const MOBILE_DIR = path.join(APP_DIR, "(mobile)");
const COMPANION_CONSOLE_DIR = path.join(APP_DIR, "companion", "(console)");

/** 相对仓库根的 POSIX 路径：断言里写出来可读，跨平台也稳定。 */
function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

/** 只扫真源码：测试、文档里写着这些标识是为了禁止它们，纳入扫描等于让门禁自己判红。 */
function sourceFiles(dir) {
  return collectFiles(dir).filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
}

/** 硬编码的「指向 `/` 的链接」——返回入口必须引用常量，页面也不许各写一个。 */
const HARDCODED_ROOT_HREF = /href=\{?["']\/["']\}?/;

/** `CompanionHeader` 的 import 说明符（只看 import，不看组件自己的默认导出）。 */
const HEADER_IMPORT = /from\s+"@\/components\/companion\/CompanionHeader"/;

/** 退出登录 / 换身份 / 读会话的痕迹。FIX-1 明确禁止其中任何一个。 */
const AUTH_TOKENS = [
  "/api/auth/logout",
  "logout",
  "signOut",
  "cookies(",
  "mock_user_id",
  "mock_admin_id",
  "mock_staff_id",
];

// ——————————————— 门禁 1：返回目标 = 用户端主入口 ———————————————

test("门禁 1：返回目标是用户端主入口 `/`，且与底部 TabBar「首页」那一格是同一个地址", () => {
  assert.equal(COMPANION_BACK_TO_USER_HREF, "/", "打手工作台的返回目标是用户端首页");
  assert.equal(typeof COMPANION_BACK_TO_USER_LABEL, "string");
  assert.ok(COMPANION_BACK_TO_USER_LABEL.trim().length > 0, "入口必须有一句可读的文案");

  // 与底部导航的「首页」对账：两条入口必须是**同一个地址**。
  // 各写各的字符串时，改了一处不会改另一处，用户端就会多出一个并不存在的主入口
  const tabBar = stripComments(readSource(TAB_BAR));
  const homeTab = /\{\s*href:\s*"([^"]+)"\s*,\s*label:\s*"首页"/.exec(tabBar);
  assert.ok(homeTab, "TabBar 里必须有一格「首页」——它是用户端主入口的唯一既有定义");
  assert.equal(
    homeTab[1],
    COMPANION_BACK_TO_USER_HREF,
    "工作台的返回入口与底部导航「首页」必须指向同一个地址，不另立第二个用户端主入口",
  );
});

// ——————————————— 门禁 2：顶栏渲染的是 Link 且引用常量 ———————————————

test("门禁 2：顶栏里渲染了一个 Link，href 取自 COMPANION_BACK_TO_USER_HREF（不是硬编码）", () => {
  const header = stripComments(readSource(HEADER));

  assert.match(header, /import\s+Link\s+from\s+"next\/link"/, "返回入口必须是客户端可点的导航（next/link）");
  assert.match(
    header,
    /<Link[\s\S]{0,240}?href=\{\s*COMPANION_BACK_TO_USER_HREF\s*\}/,
    "返回入口的 href 必须引用常量：硬编码之后，改常量对它无效，而它看起来是对的",
  );
  assert.match(
    header,
    /\{\s*COMPANION_BACK_TO_USER_LABEL\s*\}/,
    "文案也必须引用常量，而不是在组件里再写一句",
  );
  assert.equal(HARDCODED_ROOT_HREF.test(header), false, "不得把 `/` 硬编码进组件");
});

// ——————————————— 门禁 3：全仓只有一处挂载，且只在 granted 分支 ———————————————

test("门禁 3：CompanionHeader 全仓只有一处 import（(console) layout），且只在 granted 分支渲染", () => {
  const importers = [];
  for (const dir of [APP_DIR, COMPONENT_DIR]) {
    for (const file of sourceFiles(dir)) {
      if (HEADER_IMPORT.test(stripComments(readSource(file)))) importers.push(relative(file));
    }
  }
  assert.deepEqual(
    importers,
    ["app/companion/(console)/layout.tsx"],
    "顶栏必须只挂在这一处：多一处就是「每页各复制一份」，下一批新增页面时必然有页面漏掉",
  );

  // 同一份 layout 同时说明四件事：
  // (1) 整个 (console) 路由组（概览 / 池 / 专属池 / 我的订单 / 订单详情 / 我的收益）共用这一个顶栏；
  // (2) 没有每页复制按钮；
  // (3) 用户端页面拿不到它（它们不在这个路由组里，也没有任何页面 import 它）；
  // (4) 不是打手的人看到的是提示页，不是顶栏。
  const pages = collectFiles(COMPANION_CONSOLE_DIR)
    .filter((file) => file.endsWith("page.tsx"))
    .map(relative)
    .sort();
  assert.deepEqual(pages, [
    "app/companion/(console)/earnings/page.tsx",
    "app/companion/(console)/exclusive/page.tsx",
    "app/companion/(console)/orders/[id]/page.tsx",
    "app/companion/(console)/orders/page.tsx",
    "app/companion/(console)/page.tsx",
    "app/companion/(console)/pool/page.tsx",
  ], "工作台的页面集合变了：新页面要么落在 (console) 下（自动有顶栏），要么就是漏了入口");

  // 工作台里没有第二层 layout：上面那份清单里的每一个页面都吃这一个壳层
  const layouts = collectFiles(path.join(APP_DIR, "companion"))
    .filter((file) => file.endsWith("layout.tsx"))
    .map(relative);
  assert.deepEqual(layouts, ["app/companion/(console)/layout.tsx"]);

  const layout = stripComments(readSource(LAYOUT));
  const notGranted = layout.indexOf('access.kind !== "granted"');
  const header = layout.indexOf("<CompanionHeader");
  assert.ok(notGranted >= 0, "layout 里必须有那句资格判定");
  assert.ok(header > notGranted, "顶栏必须出现在 granted 判定之后");
  assert.ok(
    /access\.kind\s*!==\s*"granted"[\s\S]*?return[\s\S]*?<CompanionHeader/.test(layout),
    "两者之间必须隔着一个提前 return：否则不是打手的人也会拿到写着打手昵称的顶栏",
  );
  assert.ok(
    layout.indexOf("CompanionAccessNotice") < header,
    "不是打手时渲染的是提示页，不是顶栏",
  );
});

// ——————————————— 门禁 4：反向——工作台页面不许各自再写一个 ———————————————

test("门禁 4：工作台页面里没有各自再写一个指向 `/` 的返回链接（避免两份并存）", () => {
  const offenders = sourceFiles(path.join(APP_DIR, "companion"))
    .filter((file) => HARDCODED_ROOT_HREF.test(stripComments(readSource(file))))
    .map(relative);
  assert.deepEqual(
    offenders,
    [],
    "入口只能有一处：统一顶栏 + 各页再复制一份 = 两份，迟早有一份被改漏或样式分叉",
  );
});

// ——————————————— 门禁 5：用户端不出现工作台顶栏 ———————————————

test("门禁 5：用户端页面不 import CompanionHeader（普通用户看不到工作台顶栏）", () => {
  const offenders = sourceFiles(MOBILE_DIR)
    .filter((file) => stripComments(readSource(file)).includes("CompanionHeader"))
    .map(relative);
  assert.deepEqual(offenders, [], "普通用户端页面不该出现 Companion Console 顶栏");

  // 扫描面不能是空的：用户端的页面树确实都在这一个目录下
  assert.ok(
    collectFiles(MOBILE_DIR).some((file) => file.endsWith("page.tsx")),
    "用户端页面树必须在 app/(mobile) 下，否则上面那条断言扫了个空目录",
  );
});

// ——————————————— 门禁 6：不是退出登录 ———————————————

test("门禁 6：返回入口不是退出登录——工作台里不存在 logout / 清 Cookie / 读会话的痕迹", () => {
  const offenders = [];
  for (const dir of [path.join(APP_DIR, "companion"), path.join(COMPONENT_DIR, "companion")]) {
    for (const file of sourceFiles(dir)) {
      // 只看**代码**：注释里说明「这里没有退出登录」是允许的，而且正是它该写下来的地方
      const code = stripComments(readSource(file)).toLowerCase();
      for (const token of AUTH_TOKENS) {
        if (code.includes(token.toLowerCase())) offenders.push(`${relative(file)} → ${token}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "打手用的就是用户账号：这里只能是界面导航，不能是退出登录 / 换身份 / 清 Cookie",
  );
});

// ——————————————— 门禁 7：没有引入第二套认证 ———————————————

test("门禁 7：没有引入第二套认证——守卫与访问判定仍是原来那两处（按内容特征断言）", () => {
  // 这一条只回答「FIX-1 有没有动它们」。判定的正确性由
  // `tests/companionAccess.test.mjs` / `tests/devIdentity.test.mjs` 逐条覆盖，这里不重复
  const guard = stripComments(readSource(path.join(ROOT, "lib", "api", "companionRoute.ts")));
  assert.match(guard, /await\s+requireUser\(\)/, "打手身份仍然只来自用户会话");
  assert.equal(
    (guard.match(/new ApiError\("FORBIDDEN"/g) ?? []).length,
    2,
    "守卫仍然恰好两个 403 分支（不是护航 / 资格已下架），没有多出第三套判定",
  );
  assert.ok(guard.includes("COMPANION_NOT_A_COMPANION_MESSAGE"));
  assert.ok(guard.includes("COMPANION_DISABLED_MESSAGE"));
  assert.equal(/cookies\(/.test(guard), false, "守卫不自己读 Cookie");

  const access = stripComments(readSource(path.join(ROOT, "lib", "services", "companionAccess.ts")));
  assert.ok(
    access.includes("export const resolveCompanionAccess"),
    "访问判定仍然只有 resolveCompanionAccess() 一处导出",
  );

  // layout 仍然委托给它，而不是自己按 userId 查一次
  const layout = stripComments(readSource(LAYOUT));
  assert.ok(layout.includes("resolveCompanionAccess"), "壳层仍然读那一处判定");
  assert.equal(
    layout.includes("findCompanionByUser"),
    false,
    "layout 里再查一次仓储就会出现第二个真值来源",
  );
});

// ——————————————— 门禁 8：入口的实现不碰身份 ———————————————

test("门禁 8：返回用户端入口的实现里没有引用任何 lib/auth 或 Cookie 的符号", () => {
  for (const file of [CONSOLE_CONSTANTS, HEADER]) {
    const code = stripComments(readSource(file));
    for (const token of [
      "@/lib/auth",
      "cookies(",
      "mock_user_id",
      "mock_admin_id",
      "mock_staff_id",
      "getSessionUser",
      "getSessionAdmin",
      "getSessionStaff",
    ]) {
      assert.equal(code.includes(token), false, `${relative(file)} 不该引用 ${token}`);
    }
  }

  // 正面的一侧：常量文件里只有字符串，没有任何 import 之外的东西
  const constants = stripComments(readSource(CONSOLE_CONSTANTS));
  assert.equal(
    /import[^;]*from\s+"@\/lib\/auth/.test(constants),
    false,
    "文案常量是服务端与浏览器共用的纯字符串模块，不能牵进会话",
  );
  assert.match(constants, /export const COMPANION_BACK_TO_USER_HREF\s*=\s*"\/"/);
});
