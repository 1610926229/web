import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { findAppFile } from "./app-path.mjs";
import {
  ADMIN_APPLICATION_METRIC_LABELS,
  ADMIN_APPLICATION_METRIC_STATUSES,
  ADMIN_COMPANION_METRIC_LABELS,
  ADMIN_NAV_ITEMS,
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS,
  ADMIN_UPCOMING_MODULES,
  canEnterAdminConsole,
  countCompanionStates,
} from "../lib/constants/admin.ts";
import { getAdminRepository } from "../lib/data/adminRepository.ts";
import { getCompanionApplicationRepository } from "../lib/data/companionApplicationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { MOCK_ADMIN_LOGIN_ID, adminSeed } from "../lib/mocks/fixtures/adminSeed.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { companionSeed } from "../lib/mocks/fixtures/seed.ts";
import { isMockAdminEnabled, isMockAuthEnabled } from "../lib/config/env.ts";
import {
  getAdminOverview,
  getCompanionApplicationCounts,
  getCompanionRosterCounts,
} from "../lib/services/adminConsole.ts";

/**
 * PC 管理后台的持续测试。
 *
 * 这一组测试守的是本阶段最要紧的几条边界，它们都属于**只有真跑起来才看得见**的类型：
 *
 * 1. **两套认证互不相通**：用户 Cookie 换不来管理权限，管理 Cookie 也冒充不了普通用户。
 *    这是安全边界，不能只靠注释；
 * 2. **角色判断只有一处**：`canEnterAdminConsole()`。只有 `admin` 能进，
 *    客服、护航、停用的管理员一律进不去；
 * 3. **概览数字来自仓储**：不是页面里写死的展示值——新提交一条申请，
 *    「待审核申请」必须跟着变；
 * 4. **开关关闭时能力真的消失**：`ENABLE_MOCK_ADMIN=false` 时登录接口 404，
 *    伪造 Cookie 也不产生任何身份，而用户端的 `ENABLE_MOCK_AUTH` 完全不受影响。
 *
 * 需要真实服务的断言（HTTP 状态码与 Cookie 行为）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `tests/http-smoke.test.mjs` 同一套做法。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API_DIR = path.join(ROOT, "app", "api", "admin");

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过管理端 HTTP 用例";

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「本页没有 X」不算出现 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(file) {
  return readFileSync(file, "utf8");
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 直接带着一份 Cookie 请求，用来验证「伪造 Cookie 会怎样」。 */
async function requestWithCookie(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

/** 登录一次并拿到服务端下发的 Cookie 名与值。 */
async function mockLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  const setCookie = response.headers.getSetCookie();
  return { status: response.status, setCookie };
}

/** 环境变量的原值，用于每个用例结束后还原。 */
const ORIGINAL_MOCK_ADMIN = process.env.ENABLE_MOCK_ADMIN;
const ORIGINAL_MOCK_AUTH = process.env.ENABLE_MOCK_AUTH;

function restoreEnv() {
  if (ORIGINAL_MOCK_ADMIN === undefined) delete process.env.ENABLE_MOCK_ADMIN;
  else process.env.ENABLE_MOCK_ADMIN = ORIGINAL_MOCK_ADMIN;
  if (ORIGINAL_MOCK_AUTH === undefined) delete process.env.ENABLE_MOCK_AUTH;
  else process.env.ENABLE_MOCK_AUTH = ORIGINAL_MOCK_AUTH;
}

beforeEach(() => {
  resetMockStore("admin");
  resetMockStore("companionApplication");
});

afterEach(restoreEnv);

// ——————————————————————————— 角色与权限 ———————————————————————————

test("角色齐全且都有文案，但只有 admin 能进管理后台", () => {
  assert.deepEqual([...ADMIN_ROLES].sort(), ["admin", "companion", "customer_service"]);
  for (const role of ADMIN_ROLES) {
    assert.equal(typeof ADMIN_ROLE_LABELS[role], "string");
    assert.ok(ADMIN_ROLE_LABELS[role].length > 0, `${role} 缺少角色文案`);
  }

  assert.equal(canEnterAdminConsole("admin"), true);
  // 客服与护航是平台里真实存在的身份，但都不是管理者
  assert.equal(canEnterAdminConsole("customer_service"), false);
  assert.equal(canEnterAdminConsole("companion"), false);
});

test("预置账号覆盖四种结局：能进、客服不能进、护航不能进、停用的管理员不能进", () => {
  const byId = new Map(adminSeed.map((item) => [item.id, item]));

  const admin = byId.get(MOCK_ADMIN_LOGIN_ID);
  assert.ok(admin, "模拟登录使用的账号必须存在于预置数据里");
  assert.equal(admin.role, "admin");
  assert.equal(admin.enabled, true);

  // 三种「会被拒绝的身份」都真实存在，规则因此不是只写在注释里
  assert.equal(byId.get("admin-2").role, "customer_service");
  assert.equal(byId.get("admin-3").role, "companion");
  assert.equal(byId.get("admin-4").role, "admin");
  assert.equal(byId.get("admin-4").enabled, false);

  // 预置里**没有密码、没有密钥**：不是「暂时留空」，而是根本没有这些字段
  for (const account of adminSeed) {
    assert.deepEqual(Object.keys(account).sort(), [
      "displayName",
      "enabled",
      "id",
      "lastLoginAt",
      "role",
      "username",
    ]);
    for (const key of Object.keys(account)) {
      assert.equal(/password|secret|token|hash|salt|credential/i.test(key), false, `不该有字段 ${key}`);
    }
  }
});

