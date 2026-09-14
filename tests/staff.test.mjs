import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { findAppFile } from "./app-path.mjs";

import {
  ADMIN_STAFF_CREDENTIAL_NOTICE,
  ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH,
  ADMIN_STAFF_EMPTY_MESSAGE,
  ADMIN_STAFF_LIST_FIELDS_NOTE,
  ADMIN_STAFF_STATE_FILTERS,
  ADMIN_STAFF_STATE_LABELS,
  ADMIN_STAFF_USERNAME_EMPTY_MESSAGE,
  ADMIN_STAFF_USERNAME_INVALID_MESSAGE,
  ADMIN_STAFF_USERNAME_MAX_LENGTH,
  ADMIN_STAFF_USERNAME_TAKEN_MESSAGE,
  ADMIN_STAFF_USERNAME_TOO_LONG_MESSAGE,
  ADMIN_STAFF_AVATAR_INVALID_MESSAGE,
  ADMIN_STAFF_REMOVED_MESSAGE,
  countStaffStates,
  firstAdminStaffProfileErrorField,
  normalizeStaffUsername,
  staffLoginabilityNotice,
  staffMatchesAdminKeyword,
  staffProfileFieldErrors,
  staffStateOf,
} from "../lib/constants/adminStaff.ts";
import { MOCK_AVATAR_OPTIONS } from "../lib/constants/profile.ts";
import {
  MESSAGE_EMPTY_MESSAGE,
  MESSAGE_MAX_LENGTH,
  MESSAGE_TOO_LONG_MESSAGE,
} from "../lib/constants/service.ts";
import {
  STAFF_CONVERSATION_LIST_FIELDS_NOTE,
  STAFF_MESSAGE_ROLE_LABELS,
  STAFF_MOCK_DISABLED_MESSAGE,
  STAFF_MOCK_NOTICE,
  STAFF_NOT_REALTIME_NOTICE,
  STAFF_ORDER_READONLY_NOTICE,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  canEnterStaffConsole,
  compareStaffConversations,
  normalizeStaffOrderStatusFilter,
  readStaffOrderStatusFilter,
  readStaffUnreadFilter,
  staffMessageSenderLabel,
  staffUnreadCount,
  toStaffConversationListItem,
  toStaffOrderSummary,
} from "../lib/constants/staff.ts";
import { isMockAdminEnabled, isMockAuthEnabled, isMockStaffEnabled } from "../lib/config/env.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getStaffRepository } from "../lib/data/staffRepository.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import { userSeed } from "../lib/mocks/fixtures/seed.ts";
import { staffSeed } from "../lib/mocks/fixtures/staffSeed.ts";
import {
  createAdminStaff,
  disableAdminStaff,
  enableAdminStaff,
  queryAdminStaffList,
  removeAdminStaff,
  resolveAdminStaffListQuery,
  updateAdminStaff,
} from "../lib/services/adminStaff.ts";
import {
  getMessagesForUser,
  listConversationsForUser,
} from "../lib/services/conversations.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import {
  getStaffConversationDetail,
  getStaffOverviewMetrics,
  listConversationsForStaff,
  markStaffConversationRead,
  resolveStaffConversationListQuery,
  sendMessageForStaff,
} from "../lib/services/staffConversations.ts";

/**
 * 客服账号 + 独立客服登录 + 订单沟通工作台（P8D-1）的持续测试。
 *
 * 跑真实实现：真实的 Mock 仓储 + 真实的 `lib/services/adminStaff.ts` /
 * `staffAuth.ts` / `staffConversations.ts`。不引入测试框架，用 node 内置 runner。
 *
 * 覆盖重点（§八）：
 *
 * 1. **三类身份是三个世界**：客服 Cookie / 用户 Cookie / 管理 Cookie 互不认账，
 *    代码里不存在「把用户或管理员换算成客服」的函数；
 * 2. **客服账号的生命周期**：新增（角色写死）→ 编辑 → 启用 / 停用 → 软删除，
 *    每一步恰好写一条审计；
 * 3. **工作台看得到什么**：真实聚合的概览、可搜索筛选分页且稳定排序的会话列表、
 *    只有存在会话的订单才进得来（其余与外层 404 同体）；
 * 4. **消息身份由服务端写**：伪造 `senderRole` / `senderId` 无效、空白与超长被拒、
 *    幂等与并发只产生一条、客服已读不清用户未读、快照不随账号改名 / 移除而变；
 * 5. **只读边界**：客服发消息不改订单状态、金额、商品，也不影响消费等级与排行榜。
 *
 * 需要真实服务的断言（HTTP 状态码与 Cookie 行为）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `tests/admin.test.mjs`、`tests/service.test.mjs` 同一套做法。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF_API_DIR = path.join(ROOT, "app", "api", "staff");

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过客服端 HTTP 用例";

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「本页没有 X」不算出现 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(file) {
  return readFileSync(file, "utf8");
}

/**
 * 去掉 import 语句。
 *
 * 「守卫在第一步」这类**顺序**断言必须先去掉 import：`import { readJsonBody }`
 * 出现在文件开头，而它只是一个名字，与「什么时候解析请求体」毫无关系。
 */
function withoutImports(source) {
  return source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
}

/** 递归列出目录下所有文件（不含目录本身）。 */
function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full));
    else found.push(full);
  }
  return found;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/**
 * `lib/services/staffAuth.ts` 的源码（去掉注释）。
 *
 * ⚠️ 这个模块**不能直接 import**：它引用了 `lib/auth/staffSession.ts`，
 * 后者 import 了 `next/headers`，node 的解析器在测试进程里找不到它
 * （与 `lib/services/adminAuth.ts` 一模一样，管理端的测试也是读源码而不是 import）。
 * 因此「能不能登录」的**行为**由 HTTP 用例逐账号验证，结构性的约束在这里读源码断言。
 */
function staffAuthSource() {
  return stripComments(readSource(path.join(ROOT, "lib", "services", "staffAuth.ts")));
}

/** 从三个会话模块里取出 Cookie 名：它们同样因为 `next/headers` 而不能被 import。 */
function sessionCookieName(relative) {
  const match = readSource(path.join(ROOT, relative)).match(
    /export const \w*SESSION_COOKIE = "([^"]+)"/,
  );
  assert.ok(match, `${relative} 里找不到会话 Cookie 常量`);
  return match[1];
}

function key() {
  return crypto.randomUUID();
}

/** 直接带着一份 Cookie 请求，用来验证「伪造 Cookie 会怎样」。 */
async function requestWithCookie(pathname, cookie, init) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  return { status: response.status, body: await response.text(), response };
}

/** 客服端模拟登录一次，拿到服务端下发的 Cookie 名与值。 */
async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

/** 环境变量的原值，用于每个用例结束后还原。 */
const ORIGINAL_MOCK_STAFF = process.env.ENABLE_MOCK_STAFF;
const ORIGINAL_MOCK_ADMIN = process.env.ENABLE_MOCK_ADMIN;
const ORIGINAL_MOCK_AUTH = process.env.ENABLE_MOCK_AUTH;

