import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MOCK_LOGIN_ACCESS_LABELS, MOCK_LOGIN_USERS } from "../lib/constants/mockUsers.ts";
import { isMockAuthEnabled } from "../lib/config/env.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { COMPANION_POOL_NOTICE } from "../lib/constants/dispatch.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { listCompanionPools } from "../lib/services/companionDispatch.ts";
import { login, logout } from "../lib/services/user.ts";
import { resolveCompanionAccess } from "../lib/services/companionAccess.ts";

/**
 * DEV-1「Mock 身份切换验收工具」的回归保护。
 *
 * ## 这份测试在防什么
 *
 * DEV-1 的产物是**一个开发工具**，它的价值全在「它有没有越界」：
 *
 * 1. **开关是唯一判据。** 工具在 `ENABLE_MOCK_AUTH !== "true"` 时必须完全不可用，
 *    而且优先「不渲染」而不是「置灰」。一旦有人把它改成「先渲染再判」，
 *    正式环境的 HTML 里就会出现 Mock 用户线索；
 * 2. **它没有变成第二套身份系统。** 不新增认证接口、不新增会话 Cookie、
 *    不自己发请求、不自带一份用户名单——切换就是换掉同一个 `mock_user_id`；
 * 3. **它没有绕开权限。** 打手身份仍然只从用户会话 + 名下护航资料推出来，
 *    「切到谁」不等于「以谁的权限通行」。
 *
 * ## ⚠️ 验收身份是**预置**的，不靠人工审核变出来
 *
 * DEV-1 首轮交付在这里被打回过一次：当时 `companionSeed` 里每条记录的 `userId`
 * 都是 `null`，于是**预置数据里没有任何用户具备打手资格**——名单只能标注「申请状态」，
 * 验收的人必须先切到后台把某个人审核成打手，才跑得动「老板下单 → 打手 A 接单/取消
 * → 打手 B 抢单」。那等于 DEV-1 最重要的用途（一个浏览器里验收 P0-6 的换身份链路）
 * 走不通，也直接违反了 DEV-1 的原始要求：至少一个普通 User、至少两个**具备有效
 * Companion 资格**的 User。
 *
 * 现在 `companionSeed` 里有 `cp-10`（`userId: u-1022`）与 `cp-11`（`userId: u-1023`）
 * 两条**由入驻审核产生**的护航资料，因此启动即有两位真打手。下面「三、验收身份」
 * 那一节正面钉住这件事，包括：
 *
 * - 普通 User 不是打手、A / B 是打手（判定走 `resolveCompanionAccess`，不是看名单）；
 * - 名单里**恰好**只有标着 `approved` 的账号是打手——名单不声明资格，资格由数据决定；
 * - A / B 的 `applicationId` 指向一条 `approved` 的入驻申请（「由审核产生」有据可查）；
 * - 既有的入驻申请场景（待查看 / 审核中 / 已通过但无护航 / 未通过 / 已撤销）一个没动。
 *
 * ## 怎么写测试
 *
 * 与其它测试同一套取舍：JSX 不会被 Node 剥掉类型，所以 `.tsx` 只能做**源码级契约**
 * （`stripComments` + 文本断言），行为验证落在 service / auth / data 这些纯模块上，
 * UI 行为进人工验收。不新增测试框架。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepo(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * 去掉注释后再断言「源码里有没有某个词」。
 *
 * 与其它测试同一套理由：本仓库的注释会把**不应该存在的东西**写进去做反例说明
 * （例如「没有第二套 Cookie」这句里就带着「第二套 Cookie」），不去注释会全红。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 遍历某个目录下的全部 `.ts` / `.tsx`，返回绝对路径。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(full)) yield full;
  }
}

/** 仓库里所有源码文件的绝对路径（用于「某个名字还出现在哪些文件里」）。 */
function sourceFiles() {
  const files = [];
  for (const root of ["app", "components", "lib"]) {
    for (const full of walk(path.join(ROOT, root))) files.push(full);
  }
  return files;
}

function relativeOf(absolute) {
  return path.relative(ROOT, absolute).replace(/\\/g, "/");
}

/* ─────────────────────────── 一、开关是唯一判据 ─────────────────────────── */

