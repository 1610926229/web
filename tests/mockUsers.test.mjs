import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveSource } from "./app-path.mjs";
import {
  MOCK_LOGIN_APPLICATION_STATE_LABELS,
  MOCK_LOGIN_USERS,
} from "../lib/constants/mockUsers.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { userSeed } from "../lib/mocks/fixtures/seed.ts";

/**
 * Mock 登录的**测试账号名单**（P0-5 手工验收基础设施）。
 *
 * ## 这份测试在防什么
 *
 * 名单是一份**写给验收的人看的断言**：它说「u-1002 名下有一条待查看的申请，
 * 后台可以直接通过」。这句话没有任何东西在运行时校验——它就是一段文案。
 * 一旦 Seed 改了、或者有人手滑写错了 id，验收的人会照着它走，
 * 然后在半路撞上「这个账号提交不了申请」，再花时间判断是产品坏了还是名单错了。
 *
 * 所以这里把名单里的每一句话都拿**真实 Seed** 核一遍：
 * 人存在、昵称对得上、申请状态对得上、而且这个账号**确实能变成打手**。
 *
 * ## 还钉住了「只在登录界面出现」这条边界
 *
 * 用户前台的账号切换能力必须收敛在一处：**未登录时的登录界面**。
 * 已登录的页面里除了设置页那个「退出并重选」的入口，不该有第二个开关。
 * 这两条都是结构约束，源码扫描是唯一能钉住它们的方式。
 */

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath) {
  return readFileSync(resolveSource(relativePath), "utf8");
}

/**
 * 去掉注释后再做「源码里有没有某个词」的断言。
 *
 * 与其它测试同一套理由：本仓库的注释会把**不应该存在的东西**写进去做反例说明
 * （例如「没有第二套登录」这句话里就带着「第二套登录」），不去注释会全红。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 遍历仓库源码目录（跳过隐藏目录与 node_modules）。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * 仓库里所有用户端/打手端 .ts/.tsx 源文件（**绝对路径**）。
 *
 * ⚠️ 返回绝对路径而不是相对路径：`resolveSource()` 会把 `app/...` 当成**路由**去查
 * （忽略路由组），而遍历出来的路径带着 `(mobile)` / `(tabs)` 这些路由组段，
 * 两边对不上会直接抛错。遍历的结果只用于「哪些文件提到了某个名字」，直接读绝对路径最省事。
 */
function sourceFiles() {
  const roots = ["app", "components", "lib"];
  const files = [];
  for (const root of roots) {
    for (const full of walk(path.join(SOURCE_ROOT, root))) {
      if (/\.(ts|tsx)$/.test(full)) files.push(full);
    }
  }
  return files;
}

/** 仓库根下的相对路径，统一 `/` 分隔，用于断言里的可读输出。 */
function relativeOf(absolute) {
  return path.relative(SOURCE_ROOT, absolute).replace(/\\/g, "/");
}

const applicationByUserId = new Map(
  companionApplicationSeed.map((application) => [application.userId, application]),
);

test("名单里的每个账号都真实存在，且昵称与 Seed 一致", () => {
  const usersById = new Map(userSeed.map((user) => [user.id, user]));

  for (const option of MOCK_LOGIN_USERS) {
    const user = usersById.get(option.userId);
    assert.ok(user, `名单里的 ${option.userId} 在 userSeed 里不存在`);
    assert.equal(
      option.nickname,
      user.nickname,
      `${option.userId} 的昵称与 Seed 不一致：名单写「${option.nickname}」，Seed 是「${user.nickname}」`,
    );
  }
});

test("名单标注的入驻申请状态与预置数据一致", () => {
  for (const option of MOCK_LOGIN_USERS) {
    const application = applicationByUserId.get(option.userId);

    if (option.applicationState === "none") {
      assert.equal(
        application,
        undefined,
        `${option.userId} 在名单里标成「无入驻申请」，但预置里有一条 ${application?.status} 申请`,
      );
      continue;
    }

    assert.ok(application, `${option.userId} 标成「${option.applicationState}」，但预置里没有申请记录`);
    assert.equal(
      option.applicationState,
      application.status,
      `${option.userId} 的申请状态与预置不一致：名单写「${option.applicationState}」，预置是「${application.status}」`,
    );
  }
});

/**
 * 名单里不能出现「预置状态为已通过 / 未通过 / 已撤销」的账号。
 *
 * 一个人只能有一条申请（见入驻申请接口），因此这三种状态下这个账号
 * **既提交不了新的申请，后台也没有可批的申请**——点进去只会卡在半路，
 * 而验收的第一步恰恰是「把自己变成打手」。
 */
test("名单里不出现无法变成打手的账号（申请已通过 / 未通过 / 已撤销）", () => {
  const deadEnds = new Set(["approved", "rejected", "withdrawn"]);

  for (const option of MOCK_LOGIN_USERS) {
    const application = applicationByUserId.get(option.userId);
    assert.equal(
      Boolean(application && deadEnds.has(application.status)),
      false,
      `${option.userId} 的预置申请状态是 ${application?.status}，这个账号无法通过本轮验收变成打手`,
    );
  }
});

