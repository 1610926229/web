import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import {
  getCompanionWorkspaceView,
  resolveCompanionAccess,
} from "../lib/services/companionAccess.ts";
import { hasAppFile } from "./app-path.mjs";

/**
 * P0-4「打手工作台接入」的持续测试。
 *
 * 本批次只做一件事：**已是打手的用户能从自己的用户会话直接进入工作台**。
 * 因此这里锁的不是页面长什么样，而是三条边界：
 *
 * 1. **访问规则只有一处**（`resolveCompanionAccess`）：无护航资料 / 已下架 / 正常，
 *    三种结论由同一段代码给出，页面与接口守卫都读它。软移除**不是**一个额外的判断——
 *    它由 `findCompanionByUser` 的「有效护航」口径覆盖（下面有专门的回归断言）。
 * 2. **没有第二套身份**：负向门禁扫描全仓，确认不存在独立的打手会话模块、Cookie、
 *    环境开关、登录页与认证接口。这条门禁**刻意扫描注释**——一句「这里没有 X」的注释
 *    同样是后来者重新引入 X 的起点。
 * 3. **打手 DTO 是显式挑字段的**：`enabled` / `removedAt` / `applicationId` / `intro`
 *    这些内部字段不进工作台 DTO。
 *
 * ⚠️ 内存 Mock 仓储在同一进程内是共享的（node 对每个测试文件起一个子进程），
 * 因此需要写数据的用例一律用 `uniqueUser()` 生成独立用户，用例之间不会互相看见对方。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let userSeq = 0;
/** 每个用例一个全新用户 id，避免用例之间互相污染护航名单。 */
function uniqueUser() {
  userSeq += 1;
  return `u-p04-${process.pid}-${userSeq}`;
}

let companionSeq = 0;
/** 一条形状完整的护航资料；只需覆盖关心的字段。 */
function companionFixture(userId, overrides = {}) {
  companionSeq += 1;
  return {
    id: `cp-p04-${process.pid}-${companionSeq}`,
    userId,
    applicationId: null,
    removedAt: null,
    displayName: `测试护航${companionSeq}（占位）`,
    avatarUrl: "/mock/avatars/companion-1.svg",
    rankLabel: "钻石打手",
    intro: "这是一段不会出现在工作台 DTO 里的自我介绍",
    gameIds: [],
    regions: [],
    serviceTags: [],
    available: false,
    unavailableReason: "",
    completedOrderCount: 0,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 999,
    enabled: true,
    reviews: [],
    ...overrides,
  };
}

/** 建一条护航资料（等价于「入驻申请审核通过」在数据层的落点）。 */
async function grantCompanion(userId, overrides) {
  const created = await getCompanionRepository().createCompanion(companionFixture(userId, overrides));
  assert.equal(created.kind, "created", "这条用例需要一条新创建的护航资料");
  return created.companion;
}

// ——————————————————————— 一、三种访问态 ———————————————————————

test("没有护航资料的用户 → not-a-companion（含预置用户与空 id）", async () => {
  // u-1001 是预置普通用户：预置护航（cp-*）的 userId 一律为 null，没有用户关联到它
  for (const userId of ["u-1001", uniqueUser(), "", "u-不存在的人"]) {
    assert.deepEqual(
      await resolveCompanionAccess(userId),
      { kind: "not-a-companion" },
      `${JSON.stringify(userId)} 不该被当成护航`,
    );
  }
});

test("有护航资料且启用 → granted，DTO 恰好是工作台要用的四个字段", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId);

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "granted");
  assert.deepEqual(state.companion, {
    userId,
    companionId: created.id,
    displayName: created.displayName,
    avatarUrl: created.avatarUrl,
  });

  // 内部字段一个都不进工作台 DTO：上架开关、软移除时间、来源申请、自我介绍、接单状态…
  assert.deepEqual(
    Object.keys(state.companion).sort(),
    ["avatarUrl", "companionId", "displayName", "userId"],
    "工作台 DTO 的字段表就是边界，多一个字段多一条泄漏路径",
  );
});

