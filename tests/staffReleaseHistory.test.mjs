import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { COMPANION_RELEASE_SOURCE_LABELS, plusMinutes } from "../lib/constants/dispatch.ts";
import { toStaffCompanionReleaseEntry } from "../lib/constants/staff.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { cancelAcceptedOrder, startCompanionOrder } from "../lib/data/companionOrderTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { appendCompanionRelease } from "../lib/data/mockCompanionReleaseRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { createPaymentRequest, confirmPaymentRequest } from "../lib/services/checkout.ts";
import { createComplaintForUser } from "../lib/services/complaints.ts";
import { sendMessageForUser } from "../lib/services/conversations.ts";
import { createRefundForOrder } from "../lib/services/refunds.ts";
import { getStaffComplaintDetail } from "../lib/services/staffComplaints.ts";
import { getStaffConversationDetail } from "../lib/services/staffConversations.ts";
import { getStaffRefundDetail } from "../lib/services/staffRefunds.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * 客服视野里的**履约退出历史**（P0-6，`StaffCompanionReleaseEntry`）的持续测试。
 *
 * ## 这一批要钉住的是什么
 *
 * 打手在 `accepted` 阶段主动取消接单之后，订单上的 `actualCompanionId` / `companion`
 * 被清空（订单必须能重新进公共池），于是「谁曾经接过、为什么走、什么时候走」
 * 只剩退出历史这一份记录答得出来（`EX-SERVICE-01`：「客服/管理员可在订单详情查看取消记录」）。
 *
 * P0-6 修复批次**没有新增任何 Staff API 路由**，而是把这份历史挂到客服**已经在用的
 * 三个只读详情接口**的 DTO 上（会话 / 投诉 / 退款）。因此这一批真正要保护的是：
 *
 * 1. **三个 DTO 说的是同一件事**——同一张单在三处读出的条目必须逐字段相同，
 *    否则「客服在会话页看到的」与「客服在退款页看到的」会分叉；
 * 2. **字段集是边界**：条目恰好 6 个字段，**不含** `id` / `actorId` / `orderId`，
 *    也**不含任何金额**——少一个字段就少一条泄漏路径（`01-prompt.md` §三、D6 V3）；
 * 3. **恒为数组**：没有退出过是 `[]`，不是 `null`——那是正常情况，不是「查不到」；
 * 4. **名字靠现查、查不到回落 id、永不留空串**：记录里**没有**名字快照（7 字段冻结），
 *    因此「显示得出名字」这件事完全依赖 `findCompanionById()` 查得到**已移除**的资料；
 * 5. **顺序与条数原样透传**：客服层不排序、不按 `companionId` 合并、不覆盖旧记录；
 * 6. **它不改变任何既有语义**：投诉在订单查不到时仍可读、退款仍返回 `null`、
 *    「订单存在但没聊过」的会话仍然读不到——多取一份数据不得变成一个新的入口；
 * 7. **只读**：写退出历史的路径全仓只有 `lib/data/companionOrderTransaction.ts` 一处，
 *    客服侧连一个写原语都碰不到。
 *
 * ## 素材怎么造
 *
 * - 「真实链路」类用例走完整下单 → 接单 → 取消（`cancelAcceptedOrder` 显式传 `at`，
 *   与 `tests/companionOrders.test.mjs` 同一手法），因此用的是**真的**写入器；
 * - 「资料查不到」「同一人退出两次且时刻乱序」这类状态由 `appendCompanionRelease()`
 *   直接构造——它是全仓唯一的写原语，测试里用它只为摆出场景，不代表业务规则；
 * - 平台参数（公共池超时）用预置值 60 分钟，本文件一次都不等真实时间。
 *
 * ## 用例之间怎么隔离
 *
 * `beforeEach` 重建 `companionRelease`（本文件所有断言的对象）以及三个 DTO 的取数来源。
 * 订单 store 一律重建：本文件既读预置订单，也自己下单，起点必须是同一份预置数据。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF_DIR = path.join(ROOT, "app", "staff");
const STAFF_API_DIR = path.join(ROOT, "app", "api", "staff");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的两位（`enabled` / `available` 均为真、未移除）。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

const STAFF_A = "staff-1";

/** 预置订单：有会话，因此会话详情读得到。 */
const ORDER_WITH_CONVERSATION = "ord-seed-1001-04";
/** 预置订单：属于 u-1001，但**没有任何会话**。 */
const ORDER_WITHOUT_CONVERSATION = "ord-seed-1001-02";
/** 预置投诉：关联订单 ord-seed-1001-12。 */
const COMPLAINT_WITH_ORDER = "cmp-seed-1001-02";
/** 预置投诉：**未关联任何订单**（`orderId === null`）。 */
const COMPLAINT_WITHOUT_ORDER = "cmp-seed-1001-04";
/** 预置退款：待审核，关联订单 ord-seed-1001-03。 */
const REFUND_WITH_ORDER = "rf-seed-1001-01";