test("§十三.1/2 开关判据：ENABLE_MOCK_AUTH 恰好为字符串 \"true\" 才为真", () => {
  const original = process.env.ENABLE_MOCK_AUTH;

  // 「1」「TRUE」「yes」都不算开启——工具要么明确开着，要么根本不存在，
  // 不存在「大概开着」这一档。这条由 lib/config/env.ts 的动态取值保证。
  const cases = [
    ["true", true],
    ["false", false],
    ["1", false],
    ["TRUE", false],
    ["yes", false],
    ["", false],
    [undefined, false],
  ];

  try {
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.ENABLE_MOCK_AUTH;
      else process.env.ENABLE_MOCK_AUTH = value;

      assert.equal(isMockAuthEnabled(), expected, `ENABLE_MOCK_AUTH=${String(value)} 时的判定`);
    }
  } finally {
    if (original === undefined) delete process.env.ENABLE_MOCK_AUTH;
    else process.env.ENABLE_MOCK_AUTH = original;
  }
});

test("§十三.2 门禁先判开关再读会话：关闭时连 Cookie 都不读，工具整块不渲染", () => {
  const compact = stripComments(readRepo("lib/auth/MockIdentitySwitcher.tsx")).replace(/\s+/g, " ");

  const earlyReturn = "if (!isMockAuthEnabled()) return null;";
  assert.ok(compact.includes(earlyReturn), "关闭分支必须是直接 return null（不渲染），而不是把面板画出来再置灰");

  const switchIndex = compact.indexOf(earlyReturn);
  const sessionIndex = compact.indexOf("await getSessionUser()");
  assert.ok(sessionIndex > 0, "开启分支必须读会话，才知道「当前身份」是谁");
  assert.ok(
    switchIndex < sessionIndex,
    "读会话必须排在开关判定之后：顺序反过来时，开关关闭也照样读 Cookie，页面仍会按请求渲染",
  );

  // §八.9：资格派生也必须在早返回**之后**。这块代码会在服务端算出「谁是打手」
  // 并渲染成标签，因此它与名单同属「关闭时不得进入响应」的那一类。
  // 判据是位置：把它挪到早返回之前，开关关闭时标签照样会被算出来。
  const afterSwitch = compact.slice(switchIndex);
  for (const derived of ["resolveCompanionAccess(", "MOCK_LOGIN_ACCESS_LABELS"]) {
    assert.ok(
      afterSwitch.includes(derived),
      `${derived} 必须出现在早返回之后：在此之前就意味着开关关闭时仍会派生并渲染身份标签`,
    );
  }
});

test("§十三.2 开关关闭时面板组件不进入渲染树：宿主清单是一份显式清单", () => {
  const hosts = sourceFiles()
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes("MockIdentityPanel"))
    .map(relativeOf)
    .sort();

  assert.deepEqual(
    hosts,
    ["lib/auth/MockIdentityPanel.tsx", "lib/auth/MockIdentitySwitcher.tsx"],
    "面板只能被服务端门禁引用：直接挂到页面上就绕过了开关，工具会出现在正式环境里",
  );

  // 门禁挂在用户端全局布局上，而不是被多端复用的 MobileShell 上
  const layout = stripComments(readRepo("app/(mobile)/layout.tsx"));
  assert.ok(layout.includes("<MockIdentitySwitcher"), "用户端全局布局必须挂上门禁组件");

  const shell = stripComments(readRepo("components/common/MobileShell.tsx"));
  assert.equal(
    shell.includes("MockIdentity"),
    false,
    "MobileShell 被打手工作台复用，工具挂在它上面会顺着壳层漏到另一端（§十五 禁止）",
  );
});

/* ─────────────────── 二、它没有变成第二套身份系统 ─────────────────── */

