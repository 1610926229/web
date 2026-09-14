import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { findAppFile } from "./app-path.mjs";

import {
  ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
} from "../lib/constants/adminRefunds.ts";
import {
  DEFAULT_STAFF_REFUND_STATUS_FILTER,
  STAFF_REFUND_ACTION_LABELS,
  STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  STAFF_REFUND_OPERATION_CONFLICT_MESSAGE,
  compareStaffRefunds,
  readStaffRefundStatusFilter,
  staffRefundAllowedActions,
  staffRefundMatchesKeyword,
} from "../lib/constants/staffRefunds.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { staffSeed } from "../lib/mocks/fixtures/staffSeed.ts";
import { approveAdminRefund } from "../lib/services/adminRefunds.ts";
import {
  getStaffRefundDetail,
  listStaffRefunds,
  rejectStaffRefund,
  resolveStaffRefundListQuery,
  startReviewStaffRefund,
} from "../lib/services/staffRefunds.ts";

/**
 * 客服工作台「退款处理」（P8D-2 Agent A）的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 退款 / 支付 / 审计仓储 + 真实的伪事务 +
 * 真实的 `lib/services/staffRefunds.ts`。因此「客服只有两个动作、金额不可改、
 * 开始审核与驳回都只改退款申请、幂等与审计恰好一次、审计记客服身份快照」这些规则
 * 每次提交都会被重新验证。
 *
 * 覆盖重点：
 *
 * 1. **客服只有两个动作**：开始审核（pending → reviewing）与驳回（pending | reviewing → rejected），
 *    `StaffRefundAllowedActions` 里**没有** `canApprove`，按钮文案里**没有**「通过」；
 * 2. **两个动作都只改退款申请**：订单状态、金额、用户消费一个都不动；
 * 3. **审核人三件套来自客服会话**：`reviewedBy` = 客服 id、`reviewedByRole` = `customer_service`、
 *    `reviewedByName` = 客服显示名快照（不是 null）——驳回之后用户端要显示得出谁批的；
 * 4. **幂等按「操作者 × 目标 × 意图」收窄**：同键重复同一意图是重放（不写第二条审计），
 *    同键换意图 / 换对象 / 换操作者（客服驳了管理员再来通过）一律 400 冲突；
 * 5. **列表与详情的字段边界**：没有 userId / gameAccountId / remark / OpenID / UnionID /
 *    支付凭据；详情给服务端判定的 `allowedActions` 与 §八 的会话入口；
 * 6. **源码门禁**：四个接口第一件事都是 `requireStaff()`，没有 approve 地址。
 *
 * 需要真实服务的断言（HTTP 状态码与 Cookie 行为）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `tests/staff.test.mjs` 同一套做法。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF_REFUND_API_DIR = path.join(ROOT, "app", "api", "staff", "refunds");

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过客服退款 HTTP 用例";

/** 客服会话守卫返回的会话里，写操作真正会读的两样：id 与显示名快照。 */
const STAFF_A = "staff-1";
const STAFF_A_NAME = "客服小雨（占位）";

/** 待审核、订单处于「已接单」的预置退款 */
const PENDING_REFUND = "rf-seed-1001-01";
/** 审核中、订单处于「护航中」的预置退款 */
const REVIEWING_REFUND = "rf-seed-1001-02";
/** 已通过（终态），订单 ord-seed-1001-06 **没有会话** */
const APPROVED_REFUND = "rf-seed-1001-03";
/** 已拒绝（终态） */
const REJECTED_REFUND = "rf-seed-1001-04";
/** 已撤销（终态） */
const CANCELLED_REFUND = "rf-seed-1001-05";
/** HTTP 写用例专用：老板B 的待审核退款（避免污染老板A 的那几条） */
const HTTP_TARGET = "rf-seed-1002-01";