const ORDER_OF_COMPLAINT = "ord-seed-1001-12";
const ORDER_OF_REFUND = "ord-seed-1001-03";

/** 条目的六个字段。多一个少一个都在这里现形。 */
const RELEASE_ENTRY_KEYS = [
  "companionId",
  "companionName",
  "createdAt",
  "reason",
  "source",
  "sourceLabel",
];

const REASON = "临时有事无法服务";

/**
 * 清单本身**必须逐字钉住**，不能被改宽。
 *
 * `RELEASE_ENTRY_KEYS` 是三处 `assert.deepEqual(Object.keys(entry).sort(), RELEASE_ENTRY_KEYS)`
 * 的**唯一**期望值。若有人把它改成「至少包含这六个」这类弱断言（或往里加字段），
 * 那三处会一起失去保护力，而**任何一处都不会变红**——这正是「三条不变量看似有三层
 * 保护、实际只剩零层」的典型路径。所以清单本身也要有一条用例守着。
 */
test("字段清单本身被钉死：恰好六个名字，且不含金额或内部标识", () => {
  assert.deepEqual(
    RELEASE_ENTRY_KEYS,
    ["companionId", "companionName", "createdAt", "reason", "source", "sourceLabel"],
    "条目字段清单被改动了：三处 deepEqual 都靠它，改它等于改全部断言",
  );
  for (const name of RELEASE_ENTRY_KEYS) {
    assert.equal(
      /amount|income|rate|bp|price|fee|net|money|salary|paid|^id$|actorId/i.test(name),
      false,
      `客服视野里的条目不该出现 ${name}`,
    );
  }
});

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function key() {
  return crypto.randomUUID();
}

async function placeOrder(user, overrides = {}) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "rel_test",
      remark: "",
      companionId: null,
      ...overrides,
      idempotencyKey: key(),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return confirmed.order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

/** 一张由 `companionId` 接下的新订单；`acceptedAt` 由下单时刻推算，不依赖真实执行时间。 */
async function acceptedOrder(companionId, user) {
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const acceptedAt = plusMinutes(order.paidAt, 1);
  const result = await acceptDispatch(dispatch.id, { companionId, at: acceptedAt });
  assert.equal(result.kind, "ok", "这条用例需要一次成功的接单");
  return { order, dispatchId: dispatch.id, acceptedAt };
}

function releasesOf(orderId) {
  return getCompanionReleaseRepository().listReleasesByOrderId(orderId);
}

/**
 * 直接写一条退出历史（摆场景用）。
 *
 * 它是全仓唯一的写原语，正常链路上**只有** `cancelAcceptedOrder` 调它；
 * 这里用它构造「护航资料已不存在」「同一人退出两次且时刻乱序」这类
 * 光靠真实链路摆不出来的状态。
 */
function appendRelease(overrides = {}) {
  return appendCompanionRelease({
    orderId: ORDER_WITH_CONVERSATION,
    companionId: COMPANION_A,
    source: "companion_cancel",
    reason: REASON,
    actorId: COMPANION_A,
    createdAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  });
}

/** 递归收集一个 DTO 上出现过的所有键（含嵌套对象与数组元素）。 */
function collectKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [name, nested] of Object.entries(value)) {
      found.add(name);
      collectKeys(nested, found);
    }
  }
  return found;
}

/** 预置护航的展示名（从仓储现查，不把种子里的字符串抄进断言）。 */
async function displayNameOf(companionId) {
  const companion = await getCompanionRepository().findCompanionById(companionId);
  assert.ok(companion, `预置护航缺失：${companionId}`);
  return companion.displayName;
}

/**
 * 重建这一批关心的 store。
 *
 * `companionRelease` 没有预置数据，重建即「这一单还没有人退出过」；
 * 订单 / 派单 / 投诉 / 退款 / 消息重建是为了让每条用例从同一份预置数据出发——
 * 本文件既有用例会下单，也有用例直接往 store 里加记录。
 */
beforeEach(() => {
  resetMockStore("companionRelease");
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("message");
  resetMockStore("complaint");
  resetMockStore("refund");
  resetMockStore("companion");
});

// ————————————————— 一、三个 DTO 说的是同一件事 —————————————————

/**
 * 一次真实取消，然后**三处各读一次**。
 *
 * 这条用例是本文件的骨架：它同时验证「条目内容正确」「三个 DTO 完全一致」
 * 「字段集恰好六个」「没有金额与内部字段」。任何一处口径被改写（例如投诉详情
 * 自己排一次序、退款详情少查一次名字），都会在这里现形。
 */
