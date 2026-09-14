import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STAFF_COMPLAINT_STATUS_FILTER,
  STAFF_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE,
  STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  STAFF_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  STAFF_COMPLAINT_NOT_FOUND_MESSAGE,
  STAFF_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  STAFF_COMPLAINT_REPLAY_NOTICE,
  STAFF_COMPLAINT_RESULT_EMPTY_MESSAGE,
  STAFF_COMPLAINT_RESULT_MAX_LENGTH,
  STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  STAFF_COMPLAINT_STATUS_INVALID_MESSAGE,
  STAFF_COMPLAINT_STATUS_FILTERS,
  STAFF_COMPLAINT_SUCCESS_MESSAGES,
  STAFF_COMPLAINT_TYPE_FILTERS,
  STAFF_COMPLAINT_TYPE_INVALID_MESSAGE,
  buildStaffComplaintTimeline,
  complaintMatchesStaffKeyword,
  normalizeStaffComplaintResult,
  normalizeStaffComplaintStatusFilter,
  normalizeStaffComplaintTypeFilter,
  readStaffComplaintStatusFilter,
  readStaffComplaintTypeFilter,
  staffComplaintAllowedActions,
  toStaffComplaintListItem,
} from "../lib/constants/staffComplaints.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { getMessageRepository } from "../lib/data/messageRepository.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { getStaffRepository } from "../lib/data/staffRepository.ts";
import {
  closeStaffComplaint,
  getStaffComplaintDetail,
  queryStaffComplaintList,
  resolveStaffComplaint,
  resolveStaffComplaintListQuery,
  startProcessingStaffComplaint,
} from "../lib/services/staffComplaints.ts";

/**
 * 客服端「投诉处理」的持续测试（P8D-2）。
 *
 * 跑的是**真实实现**：真实的 Mock 投诉 / 订单 / 退款 / 消息 / 客服仓储 + 真实的
 * `lib/data/adminComplaintTransaction.ts` 伪事务 + 真实的 `lib/services/staffComplaints.ts`。
 * 因此「客服三个动作共用管理端状态机」「解决 / 关闭必填结论」「处理投诉不写订单不退款」
 * 「用户提交的内容不可被覆盖」「幂等按操作者 × 意图收窄」「列表无联系方式、详情才有」
 * 这些规则每次提交都会被重新验证。
 *
 * 需要真实服务的断言（HTTP 状态码与 Cookie 行为）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `tests/staff.test.mjs` 同一套做法。
 *
 * ⚠️ HTTP 写用例**只占用** `cmp-seed-1001-01`（预置唯一待处理的那条），
 * 不碰 `-02/-03/-04` 与 `cmp-seed-1002-01`；且每条用例都不依赖上一条改完的状态——
 * 开发服务器的内存 store 在测试之间不会被重置，因此写断言要按「读到的当前状态」自适应。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过客服端投诉 HTTP 用例";

const SURFACE = "server";
const STAFF_A = "staff-1";
const STAFF_B = "staff-2";

/** 待处理、关联订单；**没有**联系方式与凭证。HTTP 写用例唯一占用的种子。 */
const PENDING_COMPLAINT = "cmp-seed-1001-01";
/** 处理中、关联订单；**有**联系方式与凭证（隐私边界的样本）。 */
const PROCESSING_COMPLAINT = "cmp-seed-1001-02";
/** 已处理（终态） */
const RESOLVED_COMPLAINT = "cmp-seed-1001-03";
/** 已关闭（终态），且**不关联订单** */
const CLOSED_COMPLAINT = "cmp-seed-1001-04";

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function withoutImports(source) {
  return source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
}

