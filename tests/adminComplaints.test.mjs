import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE,
  ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  ADMIN_COMPLAINT_NOT_FOUND_MESSAGE,
  ADMIN_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE,
  ADMIN_COMPLAINT_RESULT_MAX_LENGTH,
  ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  ADMIN_COMPLAINT_TRANSITIONS,
  ADMIN_COMPLAINT_TYPE_FILTERS,
  ADMIN_COMPLAINT_TYPE_INVALID_MESSAGE,
  adminComplaintAllowedActions,
  canTransitionComplaint,
  complaintMatchesAdminKeyword,
} from "../lib/constants/adminComplaints.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import {
  closeAdminComplaint,
  getAdminComplaintDetail,
  queryAdminComplaintList,
  resolveAdminComplaint,
  resolveAdminComplaintListQuery,
  startProcessingAdminComplaint,
} from "../lib/services/adminComplaints.ts";
import { getComplaintDetailForUser } from "../lib/services/complaints.ts";

/**
 * 管理端「投诉处理」的持续测试（P8C）。
 *
 * 跑的是**真实实现**：真实的 Mock 投诉 / 订单 / 退款仓储 + 真实的伪事务 +
 * 真实的 `lib/services/adminComplaints.ts`。因此「状态机」、「解决与关闭的说明必填」、
 * 「处理投诉不改订单也不产生退款」、「用户提交的内容不可被覆盖」、
 * 「幂等与审计恰好一次」这些规则每次提交都会被重新验证。
 *
 * 每个用例开始前重建投诉与审计仓储，**并额外重建订单与退款仓储**：
 * 「处理投诉不碰订单和退款」这条要真的抓得住，那两份数据必须是干净的。
 */
const ADMIN = "admin-p8c";
const SURFACE = "server";

const USER_A = "u-1001";
const USER_B = "u-1002";

/** 待处理、关联订单；**没有**联系方式与凭证 */
const PENDING_COMPLAINT = "cmp-seed-1001-01";
/** 处理中、关联订单；**有**联系方式与凭证（隐私边界的样本） */
const PROCESSING_COMPLAINT = "cmp-seed-1001-02";
/** 已处理（终态） */
const RESOLVED_COMPLAINT = "cmp-seed-1001-03";
/** 已关闭（终态），且**不关联订单** */
const CLOSED_COMPLAINT = "cmp-seed-1001-04";
/** 老板B（u-1002）的投诉 */
const OTHER_COMPLAINT = "cmp-seed-1002-01";

function key() {
  return crypto.randomUUID();
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

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 全部订单 + 全部退款申请的指纹：任何一处被改动都会在这里现形。 */
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
});

// ——————————————————————————— 状态机 ———————————————————————————

test("状态机：待处理可以开始处理或直接关闭，处理中可以解决或关闭，终态没有出边", () => {
  assert.deepEqual(ADMIN_COMPLAINT_TRANSITIONS.pending, ["processing", "closed"]);
  assert.deepEqual(ADMIN_COMPLAINT_TRANSITIONS.processing, ["resolved", "closed"]);
  for (const terminal of ["resolved", "closed"]) {
    assert.deepEqual(ADMIN_COMPLAINT_TRANSITIONS[terminal], [], `${terminal} 必须是终态`);
  }

  // 没有「回到待处理」，也没有「已处理之后再关闭」
  for (const from of ["processing", "resolved", "closed"]) {
    assert.equal(canTransitionComplaint(from, "pending"), false, `${from} 不该能回到待处理`);
  }
  assert.equal(canTransitionComplaint("resolved", "closed"), false, "已处理是终态，不能再关闭");
  assert.equal(
    canTransitionComplaint("closed", "resolved"),
    false,
    "已关闭是终态，不能再改为已处理",
  );
  // 待处理**不能**直接解决：必须先开始处理，留下「谁在什么时候接的手」
  assert.equal(canTransitionComplaint("pending", "resolved"), false);
  for (const status of ["pending", "processing", "resolved", "closed"]) {
    assert.equal(canTransitionComplaint(status, status), false, "原地不动不是迁移");
  }
});