test("三处读出同一条历史：真实取消的条目在会话 / 投诉 / 退款详情里逐字段相同", async () => {
  const user = unique("u-rel");
  const { order } = await acceptedOrder(COMPANION_A, user);

  // —— 第一次退出：A ——
  const firstAt = plusMinutes(order.paidAt, 5);
  const first = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason: "第一次退出",
    idempotencyKey: key(),
    at: firstAt,
  });
  assert.equal(first.kind, "ok");

  // —— 第二个人从公共池接走，然后他也退出：同一张单上留下两条 ——
  const dispatch = await dispatchOf(order.id);
  const secondAcceptedAt = plusMinutes(firstAt, 1);
  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_B, at: secondAcceptedAt });
  assert.equal(accepted.kind, "ok");
  const secondAt = plusMinutes(secondAcceptedAt, 1);
  const second = await cancelAcceptedOrder({
    companionId: COMPANION_B,
    orderId: order.id,
    reason: "第二次退出",
    idempotencyKey: key(),
    at: secondAt,
  });
  assert.equal(second.kind, "ok");

  // 三个客服入口各需要一份自己的前置数据：一条消息（会话）、一条投诉、一条退款申请。
  // 全部走用户侧的真实服务，因此这三处 DTO 里的订单确实是同一张单。
  //
  // ⚠️ 退款申请这一步有个 P0-12 带来的前置：**已付款 / 已接单不能申请退款**
  // （那两档「尚未开始服务」，改为免审批直接全额退款）。两次取消之后订单回到了
  // 已付款，所以必须先把这一单推到护航中——第三次接单 + 打手点击开始服务，
  // 走的仍是真实链路，而不是往 store 里塞一条申请记录。
  // 这两步**不产生退出历史**，下面「退出过两次就是两条」的断言因此不受影响。
  const thirdAcceptedAt = plusMinutes(secondAt, 1);
  const third = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_B,
    at: thirdAcceptedAt,
  });
  assert.equal(third.kind, "ok", "这一条用例需要订单能重新被接走");
  const started = await startCompanionOrder({
    companionId: COMPANION_B,
    orderId: order.id,
    at: plusMinutes(thirdAcceptedAt, 1),
  });
  assert.equal(started.kind, "ok", "这一条用例需要订单进入护航中，申请退款才走得通");
  await sendMessageForUser(user, order.id, { body: "这一单怎么又没人了？", idempotencyKey: key() }, undefined, "server");
  const complaint = await createComplaintForUser(
    user,
    {
      orderId: order.id,
      typeKey: "companion_service",
      description: "接单的人换了两次，想知道中间发生了什么。",
      contact: "",
      evidence: [],
      idempotencyKey: key(),
    },
    undefined,
    "server",
  );
  const refund = await createRefundForOrder(
    order.id,
    user,
    {
      reasonKey: "other",
      description: "服务没开始就没人了，申请退款。",
      evidence: [],
      idempotencyKey: key(),
    },
    undefined,
    "server",
  );
  assert.equal(refund.created, true);

  const conversation = await getStaffConversationDetail(STAFF_A, order.id, undefined, "server");
  const complaintDetail = await getStaffComplaintDetail(complaint.complaintId, undefined, "server");
  const refundDetail = await getStaffRefundDetail(refund.refundId, undefined, "server");
  assert.ok(conversation && complaintDetail && refundDetail, "三处详情都必须读得到");

  const fromConversation = conversation.order.releaseHistory;
  const fromComplaint = complaintDetail.orderSummary.releaseHistory;
  const fromRefund = refundDetail.releaseHistory;

  // 三处逐字段相同：这不是「都非空」，而是**同一个数组**
  assert.deepEqual(fromComplaint, fromConversation, "投诉详情的退出历史必须与会话详情一致");
  assert.deepEqual(fromRefund, fromConversation, "退款详情的退出历史必须与会话详情一致");

  assert.equal(fromConversation.length, 2, "退出过两次就是两条，不合并");
  assert.deepEqual(
    fromConversation.map((entry) => [entry.companionId, entry.createdAt, entry.reason]),
    [
      [COMPANION_A, firstAt, "第一次退出"],
      [COMPANION_B, secondAt, "第二次退出"],
    ],
    "按退出时间正序，先退的人在前",
  );

  const [firstEntry, secondEntry] = fromConversation;
  assert.equal(firstEntry.companionName, await displayNameOf(COMPANION_A));
  assert.equal(secondEntry.companionName, await displayNameOf(COMPANION_B));
  for (const entry of fromConversation) {
    assert.equal(entry.source, "companion_cancel");
    assert.equal(
      entry.sourceLabel,
      COMPANION_RELEASE_SOURCE_LABELS.companion_cancel,
      "标签只来自那一张表，客服侧不自己映射",
    );

    // 字段集就是边界：恰好六个，一个不多一个不少。
    // ⚠️ 这一条**独自**就蕴含了「没有 id / actorId / orderId」与「没有金额字段」——
    // 所以下面**不再**跟着写「逐字段 `in` 检查」「正则扫金额名」那两段：
    // 它们是恒真的（键集既已被钉死，任何被点名的字段都不可能还在），
    // 写了只会让人以为这一段有三层保护。真正需要防的是**清单本身被削弱**，
    // 那由 `RELEASE_ENTRY_KEYS` 的字面量断言承担（见本文件顶部那条用例）。
    assert.deepEqual(Object.keys(entry).sort(), RELEASE_ENTRY_KEYS, "条目字段集变了");
  }

  // 条目与仓储里的记录一一对应：客服层没有丢记录、也没有多造一条
  const records = await releasesOf(order.id);
  assert.deepEqual(
    fromConversation.map((entry) => [entry.companionId, entry.createdAt, entry.reason]),
    records.map((record) => [record.companionId, record.createdAt, record.reason]),
  );

  // 上游记录的字段集**没有**任何 deepEqual 兜底，因此这里是真的在查：
  // 退出历史与钱无关（本轮不退款、不罚款、不扣减收益），也不该长出内部标识。
  // 若哪天真给 CompanionReleaseRecord 加了金额字段，这条会红——那正是要有人来解释的时刻。
  for (const record of records) {
    for (const name of Object.keys(record)) {
      assert.equal(
        /amount|income|rate|bp|price|fee|net|money|salary|paid/i.test(name),
        false,
        `退出历史与钱无关，不该出现 ${name}`,
      );
    }
  }
});