function key() {
  return crypto.randomUUID();
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(file) {
  return readFileSync(file, "utf8");
}

function withoutImports(source) {
  return source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
}

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

/** 守卫返回的会话对象里，客服写操作只读这两样（真实链路来自 `requireStaff()` 的返回值）。 */
function staffOf(staffId) {
  const account = staffSeed.find((item) => item.id === staffId);
  assert.ok(account, `预置客服账号缺失：${staffId}`);
  return { id: account.id, displayName: account.displayName };
}

async function refundOf(id) {
  return getRefundRepository().findRefundById(id);
}

async function orderOf(id) {
  const refund = await refundOf(id);
  return getPaymentRepository().findOrderById(refund.orderId);
}

async function auditCount() {
  return adminAuditStore().audits.size;
}

async function auditsFor(targetId) {
  return [...adminAuditStore().audits.values()].filter((entry) => entry.targetId === targetId);
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
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

async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

function postJson(pathname, cookie, body) {
  return fetch(new URL(pathname, BASE), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

/**
 * 每个用例开始前重建三个 store。退款要干净（写操作真的改它），审计要**空**——
 * 「恰好一次」只有在从零开始时才数得清。订单重建是因为读侧依赖订单快照，
 * 与 `adminRefunds.test.mjs` 同一理由（客服不写订单，重建只是保证起点一致）。
 */
beforeEach(() => {
  resetMockStore("refund");
  resetMockStore("adminAudit");
  resetMockStore("payment");
});

// ——————————————————————————— 一、客服的可执行动作 ———————————————————————————

test("客服可执行动作：只有开始审核与驳回，没有 canApprove（按钮不存在）", () => {
  assert.deepEqual(staffRefundAllowedActions("pending"), { canStartReview: true, canReject: true });
  assert.deepEqual(staffRefundAllowedActions("reviewing"), { canStartReview: false, canReject: true });
  for (const terminal of ["approved", "rejected", "cancelled"]) {
    assert.deepEqual(
      staffRefundAllowedActions(terminal),
      { canStartReview: false, canReject: false },
      `${terminal} 不该有可执行动作`,
    );
  }

  // 一个恒为 false 的布尔值会被前端写成「禁用按钮」，正确做法是字段根本不存在
  assert.equal("canApprove" in staffRefundAllowedActions("pending"), false, "不允许出现 canApprove");

  // 按钮文案里同样没有「通过」
  assert.deepEqual(Object.keys(STAFF_REFUND_ACTION_LABELS).sort(), ["reject", "startReview"]);
});

// ——————————————————————————— 二、状态筛选 ———————————————————————————

test("状态筛选解析：合法值通过，非法值在接口 400、在页面回退默认", () => {
  assert.equal(readStaffRefundStatusFilter(null), DEFAULT_STAFF_REFUND_STATUS_FILTER);
  assert.equal(readStaffRefundStatusFilter("  "), DEFAULT_STAFF_REFUND_STATUS_FILTER);
  assert.equal(readStaffRefundStatusFilter("reviewing"), "reviewing");
  assert.equal(readStaffRefundStatusFilter("假的"), null, "非法值返回 null，由调用方决定 400 还是回退");

  assert.throws(() => resolveStaffRefundListQuery(page({ status: "假的" }), true));
  assert.equal(resolveStaffRefundListQuery(page({ status: "假的" }), false).status, "pending");

  // 默认筛选是「待审核」：这个页面的用途是处理待办
  const defaults = resolveStaffRefundListQuery(page(), false);
  assert.equal(defaults.status, "pending");
  assert.equal(defaults.keyword, "");
  assert.equal(defaults.page, 1);
});

// ——————————————————————————— 三、列表 ———————————————————————————

test("列表：默认只看待审核，按申请时间倒序，排序稳定", async () => {
  const pending = await listStaffRefunds(resolveStaffRefundListQuery(page(), false), undefined, "server");
  assert.equal(pending.total, 2);
  assert.equal(pending.items.every((item) => item.status === "pending"), true);
  for (let index = 1; index < pending.items.length; index += 1) {
    assert.ok(compareStaffRefunds(pending.items[index - 1], pending.items[index]) <= 0);
  }

  const all = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all" }), false),
    undefined,
    "server",
  );
  assert.equal(all.total, 6);

  // 稳定排序：同样的查询跑两次，顺序完全一致
  const again = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all" }), false),
    undefined,
    "server",
  );
  assert.deepEqual(all.items.map((item) => item.id), again.items.map((item) => item.id));
});

test("列表：搜索退款单号 / 订单号 / 用户昵称，不搜退款说明", async () => {
  const refund = await refundOf(PENDING_REFUND);
  const detail = await getStaffRefundDetail(PENDING_REFUND, undefined, "server");

  for (const keyword of [refund.refundNo, detail.orderNo, detail.user.nickname]) {
    const data = await listStaffRefunds(
      resolveStaffRefundListQuery(page({ status: "all", keyword }), false),
      undefined,
      "server",
    );
    assert.ok(data.items.some((item) => item.id === PENDING_REFUND), `按「${keyword}」没搜到`);
  }

  // 大小写不敏感（订单号里带字母）
  const lower = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all", keyword: detail.orderNo.toLowerCase() }), false),
    undefined,
    "server",
  );
  assert.ok(lower.items.some((item) => item.id === PENDING_REFUND));

  // 退款说明是内容不是标识：用它搜不出来，否则等于给了一个探测入口
  const byDescription = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all", keyword: refund.description.slice(0, 10) }), false),
    undefined,
    "server",
  );
  assert.equal(byDescription.items.length, 0);

  // 匹配函数本身：三处任一命中即可
  assert.equal(staffRefundMatchesKeyword({ refundNo: "RF1", orderNo: "ORD1", nickname: "老板A" }, "ord1"), true);
  assert.equal(staffRefundMatchesKeyword({ refundNo: "RF1", orderNo: "ORD1", nickname: "老板A" }, "zzz"), false);
});

