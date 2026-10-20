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
import { resolveCompanionAccess } from "../lib/services/companionAccess.ts";

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
 * ## 还钉住了「谁可以读这份名单」这条边界
 *
 * DEV-1 之前这条写的是「只在登录界面出现」——**那句话已作废**
 * （见 `docs/03-dev/rounds/DEV-1/02-decisions.md` D1）。DEV-1 起用户端
 * 有意存在**两个**读名单的地方：未登录时的登录界面（`LoginGate`），
 * 以及已登录侧那个开发环境专用的悬浮面板（`MockIdentityPanel`）。
 *
 * 约束因此从「只有一处」改成**显式宿主清单**：多一个宿主就必须在这里
 * 写清楚，并且**必须同样受 `ENABLE_MOCK_AUTH` 的服务端判定约束**——
 * 面板只允许被 `MockIdentitySwitcher`（服务端门禁）引用，不允许任何页面
 * 直接挂它，否则开关就只挡 UI 不挡数据。
 *
 * 这些都是结构约束，源码扫描是唯一能钉住它们的方式。
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
 * 名单里不能出现**未通过 / 已撤销**的账号。
 *
 * 一个人只能有一条申请（见入驻申请接口），因此这两种状态下这个账号
 * **既提交不了新的申请，后台也没有可批的申请**——点进去只会卡在半路。
 *
 * ⚠️ `approved` **不在这条禁令里**（DEV-1 起，见 `02-decisions.md` D6 V2）：
 * 一个审核已通过、名下真有护航资料的账号是**现成的打手**，可以直接拿去接单，
 * 不是死路——它正是「一启动就要有两个打手可切」这条要求的落点。
 * 但「已通过」本身不算数，下面的第二条断言要求它**真的**是打手。
 */