function readSource(file) {
  return readFileSync(file, "utf8");
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function key() {
  return crypto.randomUUID();
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

async function complaintOf(id) {
  return getComplaintRepository().findComplaintById(id);
}

function auditCount() {
  return adminAuditStore().audits.size;
}

function auditsFor(targetId) {
  return [...adminAuditStore().audits.values()].filter((entry) => entry.targetId === targetId);
}

/** 服务层读的那份客服会话：只拼 `requireStaff()` 返回里真正被用的字段。 */
async function staffSessionOf(staffId) {
  const account = await getStaffRepository().findStaffById(staffId);
  assert.ok(account, `预置客服账号缺失：${staffId}`);
  return { id: account.id, displayName: account.displayName };
}

async function orderFingerprint() {
  const orders = await getPaymentRepository().listAllOrders();
  return orders.map((order) => `${order.id}:${order.status}:${order.totalAmount}`).sort();
}

async function refundFingerprint() {
  const orders = await getPaymentRepository().listAllOrders();
  const refunds = await Promise.all(
    orders.map((order) => getRefundRepository().findRefundByOrderId(order.id)),
  );
  return refunds
    .filter(Boolean)
    .map((refund) => `${refund.id}:${refund.status}:${refund.amount}`)
    .sort();
}

beforeEach(() => {
  resetMockStore("complaint");
  resetMockStore("adminAudit");
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("message");
  resetMockStore("staff");
});

// ——————————————————————————— 一、筛选与纯逻辑 ———————————————————————————

test("筛选解析：非法值接口 400 / 页面收敛，默认待处理", async () => {
  assert.equal(readStaffComplaintStatusFilter(null), DEFAULT_STAFF_COMPLAINT_STATUS_FILTER);
  assert.equal(readStaffComplaintStatusFilter("  "), DEFAULT_STAFF_COMPLAINT_STATUS_FILTER);
  assert.equal(readStaffComplaintStatusFilter("processing"), "processing");
  assert.equal(readStaffComplaintStatusFilter("不存在的状态"), null);
  assert.equal(normalizeStaffComplaintStatusFilter("不存在的状态"), "pending");

  assert.equal(readStaffComplaintTypeFilter(null), "all");
  assert.equal(readStaffComplaintTypeFilter(""), "all");
  assert.equal(readStaffComplaintTypeFilter("payment_issue"), "payment_issue");
  assert.equal(readStaffComplaintTypeFilter("whatever"), null);
  assert.equal(normalizeStaffComplaintTypeFilter("whatever"), "all");

  const defaults = await resolveStaffComplaintListQuery(new URLSearchParams(), false);
  assert.equal(defaults.status, "pending");
  assert.equal(defaults.type, "all");
  assert.equal(defaults.page, 1);

  await expectApiError(
    resolveStaffComplaintListQuery(new URLSearchParams({ status: "whatever" }), true),
    "BAD_REQUEST",
    STAFF_COMPLAINT_STATUS_INVALID_MESSAGE,
  );
  await expectApiError(
    resolveStaffComplaintListQuery(new URLSearchParams({ type: "whatever" }), true),
    "BAD_REQUEST",
    STAFF_COMPLAINT_TYPE_INVALID_MESSAGE,
  );

  assert.deepEqual([...STAFF_COMPLAINT_STATUS_FILTERS], ["all", "pending", "processing", "resolved", "closed"]);
  assert.deepEqual([...STAFF_COMPLAINT_TYPE_FILTERS], [
    "all",
    "companion_service",
    "refund_dispute",
    "payment_issue",
    "platform_service",
    "other",
  ]);
});

test("状态机：客服三个动作齐全，但能否执行由状态推导，终态三项全 false", () => {
  assert.deepEqual(staffComplaintAllowedActions("pending"), {
    canStartProcessing: true,
    canResolve: false,
    canClose: true,
  });
  assert.deepEqual(staffComplaintAllowedActions("processing"), {
    canStartProcessing: false,
    canResolve: true,
    canClose: true,
  });
  for (const terminal of ["resolved", "closed"]) {
    assert.deepEqual(
      staffComplaintAllowedActions(terminal),
      { canStartProcessing: false, canResolve: false, canClose: false },
      `${terminal} 不该有可执行动作`,
    );
  }
});

test("关键词只命中投诉编号 / 订单号 / 用户昵称，大小写不敏感", () => {
  assert.equal(
    complaintMatchesStaffKeyword(
      { complaintNo: "TS20260904000101", orderNo: "YM20260904000110", nickname: "老板A" },
      "ts2026",
    ),
    true,
  );
  assert.equal(
    complaintMatchesStaffKeyword(
      { complaintNo: "TS1", orderNo: "YM2", nickname: "老板A" },
      "ym2",
    ),
    true,
  );
  assert.equal(
    complaintMatchesStaffKeyword({ complaintNo: "", orderNo: "", nickname: "老板A（占位）" }, "老板A"),
    true,
  );
  assert.equal(
    complaintMatchesStaffKeyword({ complaintNo: "TS1", orderNo: "YM2", nickname: "老板A" }, "不存在"),
    false,
  );
  assert.equal(
    complaintMatchesStaffKeyword({ complaintNo: "TS1", orderNo: "YM2", nickname: "老板A" }, "   "),
    true,
    "空关键词不筛选",
  );
});

test("结果校验复用管理端：解决与关闭的空值文案不同，超长各自报错，上限本身可通过", () => {
  assert.deepEqual(normalizeStaffComplaintResult(" 结论 ", "resolve"), { ok: true, value: "结论" });
  assert.equal(normalizeStaffComplaintResult("", "resolve").message, STAFF_COMPLAINT_RESULT_EMPTY_MESSAGE);
  assert.equal(normalizeStaffComplaintResult("", "close").message, STAFF_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE);
  assert.notEqual(STAFF_COMPLAINT_RESULT_EMPTY_MESSAGE, STAFF_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE);

  const tooLong = "x".repeat(STAFF_COMPLAINT_RESULT_MAX_LENGTH + 1);
  assert.equal(normalizeStaffComplaintResult(tooLong, "resolve").message, STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE);
  assert.equal(normalizeStaffComplaintResult(tooLong, "close").message, STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE);

  assert.equal(
    normalizeStaffComplaintResult("x".repeat(STAFF_COMPLAINT_RESULT_MAX_LENGTH), "resolve").ok,
    true,
    "刚好到上限应当通过",
  );
});

test("列表项 DTO 只挑摘要：无正文、凭证、联系方式、结果与处理人", async () => {
  const [complaint] = await getComplaintRepository().queryComplaintsForAdmin({ status: null, type: null });
  const user = { id: complaint.userId, nickname: "老板A（占位）", avatarUrl: "/mock/avatar-3.svg" };

  const item = toStaffComplaintListItem(complaint, user);
  assert.deepEqual(
    new Set(Object.keys(item)),
    new Set([
      "id",
      "complaintNo",
      "status",
      "statusLabel",
      "typeKey",
      "typeLabel",
      "orderId",
      "orderNo",
      "createdAt",
      "updatedAt",
      "user",
    ]),
    "列表项的字段集合变了",
  );
  assert.deepEqual(new Set(Object.keys(item.user)), new Set(["id", "nickname", "avatarUrl"]));

  // 用户摘要**没有**平台展示 ID（StaffUserSummary 与管理端 AdminUserSummary 是两个类型）
  assert.equal("displayId" in item.user, false);
  for (const forbidden of ["description", "contact", "evidence", "result", "handledById", "handledByRole", "handledByName", "processingAt", "handledAt", "userId"]) {
    assert.equal(forbidden in item, false, `列表项不该有 ${forbidden}`);
  }
});

test("时间轴只列已经发生的节点，按时间先后排", async () => {
  const resolved = await complaintOf(RESOLVED_COMPLAINT);
  const timeline = buildStaffComplaintTimeline(resolved);

  assert.deepEqual(timeline.map((entry) => entry.key), ["pending", "processing", "resolved"]);
  for (let index = 1; index < timeline.length; index += 1) {
    assert.ok(timeline[index - 1].at <= timeline[index].at, "时间轴必须按时间先后");
  }

  // 待处理只有提交一个节点；开始处理之后不补「已处理」节点
  const pending = await complaintOf(PENDING_COMPLAINT);
  assert.deepEqual(buildStaffComplaintTimeline(pending).map((entry) => entry.key), ["pending"]);
});

// ——————————————————————————— 二、列表与详情 ———————————————————————————

test("列表：默认待处理，状态与类型都能筛，关键词不命中正文与联系方式", async () => {
  const pending = await queryStaffComplaintList(
    await resolveStaffComplaintListQuery(page({ pageSize: "100" }), false),
    undefined,
    SURFACE,
  );
  assert.ok(pending.items.length > 0);
  for (const item of pending.items) assert.equal(item.status, "pending");

  const detail = await getStaffComplaintDetail(PENDING_COMPLAINT, undefined, SURFACE);
  assert.ok(detail);

  for (const [label, keyword] of [
    ["投诉编号", detail.complaintNo],
    ["订单号", detail.orderNo],
    ["用户昵称", detail.user.nickname],
  ]) {
    assert.ok(String(keyword).length > 0, `${label} 为空，这条断言失去意义`);
    const data = await queryStaffComplaintList(
      await resolveStaffComplaintListQuery(
        page({ status: "all", keyword: String(keyword), pageSize: "100" }),
        false,
      ),
      undefined,
      SURFACE,
    );
    assert.ok(
      data.items.some((item) => item.id === PENDING_COMPLAINT),
      `按${label}「${keyword}」没有搜到这条投诉`,
    );
  }

  // 正文与联系方式**不是**搜索对象
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  for (const [label, keyword] of [
    ["正文", sample.description.slice(0, 12)],
    ["联系方式", sample.contact],
  ]) {
    const data = await queryStaffComplaintList(
      await resolveStaffComplaintListQuery(
        page({ status: "all", keyword, pageSize: "100" }),
        false,
      ),
      undefined,
      SURFACE,
    );
    assert.equal(data.items.length, 0, `关键词不该能搜到${label}`);
  }

  const byType = await queryStaffComplaintList(
    await resolveStaffComplaintListQuery(page({ status: "all", type: "companion_service", pageSize: "100" }), false),
    undefined,
    SURFACE,
  );
  assert.ok(byType.items.length > 0);
  for (const item of byType.items) assert.equal(item.typeKey, "companion_service");
});

test("列表响应不含联系方式与其它隐私字段", async () => {
  const data = await queryStaffComplaintList(
    await resolveStaffComplaintListQuery(page({ status: "all", pageSize: "100" }), false),
    undefined,
    SURFACE,
  );
  assert.ok(data.items.length > 0);

  const serialized = JSON.stringify(data);
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  for (const forbidden of [
    sample.description.slice(0, 10),
    sample.contact,
    "/mock/evidence-placeholder.svg",
    '"contact"',
    '"description"',
    '"evidence"',
    '"result"',
    '"handledById"',
    '"handledByRole"',
    '"handledByName"',
    '"userId"',
    '"displayId"',
    "openId",
    "unionId",
    "cookie",
    "sessionId",
    "gameAccountId",
    "payCredential",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `列表 DTO 出现了 ${forbidden}`);
  }
});

test("详情：正文 / 凭证 / 联系方式只在详情出现，会话入口按既有会话给", async () => {
  const processing = await getStaffComplaintDetail(PROCESSING_COMPLAINT, undefined, SURFACE);
  assert.ok(processing);
  assert.ok(processing.description.length > 0);
  assert.ok(processing.contact.length > 0, "样本应当有联系方式");
  assert.ok(processing.evidence.length > 0, "样本应当有凭证");
  assert.deepEqual(processing.allowedActions, {
    canStartProcessing: false,
    canResolve: true,
    canClose: true,
  });

  // 预置投诉的关联订单（ord-seed-1001-10）没有预置会话：不给入口
  const pending = await getStaffComplaintDetail(PENDING_COMPLAINT, undefined, SURFACE);
  assert.ok(pending);
  assert.equal(pending.conversationOrderId, null);
  assert.ok(pending.orderSummary, "关联订单的摘要应当存在");

  // 有了既有会话之后，入口才出现（§八：只查不建会话，靠 ensureConversation 造好既有会话）
  await getMessageRepository().ensureConversation("u-1001", "ord-seed-1001-10", new Date().toISOString());
  const withConversation = await getStaffComplaintDetail(PENDING_COMPLAINT, undefined, SURFACE);
  assert.equal(withConversation.conversationOrderId, "ord-seed-1001-10");
});

test("详情：不关联订单是合法状态，不存在与空 id 都是 null", async () => {
  const closed = await getStaffComplaintDetail(CLOSED_COMPLAINT, undefined, SURFACE);
  assert.ok(closed);
  assert.equal(closed.orderId, null);
  assert.equal(closed.orderNo, null);
  assert.equal(closed.orderSummary, null);
  assert.equal(closed.conversationOrderId, null);
  assert.deepEqual(closed.allowedActions, {
    canStartProcessing: false,
    canResolve: false,
    canClose: false,
  });

  assert.equal(await getStaffComplaintDetail("cmp-nope", undefined, SURFACE), null);
  assert.equal(await getStaffComplaintDetail("", undefined, SURFACE), null);
});

test("详情响应不含订单内部字段与凭据，用户摘要没有平台 ID", async () => {
  const detail = await getStaffComplaintDetail(PROCESSING_COMPLAINT, undefined, SURFACE);
  assert.ok(detail);

  // 用户摘要仍是 {id, nickname, avatarUrl} 三件套
  assert.deepEqual(new Set(Object.keys(detail.user)), new Set(["id", "nickname", "avatarUrl"]));

  const serialized = JSON.stringify(detail);
  for (const forbidden of ["userId", "displayId", "gameAccountId", "remark", "payCredential", "openId", "unionId", "sessionId", "cookie"]) {
    assert.equal(serialized.includes(forbidden), false, `详情 DTO 不该出现 ${forbidden}`);
  }
});

// ——————————————————————————— 三、三个处理动作 ———————————————————————————

test("开始处理只改状态：不产生结论、不写处理人与完成时间，也不碰订单退款", async () => {
  const ordersBefore = await orderFingerprint();
  const refundsBefore = await refundFingerprint();

  const written = await startProcessingStaffComplaint(PENDING_COMPLAINT, await staffSessionOf(STAFF_A), {
    idempotencyKey: key(),
  });

  assert.equal(written.changed, true);
  assert.equal(written.status, "processing");
  assert.equal(written.statusLabel, "处理中");
  assert.equal(written.handledAt, null, "开始处理不是结论，不该有完成时间");

  const complaint = await complaintOf(PENDING_COMPLAINT);
  assert.equal(complaint.status, "processing");
  assert.ok(complaint.processingAt);
  assert.equal(complaint.result, "", "开始处理一个字的结论都不写");
  assert.equal(complaint.handledById, null, "开始处理不代表有人出了结论");
  assert.equal(complaint.handledByRole, null);

  assert.deepEqual(await orderFingerprint(), ordersBefore);
  assert.deepEqual(await refundFingerprint(), refundsBefore);
});

test("解决与关闭写的是同一个字段、两种问法，处理人来自客服会话而不是请求体", async () => {
  const staff = await staffSessionOf(STAFF_A);

  const resolved = await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: key(),
    result: "已核对记录，未发现重复扣款。",
  });
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.handledAt);

  const record = await complaintOf(PROCESSING_COMPLAINT);
  assert.equal(record.result, "已核对记录，未发现重复扣款。");
  assert.equal(record.handledById, "staff-1");
  assert.equal(record.handledByRole, "customer_service", "客服路径写入的处理人类型一定是客服");
  assert.equal(record.handledByName, "客服小雨（占位）");

  const closed = await closeStaffComplaint(PENDING_COMPLAINT, staff, {
    idempotencyKey: key(),
    result: "用户未补充信息，本次投诉先关闭。",
  });
  assert.equal(closed.status, "closed");
  assert.equal((await complaintOf(PENDING_COMPLAINT)).result, "用户未补充信息，本次投诉先关闭。");
});