function restoreEnv() {
  for (const [name, original] of [
    ["ENABLE_MOCK_STAFF", ORIGINAL_MOCK_STAFF],
    ["ENABLE_MOCK_ADMIN", ORIGINAL_MOCK_ADMIN],
    ["ENABLE_MOCK_AUTH", ORIGINAL_MOCK_AUTH],
  ]) {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

/**
 * 每个用例开始前重建三个 store：客服账号、消息、审计。
 *
 * 订单 / 支付 / 等级 / 排行榜的 store **不重建**：客服发消息不该改动它们，
 * 这样「发完消息之后订单与榜单和发之前一模一样」才是一次真正的对比。
 */
beforeEach(() => {
  resetMockStore("staff");
  resetMockStore("message");
  resetMockStore("adminAudit");
});

afterEach(restoreEnv);

// ——————————————————————————— 一、角色与纯逻辑 ———————————————————————————

test("角色齐全但只有 customer_service 能进客服工作台", () => {
  assert.deepEqual([...STAFF_ROLES].sort(), ["companion", "customer_service"]);
  for (const role of STAFF_ROLES) {
    assert.ok(STAFF_ROLE_LABELS[role]?.length > 0, `${role} 缺少角色文案`);
  }

  assert.equal(canEnterStaffConsole("customer_service"), true);
  assert.equal(canEnterStaffConsole("companion"), false, "护航不能进客服工作台");

  // 判断的是「等于客服」而不是「不等于某某」：将来新增角色默认没有权限
  assert.equal(canEnterStaffConsole("admin"), false, "管理员也不是客服");
  assert.equal(canEnterStaffConsole(""), false);
});

test("工作台的消息称呼与用户端是两张表：同一条消息在两边叫法不同", () => {
  // 用户端叫「客服」，工作台里对着自己叫「我」、对着用户叫「用户」
  assert.equal(STAFF_MESSAGE_ROLE_LABELS.customer_service, "客服");
  assert.equal(staffMessageSenderLabel("customer_service", true), "我");
  assert.equal(staffMessageSenderLabel("customer_service", false), "客服");
  assert.equal(staffMessageSenderLabel("user", false), "用户");
  assert.equal(staffMessageSenderLabel("companion", false), "护航");
});

test("客服未读的口径：自己发的不算，用户与护航发的都算", () => {
  const messages = [
    { senderRole: "user", createdAt: "2026-09-14T10:00:00.000Z" },
    { senderRole: "companion", createdAt: "2026-09-14T10:01:00.000Z" },
    { senderRole: "customer_service", createdAt: "2026-09-14T10:02:00.000Z" },
    { senderRole: "user", createdAt: "2026-09-14T10:03:00.000Z" },
  ];

  // 从未读过：对方（用户 + 护航）说的三条全算，客服自己发的那条不算
  assert.equal(staffUnreadCount(messages, null), 3);

  // 读到最后一条之后：全部已读
  assert.equal(staffUnreadCount(messages, "2026-09-14T10:03:00.000Z"), 0);

  // 读到中间：只有严格晚于已读位置的那条算未读
  assert.equal(staffUnreadCount(messages, "2026-09-14T10:01:00.000Z"), 1);

  // 同一个时间点不算未读（已读位置是「读到哪里」，不是「读之前」）
  assert.equal(staffUnreadCount(messages, "2026-09-14T10:00:00.000Z"), 2);
});

test("会话排序稳定：最后消息时间倒序，时间相同用订单号倒序兜底", () => {
  const older = { lastMessageAt: "2026-09-14T09:00:00.000Z", orderNo: "YM20260912000101" };
  const newer = { lastMessageAt: "2026-09-14T10:00:00.000Z", orderNo: "YM20260912000102" };

  assert.ok(compareStaffConversations(newer, older) < 0, "更晚的排在前面");
  assert.ok(compareStaffConversations(older, newer) > 0, "反过来就排在后面");

  // 时间相同 → 订单号倒序，**必须**给出确定的先后，否则翻页会漏行重行
  const sameTime = { lastMessageAt: newer.lastMessageAt, orderNo: "YM20260912000103" };
  assert.ok(compareStaffConversations(newer, sameTime) > 0, "时间相同时订单号小的排后面");
  assert.equal(compareStaffConversations(newer, newer), 0, "同一条与自己比较必须相等");

  // 没有消息的会话排最后
  assert.ok(
    compareStaffConversations({ lastMessageAt: null, orderNo: "Z" }, older) > 0,
    "无消息的会话排在有消息的之后",
  );
  assert.equal(
    compareStaffConversations({ lastMessageAt: null, orderNo: "Z" }, { lastMessageAt: null, orderNo: "Z" }),
    0,
  );
});

test("会话列表 DTO 与订单摘要都不含游戏 ID、订单备注与用户 id", () => {
  const order = orderSeed.find((item) => item.id === "ord-seed-1001-04");
  assert.ok(order, "预置订单缺失：ord-seed-1001-04");

  const summary = toStaffOrderSummary(order, "老板A");
  assert.equal(summary.orderNo, order.orderNo);
  assert.equal(summary.totalAmount, order.totalAmount);
  assert.equal(summary.userNickname, "老板A");
  assert.ok(summary.companionSummary.length > 0, "没有护航时要写成「等待接单」，不是空白");

  // 字段表就是边界：少一个字段就少一条泄漏路径
  for (const forbidden of ["gameAccountId", "remark", "userId", "payCredential"]) {
    assert.equal(forbidden in summary, false, `订单摘要不该有 ${forbidden}`);
  }

  const item = toStaffConversationListItem({
    order,
    userNickname: "老板A",
    messageCount: 6,
    lastMessageBody: "我先打一把",
    lastMessageAt: "2026-09-14T10:00:00.000Z",
    lastMessageRole: "companion",
    staffUnreadCount: 5,
  });
  assert.equal(item.orderNo, order.orderNo);
  assert.equal(item.unreadCount, 5);
  assert.equal(item.lastMessageRoleLabel, "护航");
  for (const forbidden of ["gameAccountId", "remark", "userId", "messages"]) {
    assert.equal(forbidden in item, false, `列表项不该有 ${forbidden}`);
  }

  // 列表项与详情页都有的那句说明必须点明这件事
  assert.ok(STAFF_CONVERSATION_LIST_FIELDS_NOTE.includes("游戏 ID"));
  assert.ok(ADMIN_STAFF_LIST_FIELDS_NOTE.includes("Cookie"));
});

test("筛选条件解析：合法值通过，非法值可区分「缺省」与「写坏了」", () => {
  assert.equal(readStaffOrderStatusFilter(null), "all");
  assert.equal(readStaffOrderStatusFilter("  "), "all");
  assert.equal(readStaffOrderStatusFilter("serving"), "serving");
  assert.equal(readStaffOrderStatusFilter("不存在的状态"), null, "非法值返回 null，由调用方决定 400 还是回退");
  assert.equal(normalizeStaffOrderStatusFilter("不存在的状态"), "all", "页面那条链路回退默认值");

  assert.equal(readStaffUnreadFilter("1"), true);
  assert.equal(readStaffUnreadFilter(null), false);
  assert.equal(readStaffUnreadFilter("0"), false, "只有 1 表示开启");
  assert.equal(readStaffUnreadFilter("true"), false);
});

// ——————————————————————————— 二、客服账号生命周期 ———————————————————————————

const ADMIN_ID = "admin-1";

function profile(overrides = {}) {
  return {
    username: "kefu-test",
    displayName: "客服小测",
    avatarUrl: MOCK_AVATAR_OPTIONS[0],
    ...overrides,
  };
}

async function expectApiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function staffAudits() {
  return getAdminAuditRepository().listAudits({ targetType: "staff" });
}

test("新增客服账号：角色由服务端写死，客户端伪造 admin/companion 无效", async () => {
  const created = await createAdminStaff(
    ADMIN_ID,
    // 请求体里把能塞的都塞上：role / enabled / removedAt 在这条链路上没有落脚的地方
    { ...profile(), role: "admin", enabled: false, removedAt: "2020-01-01T00:00:00.000Z", idempotencyKey: key() },
  );

  assert.equal(created.changed, true);
  assert.equal(created.staff.role, "customer_service", "角色不是请求体说了算");
  assert.equal(created.staff.state, "enabled", "新账号一律启用，不能被请求体关掉");
  assert.equal(created.staff.removedAt, null, "新账号不可能一出生就是已移除");
  assert.equal(created.staff.lastLoginAt, null, "新账号从未登录，「从未登录」不是「很久以前登录过」");
  assert.equal(created.staff.canEnterStaffConsole, true);

  // 账号里根本没有密码字段：本阶段是 Mock 认证
  for (const forbidden of ["password", "secret", "passwordHash", "credential"]) {
    assert.equal(forbidden in created.staff, false, `客服账号不该有 ${forbidden}`);
  }

  // 恰好一条审计，记的是动作不是内容
  const audits = await staffAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "staff.create");
  assert.equal(audits[0].targetId, created.staff.id);
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].before, null, "新建的 before 是 null，事后一眼看得出这条记录是这次产生的");
  assert.equal(JSON.stringify(audits[0].after).includes("password"), false);
});

test("新增幂等：同一个键第二次到达不会建出第二个账号，也不写第二条审计", async () => {
  const operationId = key();
  const first = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: operationId });
  const second = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: operationId });

  assert.equal(second.changed, false);
  assert.equal(second.staff.id, first.staff.id);
  assert.equal((await staffAudits()).length, 1, "幂等重放不重复审计");
  assert.equal((await getStaffRepository().listStaff()).filter((s) => s.username === "kefu-test").length, 1);
});

test("登录名唯一且大小写不敏感：kefu-test 与 KEFU-TEST 是同一个名字", async () => {
  await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });

  await expectApiError(
    createAdminStaff(ADMIN_ID, { ...profile({ username: "KEFU-TEST" }), idempotencyKey: key() }),
    "BAD_REQUEST",
  );

  const taken = await createAdminStaff(ADMIN_ID, {
    ...profile({ username: "KEFU-TEST" }),
    idempotencyKey: key(),
  }).catch((error) => error);
  assert.equal(taken.message, ADMIN_STAFF_USERNAME_TAKEN_MESSAGE);

  // 唯一性只在服务端判：仓储里仍然只有一条
  assert.equal((await getStaffRepository().listStaff()).length, staffSeed.length + 1);
});

test("登录名规范化：去空白、不能为空、有上限、字符集受限，但**不改大小写**", () => {
  assert.deepEqual(normalizeStaffUsername("  kefu-A  "), { ok: true, value: "kefu-A" });
  assert.equal(normalizeStaffUsername("   ").message, ADMIN_STAFF_USERNAME_EMPTY_MESSAGE);
  assert.equal(normalizeStaffUsername("").message, ADMIN_STAFF_USERNAME_EMPTY_MESSAGE);

  const tooLong = "k".repeat(ADMIN_STAFF_USERNAME_MAX_LENGTH + 1);
  assert.equal(normalizeStaffUsername(tooLong).message, ADMIN_STAFF_USERNAME_TOO_LONG_MESSAGE);
  assert.equal(
    normalizeStaffUsername("k".repeat(ADMIN_STAFF_USERNAME_MAX_LENGTH)).ok,
    true,
    "刚好到上限应当通过",
  );

  // 空格与 Emoji 会造出「看起来一样」的两条账号，因此在字符集这一层就挡住
  for (const bad of ["客服小雨", "kefu 小雨", "kefu小雨", "kefu🙂", "kefu.x"]) {
    assert.equal(normalizeStaffUsername(bad).message, ADMIN_STAFF_USERNAME_INVALID_MESSAGE, bad);
  }
});

test("表单逐字段错误：顺序即页面上的顺序，第一条出错的字段会被聚焦", () => {
  const errors = staffProfileFieldErrors({
    username: "   ",
    displayName: "x".repeat(ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH + 1),
    avatarUrl: "https://evil.example/a.png",
  });

  assert.equal(errors.username, ADMIN_STAFF_USERNAME_EMPTY_MESSAGE);
  assert.ok(errors.displayName.includes(String(ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH)));
  assert.equal(errors.avatarUrl, ADMIN_STAFF_AVATAR_INVALID_MESSAGE);
  assert.equal(firstAdminStaffProfileErrorField(errors), "username", "第一条错误是最靠上的那个字段");

  // 全部合法时没有任何错误
  const clean = staffProfileFieldErrors(profile());
  assert.deepEqual(clean, { username: null, displayName: null, avatarUrl: null });
  assert.equal(firstAdminStaffProfileErrorField(clean), null);
});