test("可执行动作由状态推导：待处理不能直接解决，终态三项全 false", () => {
  assert.deepEqual(adminComplaintAllowedActions("pending"), {
    canStartProcessing: true,
    canResolve: false,
    canClose: true,
  });
  assert.deepEqual(adminComplaintAllowedActions("processing"), {
    canStartProcessing: false,
    canResolve: true,
    canClose: true,
  });
  for (const terminal of ["resolved", "closed"]) {
    assert.deepEqual(
      adminComplaintAllowedActions(terminal),
      { canStartProcessing: false, canResolve: false, canClose: false },
      `${terminal} 不该有可执行动作`,
    );
  }
});

test("非法迁移一律 400 且带上当前状态", async () => {
  for (const [id, statusLabel] of [
    [RESOLVED_COMPLAINT, "已处理"],
    [CLOSED_COMPLAINT, "已关闭"],
  ]) {
    for (const call of [
      () => startProcessingAdminComplaint(id, ADMIN, { idempotencyKey: key() }),
      () => resolveAdminComplaint(id, ADMIN, { idempotencyKey: key(), result: "结论" }),
      () => closeAdminComplaint(id, ADMIN, { idempotencyKey: key(), result: "原因" }),
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
    resolveAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: "结论" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.ok(error.message.includes("待处理"));
      return true;
    },
  );

  // 处理中不能再「开始处理」
  await expectApiError(
    startProcessingAdminComplaint(PROCESSING_COMPLAINT, ADMIN, { idempotencyKey: key() }),
    "BAD_REQUEST",
  );

  // 不存在的投诉：404，与「状态不对」区分开
  await expectApiError(
    resolveAdminComplaint("cmp-nope", ADMIN, { idempotencyKey: key(), result: "结论" }),
    "NOT_FOUND",
    ADMIN_COMPLAINT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    closeAdminComplaint("", ADMIN, { idempotencyKey: key(), result: "原因" }),
    "NOT_FOUND",
  );

  // 上面全部失败，因此一条审计都没有
  assert.equal(auditCount(), 0);
});

// ——————————————————————————— 开始处理 ———————————————————————————

test("开始处理只改状态：不产生结论，也不写处理人与完成时间", async () => {
  const ordersBefore = await orderFingerprint();
  const refundsBefore = await refundFingerprint();

  const result = await startProcessingAdminComplaint(PENDING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
  });

  assert.equal(result.status, "processing");
  assert.equal(result.statusLabel, "处理中");
  assert.equal(result.changed, true);
  assert.equal(result.handledAt, null, "开始处理不是结论，不该有完成时间");

  const complaint = await complaintOf(PENDING_COMPLAINT);
  assert.equal(complaint.status, "processing");
  assert.ok(complaint.processingAt);
  assert.equal(complaint.result, "", "开始处理一个字的结论都不写");
  assert.equal(complaint.handledByAdminId, null, "开始处理不代表已经有人出了结论");

  // 订单与退款一条都没动
  assert.deepEqual(await orderFingerprint(), ordersBefore);
  assert.deepEqual(await refundFingerprint(), refundsBefore);
});

// ——————————————————————————— 结论必填 ———————————————————————————

test("解决必须填写处理结果、关闭必须填写关闭说明：空值报错，且两者文案不同", async () => {
  for (const blank of ["", "   ", "\n\t"]) {
    await assert.rejects(
      resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: blank }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.message, ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE);
        return true;
      },
    );
    await assert.rejects(
      closeAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: blank }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        // 「请填写处理结果」与「请填写关闭说明」是两种问法，不能共用一句话
        assert.equal(error.message, ADMIN_COMPLAINT_CLOSE_NOTE_EMPTY_MESSAGE);
        assert.notEqual(error.message, ADMIN_COMPLAINT_RESULT_EMPTY_MESSAGE);
        return true;
      },
    );
  }

  // 超过上限：两种问法各自的文案
  const tooLong = "x".repeat(ADMIN_COMPLAINT_RESULT_MAX_LENGTH + 1);
  await expectApiError(
    resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: tooLong }),
    "BAD_REQUEST",
    ADMIN_COMPLAINT_RESULT_TOO_LONG_MESSAGE,
  );
  await expectApiError(
    closeAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: tooLong }),
    "BAD_REQUEST",
    ADMIN_COMPLAINT_CLOSE_NOTE_TOO_LONG_MESSAGE,
  );

  // 恰好等于上限可以过（按 code point 计数，与全站口径一致）
  const atLimit = await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "x".repeat(ADMIN_COMPLAINT_RESULT_MAX_LENGTH),
  });
  assert.equal(atLimit.status, "resolved");
  assert.equal((await complaintOf(PROCESSING_COMPLAINT)).status, "resolved");

  // 前面所有失败都没有留下审计：失败的写操作不留痕
  assert.equal(auditCount(), 1, "只有那次成功的解决留下了审计");
});