test("结论必填：解决与关闭的空值文案不同，超长明确报错，失败不留审计", async () => {
  const staff = await staffSessionOf(STAFF_A);

  for (const blank of ["", "   ", "\n\t"]) {
    await expectApiError(
      resolveStaffComplaint(PROCESSING_COMPLAINT, staff, { idempotencyKey: key(), result: blank }),
      "BAD_REQUEST",
      STAFF_COMPLAINT_RESULT_EMPTY_MESSAGE,
    );
    await expectApiError(
      closeStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key(), result: blank }),
      "BAD_REQUEST",
      STAFF_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE,
    );
  }

  const tooLong = "x".repeat(STAFF_COMPLAINT_RESULT_MAX_LENGTH + 1);
  await expectApiError(
    resolveStaffComplaint(PROCESSING_COMPLAINT, staff, { idempotencyKey: key(), result: tooLong }),
    "BAD_REQUEST",
    STAFF_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  );
  await expectApiError(
    closeStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key(), result: tooLong }),
    "BAD_REQUEST",
    STAFF_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  );

  assert.equal(auditCount(), 0, "所有失败都不该留审计");
  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "pending");
});

test("非法迁移一律 400 且带上当前状态，不存在 404", async () => {
  const staff = await staffSessionOf(STAFF_A);

  for (const [id, statusLabel] of [
    [RESOLVED_COMPLAINT, "已处理"],
    [CLOSED_COMPLAINT, "已关闭"],
  ]) {
    for (const call of [
      () => startProcessingStaffComplaint(id, staff, { idempotencyKey: key() }),
      () => resolveStaffComplaint(id, staff, { idempotencyKey: key(), result: "结论" }),
      () => closeStaffComplaint(id, staff, { idempotencyKey: key(), result: "原因" }),
    ]) {
      await assert.rejects(call(), (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.ok(error.message.includes(statusLabel), `提示里要说清当前状态是「${statusLabel}」`);
        return true;
      });
    }
  }

  // 待处理不能直接解决——跳过「开始处理」会丢掉接手时间
  await assert.rejects(
    resolveStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key(), result: "结论" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.ok(error.message.includes("待处理"));
      return true;
    },
  );

  await expectApiError(
    startProcessingStaffComplaint(PROCESSING_COMPLAINT, staff, { idempotencyKey: key() }),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveStaffComplaint("cmp-nope", staff, { idempotencyKey: key(), result: "结论" }),
    "NOT_FOUND",
    STAFF_COMPLAINT_NOT_FOUND_MESSAGE,
  );

  assert.equal(auditCount(), 0);
});