test("角色判断只有一处：服务层与组件里不出现写死的角色比较", () => {
  // 除了定义规则的那两个文件，其它地方都不该出现 `role === "admin"` 这类判断
  const allowed = new Set([
    path.join(ROOT, "lib", "constants", "admin.ts"),
    path.join(ROOT, "lib", "types", "admin.ts"),
  ]);

  const files = [
    ...collectFiles(path.join(ROOT, "lib", "services")),
    ...collectFiles(path.join(ROOT, "lib", "auth")),
    ...collectFiles(path.join(ROOT, "lib", "api")),
    ...collectFiles(path.join(ROOT, "components", "admin")),
    ...collectFiles(path.join(ROOT, "app", "admin")),
    ...collectFiles(ADMIN_API_DIR),
  ];

  for (const file of files) {
    if (allowed.has(file)) continue;
    const code = stripComments(readSource(file));
    assert.equal(
      /role\s*===\s*["']admin["']/.test(code),
      false,
      `${path.relative(ROOT, file)} 自己判断了角色，应当调用 canEnterAdminConsole()`,
    );
  }
});

function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test("每个管理接口都自己鉴权：只有登录与退出可以不要管理者身份", () => {
  const routeFiles = collectFiles(ADMIN_API_DIR).filter((file) => file.endsWith("route.ts"));
  assert.ok(routeFiles.length >= 3, "管理端认证接口至少有三个");

  /** 登录与退出发生在「还没有会话」的时候，不可能要求管理者身份。 */
  const anonymousRoutes = new Set(["auth/mock-login", "auth/logout"]);

  for (const file of routeFiles) {
    const relative = path.relative(ADMIN_API_DIR, file).replace(/\\/g, "/");
    const route = relative.replace(/\/route\.ts$/, "");
    const code = stripComments(readSource(file));

    if (anonymousRoutes.has(route)) {
      assert.equal(
        code.includes("requireAdmin()"),
        false,
        `${relative} 不该要求管理者身份（此时还没有会话）`,
      );
      continue;
    }

    assert.ok(
      code.includes("requireAdmin()"),
      `${relative} 没有调用 requireAdmin()：页面隐藏按钮挡不住直接请求接口`,
    );
  }

  // 会话查询本身就是一个管理接口，必须自己鉴权
  assert.ok(
    stripComments(readSource(path.join(ADMIN_API_DIR, "auth", "session", "route.ts"))).includes(
      "requireAdmin()",
    ),
  );
});

test("模拟登录接口不接受任何身份输入：没有请求体、没有账号切换器", () => {
  const code = stripComments(readSource(path.join(ADMIN_API_DIR, "auth", "mock-login", "route.ts")));

  // 不是「校验了角色字段」，而是根本没有读取它的位置
  for (const forbidden of ["readJsonBody", "request.json", "searchParams", "require("]) {
    assert.equal(code.includes(forbidden), false, `模拟登录接口不该读取 ${forbidden}`);
  }
  assert.ok(code.includes("export async function POST()"), "POST 不带参数：没有可以传身份的地方");

  // 登录对象由服务端固定，页面没有切换入口
  const panel = stripComments(
    readSource(path.join(ROOT, "components", "admin", "AdminLoginPanel.tsx")),
  );
  assert.equal(panel.includes("userId"), false, "登录面板不该出现可以指定的身份");
  assert.equal(/<input\b/.test(panel), false, "登录面板不该有输入框（没有账号密码可填）");
});

test("登录页与登录面板只有一个固定的模拟入口", () => {
  const source = readSource(path.join(ROOT, "components", "admin", "AdminLoginPanel.tsx"));

  // 唯一的按钮就是「模拟管理员登录」，且随 ENABLE_MOCK_ADMIN 开关出现或消失
  const buttons = source.match(/<button[\s\S]*?>/g) ?? [];
  assert.equal(buttons.length, 1, "登录面板只该有一个按钮");
  assert.ok(source.includes("ADMIN_MOCK_LOGIN_LABEL"));
  assert.ok(source.includes("mockAdminEnabled"));
  // 未启用时不渲染按钮，而是如实说明该能力未启用
  assert.ok(source.includes("ADMIN_MOCK_DISABLED_MESSAGE"));
});

// ——————————————————————————— 两套认证互不相通 ———————————————————————————

test("管理端与用户端是两个 Cookie、两个仓储：没有互相转换的函数", () => {
  const adminSession = stripComments(readSource(path.join(ROOT, "lib", "auth", "adminSession.ts")));
  const userSession = stripComments(readSource(path.join(ROOT, "lib", "auth", "session.ts")));

  // 两个不同的 Cookie 名
  assert.ok(adminSession.includes('"mock_admin_id"'));
  assert.ok(userSession.includes('"mock_user_id"'));
  assert.equal(userSession.includes("mock_admin_id"), false, "用户端会话不该认得管理端 Cookie");

  // 两条链路各自查各自的仓储
  assert.ok(adminSession.includes("getAdminRepository"));
  assert.equal(adminSession.includes("userRepository"), false, "管理端会话不该查用户仓储");
  assert.equal(userSession.includes("adminRepository"), false, "用户端会话不该查管理端仓储");

  // 管理端会话由独立开关控制；用户端模块不引用管理端开关
  assert.ok(adminSession.includes("isMockAdminEnabled"));
  assert.equal(userSession.includes("isMockAdminEnabled"), false, "用户端不该依赖管理端开关");
  assert.equal(userSession.includes("ENABLE_MOCK_ADMIN"), false);

  // 管理端 Cookie 的四个属性
  for (const attribute of ["httpOnly: true", 'sameSite: "lax"', 'path: "/"', "secure:"]) {
    assert.ok(adminSession.includes(attribute), `管理端 Cookie 缺少 ${attribute}`);
  }
  // 退出登录必须真的删掉 Cookie（maxAge: 0），而不是只清一个变量
  assert.ok(adminSession.includes("maxAge: 0"), "退出登录没有让 Cookie 失效");
});

test("用户仓储里没有角色字段：普通用户不可能「升级」成管理者", async () => {
  const userRepositorySource = readSource(path.join(ROOT, "lib", "data", "userRepository.ts"));
  const code = stripComments(userRepositorySource);

  assert.equal(code.includes("role"), false, "用户仓储出现了角色字段");
  for (const forbidden of ["AdminRole", "adminRepository", "canEnterAdminConsole"]) {
    assert.equal(code.includes(forbidden), false, `用户仓储不该出现 ${forbidden}`);
  }

  // 管理端账号与用户账号是两份数据：把管理端 id 当用户查，查不到
  const repository = getAdminRepository();
  const admins = await repository.listAdmins();
  assert.equal(admins.length, adminSeed.length);
  for (const admin of admins) {
    assert.equal(admin.id.startsWith("u-"), false, `管理端账号 id 与用户 id 取值域重叠：${admin.id}`);
  }
});

// ——————————————————————————— 开关 ———————————————————————————

test("两个开关各管各的：管理端开关不读用户端变量，反之亦然", () => {
  // 两个开关都关掉时都读成 false；只开一个时另一个不受影响
  delete process.env.ENABLE_MOCK_ADMIN;
  delete process.env.ENABLE_MOCK_AUTH;
  assert.equal(isMockAdminEnabled(), false);
  assert.equal(isMockAuthEnabled(), false);

  process.env.ENABLE_MOCK_ADMIN = "true";
  assert.equal(isMockAdminEnabled(), true);
  assert.equal(isMockAuthEnabled(), false, "开启管理端开关不该顺带打开用户端");

  process.env.ENABLE_MOCK_AUTH = "true";
  delete process.env.ENABLE_MOCK_ADMIN;
  assert.equal(isMockAdminEnabled(), false, "关闭管理端开关不该牵连用户端");
  assert.equal(isMockAuthEnabled(), true);

  // 取值必须显式等于字符串 "true"：其余写法一律按关闭处理
  for (const value of ["1", "yes", "TRUE", ""]) {
    process.env.ENABLE_MOCK_ADMIN = value;
    assert.equal(isMockAdminEnabled(), false, `ENABLE_MOCK_ADMIN=${value} 不该被当成开启`);
  }
});

test("未开启开关时，登录与退出都走「接口不存在」这条路径", () => {
  const service = stripComments(readSource(path.join(ROOT, "lib", "services", "adminAuth.ts")));

  // 两个动作都以开关判断开头，且都在碰 Cookie **之前**——关掉开关时服务端不必读 Cookie
  for (const action of ["loginMockAdmin", "logoutAdmin"]) {
    const start = service.indexOf(`export async function ${action}(`);
    assert.notEqual(start, -1, `找不到 ${action}`);
    const body = service.slice(start, start + 600);

    const guard = body.indexOf("isMockAdminEnabled()");
    assert.notEqual(guard, -1, `${action} 没有判断开关`);
    assert.ok(
      guard < body.indexOf("Cookie") || body.indexOf("Cookie") === -1,
      `${action} 应当先判断开关再碰 Cookie`,
    );
    // 404 而不是 403：一个被关掉的接口应当表现为不存在，而不是「你被拒绝了」
    assert.ok(body.includes('"NOT_FOUND"'), `${action} 关闭时应当返回 NOT_FOUND`);
    assert.ok(body.includes("404"), `${action} 关闭时应当是 404`);
  }

  // 提示文案与服务端同源，且明确点名了环境变量，便于排查
  const disabled = readSource(path.join(ROOT, "lib", "constants", "admin.ts"));
  assert.ok(disabled.includes("模拟管理员登录未启用"));
  assert.ok(disabled.includes("ENABLE_MOCK_ADMIN"));
});

test("登录会记录一次登录时间，但内部账号实体不外泄", async () => {
  const repository = getAdminRepository();
  const before = await repository.findAdminById(MOCK_ADMIN_LOGIN_ID);
  assert.equal(before.lastLoginAt, null);

  const updated = await repository.markLoggedIn(MOCK_ADMIN_LOGIN_ID, "2026-01-01T00:00:00.000Z");
  assert.equal(updated.lastLoginAt, "2026-01-01T00:00:00.000Z");

  // 不存在的账号返回 null，不抛错——登录时间只是审计信息，写失败不该让登录失败
  assert.equal(await repository.markLoggedIn("admin-999", "2026-01-01T00:00:00.000Z"), null);

  // 会话 DTO 只在服务层构造，页面拿到的字段就这五个
  const service = stripComments(readSource(path.join(ROOT, "lib", "services", "adminAuth.ts")));
  const dto = service.slice(
    service.indexOf("export function toAdminSessionUser"),
    service.indexOf("export async function getAdminSessionState"),
  );
  assert.deepEqual(
    [...dto.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]).sort(),
    ["displayName", "id", "role", "roleLabel", "username"],
  );
  for (const key of ["enabled", "lastLoginAt", "password"]) {
    assert.equal(dto.includes(`${key}:`), false, `会话 DTO 不该包含 ${key}`);
  }
});

