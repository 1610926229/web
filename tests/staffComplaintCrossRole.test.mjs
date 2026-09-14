import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { getMessageRepository } from "../lib/data/messageRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getStaffRepository } from "../lib/data/staffRepository.ts";
import {
  DEFAULT_STAFF_COMPLAINT_STATUS_FILTER,
  readStaffComplaintStatusFilter,
  readStaffComplaintTypeFilter,
} from "../lib/constants/staffComplaints.ts";
import { readStaffRefundStatusFilter } from "../lib/constants/staffRefunds.ts";
import { createComplaintForUser, getComplaintDetailForUser } from "../lib/services/complaints.ts";
import { createRefundForOrder } from "../lib/services/refunds.ts";
import {
  getStaffComplaintDetail,
  queryStaffComplaintList,
  resolveStaffComplaint,
  resolveStaffComplaintListQuery,
  startProcessingStaffComplaint,
} from "../lib/services/staffComplaints.ts";
import { fetchStaffComplaints } from "../lib/services/staffComplaintsHttp.ts";
import { listStaffRefunds, resolveStaffRefundListQuery } from "../lib/services/staffRefunds.ts";
import { fetchStaffRefunds } from "../lib/services/staffRefundsHttp.ts";

/**
 * 跨角色回归：**用户提交 → 投诉仓储 → 客服收到 → 客服处理 → 用户看到结果**。
 *
 * ⚠️ 这个文件的存在理由是一次人工验收失败：**用户针对订单提交投诉后，客服工作台
 * 看不到该投诉**。当时 681 个测试全绿却没有一条覆盖它，因为它们各自只验证一侧——
 * 用户侧的服务写完就算数，客服侧的服务拿预置种子读就算数，**没有人把两侧串起来跑一遍**。
 * 所以这里刻意**不分别测试两个孤立 API**，而是让同一份数据依次经过两个身份：
 *
 *   用户身份写 →（同一仓储）→ 客服身份读 → 客服身份写 →（同一仓储）→ 用户身份读
 *
 * 断言按「客服真实会做的动作」组织：
 * 1. 用户提交一条**关联订单**的投诉（走 `createComplaintForUser`，与用户接口同一条路径）；
 * 2. 创建成功，且用户自己查得到；
 * 3. 客服**不带任何筛选**请求列表——这正是客服打开 `/staff/complaints` 时服务端走的那条路
 *    （默认筛选是「待处理」），新投诉必须出现在这一页里；
 * 4. 客服打开详情，**投诉人、关联订单、订单号**都必须对得上；
 * 5. 客服「开始处理」→ 用户重新查询看到「处理中」；
 * 6. 客服「解决」→ 用户重新查询看到「已处理」与那段处理结果。
 *
 * 第 6 条（解决）跑的是完整闭环，不是「客服改完状态就算成功」——**处理结果要能到用户手上**。
 *
 * 跑的是真实实现：真实的 Mock 仓储 + 真实的伪事务 + 真实的用户端与客服端服务层。
 * 一组用例同时守住两件曾经出事的事：**只有一个投诉数据源**（客服读的是用户写进去的那一条，
 * 不是另一份复制品），以及**订单关联不会在跨角色途中丢失**。
 *
 * ⚠️ 这个文件**测不到**的地方要说清楚：本次验收失败还有一半在浏览器侧
 * （`.tsx` 客户端组件把服务端快照存进 `useState`，`router.refresh()` 之后不采纳新快照），
 * 而本仓库的测试架构**覆盖不了客户端组件**（Node 不做 JSX 转译，见 CLAUDE.md）。
 * 那一半只能人工复验，步骤见验收说明。这里守住的是数据链路这一半。
 */

const USER_A = "u-1001";
const STAFF_A = "staff-1";
const SURFACE = "server";