test("编辑客服账号：只改资料，重复保存不写数据也不写审计", async () => {
  const created = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });
  const id = created.staff.id;

  const updated = await updateAdminStaff(id, ADMIN_ID, {
    ...profile({ displayName: "客服小测（改名）" }),
    idempotencyKey: key(),
  });
  assert.equal(updated.changed, true);
  assert.equal(updated.staff.displayName, "客服小测（改名）");
  assert.equal(updated.staff.state, "enabled", "编辑不碰状态");

  // 用**另一个**幂等键再保存一次同样的内容：不是错误，但什么都不该发生
  const again = await updateAdminStaff(id, ADMIN_ID, {
    ...profile({ displayName: "客服小测（改名）" }),
    idempotencyKey: key(),
  });
  assert.equal(again.changed, false);
  assert.equal(again.staff.updatedAt, updated.staff.updatedAt, "时间戳不该被无意义的保存刷新");

  const audits = await staffAudits();
  assert.deepEqual(audits.map((entry) => entry.action), ["staff.create", "staff.update"]);
});

test("编辑不能顺手改状态：停用之后一次资料保存不会把它重新打开", async () => {
  const created = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });
  const id = created.staff.id;

  await disableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  const edited = await updateAdminStaff(id, ADMIN_ID, {
    ...profile({ displayName: "换个名字" }),
    enabled: true, // 请求体里塞进来也没用
    idempotencyKey: key(),
  });

  assert.equal(edited.staff.state, "disabled", "编辑接口读都不读 enabled");
  assert.equal(edited.staff.canEnterStaffConsole, false);
});

test("停用与启用：状态互斥、可逆，重复动作幂等且不重复审计", async () => {
  const created = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });
  const id = created.staff.id;

  const disabled = await disableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  assert.equal(disabled.changed, true);
  assert.equal(disabled.staff.state, "disabled");
  assert.equal(disabled.staff.canEnterStaffConsole, false, "停用后立即失去工作台权限");

  // 重复停用：不是错误，但既不刷新时间戳也不写第二条审计
  const again = await disableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  assert.equal(again.changed, false);
  assert.equal(again.staff.updatedAt, disabled.staff.updatedAt);

  const enabled = await enableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  assert.equal(enabled.changed, true);
  assert.equal(enabled.staff.state, "enabled");
  assert.equal(enabled.staff.canEnterStaffConsole, true);
  assert.equal(enabled.staff.lastLoginAt, null, "启用不重置资料，也不伪造一次登录");

  const actions = (await staffAudits()).map((entry) => entry.action);
  assert.deepEqual(actions, ["staff.create", "staff.disable", "staff.enable"]);
});

test("移除是软删除：记录与历史消息都保留，且不能再启用、不能再编辑", async () => {
  const created = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });
  const id = created.staff.id;

  const removed = await removeAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  assert.equal(removed.changed, true);
  assert.equal(removed.staff.state, "removed");
  assert.equal(removed.staff.removedAt !== null, true);
  assert.equal(removed.staff.canEnterStaffConsole, false);

  // 记录还在：软删除不是消失，后台要能回答「这个账号现在是什么状态」
  const record = await getStaffRepository().findStaffById(id);
  assert.ok(record, "软删除之后记录必须仍然存在");

  await expectApiError(enableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() }), "BAD_REQUEST");
  const enableError = await enableAdminStaff(id, ADMIN_ID, { idempotencyKey: key() }).catch((e) => e);
  assert.equal(enableError.message, ADMIN_STAFF_REMOVED_MESSAGE);

  const editError = await updateAdminStaff(id, ADMIN_ID, {
    ...profile({ displayName: "还想改" }),
    idempotencyKey: key(),
  }).catch((e) => e);
  assert.equal(editError.message, ADMIN_STAFF_REMOVED_MESSAGE);

  // 重复移除幂等
  const again = await removeAdminStaff(id, ADMIN_ID, { idempotencyKey: key() });
  assert.equal(again.changed, false);

  assert.deepEqual(
    (await staffAudits()).map((entry) => entry.action),
    ["staff.create", "staff.remove"],
  );
});

test("后台列表：按状态筛选，已移除的账号能筛出来看", async () => {
  const created = await createAdminStaff(ADMIN_ID, { ...profile(), idempotencyKey: key() });
  await removeAdminStaff(created.staff.id, ADMIN_ID, { idempotencyKey: key() });

  const all = await queryAdminStaffList(resolveAdminStaffListQuery(page(), true), undefined, "server");
  assert.equal(all.total, staffSeed.length + 1);
  assert.equal(all.counts.total, staffSeed.length + 1);

  const removed = await queryAdminStaffList(
    resolveAdminStaffListQuery(page({ state: "removed" }), true),
    undefined,
    "server",
  );
  assert.equal(removed.items.every((item) => item.state === "removed"), true);
  assert.ok(removed.items.some((item) => item.id === created.staff.id), "刚移除的账号要能筛出来");
  assert.ok(removed.items.some((item) => item.stateLabel === ADMIN_STAFF_STATE_LABELS.removed));

  // counts 统计的是**全部账号**，不是当前筛选的结果
  assert.equal(removed.counts.total, all.counts.total);

  // 非法枚举：接口 400，页面回退默认值——两种链路两套处置
  assert.throws(() => resolveAdminStaffListQuery(page({ state: "gone" }), true));
  assert.equal(resolveAdminStaffListQuery(page({ state: "gone" }), false).state, "all");

  // 关键字命中登录名与名称，大小写不敏感
  assert.equal(staffMatchesAdminKeyword({ username: "kefu-xiaoyu", displayName: "客服小雨" }, "KEFU"), true);
  assert.equal(staffMatchesAdminKeyword({ username: "kefu-xiaoyu", displayName: "客服小雨" }, "小雨"), true);
  assert.equal(staffMatchesAdminKeyword({ username: "kefu-xiaoyu", displayName: "客服小雨" }, "不存在"), false);
});

test("状态推导与统计：已移除优先于启用 / 停用", () => {
  assert.equal(staffStateOf({ enabled: true, removedAt: null }), "enabled");
  assert.equal(staffStateOf({ enabled: false, removedAt: null }), "disabled");
  // 一条已移除的记录说「已停用」会让人以为还能重新启用它
  assert.equal(staffStateOf({ enabled: false, removedAt: "2026-09-14T00:00:00.000Z" }), "removed");
  assert.equal(staffStateOf({ enabled: true, removedAt: "2026-09-14T00:00:00.000Z" }), "removed");

  const counts = countStaffStates([
    { enabled: true, removedAt: null },
    { enabled: false, removedAt: null },
    { enabled: false, removedAt: "2026-09-14T00:00:00.000Z" },
  ]);
  assert.deepEqual(counts, { enabled: 1, disabled: 1, removed: 1, total: 3 });
  assert.deepEqual([...ADMIN_STAFF_STATE_FILTERS], ["all", "enabled", "disabled", "removed"]);
});

test("详情页的「能不能进工作台」四种提示互不重叠", () => {
  const removedNotice = staffLoginabilityNotice({ state: "removed", canEnterStaffConsole: false });
  const disabledNotice = staffLoginabilityNotice({ state: "disabled", canEnterStaffConsole: false });
  const wrongRole = staffLoginabilityNotice({ state: "enabled", canEnterStaffConsole: false });
  const ok = staffLoginabilityNotice({ state: "enabled", canEnterStaffConsole: true });

  assert.ok(removedNotice.includes("历史消息"));
  assert.ok(disabledNotice.includes("Cookie"));
  assert.ok(wrongRole.includes("角色"));
  assert.ok(ok.includes("/staff/login"));

  const notices = [removedNotice, disabledNotice, wrongRole, ok];
  assert.equal(new Set(notices).size, 4, "四种情形必须是四句话");
});

// ——————————————————————————— 三、三类身份隔离 ———————————————————————————

test("能不能登录只看账号自身：启用 + 未移除 + 角色是客服，三者缺一不可", () => {
  // ⚠️ 这条规则的**唯一落点**是 staffAuth.ts，而它不能被 import（见 staffAuthSource 注释）。
  // 因此这里断言的是「三个条件写成了合取，且没有第四种写法」；实际行为由 HTTP 用例
  // 逐账号验证：staff-1 通过，staff-3 / staff-4 / staff-5 与不存在的 id 一律 403。
  const source = staffAuthSource();
  const start = source.indexOf("export function canStaffSignIn");
  assert.notEqual(start, -1, "找不到 canStaffSignIn");
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.ok(body.includes("account.enabled"), "必须看启用状态");
  assert.ok(body.includes("account.removedAt === null"), "必须看有没有被软删除");
  assert.ok(body.includes("canEnterStaffConsole(account.role)"), "角色判断必须走那个唯一的函数");
  assert.ok(
    (body.match(/&&/g) ?? []).length >= 2,
    "三个条件必须是合取：漏掉任意一个都会放过一类不该登录的账号",
  );
  assert.equal(body.includes('role === "customer_service"'), false, "不在这里另写一遍角色判断");

  // 会话 DTO 显式挑字段：内部状态一个字都不往外发
  const dto = source.slice(source.indexOf("export function toStaffSessionUser("));
  const dtoBody = dto.slice(0, dto.indexOf("\n}", 0));
  for (const forbidden of ["enabled", "removedAt", "lastLoginAt", "createdAt"]) {
    assert.equal(dtoBody.includes(forbidden), false, `会话 DTO 不该下发 ${forbidden}`);
  }
  assert.ok(dtoBody.includes("roleLabel"), "角色文案由服务端给，页面不自己拼");
});