test("列表：分页不重不漏，total 不随页变", async () => {
  const all = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all" }), false),
    undefined,
    "server",
  );

  const seen = [];
  for (const pageNumber of [1, 2, 3]) {
    const result = await listStaffRefunds(
      resolveStaffRefundListQuery(page({ status: "all", page: pageNumber, pageSize: 2 }), false),
      undefined,
      "server",
    );
    assert.equal(result.pageSize, 2);
    assert.equal(result.total, all.total);
    assert.equal(result.hasMore, pageNumber * 2 < all.total);
    assert.ok(result.items.length <= 2);
    seen.push(...result.items.map((item) => item.id));
  }

  assert.equal(new Set(seen).size, seen.length, "同一条退款不能在两页里各出现一次");
  assert.deepEqual([...seen].sort(), all.items.map((item) => item.id).sort());
});

test("列表 DTO 只有摘要：没有原因 / 说明 / 凭证 / 审核意见 / 身份标识", async () => {
  const data = await listStaffRefunds(
    resolveStaffRefundListQuery(page({ status: "all" }), false),
    undefined,
    "server",
  );
  assert.ok(data.items.length > 0);

  const allowed = new Set([
    "id",
    "refundNo",
    "status",
    "statusLabel",
    "amount",
    "createdAt",
    "updatedAt",
    "user",
    "orderId",
    "orderNo",
    "orderStatus",
    "orderStatusLabel",
    "productTitle",
  ]);

  for (const item of data.items) {
    assert.deepEqual(new Set(Object.keys(item)), allowed, "列表项字段集合变了");
    // 客服端用户摘要只有三样：id / 昵称 / 头像，**没有**平台展示 ID
    assert.deepEqual(new Set(Object.keys(item.user)), new Set(["id", "nickname", "avatarUrl"]));
  }

  const serialized = JSON.stringify(data);
  const seed = await refundOf(PENDING_REFUND);
  for (const forbidden of [
    seed.description.slice(0, 10),
    "evidence",
    "reviewNote",
    "reasonKey",
    "reasonLabel",
    "reviewingAt",
    "reviewedAt",
    "reviewedBy",
    "reviewedByRole",
    "reviewedByName",
    "cancelledAt",
    "/mock/evidence-placeholder.svg",
    "userId",
    "displayId",
    "gameAccountId",
    "remark",
    "openId",
    "unionId",
    "cookie",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `列表 DTO 出现了 ${forbidden}`);
  }
});

// ——————————————————————————— 四、详情 ———————————————————————————