test("解决与关闭写的是同一个字段、两种问法：一条投诉只有一个结论", async () => {
  const resolved = await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "客服已核对退款记录，未发现重复扣款。",
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.statusLabel, "已处理");
  assert.ok(resolved.handledAt);

  const resolvedRecord = await complaintOf(PROCESSING_COMPLAINT);
  assert.equal(resolvedRecord.result, "客服已核对退款记录，未发现重复扣款。");
  assert.equal(resolvedRecord.handledByAdminId, ADMIN);
  assert.equal(resolvedRecord.handledAt, resolved.handledAt);

  const closed = await closeAdminComplaint(PENDING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "用户未补充信息，本次投诉先关闭。",
  });
  assert.equal(closed.status, "closed");
  assert.equal(
    (await complaintOf(PENDING_COMPLAINT)).result,
    "用户未补充信息，本次投诉先关闭。",
  );
});

// ——————————————————————————— 不碰订单、不退款 ———————————————————————————

test("处理投诉不改任何订单、不产生任何退款：三条路径都试一遍", async () => {
  const ordersBefore = await orderFingerprint();
  const refundsBefore = await refundFingerprint();

  await startProcessingAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key() });
  await resolveAdminComplaint(PENDING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "已核实并记录，未做赔付。",
  });
  await closeAdminComplaint(OTHER_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "已与用户沟通清楚，本次投诉关闭。",
  });

  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "resolved");
  assert.equal((await complaintOf(OTHER_COMPLAINT)).status, "closed");
  assert.deepEqual(await orderFingerprint(), ordersBefore, "订单一个字都不该变");
  assert.deepEqual(await refundFingerprint(), refundsBefore, "不该多出任何退款申请");
});

test("用户提交的正文、凭证与联系方式不可被覆盖：请求体里的同名字段一律被忽略", async () => {
  const before = await complaintOf(PROCESSING_COMPLAINT);

  await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "这里是平台侧的处理结果。",
    // 客户端伪造：想改用户提交的内容，以及想改状态、处理人、投诉编号、订单
    description: "被篡改的正文",
    contact: "13800000000",
    evidence: [{ id: "fake", kind: "image", name: "fake.png", url: "https://evil.example/x.png" }],
    complaintNo: "TS-FAKE",
    status: "closed",
    handledByAdminId: "admin-999",
    handledAt: "2000-01-01T00:00:00.000Z",
    orderId: "ord-nope",
    processingAt: "2000-01-01T00:00:00.000Z",
  });

  const after = await complaintOf(PROCESSING_COMPLAINT);
  assert.equal(after.description, before.description, "用户写的正文不可被覆盖");
  assert.equal(after.contact, before.contact, "联系方式不可被覆盖");
  assert.deepEqual(after.evidence, before.evidence, "凭证不可被覆盖");
  assert.equal(after.complaintNo, before.complaintNo);
  assert.equal(after.orderId, before.orderId, "关联订单不可被改动");
  assert.equal(after.processingAt, before.processingAt, "开始处理时间不可被改写");
  assert.equal(after.status, "resolved", "状态由状态机决定，不由请求体决定");
  assert.equal(after.handledByAdminId, ADMIN, "处理人来自服务端会话");
  assert.notEqual(after.handledAt, "2000-01-01T00:00:00.000Z");
  assert.equal(after.result, "这里是平台侧的处理结果。");
});

// ——————————————————————————— 幂等与审计 ———————————————————————————

test("幂等：同一个键重复提交不迁移两次状态、不写第二条审计、不覆盖结论", async () => {
  const operationId = key();

  const first = await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: operationId,
    result: "第一次结论",
  });
  assert.equal(first.changed, true);
  assert.equal(auditCount(), 1);

  const replay = await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: operationId,
    result: "第二次结论（不该生效）",
  });
  assert.equal(replay.status, "resolved");
  assert.equal(replay.changed, false, "重放不算改动");
  assert.equal(replay.handledAt, first.handledAt);
  assert.equal(auditCount(), 1, "重放不能再写审计");
  assert.equal((await complaintOf(PROCESSING_COMPLAINT)).result, "第一次结论");
});