test("§十三.3 切换复用既有登录链路：不自己发请求、不自己写 Cookie", () => {
  const panel = stripComments(readRepo("lib/auth/MockIdentityPanel.tsx"));

  for (const forbidden of ["fetch(", "document.cookie", "mock_user_id", "apiPost", "XMLHttpRequest"]) {
    assert.equal(panel.includes(forbidden), false, `面板里不应出现 ${forbidden}`);
  }

  // 链式调用允许换行，因此按「词」而不是按「字面量」断言（`authAdapter\n  .login(` 也是对的）
  assert.ok(/authAdapter\s*\.\s*login\(/.test(panel), "切换必须走 authAdapter —— 它才是登录的唯一出口");
  assert.ok(/authAdapter\s*\.\s*logout\(/.test(panel), "退出必须走既有退出链路（§十：不得自己删 Cookie）");
  assert.ok(
    panel.includes("router.refresh()"),
    "切换 / 退出后必须刷新，让服务端按新会话重新渲染（§九：权限与导航都要重算）",
  );
});

test("§十三.3 切换与退出都打到既有接口，一个字节的新协议都没有", async () => {
  const calls = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        data: { id: "u-1002", nickname: "老板B（占位）", avatarUrl: "/mock/avatar-2.svg" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const user = await login("u-1002");
    assert.equal(user.id, "u-1002");
    await logout();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 2, "一次切换 + 一次退出，只应发出两个请求");
  assert.equal(calls[0].url, "/api/auth/mock-login");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { userId: "u-1002" });
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[1].url, "/api/auth/logout");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.body, undefined, "退出接口不读请求体：没有「退出谁」这种参数");
});

test("§十三.4 面板不自带用户名单：名单只有 lib/constants/mockUsers.ts 一份", () => {
  const panel = stripComments(readRepo("lib/auth/MockIdentityPanel.tsx"));

  for (const option of MOCK_LOGIN_USERS) {
    assert.equal(
      panel.includes(option.userId),
      false,
      `面板里不该写死 ${option.userId}：名单必须来自 MOCK_LOGIN_USERS，否则 Seed 一改就会对不上`,
    );
  }

  assert.ok(panel.includes("<MockUserPicker"), "面板必须复用登录界面那份选择器，而不是自己再画一份列表");
});

test("§十三.9 没有新增任何认证接口：app/api/**/auth/** 恰好是这八个", () => {
  const found = [];
  for (const full of walk(path.join(ROOT, "app", "api"))) {
    const relative = relativeOf(full);
    if (relative.includes("/route.ts") && relative.split("/").includes("auth")) found.push(relative);
  }

  assert.deepEqual(
    found.sort(),
    [
      "app/api/admin/auth/logout/route.ts",
      "app/api/admin/auth/mock-login/route.ts",
      "app/api/admin/auth/session/route.ts",
      "app/api/auth/logout/route.ts",
      "app/api/auth/mock-login/route.ts",
      "app/api/staff/auth/logout/route.ts",
      "app/api/staff/auth/mock-login/route.ts",
      "app/api/staff/auth/session/route.ts",
    ],
    "DEV-1 只提供身份切换工具：不得新增任何认证接口",
  );
});

test("§十三.9 没有新会话模型：全仓仍然只有三套会话 Cookie，且没有打手 Cookie", () => {
  const cookieValues = new Set();

  for (const full of walk(path.join(ROOT, "lib"))) {
    const source = stripComments(readFileSync(full, "utf8"));
    for (const match of source.matchAll(/export const [A-Z_]*COOKIE[A-Z_]* = "([^"]+)"/g)) {
      cookieValues.add(match[1]);
    }
  }

  assert.deepEqual(
    [...cookieValues].sort(),
    ["mock_admin_id", "mock_staff_id", "mock_user_id"],
    "三套会话（用户 / 管理 / 客服），一个都不能多；打手身份建立在用户会话之上，没有自己的 Cookie",
  );

  // ⚠️ 上面那条只认「导出常量 + 双引号字面量」这一种写法。DEV-1 交付审查时被
  // 指出这不够：`cookies().set("companion_session", …)`、模板串、或不导出的常量
  // 都能悄悄多出一套会话，而上面那条照样全绿。**下面这条补上真正的判据**。
  //
  // 理由：在本仓库里「会话」就是建立在 `cookies()` 之上的（三套 cookie 会话都是）。
  // 因此新增一套会话**必然**要调用 `cookies()`——无论它叫什么名字、导不导出、
  // 是不是用模板串。钉住调用点，就钉住了「不可能有第四套会话」。
  const callSites = sourceFiles()
    .filter((full) => stripComments(readFileSync(full, "utf8")).includes("cookies()"))
    .map(relativeOf);

  assert.deepEqual(
    callSites.sort(),
    ["lib/auth/adminSession.ts", "lib/auth/session.ts", "lib/auth/staffSession.ts"],
    "会话只允许在这三个模块里落地：多出一道调用点就等于多了一套会话；打手复用用户会话，不该有第四套",
  );
});