test("缺少或格式不对的幂等键一律 400，且不留审计、不改状态", async () => {
  const staff = await staffSessionOf(STAFF_A);

  for (const bad of [undefined, "", "abc", "带空格的 key", "a".repeat(65), 12345]) {
    await expectApiError(
      startProcessingStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: bad }),
      "BAD_REQUEST",
      STAFF_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }
  assert.equal(auditCount(), 0);
  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "pending");
});

test("用户提交的正文、凭证与联系方式不可被覆盖，处理人身份字段一律被忽略", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const before = await complaintOf(PROCESSING_COMPLAINT);

  await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: key(),
    result: "这里是平台侧的处理结果。",
    // 客户端伪造：想改用户提交的内容，想改状态、处理人、投诉编号、订单，想冒充管理员
    description: "被篡改的正文",
    contact: "13800000000",
    evidence: [{ id: "fake", kind: "image", name: "fake.png", url: "https://evil.example/x.png" }],
    complaintNo: "TS-FAKE",
    status: "closed",
    orderId: "ord-nope",
    processingAt: "2000-01-01T00:00:00.000Z",
    handledById: "admin-1",
    handledByRole: "admin",
    handledByName: "伪造的处理人",
    handledAt: "2000-01-01T00:00:00.000Z",
    actorId: "admin-1",
    actorRole: "admin",
    actorName: "伪造",
  });

  const after = await complaintOf(PROCESSING_COMPLAINT);
  assert.equal(after.description, before.description, "用户写的正文不可被覆盖");
  assert.equal(after.contact, before.contact, "联系方式不可被覆盖");
  assert.deepEqual(after.evidence, before.evidence, "凭证不可被覆盖");
  assert.equal(after.complaintNo, before.complaintNo);
  assert.equal(after.orderId, before.orderId, "关联订单不可被改动");
  assert.equal(after.processingAt, before.processingAt);
  assert.equal(after.status, "resolved", "状态由状态机决定，不由请求体决定");
  assert.equal(after.handledById, "staff-1", "处理人来自服务端会话");
  assert.equal(after.handledByRole, "customer_service", "处理人类型也来自服务端会话");
  assert.equal(after.handledByName, "客服小雨（占位）");
  assert.notEqual(after.handledAt, "2000-01-01T00:00:00.000Z");
  assert.equal(after.result, "这里是平台侧的处理结果。");
});