test("幂等键被另一个对象占用时报冲突，而不是安静地重放别人的结果", async () => {
  const operationId = key();
  await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: operationId,
    result: "甲条投诉的结论",
  });

  await expectApiError(
    closeAdminComplaint(PENDING_COMPLAINT, ADMIN, {
      idempotencyKey: operationId,
      result: "乙条投诉的关闭说明",
    }),
    "BAD_REQUEST",
    ADMIN_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  );
  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "pending", "冲突不该改动目标");
  assert.equal(auditCount(), 1);
});

test("并发：两个同时到达的「关闭」只有一个成功，另一个被判为非法迁移", async () => {
  const results = await Promise.allSettled([
    closeAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: "原因一" }),
    closeAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key(), result: "原因二" }),
  ]);

  const ok = results.filter((item) => item.status === "fulfilled");
  assert.equal(ok.length, 1, "只能有一次关闭");
  assert.equal(results.filter((item) => item.status === "rejected")[0].reason.code, "BAD_REQUEST");
  assert.equal(auditCount(), 1);
  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "closed");
});

test("审计恰好一次，且不保存投诉正文、联系方式与凭证地址", async () => {
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  assert.ok(sample.contact.length > 0, "样本应当有联系方式，这条断言才有意义");
  assert.ok(sample.evidence.length > 0, "样本应当有凭证");

  await startProcessingAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key() });
  await closeAdminComplaint(PENDING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "已核实并给出答复。",
  });
  await resolveAdminComplaint(PROCESSING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "已核对退款记录，未发现重复扣款。",
  });

  const pendingEntries = auditsFor(PENDING_COMPLAINT);
  assert.equal(pendingEntries.length, 2);
  assert.deepEqual(
    pendingEntries.map((entry) => entry.action),
    ["complaint.start-processing", "complaint.close"],
  );
  for (const entry of pendingEntries) {
    assert.equal(entry.adminId, ADMIN);
    assert.equal(entry.targetType, "complaint");
  }

  // 开始处理那次：状态变了，但结论栏仍然是空的
  assert.equal(pendingEntries[0].before.status, "pending");
  assert.equal(pendingEntries[0].after.status, "processing");
  assert.equal(pendingEntries[0].after.result, "");
  assert.equal(pendingEntries[0].after.handledAt, null);

  // 关闭那次：结论（截断后）留下来，否则这条审计回答不了「当时为什么关掉」
  assert.equal(pendingEntries[1].before.status, "processing");
  assert.equal(pendingEntries[1].after.status, "closed");
  assert.ok(pendingEntries[1].after.result.startsWith("已核实"));
  assert.equal(pendingEntries[1].after.handledByAdminId, ADMIN);

  const processingEntry = auditsFor(PROCESSING_COMPLAINT)[0];
  assert.equal(processingEntry.action, "complaint.resolve");
  // 联系方式只留「有没有留」，凭证只记份数
  assert.equal(processingEntry.after.hasContact, true);
  assert.equal(processingEntry.after.evidenceCount, sample.evidence.length);

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
    assert.equal(
      serialized.includes(forbidden),
      false,
      `审计里出现了不该留档的内容：${forbidden}`,
    );
  }
});

test("缺少或格式不对的幂等键一律 400，且不留审计、不改状态", async () => {
  for (const bad of [undefined, "", "short", "带空格的 key", "a".repeat(65), 12345]) {
    await assert.rejects(
      startProcessingAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: bad }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }
  assert.equal(auditCount(), 0);
  assert.equal((await complaintOf(PENDING_COMPLAINT)).status, "pending");
});

// ——————————————————————————— 列表 ———————————————————————————