/* ─────────── 三、验收身份：普通 User + 打手 A + 打手 B（必须一启动就有） ─────────── */

/**
 * 这一节守的是 DEV-1 的**存在理由**：在一个浏览器里切换身份，把 P0-6 的
 * 「老板下单 → 打手 A 接单/取消 → 打手 B 抢单」走完，**中途不许再去后台审核**。
 *
 * 因此下面不造数据、不改数据，只对**真实 Seed** 提要求：进程起来的那一刻，
 * 名单里就必须有一位普通 User 和两位有效打手。谁把 `cp-10` / `cp-11` 删了、
 * 把 `available` 改成 `false`、或者把 `userId` 解绑，都会在这里立刻现形——
 * 而不是等到人工验收走到一半才发现名单在说谎。
 */

/** 名单里标着「入驻已通过」的账号：按名单的约定，这些人**必须真的已经是打手**。 */
const approvedOptions = MOCK_LOGIN_USERS.filter((option) => option.applicationState === "approved");

/**
 * 取一位验收打手的「判定」与「资料」两半。
 *
 * 两半都要，是因为它们刻意是两种视角（见 `lib/services/companionAccess.ts`）：
 * 判定（`resolveCompanionAccess`）只交出 `CompanionSessionUser`，**不含**
 * `enabled` / `available` / `removedAt`——那是不该外泄的内部字段。要断言
 * 「这个人为什么是有效打手」就得回到资料本身（仓储）。
 */
async function presetCompanionOf(userId) {
  const access = await resolveCompanionAccess(userId);
  assert.equal(
    access.kind,
    "granted",
    `${userId} 在名单里标着「入驻已通过」，但 resolveCompanionAccess 判定为 ${access.kind}`,
  );

  const record = await getCompanionRepository().findCompanionByUser(userId);
  assert.ok(record, `${userId} 判定为 granted，却查不到名下的护航资料`);
  assert.equal(
    access.companion.companionId,
    record.id,
    `${userId} 的判定与资料不是同一条记录：资格判定必须与展示字段出自同一次读取`,
  );

  return { access, record };
}

test("§八.2/3 打手 A / B 是预置的有效打手：resolveCompanionAccess 判定 granted，四个条件一个不缺", async () => {
  assert.ok(
    approvedOptions.length >= 2,
    "DEV-1 要求至少两个具备有效 Companion 资格的 User：名单里标着「入驻已通过」的少于两个",
  );

  const applicationById = new Map(companionApplicationSeed.map((item) => [item.id, item]));

  for (const option of approvedOptions) {
    const { record } = await presetCompanionOf(option.userId);

    // 关联必须绑在 userId 上：资格的唯一真值源是「这个用户名下有没有护航资料」
    assert.equal(record.userId, option.userId, `${option.userId} 名下的护航资料没有绑定这个 userId`);
    assert.equal(record.removedAt, null, `${record.id} 已被移除，不能作为验收身份`);

    // ⚠️ 下面两条正是 BR-01 的两个分支，缺哪一条这位「打手」都会在验收里失效：
    // `enabled: false` → 判定成 disabled，工作台直接进不去；
    // `available: false` → 进得去但公共池一条都不给（BR-01）。
    assert.equal(record.enabled, true, `${record.id} 未上架：判定会变成 disabled，工作台直接进不去`);
    assert.equal(
      record.available,
      true,
      `${record.id} 不可接单：公共池不会给他任何一单，「打手 A 接单」这一步会当场卡住`,
    );

    // 「由入驻审核产生」要有据可查：来源申请存在、属于他、且已通过
    assert.ok(record.applicationId, `${record.id} 没有来源申请，不能声称它由入驻审核产生`);
    const application = applicationById.get(record.applicationId);
    assert.ok(application, `${record.id} 的来源申请 ${record.applicationId} 在预置数据里不存在`);
    assert.equal(application.userId, option.userId, `${record.id} 的来源申请不属于 ${option.userId}`);
    assert.equal(
      application.status,
      "approved",
      `${record.id} 的来源申请状态是 ${application.status}，不是已通过`,
    );
  }

  // 两位必须是不同的人：同一个人切两次不叫「换身份」，也演不了「A 取消 → B 抢单」
  assert.equal(
    new Set(approvedOptions.map((option) => option.userId)).size,
    approvedOptions.length,
    "名单里标着「入驻已通过」的账号出现了重复的 userId",
  );
});