test("详情：补齐原因 / 说明 / 凭证 / 金额对照 / 审核信息 / 时间轴，动作由服务端判定", async () => {
  const detail = await getStaffRefundDetail(PENDING_REFUND, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.status, "pending");
  assert.ok(detail.description.length > 0, "详情必须给出用户写的说明");
  assert.ok(detail.reasonLabel.length > 0);
  assert.deepEqual(detail.allowedActions, { canStartReview: true, canReject: true });
  assert.equal(detail.timeline[0].key, "pending");

  const order = await orderOf(PENDING_REFUND);
  assert.equal(detail.amount, order.totalAmount, "退款金额取申请创建时的订单实付快照");
  assert.equal(detail.orderTotalAmount, order.totalAmount);
  assert.equal(detail.orderStatus, order.status);

  const cancelled = await getStaffRefundDetail(CANCELLED_REFUND, undefined, "server");
  assert.ok(cancelled);
  assert.deepEqual(cancelled.allowedActions, { canStartReview: false, canReject: false });

  assert.equal(await getStaffRefundDetail("rf-nope", undefined, "server"), null);
  assert.equal(await getStaffRefundDetail("", undefined, "server"), null);
});

test("客服端时间轴：开始审核 / 驳回是「客服」的动作，撤销是「用户」自己", async () => {
  const reviewing = await getStaffRefundDetail(REVIEWING_REFUND, undefined, "server");
  assert.ok(reviewing.timeline.some((entry) => entry.note.includes("客服已开始审核")));

  const cancelled = await getStaffRefundDetail(CANCELLED_REFUND, undefined, "server");
  assert.ok(cancelled.timeline.some((entry) => entry.note.includes("用户自己撤销")));

  const rejected = await getStaffRefundDetail(REJECTED_REFUND, undefined, "server");
  assert.ok(rejected.timeline.some((entry) => entry.key === "rejected"));
});

test("详情：§八 会话入口——有会话给 orderId，没有会话给 null", async () => {
  // ord-seed-1001-03 有会话：给真实入口
  const withConversation = await getStaffRefundDetail(PENDING_REFUND, undefined, "server");
  assert.equal(withConversation.conversationOrderId, "ord-seed-1001-03");

  // ord-seed-1001-06 没有会话：入口为 null，页面不给会 404 的链接
  const withoutConversation = await getStaffRefundDetail(APPROVED_REFUND, undefined, "server");
  assert.equal(withoutConversation.conversationOrderId, null);
});

test("详情 DTO 不含 userId / gameAccountId / remark / OpenID / UnionID / 支付凭据", async () => {
  const detail = await getStaffRefundDetail(PENDING_REFUND, undefined, "server");
  const serialized = JSON.stringify(detail);
  for (const forbidden of [
    "userId",
    "gameAccountId",
    "remark",
    "openId",
    "unionId",
    "sessionId",
    "cookie",
    "payCredential",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `详情 DTO 出现了 ${forbidden}`);
  }
});

// ——————————————————————————— 五、开始审核 ———————————————————————————

test("开始审核只改退款申请：订单与金额不动，不写审核人与审核意见", async () => {
  const before = await orderOf(PENDING_REFUND);

  const result = await startReviewStaffRefund(PENDING_REFUND, staffOf(STAFF_A), { idempotencyKey: key() });
  assert.equal(result.status, "reviewing");
  assert.equal(result.changed, true);

  const refund = await refundOf(PENDING_REFUND);
  assert.equal(refund.status, "reviewing");
  assert.ok(refund.reviewingAt, "开始审核要记下开始时间");
  assert.equal(refund.reviewedAt, null, "开始审核不是结论，不该有完成时间");
  assert.equal(refund.reviewedBy, null, "开始审核不产生审核人——谁开始看的由审计回答");
  assert.equal(refund.reviewedByRole, null);
  assert.equal(refund.reviewNote, "", "开始审核不写审核意见");

  assert.deepEqual(await orderOf(PENDING_REFUND), before, "订单必须一字未改");
});

// ——————————————————————————— 六、驳回 ———————————————————————————