test("处理投诉不改任何订单、不产生任何退款：三条路径都试一遍", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const ordersBefore = await orderFingerprint();
  const refundsBefore = await refundFingerprint();

  await startProcessingStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key() });
  await resolveStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key(), result: "已核实并记录，未做赔付。" });
  await closeStaffComplaint(PROCESSING_COMPLAINT, staff, { idempotencyKey: key(), result: "已与用户沟通清楚。" });

  assert.deepEqual(await orderFingerprint(), ordersBefore, "订单一个字都不该变");
  assert.deepEqual(await refundFingerprint(), refundsBefore, "不该多出任何退款申请");
});

// ——————————————————————————— 四、幂等与审计 ———————————————————————————

test("幂等：同一个键重复提交不迁移两次状态、不写第二条审计、不覆盖结论", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const operationId = key();

  const first = await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: operationId,
    result: "第一次结论",
  });
  assert.equal(first.changed, true);
  assert.equal(auditCount(), 1);

  const replay = await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: operationId,
    result: "第二次结论（不该生效）",
  });
  assert.equal(replay.status, "resolved");
  assert.equal(replay.changed, false, "重放不算改动");
  assert.equal(replay.handledAt, first.handledAt);
  assert.equal(auditCount(), 1, "重放不能再写审计");
  assert.equal((await complaintOf(PROCESSING_COMPLAINT)).result, "第一次结论");
});