test("§八.1 普通 User 不是打手：默认登录身份（名单第一位）必须是普通下单用户", async () => {
  // 名单第一位就是 `/api/auth/mock-login` 不带 userId 时登录的那位，也是验收里下单的老板。
  // 他名下不能有护航资料，否则「普通 User 下单 → 打手接单」这条链的两个身份会重合。
  const ordering = MOCK_LOGIN_USERS[0];
  assert.deepEqual(
    await resolveCompanionAccess(ordering.userId),
    { kind: "not-a-companion" },
    `${ordering.userId} 是默认登录身份，必须是一位普通下单用户`,
  );

  // 名单里必须**至少有一位**不是打手的人可供下单，否则验收第一步就没有身份可用
  const plain = [];
  for (const option of MOCK_LOGIN_USERS) {
    const access = await resolveCompanionAccess(option.userId);
    if (access.kind !== "granted") plain.push(option.userId);
  }
  assert.ok(plain.length >= 1, "名单里没有任何普通用户，验收第一步（下单）没有身份可用");
});

test("§八.7 资格标签的键必须与真实的判定取值一一对应，拼错一个键会让标签静默消失", () => {
  // 标签表的键是**手写的字符串字面量**：`lib/constants/mockUsers.ts` 是零 import 的纯常量文件
  // （`tests/mockUsers.test.mjs` 钉住这一点），因此它引不进 `CompanionAccessState` 这个联合类型，
  // 编译器管不到「键名拼对没有」。拼错一个键的后果不是报错，而是**那一档标签在页面上凭空消失**，
  // 而且所有测试照样绿——所以只能在这里显式断言。取值来自 `resolveCompanionAccess` 的三种 kind。
  const kinds = ["granted", "disabled", "not-a-companion"];
  for (const kind of kinds) {
    assert.equal(
      typeof MOCK_LOGIN_ACCESS_LABELS[kind],
      "string",
      `资格标签表缺少 "${kind}" 这一档：判定返回这个值时页面上不会显示任何标签`,
    );
    assert.ok(MOCK_LOGIN_ACCESS_LABELS[kind].trim(), `"${kind}" 的标签文案是空的`);
  }
  // 三种状态必须给出**三种不同**的文案，否则标签就分辨不出身份了
  assert.equal(new Set(kinds.map((kind) => MOCK_LOGIN_ACCESS_LABELS[kind])).size, kinds.length);
  // `granted` 这一档是验收时认「谁是打手」的那句话，单独钉住，避免被顺手改成含混的说法
  assert.equal(MOCK_LOGIN_ACCESS_LABELS.granted, "有效打手");
  assert.equal(MOCK_LOGIN_ACCESS_LABELS["not-a-companion"], "普通用户");

  // 标签表里不该有多余的档位：多出来的一档意味着有人以为还有第四种判定结果
  assert.deepEqual(Object.keys(MOCK_LOGIN_ACCESS_LABELS).sort(), [...kinds].sort());
});

test("§八.7 名单不声明资格：名单里「已经是打手」的恰好是标着 approved 的那两位", async () => {
  // 这条把名单与真实资格**对齐**：`applicationState` 是名单里唯一与资格有关的字段，
  // 因此标着 `approved` 的必须真的是打手（上面一条已验），而**不是**打手的必须一个都没被漏标。
  // 反过来说：谁往 `companionSeed` 里补一位带 `userId` 的护航却忘了在名单里说明，
  // 这条会红——验收的人正是靠名单认人。
  const granted = [];
  for (const option of MOCK_LOGIN_USERS) {
    const access = await resolveCompanionAccess(option.userId);
    if (access.kind === "granted") granted.push(option.userId);
  }

  assert.deepEqual(
    granted.sort(),
    approvedOptions.map((option) => option.userId).sort(),
    "名单里已经是打手的账号与标注不一致：名单是给人认身份用的，标错等于让人照着错的身份去验收",
  );
});