test("登录名单只列能登录的账号：名单与登录共用同一个判定，开关关闭时不列", () => {
  const source = staffAuthSource();
  const start = source.indexOf("export async function getStaffLoginOptions(");
  assert.notEqual(start, -1, "找不到 getStaffLoginOptions");
  const body = source.slice(start, source.indexOf("\n}", start));

  assert.ok(body.includes("isMockStaffEnabled()"), "开关关闭时返回空名单");
  assert.ok(body.includes(".filter(canStaffSignIn)"), "名单与登录必须用同一个判定");
  assert.equal(body.includes('role === "'), false, "名单里不另写一遍角色判断");
});

test("登录与退出的开关判断都在碰 Cookie 之前，四种拒绝共用同一句话", () => {
  const source = staffAuthSource();

  for (const [action, cookieCall] of [
    ["loginMockStaff", "setSessionStaff("],
    ["logoutStaff", "clearSessionStaff("],
  ]) {
    const start = source.indexOf(`export async function ${action}(`);
    assert.notEqual(start, -1, `找不到 ${action}`);
    const body = source.slice(start, start + 900);
    const guard = body.indexOf("assertMockStaffEnabled()");
    assert.notEqual(guard, -1, `${action} 必须以开关判断开头`);
    assert.ok(guard < body.indexOf(cookieCall), `${action} 的开关判断必须在碰 Cookie 之前`);
  }

  // 总闸本身必须真的读开关、真的按「接口不存在」返回。上面两条只证明
  // 「调用了一个名叫 assertMockStaffEnabled 的函数」，函数体被掏空也照样通过。
  const gate = source.slice(source.indexOf("export function assertMockStaffEnabled("));
  const gateBody = gate.slice(0, gate.indexOf("\n}", 0));
  assert.ok(gateBody.includes("isMockStaffEnabled()"), "总闸必须读 ENABLE_MOCK_STAFF");
  assert.ok(gateBody.includes('"NOT_FOUND"'), "开关关闭时按「接口不存在」返回");
  assert.ok(gateBody.includes("404"), "关闭时不该用 403：那会让人以为换个账号就能进");
  assert.ok(gateBody.includes("STAFF_MOCK_LOGIN_DISABLED_MESSAGE"), "提示与登录页同源");

  const login = source.slice(source.indexOf("export async function loginMockStaff("));
  const loginBody = login.slice(0, login.indexOf("\n}", 0));
  // 「查不到」「已停用」「已移除」「角色不是客服」必须在同一个分支里，给同一句话同一个状态码
  assert.ok(loginBody.includes("!account || !canStaffSignIn(account)"), "四种拒绝必须在同一个分支里");
  assert.ok(loginBody.includes("STAFF_FORBIDDEN_MESSAGE"), "四种拒绝必须共用同一句提示");
  // 登录写的是最后登录时间，**不写管理审计**：审计记的是管理者做过什么
  assert.ok(loginBody.includes("markLoggedIn("));
  assert.equal(loginBody.includes("writeAudit"), false, "登录不该刷审计表");
});

test("三个开关各管各的：客服端开关不读另外两个变量，也不被它们牵连", () => {
  for (const name of ["ENABLE_MOCK_STAFF", "ENABLE_MOCK_ADMIN", "ENABLE_MOCK_AUTH"]) delete process.env[name];
  assert.equal(isMockStaffEnabled(), false);
  assert.equal(isMockAdminEnabled(), false);
  assert.equal(isMockAuthEnabled(), false);

  process.env.ENABLE_MOCK_STAFF = "true";
  assert.equal(isMockStaffEnabled(), true);
  assert.equal(isMockAdminEnabled(), false, "开启客服端开关不该顺带打开管理端");
  assert.equal(isMockAuthEnabled(), false, "也不该打开用户端");

  process.env.ENABLE_MOCK_ADMIN = "true";
  delete process.env.ENABLE_MOCK_STAFF;
  assert.equal(isMockStaffEnabled(), false, "关闭客服端开关不该牵连另外两个");
  assert.equal(isMockAdminEnabled(), true);

  // 取值必须显式等于字符串 "true"：其余写法一律按关闭处理
  for (const value of ["1", "yes", "TRUE", ""]) {
    process.env.ENABLE_MOCK_STAFF = value;
    assert.equal(isMockStaffEnabled(), false, `ENABLE_MOCK_STAFF=${value} 不该被当成开启`);
  }
});

test("三套 Cookie 的取值域不相交", () => {
  const names = [
    sessionCookieName("lib/auth/staffSession.ts"),
    sessionCookieName("lib/auth/adminSession.ts"),
    sessionCookieName("lib/auth/session.ts"),
  ];

  assert.deepEqual(names, ["mock_staff_id", "mock_admin_id", "mock_user_id"]);
  assert.equal(new Set(names).size, 3, "三个 Cookie 名必须互不相同");

  // 客服端只读自己的那个 Cookie
  const staffSession = stripComments(readSource(path.join(ROOT, "lib", "auth", "staffSession.ts")));
  assert.ok(staffSession.includes("MOCK_STAFF_SESSION_COOKIE"));
  assert.equal(staffSession.includes("mock_user_id"), false, "客服会话不读用户端 Cookie");
  assert.equal(staffSession.includes("mock_admin_id"), false, "也不读管理端 Cookie");

  // 下发时三个属性齐全：HttpOnly 必须有——页面脚本读得到就等于把 id 交给了前端
  for (const attribute of ["httpOnly: true", "sameSite: \"lax\"", "path: \"/\""]) {
    assert.ok(staffSession.includes(attribute), `Cookie 选项缺少 ${attribute}`);
  }
});

test("客服端代码里不存在「把用户或管理员换算成客服」的那条路", () => {
  const authService = stripComments(readSource(path.join(ROOT, "lib", "services", "staffAuth.ts")));
  const guard = stripComments(readSource(path.join(ROOT, "lib", "api", "staffRoute.ts")));
  const session = stripComments(readSource(path.join(ROOT, "lib", "auth", "staffSession.ts")));

  // 客服端不 import 另外两端的会话或服务：隔离靠的是「代码里没有那条路」
  for (const [name, source] of [["staffAuth", authService], ["staffRoute", guard], ["staffSession", session]]) {
    for (const forbidden of ["adminSession", "services/adminAuth", "services/userAuth", "auth/session", "adminRoute"]) {
      assert.equal(source.includes(forbidden), false, `${name} 不该引用 ${forbidden}`);
    }
  }

  // 用户端的会话模块也不认识客服：隔离是双向的
  const userSession = stripComments(readSource(path.join(ROOT, "lib", "auth", "session.ts")));
  assert.equal(userSession.includes("staff"), false, "用户端会话不该出现 staff");
});

// ——————————————————————————— 四、工作台与会话查询 ———————————————————————————

const STAFF_A = "staff-1";
const STAFF_B = "staff-2";
const USER_A = "u-1001";
/** 有会话：用户 / 护航 / 客服三种发送者都出现过 */
const ORDER_WITH_HISTORY = "ord-seed-1001-04";
/** 有会话但一条消息都没有 */
const ORDER_EMPTY_CONVERSATION = "ord-seed-1001-07";
/** 属于 USER_A 但**没有任何会话**：客服必须与「订单不存在」看到同一个 404 */
const ORDER_WITHOUT_CONVERSATION = "ord-seed-1001-02";

function listQuery(overrides = {}) {
  return resolveStaffConversationListQuery(page(overrides), true);
}

async function staffSessionOf(staffId) {
  const account = await getStaffRepository().findStaffById(staffId);
  assert.ok(account, `预置客服账号缺失：${staffId}`);
  // 真实链路上这份对象来自 `requireStaff()` 的返回值（`toStaffSessionUser()` 的产物）。
  // 测试里不 import `staffAuth.ts`（理由见 `staffAuthSource()`），只拼出服务端真正会读的
  // 三个字段：发送消息用的是守卫返回的 **id**，名称与头像是写进消息快照的那两个。
  return { id: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl };
}

const staffMessageBody = (text, overrides = {}) => ({ body: text, idempotencyKey: key(), ...overrides });