test("恒为数组：没有退出过时三个 DTO 给的都是 []，不是 null / undefined", async () => {
  const conversation = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  const complaint = await getStaffComplaintDetail(COMPLAINT_WITH_ORDER, undefined, "server");
  const refund = await getStaffRefundDetail(REFUND_WITH_ORDER, undefined, "server");

  assert.ok(conversation && complaint && refund, "三处详情都必须读得到");
  assert.ok(complaint.orderSummary, "这条投诉关联的订单必须读得到，否则测的不是空数组");
  assert.deepEqual(complaint.orderSummary.orderNo, "YM20260830000112");

  for (const [name, history] of [
    ["会话详情", conversation.order.releaseHistory],
    ["投诉详情的订单摘要", complaint.orderSummary.releaseHistory],
    ["退款详情", refund.releaseHistory],
  ]) {
    assert.equal(Array.isArray(history), true, `${name} 的 releaseHistory 必须是数组`);
    assert.deepEqual(history, [], `${name} 没有退出过时必须是空数组`);
  }

  // 素材本身要成立：这三张单确实一条退出记录都没有
  for (const orderId of [ORDER_WITH_CONVERSATION, ORDER_OF_COMPLAINT, ORDER_OF_REFUND]) {
    assert.deepEqual(await releasesOf(orderId), []);
  }
});

/**
 * 三处一致性的**素材缝隙**补丁。
 *
 * 三处 deepEqual 对比用的历史全部由 `cancelAcceptedOrder` 造出，source 恒为
 * `companion_cancel`。因此如果哪天有人在某一个 `releaseHistoryFor` 里顺手加一句
 * `records.filter((r) => r.source === "companion_cancel")`，**三处对比不会变红**——
 * 而「三处说的是同一件事」这条不变量那天就失效了。
 *
 * 这里用 `appendCompanionRelease` 造一条 `staff_reassign`（目前还没有写入路径，
 * 但标签表里已有取值），三处各读一次：任何一处按 source 收窄，都会在这里少一条。
 * ⚠️ 只断言「照原样透出」，**不**断言「客服改派会写一条退出历史」——后者尚无产品规则。
 */
test("非 companion_cancel 的 source 也照原样透出：任何一处按 source 收窄都会现形", async () => {
  const reasonFor = {
    [ORDER_WITH_CONVERSATION]: "客服改派：会话这一侧",
    [ORDER_OF_COMPLAINT]: "客服改派：投诉这一侧",
    [ORDER_OF_REFUND]: "客服改派：退款这一侧",
  };
  for (const [orderId, reason] of Object.entries(reasonFor)) {
    appendRelease({ orderId, source: "staff_reassign", reason });
  }

  const conversation = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  const complaint = await getStaffComplaintDetail(COMPLAINT_WITH_ORDER, undefined, "server");
  const refund = await getStaffRefundDetail(REFUND_WITH_ORDER, undefined, "server");
  assert.ok(conversation && complaint && refund, "三处详情都必须读得到");
  assert.ok(complaint.orderSummary, "这条投诉关联的订单必须读得到");

  for (const [name, history, orderId] of [
    ["会话详情", conversation.order.releaseHistory, ORDER_WITH_CONVERSATION],
    ["投诉详情的订单摘要", complaint.orderSummary.releaseHistory, ORDER_OF_COMPLAINT],
    ["退款详情", refund.releaseHistory, ORDER_OF_REFUND],
  ]) {
    assert.deepEqual(
      history.map((entry) => [entry.source, entry.reason]),
      [["staff_reassign", reasonFor[orderId]]],
      `${name} 少了一条非 companion_cancel 的退出记录——是不是有人按 source 收窄了？`,
    );
    assert.equal(
      history[0].sourceLabel,
      COMPANION_RELEASE_SOURCE_LABELS.staff_reassign,
      `${name} 的标签必须来自那一张表`,
    );
  }
});