test("§八.4/5/6 打手 A / B 真的能进工作台并参与公共池：canAccept 为真，不是「进得去但没有单」", async () => {
  const at = new Date().toISOString();

  for (const option of approvedOptions) {
    const { record } = await presetCompanionOf(option.userId);

    // 工作台与接单接口都走 `requireCompanion()`，而它的放行条件是同一份 granted 判定；
    // 这里再往下走一步，确认这位打手在**服务层**真的能拿到池子（`canAccept` 为真），
    // 而不是「资格没问题、池子却因为 available=false 一条都不给」（BR-01 的第二个分支）。
    const pools = await listCompanionPools(record.id, at);
    assert.equal(
      pools.canAccept,
      true,
      `${option.userId}（${record.id}）读到的池子 canAccept 为假：公共池不会给他任何一单`,
    );
    assert.equal(
      pools.notice,
      COMPANION_POOL_NOTICE,
      `${option.userId} 看到的是「暂停接单」的提示（BR-01 的第二个分支）`,
    );
  }
});

test("§八.8 既有入驻申请场景一个都没被破坏：五种状态都还在，且只有验收身份是打手", async () => {
  // 新增验收身份最容易伤到的是这些「专供某个状态页」的样本：一旦有人图省事把它们
  // 改成「已通过 + 有护航」，待查看 / 审核中 / 已通过但无护航 三个页面就再也造不出来了。
  const expected = [
    { applicationId: "ca-1002", userId: "u-1002", status: "pending" },
    { applicationId: "ca-1003", userId: "u-1003", status: "reviewing" },
    { applicationId: "ca-1004", userId: "u-1004", status: "approved" },
    { applicationId: "ca-1005", userId: "u-1005", status: "rejected" },
    { applicationId: "ca-1006", userId: "u-1006", status: "withdrawn" },
    { applicationId: "ca-1007", userId: "u-1007", status: "withdrawn" },
  ];
  const byId = new Map(companionApplicationSeed.map((item) => [item.id, item]));

  for (const item of expected) {
    const application = byId.get(item.applicationId);
    assert.ok(application, `预置入驻申请 ${item.applicationId} 不见了`);
    assert.equal(application.userId, item.userId, `${item.applicationId} 的所属用户被改过`);
    assert.equal(
      application.status,
      item.status,
      `${item.applicationId} 的状态被改成了 ${application.status}：这会让某个状态页失去样本`,
    );
  }

  // `ca-1004`（已通过）**刻意**没有对应的护航资料：「申请已通过、护航资料另行产生」
  // 这个中间态就是靠它演示的。补一条护航等于把它弄没。
  assert.deepEqual(
    await resolveCompanionAccess("u-1004"),
    { kind: "not-a-companion" },
    "u-1004 的申请已通过但名下不该有护航资料：它是「已通过但不是打手」这个中间态的唯一样本",
  );
});

/* ─────────────────── 四、切到谁不等于以谁的权限通行 ─────────────────── */