test("概览三个数是真实聚合：按当前客服口径算，不是写死的展示值", async () => {
  const metrics = await getStaffOverviewMetrics(STAFF_A, undefined, "server");

  // 会话总数与筛选无关：一共有多少单在沟通
  assert.equal(metrics.conversationCount, 5);
  assert.equal(metrics.conversationCount, (await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server")).total);

  // 未读会话数按**当前客服**算：staff-1 只在 ord-seed-1001-03 上有已读记录
  assert.equal(metrics.unreadConversationCount, 3);
  const other = await getStaffOverviewMetrics(STAFF_B, undefined, "server");
  assert.equal(other.unreadConversationCount, 4, "另一位客服的未读是另一份状态，不是同一批数字");

  // 今日消息数是**增量**而不是绝对值：它随当前时刻变化，断言的是「发一条就多一条」
  const before = metrics.todayMessageCount;
  await sendMessageForStaff(await staffSessionOf(STAFF_A), ORDER_WITH_HISTORY, staffMessageBody("统计一下"), undefined, "server");
  const after = await getStaffOverviewMetrics(STAFF_A, undefined, "server");
  assert.equal(after.todayMessageCount, before + 1);

  assert.ok(metrics.generatedAt.length > 0);
  assert.ok(metrics.notice.length > 0, "口径说明必须跟着数字一起给出来");
});

test("会话列表：按最后消息时间倒序，没有消息的排最后", async () => {
  const result = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");
  assert.equal(result.items.length, 5);
  assert.equal(result.total, 5);

  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(
      compareStaffConversations(result.items[index - 1], result.items[index]) <= 0,
      `第 ${index} 条与前一条顺序不符`,
    );
  }

  // 刚发起、还没聊过的会话排在最后一位
  assert.equal(result.items[result.items.length - 1].orderId, ORDER_EMPTY_CONVERSATION);
  assert.equal(result.items[result.items.length - 1].lastMessageAt, null);
  assert.equal(result.items[result.items.length - 1].messageCount, 0);
});

test("会话列表：搜索订单号 / 用户昵称 / 商品名，大小写不敏感", async () => {
  const all = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");
  const target = all.items.find((item) => item.orderId === "ord-seed-1001-03");

  const byOrderNo = await listConversationsForStaff(STAFF_A, listQuery({ keyword: target.orderNo }), undefined, "server");
  assert.deepEqual(byOrderNo.items.map((item) => item.orderId), [target.orderId]);

  // 大小写不敏感：订单号里带字母
  const lower = await listConversationsForStaff(
    STAFF_A,
    listQuery({ keyword: target.orderNo.toLowerCase() }),
    undefined,
    "server",
  );
  assert.deepEqual(lower.items.map((item) => item.orderId), [target.orderId]);

  // 按用户昵称搜：同一用户的多笔会话都命中，且每一条的昵称都对得上
  const user = userSeed.find((item) => item.id === USER_A);
  const byNickname = await listConversationsForStaff(STAFF_A, listQuery({ keyword: user.nickname }), undefined, "server");
  assert.ok(byNickname.items.length >= 1);
  assert.equal(byNickname.items.every((item) => item.userNickname === user.nickname), true);

  // 按商品名搜：命中的每一条商品名都包含关键字
  const byProduct = await listConversationsForStaff(
    STAFF_A,
    listQuery({ keyword: target.productTitle }),
    undefined,
    "server",
  );
  assert.ok(byProduct.items.length >= 1);
  assert.equal(byProduct.items.every((item) => item.productTitle === target.productTitle), true);

  // 搜不到就是搜不到，不是报错
  const none = await listConversationsForStaff(STAFF_A, listQuery({ keyword: "绝不可能命中的关键字" }), undefined, "server");
  assert.equal(none.total, 0);
  assert.deepEqual(none.items, []);
});

test("会话列表：只看未读与订单状态两种筛选都作用于展示，且与概览口径一致", async () => {
  const all = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");

  const unread = await listConversationsForStaff(STAFF_A, listQuery({ unread: 1 }), undefined, "server");
  assert.equal(unread.items.length, 3);
  assert.equal(unread.items.every((item) => item.unreadCount > 0), true);
  assert.deepEqual(
    unread.items.map((item) => item.orderId).sort(),
    all.items.filter((item) => item.unreadCount > 0).map((item) => item.orderId).sort(),
  );

  // 状态筛选：拿全部列表自己算出期望，避免把「实现」抄成「断言」
  const serving = all.items.filter((item) => item.orderStatus === "serving");
  const filtered = await listConversationsForStaff(STAFF_A, listQuery({ status: "serving" }), undefined, "server");
  assert.deepEqual(
    filtered.items.map((item) => item.orderId).sort(),
    serving.map((item) => item.orderId).sort(),
  );

  // 非法状态：接口 400，页面回退默认值
  assert.throws(() => resolveStaffConversationListQuery(page({ status: "假的" }), true));
  assert.equal(resolveStaffConversationListQuery(page({ status: "假的" }), false).status, "all");
});

test("会话列表：分页不重不漏，排序稳定", async () => {
  const all = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");

  const seen = [];
  for (const pageNumber of [1, 2, 3]) {
    const result = await listConversationsForStaff(
      STAFF_A,
      listQuery({ page: pageNumber, pageSize: 2 }),
      undefined,
      "server",
    );
    assert.equal(result.pageSize, 2);
    assert.equal(result.total, all.total, "分页不改变 total");
    assert.equal(result.hasMore, pageNumber * 2 < all.total);
    assert.ok(result.items.length <= 2);
    seen.push(...result.items.map((item) => item.orderId));
  }

  assert.equal(new Set(seen).size, seen.length, "同一条会话不能在两页里各出现一次");
  assert.deepEqual([...seen].sort(), all.items.map((item) => item.orderId).sort());

  // 稳定排序：同样的查询跑两次，顺序完全一致
  const first = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");
  const second = await listConversationsForStaff(STAFF_A, listQuery(), undefined, "server");
  assert.deepEqual(first.items.map((item) => item.orderId), second.items.map((item) => item.orderId));
});

test("会话详情：三方消息、当前客服的已读位置与只读订单摘要", async () => {
  // 以 staff-2 的身份读：预置消息的发送者是 staff-1，因此没有一条是「我」发的，
  // 「称呼随当前客服而变」这件事才看得见
  const detail = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  assert.ok(detail, "预置会话缺失");

  assert.equal(detail.order.orderNo, "YM20260911000104");
  assert.equal(detail.order.orderStatus, "serving");
  assert.equal(detail.user.id, USER_A);
  assert.ok(detail.user.nickname.length > 0);

  // 三方角色的消息都在，且每一条都被展示层加工过
  const roles = new Set(detail.messages.map((message) => message.senderRole));
  assert.deepEqual([...roles].sort(), ["companion", "customer_service", "user"]);
  for (const message of detail.messages) {
    assert.ok(message.senderName.length > 0, "快照里的名称不能是空白");
    assert.ok(message.senderRoleLabel.length > 0);
    assert.equal(message.isSelf, false, "对 staff-2 来说没有一条是自己发的");
    // 消息实体不直接作为响应：DTO 里没有 senderId / userId / orderId
    for (const forbidden of ["senderId", "userId", "orderId"]) {
      assert.equal(forbidden in message, false, `消息 DTO 不该有 ${forbidden}`);
    }
  }

  // 同一条会话由 staff-1 读：客服消息变成了「我」
  const asSender = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  const selfMessages = asSender.messages.filter((message) => message.isSelf);
  assert.ok(selfMessages.length > 0);
  assert.equal(selfMessages.every((message) => message.senderRole === "customer_service"), true);
  assert.equal(selfMessages.every((message) => message.senderRoleLabel === "我"), true);

  // staff-1 在 ord-seed-1001-03 上有已读记录，在这个会话上没有
  assert.equal(asSender.staffLastReadAt, null);
  const read = await getStaffConversationDetail(STAFF_A, "ord-seed-1001-03", undefined, "server");
  assert.ok(read.staffLastReadAt, "预置的客服已读位置应当读得到");
});

test("只有存在会话的订单进得来：没有会话与订单不存在给的是同一个结果", async () => {
  const noConversation = await getStaffConversationDetail(STAFF_A, ORDER_WITHOUT_CONVERSATION, undefined, "server");
  const missing = await getStaffConversationDetail(STAFF_A, "ord-根本不存在", undefined, "server");
  const empty = await getStaffConversationDetail(STAFF_A, "", undefined, "server");

  // 三种情形必须完全无法区分，否则客服能拿订单号一个一个试出平台上到底有哪些订单
  assert.equal(noConversation, null);
  assert.equal(missing, null);
  assert.equal(empty, null);

  // 别人的订单：有会话，但它本来就在工作台范围内（客服服务所有用户），因此能读到
  const otherUser = await getStaffConversationDetail(STAFF_A, "ord-seed-1002-01", undefined, "server");
  assert.equal(otherUser.user.id, "u-1002");
});

test("客服读自己的消息：只推进自己的已读位置，不动用户的未读", async () => {
  const before = await listConversationsForUser(USER_A, undefined, "server");
  const target = before.find((conversation) => conversation.orderId === ORDER_WITH_HISTORY);
  const userUnreadBefore = target.unreadCount;
  assert.ok(userUnreadBefore > 0, "预置数据的这条会话应当有用户侧未读");

  const staffBefore = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  const staffUnreadBefore = staffUnreadCount(staffBefore.messages, staffBefore.staffLastReadAt);
  assert.ok(staffUnreadBefore > 0);

  assert.equal(await markStaffConversationRead(STAFF_B, ORDER_WITH_HISTORY), true);

  const staffAfter = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(staffUnreadCount(staffAfter.messages, staffAfter.staffLastReadAt), 0, "客服读过的会话未读数归零");
  assert.ok(staffAfter.staffLastReadAt);

  // 两个方向互不影响：客服读完了，用户那边的未读角标该是什么还是什么
  const after = await listConversationsForUser(USER_A, undefined, "server");
  assert.equal(
    after.find((conversation) => conversation.orderId === ORDER_WITH_HISTORY).unreadCount,
    userUnreadBefore,
    "客服已读不该把用户侧的未读清零",
  );

  // 按「会话 + 客服」记：另一位客服的待办不受影响
  const staffA = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  assert.ok(staffUnreadCount(staffA.messages, staffA.staffLastReadAt) > 0, "一位客服读过的会话不该从另一位的工作台上消失");

  // 不存在的会话不会「顺手建一个」：客服不能凭空给一笔订单造出会话
  assert.equal(await markStaffConversationRead(STAFF_A, ORDER_WITHOUT_CONVERSATION), false);
});

// ——————————————————————————— 五、消息身份、幂等与快照 ———————————————————————————

test("客服发送：发送者身份由服务端写，请求体里的角色与发送者会被忽略", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const { messageId, created } = await sendMessageForStaff(
    staff,
    ORDER_WITH_HISTORY,
    staffMessageBody("这条消息试图伪装成用户", {
      senderRole: "user",
      senderId: USER_A,
      senderName: "老板A",
      senderAvatarUrl: "https://evil.example/a.png",
      userId: "u-9999",
    }),
    undefined,
    "server",
  );
  assert.equal(created, true);

  const detail = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  const sent = detail.messages.find((message) => message.id === messageId);

  assert.equal(sent.senderRole, "customer_service");
  assert.equal(sent.isSelf, false, "对另一位客服来说不是自己发的");
  // 快照写的是**发送时**这位客服的名称与头像，不是请求体里塞的那些
  assert.equal(sent.senderName, "客服小雨（占位）");
  assert.equal(sent.senderAvatarUrl.includes("evil.example"), false);

  const asSelf = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(asSelf.messages.find((message) => message.id === messageId).isSelf, true);
});