test("列表：关键词命中投诉编号 / 订单号 / 用户昵称 / 平台 ID，不命中正文与联系方式", async () => {
  const detail = await getAdminComplaintDetail(PENDING_COMPLAINT, undefined, SURFACE);
  assert.ok(detail);

  for (const [label, keyword] of [
    ["投诉编号", detail.complaintNo],
    ["订单号", detail.orderNo],
    ["用户昵称", detail.user.nickname],
    ["平台 ID", detail.user.displayId],
  ]) {
    assert.ok(String(keyword).length > 0, `${label} 为空，这条断言失去意义`);
    const data = await queryAdminComplaintList(
      await resolveAdminComplaintListQuery(
        new URLSearchParams({ status: "all", keyword: String(keyword), pageSize: "100" }),
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

  // 大小写不敏感（投诉编号里有字母）
  const upper = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", keyword: detail.complaintNo.toUpperCase() }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.ok(upper.items.some((item) => item.id === PENDING_COMPLAINT));

  // 正文与联系方式**不是**搜索对象：否则任何人都能用关键词把别人的手机号试出来
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  for (const [label, keyword] of [
    ["正文", sample.description.slice(0, 12)],
    ["联系方式", sample.contact],
  ]) {
    const data = await queryAdminComplaintList(
      await resolveAdminComplaintListQuery(
        new URLSearchParams({ status: "all", keyword, pageSize: "100" }),
        false,
      ),
      undefined,
      SURFACE,
    );
    assert.equal(data.items.length, 0, `关键词不该能搜到${label}`);
  }

  const none = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", keyword: "不存在的关键词-zzz" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.equal(none.items.length, 0);
  assert.equal(none.total, 0);
  assert.equal(none.hasMore, false, "空结果不该说「后面还有」");

  assert.equal(
    complaintMatchesAdminKeyword(
      { complaintNo: "TS1", orderNo: "ORD1", nickname: "老板A", displayId: "ID-1" },
      "ts1",
    ),
    true,
  );
});

test("列表 DTO 只有摘要：没有正文、凭证、联系方式、处理结果与处理人", async () => {
  const data = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", pageSize: "100" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.ok(data.items.length > 0);

  const allowed = new Set([
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
  ]);
  for (const item of data.items) {
    assert.deepEqual(new Set(Object.keys(item)), allowed, "列表项的字段集合变了");
    assert.deepEqual(
      new Set(Object.keys(item.user)),
      new Set(["id", "displayId", "nickname"]),
      "用户摘要多带了字段",
    );
  }

  const serialized = JSON.stringify(data);
  const sample = await complaintOf(PROCESSING_COMPLAINT);
  for (const forbidden of [
    sample.description.slice(0, 10),
    sample.contact,
    "/mock/evidence-placeholder.svg",
    "evidence",
    "contact",
    "result",
    "handledByAdminId",
    "handledAt",
    "processingAt",
    "openId",
    "unionId",
    "cookie",
    "sessionId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `列表 DTO 出现了 ${forbidden}`);
  }
});

test("列表筛选：状态与类型都能筛，默认待处理，非法值接口 400 / 页面收敛", async () => {
  const pending = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "pending", pageSize: "100" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.ok(pending.items.length > 0);
  for (const item of pending.items) assert.equal(item.status, "pending");

  const type = ADMIN_COMPLAINT_TYPE_FILTERS.find((value) => value !== "all");
  assert.ok(type);
  const byType = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", type, pageSize: "100" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  assert.ok(byType.items.length > 0);
  for (const item of byType.items) assert.equal(item.typeKey, type);

  // 默认筛选是「待处理」；默认类型是「不限类型」
  const defaults = await resolveAdminComplaintListQuery(new URLSearchParams(), false);
  assert.equal(defaults.status, "pending");
  assert.equal(defaults.type, "all");
  assert.equal(defaults.page, 1);

  // 页面用宽松模式：地址栏改坏了不该变成一屏 400
  const loose = await resolveAdminComplaintListQuery(
    new URLSearchParams({ status: "whatever", type: "whatever" }),
    false,
  );
  assert.equal(loose.status, "pending");
  assert.equal(loose.type, "all");

  // 接口用严格模式：同样的值一律 400，且各自带上说明
  await assert.rejects(
    resolveAdminComplaintListQuery(new URLSearchParams({ status: "whatever" }), true),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    },
  );
  await expectApiError(
    resolveAdminComplaintListQuery(new URLSearchParams({ type: "whatever" }), true),
    "BAD_REQUEST",
    ADMIN_COMPLAINT_TYPE_INVALID_MESSAGE,
  );

  // 分页参数永远不规范化为 400
  const clamped = await resolveAdminComplaintListQuery(
    new URLSearchParams({ page: "0", pageSize: "9999" }),
    true,
  );
  assert.equal(clamped.page, 1);
  assert.ok(clamped.pageSize > 0);
});

test("列表默认按提交时间倒序，同一时间按 id 兜底（顺序稳定，翻页不重不漏）", async () => {
  const first = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", pageSize: "1" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  const second = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", pageSize: "1", page: "2" }),
      false,
    ),
    undefined,
    SURFACE,
  );
  const whole = await queryAdminComplaintList(
    await resolveAdminComplaintListQuery(
      new URLSearchParams({ status: "all", pageSize: "5" }),
      false,
    ),
    undefined,
    SURFACE,
  );

  assert.ok(whole.items.length >= 2, "预置投诉太少，这条断言失去意义");
  assert.equal(first.total, whole.total);
  assert.equal(second.total, whole.total, "total 是过滤后的总数，不随页码变化");
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    whole.items.slice(0, 2).map((item) => item.id),
    "两页拼起来必须等于一次取回的前两条",
  );

  for (let index = 1; index < whole.items.length; index += 1) {
    const previous = whole.items[index - 1];
    const current = whole.items[index];
    assert.ok(
      previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id < current.id),
      `第 ${index} 条的顺序不满足「提交时间倒序 + id 兜底」`,
    );
  }
});