test("§十三.7/8 资格只吃会话里的 userId：同一个浏览器切到打手就是打手，切回来就不是", async () => {
  // DEV-1 面板在验收里的用法是「切过去 → 打手工作台放行 → 切回来 → 不再放行」。
  // 这条在数据层把整件事走一遍：临时造一位打手，然后只看 userId 的判定结果。
  //
  // ⚠️ 这里**必须用一个不在名单里的 userId**：名单里标着 approved 的那两位
  // 名下已经有护航（`cp-10` / `cp-11`），拿他们来造会直接命中
  // 「一名用户最多一条有效护航」而返回 `already-linked`，这条用例就变成在测别的东西了。
  const asCompanion = "u-1006"; // 已撤销申请的用户：正是「还得靠审核才能变成打手」的那一类
  const asPlain = "u-1001";

  assert.deepEqual(
    await resolveCompanionAccess(asCompanion),
    { kind: "not-a-companion" },
    "起点必须是「还不是打手」，否则下面那句 granted 证明不了任何事",
  );

  const created = await getCompanionRepository().createCompanion({
    id: `cp-dev1-${process.pid}`,
    userId: asCompanion,
    applicationId: null,
    removedAt: null,
    displayName: "DEV-1 验收用打手（占位）",
    avatarUrl: "/mock/avatars/companion-1.svg",
    rankLabel: "钻石打手",
    intro: "",
    gameIds: [],
    regions: [],
    serviceTags: [],
    available: true,
    unavailableReason: "",
    completedOrderCount: 0,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 999,
    enabled: true,
    reviews: [],
  });
  assert.equal(created.kind, "created");

  // 切到这位：判定为 granted（打手接口守卫由此放行）
  const granted = await resolveCompanionAccess(asCompanion);
  assert.equal(granted.kind, "granted", "有有效护航资料的用户必须能进打手工作台");

  // 切回普通用户：同一个进程、同一个仓储，判定立刻变回 not-a-companion
  assert.deepEqual(
    await resolveCompanionAccess(asPlain),
    { kind: "not-a-companion" },
    "打手资格不会跟着浏览器 / 会话残留：判定只由「这个 userId 名下有没有护航资料」决定",
  );
});

test("§十三.7/8 打手接口守卫只从用户会话取身份，不读第二个 Cookie", () => {
  const guard = stripComments(readRepo("lib/api/companionRoute.ts"));

  assert.ok(guard.includes("requireUser()"), "守卫必须走既有的用户会话");
  assert.ok(guard.includes("resolveCompanionAccess("), "资格判定必须委托给唯一入口");
  assert.equal(/cookies\(\)/.test(guard), false, "守卫不该自己读 Cookie：身份只能从会话服务取");
  assert.equal(
    /"mock_[a-z_]+_id"/.test(guard),
    false,
    "守卫里不该出现任何 Cookie 名——出现一个就说明打手身份有了第二个来源",
  );
});

/* ─────────────────── 五、真实会话（需要 APP_BASE_URL） ─────────────────── */

/**
 * §十三.3/5/6/9 里「换掉的是同一个会话」这半件事，只有真跑服务才验得到：
 * 会话建立在 `cookies()` 之上，进程内测试拿不到。因此与其它 HTTP 用例同一取舍：
 * 没设 `APP_BASE_URL` 时自动跳过，而不是伪装成通过。
 *
 * ⚠️ 这一节**一个字节都不写**（只有 mock-login / logout 与几次 GET）：
 * 这台服务的进程内数据是整轮 HTTP 用例共享的，写一条就等于污染其它用例。
 * 「切到打手后守卫放行」在这里用的是**预置的**打手 A / B（`cp-10` / `cp-11`），
 * 恰好不需要造数据就能验——这正是 DEV-1 本轮补上那两条预置护航的意义。
 */
const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3213），跳过 DEV-1 的真实会话用例";

function mockLoginBody(userId) {
  return fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: userId === undefined ? undefined : JSON.stringify({ userId }),
  });
}

function cookieName(setCookieValue) {
  return setCookieValue.split("=")[0];
}

test("§十三.5 切换后会话就是目标用户，再切回来也是：同一个 Cookie 被替换，不是并行两个会话", { skip: SKIP }, async () => {
  const asSecond = await mockLoginBody("u-1002");
  assert.equal(asSecond.status, 200);
  const secondCookies = asSecond.headers.getSetCookie();
  assert.equal(secondCookies.length, 1, "登录只应下发一个 Cookie：没有第二套登录态");
  assert.equal(cookieName(secondCookies[0]), "mock_user_id", "用户会话 Cookie 名不变");
  const secondCookie = secondCookies[0].split(";")[0];

  const secondMe = await fetch(new URL("/api/me", BASE), { headers: { cookie: secondCookie } });
  assert.equal(secondMe.status, 200);
  assert.equal((await secondMe.json()).data.id, "u-1002", "切换后 /api/me 必须变成目标用户");

  // 再切一次（这次走默认用户）：拿到的是**新的一份**同名 Cookie，仍然只有一个
  const back = await mockLoginBody();
  assert.equal(back.status, 200);
  const backCookies = back.headers.getSetCookie();
  assert.equal(backCookies.length, 1);
  assert.equal(cookieName(backCookies[0]), "mock_user_id");
  const backCookie = backCookies[0].split(";")[0];

  const backMe = await fetch(new URL("/api/me", BASE), { headers: { cookie: backCookie } });
  assert.equal((await backMe.json()).data.id, "u-1001", "不带 userId 时登录名单里的第一位");
});