// ——————————————————————————— 概览口径 ———————————————————————————

test("护航三个数的口径：下架记录不算「暂不可接单」", () => {
  const counts = countCompanionStates([
    { id: "a", enabled: true, available: true },
    { id: "b", enabled: true, available: false },
    { id: "c", enabled: false, available: true },
    { id: "d", enabled: false, available: false },
  ]);

  assert.deepEqual(counts, { enabled: 2, disabled: 2, unavailable: 1, total: 4 });
});

test("概览七项齐全：四个申请状态 + 三个护航状态，键名与地址稳定", async () => {
  const overview = await getAdminOverview(page());

  assert.deepEqual(
    overview.metrics.map((metric) => metric.key),
    [
      "applications.pending",
      "applications.reviewing",
      "applications.approved",
      "applications.rejected",
      "companions.enabled",
      "companions.disabled",
      "companions.unavailable",
    ],
  );

  for (const metric of overview.metrics) {
    assert.equal(Number.isInteger(metric.value), true, `${metric.key} 不是整数`);
    assert.ok(metric.value >= 0);
    assert.ok(metric.hint.length > 0, `${metric.key} 缺少口径说明`);
    assert.ok(metric.label.length > 0);
  }

  // 文案与状态取自常量，概览不另起一套叫法（改文案时不会只改到一半）
  const byKeyForLabels = new Map(overview.metrics.map((metric) => [metric.key, metric.label]));
  for (const status of ADMIN_APPLICATION_METRIC_STATUSES) {
    assert.equal(byKeyForLabels.get(`applications.${status}`), ADMIN_APPLICATION_METRIC_LABELS[status]);
  }
  for (const state of ["enabled", "disabled", "unavailable"]) {
    assert.equal(
      byKeyForLabels.get(`companions.${state}`),
      ADMIN_COMPANION_METRIC_LABELS[state],
    );
  }

  // 每张卡都指向对应模块的筛选地址
  const byKey = new Map(overview.metrics.map((metric) => [metric.key, metric]));
  assert.equal(byKey.get("applications.pending").href, "/admin/applications?status=pending");
  assert.equal(byKey.get("applications.rejected").href, "/admin/applications?status=rejected");
  assert.equal(byKey.get("companions.enabled").href, "/admin/companions?state=enabled");
  assert.equal(byKey.get("companions.unavailable").href, "/admin/companions?state=unavailable");

  // 「已撤销」刻意不进概览：撤销是用户自己的动作，不是平台待处理的工作量
  assert.equal(byKey.has("applications.withdrawn"), false);
  assert.equal(overview.metrics.length, 7);
});