test("驳回必须填写审核意见：空 / 空白 / 超长都是 400，上限内可过", async () => {
  const staff = staffOf(STAFF_A);
  for (const note of ["", "   ", "\n\t", "x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH + 1)]) {
    await assert.rejects(
      rejectStaffRefund(PENDING_REFUND, staff, { idempotencyKey: key(), reviewNote: note }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }

  const ok = await rejectStaffRefund(PENDING_REFUND, staff, {
    idempotencyKey: key(),
    reviewNote: "x".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH),
  });
  assert.equal(ok.status, "rejected");
});

test("驳回：pending 或 reviewing 都能驳，只改退款申请，审核人三件套来自客服会话", async () => {
  const staff = staffOf(STAFF_A);
  const before = await orderOf(REVIEWING_REFUND);

  const result = await rejectStaffRefund(REVIEWING_REFUND, staff, {
    idempotencyKey: key(),
    reviewNote: "已核对服务记录，本次申请不符合同意条件。",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.changed, true);

  const refund = await refundOf(REVIEWING_REFUND);
  assert.equal(refund.reviewNote, "已核对服务记录，本次申请不符合同意条件。");
  assert.ok(refund.reviewedAt);
  assert.equal(refund.reviewedBy, "staff-1", "审核人来自客服会话");
  assert.equal(refund.reviewedByRole, "customer_service");
  assert.equal(refund.reviewedByName, STAFF_A_NAME, "客服驳回必须留显示名快照，不是 null");

  assert.deepEqual(await orderOf(REVIEWING_REFUND), before, "驳回不改订单");

  // 待审核也能直接驳回（不强制先开始审核）
  const direct = await rejectStaffRefund(PENDING_REFUND, staff, {
    idempotencyKey: key(),
    reviewNote: "不同意",
  });
  assert.equal(direct.status, "rejected");
});

// ——————————————————————————— 七、非法迁移与 404 ———————————————————————————

test("非法迁移 400 并带上当前状态；不存在 404", async () => {
  const staff = staffOf(STAFF_A);

  for (const [id, label] of [
    [APPROVED_REFUND, "已通过"],
    [REJECTED_REFUND, "已拒绝"],
    [CANCELLED_REFUND, "已撤销"],
  ]) {
    for (const call of [
      () => startReviewStaffRefund(id, staff, { idempotencyKey: key() }),
      () => rejectStaffRefund(id, staff, { idempotencyKey: key(), reviewNote: "不行" }),
    ]) {
      await assert.rejects(call(), (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.ok(error.message.includes(label), `提示里要带上当前状态「${label}」`);
        return true;
      });
    }
  }

  // 审核中不能回到待审核（没有这个迁移）
  await expectApiError(startReviewStaffRefund(REVIEWING_REFUND, staff, { idempotencyKey: key() }), "BAD_REQUEST");

  await expectApiError(startReviewStaffRefund("rf-nope", staff, { idempotencyKey: key() }), "NOT_FOUND");
  await expectApiError(startReviewStaffRefund("", staff, { idempotencyKey: key() }), "NOT_FOUND");
});

// ——————————————————————————— 八、幂等与审计 ———————————————————————————

test("幂等：同一个键重复驳回只产生一次迁移与一条审计", async () => {
  const staff = staffOf(STAFF_A);
  const operationId = key();

  const first = await rejectStaffRefund(PENDING_REFUND, staff, {
    idempotencyKey: operationId,
    reviewNote: "第一次驳回",
  });
  assert.equal(first.changed, true);
  assert.equal(await auditCount(), 1);

  const replay = await rejectStaffRefund(PENDING_REFUND, staff, {
    idempotencyKey: operationId,
    reviewNote: "第二次提交（同一意图，应当被判为重放）",
  });
  assert.equal(replay.status, "rejected");
  assert.equal(replay.changed, false, "同一意图的重复提交仍然是重放");
  assert.equal(replay.reviewedAt, first.reviewedAt, "重放返回的是第一次的结果");
  assert.equal(await auditCount(), 1, "重放不写第二条审计");
  assert.equal((await refundOf(PENDING_REFUND)).reviewNote, "第一次驳回", "重放不改写字段");
});

test("并发同键只写一条：抢在同一个瞬间的两份请求不会各写一条", async () => {
  const staff = staffOf(STAFF_A);
  const operationId = key();

  const results = await Promise.all([
    startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: operationId }),
    startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: operationId }),
  ]);

  assert.equal(results.filter((result) => result.changed).length, 1, "只允许一次真正写入");
  assert.equal(await auditCount(), 1, "审计恰好一条");
  assert.equal((await refundOf(PENDING_REFUND)).status, "reviewing");
});