test("用户端立即可见：客服发出去的消息就在同一个仓储里，不需要任何同步动作", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const { messageId } = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, staffMessageBody("客服回你一条"), undefined, "server");

  const { messages } = await getMessagesForUser(USER_A, ORDER_WITH_HISTORY, undefined, "server");
  const seen = messages.find((message) => message.id === messageId);

  assert.ok(seen, "用户端必须立刻看得到客服刚发的消息");
  assert.equal(seen.senderRole, "customer_service");
  assert.equal(seen.userId, USER_A, "消息挂在会话所属用户下，用户端按自己的 userId 就查得到");
  assert.equal(seen.orderId, ORDER_WITH_HISTORY);
  assert.equal(seen.body, "客服回你一条");

  // 用户收得到，别的用户收不到
  const other = await getMessagesForUser("u-1002", ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(other, null, "别人的订单一律拿不到");
});

test("空白与超长消息被拒：超长明确报错，不静默截断", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const before = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");

  const empty = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, staffMessageBody("   "), undefined, "server").catch((e) => e);
  assert.equal(empty.code, "BAD_REQUEST");
  assert.equal(empty.message, MESSAGE_EMPTY_MESSAGE);

  const tooLong = "字".repeat(MESSAGE_MAX_LENGTH + 1);
  const long = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, staffMessageBody(tooLong), undefined, "server").catch((e) => e);
  assert.equal(long.code, "BAD_REQUEST");
  assert.equal(long.message, MESSAGE_TOO_LONG_MESSAGE, "超长必须是明确的错误，而不是悄悄截断成能发出去的样子");

  // 边界值可以通过：上限本身是合法的
  const atLimit = await sendMessageForStaff(
    staff,
    ORDER_WITH_HISTORY,
    staffMessageBody("字".repeat(MESSAGE_MAX_LENGTH)),
    undefined,
    "server",
  );
  assert.equal(atLimit.created, true);

  const after = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(after.messages.length, before.messages.length + 1, "被拒的两次一条都没写进去");
  assert.equal(after.messages.some((message) => message.body.length > MESSAGE_MAX_LENGTH), false);
});

test("缺少幂等键或格式不合法一律拒绝：防重不是靠按钮禁用", async () => {
  const staff = await staffSessionOf(STAFF_A);

  await expectApiError(sendMessageForStaff(staff, ORDER_WITH_HISTORY, { body: "没有键" }, undefined, "server"), "BAD_REQUEST");
  await expectApiError(
    sendMessageForStaff(staff, ORDER_WITH_HISTORY, { body: "键太短", idempotencyKey: "abc" }, undefined, "server"),
    "BAD_REQUEST",
  );
  await expectApiError(
    sendMessageForStaff(staff, ORDER_WITH_HISTORY, { body: "键带空格", idempotencyKey: "abc def ghi" }, undefined, "server"),
    "BAD_REQUEST",
  );
});

test("幂等：同一个键重复发送只产生一条消息，连点与重试都不会刷屏", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const before = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  const payload = staffMessageBody("连点了三下");

  const first = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, payload, undefined, "server");
  const second = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, payload, undefined, "server");
  const third = await sendMessageForStaff(staff, ORDER_WITH_HISTORY, payload, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(third.created, false);
  assert.equal(second.messageId, first.messageId);
  assert.equal(third.messageId, first.messageId);

  const after = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(after.messages.length, before.messages.length + 1);
});

test("并发同键只写一条：抢在同一个瞬间的两份请求不会各写一条", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const before = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  const payload = staffMessageBody("同时到达的两份请求");

  const results = await Promise.all([
    sendMessageForStaff(staff, ORDER_WITH_HISTORY, payload, undefined, "server"),
    sendMessageForStaff(staff, ORDER_WITH_HISTORY, payload, undefined, "server"),
  ]);

  assert.equal(results.filter((result) => result.created).length, 1, "只允许一次真正写入");
  assert.equal(new Set(results.map((result) => result.messageId)).size, 1);

  const after = await getStaffConversationDetail(STAFF_A, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(after.messages.length, before.messages.length + 1);
});

test("幂等键的作用域是「订单 + 发送者」：换一笔订单、换一位客服都是另一条消息", async () => {
  const payload = staffMessageBody("同一个键用在两笔订单上");

  await sendMessageForStaff(await staffSessionOf(STAFF_A), ORDER_WITH_HISTORY, payload, undefined, "server");
  const otherOrder = await sendMessageForStaff(
    await staffSessionOf(STAFF_A),
    "ord-seed-1001-03",
    payload,
    undefined,
    "server",
  );
  assert.equal(otherOrder.created, true, "同一把键落在另一笔订单上不是重放");

  const otherStaff = await sendMessageForStaff(
    await staffSessionOf(STAFF_B),
    ORDER_WITH_HISTORY,
    payload,
    undefined,
    "server",
  );
  assert.equal(otherStaff.created, true, "两位客服各自发的消息不该互相吞掉");
});

test("客服不能给没有会话的订单发消息：与订单不存在同样拿不到", async () => {
  const staff = await staffSessionOf(STAFF_A);
  await expectApiError(
    sendMessageForStaff(staff, ORDER_WITHOUT_CONVERSATION, staffMessageBody("偷偷建一个会话"), undefined, "server"),
    "NOT_FOUND",
  );

  // 拒绝之后也没有留下半个会话
  assert.equal(await getStaffConversationDetail(STAFF_A, ORDER_WITHOUT_CONVERSATION, undefined, "server"), null);
});

test("历史消息用发送时的快照：客服改名或移除之后，旧消息不会变成空白", async () => {
  const original = staffSeed.find((item) => item.id === STAFF_A);
  const renamed = "客服小雨（已改名）";

  await updateAdminStaff(STAFF_A, ADMIN_ID, {
    username: original.username,
    displayName: renamed,
    avatarUrl: MOCK_AVATAR_OPTIONS[1],
    idempotencyKey: key(),
  });

  // 改名之后发的消息用的是**新**名字——证明这次改名确实生效了
  const fresh = await sendMessageForStaff(
    await staffSessionOf(STAFF_A),
    ORDER_WITH_HISTORY,
    staffMessageBody("改名之后发的"),
    undefined,
    "server",
  );
  const afterRename = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(afterRename.messages.find((m) => m.id === fresh.messageId).senderName, renamed);

  // 改名之前的那些消息仍然是当年的名字
  const oldMessages = afterRename.messages.filter(
    (message) => message.senderRole === "customer_service" && message.id !== fresh.messageId,
  );
  assert.ok(oldMessages.length > 0);
  assert.equal(oldMessages.every((message) => message.senderName === original.displayName), true);

  await removeAdminStaff(STAFF_A, ADMIN_ID, { idempotencyKey: key() });

  // 软删除之后，另一位客服打开同一个会话，历史消息照样显示得出当时的名字与头像
  const afterRemove = await getStaffConversationDetail(STAFF_B, ORDER_WITH_HISTORY, undefined, "server");
  assert.equal(afterRemove.messages.length, afterRename.messages.length);
  for (const message of afterRemove.messages.filter((m) => m.senderRole === "customer_service")) {
    assert.ok(message.senderName.length > 0, "已移除客服的历史消息不能变成空白");
    assert.ok(message.senderAvatarUrl.length > 0);
  }
  assert.equal(
    afterRemove.messages.find((m) => m.id === fresh.messageId).senderName,
    renamed,
    "快照是发送时那一次，之后改名字不会追溯修改历史",
  );
});