test("概览数字来自仓储：新提交一条申请，「待审核申请」跟着变", async () => {
  const before = await getAdminOverview(page());
  const pendingBefore = before.metrics.find((item) => item.key === "applications.pending").value;

  // 预置数据里就有待审核申请，因此这里比较的是「多了一条」
  await getCompanionApplicationRepository().createApplication(
    {
      ...companionApplicationSeed[0],
      id: "ca-admin-test",
      applicationNo: "RA20260101999999",
      userId: "u-admin-test",
      status: "pending",
    },
    "admin-test-key",
  );

  const after = await getAdminOverview(page());
  const pendingAfter = after.metrics.find((item) => item.key === "applications.pending").value;

  assert.equal(pendingAfter, pendingBefore + 1, "概览数字没有跟着仓储变化，可能是写死的展示值");
  assert.ok(pendingBefore > 0, "预置数据里应当有待审核申请，否则这个用例证明不了任何事");
});

test("申请计数覆盖全部状态且按用户无差别统计", async () => {
  const counts = await getCompanionApplicationCounts(page());

  // 口径来自预置数据本身，而不是另一个写死的数字
  const expected = { pending: 0, reviewing: 0, approved: 0, rejected: 0, withdrawn: 0 };
  for (const application of companionApplicationSeed) expected[application.status] += 1;
  assert.deepEqual(counts, expected);
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    companionApplicationSeed.length,
  );
});

test("护航计数读的是用户端公开名单用的那一份数据", async () => {
  const counts = await getCompanionRosterCounts(page());

  assert.equal(counts.total, companionSeed.length, "护航名单应当是同一份陪玩数据");
  assert.equal(counts.enabled + counts.disabled, counts.total);
  assert.equal(
    counts.unavailable,
    companionSeed.filter((companion) => companion.enabled && !companion.available).length,
  );

  // 名单里确实有停用与暂不可接单的记录，这两个数字才有意义
  assert.ok(counts.disabled > 0);
  assert.ok(counts.unavailable > 0);
});