// ————————————————— 二、名字 —————————————————

test("名字回落：护航资料查不到时用 companionId，**永不留空串**", async () => {
  const missing = unique("cp-根本没有这条资料");
  // 素材先成立：这个 id 在护航仓储里确实查不到
  assert.equal(await getCompanionRepository().findCompanionById(missing), null);

  appendRelease({ companionId: missing, reason: "资料已经被彻底删除的那位退出了" });

  const detail = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  assert.ok(detail);
  const [entry] = detail.order.releaseHistory;

  assert.equal(entry.companionId, missing);
  assert.equal(entry.companionName, missing, "查不到资料时回落到 companionId：页面上仍要看得出退出的是哪一位");
  assert.notEqual(entry.companionName, "", "空名字会让那一行看起来像界面坏了");
  // 回落之后仍然是六个字段：回落不是加字段
  assert.deepEqual(Object.keys(entry).sort(), RELEASE_ENTRY_KEYS);
});

test("已移除的护航仍解析得出名字：历史事实不因资料下架而消失", async () => {
  const created = await getCompanionRepository().createCompanion({
    id: unique("cp-rel"),
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "已下架的护航（占位）",
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
  const companionId = created.companion.id;

  // 用后台那条真实的软移除入口？这里走仓储的同一个写原语，避免把审计表牵进来
  const removed = await getCompanionRepository().markCompanionRemoved(companionId, "2026-09-19T00:00:00.000Z");
  assert.ok(removed);
  assert.equal(removed.updated.removedAt, "2026-09-19T00:00:00.000Z");

  // 口径先核实：**已移除的记录照样查得到**，因此名字推导得出来
  const reread = await getCompanionRepository().findCompanionById(companionId);
  assert.ok(reread, "已移除不等于查不到：历史订单、评价都要继续指得到这条资料");
  assert.notEqual(reread.removedAt, null);
  assert.equal(reread.displayName, "已下架的护航（占位）");

  appendRelease({ companionId, reason: "资料下架之前退出的那一次" });

  const detail = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  assert.ok(detail);
  const [entry] = detail.order.releaseHistory;
  assert.equal(entry.companionId, companionId);
  assert.equal(
    entry.companionName,
    "已下架的护航（占位）",
    "下架之后客服仍要答得出「当时是谁接的」，名字不能变成 id 或空白",
  );
});

// ————————————————— 三、顺序与条数 —————————————————

test("顺序就是仓储顺序、同一人退出两次是两条：客服层不排序、不按人合并、不覆盖", async () => {
  const nameOfA = await displayNameOf(COMPANION_A);
  assert.equal(await displayNameOf(COMPANION_B).then((name) => name.length > 0), true);

  // 写入顺序**故意与时刻顺序相反**：若客服层另排一次、或按人合并，这里都会现形
  appendRelease({ companionId: COMPANION_A, createdAt: "2026-09-20T12:00:00.000Z", reason: "第三次" });
  appendRelease({ companionId: COMPANION_A, createdAt: "2026-09-20T10:00:00.000Z", reason: "第一次" });
  appendRelease({ companionId: COMPANION_B, createdAt: "2026-09-20T11:00:00.000Z", reason: "第二次" });

  const records = await releasesOf(ORDER_WITH_CONVERSATION);
  assert.equal(records.length, 3, "写进去三条就要有三条");

  const detail = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  assert.ok(detail);
  const history = detail.order.releaseHistory;

  assert.deepEqual(
    history.map((entry) => [entry.companionId, entry.createdAt, entry.reason]),
    records.map((record) => [record.companionId, record.createdAt, record.reason]),
    "DTO 必须是仓储输出的原样映射：顺序、条数都不再加工",
  );
  assert.deepEqual(
    history.map((entry) => entry.reason),
    ["第一次", "第二次", "第三次"],
    "按时刻正序，而不是写入顺序",
  );

  // 同一位护航的两条都在：名字缓存按 id 去重，**记录**一条都不能少
  const samePerson = history.filter((entry) => entry.companionId === COMPANION_A);
  assert.equal(samePerson.length, 2, "同一个人退出两次就是两条，不合并");
  assert.deepEqual(samePerson.map((entry) => entry.reason), ["第一次", "第三次"]);
  assert.equal(samePerson.every((entry) => entry.companionName === nameOfA), true);
});

// ————————————————— 四、不改既有语义 —————————————————

test("投诉：订单查不到 / 未关联订单时投诉仍然可读，退出历史不会因此开出一条新路", async () => {
  const danglingOrderId = unique("ord-rel-查不到");
  const privateReason = unique("内部退出原因");

  // 这一单查不到，但它**有**一条退出历史：若详情顺手把历史当成订单是否存在的依据，
  // 就会多出一条「拿构造出的 orderId 试探」的通道
  appendRelease({ orderId: danglingOrderId, reason: privateReason, companionId: COMPANION_A });

  // (a) 未关联订单的预置投诉：本来就该完整可读
  const withoutOrder = await getStaffComplaintDetail(COMPLAINT_WITHOUT_ORDER, undefined, "server");
  assert.ok(withoutOrder, "未关联订单的投诉必须完整可读");
  assert.equal(withoutOrder.orderSummary, null);
  assert.equal(Object.hasOwn(withoutOrder, "releaseHistory"), false, "退出历史只随订单摘要出现，不是顶层字段");

  // (b) 关联的订单查不到：同样完整可读——为了一条查不到的订单把整条投诉变成 404，
  //     会让客服连用户写了什么都看不到
  const complaintId = unique("cmp-rel");
  const now = "2026-09-20T09:00:00.000Z";
  const created = await getComplaintRepository().createComplaint(
    {
      id: complaintId,
      complaintNo: `TS-REL-${process.pid}`,
      userId: "u-1001",
      orderId: danglingOrderId,
      orderNo: null,
      status: "pending",
      typeKey: "other",
      typeLabel: "其他",
      description: "构造出的存储异常：关联订单查不到。",
      evidence: [],
      contact: "",
      createdAt: now,
      updatedAt: now,
      processingAt: null,
      handledAt: null,
      handledById: null,
      handledByRole: null,
      handledByName: null,
      result: "",
    },
    key(),
  );
  assert.equal(created.created, true);

  const dangling = await getStaffComplaintDetail(complaintId, undefined, "server");
  assert.ok(dangling, "关联订单查不到的投诉不能变成 404");
  assert.equal(dangling.orderSummary, null);
  assert.equal(Object.hasOwn(dangling, "releaseHistory"), false);
  assert.equal(
    JSON.stringify(dangling).includes(privateReason),
    false,
    "订单都读不到时，退出历史一个字都不该漏出来",
  );
  assert.equal(JSON.stringify(dangling).includes(COMPANION_A), false);
});

test("退款：订单查不到的退款仍然是 null（404），退出历史不会把它变成可读", async () => {
  const danglingOrderId = unique("ord-rel-退款查不到");
  const privateReason = unique("退款这条也该藏住的原因");
  appendRelease({ orderId: danglingOrderId, reason: privateReason });

  // 不存在的退款：仍然是 null（页面 notFound()）
  assert.equal(await getStaffRefundDetail(unique("rf-rel-不存在"), undefined, "server"), null);
  assert.equal(await getStaffRefundDetail("", undefined, "server"), null);

  const refundId = unique("rf-rel");
  const now = "2026-09-20T09:30:00.000Z";
  const created = await getRefundRepository().createRefundRequest(
    {
      id: refundId,
      refundNo: `TK-REL-${process.pid}`,
      userId: "u-1001",
      orderId: danglingOrderId,
      status: "pending",
      amount: 2990,
      reasonKey: "other",
      reasonLabel: "其他原因",
      description: "构造出的存储异常：关联订单查不到。",
      evidence: [],
      createdAt: now,
      updatedAt: now,
      reviewingAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewedByRole: null,
      reviewedByName: null,
      reviewNote: "",
      cancelledAt: null,
    },
    key(),
  );
  assert.equal(created.ok, true);

  assert.equal(
    await getStaffRefundDetail(refundId, undefined, "server"),
    null,
    "订单查不到就是不可读：多取一份退出历史不得改变这条结论",
  );
});

test("会话：没有聊过的订单仍然读不到，退出历史不是旁路入口", async () => {
  const reason = unique("旁路试探用的原因");

  // 素材先成立：这张单确实存在、属于 u-1001，但一条会话都没有
  const order = await getPaymentRepository().findOrderById(ORDER_WITHOUT_CONVERSATION);
  assert.ok(order, "预置订单缺失");
  assert.equal(order.userId, "u-1001");

  // 给它写一条退出历史：会话详情的判定顺序不能因为「这一单有过退出」而变
  appendRelease({ orderId: ORDER_WITHOUT_CONVERSATION, reason });

  const neverChatted = await getStaffConversationDetail(STAFF_A, ORDER_WITHOUT_CONVERSATION, undefined, "server");
  assert.equal(neverChatted, null, "客服只能访问存在会话的订单：退出历史不得成为第二条进入路径");

  // 不存在的订单同样如此（哪怕它也被写了一条历史）
  const missing = unique("ord-rel-没有这一单");
  appendRelease({ orderId: missing, reason });
  assert.equal(await getStaffConversationDetail(STAFF_A, missing, undefined, "server"), null);

  // 三种情形必须完全无法区分，否则订单号可以被逐个试探
  assert.equal(neverChatted, await getStaffConversationDetail(STAFF_A, missing, undefined, "server"));
});

// ————————————————— 五、只读与唯一转换点 —————————————————

/**
 * 结构约束：**写退出历史的路径全仓只有一条**。
 *
 * 补一个只读展示面最容易顺手做的事，就是给客服侧也开一个「能写点什么」的口子
 * （哪怕只是「客服可以补一句备注」）。这条断言让那件事在结构上做不到：
 * 三个客服服务连写原语的名字都不出现，仓储接口上也只有一个读方法。
 */
test("只读：写退出历史的路径只有 companionOrderTransaction 一处，客服侧连写原语都碰不到", () => {
  const WRITE_PRIMITIVES = ["appendCompanionRelease", "bindCompanionReleaseKey", "companionReleaseStore"];

  const sources = [
    ...collectFiles(path.join(ROOT, "lib")).filter((file) => file.endsWith(".ts")),
    ...collectFiles(path.join(ROOT, "app")).filter((file) => /\.tsx?$/.test(file)),
  ].map((file) => ({
    relative: path.relative(ROOT, file).replace(/\\/g, "/"),
    code: stripComments(readSource(file)),
  }));

  // 去掉注释后再找：文档注释里说明「这里不写 X」不算调用 X
  const callers = sources
    .filter((file) => WRITE_PRIMITIVES.some((name) => file.code.includes(name)))
    .map((file) => file.relative)
    .sort();

  assert.deepEqual(
    callers,
    ["lib/data/companionOrderTransaction.ts", "lib/data/mockCompanionReleaseRepository.ts"],
    "新增一条写退出历史的路径就等于新增一处没有原子区段、没有幂等索引的入口",
  );

  // 仓储接口上**只有**读方法：接口上开一个 create 就等于开出第二条写入路径
  assert.deepEqual(
    Object.keys(getCompanionReleaseRepository()).sort(),
    ["listReleasesByOrderId"],
    "退出历史仓储只有只读方法",
  );

  // 客服侧（服务 + 页面 + 接口）一律不 import 写原语所在的模块
  const staffSources = [
    ...collectFiles(STAFF_DIR),
    ...collectFiles(STAFF_API_DIR),
    path.join(ROOT, "lib", "services", "staffConversations.ts"),
    path.join(ROOT, "lib", "services", "staffComplaints.ts"),
    path.join(ROOT, "lib", "services", "staffRefunds.ts"),
  ].filter((file) => /\.tsx?$/.test(file));

  for (const file of staffSources) {
    const code = stripComments(readSource(file));
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    assert.equal(
      code.includes("mockCompanionReleaseRepository"),
      false,
      `${relative} 不该引用退出历史的写原语模块`,
    );
    assert.equal(
      code.includes("companionOrderTransaction"),
      false,
      `${relative} 不该引用那条会写订单与派单的伪事务`,
    );
  }
});

test("空历史的两种相反取舍：客服侧整段不渲染，管理端写「无退出记录」——不许顺手统一", () => {
  // 组件渲染不出来（JSX 不剥离），但它**怎么对待空数组**是源码里的一句话，可以钉住。
  const staffComponent = stripComments(
    readSource(path.join(ROOT, "components", "staff", "StaffReleaseHistory.tsx")),
  );
  assert.match(
    staffComponent,
    /entries\.length === 0\)[^;]{0,24}return null/,
    "客服侧是作业面：绝大多数订单从没人退出过，占位文案出现得够频繁就会被当成装饰，真的退出过时同样被跳过",
  );

  // 管理端正好相反：审计视角要的是「查过了，没有」这个明确结论，一片空白区分不了「没有」与「没查」
  // 去掉注释再看：管理端**注释里**解释了这处不对称（提到客服侧组件的文件名），
  // 那是说明，不是引用——所以这一段的两个判断都必须在去注释后的源码上做
  const adminCode = stripComments(
    readSource(path.join(ROOT, "app", "admin", "(console)", "orders", "[id]", "page.tsx")),
  );
  assert.ok(adminCode.includes("无退出记录"), "管理端的空态是明确结论，不是留白");

  // 两处**刻意不同**：管理端不得借用客服侧那个「空则消失」的组件——
  // 借用的那一刻，两边的取舍就被顺手统一了
  assert.equal(
    adminCode.includes("StaffReleaseHistory"),
    false,
    "管理端不是复用客服侧组件，而是自己那段（它要的空态语义正好相反）",
  );

  // 客服侧那段是纯展示：不取数、不发请求、没有客户端指令
  for (const forbidden of ['"use client"', "fetch(", "useState"]) {
    assert.equal(
      staffComponent.includes(forbidden),
      false,
      `退出历史是只读展示，不该出现 ${forbidden}`,
    );
  }
});

test("唯一转换点：sourceLabel 只来自 COMPANION_RELEASE_SOURCE_LABELS，四个服务都不自己拼条目", () => {
  // P0-10 新增第四个调用方（客服订单详情也要显示退出历史）。
  // 这个清单**必须跟着涨**：少登记一个，就有一个服务可以偷偷自己拼条目而不被这条门禁拦住。
  for (const name of ["staffConversations", "staffComplaints", "staffRefunds", "staffOrders"]) {
    const code = stripComments(readSource(path.join(ROOT, "lib", "services", `${name}.ts`)));
    assert.ok(
      code.includes("toStaffCompanionReleaseEntry"),
      `${name} 必须走唯一转换点，而不是自己拼一个条目`,
    );
    assert.equal(
      code.includes("companionName"),
      false,
      `${name} 不该自己构造 companionName：回落规则只在那一个函数里`,
    );
    assert.equal(
      code.includes("COMPANION_RELEASE_SOURCE_LABELS"),
      false,
      `${name} 不该自己映射退出方式标签`,
    );
  }

  // 转换点本身只有一个定义处
  const definitions = collectFiles(path.join(ROOT, "lib"))
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => readSource(file).includes("export function toStaffCompanionReleaseEntry"));
  assert.deepEqual(
    definitions.map((file) => path.relative(ROOT, file).replace(/\\/g, "/")),
    ["lib/constants/staff.ts"],
  );

  // 标签表是**全取值**覆盖的：三个 source 都映射得出中文，不靠调用方兜底
  for (const source of ["companion_cancel", "companion_disabled", "staff_reassign"]) {
    const entry = toStaffCompanionReleaseEntry(
      {
        id: "rel-任意",
        orderId: "ord-任意",
        companionId: COMPANION_A,
        source,
        reason: null,
        actorId: null,
        createdAt: "2026-09-20T10:00:00.000Z",
      },
      "某位护航",
    );
    assert.equal(entry.sourceLabel, COMPANION_RELEASE_SOURCE_LABELS[source]);
    assert.ok(entry.sourceLabel.length > 0);
    assert.deepEqual(Object.keys(entry).sort(), RELEASE_ENTRY_KEYS);
  }

  // 回落到 id 这条规则**只在这一处**：构造函数的入参拿到空串时自己兜住
  const fallback = toStaffCompanionReleaseEntry(
    {
      id: "rel-任意",
      orderId: "ord-任意",
      companionId: "cp-查不到",
      source: "companion_cancel",
      reason: REASON,
      actorId: "cp-查不到",
      createdAt: "2026-09-20T10:00:00.000Z",
    },
    "",
  );
  assert.equal(fallback.companionName, "cp-查不到");
});