test("客服发消息不改订单：状态、金额、商品与消费等级、排行榜都不受影响", async () => {
  const before = await getOrderDetailForUser(ORDER_WITH_HISTORY, USER_A, undefined, "server");
  const rankingBefore = await getConsumptionRanking(null, page(), "server");

  await sendMessageForStaff(
    await staffSessionOf(STAFF_A),
    ORDER_WITH_HISTORY,
    staffMessageBody("客服说话不会改单"),
    undefined,
    "server",
  );

  const after = await getOrderDetailForUser(ORDER_WITH_HISTORY, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.equal(after.totalAmount, before.totalAmount);
  assert.equal(after.productTitle, before.productTitle);
  assert.equal(after.specName, before.specName);

  // 客服不是消费者：他说话不该给任何人加分，也不该把谁从榜上挤下去
  const rankingAfter = await getConsumptionRanking(null, page(), "server");
  assert.deepEqual(rankingAfter.items, rankingBefore.items);
  assert.equal(rankingAfter.total, rankingBefore.total);
});

test("客服账号不进用户名单，也不参与消费：它是独立的第三类身份", async () => {
  const accounts = await getStaffRepository().listStaff();
  const userIds = new Set(userSeed.map((user) => user.id));
  const companionIds = new Set(orderSeed.map((order) => order.companionId).filter(Boolean));

  for (const account of accounts) {
    assert.equal(userIds.has(account.id), false, "客服账号不能混成普通用户");
    assert.equal(companionIds.has(account.id), false, "客服账号也不能混成护航");
    assert.ok(account.id.startsWith("staff-") || account.id.startsWith("staff_"));
  }

  // 客服账号里没有「消费金额」这类字段：不进排行榜的第一步是根本没有这个数
  for (const account of accounts) {
    for (const forbidden of ["spendAmount", "totalSpend", "level", "points", "coupon"]) {
      assert.equal(forbidden in account, false, `客服账号不该有 ${forbidden}`);
    }
  }
});

// ——————————————————————————— 六、源码门禁 ———————————————————————————

test("客服接口清单固定：认证三件 + 会话四件 + 退款四件 + 投诉五件", () => {
  const routeFiles = collectFiles(STAFF_API_DIR).filter((file) => file.endsWith("route.ts"));

  // 逐个写出来而不是只断言数量：少一个、多一个、被改名都会在这里现形。
  // ⚠️ 这里没有「管理客服账号」的地址：那在 `/api/admin/staff/**`，
  // 两者的鉴权是两套（`requireAdmin()` 与 `requireStaff()`），不能合成一个地址段。
  // ⚠️ **仍然没有**「改订单」的地址：客服不能改订单状态、金额、商品（P8D-2 也没有放开）。
  // ⚠️ 退款**只有四个**地址：列表、详情、开始审核、驳回。
  //    **没有 `approve`**：通过会在同一次写入里把订单改成「已退款」，属于资金最终划拨，
  //    留在管理员侧。这个「少一个地址」就是那条边界在代码里的样子——
  //    接口不存在，因此谁也无法从客服端把它调出来。
  // ⚠️ 投诉五个：列表、详情，加三个处理动作（开始处理 / 解决 / 关闭）——
  //    投诉不写订单、不写退款、不动金额，因此三个动作都归客服。
  assert.deepEqual(
    routeFiles.map((file) => path.relative(STAFF_API_DIR, file).replace(/\\/g, "/")).sort(),
    [
      "auth/logout/route.ts",
      "auth/mock-login/route.ts",
      "auth/session/route.ts",
      "complaints/[id]/close/route.ts",
      "complaints/[id]/resolve/route.ts",
      "complaints/[id]/route.ts",
      "complaints/[id]/start-processing/route.ts",
      "complaints/route.ts",
      // 详情与发送共用一个地址段（GET 读、POST 发），因此只有这一个 route.ts
      "conversations/[orderId]/messages/route.ts",
      "conversations/[orderId]/read/route.ts",
      "conversations/[orderId]/route.ts",
      "conversations/route.ts",
      "refunds/[id]/reject/route.ts",
      "refunds/[id]/route.ts",
      "refunds/[id]/start-review/route.ts",
      "refunds/route.ts",
    ],
  );

  // 每个客服接口都不能出现别的身份守卫：混进一个 requireUser 就等于开了第二条进工作台的路
  for (const file of routeFiles) {
    const source = stripComments(readSource(file));
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");

    for (const forbidden of ["requireAdmin", "requireUser", "getSessionUser", "getSessionAdmin"]) {
      assert.equal(source.includes(forbidden), false, `${relative} 不该出现 ${forbidden}`);
    }
  }

  // 需要「当前是谁」的接口：第一件事必须是 requireStaff()，而且必须在读请求体之前
  for (const file of routeFiles) {
    const relative = path.relative(STAFF_API_DIR, file).replace(/\\/g, "/");
    // ⚠️ 登录与退出**没有**守卫，而且这是对的：它们要回答的正是「现在是谁」，
    //    在还没登录的时候也必须能调（退出还得能被重复调用以清掉一个过期的 Cookie）。
    if (relative === "auth/mock-login/route.ts" || relative === "auth/logout/route.ts") continue;

    const source = withoutImports(stripComments(readSource(file)));
    const guard = source.indexOf("requireStaff");
    assert.notEqual(guard, -1, `${relative} 缺少客服身份守卫`);

    // 假守卫：先处理请求体再鉴权，等于把解析成本交给了未认证的请求
    const readsBody = source.indexOf("readJsonBody");
    if (readsBody !== -1) {
      assert.ok(guard < readsBody, `${relative} 的身份守卫必须是第一步，解析请求体不能发生在鉴权之前`);
    }
  }

  // 登录接口由开关控制，未开启时按「接口不存在」返回——靠的是服务端的开关判断
  const loginRoute = stripComments(readSource(path.join(STAFF_API_DIR, "auth", "mock-login", "route.ts")));
  assert.ok(loginRoute.includes("loginMockStaff"));
  assert.equal(loginRoute.includes("isMockStaffEnabled"), false, "开关判断在服务层，接口不自己看环境变量");

  // ⚠️ 过闸必须排在 `readJsonBody()` 前面：接口层读体会先校验请求体格式，
  // 让「开关关闭」退回成 400 等于把这个接口的存在本身说出去。用户端
  // `/api/auth/mock-login` 就是这个次序，两边必须一致。
  const gate = loginRoute.indexOf("assertMockStaffEnabled()");
  const parse = loginRoute.indexOf("readJsonBody(");
  assert.ok(gate !== -1, "登录接口没有在开关关闭时按「接口不存在」返回");
  assert.ok(parse !== -1, "登录接口应当读取请求体");
  assert.ok(gate < parse, "开关判断必须发生在解析请求体之前");
});

test("客服工作台不复用用户端壳层，也不进管理员侧栏", () => {
  const layout = stripComments(readSource(findAppFile("staff/layout.tsx")));

  // 移动端 480px 容器、底部 TabBar 与后台侧栏都不出现在工作台
  for (const forbidden of ["MobileShell", "TabBar", "shell-width", "AdminSidebar", "AdminShell"]) {
    assert.equal(layout.includes(forbidden), false, `工作台壳层不该出现 ${forbidden}`);
  }

  // 工作台页面按地址找得到，且登录页在壳层之外（否则会转成一个死循环）
  for (const route of ["staff/page.tsx", "staff/login/page.tsx", "staff/conversations/page.tsx"]) {
    assert.ok(findAppFile(route).length > 0, `缺少 ${route}`);
  }
  assert.equal(
    findAppFile("staff/login/page.tsx").includes("(console)"),
    false,
    "登录页不该待在需要登录的壳层里",
  );

  // 详情页不能有加载边界：外壳先以 200 发出之后，迟到的 notFound() 只能改内容、改不了状态码
  const detailDir = path.dirname(findAppFile("staff/conversations/[orderId]/page.tsx"));
  assert.equal(
    readdirSync(detailDir).some((name) => /^loading\.(tsx|js)$/.test(name)),
    false,
    "订单沟通页不该有 loading.tsx：加载边界会把真 404 变成 200",
  );
});

test("客服页面与服务不直接引用 Mock 数据，也不出现管理端的调用", () => {
  const staffSources = [
    ...collectFiles(path.join(ROOT, "app", "staff")),
    ...collectFiles(path.join(ROOT, "components", "staff")),
  ].filter((file) => /\.(ts|tsx)$/.test(file));
  assert.ok(staffSources.length > 0, "没找到客服端源码");

  for (const file of staffSources) {
    const source = stripComments(readSource(file));
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");

    // 页面组件不直接 import lib/mocks：一律走 HTTP（`lib/services/*Http.ts`）
    assert.equal(source.includes("lib/mocks"), false, `${relative} 不该直接引用 lib/mocks`);
    // 客服端不认识管理端的服务与接口
    assert.equal(source.includes("services/adminHttp"), false, `${relative} 不该调用管理端接口`);
    assert.equal(source.includes("api/admin"), false, `${relative} 不该请求管理端接口`);
    // 无 HTML 注入
    assert.equal(source.includes("dangerouslySetInnerHTML"), false, `${relative} 不该注入 HTML`);
  }

  // 工作台壳层与列表/详情都不含 /admin 链接（登录页那句「管理员请去 /admin/login」的说明除外）
  const consoleSources = collectFiles(path.join(ROOT, "app", "staff", "(console)")).filter((file) =>
    /\.tsx$/.test(file),
  );
  for (const file of consoleSources) {
    const source = stripComments(readSource(file));
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    assert.equal(source.includes('href="/admin'), false, `${relative} 不该有指向管理后台的入口`);
  }
});

test("客服端的文案说明了三件事：Mock 认证、不是实时、只读订单", () => {
  const constants = readSource(path.join(ROOT, "lib", "constants", "staff.ts"));

  // 页面上的字符串是纯文本渲染的，出现 ** 会原样显示成两个星号
  for (const name of [
    "STAFF_MOCK_NOTICE",
    "STAFF_MOCK_DISABLED_MESSAGE",
    "STAFF_OVERVIEW_NOTICE",
    "STAFF_CONVERSATION_LIST_NOTICE",
    "STAFF_CONVERSATION_LIST_FIELDS_NOTE",
    "STAFF_NOT_REALTIME_NOTICE",
    "STAFF_ORDER_READONLY_NOTICE",
    "STAFF_MESSAGE_SEND_HINT",
  ]) {
    const start = constants.indexOf(`export const ${name}`);
    assert.notEqual(start, -1, `找不到 ${name}`);
    const end = constants.indexOf(";", start);
    assert.equal(constants.slice(start, end).includes("**"), false, `${name} 里不该有 Markdown 星号`);
  }

  // 三句必须出现在页面上的话各自说了什么
  assert.ok(STAFF_MOCK_NOTICE.includes("没有真实密码"), "必须一眼看出这是本地模拟");
  assert.ok(STAFF_MOCK_DISABLED_MESSAGE.includes("ENABLE_MOCK_STAFF"), "关闭开关时要说明开关名");
  assert.ok(STAFF_NOT_REALTIME_NOTICE.includes("刷新"), "不说明的话「发了没反应」会被当成故障");
  assert.ok(STAFF_ORDER_READONLY_NOTICE.includes("不能修改订单"), "只读边界要写在明面上");
  assert.ok(ADMIN_STAFF_CREDENTIAL_NOTICE.includes("不保存任何真实密码"));
  assert.ok(ADMIN_STAFF_EMPTY_MESSAGE.length > 0);
});

// ——————————————————————————— 七、HTTP（需要真实服务）———————————————————————————

test("匿名访问客服工作台与客服接口：一律挡住，不是 200", { skip: SKIP_HTTP }, async () => {
  for (const pathname of ["/api/staff/auth/session", "/api/staff/conversations"]) {
    const anonymous = await requestWithCookie(pathname, null);
    assert.equal(anonymous.status, 401, `${pathname} 匿名应当是 401`);
  }

  // 页面转到客服登录页，而不是渲染出一份没有数据的空工作台
  const pageResponse = await requestWithCookie("/staff", null);
  assert.equal(pageResponse.status, 307);
  assert.ok(pageResponse.response.headers.get("location")?.includes("/staff/login"));
});

test("三类 Cookie 完全隔离：任何一端都进不了另外两端", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");

  // 用户端与管理端的 Cookie 一律读不到客服的东西——与客服端开关无关，永远成立
  for (const cookie of ["mock_user_id=u-1001", "mock_admin_id=admin-1"]) {
    const session = await requestWithCookie("/api/staff/auth/session", cookie);
    assert.equal(session.status, 401, `${cookie} 不该拿到客服会话`);

    const list = await requestWithCookie("/api/staff/conversations", cookie);
    assert.equal(list.status, 401, `${cookie} 不该读到客服会话列表`);
  }

  if (login.status !== 200) {
    // 本次跑的服务关着客服端开关：登录接口按「不存在」返回，伪造的客服 Cookie 也不产生身份
    assert.equal(login.status, 404);
    assert.equal(login.setCookie.length, 0, "未启用时不该下发任何 Cookie");

    const forged = await requestWithCookie("/api/staff/auth/session", "mock_staff_id=staff-1");
    assert.equal(forged.status, 401);
    const forgedPage = await requestWithCookie("/staff", "mock_staff_id=staff-1");
    assert.equal(forgedPage.status, 307, "开关关闭时伪造 Cookie 也进不去工作台");
    return;
  }

  // 开关开启：客服 Cookie 只对客服端有效
  const staffCookie = login.setCookie[0].split(";")[0];
  assert.equal(login.setCookie.length, 1, "登录只该下发一个 Cookie");
  assert.ok(staffCookie.startsWith("mock_staff_id="), "客服端用的是第三个独立 Cookie");
  for (const attribute of ["HttpOnly", "SameSite=lax", "Path=/"]) {
    assert.ok(login.setCookie[0].includes(attribute), `Cookie 缺少 ${attribute}`);
  }
  assert.equal(login.setCookie[0].includes("mock_user_id"), false);
  assert.equal(login.setCookie[0].includes("mock_admin_id"), false);

  const session = await requestWithCookie("/api/staff/auth/session", staffCookie);
  assert.equal(session.status, 200);
  assert.ok(session.body.includes("kefu-xiaoyu"));
  // 响应体不含内部状态字段与任何凭据
  assert.equal(/password|secret|token|removedAt|lastLoginAt/i.test(session.body), false);

  // 客服 Cookie 不能调用用户 API，也不能调用管理 API
  const me = await requestWithCookie("/api/me", staffCookie);
  assert.equal(me.status, 401, "客服 Cookie 不该通过用户接口的鉴权");
  const adminList = await requestWithCookie("/api/admin/staff", staffCookie);
  assert.equal(adminList.status, 401, "客服 Cookie 不该通过管理接口的鉴权");

  // 工作台页面渲染得出真实数据，且不带用户端壳层
  const console_ = await requestWithCookie("/staff", staffCookie);
  assert.equal(console_.status, 200);
  const conversations = await requestWithCookie("/staff/conversations", staffCookie);
  assert.equal(conversations.status, 200);

  // 护航与已停用账号即使拿到 Cookie 也进不来（403，与订单不存在同体）
  const disabled = await requestWithCookie("/api/staff/conversations", "mock_staff_id=staff-3");
  assert.equal(disabled.status, 403);
  const companion = await requestWithCookie("/api/staff/conversations", "mock_staff_id=staff-4");
  assert.equal(companion.status, 403);
  const removed = await requestWithCookie("/api/staff/conversations", "mock_staff_id=staff-5");
  assert.equal(removed.status, 403);
});