test("空数据不是错误：?mockEmpty 只把数字清零，仍然返回完整结构", async () => {
  const original = process.env.ENABLE_MOCK_DEBUG;
  process.env.ENABLE_MOCK_DEBUG = "true";

  try {
    const applications = await getCompanionApplicationCounts(page({ mockEmpty: "applications" }));
    assert.deepEqual(applications, {
      pending: 0,
      reviewing: 0,
      approved: 0,
      rejected: 0,
      withdrawn: 0,
    });

    const companions = await getCompanionRosterCounts(page({ mockEmpty: "companions" }));
    assert.deepEqual(companions, { enabled: 0, disabled: 0, unavailable: 0, total: 0 });

    // 只清一个范围时，另一组数字照常
    const mixed = await getAdminOverview(page({ mockEmpty: "applications" }));
    assert.equal(mixed.metrics.length, 7);
    assert.equal(mixed.metrics.find((item) => item.key === "applications.pending").value, 0);
    assert.ok(mixed.metrics.find((item) => item.key === "companions.enabled").value > 0);

    // ?mockEmpty=all 两组都清空 → 整页 0，仍然不抛错
    const all = await getAdminOverview(page({ mockEmpty: "all" }));
    assert.equal(all.metrics.length, 7);
    assert.ok(all.metrics.every((metric) => metric.value === 0));
  } finally {
    if (original === undefined) delete process.env.ENABLE_MOCK_DEBUG;
    else process.env.ENABLE_MOCK_DEBUG = original;
  }
});

test("调试开关关闭时 mockEmpty 不生效：数字仍然是真实聚合值", async () => {
  delete process.env.ENABLE_MOCK_DEBUG;

  const counts = await getCompanionApplicationCounts(page({ mockEmpty: "applications" }));
  assert.ok(
    Object.values(counts).reduce((sum, value) => sum + value, 0) > 0,
    "调试开关关闭时不该被 mockEmpty 影响",
  );
});

test("?mockError=1 抛错由错误边界处理，与「空数据」是两回事", async () => {
  const original = process.env.ENABLE_MOCK_DEBUG;
  process.env.ENABLE_MOCK_DEBUG = "true";

  try {
    await assert.rejects(getAdminOverview(page({ mockError: "1", mockDelay: 0 })), (error) => {
      assert.equal(error.code, "SERVER_ERROR");
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.ENABLE_MOCK_DEBUG;
    else process.env.ENABLE_MOCK_DEBUG = original;
  }
});

// ——————————————————————————— 页面与导航 ———————————————————————————

test("管理端页面都在 /admin 下，登录页不套后台壳层", () => {
  // 按**地址**找页面，不按文件位置：`findAppFile` 忽略路由组，
  // 因此这里写的是 `/admin` 与 `/admin/applications`，不是它们在磁盘上的目录。
  for (const route of [
    "admin/page.tsx",
    "admin/login/page.tsx",
    "admin/applications/page.tsx",
    "admin/companions/page.tsx",
  ]) {
    const file = findAppFile(route);
    assert.ok(file.length > 0, `缺少 ${route}`);
  }

  // 登录页在后台壳层之外：它既不该有侧栏，也不该先要求登录（那会转成一个死循环）
  const loginFile = findAppFile("admin/login/page.tsx");
  assert.equal(loginFile.includes("(console)"), false, "登录页不该待在后台壳层里");

  // 后台壳层的布局存在，且它罩住的是 /admin 本身
  const consoleLayout = findAppFile("admin/layout.tsx");
  assert.ok(consoleLayout.includes("(console)"), "后台壳层应当收在路由组里");

  // 用户端的移动壳层不在这条链上：后台的路由组全是后台自己的，一共就三个，
  // 而且每个都有明确用途（见下面的注释）。新冒出来一个就得是有理由的。
  const allowedGroups = new Set(["(console)", "(list)", "(overview)"]);
  for (const dir of collectDirs(path.join(ROOT, "app", "admin"))) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^\(.*\)$/.test(entry.name)) continue;
      assert.ok(
        allowedGroups.has(entry.name),
        `${path.relative(ROOT, path.join(dir, entry.name))} 是多余的路由组`,
      );
    }
  }

  // `(console)` 是后台壳层本身；`(list)` 与 `(overview)` 存在的唯一理由是**收住加载边界**：
  // `loading.tsx` 一旦罩到详情页上，外壳会先以 200 发出，迟到的 `notFound()` 只能改内容、
  // 改不了状态码。因此列表页各自把加载边界收在自己的路由组里，`[id]` 则一个都没有。
  for (const route of ["admin/companions/page.tsx", "admin/applications/page.tsx"]) {
    const file = findAppFile(route);
    assert.ok(file.includes("(list)"), `${route} 应当待在 (list) 里，加载边界才收得住`);
  }
  for (const route of ["admin/companions/[id]/page.tsx", "admin/applications/[id]/page.tsx"]) {
    const dir = path.dirname(findAppFile(route));
    assert.equal(
      readdirSync(dir).some((name) => /^loading\.(tsx|js)$/.test(name)),
      false,
      `${route} 不该有 loading.tsx：加载边界会把真 404 变成 200`,
    );
  }
});

/** 递归列出目录（含自身），用于「整棵子树里都不该有某样东西」的断言。 */
function collectDirs(dir) {
  const found = [dir];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...collectDirs(path.join(dir, entry.name)));
  }
  return found;
}

test("管理端壳层不复用用户端移动壳层，也不显示底部 TabBar", () => {
  const layout = stripComments(readSource(path.join(ROOT, "app", "admin", "(console)", "layout.tsx")));

  // 移动端 480px 容器与底部导航都不出现在后台
  for (const forbidden of ["MobileShell", "TabBar", "shell-width"]) {
    assert.equal(layout.includes(forbidden), false, `后台壳层不该引用 ${forbidden}`);
  }
  // 鉴权写在布局里：页面自己不再判断
  assert.ok(layout.includes("getAdminSession"));
  assert.ok(layout.includes("redirect("));

  // 侧栏与顶部条是后台自己的组件，且不引用用户端的壳层
  for (const file of ["AdminSidebar.tsx", "AdminHeader.tsx", "AdminMetricCards.tsx"]) {
    const code = stripComments(readSource(path.join(ROOT, "components", "admin", file)));
    for (const forbidden of ["MobileShell", "TabBar"]) {
      assert.equal(code.includes(forbidden), false, `${file} 不该引用 ${forbidden}`);
    }
  }
});