test("幂等的意图绑定：同一个键先「开始处理」再「解决」，第二次必须报冲突而不是静默成功", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const operationId = key();

  const first = await startProcessingStaffComplaint(PENDING_COMPLAINT, staff, {
    idempotencyKey: operationId,
  });
  assert.equal(first.status, "processing");
  assert.equal(first.changed, true);
  assert.equal(auditCount(), 1);

  await expectApiError(
    resolveStaffComplaint(PENDING_COMPLAINT, staff, {
      idempotencyKey: operationId,
      result: "换了个意图，但复用了同一个键",
    }),
    "BAD_REQUEST",
    STAFF_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  );

  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "processing", "状态不该被这次请求改变");
  assert.equal(auditCount(), 1, "被拒的请求不写审计");
});

test("幂等键被另一条投诉或另一位客服占用时报冲突，而不是安静重放", async () => {
  const operationId = key();
  await resolveStaffComplaint(PROCESSING_COMPLAINT, await staffSessionOf(STAFF_A), {
    idempotencyKey: operationId,
    result: "甲条投诉的结论",
  });

  // 同一键、另一条投诉
  await expectApiError(
    closeStaffComplaint(PENDING_COMPLAINT, await staffSessionOf(STAFF_A), {
      idempotencyKey: operationId,
      result: "乙条投诉的关闭说明",
    }),
    "BAD_REQUEST",
    STAFF_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  );

  // 同一键、另一位客服
  await expectApiError(
    resolveStaffComplaint(PROCESSING_COMPLAINT, await staffSessionOf(STAFF_B), {
      idempotencyKey: operationId,
      result: "另一位客服的结论",
    }),
    "BAD_REQUEST",
    STAFF_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  );

  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "pending", "冲突不该改动目标");
  assert.equal(auditCount(), 1);
});

test("审计恰好一次，操作者与动作正确，且不留档正文 / 联系方式 / 凭证地址", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  assert.ok(sample.contact.length > 0, "样本应当有联系方式，这条断言才有意义");
  assert.ok(sample.evidence.length > 0, "样本应当有凭证");

  await startProcessingStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key() });
  await closeStaffComplaint(PENDING_COMPLAINT, staff, { idempotencyKey: key(), result: "已核实并给出答复。" });
  await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, { idempotencyKey: key(), result: "已核对记录。" });

  const pendingEntries = auditsFor(PENDING_COMPLAINT);
  assert.equal(pendingEntries.length, 2);
  assert.deepEqual(
    pendingEntries.map((entry) => entry.action),
    ["complaint.start-processing", "complaint.close"],
  );
  for (const entry of pendingEntries) {
    assert.equal(entry.actorId, "staff-1");
    assert.equal(entry.actorRole, "customer_service");
    assert.equal(entry.actorName, "客服小雨（占位）");
    assert.equal(entry.targetType, "complaint");
  }

  const serialized = JSON.stringify([...adminAuditStore().audits.values()]);
  for (const forbidden of [
    sample.description.slice(0, 10),
    sample.contact,
    "/mock/evidence-placeholder.svg",
    "openId",
    "unionId",
    "cookie",
    "sessionId",
    "gameAccountId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `审计里出现了不该留档的内容：${forbidden}`);
  }
});

// ——————————————————————————— 五、重放的客户端文案（协调补充四） ———————————————————————————

test("changed:false 不能翻译成「已解决」：重放文案与成功文案必须分开", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const operationId = key();

  const first = await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: operationId,
    result: "第一次结论",
  });
  assert.equal(first.changed, true);

  const replay = await resolveStaffComplaint(PROCESSING_COMPLAINT, staff, {
    idempotencyKey: operationId,
    result: "重试",
  });
  assert.equal(replay.changed, false, "重放必须携带 changed:false，页面据此决定文案");

  // 文案层面：重放不能是「已解决」那类成功话术
  assert.notEqual(STAFF_COMPLAINT_REPLAY_NOTICE, STAFF_COMPLAINT_SUCCESS_MESSAGES.resolve);
  assert.notEqual(STAFF_COMPLAINT_REPLAY_NOTICE, STAFF_COMPLAINT_SUCCESS_MESSAGES.close);
  assert.notEqual(STAFF_COMPLAINT_REPLAY_NOTICE, STAFF_COMPLAINT_SUCCESS_MESSAGES.startProcessing);
  assert.ok(STAFF_COMPLAINT_REPLAY_NOTICE.includes("已经"), "重放文案要说清是「处理过了」");
  assert.ok(STAFF_COMPLAINT_SUCCESS_MESSAGES.resolve.includes("已解决"), "只有成功文案才是「已解决」");

  // 结构层面：console 组件按 `written.changed` 在成功文案与重放文案之间二选一
  const source = stripComments(readSource(path.join(ROOT, "components", "staff", "StaffComplaintConsole.tsx")));
  const anchor = source.indexOf("written.changed");
  assert.notEqual(anchor, -1, "console 组件必须读 written.changed 来决定文案");
  const window = source.slice(anchor, anchor + 300);
  const successAt = window.indexOf("STAFF_COMPLAINT_SUCCESS_MESSAGES");
  const replayAt = window.indexOf("STAFF_COMPLAINT_REPLAY_NOTICE");
  assert.notEqual(successAt, -1, "真分支要用成功文案");
  assert.notEqual(replayAt, -1, "假分支要用重放文案");
  assert.ok(successAt < replayAt, "changed 为真时用成功文案，为假时用重放文案");
});

// ——————————————————————————— 六、源码门禁 ———————————————————————————