/** 归属 u-1001、没有预置投诉占用、且**没有沟通记录**的订单。 */
const ORDER_FOR_COMPLAINT = "ord-seed-1001-02";
/** 归属 u-1001、**有**沟通记录的订单（会话入口必须能通向这条投诉的订单）。 */
const ORDER_WITH_CONVERSATION = "ord-seed-1001-04";
/** 归属 u-1001、状态可退、且**没有**预置退款记录的订单。 */
const ORDER_FOR_REFUND = "ord-seed-1001-11";

function key() {
  return crypto.randomUUID();
}

/** 服务层读的那份客服会话：只拼 `requireStaff()` 返回里真正被用的字段。 */
async function staffSessionOf(staffId) {
  const account = await getStaffRepository().findStaffById(staffId);
  assert.ok(account, `预置客服账号缺失：${staffId}`);
  return { id: account.id, displayName: account.displayName };
}

/** 用户侧提交一条投诉（与用户接口同一条路径）。 */
function submitComplaint(overrides = {}) {
  return createComplaintForUser(
    USER_A,
    {
      typeKey: "companion_service",
      description: "跨角色回归：护航中途离场，订单一直停在服务中。",
      contact: "13800000001",
      evidence: [],
      orderId: ORDER_FOR_COMPLAINT,
      idempotencyKey: key(),
      ...overrides,
    },
    undefined,
    SURFACE,
  );
}

/** 客服侧的默认列表——客服打开 `/staff/complaints` 时服务端走的那条路。 */
async function staffDefaultComplaintList() {
  const params = new URLSearchParams();
  const query = await resolveStaffComplaintListQuery(params, false);
  return queryStaffComplaintList(query, params, SURFACE);
}

beforeEach(() => {
  resetMockStore("complaint");
  resetMockStore("adminAudit");
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("message");
  resetMockStore("staff");
});

test("跨角色：用户提交投诉 → 客服默认列表收到 → 订单与投诉人都对得上", async () => {
  // —— 1/2. 用户侧提交，且创建成功
  const created = await submitComplaint();
  assert.equal(created.created, true, "用户提交投诉没有真正落库");

  // 用户自己也查得到（不是「写进去但两边都读不到」）
  const userView = await getComplaintDetailForUser(
    created.complaintId,
    USER_A,
    undefined,
    SURFACE,
  );
  assert.ok(userView, "用户查不到自己刚提交的投诉");
  assert.equal(userView.status, "pending");

  // —— 3. 客服**不带任何筛选**打开列表：新投诉必须在这一页里
  const list = await staffDefaultComplaintList();
  const row = list.items.find((item) => item.id === created.complaintId);
  assert.ok(row, "客服列表（默认「待处理」筛选）里没有收到用户刚提交的投诉");
  assert.equal(row.status, "pending");
  assert.equal(row.complaintNo, userView.complaintNo);

  // —— 4. 客服打开详情：投诉人、关联订单、订单号都要对得上
  const detail = await getStaffComplaintDetail(created.complaintId, undefined, SURFACE);
  assert.ok(detail, "客服打不开这条投诉的详情");

  assert.equal(detail.orderId, ORDER_FOR_COMPLAINT, "投诉的订单关联在客服侧丢失了");
  assert.equal(detail.user.id, USER_A, "客服看到的投诉人不是提交投诉的那个用户");

  const order = await getPaymentRepository().findOrderById(ORDER_FOR_COMPLAINT);
  assert.ok(order);
  assert.equal(detail.orderNo, order.orderNo);
  assert.equal(detail.orderSummary.id, ORDER_FOR_COMPLAINT);
  assert.equal(detail.orderSummary.orderNo, order.orderNo);

  // 用户提交的内容在客服侧**原样**可见，没有被客服端的字段假设改掉
  assert.equal(detail.description, userView.description);
  assert.equal(detail.contact, userView.contact);
  assert.deepEqual(detail.evidence, userView.evidence);

  // 这一单没有沟通记录：不给会话入口，也不为它**造一个**（不制造虚假消息）
  assert.equal(detail.conversationOrderId, null);
  assert.equal(
    await getMessageRepository().findConversationForStaff(ORDER_FOR_COMPLAINT),
    null,
    "详情不该为一条没有消息的订单造出会话",
  );

  // 待处理 → 可开始处理
  assert.equal(detail.allowedActions.canStartProcessing, true);
});