test("护航资料被下架（enabled = false）→ disabled，既不是 granted 也不是 not-a-companion", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId, { enabled: false });

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "disabled", "下架与「不是护航」是两件事：页面提示与后续处置都不同");
  assert.equal(state.companion.companionId, created.id);
});

test("用户隔离：别人是护航，不代表我是护航", async () => {
  const me = uniqueUser();
  const other = uniqueUser();
  await grantCompanion(other);

  assert.deepEqual(await resolveCompanionAccess(me), { kind: "not-a-companion" });
  assert.equal((await resolveCompanionAccess(other)).kind, "granted");
});

// ——————————————————————— 二、软移除（回归断言）———————————————————————

/**
 * ⚠️ 这一条是**唯一**允许在「有效护航」口径变化时被改写的用例。
 *
 * 它防的是一个具体的、很容易犯的错误：把软移除当成第四种访问态，
 * 或者在访问规则里再写一次 `removedAt === null`。两种写法都会让
 * 「已移除」与「已下架」在页面上长得一样，而两者的后续处置完全不同——
 * 下架是暂时的（管理员可以恢复），移除之后再进工作台必须重新走审核。
 */
test("软移除之后不再算护航：由 findCompanionByUser 的「有效护航」口径覆盖，不是第四种状态", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId);
  assert.equal((await resolveCompanionAccess(userId)).kind, "granted");

  await getCompanionRepository().markCompanionRemoved(created.id, new Date().toISOString());

  // 仓储口径本身：已移除的不算「有效护航」
  assert.equal(
    await getCompanionRepository().findCompanionByUser(userId),
    null,
    "findCompanionByUser 应当只返回未移除的记录",
  );
  // 因此访问态是 not-a-companion，**不是** disabled
  assert.deepEqual(await resolveCompanionAccess(userId), { kind: "not-a-companion" });

  // 但记录本身仍然取得到：软移除不是删除，历史订单与评价还要指得到它
  const removed = await getCompanionRepository().findCompanionById(created.id);
  assert.ok(removed, "软移除不该把记录删掉");
  assert.notEqual(removed.removedAt, null);
});

test("移除之后重新审核通过：又能进入工作台（移除会释放「一名用户一条有效护航」的名额）", async () => {
  const userId = uniqueUser();
  const first = await grantCompanion(userId);
  await getCompanionRepository().markCompanionRemoved(first.id, new Date().toISOString());

  const second = await grantCompanion(userId);

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "granted");
  assert.equal(state.companion.companionId, second.id, "工作台应当指向新的那条资料");
});

// ——————————————————————— 三、工作台视图 ———————————————————————

test("getCompanionWorkspaceView：只有 granted 才有工作台数据，其余一律 null", async () => {
  const normal = uniqueUser();
  const disabled = uniqueUser();
  const companion = uniqueUser();
  await grantCompanion(disabled, { enabled: false });
  const created = await grantCompanion(companion);

  assert.equal(await getCompanionWorkspaceView(normal), null, "不是护航的人没有工作台数据");
  assert.equal(await getCompanionWorkspaceView(disabled), null, "资格已下架的人同样没有");

  const view = await getCompanionWorkspaceView(companion);
  assert.ok(view, "护航应当拿得到工作台数据");
  assert.equal(view.companion.companionId, created.id);
  assert.equal(view.companion.displayName, created.displayName);
  assert.equal(view.rankLabel, created.rankLabel);
  // 工作台视图只给「你是谁」：订单、收益、接单相关字段一个都没有
  assert.deepEqual(Object.keys(view).sort(), ["companion", "rankLabel"]);
});

// ——————————————————————— 四、负向门禁 ———————————————————————