test("名单里不出现无法变成打手的账号（申请未通过 / 已撤销）", () => {
  const deadEnds = new Set(["rejected", "withdrawn"]);

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
 * 标着 `approved` 的账号**必须真的是打手**——这条是名单与资格的唯一接口。
 *
 * 名单只是一段文案，写「他是打手」没有任何东西在运行时拦得住；
 * 而标签一旦与事实不符，验收的人就会遇到「标着有效打手、点进去 403」。
 * 因此这里不看名单怎么写，直接问唯一的资格入口 `resolveCompanionAccess`。
 *
 * ⚠️ 这也是「标签由服务端派生」那条设计的兜底：`MockIdentitySwitcher` 渲染的
 * 标签就是按同一个函数现算的，两者不可能一个说是一个说不是。
 */
test("标着「入驻已通过」的账号必须真的是有效打手（由 resolveCompanionAccess 判定）", async () => {
  const approvedOptions = MOCK_LOGIN_USERS.filter((option) => option.applicationState === "approved");

  assert.ok(
    approvedOptions.length >= 2,
    "DEV-1 要求至少两个具备有效 Companion 资格的 User，名单里标着「入驻已通过」的少于两个",
  );

  for (const option of approvedOptions) {
    const access = await resolveCompanionAccess(option.userId);
    assert.equal(
      access.kind,
      "granted",
      `${option.userId} 标着「入驻已通过」，但资格判定是 ${access.kind}：名单在说谎`,
    );
  }
});

/**
 * 验收链路上的三种人**必须都在名单里**：
 *
 * - 至少一个「无申请」的账号：用来走「提交入驻申请 → 后台通过」，也是下单的老板；
 * - 至少两个「已有待查看 / 审核中申请」的账号：用来走「后台直接通过」，
 *   而且**要两个**，因为「两个打手抢同一张单」需要两个不同的人；
 * - 至少两个「已经是打手」的账号：用来**跳过审核**直接跑
 *   「下单 → A 接单/取消 → B 抢单」这条链（DEV-1 被打回的那一轮缺的就是这一档）。
 *
 * ⚠️ 第二条的判据必须是 `pending` / `reviewing` 而不是「不等于 none」：
 * `approved` 现在也在名单里，用「不等于 none」会把那一档算进来，
 * 这条断言就退化成永远为真了。
 */
test("名单覆盖验收所需的三种账号：可新提交申请的、可直接被后台通过的、已经是打手的", () => {
  const fresh = MOCK_LOGIN_USERS.filter((option) => option.applicationState === "none");
  const approvable = MOCK_LOGIN_USERS.filter((option) =>
    ["pending", "reviewing"].includes(option.applicationState),
  );
  const alreadyCompanion = MOCK_LOGIN_USERS.filter(
    (option) => option.applicationState === "approved",
  );

  assert.ok(fresh.length >= 1, "名单里至少要有 1 个可以新提交入驻申请的账号");
  assert.ok(approvable.length >= 2, "名单里至少要有 2 个可被后台直接通过申请的账号（抢单需要两个打手）");
  assert.ok(
    alreadyCompanion.length >= 2,
    "名单里至少要有 2 个已经是打手的账号：否则「下单 → A 接单 → B 抢单」必须先人工审核一遍",
  );
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

/* ─────────────────── 结构约束：切换能力只有两处，且都受开关控制 ─────────────────── */

/**
 * 选择器只有**两个**宿主，两个都在服务端开关之下。
 *
 * DEV-1 之前这条钉的是「只出现在登录界面」。DEV-1 加了一个已登录侧的悬浮面板
 * （`lib/auth/MockIdentityPanel.tsx`），因此约束随之改成**显式宿主清单**——
 * 与 `tests/admin.test.mjs` 的后台接口清单、`tests/companionAccess.test.mjs`
 * 的资格调用点清单同一个做法：**多一个宿主就必须在这里写清楚**，
 * 而不是从「只有一处」变成「谁都能引」。
 *
 * ⚠️ 一并钉住「面板只能经门禁进入」：`MockIdentityPanel` 只被
 * `MockIdentitySwitcher`（服务端开关）引用。少了这一条，将来某个页面可以
 * 直接 `<MockIdentityPanel current={...} />`，绕过开关把工具渲染到正式环境里。
 */
test("测试账号选择器只有两个宿主：登录界面与 DEV-1 面板，且面板只能经服务端门禁进入", () => {
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
    ["lib/auth/LoginGate.tsx", "lib/auth/MockIdentityPanel.tsx", "lib/auth/MockUserPicker.tsx"],
    "测试账号选择器的宿主是一份显式清单：新增一处就必须在这里写清楚，并确认它同样受开关控制",
  );

  const panelReferences = sourceFiles()
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes("MockIdentityPanel"))
    .map(relativeOf);

  assert.deepEqual(
    panelReferences.sort(),
    ["lib/auth/MockIdentityPanel.tsx", "lib/auth/MockIdentitySwitcher.tsx"],
    "DEV-1 面板只应被服务端门禁引用：直接挂到页面上的话，开关就只挡 UI 不挡数据了",
  );

  const switcher = stripComments(readSource("lib/auth/MockIdentitySwitcher.tsx"));
  assert.ok(
    /if\s*\(\s*!isMockAuthEnabled\(\)\s*\)\s*return null/.test(switcher.replace(/\s+/g, " ")),
    "门禁必须在开关关闭时直接返回 null（不渲染），而不是把面板渲染出来再置灰",
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
 * 选择器的参数只允许是**显示用**的（DEV-1 D3 V2 的最终执行规则）。
 *
 * 这条规则来自一次真实的打回：DEV-1 首轮用「多一次资格查询、只省一次跳转」的成本理由
 * 拒绝了「面板该显示谁是打手」，被人工作为需求未达成驳回。重做批改为**加**一个显示参数，
 * 同时把边界写死：`MockUserPicker` 可以多知道「显示什么」，**不能**多知道「点了会怎样」。
 *
 * 为什么这条要写成测试：显示参数加错了只是难看，行为参数加错了就是**权限**——
 * 一个 `canPick` / `disabledIds` 这样的参数等于把「谁能被切换」搬进了客户端组件，
 * 而本仓库的权限只在服务端。参数集合是封闭的，加第四个就得先来这里说明它为什么不是权限。
 */
test("选择器的参数只允许是显示用的：没有任何影响点击 / 跳转 / 校验的参数", () => {
  const picker = stripComments(readSource("lib/auth/MockUserPicker.tsx"));

  // 参数集合是**封闭**的：多一个少一个都会在这里被发现
  const props = [...picker.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
  assert.deepEqual(
    props.sort(),
    ["accessLabels", "busyId", "currentUserId", "onPick"],
    "MockUserPicker 的参数集合变了：新增的参数必须先说明它为什么是显示用的、而不是权限",
  );

  // 行为只由 `busyId`（登录进行中）决定，与资格标签、当前身份**无关**
  const disabledUses = [...picker.matchAll(/disabled=\{([^}]*)\}/g)].map((match) => match[1].trim());
  assert.ok(disabledUses.length > 0, "选择器应当仍由 busyId 控制禁用");
  for (const expression of disabledUses) {
    assert.ok(
      expression.includes("busy"),
      `禁用条件里出现了 ${expression}——资格 / 当前身份不得影响能不能点`,
    );
  }

  // 「当前身份」只影响外观与文案，不得变成禁用条件或跳转目标
  assert.equal(
    /current\w*\s*\?[^:]*(?:router|href|push|replace)/.test(picker),
    false,
    "「当前身份」不该触发跳转：它只是显示",
  );
  assert.equal(picker.includes("router"), false, "选择器不做跳转，跳转由宿主决定");
});

/**
 * 设置页的「退出并重选」：它只能退出，不能指定身份。
 *
 * ⚠️ DEV-1 之前这条写的是「已登录页面上唯一的切换途径」。DEV-1 加了悬浮面板之后
 * 这句话不再成立，因此本用例的约束**缩小到设置页这一个组件**，
 * 它守的东西一点没变：入口在开关分支里（关掉 Mock 登录时整块不渲染）；
 * 组件本身**不接受任何身份参数**——它只能做「退出」，不能做「以某个身份登录」。
 *
 * 「能指定身份」的那个入口（DEV-1 面板）由上面那条宿主清单守：
 * 它只能出现在服务端开关之下，且仍然走 `authAdapter` → `/api/auth/mock-login`
 * 这一条登录链路（见 `tests/devIdentity.test.mjs`）。
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