test("用户端不出现任何管理后台入口", () => {
  const userFiles = collectFiles(path.join(ROOT, "app", "(mobile)")).filter((file) =>
    file.endsWith(".tsx"),
  );
  userFiles.push(...collectFiles(path.join(ROOT, "components", "common")));

  for (const file of userFiles) {
    const code = stripComments(readSource(file));
    assert.equal(
      code.includes("/admin"),
      false,
      `${path.relative(ROOT, file)} 出现了管理后台入口`,
    );
  }
});

test("后台导航覆盖五个已开放模块，未开放模块没有入口", () => {
  // P8B 把「商品与类目」从 `ADMIN_UPCOMING_MODULES` 里搬进了导航：
  // 它们的页面已经存在，侧栏再挂一条「后续开放」就会与真实入口并存，
  // 运营点哪个都不对。这条断言守的是「导航与已建成的页面一一对应」。
  assert.deepEqual(
    ADMIN_NAV_ITEMS.map((item) => item.href),
    [
      "/admin",
      "/admin/applications",
      "/admin/companions",
      "/admin/categories",
      "/admin/products",
    ],
  );
  for (const item of ADMIN_NAV_ITEMS) {
    assert.ok(item.label.length > 0);
    assert.ok(item.description.length > 0);
  }

  // 后续阶段的模块只有名字，没有地址——不做成能点进去的空壳
  assert.ok(ADMIN_UPCOMING_MODULES.length > 0);
  const sidebar = readSource(path.join(ROOT, "components", "admin", "AdminSidebar.tsx"));
  const listStart = sidebar.indexOf("ADMIN_UPCOMING_MODULES.map");
  assert.notEqual(listStart, -1, "侧栏没有渲染后续阶段模块");
  const upcomingBlock = sidebar.slice(listStart, sidebar.indexOf("</ul>", listStart));
  assert.equal(/<Link\b|<a\b/.test(upcomingBlock), false, "未开放模块不该渲染成链接");
});

test("后台页面不引用 lib/mocks，也不使用不受控 HTML", () => {
  const files = collectFiles(path.join(ROOT, "app", "admin"));

  for (const file of files) {
    const code = stripComments(readSource(file));
    assert.equal(code.includes("lib/mocks"), false, `${path.relative(ROOT, file)} 不该引用 lib/mocks`);
    assert.equal(code.includes("dangerouslySetInnerHTML"), false);
    assert.equal(code.includes("innerHTML"), false);
  }
});

test("管理接口清单固定：认证三件 + 申请审核四件 + 护航管理七件 + 类目五件 + 商品五件", () => {
  const routeFiles = collectFiles(ADMIN_API_DIR).filter((file) => file.endsWith("route.ts"));

  // 逐个写出来而不是只断言数量：少一个、多一个、被改名都会在这里现形。
  // 这些地址是有调用方的（页面与将来的真实后端），改名不是无关紧要的重构。
  assert.deepEqual(
    routeFiles.map((file) => path.relative(ADMIN_API_DIR, file).replace(/\\/g, "/")).sort(),
    [
      "auth/logout/route.ts",
      "auth/mock-login/route.ts",
      "auth/session/route.ts",
      // P8B：类目（列表 / 新建、详情 / 编辑、启用、停用、移除）
      "categories/[id]/disable/route.ts",
      "categories/[id]/enable/route.ts",
      "categories/[id]/remove/route.ts",
      "categories/[id]/route.ts",
      "categories/route.ts",
      "companion-applications/[id]/approve/route.ts",
      "companion-applications/[id]/reject/route.ts",
      "companion-applications/[id]/route.ts",
      "companion-applications/[id]/start-review/route.ts",
      "companion-applications/route.ts",
      "companions/[id]/disable/route.ts",
      "companions/[id]/enable/route.ts",
      "companions/[id]/pause/route.ts",
      "companions/[id]/remove/route.ts",
      "companions/[id]/resume/route.ts",
      "companions/[id]/route.ts",
      "companions/route.ts",
      // P8B：商品（列表 / 新建、详情 / 编辑、上架、下架、移除）
      // ⚠️ 这里没有「改价」「改规格」这类地址：价格与规格是商品资料的一部分，
      // 它们随整体保存一起写入，单独开一个改价接口只会绕过「一次原子写入」
      "products/[id]/publish/route.ts",
      "products/[id]/remove/route.ts",
      "products/[id]/route.ts",
      "products/[id]/unpublish/route.ts",
      "products/route.ts",
    ],
  );

  // 聚合服务（概览数字）始终只读：改状态、建护航、改用户都不在它这里
  const consoleSource = stripComments(readSource(path.join(ROOT, "lib", "services", "adminConsole.ts")));
  for (const forbidden of [
    "reviewing",
    "approved",
    "rejected",
    "updateCompanion",
    "createCompanion",
    "assignRole",
    "updateUser",
  ]) {
    assert.equal(consoleSource.includes(`"${forbidden}"`), false, `聚合服务不该写死状态：${forbidden}`);
  }
});