test("详情：不关联订单是合法状态，不是数据缺失", async () => {
  const closed = await getAdminComplaintDetail(CLOSED_COMPLAINT, undefined, SURFACE);
  assert.ok(closed);
  assert.equal(closed.orderId, null);
  assert.equal(closed.orderNo, null);
  assert.equal(closed.orderSummary, null, "未关联订单时摘要为 null");
  assert.deepEqual(closed.allowedActions, {
    canStartProcessing: false,
    canResolve: false,
    canClose: false,
  });
  // 没有订单不影响投诉本身可读
  assert.ok(closed.description.length > 0);
  assert.ok(Array.isArray(closed.evidence));
  assert.ok(closed.timeline.length >= 2, "时间轴至少要有提交与关闭两个节点");
  assert.equal(closed.timeline[0].key, "pending");

  const withOrder = await getAdminComplaintDetail(PENDING_COMPLAINT, undefined, SURFACE);
  assert.ok(withOrder?.orderSummary);
  assert.equal(withOrder.orderSummary.id, withOrder.orderId);
  assert.equal(typeof withOrder.orderSummary.totalAmount, "number");
  assert.ok(withOrder.orderSummary.orderNo.length > 0);

  assert.equal(await getAdminComplaintDetail("cmp-nope", undefined, SURFACE), null);
  assert.equal(await getAdminComplaintDetail("", undefined, SURFACE), null);
});

// ——————————————————————————— 用户端同步 ———————————————————————————

test("用户端同步看到处理结果，但看不到管理员的内部字段", async () => {
  await startProcessingAdminComplaint(PENDING_COMPLAINT, ADMIN, { idempotencyKey: key() });
  const result = await resolveAdminComplaint(PENDING_COMPLAINT, ADMIN, {
    idempotencyKey: key(),
    result: "客服已回访并记录了本次反馈的处理过程。",
  });
  assert.equal(result.status, "resolved");

  const mine = await getComplaintDetailForUser(PENDING_COMPLAINT, USER_A, undefined, SURFACE);
  assert.ok(mine, "本人应当能看到自己的投诉");
  assert.equal(mine.status, "resolved");
  assert.equal(mine.result, "客服已回访并记录了本次反馈的处理过程。", "处理结果同步给用户");
  assert.equal(mine.handledAt, result.handledAt, "用户看得到处理时间");
  assert.ok(mine.processingAt, "用户也看得到平台是什么时候开始处理的");

  // 管理员的内部字段不进用户 DTO
  assert.equal(
    Object.hasOwn(mine, "handledByAdminId"),
    false,
    "用户端 DTO 不该有「处理人是谁」这个字段",
  );
  const serialized = JSON.stringify(mine);
  assert.equal(serialized.includes(ADMIN), false, "用户端看不到管理员 id");
  assert.equal(serialized.includes("openId"), false);
  assert.equal(serialized.includes("cookie"), false);

  // 别人的投诉照旧读不到——「不存在」与「不是你的」对外表现一致，id 探不出来
  assert.equal(
    await getComplaintDetailForUser(PENDING_COMPLAINT, USER_B, undefined, SURFACE),
    null,
    "不能拿别人的投诉 id 试探",
  );
  assert.equal(await getComplaintDetailForUser(OTHER_COMPLAINT, USER_A, undefined, SURFACE), null);
});