test("幂等键被另一个对象用过：报 400 而不是安静重放别人的结果", async () => {
  const staff = staffOf(STAFF_A);
  const operationId = key();
  await startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: operationId });

  await expectApiError(
    startReviewStaffRefund(REVIEWING_REFUND, staff, { idempotencyKey: operationId }),
    "BAD_REQUEST",
    STAFF_REFUND_OPERATION_CONFLICT_MESSAGE,
  );

  // 被冲突的这一次没有改到 REVIEWING_REFUND
  assert.equal((await refundOf(REVIEWING_REFUND)).status, "reviewing");
});

test("意图绑定：同一个键先「开始审核」再「驳回」，第二次必须 400 而不是静默成功", async () => {
  const staff = staffOf(STAFF_A);
  const operationId = key();

  const first = await startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: operationId });
  assert.equal(first.status, "reviewing");
  assert.equal(first.changed, true);
  assert.equal(await auditCount(), 1);

  // 同一个键、同一个目标、同一位客服，但意图不同 → 冲突
  await expectApiError(
    rejectStaffRefund(PENDING_REFUND, staff, {
      idempotencyKey: operationId,
      reviewNote: "换了个意图，但复用了同一个键",
    }),
    "BAD_REQUEST",
    STAFF_REFUND_OPERATION_CONFLICT_MESSAGE,
  );

  assert.equal((await refundOf(PENDING_REFUND)).status, "reviewing", "状态不能被这次请求改变");
  assert.equal(await auditCount(), 1, "被拒的请求不写审计");
});