test("跨角色：订单有沟通记录时，会话入口指向**这一单**（投诉关联不丢）", async () => {
  // 这一单预置了消息，因此客服详情必须给出会话入口，且入口指向投诉自己的订单
  const created = await submitComplaint({ orderId: ORDER_WITH_CONVERSATION });
  const detail = await getStaffComplaintDetail(created.complaintId, undefined, SURFACE);

  assert.ok(detail);
  assert.equal(detail.orderId, ORDER_WITH_CONVERSATION);
  assert.equal(
    detail.conversationOrderId,
    ORDER_WITH_CONVERSATION,
    "有关联会话时，会话入口没有指向投诉的订单",
  );
  assert.ok(await getMessageRepository().findConversationForStaff(ORDER_WITH_CONVERSATION));
});

test("跨角色闭环：客服开始处理 → 客服解决 → 用户看到「已处理」与处理结果", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const created = await submitComplaint();

  // —— 5. 客服开始处理 → 用户侧变成「处理中」
  const started = await startProcessingStaffComplaint(created.complaintId, staff, {
    idempotencyKey: key(),
  });
  assert.equal(started.changed, true);
  assert.equal(started.status, "processing");

  const processing = await getComplaintDetailForUser(
    created.complaintId,
    USER_A,
    undefined,
    SURFACE,
  );
  assert.equal(processing.status, "processing", "客服开始处理后用户没有看到「处理中」");
  assert.ok(processing.processingAt);

  // —— 6. 客服解决 → 用户侧变成「已处理」，且处理结果送到了用户手上
  const RESULT_TEXT = "已核实护航记录，按平台规则补偿，订单不再继续。";
  const resolved = await resolveStaffComplaint(created.complaintId, staff, {
    idempotencyKey: key(),
    result: RESULT_TEXT,
  });
  assert.equal(resolved.changed, true);
  assert.equal(resolved.status, "resolved");

  const done = await getComplaintDetailForUser(created.complaintId, USER_A, undefined, SURFACE);
  assert.equal(done.status, "resolved", "客服解决后用户没有看到「已处理」");
  assert.equal(done.result, RESULT_TEXT, "客服填写的处理结果没有到用户手上");
  assert.ok(done.handledAt);

  // 终态：客服侧不再给任何动作（用户看到的结束状态要和服务端判定一致）
  const finalDetail = await getStaffComplaintDetail(created.complaintId, undefined, SURFACE);
  assert.deepEqual(finalDetail.allowedActions, {
    canStartProcessing: false,
    canResolve: false,
    canClose: false,
  });
});

test("跨角色：投诉处理不写订单——用户那一单在客服处理前后一个字段都没变", async () => {
  const staff = await staffSessionOf(STAFF_A);
  const created = await submitComplaint();

  // 取**字符串快照**而不是对象引用：仓储若原地改写对象，引用比较会永远相等，
  // 这条断言就成了摆设（与同目录「订单指纹」用例同一做法）。
  const fingerprint = async () =>
    JSON.stringify(await getPaymentRepository().findOrderById(ORDER_FOR_COMPLAINT));

  const before = await fingerprint();
  await startProcessingStaffComplaint(created.complaintId, staff, { idempotencyKey: key() });
  await resolveStaffComplaint(created.complaintId, staff, {
    idempotencyKey: key(),
    result: "已核实。",
  });
  const after = await fingerprint();

  assert.equal(after, before, "处理投诉动了订单");
});