/**
 * 验收链路上的两种人**必须都在名单里**：
 *
 * - 至少一个「无申请」的账号：用来走「提交入驻申请 → 后台通过」；
 * - 至少两个「已有待查看 / 审核中申请」的账号：用来走「后台直接通过」，
 *   而且**要两个**，因为「两个打手抢同一张单」需要两个不同的人。
 *
 * 这条断言看似在数数，实际在保护一个具体的验收步骤：少一个，场景 B 就走不通。
 */
test("名单覆盖验收所需的两种账号：可新提交申请的，与可直接被后台通过的", () => {
  const fresh = MOCK_LOGIN_USERS.filter((option) => option.applicationState === "none");
  const approvable = MOCK_LOGIN_USERS.filter((option) => option.applicationState !== "none");

  assert.ok(fresh.length >= 1, "名单里至少要有 1 个可以新提交入驻申请的账号");
  assert.ok(approvable.length >= 2, "名单里至少要有 2 个可被后台直接通过申请的账号（抢单需要两个打手）");
});

test("名单本身没有重复与空字段，且每个状态都有显示名", () => {
  const ids = MOCK_LOGIN_USERS.map((option) => option.userId);
  assert.equal(new Set(ids).size, ids.length, "名单里出现了重复的 userId");
  assert.ok(ids.length > 0, "名单不能是空的");

  for (const option of MOCK_LOGIN_USERS) {
    assert.ok(option.nickname.trim(), `${option.userId} 缺少昵称`);
    assert.ok(option.purpose.trim(), `${option.userId} 缺少用途说明`);
    assert.ok(
      MOCK_LOGIN_APPLICATION_STATE_LABELS[option.applicationState],
      `${option.userId} 的申请状态「${option.applicationState}」没有显示名`,
    );
  }
});

/* ───────────────────────── 结构约束：切换能力只有一处 ───────────────────────── */

test("测试账号选择器只在登录界面里渲染，且只在 Mock 开关打开时渲染", () => {
  const gate = stripComments(readSource("lib/auth/LoginGate.tsx"));

  assert.ok(
    /mockAuthEnabled\s*\?\s*\(\s*<MockUserPicker/.test(gate.replace(/\s+/g, " ")),
    "LoginGate 必须在 mockAuthEnabled 为真时才渲染选择器",
  );

  const references = sourceFiles()
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes("MockUserPicker"))
    .map(relativeOf);

  assert.deepEqual(
    references.sort(),
    ["lib/auth/LoginGate.tsx", "lib/auth/MockUserPicker.tsx"],
    "测试账号选择器只应被登录界面引用：它不该出现在任何已登录的页面里",
  );
});

/**
 * 选择器**不能自己变成一套登录实现**。
 *
 * 它只允许交出 userId，由 `LoginGate` 走 `authAdapter`（最终打到
 * `/api/auth/mock-login`，由服务端决定这个人是谁）。一旦它开始自己写 Cookie、
 * 或者自己拼请求，用户端就出现了第二条登录路径，而那条路径不受
 * `ENABLE_MOCK_AUTH` 的服务端判定约束。
 */
test("选择器不直接写 Cookie，也不自己发请求", () => {
  const picker = stripComments(readSource("lib/auth/MockUserPicker.tsx"));

  for (const forbidden of ["document.cookie", "fetch(", "apiPost", "mock_user_id"]) {
    assert.equal(picker.includes(forbidden), false, `选择器里不应出现 ${forbidden}`);
  }
});

/**
 * 已登录页面上唯一的切换途径：设置页的「退出并重选」。
 *
 * 两个约束：入口在开关分支里（关掉 Mock 登录时整块不渲染）；
 * 组件本身**不接受任何身份参数**——它只能做「退出」，不能做「以某个身份登录」。
 */
test("设置页的切换入口受开关控制，且它只能退出、不能指定身份", () => {
  const page = stripComments(readSource("app/settings/page.tsx"));
  const compact = page.replace(/\s+/g, " ");

  assert.ok(
    /mockAuthEnabled \? \([\s\S]*?<MockUserSwitchButton[\s\S]*?\) : null/.test(compact),
    "设置页的切换入口必须在 mockAuthEnabled 为真时才渲染",
  );

  const button = stripComments(readSource("components/settings/MockUserSwitchButton.tsx"));

  assert.ok(button.includes("useAuth()"), "切换入口必须复用登录态上下文，而不是自己读会话");
  assert.ok(button.includes("logout()"), "切换入口的动作是退出登录");
  for (const forbidden of ["document.cookie", "mock_user_id", "userId", "fetch(", "apiPost"]) {
    assert.equal(
      button.includes(forbidden),
      false,
      `切换入口里不应出现 ${forbidden}：它只能做「退出」，不能指定以谁的身份登录`,
    );
  }
});

/**
 * 名单文件本身必须是**无依赖**的常量：它会被客户端组件引用，
 * 一旦 import 了 `lib/data` 或环境变量，Mock 数据层与整个仓储就会被打进浏览器产物。
 */
test("名单文件没有任何 import：它是纯常量，可以安全地进客户端产物", () => {
  const source = readSource("lib/constants/mockUsers.ts");
  assert.equal(
    /^\s*import\s/m.test(stripComments(source)),
    false,
    "lib/constants/mockUsers.ts 不应当有任何 import",
  );
});