test("五个投诉接口都先过 requireStaff、强制动态渲染、不出现其它身份守卫", () => {
  const routeFiles = [
    "app/api/staff/complaints/route.ts",
    "app/api/staff/complaints/[id]/route.ts",
    "app/api/staff/complaints/[id]/start-processing/route.ts",
    "app/api/staff/complaints/[id]/resolve/route.ts",
    "app/api/staff/complaints/[id]/close/route.ts",
  ];

  for (const relative of routeFiles) {
    const source = stripComments(readSource(path.join(ROOT, relative)));
    assert.equal(source.includes('export const dynamic = "force-dynamic"'), true, `${relative} 缺少 force-dynamic`);

    for (const forbidden of ["requireAdmin", "requireUser", "getSessionUser", "getSessionAdmin", "mock_user_id", "mock_admin_id"]) {
      assert.equal(source.includes(forbidden), false, `${relative} 不该出现 ${forbidden}`);
    }

    // 第一件事是 requireStaff()，读请求体必须排在它之后
    const body = withoutImports(source);
    const guard = body.indexOf("requireStaff");
    assert.notEqual(guard, -1, `${relative} 缺少客服身份守卫`);
    const readsBody = body.indexOf("readJsonBody");
    if (readsBody !== -1) {
      assert.ok(guard < readsBody, `${relative} 的身份守卫必须是第一步`);
    }
  }
});

test("服务层直接走既有投诉事务、复用管理端结果校验，不自造身份", () => {
  const source = stripComments(readSource(path.join(ROOT, "lib", "services", "staffComplaints.ts")));

  assert.ok(source.includes("applyAdminComplaintIntent("), "写操作必须直接调用既有事务");
  assert.ok(source.includes("normalizeAdminComplaintResult("), "结果校验必须复用管理端函数");
  assert.ok(source.includes("@/lib/constants/adminComplaints"), "校验函数必须从 adminComplaints 导入");
  assert.equal(source.includes("getMessageRepository().findConversationForStaff"), true, "会话入口必须走 findConversationForStaff");
  assert.equal(source.includes("ensureConversation"), false, "客服绝不能创建会话");

  for (const forbidden of ["requireAdmin", "requireUser", "getSessionUser", "getSessionAdmin", "mock_user_id", "mock_admin_id"]) {
    assert.equal(source.includes(forbidden), false, `服务层不该出现 ${forbidden}`);
  }
});

test("投诉页面与组件不含 Mock 直连、管理端调用、HTML 注入与 /admin 链接，列表不按状态写 if", () => {
  const staffFiles = [
    "app/staff/(console)/complaints/(list)/page.tsx",
    "app/staff/(console)/complaints/[id]/page.tsx",
    "app/staff/(console)/complaints/[id]/not-found.tsx",
    "components/staff/StaffComplaintConsole.tsx",
    "components/staff/StaffComplaintTable.tsx",
  ];

  for (const relative of staffFiles) {
    const source = stripComments(readSource(path.join(ROOT, relative)));
    for (const forbidden of ["lib/mocks", "services/adminHttp", "api/admin", "dangerouslySetInnerHTML"]) {
      assert.equal(source.includes(forbidden), false, `${relative} 不该出现 ${forbidden}`);
    }
  }

  for (const relative of [
    "app/staff/(console)/complaints/(list)/page.tsx",
    "app/staff/(console)/complaints/[id]/page.tsx",
  ]) {
    const source = stripComments(readSource(path.join(ROOT, relative)));
    assert.equal(source.includes('href="/admin'), false, `${relative} 不该有指向管理后台的入口`);
  }

  // 列表操作列用统一「查看详情」，不拿状态自己写分支：能不能处理由详情页服务端 allowedActions 决定
  const table = stripComments(readSource(path.join(ROOT, "components", "staff", "StaffComplaintTable.tsx")));
  assert.equal(table.includes('if (status === "pending")'), false, "列表不该按状态写 if");
  assert.equal(table.includes("查看详情"), true, "操作列必须是统一的「查看详情」");
  assert.equal(table.includes("fetchStaffComplaints"), true, "列表必须走自己的 HTTP 取数器");
});

// ——————————————————————————— 七、HTTP（需要真实服务） ———————————————————————————

async function requestWithCookie(pathname, cookie, init) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  return { status: response.status, body: await response.text(), response };
}

async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