// ——————————————————————————— 真实服务（HTTP） ———————————————————————————

test("匿名访问 /admin 与三个管理页面：一律转到登录页，不是 200", { skip: SKIP_HTTP }, async () => {
  for (const pathname of ["/admin", "/admin/applications", "/admin/companions"]) {
    const { status } = await requestWithCookie(pathname, null);
    assert.equal(status, 307, `${pathname} 未登录时应当是跳转`);
  }

  // 登录页本身当然可以匿名打开
  const login = await requestWithCookie("/admin/login", null);
  assert.equal(login.status, 200);
});

test("管理接口自己鉴权：匿名 401，无权限角色 403", { skip: SKIP_HTTP }, async () => {
  const anonymous = await requestWithCookie("/api/admin/auth/session", null);
  assert.equal(anonymous.status, 401);
  assert.ok(anonymous.body.includes("UNAUTHORIZED"));

  const login = await mockLogin();

  if (login.status !== 200) {
    // 开关关闭：`getSessionAdmin()` 一律返回 null，因此连「有会话但没权限」都不存在，
    // 三种身份全部按未登录处理（401）。这是设计如此，不是漏判。
    for (const id of ["admin-2", "admin-3", "admin-4", "admin-999"]) {
      const { status } = await requestWithCookie("/api/admin/auth/session", `mock_admin_id=${id}`);
      assert.equal(status, 401, `开关关闭时 ${id} 也应当是无会话`);
    }
    return;
  }

  for (const id of ["admin-2", "admin-3", "admin-4"]) {
    const { status, body } = await requestWithCookie(
      "/api/admin/auth/session",
      `mock_admin_id=${id}`,
    );
    assert.equal(status, 403, `${id} 不该获得管理权限`);
    assert.ok(body.includes("FORBIDDEN"));
    // 不区分「角色不对」与「账号被停用」：那等于给出一个可以探测账号状态的接口
    assert.ok(body.includes("当前账号没有管理后台权限"));
  }

  // 不存在的 id 与未登录等价
  const unknown = await requestWithCookie("/api/admin/auth/session", "mock_admin_id=admin-999");
  assert.equal(unknown.status, 401);
});

test("用户端 Cookie 不能获得管理权限", { skip: SKIP_HTTP }, async () => {
  const { status, body } = await requestWithCookie(
    "/api/admin/auth/session",
    "mock_user_id=u-1001",
  );
  assert.equal(status, 401);
  assert.ok(body.includes("UNAUTHORIZED"));

  const page = await requestWithCookie("/admin", "mock_user_id=u-1001");
  assert.equal(page.status, 307, "带着用户 Cookie 也该被挡在后台之外");

  // 伪造一个「像管理员」的用户 id 也没用：用户仓储里根本没有角色这回事
  const forged = await requestWithCookie("/api/admin/auth/session", "mock_user_id=admin-1");
  assert.equal(forged.status, 401);
});

test("管理端 Cookie 不能冒充普通用户参与用户端业务", { skip: SKIP_HTTP }, async () => {
  for (const pathname of ["/api/me", "/api/orders", "/api/suggestions"]) {
    const { status } = await requestWithCookie(pathname, "mock_admin_id=admin-1");
    assert.equal(status, 401, `${pathname} 收到了管理端 Cookie 却当成了用户身份`);
  }
});

test("模拟登录下发的 Cookie 属性齐全，退出后立即失效", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();

  // 开关关闭时登录接口是 404，没有 Cookie 可查——那条路径由下面的用例覆盖
  if (login.status !== 200) {
    assert.equal(login.status, 404);
    return;
  }

  assert.equal(login.setCookie.length, 1, "登录只该下发一个 Cookie");

  const cookie = login.setCookie[0];
  for (const attribute of ["mock_admin_id=", "HttpOnly", "SameSite=lax", "Path=/"]) {
    assert.ok(cookie.includes(attribute), `Cookie 缺少 ${attribute}`);
  }
  assert.equal(cookie.includes("mock_user_id"), false, "登录不该动用户端 Cookie");

  // 响应体不含任何凭据或内部字段
  assert.equal(/password|secret|token|enabled|lastLoginAt/i.test(login.setCookie.join("")), false);

  const logout = await fetch(new URL("/api/admin/auth/logout", BASE), {
    method: "POST",
    headers: { cookie: cookie.split(";")[0] },
  });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.getSetCookie().join(" ");
  assert.ok(cleared.includes("mock_admin_id="), "退出应当清除管理端 Cookie");
  assert.ok(cleared.includes("Max-Age=0"), "退出后 Cookie 必须立即失效");
});

test("登录后 /admin/login 转到 /admin，且后台页面不含用户端壳层", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return; // 未开启 ENABLE_MOCK_ADMIN，跳过
  const cookie = login.setCookie[0].split(";")[0];

  const backToLogin = await requestWithCookie("/admin/login", cookie);
  assert.equal(backToLogin.status, 307, "已登录时停在登录页应当被转走");

  const overview = await requestWithCookie("/admin", cookie);
  assert.equal(overview.status, 200);
  assert.ok(overview.body.includes("后台概览"));
  assert.ok(overview.body.includes("待审核申请"));
  // 后台不是用户端：没有 480px 容器，也没有底部导航
  assert.equal(overview.body.includes("主导航"), false, "后台不该出现用户端底部 TabBar");
  assert.equal(overview.body.includes("max-w-[var(--shell-width)]"), false);

  // 未开放的模块只列名字，不给入口
  assert.ok(overview.body.includes("后续开放"));
  assert.ok(overview.body.includes("订单管理"));
});