test("跨角色：用户提交退款 → 客服默认列表收到，且订单与申请人都在", async () => {
  const created = await createRefundForOrder(
    ORDER_FOR_REFUND,
    USER_A,
    {
      reasonKey: "schedule_conflict",
      description: "跨角色回归：临时有事，这一单打不了了。",
      evidence: [],
      idempotencyKey: key(),
    },
    undefined,
    SURFACE,
  );
  assert.equal(created.created, true, "用户提交退款没有真正落库");

  const params = new URLSearchParams();
  const query = resolveStaffRefundListQuery(params, false);
  const list = await listStaffRefunds(query, params, SURFACE);

  const row = list.items.find((item) => item.id === created.refundId);
  assert.ok(row, "客服退款列表（默认「待审核」筛选）里没有收到用户刚提交的申请");
  assert.equal(row.status, "pending");
  assert.equal(row.orderId, ORDER_FOR_REFUND, "退款的订单关联在客服侧丢失了");
  assert.equal(row.user.id, USER_A);

  // 申请退款不改订单状态（退款申请与订单是两条独立的线）
  const order = await getPaymentRepository().findOrderById(ORDER_FOR_REFUND);
  assert.equal(row.orderStatus, order.status);
  assert.equal(row.productTitle, order.productTitle);
});

/**
 * 浏览器取数那一半：**请求要说什么，服务端就得听成什么**。
 *
 * 这一段守的是一次真实的口径错位：客户端曾把「全部」编码成「不传 status」，
 * 而服务端把「没有 status」读作**默认筛选（待处理）**。于是筛选栏写着「全部」、
 * 列表里只有待处理——客服按状态去找一条已处理的投诉，会得出「没有这条投诉」的
 * 错误结论。两个模块各自都对，错的是它们之间的约定，所以这里把两端**接起来**断言：
 * 客户端拼出来的查询串，喂给服务端自己的解析函数，必须还原成客户端想表达的那个筛选。
 *
 * ⚠️ 能这样测是因为 `lib/services/staffComplaintsHttp.ts` **不含 JSX**
 * （纯取值函数）；真正渲染的部分本仓库测不了，见文件头说明。
 */
test("浏览器拼的查询串与服务端解析口径一致：「全部」不能被发成「不传」", async () => {
  // 前提：不传 status 会被读成默认筛选「待处理」——这正是不能省略它的原因
  assert.equal(readStaffComplaintStatusFilter(null), DEFAULT_STAFF_COMPLAINT_STATUS_FILTER);
  assert.equal(DEFAULT_STAFF_COMPLAINT_STATUS_FILTER, "pending");

  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    captured.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [], page: 1, pageSize: 20, total: 0, hasMore: false } }),
    };
  };

  try {
    await fetchStaffComplaints({ status: "all", type: "all", keyword: "", page: 1 });
    await fetchStaffComplaints({ status: "processing", type: "payment_issue", page: 2 });
    await fetchStaffRefunds({ status: "all", page: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const queryOf = (url) => new URL(url, "http://localhost").searchParams;

  // 1. 「全部」显式发出，且服务端读回来还是「全部」（不是待处理）
  const all = queryOf(captured[0]);
  assert.equal(all.get("status"), "all", "「全部」被编码成了「不传 status」");
  assert.equal(readStaffComplaintStatusFilter(all.get("status")), "all");
  assert.equal(readStaffComplaintTypeFilter(all.get("type")), "all");

  // 2. 具体筛选值与分页原样传达
  const page2 = queryOf(captured[1]);
  assert.equal(readStaffComplaintStatusFilter(page2.get("status")), "processing");
  assert.equal(readStaffComplaintTypeFilter(page2.get("type")), "payment_issue");
  assert.equal(page2.get("page"), "2");

  // 3. 退款侧同一口径（它一直是显式发送的，这里钉住，防止将来被改成省略）
  const refundAll = queryOf(captured[2]);
  assert.equal(refundAll.get("status"), "all");
  assert.equal(readStaffRefundStatusFilter(refundAll.get("status")), "all");
});