test("§十三.6 退出走既有接口：服务端下发清 Cookie 的响应，客户端不需要自己删", { skip: SKIP }, async () => {
  const login = await mockLoginBody("u-1002");
  const cookie = login.headers.getSetCookie()[0].split(";")[0];

  const out = await fetch(new URL("/api/auth/logout", BASE), {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(out.status, 200);

  const cleared = out.headers.getSetCookie().find((value) => cookieName(value) === "mock_user_id");
  assert.ok(cleared, "退出必须由服务端下发 mock_user_id 的清除指令，而不是让客户端自己删");
  assert.ok(
    /Max-Age=0/i.test(cleared) || /Expires=Thu, 01 Jan 1970/i.test(cleared),
    `退出后该 Cookie 必须过期，实际拿到的是：${cleared}`,
  );
});

test("§十三.8 切到普通用户拿不到打手权限：两个打手接口都是 403，不是 401", { skip: SKIP }, async () => {
  const login = await mockLoginBody("u-1002");
  const cookie = login.headers.getSetCookie()[0].split(";")[0];

  for (const pathname of ["/api/companion/orders", "/api/companion/dispatches"]) {
    const response = await fetch(new URL(pathname, BASE), { headers: { cookie } });
    assert.equal(response.status, 403, `${pathname} 普通用户必须 403（登录了，但不是打手）`);
    assert.equal((await response.json()).error.code, "FORBIDDEN");
  }

  const anonymous = await fetch(new URL("/api/companion/orders", BASE));
  assert.equal(anonymous.status, 401, "未登录是 401 —— 与「不是打手」分开表达");
});

/**
 * §八.4/5/6 的**真服务**版本：`requireCompanion()` 对打手 A / B 放行。
 *
 * 上面那条数据层用例证的是「判定为 granted」，而这一条证的是**守卫真的放行**：
 * 它是 401 / 403 的分支逻辑，只有带真实 Cookie 打到真接口才走得到。
 * 这两件事不是同一件——判定对了而守卫写错（例如把 kind 比错）时，只有这里会红。
 *
 * ⚠️ 全程只 GET，不写任何数据（见本节开头）。列表内容不在这里断言：
 * 这一节跑在一台被整轮 HTTP 用例共享的服务器上，池子里有几单取决于谁先跑。
 */
test("§八.4/5/6 打手 A / B 的会话真的能过 requireCompanion()：工作台接口 200 而不是 403", { skip: SKIP }, async () => {
  for (const option of approvedOptions) {
    const login = await mockLoginBody(option.userId);
    assert.equal(login.status, 200, `${option.userId} 应当能登录`);
    const cookie = login.headers.getSetCookie()[0].split(";")[0];

    // 打手「我的订单」：守卫放行才会走到服务层
    const orders = await fetch(new URL("/api/companion/orders", BASE), { headers: { cookie } });
    assert.equal(
      orders.status,
      200,
      `${option.userId}（${option.purpose}）打开打手订单接口拿到 ${orders.status}：守卫没有放行`,
    );

    // 订单池：顺便确认这位打手的 `canAccept` 为真——「进得去但一条单都不给」不算能接单
    const dispatches = await fetch(new URL("/api/companion/dispatches", BASE), { headers: { cookie } });
    assert.equal(dispatches.status, 200, `${option.userId} 读订单池拿到 ${dispatches.status}`);
    assert.equal(
      (await dispatches.json()).data.canAccept,
      true,
      `${option.userId} 的 canAccept 为假：公共池不会给他任何一单`,
    );
  }
});