test("登录页只列能登录的客服账号：停用 / 已移除 / 护航都不出现", { skip: SKIP_HTTP }, async () => {
  const panel = await requestWithCookie("/staff/login", null);
  assert.equal(panel.status, 200, "登录页本身不该要求登录，否则会转成一个死循环");

  const login = await staffLogin("staff-1");
  const loginable = ["kefu-xiaoyu", "kefu-anran"];
  const notLoginable = ["kefu-linlin", "huhang-aze", "kefu-yiqi"];

  if (login.status === 404) {
    // 开关关闭：一个账号都不列，页面上只有一句「未启用」的说明
    for (const username of [...loginable, ...notLoginable]) {
      assert.equal(panel.body.includes(username), false, `开关关闭时不该列出 ${username}`);
    }
    assert.ok(panel.body.includes("模拟客服登录未启用"), "关闭时要说明是哪个开关没开");
    return;
  }

  for (const username of loginable) {
    assert.ok(panel.body.includes(username), `能登录的 ${username} 应当出现在名单里`);
  }
  for (const username of notLoginable) {
    // 列出点了一定失败的账号，等于给出一个「点了没用」的入口，也等于泄漏这些账号存在
    assert.equal(panel.body.includes(username), false, `${username} 不该出现在名单里`);
  }
});

test("客服端登录接口只认能登录的账号，退出只清客服端 Cookie", { skip: SKIP_HTTP }, async () => {
  const ok = await staffLogin("staff-1");
  if (ok.status === 404) {
    // 未开启 ENABLE_MOCK_STAFF：接口按「不存在」处理，由上一个用例覆盖名单，
    // 这里补一条**次序**断言——「开关关闭」必须比「请求体格式」先说话。
    // 读体在先的话，一个畸形请求会拿到 400，等于承认这个接口存在。
    const malformed = await requestWithCookie("/api/staff/auth/mock-login", null, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 404, "开关关闭时畸形请求也应当是 404，而不是 400");
    assert.ok(malformed.body.includes("模拟客服登录未启用"));
    return;
  }

  assert.equal(ok.status, 200);

  for (const id of ["staff-3", "staff-4", "staff-5", "staff-不存在"]) {
    const rejected = await staffLogin(id);
    assert.equal(rejected.status, 403, `${id} 不该登录成功`);
    assert.equal(rejected.setCookie.length, 0, "被拒的登录不该下发 Cookie");
  }

  // 退出：只清客服端 Cookie，另外两端不受影响
  const staffCookie = ok.setCookie[0].split(";")[0];
  const logout = await fetch(new URL("/api/staff/auth/logout", BASE), {
    method: "POST",
    headers: { cookie: `${staffCookie}; mock_user_id=u-1001; mock_admin_id=admin-1` },
  });
  assert.equal(logout.status, 200);
  const cleared = logout.headers.getSetCookie().join(" ");
  assert.ok(cleared.includes("mock_staff_id="));
  assert.ok(cleared.includes("Max-Age=0"), "退出后 Cookie 必须立即失效");
  assert.equal(cleared.includes("mock_user_id"), false, "退出客服端不该动用户端 Cookie");
  assert.equal(cleared.includes("mock_admin_id"), false, "也不该动管理端 Cookie");
});

test("客服在接口层发的消息，用户端接口立刻读得到", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;

  const staffCookie = login.setCookie[0].split(";")[0];
  const orderId = "ord-seed-1001-04";
  const body = `HTTP 链路上的一条消息 ${key()}`;

  const sent = await fetch(new URL(`/api/staff/conversations/${orderId}/messages`, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: staffCookie },
    body: JSON.stringify({ body, idempotencyKey: key() }),
  });
  assert.equal(sent.status, 200);
  const payload = await sent.json();
  assert.equal(payload.data.created, true);

  // 同一份数据、同一个仓储：用户端只要请求自己的接口就能看到
  const userLogin = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "u-1001" }),
  });
  if (userLogin.status !== 200) return; // 未开启 ENABLE_MOCK_AUTH，用户端这条链路本次跑不了
  const userCookie = userLogin.headers.getSetCookie()[0].split(";")[0];

  const read = await requestWithCookie(`/api/orders/${orderId}/messages`, userCookie);
  assert.equal(read.status, 200);
  assert.ok(read.body.includes(body), "用户端必须立刻看得到客服刚发的消息");
});

test("伪造的客服身份请求会话详情：不存在的订单与没权限的会话给同一个 404", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const staffCookie = login.setCookie[0].split(";")[0];

  // 有会话的订单：200，且带上只读摘要
  const detail = await requestWithCookie("/api/staff/conversations/ord-seed-1001-04", staffCookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.includes("orderNo"), true);
  // 摘要有金额（客服要对得上账），但没有游戏 ID、订单备注与任何支付凭据
  assert.equal(detail.body.includes("totalAmount"), true);
  for (const forbidden of ["gameAccountId", "remark", "openId", "unionId", "sessionId", "cookie"]) {
    assert.equal(detail.body.includes(forbidden), false, `详情的响应体不该出现 ${forbidden}`);
  }
  // 会话列表不含完整消息历史：列表接口里没有 body 字段
  const listBody = await requestWithCookie("/api/staff/conversations", staffCookie);
  assert.equal(listBody.status, 200);
  assert.equal(listBody.body.includes("lastMessageBody"), true, "列表只给最后一条的摘要");
  assert.equal(/"messages"/.test(listBody.body), false, "列表不带完整消息历史");

  // 没有会话的订单与不存在的订单：同一个状态码同一个提示语
  const noConversation = await requestWithCookie("/api/staff/conversations/ord-seed-1001-02", staffCookie);
  const missing = await requestWithCookie("/api/staff/conversations/ord-does-not-exist", staffCookie);
  assert.equal(noConversation.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(noConversation.body, missing.body, "两种情形必须完全无法区分，否则订单号可以被逐个试探");
});