/** 带 Cookie 的 POST，返回真实状态码与解析后的 JSON。 */
async function postJson(pathname, cookie, payload) {
  const response = await fetch(new URL(pathname, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应（如网关错误页）留空
  }
  return { status: response.status, json };
}

test("身份矩阵：匿名/用户/管理员/伪造客服 Cookie 一律 401，护航/停用/已移除 403", { skip: SKIP_HTTP }, async () => {
  // 匿名与另外两类身份 Cookie 永远是 401——与客服端开关无关
  assert.equal((await requestWithCookie("/api/staff/complaints", null)).status, 401);
  assert.equal((await requestWithCookie("/api/staff/complaints", "mock_user_id=u-1001")).status, 401);
  assert.equal((await requestWithCookie("/api/staff/complaints", "mock_admin_id=admin-1")).status, 401);

  // 伪造客服 Cookie：把另外两类的 id、或一个不存在的 id 塞进 mock_staff_id，都查不到账号 → 401
  for (const forged of ["mock_staff_id=u-1001", "mock_staff_id=admin-1", "mock_staff_id=staff-999"]) {
    assert.equal((await requestWithCookie("/api/staff/complaints", forged)).status, 401, `${forged} 不该通过`);
  }

  const login = await staffLogin("staff-1");
  if (login.status !== 200) {
    // 开关关闭：连真实客服 id 的伪造 Cookie 也进不来
    assert.equal(login.status, 404);
    assert.equal((await requestWithCookie("/api/staff/complaints", "mock_staff_id=staff-1")).status, 401);
    return;
  }

  const staffCookie = login.setCookie[0].split(";")[0];
  const ok = await requestWithCookie("/api/staff/complaints?pageSize=100", staffCookie);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes('"items"'));

  // 护航 / 停用 / 已移除：记录查得到但进不来，与订单不存在同体的 403
  for (const id of ["staff-3", "staff-4", "staff-5"]) {
    const rejected = await requestWithCookie("/api/staff/complaints", `mock_staff_id=${id}`);
    assert.equal(rejected.status, 403, `${id} 不该通过`);
  }
});

test("HTTP 响应体无敏感字段：列表无联系方式，详情才有", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const staffCookie = login.setCookie[0].split(";")[0];

  const list = await requestWithCookie("/api/staff/complaints?pageSize=100", staffCookie);
  assert.equal(list.status, 200);
  for (const forbidden of ['"contact"', '"description"', '"evidence"', '"result"', '"handledById"', '"handledByRole"', '"handledByName"', '"userId"', '"displayId"', "openId", "unionId", "sessionId", "cookie", "gameAccountId", "payCredential"]) {
    assert.equal(list.body.includes(forbidden), false, `列表响应不该出现 ${forbidden}`);
  }

  // 详情（用有联系方式的 cmp-seed-1001-02，只读不写）
  const detail = await requestWithCookie("/api/staff/complaints/cmp-seed-1001-02", staffCookie);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.includes('"contact"'), true, "联系方式只在详情出现");
  for (const forbidden of ["openId", "unionId", "sessionId", "cookie", "gameAccountId", "payCredential", '"userId"', '"displayId"']) {
    assert.equal(detail.body.includes(forbidden), false, `详情响应不该出现 ${forbidden}`);
  }
});

test("HTTP 写：合法迁移 200、非法迁移 400、同键重放只有一个结果、跨意图同键冲突", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const staffCookie = login.setCookie[0].split(";")[0];

  const detail = await requestWithCookie("/api/staff/complaints/cmp-seed-1001-01", staffCookie);
  assert.equal(detail.status, 200);
  const current = JSON.parse(detail.body).data;
  const status = current.status;

  if (status === "pending") {
    const k1 = key();
    // 1. 合法迁移成功
    const start = await postJson("/api/staff/complaints/cmp-seed-1001-01/start-processing", staffCookie, { idempotencyKey: k1 });
    assert.equal(start.status, 200);
    assert.equal(start.json.data.changed, true);
    assert.equal(start.json.data.status, "processing");

    // 2. 同一个键、同一个意图重放：只有一个结果，changed:false
    const replay = await postJson("/api/staff/complaints/cmp-seed-1001-01/start-processing", staffCookie, { idempotencyKey: k1 });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.changed, false, "同意图重放必须 changed:false");
    assert.equal(replay.json.data.status, "processing");

    // 3. 同一个键换一个意图（开始处理 → 解决）：必须 400，不能静默成功
    const cross = await postJson("/api/staff/complaints/cmp-seed-1001-01/resolve", staffCookie, { idempotencyKey: k1, result: "换意图" });
    assert.equal(cross.status, 400);
    assert.equal(cross.json.error.code, "BAD_REQUEST");

    // 4. 非法迁移：已经是处理中，再开始处理必须 400
    const illegal = await postJson("/api/staff/complaints/cmp-seed-1001-01/start-processing", staffCookie, { idempotencyKey: key() });
    assert.equal(illegal.status, 400);
    assert.equal(illegal.json.error.code, "BAD_REQUEST");
    return;
  }

  if (status === "processing") {
    const k1 = key();
    const resolve = await postJson("/api/staff/complaints/cmp-seed-1001-01/resolve", staffCookie, { idempotencyKey: k1, result: "已核实并给出答复。" });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.json.data.changed, true);
    assert.equal(resolve.json.data.status, "resolved");

    const replay = await postJson("/api/staff/complaints/cmp-seed-1001-01/resolve", staffCookie, { idempotencyKey: k1, result: "重试" });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.changed, false);

    const cross = await postJson("/api/staff/complaints/cmp-seed-1001-01/close", staffCookie, { idempotencyKey: k1, result: "换意图" });
    assert.equal(cross.status, 400);

    const illegal = await postJson("/api/staff/complaints/cmp-seed-1001-01/start-processing", staffCookie, { idempotencyKey: key() });
    assert.equal(illegal.status, 400);
    return;
  }

  // 终态（resolved / closed）：三个动作全部非法，真实状态码 400，绝不 200
  for (const action of ["start-processing", "resolve", "close"]) {
    const result = await postJson(
      `/api/staff/complaints/cmp-seed-1001-01/${action}`,
      staffCookie,
      { idempotencyKey: key(), result: "x" },
    );
    assert.equal(result.status, 400, `终态下 ${action} 必须 400`);
  }
});