test("跨主体：客服带键 K 驳回 → 管理员带同一个 K 通过 → 必须 400，退款仍停在 rejected", async () => {
  const staff = staffOf(STAFF_A);
  const operationId = key();

  const rejected = await rejectStaffRefund(PENDING_REFUND, staff, {
    idempotencyKey: operationId,
    reviewNote: "客服驳回：与打手核对后不符合同意条件。",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(await auditCount(), 1);

  // 管理员带着**同一个**键请求「通过」：绝不能因为 (targetType, targetId) 都匹配
  // 就被判成重放而静默回 200——那是「管理员以为通过了，实际上没有」。
  await expectApiError(
    approveAdminRefund(PENDING_REFUND, "admin-1", {
      idempotencyKey: operationId,
      reviewNote: "管理员通过",
    }),
    "BAD_REQUEST",
    ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE,
  );

  assert.equal((await refundOf(PENDING_REFUND)).status, "rejected", "R 必须仍停在 rejected");
  assert.equal((await orderOf(PENDING_REFUND)).status, "accepted", "订单不能被这次的通过改成已退款");
  assert.equal(await auditCount(), 1, "管理员的通过没有被写成审计");
});

test("缺少或格式不对的幂等键一律 400，不留审计", async () => {
  const staff = staffOf(STAFF_A);

  await expectApiError(
    startReviewStaffRefund(PENDING_REFUND, staff, {}),
    "BAD_REQUEST",
    STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );
  for (const bad of ["", "short", "带空格的 key", "a".repeat(65), 12345]) {
    await assert.rejects(
      startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: bad }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }
  assert.equal(await auditCount(), 0, "失败的请求不该留下审计");
});

test("审计恰好一次：actorRole=customer_service，actorName 快照，actorId=客服 id", async () => {
  const staff = staffOf(STAFF_A);
  await startReviewStaffRefund(PENDING_REFUND, staff, { idempotencyKey: key() });
  await rejectStaffRefund(PENDING_REFUND, staff, { idempotencyKey: key(), reviewNote: "已核实，驳回。" });

  const entries = await auditsFor(PENDING_REFUND);
  assert.equal(entries.length, 2, "两个动作各一条审计");
  assert.deepEqual(entries.map((entry) => entry.action), ["refund.start-review", "refund.reject"]);

  for (const entry of entries) {
    assert.equal(entry.actorId, "staff-1");
    assert.equal(entry.actorRole, "customer_service");
    assert.equal(entry.actorName, STAFF_A_NAME, "客服的审核人快照不是 null");
    assert.ok(entry.before && entry.after, "每条审计都要有前后快照");
  }
  assert.ok(entries[1].after.reviewNote.startsWith("已核实"));
  // 两个动作都不动订单：审计里的订单状态前后一致
  assert.equal(entries[0].after.orderStatus, "accepted");
  assert.equal(entries[1].after.orderStatus, "accepted");
});

// ——————————————————————————— 九、源码门禁 ———————————————————————————

test("客服退款接口：四个地址、无 approve、requireStaff 是第一步且先于 readJsonBody、force-dynamic", () => {
  const routeFiles = collectFiles(STAFF_REFUND_API_DIR).filter((file) => file.endsWith("route.ts"));

  // 逐个写出来而不是只断言数量：少一个、多一个、被改名都会在这里现形。
  // ⚠️ 只有四个地址：列表、详情、开始审核、驳回。**没有 approve**——
  //    通过涉及资金最终划拨，只在管理员侧，接口不存在因此谁也调不出来。
  assert.deepEqual(
    routeFiles.map((file) => path.relative(STAFF_REFUND_API_DIR, file).replace(/\\/g, "/")).sort(),
    ["[id]/reject/route.ts", "[id]/route.ts", "[id]/start-review/route.ts", "route.ts"],
  );
  assert.equal(routeFiles.some((file) => file.includes("approve")), false, "客服退款接口不该有 approve 地址");

  for (const file of routeFiles) {
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    const source = stripComments(readSource(file));

    for (const forbidden of ["requireAdmin", "requireUser", "getSessionUser", "getSessionAdmin"]) {
      assert.equal(source.includes(forbidden), false, `${relative} 不该出现 ${forbidden}`);
    }
    assert.ok(source.includes('dynamic = "force-dynamic"'), `${relative} 缺少 force-dynamic`);

    const body = withoutImports(source);
    const guard = body.indexOf("requireStaff");
    assert.notEqual(guard, -1, `${relative} 缺少客服身份守卫`);
    const readsBody = body.indexOf("readJsonBody");
    if (readsBody !== -1) {
      assert.ok(guard < readsBody, `${relative} 的身份守卫必须先于解析请求体`);
    }
  }
});

test("客服退款页面与组件：不引用 lib/mocks / adminHttp / api/admin，动作由 allowedActions 决定", () => {
  const sources = [
    ...collectFiles(path.join(ROOT, "app", "staff", "(console)", "refunds")),
    ...collectFiles(path.join(ROOT, "components", "staff")).filter((file) => file.includes("Refund")),
  ].filter((file) => /\.(ts|tsx)$/.test(file));
  assert.ok(sources.length > 0, "没找到客服退款源码");

  for (const file of sources) {
    const source = stripComments(readSource(file));
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    assert.equal(source.includes("lib/mocks"), false, `${relative} 不该直接引用 lib/mocks`);
    assert.equal(source.includes("services/adminHttp"), false, `${relative} 不该调用管理端接口`);
    assert.equal(source.includes("api/admin"), false, `${relative} 不该请求管理端接口`);
    assert.equal(source.includes("dangerouslySetInnerHTML"), false, `${relative} 不该注入 HTML`);
  }

  // 详情页不能有加载边界：外壳先以 200 发出之后，迟到的 notFound() 只能改内容、改不了状态码
  const detailDir = path.dirname(findAppFile("staff/refunds/[id]/page.tsx"));
  assert.equal(
    readdirSync(detailDir).some((name) => /^loading\.(tsx|js)$/.test(name)),
    false,
    "退款详情页不该有 loading.tsx",
  );

  // 动作出没由服务端的 allowedActions 决定，页面不拿 status 自己写 if
  const consoleSource = stripComments(readSource(path.join(ROOT, "components", "staff", "StaffRefundConsole.tsx")));
  assert.ok(consoleSource.includes("allowedActions"), "控制台必须读 allowedActions");
  assert.equal(consoleSource.includes("refund.status ==="), false, "控制台不该拿退款状态自己写 if");

  const detailSource = stripComments(readSource(findAppFile("staff/refunds/[id]/page.tsx")));
  assert.equal(detailSource.includes('status === "pending"'), false, "详情页不该拿状态自己写 if");
});

test("客服退款取数与常量层没有 approve：按钮不存在，地址也不存在", () => {
  const http = stripComments(readSource(path.join(ROOT, "lib", "services", "staffRefundsHttp.ts")));
  assert.equal(http.includes("approve"), false, "客服客户端取数文件不该有 approve 函数或地址");

  const constants = stripComments(readSource(path.join(ROOT, "lib", "constants", "staffRefunds.ts")));
  const labelsStart = constants.indexOf("STAFF_REFUND_ACTION_LABELS");
  assert.notEqual(labelsStart, -1, "找不到 STAFF_REFUND_ACTION_LABELS");
  const labelsBlock = constants.slice(labelsStart, constants.indexOf("as const", labelsStart));
  assert.equal(labelsBlock.includes("approve"), false, "按钮文案里不该有 approve");
});

test("审核意见规则复用现成实现：客服服务不另写一份", () => {
  const source = stripComments(readSource(path.join(ROOT, "lib", "services", "staffRefunds.ts")));
  assert.ok(source.includes("normalizeAdminReviewNote"), "驳回意见必须走现成的校验");
  assert.ok(source.includes('from "@/lib/constants/adminRefunds"'), "必须从 adminRefunds 导入，而不是另写一份");
});

// ——————————————————————————— 十、HTTP（需要真实服务）———————————————————————————

test("HTTP：匿名 / 伪造用户与管理 Cookie / 停用 / 护航 / 已移除账号一律挡在退款接口外", { skip: SKIP_HTTP }, async () => {
  const anonymous = await requestWithCookie("/api/staff/refunds", null);
  assert.equal(anonymous.status, 401, "匿名应当是 401");

  for (const cookie of ["mock_user_id=u-1001", "mock_admin_id=admin-1"]) {
    const list = await requestWithCookie("/api/staff/refunds", cookie);
    assert.equal(list.status, 401, `${cookie} 不该读到客服退款列表`);
  }

  const login = await staffLogin("staff-1");
  if (login.status !== 200) {
    // 开关关闭：登录接口按「不存在」返回，伪造的客服 Cookie 也不产生身份
    assert.equal(login.status, 404);
    const forged = await requestWithCookie("/api/staff/refunds", "mock_staff_id=staff-1");
    assert.equal(forged.status, 401);
    return;
  }

  const staffCookie = login.setCookie[0].split(";")[0];
  const okList = await requestWithCookie("/api/staff/refunds", staffCookie);
  assert.equal(okList.status, 200);

  // 停用 / 护航 / 已移除账号即使拿到 Cookie 也进不来
  for (const id of ["staff-3", "staff-4", "staff-5"]) {
    const denied = await requestWithCookie("/api/staff/refunds", `mock_staff_id=${id}`);
    assert.equal(denied.status, 403, `${id} 不该读到退款列表`);
  }
});

test("HTTP：合法迁移 / 幂等重放 / 非法迁移 / 响应不含敏感字段（写只占 rf-seed-1002-01）", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const cookie = login.setCookie[0].split(";")[0];

  // 上一轮跑可能已经写过这一笔，先确认它仍是待审核
  const detailRes = await requestWithCookie(`/api/staff/refunds/${HTTP_TARGET}`, cookie);
  assert.equal(detailRes.status, 200);
  assert.equal(
    /userId|gameAccountId|remark|openId|unionId|sessionId|cookie/i.test(detailRes.body),
    false,
    "详情响应不含敏感字段",
  );
  const detail = JSON.parse(detailRes.body).data;
  if (detail.status !== "pending") return;

  // 合法迁移：开始审核
  const operationId = key();
  const started = await postJson(`/api/staff/refunds/${HTTP_TARGET}/start-review`, cookie, {
    idempotencyKey: operationId,
  });
  assert.equal(started.status, 200);
  assert.equal(JSON.parse(await started.text()).data.changed, true);

  // 幂等重放：同一个键
  const replay = await postJson(`/api/staff/refunds/${HTTP_TARGET}/start-review`, cookie, {
    idempotencyKey: operationId,
  });
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(await replay.text()).data.changed, false);

  // 非法迁移：审核中不能再开始审核（换一个新键）
  const illegal = await postJson(`/api/staff/refunds/${HTTP_TARGET}/start-review`, cookie, {
    idempotencyKey: key(),
  });
  assert.equal(illegal.status, 400);

  // 合法迁移：驳回（reviewing → rejected），必须带审核意见
  const rejected = await postJson(`/api/staff/refunds/${HTTP_TARGET}/reject`, cookie, {
    idempotencyKey: key(),
    reviewNote: "HTTP 链路上的一次驳回",
  });
  assert.equal(rejected.status, 200);
  assert.equal(JSON.parse(await rejected.text()).data.status, "rejected");
});