/** 递归列出目录下的全部文件（跳过 `.` 开头的目录，与路由规则一致）。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * 负向门禁：**打手身份建立在现有 User Session 之上**。
 *
 * 打手不是第四套账号：没有自己的会话模块、Cookie、环境开关、登录页与认证接口。
 * 身份一律由 `requireUser()`（用户会话）→ 护航资料推导出来。
 *
 * ⚠️ 扫描范围是 `app/` `lib/` `components/`，**不含 `tests/` 与 `docs/`**：
 * 本文件与整改计划里必须写出这些标识才能禁止它们，把这两处纳入扫描等于
 * 让门禁自己把自己判红。要挡的是「生产代码里出现第二条路」，不是「文档里提到过它」。
 *
 * ⚠️ 扫描的是**原文，注释也算**。一句「本模块不建 companionSession」的注释
 * 正是后来者重新引入它的起点；用词上绕开标识本身，成本远低于一次误判。
 *
 * ⚠️ 这里**不用** `readFlag(` 的调用次数做门禁：那会让以后新增任何无关环境开关时
 * 产生无意义的失败。本门禁要保证的是「打手能力不建立在第二个开关上」，
 * 不是「环境变量开关数量恒定」。
 */
test("负向门禁：仓库里不存在任何「第二套打手身份」的痕迹", () => {
  const FORBIDDEN_TOKENS = [
    "ENABLE_MOCK_COMPANION", // 独立的模拟开关
    "mock_companion_id", // 独立的会话 Cookie
    "companionSession", // 独立的会话模块
  ];

  const offenders = [];
  for (const dir of ["app", "lib", "components"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        if (source.includes(token)) offenders.push(`${path.relative(ROOT, file)} → ${token}`);
      }
    }
  }

  assert.deepEqual(offenders, [], "打手不该有独立的开关 / Cookie / 会话模块");
});

test("负向门禁：不存在打手独立登录页，也不存在打手认证接口", () => {
  // hasAppFile 忽略路由组：`app/companion/(auth)/login/page.tsx` 这种改头换面同样会被抓住
  assert.equal(
    hasAppFile("companion/login/page.tsx"),
    false,
    "打手没有独立登录页：未登录时复用用户端登录控件",
  );
  assert.equal(
    hasAppFile("api/companion/auth/mock-login/route.ts"),
    false,
    "打手没有独立认证接口",
  );

  // api/companion 下不允许出现任何 auth 段（将来加接单接口时也不会凭空长出一个）。
  // 按路由扫描而不是写死路径：多一层少一层、换个目录名都躲不过去。
  const APP_DIR = path.join(ROOT, "app");
  const offenders = [];
  for (const file of walk(APP_DIR)) {
    const route = path
      .relative(APP_DIR, file)
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
      .join("/");
    if (route.startsWith("api/companion/auth/")) offenders.push(route);
  }
  assert.deepEqual(offenders, [], "打手不该有独立的认证接口");
});

test("隔离断言：打手守卫走用户会话，且访问规则只有一处", () => {
  const code = stripComments(readFileSync(path.join(ROOT, "lib", "api", "companionRoute.ts"), "utf8"));

  // 身份来源是既有的用户会话守卫
  assert.ok(code.includes("requireUser"), "打手守卫必须先走既有的 requireUser()");

  // 不碰另外两套会话
  for (const forbidden of ["staffSession", "adminSession", "getSessionStaff", "getSessionAdmin"]) {
    assert.equal(code.includes(forbidden), false, `打手守卫不该引用 ${forbidden}`);
  }

  // 访问规则只有一处：守卫复用服务层的判定，而不是自己再查一次仓储
  assert.ok(
    code.includes("resolveCompanionAccess"),
    "访问规则应当只有 resolveCompanionAccess() 一处，守卫不得自己重写一遍",
  );
  assert.equal(
    code.includes("findCompanionByUser"),
    false,
    "守卫里再查一次仓储就会出现第二个真值来源（软移除口径会分叉）",
  );
});