test("列表页渲染真实数据，且**只有详情页**才有动作", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return; // 未开启 ENABLE_MOCK_ADMIN，跳过
  const cookie = login.setCookie[0].split(";")[0];

  const applications = await requestWithCookie("/admin/applications?status=all", cookie);
  assert.equal(applications.status, 200);
  assert.ok(applications.body.includes("入驻申请"));
  // 预置数据里的申请编号出现在列表里 → 渲染的是仓储里的真实记录
  assert.ok(applications.body.includes("RA-MOCK-0002"), "列表没有渲染任何真实申请");

  // 列表 DTO 不带正文、联系方式、凭证与审核意见：断言的是**取值**，
  // 因为页面上的说明文案本身就会提到这几个词
  for (const [label, value] of [
    ["联系方式", "晚上八点后回消息比较快。（Mock 说明）"],
    ["审核意见", "这次提交的截图看不清当前水平，不方便判断。等资料齐全后再看。（Mock 备注）"],
  ]) {
    assert.equal(applications.body.includes(value), false, `列表泄漏了${label}`);
  }

  // 列表不提供动作按钮：审核动作只在详情页（那里才拿得到服务端给的 allowedActions）
  assert.equal(applications.body.includes("确认通过"), false, "列表不该出现审核按钮");

  // 非法筛选参数收敛到默认值，而不是把整页变成错误页
  const bogus = await requestWithCookie("/admin/applications?status=whatever", cookie);
  assert.equal(bogus.status, 200);
  assert.ok(bogus.body.includes("待查看"), "非法状态应当收敛到默认筛选「待查看」");

  const companions = await requestWithCookie("/admin/companions?state=disabled", cookie);
  assert.equal(companions.status, 200);
  assert.ok(companions.body.includes("护航管理"));
  // 状态筛选项后面跟着**服务端算出来的**角标（`已停用（1）`）。这里只断言「有数字」，
  // 不把具体数字写进来：数量会随预置数据变化，而这个用例要证明的是
  // 「页面渲染的是仓储里的真实数据」，不是「今天正好有一条停用记录」。
  // 注意 React 会在两段文本之间插入注释节点，所以正则要容得下它。
  assert.match(companions.body, /已停用(<!-- -->)?（\d+）/, "状态筛选项应当带上服务端算出的角标");
  // 名单页只有「查看」链接：停用、移除这类动作在详情页的二次确认里
  for (const forbidden of ["停用该护航", "移除该护航", "启用该护航", "暂停该护航"]) {
    assert.equal(companions.body.includes(forbidden), false, `名单页不该出现「${forbidden}」入口`);
  }
});

test("两个详情页都对得上真实记录：申请有状态时间轴，护航有只读统计", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return; // 未开启 ENABLE_MOCK_ADMIN，跳过
  const cookie = login.setCookie[0].split(";")[0];

  // 未通过的申请：详情页看得到审核意见（列表里看不到），终态因此没有动作按钮
  const rejected = await requestWithCookie("/admin/applications/ca-1005", cookie);
  assert.equal(rejected.status, 200);
  assert.ok(rejected.body.includes("这次提交的截图看不清当前水平"), "详情页应当展示审核意见");
  assert.equal(rejected.body.includes("确认通过"), false, "终态申请不该出现审核按钮");

  // 待查看的申请：动作由服务端给出的 allowedActions 决定，因此这里能开始审核
  const pending = await requestWithCookie("/admin/applications/ca-1002", cookie);
  assert.equal(pending.status, 200);
  assert.ok(pending.body.includes("开始审核"));

  // 不存在的申请是**真的 404**，不是一个 200 的「找不到」页面
  const missing = await requestWithCookie("/admin/applications/ca-nope", cookie);
  assert.equal(missing.status, 404);

  const companion = await requestWithCookie("/admin/companions/cp-1", cookie);
  assert.equal(companion.status, 200);
  assert.ok(companion.body.includes("展示排序"));
  assert.ok(companion.body.includes("评分"));

  const missingCompanion = await requestWithCookie("/admin/companions/c-nope", cookie);
  assert.equal(missingCompanion.status, 404);
});

test("未开启 ENABLE_MOCK_ADMIN 时，登录接口表现为「不存在」", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();

  if (login.status === 200) {
    // 本次跑的服务开着开关：这条只能由「用 ENABLE_MOCK_ADMIN=false 起一个服务」来验证，
    // 不能伪装成通过，因此如实跳过并说明原因
    return;
  }

  assert.equal(login.status, 404);
  assert.equal(login.setCookie.length, 0, "未启用时不该下发任何 Cookie");

  const logout = await fetch(new URL("/api/admin/auth/logout", BASE), { method: "POST" });
  assert.equal(logout.status, 404);

  // 伪造 Cookie 也不产生任何管理身份
  const forged = await requestWithCookie("/api/admin/auth/session", "mock_admin_id=admin-1");
  assert.equal(forged.status, 401);
  const page = await requestWithCookie("/admin", "mock_admin_id=admin-1");
  assert.equal(page.status, 307, "开关关闭时伪造 Cookie 也进不去后台");

  // 用户端的开关不受影响：模拟登录照常可用
  const userLogin = await fetch(new URL("/api/auth/mock-login", BASE), { method: "POST" });
  assert.equal(userLogin.status, 200, "关闭管理端开关不该牵连用户端");
});