// ————————————————— 六、隐私边界没有被放开 —————————————————

/**
 * 三个 DTO 的既有边界（P8D-1 / P8D-2 冻结）在加上 `releaseHistory` 之后**必须原样保持**。
 *
 * 用递归收集键而不是逐字段点名：新增字段是这次改动最容易发生的副作用，
 * 而「新字段是否越界」只有把整棵树摊平才看得出。
 */
test("隐私边界未被放宽：三个 DTO 仍然没有游戏 ID、订单备注、用户 id、支付凭据与平台账目", async () => {
  // 三处的订单各写一条退出历史，确保检查的是**带着新载荷**的那份 DTO
  appendRelease({ orderId: ORDER_WITH_CONVERSATION, reason: REASON });
  appendRelease({ orderId: ORDER_OF_COMPLAINT, reason: REASON });
  appendRelease({ orderId: ORDER_OF_REFUND, reason: REASON });

  const conversation = await getStaffConversationDetail(STAFF_A, ORDER_WITH_CONVERSATION, undefined, "server");
  const complaint = await getStaffComplaintDetail(COMPLAINT_WITH_ORDER, undefined, "server");
  const refund = await getStaffRefundDetail(REFUND_WITH_ORDER, undefined, "server");
  assert.ok(conversation && complaint && refund);

  // 素材先成立：三条历史确实拿到了，而不是空数组轮空
  assert.equal(conversation.order.releaseHistory.length, 1);
  assert.equal(complaint.orderSummary.releaseHistory.length, 1);
  assert.equal(refund.releaseHistory.length, 1);

  const FORBIDDEN = [
    // 用户与订单隐私
    "userId",
    "gameAccountId",
    "remark",
    // 支付凭据
    "payCredential",
    "openId",
    "unionId",
    "sessionId",
    // 平台账目与分账
    "clubNetIncome",
    "platformNetIncome",
    "companionBaseIncome",
    "companionRateSnapshot",
    "companionRateBp",
    "refundedAmount",
    "actualPaidAmount",
    // 退出历史的内部字段（它只该以六个字段的形式出现在 releaseHistory 里）
    "actorId",
  ];

  for (const [name, dto] of [
    ["会话详情", conversation],
    ["投诉详情", complaint],
    ["退款详情", refund],
  ]) {
    const keys = collectKeys(dto);
    for (const forbidden of FORBIDDEN) {
      assert.equal(keys.has(forbidden), false, `${name} 不该出现 ${forbidden}`);
    }
  }

  // 反证：这三个 DTO 确实带着该带的字段，上面的「没有」不是因为什么都没取到
  assert.equal(collectKeys(conversation).has("releaseHistory"), true);
  assert.equal(collectKeys(complaint).has("releaseHistory"), true);
  assert.equal(collectKeys(refund).has("releaseHistory"), true);
  assert.equal(collectKeys(refund).has("amount"), true, "退款金额本身是客服要对账的，必须在");
});
