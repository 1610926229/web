import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assignmentKeyOf,
  canCompanionAccessConversation,
  compareConversationsWithinOrder,
  isCurrentAssignmentConversation,
  isOrderChatClosed,
  resolveAssignmentSeq,
  resolveCurrentAssignmentKey,
  segmentTitle,
  COMPANION_CHAT_HISTORY_NOTICE,
  COMPANION_CHAT_REFUNDED_NOTICE,
  COMPANION_MESSAGE_ROLE_LABELS,
  CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF,
  CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER,
  CONVERSATION_SEGMENT_HISTORY_NOTICE,
  CONVERSATION_SEGMENT_HISTORY_SUFFIX,
  CONVERSATION_SEGMENT_REFUNDED_NOTICE,
  CONVERSATION_SEGMENT_SERVICE_TITLE,
} from "../lib/constants/conversations.ts";
import {
  COMPANION_CHAT_READONLY_FOOTER,
  COMPANION_ROLE_LABEL,
} from "../lib/constants/companionConsole.ts";
import {
  COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
  COMPANION_ORDER_REFUNDED_MESSAGE,
  CONVERSATION_ENTRY_HINT,
  MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE,
  MESSAGE_ORDER_REFUNDED_MESSAGE,
  MESSAGE_ROLE_LABELS,
  MESSAGE_TARGET_INVALID_MESSAGE,
  MESSAGE_TARGETS,
} from "../lib/constants/service.ts";
import {
  STAFF_MESSAGE_ROLE_LABELS,
  STAFF_MESSAGE_TARGET_NOTICE,
} from "../lib/constants/staff.ts";
import { ORDER_STATUS_LABELS } from "../lib/constants/orders.ts";
import { setCompanionFlags } from "../lib/data/adminCompanionTransaction.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { getMessageRepository } from "../lib/data/messageRepository.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { approveAdminRefund } from "../lib/services/adminRefunds.ts";
import {
  getCompanionOrderDetail,
  listCompanionOrders,
  startCompanionOrder,
} from "../lib/services/companionOrders.ts";
import {
  getMessagesForUser,
  sendMessageForUser,
} from "../lib/services/conversations.ts";
import {
  getCompanionChatDetail,
  listCompanionChats,
  markCompanionChatRead,
  sendMessageForCompanion,
} from "../lib/services/companionConversations.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { createRefundForOrder, directRefundOrderForUser } from "../lib/services/refunds.ts";
import {
  getStaffConversationDetail,
  markStaffConversationRead,
  sendMessageForStaff,
} from "../lib/services/staffConversations.ts";
import {
  releaseStaffOrder,
  replaceStaffOrderCompanion,
} from "../lib/services/staffOrderActions.ts";

/**
 * P0-14｜打手订单聊天 + 换人后的聊天隔离（`cmd_p0-14.md` §十四 1～24、33、38）。
 *
 * ## 这个文件要证明的一件事
 *
 * 「一段履约一段会话」这条模型升级，真正要守住的**不是**「能不能建出两条会话」，
 * 而是**换人之后三件事同时成立**：
 *
 * 1. 新打手看不到旧打手的聊天（②③）；
 * 2. 旧打手立刻什么都看不到（①③）——包括**同一位打手**上一次履约（`A→B→A`）；
 * 3. 用户与客服**一段都不少**——历史不因换人而消失。
 *
 * 因此本文件的主线是**同一个场景走三遍**（`A→B→A`），每一遍换一个视角断言。
 *
 * ## 为什么 `A→B→A` 必须是一条独立用例，而不是「A→B 的重复」
 *
 * `A→B` 只验得到「会话是别人的」这一条腿（②）。同一位打手再次接单时②是**成立**的
 * ——`#s0` 本来就是 A 的——只有「这一段还是不是当前那一段」（③）能把他挡住。
 * 去掉③，A 重新接单就会看到自己上一次的聊天，而所有 `A→B` 用例仍然全绿。
 *
 * ## 会话 id 从哪来
 *
 * 打手端与用户端都**拿不到** `conversationId`（那是内部键，见
 * `lib/types/message.ts`）。测试要按段取数时用 `assignmentKeyOf(orderId, seq)`
 * 现算——它与生产代码里冻结进会话记录的那个串同源，不是重新拼一次。
 */

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 三位**没有挂任何预置在履约单**的护航：接单、被换下、被停用都不会波及其它样本。 */
const COMPANION_A = "cp-5";
const COMPANION_B = "cp-8";
const COMPANION_C = "cp-9";

/** 客服会话身份的最小形状：`releaseStaffOrder` 只需要 `id` 与展示用的三项。 */
const STAFF = {
  id: "staff-1",
  username: "kefu01",
  displayName: "客服小超",
  avatarUrl: "/mock/avatar-staff.svg",
  role: "customer_service",
  roleLabel: "客服",
};

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-p014-${process.pid}-${seq}`;
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。下单用户默认是合成 id。 */
async function placeOrder(userId = unique("u")) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      idempotencyKey: unique("key"),
    },
    userId,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", userId);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
  return confirmed.order;
}

function dispatchIdOf(orderId) {
  const id = dispatchStore().dispatchIdByOrder.get(orderId);
  assert.ok(id, `订单 ${orderId} 必须有派单记录`);
  return id;
}

/** 把订单交给某位打手（订单必须此刻在公共池里）。 */
async function accept(orderId, companionId) {
  const accepted = await acceptDispatch(dispatchIdOf(orderId), {
    companionId,
    at: new Date().toISOString(),
  });
  assert.equal(accepted.kind, "ok", `订单 ${orderId} 必须能被 ${companionId} 接走`);
}

async function releasesOf(orderId) {
  return getCompanionReleaseRepository().listReleasesByOrderId(orderId);
}

/**
 * 消息正文的**集合**比较。
 *
 * ⚠️ 同一毫秒内发出的两条消息，仓储按 `id` 兜底排序（`readMessagesOfConversation`），
 * 而 `id` 是随机 uuid。因此「谁在前」在消息时间戳相同时**不是**被测行为，
 * 用它做断言只会得到一条随机失败的用例。需要断言**顺序**的地方
 * （如「第一段在第二段之前」）用的是**段**的顺序，那是全序。
 */
function bodiesOf(messages) {
  return messages.map((message) => message.body).sort();
}

/** 打手端的发送者身份快照：与 `requireCompanion()` 返回的形状一致。 */
async function companionSender(companionId) {
  const companion = await getCompanionRepository().findCompanionById(companionId);
  assert.ok(companion, `预置护航缺失：${companionId}`);
  return {
    companionId,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
  };
}

/** 用户在某一段里的消息（**按段取数**，用来证明「这一段没被写进那一段」）。 */
async function messagesInSegment(orderId, seq) {
  return getMessageRepository().listMessagesInConversation(assignmentKeyOf(orderId, seq));
}

/** 用户视角的聊天页内容；订单不属于该用户时返回 null。 */
async function userView(userId, orderId) {
  return getMessagesForUser(userId, orderId, undefined, "server");
}

/** 用户发一条消息（`target` 省略时服务端默认 `service`）。 */
async function userSends(userId, orderId, body, target) {
  return sendMessageForUser(
    userId,
    orderId,
    { body, idempotencyKey: unique("key"), ...(target === undefined ? {} : { target }) },
    undefined,
    "server",
  );
}

async function companionSends(companionId, orderId, body) {
  return sendMessageForCompanion(await companionSender(companionId), orderId, {
    body,
    idempotencyKey: unique("key"),
  });
}

function segmentTitles(segments) {
  return segments.map((segment) => segment.title);
}

function keysOf(value) {
  return Object.keys(value).sort();
}

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("message");
  resetMockStore("dispatch");
  resetMockStore("companionRelease");
  resetMockStore("notification");
  resetMockStore("companion");
  resetMockStore("user");
  // 退款链路会写这两个 store，而它们原先不在名单里（第三轮只读审查 NOTE-5）。
  // 「只读 5」拿**预置**的待审申请去退一张预置的已完成订单，一旦这条用例失败
  // 并被同进程重跑（`--test-rerun-failures`），那张申请已经是「已审批」，
  // 重跑会以一个与真实缺陷无关的理由再红一次——失败信号被污染成噪声。
  // 重置语义与上面七条完全一致：丢掉 store，下次取用时按预置数据重新建仓。
  resetMockStore("refund");
  resetMockStore("earning");
});

// ——————————————————————————————————————————————————————————————————————
// 一、模型 / 仓储（§十四 1～6）
// ——————————————————————————————————————————————————————————————————————

test("模型 1：一条订单可以同时有多段 assignment conversation（不以订单号为唯一键）", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);

  assert.deepEqual(await releasesOf(order.id), [], "还没换过人，履约序号是 0");
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);

  const conversations = await getMessageRepository().listConversationsByOrder(order.userId, order.id);
  const assignments = conversations.filter((item) => item.kind === "assignment");

  assert.equal(assignments.length, 2, "换过一次人之后必须有两段履约会话");
  assert.equal(new Set(conversations.map((item) => item.id)).size, conversations.length, "会话 id 不得重复");
  // 「不以 orderId 单键覆盖」的可观测形态：两段会话的 orderId 相同、id 不同
  assert.equal(assignments[0].orderId, assignments[1].orderId);
  assert.notEqual(assignments[0].id, assignments[1].id);
  assert.deepEqual(
    assignments.map((item) => item.assignmentSeq),
    [0, 1],
    "两段会话的履约序号必须是 0 与 1，且各不相同",
  );
});

test("模型 2：同一段 assignment 重复建立只得到同一段会话，不覆盖创建时间与打手", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);

  const first = await getCompanionChatDetail(COMPANION_A, order.id);
  const firstCreatedAt = (
    await getMessageRepository().findAssignmentConversationByKey(order.id, assignmentKeyOf(order.id, 0))
  ).createdAt;
  const second = await getCompanionChatDetail(COMPANION_A, order.id);
  const third = await getCompanionChatDetail(COMPANION_A, order.id);

  assert.deepEqual(first.messages, []);
  assert.deepEqual(keysOf(second), keysOf(first));
  assert.deepEqual(keysOf(third), keysOf(first));

  // 读三次之后**仍然只有一段**履约会话（客服会话由用户打开聊天页时才建，见下一组用例）
  const stored = await getMessageRepository().listConversationsByOrder(order.userId, order.id);
  assert.deepEqual(stored.map((item) => item.kind), ["assignment"]);

  const conversation = await getMessageRepository().findAssignmentConversationByKey(
    order.id,
    assignmentKeyOf(order.id, 0),
  );
  assert.equal(conversation.companionId, COMPANION_A, "段落上的打手一旦写下就是历史事实，重复建立不得改写");
  assert.equal(
    conversation.createdAt,
    firstCreatedAt,
    "重复建立**不覆盖创建时间**——否则「这段会话什么时候开始的」会被每一次刷新推后",
  );
});

test("模型 3 / 4：A→B 建两条；A→B→A 再次回来时**新建第三条**，不复用 A 的第一段", async () => {
  const order = await placeOrder();

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id); // #s0
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });

  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id); // #s1
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：再换一次" });

  await accept(order.id, COMPANION_A); // 同一位打手回来了
  await getCompanionChatDetail(COMPANION_A, order.id); // 必须新建 #s2

  const assignments = (
    await getMessageRepository().listConversationsByOrder(order.userId, order.id)
  ).filter((item) => item.kind === "assignment");

  assert.deepEqual(
    assignments.map((item) => item.assignmentSeq),
    [0, 1, 2],
    "A→B→A 的第三段必须是**新的**第 2 段，而不是复用 A 的第 0 段",
  );
  assert.deepEqual(
    assignments.map((item) => item.companionId),
    [COMPANION_A, COMPANION_B, COMPANION_A],
    "第 0 段与第 2 段虽然都是 A，但它们是两段不同的履约",
  );
  assert.notEqual(assignments[0].id, assignments[2].id, "两段会话的 id 必须不同——否则第 2 段会顶掉第 0 段");
});

test("模型 5 / 6：A→B→A 之后历史消息一条不丢，且旧段落不被新段落覆盖", async () => {
  const order = await placeOrder();
  const user = order.userId;

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(user, order.id, "第一段：A 在的时候我说的", "current");
  await companionSends(COMPANION_A, order.id, "第一段：A 的回复");
  const firstSegment = await messagesInSegment(order.id, 0);
  assert.equal(firstSegment.length, 2);

  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);
  await userSends(user, order.id, "第二段：B 在的时候我说的", "current");
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：再换一次" });
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(user, order.id, "第三段：A 又回来了", "current");

  // 用户看到的是**整单的时间线**：三段全在
  const view = await userView(user, order.id);
  assert.deepEqual(
    bodiesOf(view.messages),
    ["第一段：A 在的时候我说的", "第一段：A 的回复", "第二段：B 在的时候我说的", "第三段：A 又回来了"].sort(),
  );

  // 而每一段里**只有自己那一条**——没有被后来的段落合并进来
  assert.deepEqual(bodiesOf(await messagesInSegment(order.id, 0)), ["第一段：A 在的时候我说的", "第一段：A 的回复"].sort());
  assert.deepEqual(bodiesOf(await messagesInSegment(order.id, 1)), ["第二段：B 在的时候我说的"]);
  assert.deepEqual(bodiesOf(await messagesInSegment(order.id, 2)), ["第三段：A 又回来了"]);
});

test("模型：访问判据的三条腿是**同时**成立——任意一条不成立都不放行", () => {
  const conversation = {
    kind: "assignment",
    assignmentKey: "ord-x#s0",
    companionId: "cp-5",
  };
  const base = { companionId: "cp-5", actualCompanionId: "cp-5", currentAssignmentKey: "ord-x#s0" };

  assert.equal(canCompanionAccessConversation(conversation, base), true, "三条全成立才是可见的");
  assert.equal(
    canCompanionAccessConversation(conversation, { ...base, actualCompanionId: null }),
    false,
    "① 回池 / 被换下：订单已经不归他了",
  );
  assert.equal(
    canCompanionAccessConversation(conversation, { ...base, actualCompanionId: "cp-8" }),
    false,
    "① 订单归别人",
  );
  assert.equal(
    canCompanionAccessConversation(conversation, { ...base, companionId: "cp-8" }),
    false,
    "② 这段会话不是他的（新打手）",
  );
  assert.equal(
    canCompanionAccessConversation(conversation, { ...base, currentAssignmentKey: "ord-x#s2" }),
    false,
    "③ 同一位打手的上一次履约——A→B→A 的胜负手",
  );
  assert.equal(
    canCompanionAccessConversation(conversation, { ...base, currentAssignmentKey: null }),
    false,
    "订单没有履约人时不存在「当前段」",
  );
  assert.equal(
    canCompanionAccessConversation({ ...conversation, kind: "service", assignmentKey: null }, base),
    false,
    "客服会话不走这条判据：打手对它一律不可见",
  );
});

test("模型：履约序号 = 退出历史条数；订单无履约人时当前键为 null", () => {
  assert.equal(resolveAssignmentSeq(0), 0);
  assert.equal(resolveAssignmentSeq(3), 3);
  assert.equal(resolveAssignmentSeq(-1), 0, "负数兜底为 0，不把序号算成负的");
  assert.equal(
    resolveCurrentAssignmentKey({ orderId: "ord-x", actualCompanionId: null, releaseCount: 5 }),
    null,
    "公共池里的订单不存在当前履约段",
  );
  assert.equal(
    resolveCurrentAssignmentKey({ orderId: "ord-x", actualCompanionId: "cp-5", releaseCount: 2 }),
    "ord-x#s2",
  );
});

test("模型：订单内排序是全序，段标题按端给词、历史段带后缀", () => {
  const service = { kind: "service", assignmentSeq: null };
  const s1 = { kind: "assignment", assignmentSeq: 1 };
  const s0 = { kind: "assignment", assignmentSeq: 0 };

  assert.ok(compareConversationsWithinOrder(service, s0) < 0, "客服会话永远第一");
  assert.ok(compareConversationsWithinOrder(s0, s1) < 0, "履约会话按序号升序");
  assert.equal(compareConversationsWithinOrder(s0, s0), 0);

  assert.equal(segmentTitle(service, false, CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER), CONVERSATION_SEGMENT_SERVICE_TITLE);
  assert.equal(segmentTitle(s0, true, CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER), CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER);
  assert.equal(
    segmentTitle(s0, false, CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER),
    `${CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER}${CONVERSATION_SEGMENT_HISTORY_SUFFIX}`,
  );
  assert.equal(
    segmentTitle(s0, true, CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF),
    CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF,
    "同一个动作在两端叫两个词：用户端「打手」、客服端「护航」",
  );
  assert.equal(
    isCurrentAssignmentConversation(service, "ord-x#s0"),
    false,
    "客服会话永远不是「当前履约段」",
  );
});

// ——————————————————————————————————————————————————————————————————————
// 二、打手端（§十四 7～16）
// ——————————————————————————————————————————————————————————————————————

test("打手 7 / 8：当前打手读得到、发得出，且消息落进当前那一段", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);

  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.ok(detail, "当前履约人必须能读到聊天");
  assert.deepEqual(detail.messages, [], "还没有人开口");

  const sent = await companionSends(COMPANION_A, order.id, "你好，我已经接单了");
  assert.equal(sent.created, true);

  const after = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.deepEqual(
    after.messages.map((message) => message.body),
    ["你好，我已经接单了"],
  );
  assert.equal(after.messages[0].isSelf, true);
  assert.equal(after.messages[0].senderRole, "companion");
  assert.equal(after.messages[0].senderLabel, "我", "自己发的显示「我」——按 senderId 判，不是按角色");

  // 落点就是当前那一段，不是客服会话
  assert.deepEqual(
    (await messagesInSegment(order.id, 0)).map((message) => message.body),
    ["你好，我已经接单了"],
  );
  const serviceMessages = await getMessageRepository().listMessagesInConversation(order.id);
  assert.deepEqual(serviceMessages, [], "打手的消息绝不能进客服会话");
});

test("打手 9 / 13 / 14：非当前打手一律读不到——三种「查不到」对外同形", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "只给 A 看的话", "current");

  // B 不是这一单的履约人：①不成立
  assert.equal(await getCompanionChatDetail(COMPANION_B, order.id), null, "别人接的单读不到");
  // 完全不存在的订单
  assert.equal(await getCompanionChatDetail(COMPANION_B, "ord-does-not-exist"), null, "不存在的订单同样读不到");
  // 空串不能变成「查到全部」
  assert.equal(await getCompanionChatDetail(COMPANION_B, ""), null, "空订单号不得退化成「查得到」");

  // B 也发不出去：写路径与读路径用同一条判据
  await assert.rejects(
    () => companionSends(COMPANION_B, order.id, "我不该能说话"),
    (error) => error.message === COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
  );
  // 而且一条都没写进去
  assert.deepEqual(
    (await messagesInSegment(order.id, 0)).map((message) => message.body),
    ["只给 A 看的话"],
  );
});

test("打手 10：release（回公共池）之后旧打手**立刻**失权——读、写、已读三条路径一起断", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "换人之前的话", "current");
  const conversationId = assignmentKeyOf(order.id, 0);
  const before = (await getMessageRepository().listMessagesInConversation(conversationId)).length;

  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：回池" });

  assert.equal(await getCompanionChatDetail(COMPANION_A, order.id), null, "回池之后读不到");
  assert.equal(await markCompanionChatRead(COMPANION_A, order.id), false, "回池之后也不能标记已读");
  await assert.rejects(
    () => companionSends(COMPANION_A, order.id, "我不该还能说话"),
    (error) => error.message === COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
  );

  // 会话记录**还在**（数据没被删），只是他再也拿不到它——「数据还在，权限没了」
  assert.equal(
    (await getMessageRepository().listMessagesInConversation(conversationId)).length,
    before,
    "失权不等于删除：一条消息都不该消失",
  );
  assert.deepEqual(
    (await listCompanionChats(COMPANION_A)).items.map((item) => item.orderId).includes(order.id),
    false,
    "这一单同时从他的聊天列表与「我的订单」里消失",
  );
});

test("打手 11：direct replace 之后旧打手失权，新打手拿到的是**新的一段**", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "换人之前的话", "current");

  const replaced = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  assert.equal(replaced.changed, true);
  assert.equal(replaced.previousCompanionId, COMPANION_A);
  assert.equal(replaced.newCompanionId, COMPANION_B);

  assert.equal(await getCompanionChatDetail(COMPANION_A, order.id), null, "被换下的打手立刻失权");

  const detail = await getCompanionChatDetail(COMPANION_B, order.id);
  assert.ok(detail, "接手的那位必须能读到自己的这一段");
  assert.deepEqual(detail.messages, [], "他看不到旧打手那一段的任何消息");
});

test("打手 12：停用（disable）触发的释放同样让旧打手立刻失权", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_C);
  await getCompanionChatDetail(COMPANION_C, order.id);
  await userSends(order.userId, order.id, "停用之前的话", "current");

  const disabled = await setCompanionFlags(
    COMPANION_C,
    "disable",
    { unavailableReason: "" },
    {
      actorId: "admin-1",
      actorRole: "admin",
      actorName: null,
      operationId: unique("op"),
      at: new Date().toISOString(),
    },
  );
  assert.equal(disabled.kind, "ok");

  assert.equal(await getCompanionChatDetail(COMPANION_C, order.id), null, "被停用之后读不到自己的旧段");
  assert.equal(await markCompanionChatRead(COMPANION_C, order.id), false);
  assert.equal((await releasesOf(order.id)).length, 1, "停用必须留下一条退出历史——序号就是靠它递增的");
});

test("打手 15 / 16：已读游标按段独立——新打手既不继承旧打手的已读，旧打手的未读也不算到他头上", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "A 收到的第一条", "current");
  await userSends(order.userId, order.id, "A 收到的第二条", "current");

  const beforeRead = await listCompanionChats(COMPANION_A);
  assert.equal(beforeRead.items[0].unreadCount, 2, "A 一条都没读过");

  assert.equal(await markCompanionChatRead(COMPANION_A, order.id), true);
  assert.equal((await listCompanionChats(COMPANION_A)).items[0].unreadCount, 0, "A 读完归零");
  const aConversation = await getMessageRepository().findAssignmentConversationByKey(
    order.id,
    assignmentKeyOf(order.id, 0),
  );
  assert.ok(aConversation.companionLastReadAt, "已读位置记在**会话**上");

  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);

  const bConversation = await getMessageRepository().findAssignmentConversationByKey(
    order.id,
    assignmentKeyOf(order.id, 1),
  );
  assert.equal(bConversation.companionLastReadAt, null, "新一段的游标从 null 开始，不继承 A 的已读位置");
  assert.equal((await listCompanionChats(COMPANION_B)).items[0].unreadCount, 0, "A 那两条消息在 B 的段里，不该出现");

  await userSends(order.userId, order.id, "B 收到的第一条", "current");
  assert.equal((await listCompanionChats(COMPANION_B)).items[0].unreadCount, 1, "B 的未读只数自己段里的");

  // 反向：A 的已读游标没有被 B 的动作改动
  assert.equal(
    (await getMessageRepository().findAssignmentConversationByKey(order.id, assignmentKeyOf(order.id, 0)))
      ?.companionLastReadAt,
    aConversation.companionLastReadAt,
    "B 发消息/读消息都不得改写 A 那一段的游标",
  );
});

test("打手：幂等键作用域是「会话 + 打手」——同一位打手在两段里用同一个键仍然是两条消息", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);

  const firstKey = unique("key");
  const first = await sendMessageForCompanion(await companionSender(COMPANION_A), order.id, {
    body: "第一段的话",
    idempotencyKey: firstKey,
  });
  const replay = await sendMessageForCompanion(await companionSender(COMPANION_A), order.id, {
    body: "第一段的话",
    idempotencyKey: firstKey,
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false, "同一个键重放只得到同一条消息");
  assert.equal(replay.messageId, first.messageId);

  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id); // 新的 #s1

  // 同一个键、同一位打手，但换了会话：必须是一条**新**消息
  const second = await sendMessageForCompanion(await companionSender(COMPANION_A), order.id, {
    body: "第二段的话",
    idempotencyKey: firstKey,
  });
  assert.equal(second.created, true, "键空间必须按会话隔离，否则第二段的话会被第一段吞掉");
  assert.notEqual(second.messageId, first.messageId);
});

// ——————————————————————————————————————————————————————————————————————
// 三、用户端（§十四 17～21）
// ——————————————————————————————————————————————————————————————————————

test("用户 17 / 21：owner 看得到全部段落（含历史），分段顺序稳定且只有当前那段可写", async () => {
  const order = await placeOrder();
  const user = order.userId;

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(user, order.id, "第一段", "current");
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);
  await userSends(user, order.id, "第二段", "current");

  const view = await userView(user, order.id);
  assert.deepEqual(
    segmentTitles(view.segments),
    [
      CONVERSATION_SEGMENT_SERVICE_TITLE,
      `${CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER}${CONVERSATION_SEGMENT_HISTORY_SUFFIX}`,
      CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER,
    ],
    "客服段在前，其后按履约序号；只有当前那段没有「（历史）」后缀",
  );
  assert.deepEqual(
    view.segments.map((segment) => segment.isReadOnly),
    [false, true, false],
    "客服段永远可写；历史履约段只读；当前履约段可写",
  );
  assert.deepEqual(
    view.segments.map((segment) => segment.isCurrent),
    [false, false, true],
  );
  assert.deepEqual(
    bodiesOf(view.messages),
    ["第一段", "第二段"].sort(),
    "「完整历史」是整单的时间线，跨段合并",
  );

  // 顺序稳定：同一份数据读两次，段的顺序与 index 完全一致
  const again = await userView(user, order.id);
  assert.deepEqual(again.segments.map((segment) => segment.index), view.segments.map((segment) => segment.index));
  assert.deepEqual(segmentTitles(again.segments), segmentTitles(view.segments));
});

test("用户 18 / 19：owner 只发得进「客服」与「当前履约」两处，历史段没有可写的入口", async () => {
  const order = await placeOrder();
  const user = order.userId;

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(user, order.id, "第一段：用户的话", "current");
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：换人" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);

  const firstSegmentBefore = (await messagesInSegment(order.id, 0)).map((message) => message.id);

  // 合法的两个取值
  const toCurrent = await userSends(user, order.id, "第二段：用户的话", "current");
  assert.ok(toCurrent.messageId);
  const toService = await userSends(user, order.id, "顺便问下客服", "service");
  assert.ok(toService.messageId);

  // 历史段**在结构上就写不进去**：没有那个枚举值
  assert.deepEqual([...MESSAGE_TARGETS], ["service", "current"], "发送对象只有两个取值，都不是内部键");
  for (const target of ["assignment", "assignment#0", `${order.id}#s0`, "companion"]) {
    await assert.rejects(
      () => userSends(user, order.id, "试图写进历史段", target),
      (error) => error.message === MESSAGE_TARGET_INVALID_MESSAGE,
      `target=${target} 必须被拒绝，而不是回退默认值`,
    );
  }

  // 落点验证：第一段的 id 集合**一个没变**
  assert.deepEqual(
    (await messagesInSegment(order.id, 0)).map((message) => message.id),
    firstSegmentBefore,
    "用户发的消息不得落进历史段",
  );
  assert.deepEqual(
    (await messagesInSegment(order.id, 1)).map((message) => message.body),
    ["第二段：用户的话"],
  );

  // 省略 target 默认落客服会话（零回归：P0-14 之前用户发的消息就都在那里）
  await userSends(user, order.id, "没写 target 的话");
  assert.equal(
    (await getMessageRepository().listMessagesInConversation(order.id)).some(
      (message) => message.body === "没写 target 的话",
    ),
    true,
    "省略发送对象时默认落客服会话",
  );
});

test("用户：订单回池时 target=current 报 400 而不是 404——用户要看到的是「现在没有打手」", async () => {
  const order = await placeOrder();
  const user = order.userId;

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await releaseStaffOrder(order.id, STAFF, { reason: "测试用：回池" });

  await assert.rejects(
    () => userSends(user, order.id, "还有人吗", "current"),
    (error) => error.message === MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE,
  );
  // 但客服仍然发得进——回池不该顺带把用户与客服的沟通冻住
  const toService = await userSends(user, order.id, "客服还在吗", "service");
  assert.ok(toService.messageId);
});

test("用户 20：non-owner 读不到也写不进——与「订单不存在」完全同形", async () => {
  const order = await placeOrder();
  const stranger = unique("u");

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "只有我能看到", "current");

  assert.equal(await userView(stranger, order.id), null, "别人的订单读不到");
  assert.equal(await userView(stranger, "ord-does-not-exist"), null, "两种「读不到」必须同一个结果");
  assert.equal(await userView(stranger, ""), null);

  await assert.rejects(
    () => userSends(stranger, order.id, "我不该能说话", "current"),
    (error) => error.message === "订单不存在",
  );
  await assert.rejects(
    () => userSends(stranger, order.id, "我也不该能说话", "service"),
    (error) => error.message === "订单不存在",
  );
  assert.deepEqual(
    (await messagesInSegment(order.id, 0)).map((message) => message.body),
    ["只有我能看到"],
  );
});

test("用户：打手发的消息进得了用户看到的「完整历史」", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);

  await companionSends(COMPANION_A, order.id, "我上线了");
  await userSends(order.userId, order.id, "好的", "current");

  const view = await userView(order.userId, order.id);
  assert.deepEqual(
    view.messages
      .map((message) => [message.senderRole, message.body])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [
      ["companion", "我上线了"],
      ["user", "好的"],
    ],
    "两端写的是**同一个仓储**，不存在「打手专用消息副本」",
  );
  assert.equal(
    view.segments.find((segment) => segment.isCurrent)?.messages.length,
    2,
    "两条都在当前那一段里",
  );
});

// ——————————————————————————————————————————————————————————————————————
// 四、客服端（§十四 22～24、33）
// ——————————————————————————————————————————————————————————————————————

test("客服 22 / 23：客服看得到每一段历史，且段落与退出历史**对得上**", async () => {
  const order = await placeOrder();

  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  // 用户打开过自己的聊天页 —— 客服会话就是这样建起来的（懒创建，与 P0-14 之前一致）。
  // 不打开的话这一段在客服视角里根本不存在，下面的四段断言就无从谈起
  await userView(order.userId, order.id);
  await userSends(order.userId, order.id, "第一段：用户说的话", "current");
  await releaseStaffOrder(order.id, STAFF, { reason: "第一段结束" });
  await accept(order.id, COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);
  await userSends(order.userId, order.id, "第二段：用户说的话", "current");
  await releaseStaffOrder(order.id, STAFF, { reason: "第二段结束" });
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);

  const detail = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  assert.ok(detail, "客服必须能打开这一单");

  assert.deepEqual(
    detail.segments.map((segment) => [segment.kind, segment.title, segment.isCurrent]),
    [
      ["service", CONVERSATION_SEGMENT_SERVICE_TITLE, false],
      ["assignment", `${CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF}${CONVERSATION_SEGMENT_HISTORY_SUFFIX}`, false],
      ["assignment", `${CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF}${CONVERSATION_SEGMENT_HISTORY_SUFFIX}`, false],
      ["assignment", CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF, true],
    ],
    "客服端用「护航」这个词，用户端用「打手」——同一个动作两端两个词，各有明文出处",
  );
  assert.deepEqual(
    detail.segments.map((segment) => segment.companionId),
    [null, COMPANION_A, COMPANION_B, COMPANION_A],
  );
  assert.equal(detail.segments[0].companionName, null, "客服会话不属于任何一位护航");

  // 段落 ↔ 退出历史：历史段恰好是退出历史的条数，而且**顺序与人一一对应**
  const releases = await releasesOf(order.id);
  const history = detail.segments.filter(
    (segment) => segment.kind === "assignment" && !segment.isCurrent,
  );
  assert.equal(history.length, releases.length, "有几个历史段就有几条退出历史");
  // ⚠️ 用**多重集合**比较而不是顺序比较：两次释放发生在同一毫秒时，
  // 退出历史的兜底排序键是随机 id（`listCompanionReleasesByOrderId`），
  // 而段落顺序是全序（`assignmentSeq`）。真实场景里两次释放之间隔着一次接单，
  // 不可能同毫秒；用顺序断言只会得到一条偶尔失败的用例。
  assert.deepEqual(
    history.map((segment) => segment.companionId).sort(),
    releases.map((record) => record.companionId).sort(),
    "每一段历史都对应一条退出历史，反之亦然——「谁曾经接过」两处说法必须一致",
  );
  assert.deepEqual(
    history.map((segment) => segment.index),
    [1, 2],
    "历史段自身按履约序号全序排列",
  );
  assert.equal(detail.order.releaseHistory.length, releases.length, "客服看到的退出历史条数与仓储一致");
  // 消息一条不丢：三段的话都在扁平时间线里
  assert.deepEqual(
    bodiesOf(detail.messages),
    ["第一段：用户说的话", "第二段：用户说的话"].sort(),
  );
  assert.ok(detail.messageTargetNotice === STAFF_MESSAGE_TARGET_NOTICE);
});

test("客服 24：客服已读与打手已读是三份互不影响的游标", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "给两边都看的话", "current");

  // 打手先读
  assert.equal(await markCompanionChatRead(COMPANION_A, order.id), true);
  const companionCursor = (
    await getMessageRepository().findAssignmentConversationByKey(order.id, assignmentKeyOf(order.id, 0))
  ).companionLastReadAt;
  assert.ok(companionCursor);

  let detail = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  assert.equal(detail.staffLastReadAt, null, "打手读过不等于客服读过");
  const userCursorBefore = (
    await getMessageRepository().findAssignmentConversationByKey(order.id, assignmentKeyOf(order.id, 0))
  ).userLastReadAt;

  // 客服再读
  assert.equal(await markStaffConversationRead(STAFF.id, order.id), true);
  detail = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  assert.ok(detail.staffLastReadAt);

  const conversation = await getMessageRepository().findAssignmentConversationByKey(
    order.id,
    assignmentKeyOf(order.id, 0),
  );
  assert.equal(conversation.companionLastReadAt, companionCursor, "客服读不得改动打手的游标");
  assert.equal(conversation.userLastReadAt, userCursorBefore, "客服读不得改动用户的游标");
});

test("客服 33（回归）：客服发的消息只进「客服沟通」那一段，打手看不到、也不进他的会话", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "打手你好", "current");

  const sent = await sendMessageForStaff(
    { id: STAFF.id, displayName: STAFF.displayName, avatarUrl: STAFF.avatarUrl },
    order.id,
    { body: "客服在跟进这一单", idempotencyKey: unique("key") },
    undefined,
    "server",
  );
  assert.ok(sent.messageId);

  // 落到客服会话（id 就是订单号）——而不是某一段履约会话
  assert.deepEqual(
    (await getMessageRepository().listMessagesInConversation(order.id)).map((message) => message.body),
    ["客服在跟进这一单"],
  );
  assert.deepEqual(
    (await messagesInSegment(order.id, 0)).map((message) => message.body),
    ["打手你好"],
    "客服的话绝不能插进用户与打手的私聊",
  );

  // 打手读不到那句客服消息
  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.deepEqual(
    detail.messages.map((message) => message.body),
    ["打手你好"],
  );

  // 客服端要能同时看到两段
  const staffView = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  assert.deepEqual(
    staffView.segments.map((segment) => segment.messages.length),
    [1, 1],
    "客服视角：客服段 1 条、履约会话段 1 条",
  );
});

test("客服：一条订单只有履约会话、客服会话还没建时，客服回复是**补建**客服会话而不是 404", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  // 只让打手打开聊天页：此时这一单只有一段履约会话
  await getCompanionChatDetail(COMPANION_A, order.id);

  const conversations = await getMessageRepository().listConversationsByOrder(order.userId, order.id);
  assert.deepEqual(conversations.map((item) => item.kind), ["assignment"], "此刻还没有客服会话");

  const sent = await sendMessageForStaff(
    { id: STAFF.id, displayName: STAFF.displayName, avatarUrl: STAFF.avatarUrl },
    order.id,
    { body: "客服来回复了", idempotencyKey: unique("key") },
    undefined,
    "server",
  );
  assert.ok(sent.messageId, "客服不能因为打手先打开了聊天页就无法回复用户");

  const after = await getMessageRepository().listConversationsByOrder(order.userId, order.id);
  assert.deepEqual(after.map((item) => item.kind), ["service", "assignment"], "补建出来的客服会话 id 就是订单号");
});

// ——————————————————————————————————————————————————————————————————————
// 五、DTO 边界（§十四 38）
// ——————————————————————————————————————————————————————————————————————

/**
 * **任何**对外响应都不该出现的键：会话 id（= 履约身份键）、履约序号与它的两个变体。
 *
 * ⚠️ 「内部键」与「不属于这一端的业务字段」是两回事，因此分成两张表：
 * `companionLastReadAt` 是打手**自己的**已读游标（打手端详情里本来就该有），
 * 但它不该出现在用户端——把它和 `conversationId` 混成一类，会让「谁在什么时候
 * 该看得到什么」变成一句笼统的「都不能有」，而那种规则迟早被放宽到全都可以有。
 */
const FORBIDDEN_INTERNAL_KEYS = ["conversationId", "assignmentKey", "assignmentSeq"];
/** 只有**用户端**不得携带的字段：打手身份与打手游标。 */
const FORBIDDEN_USER_ONLY_KEYS = ["companionId", "companionLastReadAt"];

function assertNoForbiddenKeys(value, where, keys = FORBIDDEN_INTERNAL_KEYS) {
  assert.ok(value && typeof value === "object", `${where} 必须是一个对象`);
  for (const key of keys) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value, key),
      false,
      `${where} 不得携带 ${key}`,
    );
  }
}

test("DTO 38：各端 DTO 的键集合是**精确**的——多一个内部键就是越界，少一个就是页面坏掉", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "一句话", "current");
  await companionSends(COMPANION_A, order.id, "回一句");

  // —— 用户端 ——
  const view = await userView(order.userId, order.id);
  assert.deepEqual(
    keysOf(view.messages[0]),
    [
      "body",
      "createdAt",
      "id",
      "orderId",
      "senderAvatarUrl",
      "senderId",
      "senderName",
      "senderRole",
      "userId",
    ],
    "用户端消息视图恰好九个字段，`conversationId` 不在其中",
  );
  assert.deepEqual(
    keysOf(view.segments[0]),
    ["index", "isCurrent", "isReadOnly", "kind", "messages", "title"],
    "分段 DTO 恰好六个字段；没有 id / assignmentKey / companionId，用户推不出「第几段」",
  );
  assertNoForbiddenKeys(view.messages[0], "用户端消息", [...FORBIDDEN_INTERNAL_KEYS, ...FORBIDDEN_USER_ONLY_KEYS]);
  assertNoForbiddenKeys(view.segments[0], "用户端分段", [...FORBIDDEN_INTERNAL_KEYS, ...FORBIDDEN_USER_ONLY_KEYS]);
  assert.deepEqual(
    keysOf(view.conversation).sort(),
    [
      "lastMessageAt",
      "lastMessageBody",
      "lastMessageRole",
      "messageCount",
      "orderId",
      "orderNo",
      "orderStatus",
      "orderStatusLabel",
      "productCoverUrl",
      "productTitle",
      "unreadCount",
    ],
    "订单级会话摘要字段集合",
  );
  // 分段里包着的消息同样是视图，不是内部记录。⚠️ 取**有消息的那一段**：
  // segments[0] 是客服会话，这一单里它是空的（用户没跟客服说过话）
  const nonEmptySegment = view.segments.find((segment) => segment.messages.length > 0);
  assert.ok(nonEmptySegment, "至少当前履约段里有一条消息");
  assertNoForbiddenKeys(nonEmptySegment.messages[0], "用户端分段内消息", [
    ...FORBIDDEN_INTERNAL_KEYS,
    ...FORBIDDEN_USER_ONLY_KEYS,
  ]);

  // —— 打手端 ——
  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.deepEqual(
    keysOf(detail),
    [
      "companionLastReadAt",
      "customerNickname",
      "isReadOnly",
      "messages",
      "notice",
      "orderId",
      "orderNo",
      "orderStatus",
      "orderStatusLabel",
      "productTitle",
    ],
    "打手端详情恰好十个字段；**没有** segments（他只有一段，分段概念对他不存在）",
  );
  assert.deepEqual(
    keysOf(detail.messages[0]),
    ["body", "createdAt", "id", "isSelf", "senderAvatarUrl", "senderLabel", "senderRole"],
    "打手端消息恰好七个字段",
  );
  // ⚠️ 打手端详情**允许**有 `companionLastReadAt`（那是他自己的游标），
  // 但同样不得有会话 id：`#s0` 这类串一旦出去，客户端就能试着去寻址一段历史会话
  assertNoForbiddenKeys(detail, "打手端详情", [...FORBIDDEN_INTERNAL_KEYS, "companionId"]);
  assertNoForbiddenKeys(detail.messages[0], "打手端消息", [...FORBIDDEN_INTERNAL_KEYS, "companionId"]);
  assert.equal(JSON.stringify(detail).includes(order.id + "#s"), false, "会话 id（= assignmentKey）不得出现在任何打手端响应里");

  // —— 打手端列表 ——
  const list = await listCompanionChats(COMPANION_A);
  assert.deepEqual(
    keysOf(list.items[0]),
    [
      "customerNickname",
      "isReadOnly",
      "lastMessageAt",
      "lastMessageBody",
      "lastMessageRole",
      "messageCount",
      "orderId",
      "orderNo",
      "orderStatus",
      "orderStatusLabel",
      "productCoverUrl",
      "productTitle",
      "unreadCount",
    ],
    "打手端列表项恰好十三个字段",
  );
  assertNoForbiddenKeys(list.items[0], "打手端列表项", [...FORBIDDEN_INTERNAL_KEYS, "companionId"]);
  assertNoForbiddenKeys(list, "打手端列表", [...FORBIDDEN_INTERNAL_KEYS, "companionId"]);
  assert.equal(JSON.stringify(list).includes("#s"), false, "列表里也不得出现内部键");

  // —— 客服端 ——
  const staffView = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  assert.deepEqual(
    keysOf(staffView.segments[0]),
    ["companionId", "companionName", "index", "isCurrent", "kind", "messages", "title"],
    "客服端分段恰好七个字段：客服**要**知道是哪位护航（调查视角），因此这里带着 companionId",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(staffView.segments[0], "assignmentKey"),
    false,
    "但内部履约键对客服也没有信息量——他看的是「这一单发生过什么」",
  );
  assert.equal(JSON.stringify(staffView).includes("#s"), false, "客服响应里同样不得出现内部履约键");
});

// ⚠️ 这条测的是**用户端**那一个转换点（`toMessageView`）；打手端 / 客服端各有
// 自己的转换点、形状不同，由各自的文件与本套件的 §四 覆盖。标题原先写「唯一的
// 转换点」是不实陈述（reviewer P0-14 MINOR-1），已改正——断言未动。
test("DTO：用户端 `toMessageView` 显式挑字段而不是展开后删键，产出恰好等于内部记录去掉 conversationId", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "边界测试", "current");

  const view = await userView(order.userId, order.id);
  // ⚠️ 按**段**取内部记录：`order.id` 是客服会话的 id，而这条消息在履约会话里
  const internal = await messagesInSegment(order.id, 0);
  assert.equal(internal.length, 1);

  // 内部记录确实带 conversationId（否则这条断言什么也证明不了）
  assert.ok(internal[0].conversationId, "内部记录必须有 conversationId");
  assert.deepEqual(
    Object.keys(view.messages[0]).sort(),
    Object.keys(internal[0])
      .filter((key) => key !== "conversationId")
      .sort(),
    "对外视图 = 内部记录**恰好**去掉 conversationId 一项",
  );
});

// ——————————————————————————————————————————————————————————————————————
// 五、称呼的**来源**（结构约束，不是文案断言）
// ——————————————————————————————————————————————————————————————————————

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 去掉注释后再扫。注释里出现「护航」是解释，不是给用户看的词。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function sourceOf(...segments) {
  return stripComments(readFileSync(path.join(ROOT, ...segments), "utf8"));
}

/**
 * 同一个角色在两端**刻意有不同的叫法**，这是全仓最容易在改动中被顺手统一掉的一处：
 * 用户端说「打手」，客服端与打手端说「护航」。三张角色表分开写不是重复，
 * 而「分开」这件事没有任何类型系统在保——把两张表合并、或者在页面里写死一个词，
 * 都不会报错，只会在**同一个屏幕上**出现「分段标题写着『打手沟通』、
 * 上面的收件人按钮写着『护航』」这种自相矛盾。
 *
 * 因此这里不做文案断言（那种断言改一个字就红，只会被当成噪音删掉），
 * 而是钉住**词的来源**：表在哪、谁必须从表里取、页面文件里不许出现写死的角色词。
 *
 * ⚠️ 打手端聊天页（`components/companion/CompanionChatConsole.tsx`）与
 * 打手端聊天组件**不在**下面的扫描范围里：它们与客服端同词（「护航」），
 * 但归属判定与用语各自有出处的检查放在各自的测试里，避免这里变成一张
 * 「谁出现过哪个字」的大网——那种网一红，没人分得清是真的错了还是漏加了文件。
 */
test("称呼来源：三端角色表各说各的词，页面里不许写死角色词", () => {
  // 1. 三张表的分工本身。用户端与另外两端**必须不同**，这是需求明文
  //    （`lib/constants/service.ts` 的 `MESSAGE_ROLE_LABELS` 与
  //    `lib/constants/conversations.ts` 的 `COMPANION_MESSAGE_ROLE_LABELS` 各自说明了理由）
  assert.equal(MESSAGE_ROLE_LABELS.companion, "打手", "用户端的角色表说「打手」");
  assert.equal(COMPANION_MESSAGE_ROLE_LABELS.companion, "护航", "打手端的角色表说「护航」");
  assert.equal(STAFF_MESSAGE_ROLE_LABELS.companion, "护航", "客服端的角色表说「护航」");
  assert.equal(COMPANION_ROLE_LABEL, "护航", "打手端对自己的称呼");
  assert.notEqual(
    MESSAGE_ROLE_LABELS.companion,
    STAFF_MESSAGE_ROLE_LABELS.companion,
    "两张表**合并**的那一刻，就会有一端在自己的聊天页里把对方标成自己的叫法",
  );

  // 2. 用户端收件人选择器的两个词必须来自那张表。
  //    这不是风格问题：写死「护航」会让用户以为要把消息发给一个用户端从未出现过的角色
  const orderChat = sourceOf("components", "service", "OrderChat.tsx");
  for (const key of ["MESSAGE_ROLE_LABELS.companion", "MESSAGE_ROLE_LABELS.customer_service"]) {
    assert.ok(
      orderChat.includes(key),
      `用户端聊天组件的收件人称呼必须取自 ${key}，不能在组件里另写一个词`,
    );
  }

  // 3. 这几个界面文件（去掉注释后）不得出现**写死**的角色词。
  //    段落标题由服务端的 `segmentTitle` 按端生成，组件只负责显示，
  //    因此这几个文件里一个角色词都不该有
  //
  for (const relative of [
    ["components", "service", "OrderChat.tsx"],
    ["app", "(mobile)", "service", "chat", "[orderId]", "page.tsx"],
    ["components", "staff", "StaffConversationConsole.tsx"],
  ]) {
    const source = sourceOf(...relative);
    for (const word of ["打手", "护航"]) {
      assert.equal(
        source.includes(word),
        false,
        `${relative.join("/")} 里出现了写死的「${word}」：角色的词只有一处来源，页面不该自己造一个`,
      );
    }
  }

  // 4. 订单详情页的「订单沟通」入口说明：**只扫这一条**，不扫整页。
  //
  //    📌 P0-14 裁定 fix（2026-09-27）：这条说明原本把「打手」写死在页面里，
  //    而它**不在**上面那份名单的覆盖范围内——门禁的范围是一份**名单**，
  //    名单漏掉一个文件，不等于那个文件里就没有第二份来源。是 reviewer 的
  //    NOTE-5 指出来的，已改为取 `CONVERSATION_ENTRY_HINT`。
  //
  //    ⚠️ **为什么只扫这一条、不把整页加进上面那份名单**：那一页还有一处
  //    「护航收益」（金额行标签，`lib/types/order.ts` 的分账口径明文写着它就叫
  //    这个名字）。名称该怎么统一是**产品文案问题**，且该行已被登记在
  //    「上线前移除用户端分账比例」那条技术债里——不在本批次范围内，
  //    登记为 NOTE-5 而不是在这里顺手改掉。
  const orderDetailPage = sourceOf("app", "(mobile)", "orders", "[id]", "page.tsx");
  assert.ok(
    orderDetailPage.includes("CONVERSATION_ENTRY_HINT"),
    "订单沟通入口说明必须取自常量，不能在页面里拼一个含角色词的字符串",
  );
  // ⚠️ 只断言「引用了常量」是**防不住**的——把用法换回字面量、留下那行 `import`，
  // 上面那条照样绿。因此再钉一句：**整句文案不许内联在页面里**。
  assert.equal(
    orderDetailPage.includes("与客服"),
    false,
    "入口说明的整句文案不许内联在页面里（只 import 不引用是防不住的）",
  );
  assert.equal(
    CONVERSATION_ENTRY_HINT,
    `与客服 / ${MESSAGE_ROLE_LABELS.companion}沟通`,
    "入口说明的角色词必须来自 MESSAGE_ROLE_LABELS，改表就该跟着改",
  );
});

// ——————————————————————————————————————————————————————————————————————
// 六、全额退款后的只读（产品裁定 `TBD-P0-14-1`，2026-09-27）
// ——————————————————————————————————————————————————————————————————————
//
// 裁定原文：「订单全额退款后，当前 assignment 立即结束；对应聊天历史保留，
// 但进入只读状态。」
//
// ## 这一组真正要钉住的**不是**「退款后发不出去」
//
// 那太好实现了——一句 `status === "refunded"` 就够了。难的是另外三件事：
//
// 1. **读必须一条不少地照旧**。`applyOrderRefund` 既不清 `actualCompanionId`
//    （P0-12 硬约束），也不追加履约退出记录，因此「归属」与「段身份」两条腿
//    在退款后**仍然成立**，读取路径一个字都不用改就该照常返回。反过来，
//    若有人图省事在读取路径上也加一句「退款了就返回 null」，
//    本组每一条「仍可读 / 历史一条不少」的断言都会红。
// 2. **判据不能是金额**。`refundedAmount > 0` 在**部分退款**上同样成立，
//    拿它当开关会让「退了一半、还在服务中」的单子当场失联。
//    部分退款是允许的（裁定第 5 条），所以这一条必须有**正向**用例。
// 3. **`actualCompanionId` 不再是「还能聊」的充分条件**（裁定第 2 条）。
//    它仍然等于本人，写权限却必须已经关掉——因此下面每一条写拒绝的断言
//    都紧挨着一条「`actualCompanionId` 照旧等于本人」的断言。
//
// ## 段身份与写权限是两件事，退款把它们的组合翻了一面
//
// 退款**不**把当前段变成历史段（人没被换掉）。于是出现了 P0-14 交付时
// 还不存在的组合：`isCurrent: true` 且 `isReadOnly: true`。
// `buildConversationSegments` 的两个字段因此都必须保留，
// 页面也不得假定其中一个蕴含另一个（见 `lib/types/message.ts` 的对照表）。

/** 订单当前快照。 */
async function orderNow(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

/** 断言一个请求以指定的错误码与文案被拒绝（文案是冻结的常量，不是随手写的中文）。 */
async function expectApiError(run, code, message) {
  await assert.rejects(run, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/**
 * 管理端审核决策的请求体 —— **P0-15 之后只剩一个比例字段**。
 *
 * ⚠️ 旧版本里还带 `responsibility: "platform"`，理由是「平台承担时打手收益冲回额为 0，
 * 于是不必先造出一笔 Earning」。责任划分模型已被 P0-15 整条删除：
 * 冲回额**恒为全额**（= 订单上的 `companionBaseIncome`），与比例、与责任方都无关。
 * 服务端现在只读 `refundRatePercent`；多传的字段一律被忽略，所以这里不再写它们。
 * 金额口径由 `adminRefunds.test.mjs` / `refundMoneyChain.test.mjs` 负责，
 * 本文件只验聊天的可写性。
 */
function refundDecision(ratePercent) {
  return { refundRatePercent: ratePercent, reviewNote: "" };
}

/**
 * 走**真实的售后链路**把订单退掉：用户申请 → 管理员按比例通过。
 *
 * ⚠️ 走服务层而不是直接调伪事务：服务层才有决策三件套与幂等键的形态校验，
 * 测试要覆盖的正是接口真实经过的那条路。
 */
async function refundAfterSales(orderId, userId, ratePercent) {
  const created = await createRefundForOrder(
    orderId,
    userId,
    {
      reasonKey: "service_not_delivered",
      description: "测试用：走售后申请退款",
      evidence: [],
      idempotencyKey: unique("key"),
    },
    undefined,
    "server",
  );
  await approveAdminRefund(created.refundId, "admin-1", {
    idempotencyKey: unique("key"),
    ...refundDecision(ratePercent),
  });
  return orderNow(orderId);
}

/** 一张「护航中」的单：下单 → 接单 → 开始服务。 */
async function placeServingOrder(companionId) {
  const order = await placeOrder();
  await accept(order.id, companionId);
  await startCompanionOrder(companionId, order.id);
  const after = await orderNow(order.id);
  assert.equal(after.status, "serving", "前置：订单必须进入护航中");
  return after;
}

/** 客服会话里的消息（它的会话 id 恰好等于订单号，与履约会话的 `#sN` 不同）。 */
async function messagesInServiceConversation(orderId) {
  return getMessageRepository().listMessagesInConversation(orderId);
}

test("只读 1：触发只读的**只有** `refunded`——其余四档一个都不关，`completed` 尤其不能顺手关", () => {
  const all = ["paid", "accepted", "serving", "completed", "refunded"];
  assert.deepEqual(all.filter(isOrderChatClosed), ["refunded"], "只有已全额退款才关");

  // 逐档写出「不关」，而不是只留一句 `deepEqual`：将来有人把触发条件放宽
  // （最像的一次是「已完成就只读」），报错信息要直接指出是**哪一档**被误关
  for (const status of ["paid", "accepted", "serving", "completed"]) {
    assert.equal(isOrderChatClosed(status), false, `${status} 不该只读`);
  }
  // `completed` 是最容易被顺手关掉的一档：它看起来「结束了」，
  // 但售后、评价、投诉都还要在这一段里说话（见该函数的注释）
  assert.equal(
    isOrderChatClosed("completed"),
    false,
    "已完成不等于沟通结束——已完结但没退款的单子，双方照样要能继续说话",
  );
});

test("只读 2：accepted 全额直退之后，双方都**还能读**、都**不能再发**（客服会话照常）", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "这一段之前说的话", "current");
  await companionSends(COMPANION_A, order.id, "这一段之前的回复");

  await directRefundOrderForUser(order.id, order.userId, undefined, "server");

  // —— 前置与「历史事实保留」——
  const after = await orderNow(order.id);
  assert.equal(after.status, "refunded");
  assert.equal(
    after.actualCompanionId,
    COMPANION_A,
    "P0-12 硬约束：退款**不**清 actualCompanionId，订单仍指得到当初接单的人",
  );
  assert.deepEqual(
    await releasesOf(order.id),
    [],
    "退款不是「换人」：不写履约退出记录，段号不变——因此旧会话不会因为段号跳变而失权",
  );

  // —— 打手：读得到、发不出 ——
  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.ok(detail, "退款后打手**仍然读得到**这一段的历史，读取路径不因退款提前返回 null");
  assert.equal(detail.isReadOnly, true);
  assert.equal(detail.notice, COMPANION_CHAT_REFUNDED_NOTICE, "说明要换成「这一单退掉了」");
  assert.notEqual(
    detail.notice,
    COMPANION_CHAT_HISTORY_NOTICE,
    "不能再用「换人之后看不到」那一条——这一单既没换人也不是那种原因",
  );
  assert.deepEqual(
    bodiesOf(detail.messages),
    ["这一段之前说的话", "这一段之前的回复"].sort(),
    "历史一条不少",
  );
  await expectApiError(
    () => companionSends(COMPANION_A, order.id, "退款之后还想说一句"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );

  // —— 用户：读得到、发不出（对打手）——
  const view = await userView(order.userId, order.id);
  const assignment = view.segments.find((segment) => segment.kind === "assignment");
  assert.ok(assignment, "履约会话必须还在——「保留可查」指的就是它");
  assert.equal(assignment.isCurrent, true, "退款**不**把这一段变成历史段：人没被换掉");
  assert.equal(
    assignment.isReadOnly,
    true,
    "只读来自退款而不是「变成历史段」——这正是两个字段必须分开的理由",
  );
  assert.equal(assignment.messages.length, 2, "用户看到的历史同样一条不少");
  await expectApiError(
    () => userSends(order.userId, order.id, "退款之后还想说一句", "current"),
    "BAD_REQUEST",
    MESSAGE_ORDER_REFUNDED_MESSAGE,
  );

  // —— 客服会话不受影响：退款之后恰恰是用户最需要问客服的时候 ——
  await userSends(order.userId, order.id, "这一单为什么退了", "service");
  const service = (await userView(order.userId, order.id)).segments.find(
    (segment) => segment.kind === "service",
  );
  assert.ok(service);
  assert.equal(service.isReadOnly, false, "退款冻的是履约段，不是用户与客服的沟通");
  assert.deepEqual(
    bodiesOf(await messagesInServiceConversation(order.id)),
    ["这一单为什么退了"],
    "确认它真的落在客服会话里，而不是因为退款被静默丢弃",
  );
});

test("只读 3：`actualCompanionId` 保留，但**不再**是「还能聊」的充分条件", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "退款前的一句", "current");

  // 退款之前的对照面：归属成立 → 读得到、也发得出去
  const before = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.equal(before.isReadOnly, false, "对照面：退款之前不是只读");
  await companionSends(COMPANION_A, order.id, "退款前回的一句");

  await directRefundOrderForUser(order.id, order.userId, undefined, "server");

  // 退款之后：**归属这一条腿仍然是白的**——它照旧等于本人
  const after = await orderNow(order.id);
  assert.equal(
    after.actualCompanionId,
    COMPANION_A,
    "必要条件：退款之后 actualCompanionId 仍然等于本人，这条断言不成立下面什么也证明不了",
  );

  // 而同一条腿**已经不足以**让他发出去：写权限另外要求订单尚未 refunded
  await expectApiError(
    () => companionSends(COMPANION_A, order.id, "归属还在，但这一句必须被拒"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );
  // 读与写用同一条判据的两个方向，因此列表里的那一行也必须是只读的——
  // 否则列表说能发、聊天页说不能发
  const list = await listCompanionChats(COMPANION_A);
  const row = list.items.find((item) => item.orderId === order.id);
  assert.ok(row, "退款后的单仍然留在聊天列表里：记录要「可查」，藏掉入口等于查不到");
  assert.equal(row.isReadOnly, true, "列表与详情必须给出同一个答案");
});

test("只读 4：serving 全额退款同样只读（售后链路退满，而不是直接退款）", async () => {
  const order = await placeServingOrder(COMPANION_B);
  await getCompanionChatDetail(COMPANION_B, order.id);
  await userSends(order.userId, order.id, "服务中的一句", "current");

  const refunded = await refundAfterSales(order.id, order.userId, "100");
  assert.equal(refunded.status, "refunded", "退满之后订单转已退款");
  assert.equal(
    refunded.refundedAmount,
    refunded.actualPaidAmount,
    "「已退款」必须同时是「累计已退 = 实付」（P0-5.5 口径）",
  );
  assert.equal(refunded.actualCompanionId, COMPANION_B, "护航中的单退款同样保留归属");

  assert.equal(
    (await userView(order.userId, order.id)).segments.find((s) => s.kind === "assignment")
      .isReadOnly,
    true,
  );
  await expectApiError(
    () => userSends(order.userId, order.id, "退满了还想发", "current"),
    "BAD_REQUEST",
    MESSAGE_ORDER_REFUNDED_MESSAGE,
  );

  const detail = await getCompanionChatDetail(COMPANION_B, order.id);
  assert.ok(detail, "护航中的单退满之后，护航仍读得到这一段");
  assert.equal(detail.isReadOnly, true);
  assert.equal(detail.messages.length, 1, "历史同样一条不少");
  await expectApiError(
    () => companionSends(COMPANION_B, order.id, "退满了还想发"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );
});

test("只读 5：completed 全额退款同样只读——「已完结」不改变这条规则，只改变退款走哪条路", async () => {
  // 用预置数据：一张**已完结**且带实际打手的单，配一条挂在它上面的待审核申请。
  // 已完结的单不能直接退款，只能走售后审核——这正是这一档与前两档的区别。
  const orderId = "ord-seed-1003-01";
  const userId = "u-1003";
  const companionId = "cp-1";

  const before = await orderNow(orderId);
  assert.equal(before.status, "completed", "前置：这一单必须是已完结");
  assert.equal(before.actualCompanionId, companionId);
  await userSends(userId, orderId, "结单之后说的一句", "current");

  await approveAdminRefund("rf-seed-1003-01", "admin-1", {
    idempotencyKey: unique("key"),
    ...refundDecision("100"),
  });

  const after = await orderNow(orderId);
  assert.equal(after.status, "refunded");
  assert.equal(after.actualCompanionId, companionId, "已完结的单退款同样保留归属");

  assert.equal(
    (await userView(userId, orderId)).segments.find((s) => s.kind === "assignment").isReadOnly,
    true,
  );
  await expectApiError(
    () => userSends(userId, orderId, "退满了还想发", "current"),
    "BAD_REQUEST",
    MESSAGE_ORDER_REFUNDED_MESSAGE,
  );

  const detail = await getCompanionChatDetail(companionId, orderId);
  assert.ok(detail);
  assert.equal(detail.isReadOnly, true);
  assert.ok(
    detail.messages.some((message) => message.body === "结单之后说的一句"),
    "历史必须还在——这条用例同时否掉「退款顺手把记录删了」",
  );
  await expectApiError(
    () => companionSends(companionId, orderId, "退满了还想发"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );
});

test("只读 6：**部分**退款不结束履约——写权限照旧，只读不得被金额开关误触发", async () => {
  const order = await placeServingOrder(COMPANION_C);
  await getCompanionChatDetail(COMPANION_C, order.id);
  await userSends(order.userId, order.id, "退一半之前的一句", "current");

  const partial = await refundAfterSales(order.id, order.userId, "50");
  // 前提自检：这一条用例只有在「钱确实退了一部分、订单却没转已退款」时才成立
  assert.ok(partial.refundedAmount > 0, "前置：确实退了一部分钱");
  assert.notEqual(
    partial.status,
    "refunded",
    "前置：部分退款**不**把订单转成已退款——否则下面证明不了「判据不是金额」",
  );

  // 段仍然可写：这一条就是「拿 `refundedAmount > 0` 当开关」会踩中的那个坑
  const assignment = (await userView(order.userId, order.id)).segments.find(
    (segment) => segment.kind === "assignment",
  );
  assert.equal(assignment.isReadOnly, false, "退了一半但服务还在继续，这一段必须照旧可写");
  await userSends(order.userId, order.id, "退一半之后仍要能说", "current");

  const detail = await getCompanionChatDetail(COMPANION_C, order.id);
  assert.equal(detail.isReadOnly, false);
  await companionSends(COMPANION_C, order.id, "退一半之后仍要能回");
  // ⚠️ 发完**重新取一次**：上面那份 detail 是发送之前的快照，
  //    拿它来断言「三句话都在」只会证明发送没成功
  assert.deepEqual(
    bodiesOf((await getCompanionChatDetail(COMPANION_C, order.id)).messages),
    ["退一半之前的一句", "退一半之后仍要能说", "退一半之后仍要能回"].sort(),
    "三句话都在同一段里，没有因为退款被拒或被改道",
  );
});

test("只读 7：客服的调查读取完全不受退款影响", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "调查要看的一句", "current");
  await companionSends(COMPANION_A, order.id, "调查要看的回复");
  await userSends(order.userId, order.id, "也给客服说一句", "service");

  const before = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");
  await directRefundOrderForUser(order.id, order.userId, undefined, "server");
  const after = await getStaffConversationDetail(STAFF.id, order.id, undefined, "server");

  assert.ok(after, "退款不得让客服查不到这一单的沟通——售后调查恰恰发生在退款之后");
  assert.deepEqual(
    segmentTitles(after.segments),
    segmentTitles(before.segments),
    "段一个不少、顺序不变：退款只是关掉写权限，不改动会话结构",
  );
  assert.deepEqual(
    after.segments.flatMap((segment) => bodiesOf(segment.messages)),
    before.segments.flatMap((segment) => bodiesOf(segment.messages)),
    "每一段的消息也一条不少",
  );
  // ⚠️ 客服端**本来就没有** `isReadOnly`：客服对手会话一段都不可写（D5），
  //    因此「只读」这个概念在客服端不存在，也不该因为退款被顺手加上
  for (const segment of after.segments) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(segment, "isReadOnly"),
      false,
      "客服端分段不得出现 isReadOnly：客服对履约会话本来就不能写",
    );
  }
});

test("只读 8：只读的**判据只在服务端一处**——两个页面都不许拿 orderStatus 自己再判一次", () => {
  // 这是结构约束，不是文案断言：`isReadOnly` 一旦被页面用
  // `orderStatus === "refunded"` 重新推一遍，规则改成两种只读情形的那天，
  // 页面里那份副本不会跟着动，于是列表说能发、聊天页说不能发。
  const companionList = sourceOf("app", "companion", "(console)", "chats", "page.tsx");
  const companionDetail = sourceOf(
    "app",
    "companion",
    "(console)",
    "chats",
    "[orderId]",
    "page.tsx",
  );
  const companionConsole = sourceOf("components", "companion", "CompanionChatConsole.tsx");

  for (const [name, source] of [
    ["打手端聊天列表页", companionList],
    ["打手端聊天详情页", companionDetail],
    ["打手端聊天组件", companionConsole],
  ]) {
    assert.equal(
      source.includes('"refunded"'),
      false,
      `${name} 里出现了写死的 "refunded"：只读与否只有一处判据（服务端的 isReadOnly）`,
    );
  }

  // 用户端同理：它用服务端给的 isReadOnly / isCurrent **选文案**，不重算写权限
  const orderChat = sourceOf("components", "service", "OrderChat.tsx");
  assert.equal(
    orderChat.includes('"refunded"'),
    false,
    "用户端聊天组件不得自己判状态：它只消费 isReadOnly 与 isCurrent",
  );
  // 且两种原因确实各有各的文案（合并成一句会让用户在退款单上去问「谁把我换了」）
  assert.ok(
    orderChat.includes("CONVERSATION_SEGMENT_REFUNDED_NOTICE") &&
      orderChat.includes("CONVERSATION_SEGMENT_HISTORY_NOTICE"),
    "两种只读原因必须各有文案，且都从常量取",
  );
  assert.notEqual(
    CONVERSATION_SEGMENT_REFUNDED_NOTICE,
    CONVERSATION_SEGMENT_HISTORY_NOTICE,
    "「这一单退掉了」与「这段换人了」不是一回事，不能共用一句话",
  );
});

/** 这一单目前有哪些会话（**不过滤所有者**，用它做存在性判定）。 */
async function conversationsOf(orderId) {
  return getMessageRepository().listConversationsByOrderForStaff(orderId);
}

test("只读 9：被拒绝的发送**零副作用**——不会顺手把这一段空会话建出来", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);

  // ⚠️ 刻意**不**调 `getCompanionChatDetail`：履约会话是靠**读路径**惰性创建的，
  // 先把「这一刻它还不存在」钉住，才有资格验「被拒绝的写没把它建出来」。
  assert.deepEqual(
    await conversationsOf(order.id),
    [],
    "前置：还没人打开过聊天页，因此这一段会话此刻不该存在",
  );

  await directRefundOrderForUser(order.id, order.userId, undefined, "server");

  await expectApiError(
    () => companionSends(COMPANION_A, order.id, "退款之后的一次尝试"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );

  // 这一条是本项目对「状态闸拒绝」的既有约定：P0-13 的 `D22` 明文要求
  // 不在审批档位的订单 **400 且零副作用**。写闸与被拒绝的写是两件事——
  // 闸要是排在「确保会话存在」后面，一次失败的发送也会真的建出一段空会话，
  // 而**没有任何别的东西**会发现这件事（列表按订单取行，空会话看不出来）。
  assert.deepEqual(
    await conversationsOf(order.id),
    [],
    "400 必须零副作用：被拒绝的写不得留下会话记录",
  );

  // 反向对照：读路径**应当**建会话（「打开聊天页」本身就是开始沟通），
  // 因此上面那条断言不是「反正永远建不出来」的恒真句。
  await getCompanionChatDetail(COMPANION_A, order.id);
  const afterRead = await conversationsOf(order.id);
  assert.equal(afterRead.length, 1, "读路径仍然照常惰性建段——上一条断言才有区分度");
  assert.equal(afterRead[0].kind, "assignment");
});

test("只读 10：页顶说明与底栏说明**不是同一句话**——同一屏不许把一句话显示两遍", () => {
  // 这两条渲染在**同一块屏幕**上：页顶一段（`detail.notice`）、
  // 输入框原来的位置一段（`COMPANION_CHAT_READONLY_FOOTER`）。
  // 它们分工不同——页顶答「发生了什么、记录还在不在」，
  // 底栏答「这里为什么没有输入框」——但写成同一个字符串时，
  // 护航看到的是同一句话连着出现两遍，那是 bug 的样子。
  //
  // ⚠️ 这里只能断言「不相等」，不能断言各自的具体措辞：文案可以改，
  // 该钉住的是**它们不是同一个槽位**。
  assert.notEqual(
    COMPANION_CHAT_REFUNDED_NOTICE,
    COMPANION_CHAT_READONLY_FOOTER,
    "两条都渲染在同一屏上，同文等于重复显示",
  );
  assert.ok(
    COMPANION_CHAT_READONLY_FOOTER.includes("无法继续发送"),
    "底栏说明必须回答「为什么打不了字」，而不是复述订单状态",
  );
});

test("只读 11：退款单 + **非本人**发送仍是 404，不拿退款状态当预言机", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);
  await directRefundOrderForUser(order.id, order.userId, undefined, "server");
  assert.equal((await orderNow(order.id)).status, "refunded", "前置：这一单已全额退款");

  // ⚠️ 这一条守的是**闸序**，不是闸本身。
  //
  // 打手端的退款闸**刻意排在归属判定之后**：先确认「这段聊天确实是你的」，
  // 再告诉他「你的这段不能写了」。若有人图省事把退款闸提到归属判定之前，
  // 那么任何一个不相干的护航，拿别人的订单号发一条消息，
  // 就能从 400 / 404 的区别里读出「这张单退没退款」——
  // 一个只读的订单状态**预言机**。功能测试全绿，只有这条会红。
  //
  // 反向对照在最后：本人来发**确实**是 400。没有它，上面那句
  // 「必须是 404」可能只是因为整个发送路径都坏成了 404。
  await expectApiError(
    () => companionSends(COMPANION_B, order.id, "我不是这一单的人，但我想试试"),
    "NOT_FOUND",
    COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
  );
  assert.notEqual(
    COMPANION_CONVERSATION_FORBIDDEN_MESSAGE,
    COMPANION_ORDER_REFUNDED_MESSAGE,
    "两种拒绝必须是两句不同的话，否则「同形」无从谈起",
  );

  // 读路径同理：非本人读不到，且与「订单不存在」完全同形
  assert.equal(await getCompanionChatDetail(COMPANION_B, order.id), null);
  assert.equal(await getCompanionChatDetail(COMPANION_B, "ord-does-not-exist"), null);

  // 被拒的写零副作用：既不建段，也不落消息
  assert.deepEqual(await conversationsOf(order.id), [], "非本人的发送不得留下任何段");

  // —— 反向对照：同一条订单、同一个动作，本人来发是 400 ——
  await expectApiError(
    () => companionSends(COMPANION_A, order.id, "我才是这一单的人"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );
});

test("打手：没先打开聊天页也能直接发出第一条（发送路径自己把段建出来）", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);

  // ⚠️ 这一条守的是「退款闸零副作用」那次改动引入的**新分支**：
  // 发送现在先用**不建会话**的解析过闸，会话不存在时才回转去建。
  // 上一条用例只走到了「闸拒绝」那一侧，**建了再发**这一侧同样要有用例——
  // 否则改动把这条日常路径写坏（例如解析结果被判成 null 而报 404）也没人知道。
  assert.deepEqual(await conversationsOf(order.id), [], "前置：这一刻还没有这一段会话");

  const sent = await companionSends(COMPANION_A, order.id, "接单后第一句");
  assert.equal(sent.created, true, "打手不必先打开聊天页，直接发就该成功");

  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.ok(detail);
  assert.deepEqual(
    bodiesOf(detail.messages),
    ["接单后第一句"],
    "消息必须真的落进那一段",
  );
  assert.equal(detail.isReadOnly, false, "没退款就不该是只读");
});

// ——————————————————————————————————————————————————————————————————————
// 七、退款最终状态与「全额退款」之后的只读（P0-15 重写）
// ——————————————————————————————————————————————————————————————————————
//
// 原题（P0-14 人工验收 FAIL）：售后审批的退款额按整数百分比算（`floor(实付 × n / 100)`），
// 一张先退过部分款的订单「把剩下的全退掉」可能表达不出来，累计永远差一点 ⇒
// 订单永远进不了 `refunded`。P0-14 的修法是补一条「退满剩余」的金额表达方式。
//
// ⚠️ **P0-15（2026-09-28 产品裁定）把那条前提整个删掉了**：一个订单**最多一次**退款申请，
// 一次退款决定退多少，没有「先退部分、再补退」这条路，也就没有「累计差一点」这个洞。
// 「退满剩余」这一支连同 `refundRemainingAfterSales` 辅助函数一并删除。
//
// 本节保留的两条规则仍然成立，并且都必须走**真实的售后链路**
// （用户申请 / 预置申请 + 服务端批准），而不是手工把订单状态改掉——
// 否则证明不了「这条路真的走得到」：
//
//  1. 全额退款（100%）→ 订单进入 `refunded` → 派单沟通**立即**只读；
//  2. 部分退款（例如 30%）→ 订单 `status` **不变**（仍是 `completed`），
//     派单沟通**仍然可写**——判据是**真实订单状态**（`isOrderChatClosed`），
//     不是「退过钱」这个事实，也不是打手端的展示状态 `displayStatus`。
//
// 金额侧证据（比例公式、打手冲回恒为全额）在 `tests/adminRefunds.test.mjs`
// 与 `tests/refundMoneyChain.test.mjs`。

test("只读 12：Companion 订单 DTO 的 status 读的是订单——退款后不再报「已接单」", async () => {
  const order = await placeOrder();
  await accept(order.id, COMPANION_A);

  // 对照面：退款之前 DTO 报的就是「已接单」。没有这一面，下面那句「不再是已接单」
  // 可能只是因为整个字段读错了源。
  const before = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(before);
  assert.equal(before.status, "accepted");
  assert.equal(before.statusLabel, ORDER_STATUS_LABELS.accepted);

  await directRefundOrderForUser(order.id, order.userId, undefined, "server");
  assert.equal((await orderNow(order.id)).status, "refunded", "前置：订单已全额退款");

  const after = await getCompanionOrderDetail(COMPANION_A, order.id);
  assert.ok(after, "退款不把这一单从打手的历史里抹掉——它仍然属于他（可查）");
  assert.equal(
    after.status,
    "refunded",
    "工作台必须显示真实最终状态，不得停在「已接单 / 护航中」",
  );
  assert.notEqual(after.status, "accepted");
  assert.equal(after.statusLabel, ORDER_STATUS_LABELS.refunded);
  assert.equal(after.statusLabel, "已退款");
  // 两个动作旗标由状态推导：已退款的单既不能取消也不能开始
  assert.equal(after.canCancel, false);
  assert.equal(after.canStart, false);

  // 列表与详情必须给出同一个答案（否则列表卡片还写着「已接单」）
  const list = await listCompanionOrders(COMPANION_A);
  const row = list.items.find((item) => item.id === order.id);
  assert.ok(row, "退款后的单仍留在打手的订单列表里");
  assert.equal(row.status, "refunded");
  assert.equal(row.statusLabel, ORDER_STATUS_LABELS.refunded);
});

test("只读 13：全额退款走完整售后链路 ⇒ 派单沟通**立即**只读，客服会话仍可写", async () => {
  // ⚠️ P0-15 重写：旧版本的前提是「多次退款累计退满」——先退 33% 再补退剩余。
  // 产品 2026-09-28 裁定**一个订单最多一次退款申请**，那条前提已不存在：
  // 第二次 `createRefundForOrder` 会被以 `REFUND_ALREADY_EXISTS_MESSAGE` 拒绝。
  // 换成「一笔 100% 退款」——它同样必须走真实链路，而不是把订单状态改成 refunded。
  const order = await placeServingOrder(COMPANION_A);
  await getCompanionChatDetail(COMPANION_A, order.id);
  await userSends(order.userId, order.id, "退之前的一句", "current");

  const refunded = await refundAfterSales(order.id, order.userId, "100");
  assert.equal(refunded.status, "refunded", "100% 退款 ⇒ 订单进入已退款");
  assert.equal(
    refunded.refundedAmount,
    refunded.actualPaidAmount,
    "「已退款」必须同时是「累计已退 = 实付」——不得出现「已退款但累计已退 0 元」",
  );

  // 「立即」的含义：批准一返回就读，中间不做任何其它动作
  // （不是靠刷新 / 惰性物化才变只读）
  const assignment = (await userView(order.userId, order.id)).segments.find(
    (s) => s.kind === "assignment",
  );
  assert.ok(assignment);
  assert.equal(assignment.isCurrent, true, "退款不换人：段仍是当前段，只关写权限");
  assert.equal(assignment.isReadOnly, true, "全额退款之后当前段立即只读");
  await expectApiError(
    () => userSends(order.userId, order.id, "退满之后还想说", "current"),
    "BAD_REQUEST",
    MESSAGE_ORDER_REFUNDED_MESSAGE,
  );

  const detail = await getCompanionChatDetail(COMPANION_A, order.id);
  assert.ok(detail, "退款前的历史仍然读得到");
  assert.equal(detail.isReadOnly, true);
  assert.deepEqual(bodiesOf(detail.messages), ["退之前的一句"], "退款前的历史一条不少");

  // 列表与详情必须给出同一个答案——否则列表卡片说能发、聊天页说不能发
  const row = (await listCompanionChats(COMPANION_A)).items.find(
    (item) => item.orderId === order.id,
  );
  assert.ok(row, "退款后的单仍然留在聊天列表里：记录要「可查」，藏掉入口等于查不到");
  assert.equal(row.isReadOnly, true, "列表与详情必须给出同一个答案");

  await expectApiError(
    () => companionSends(COMPANION_A, order.id, "退满之后还想说"),
    "BAD_REQUEST",
    COMPANION_ORDER_REFUNDED_MESSAGE,
  );

  // 客服线仍然可写（产品裁定二：退款之后恰恰最需要问客服）
  await userSends(order.userId, order.id, "这一单退款的问题问客服", "service");
});

test("只读 14：部分退款**不改**订单 status ⇒ 派单沟通仍然可写（判据是真实状态，不是 displayStatus）", async () => {
  // P0-15 新规则的两条线在这里**同时**可见：
  //   打手端的**展示状态** `displayStatus` 变成「已退款」（他的钱确实全没了），
  //   而订单的**真实生命周期** `status` 不变（仍是 completed）。
  // 聊天的可写性看真实状态，所以这一段必须**照旧可写**——
  // 「打手看到已退款就把沟通锁掉」会让部分退款的售后沟通在最需要的时候断掉。
  //
  // 用预置数据：一张**已完结**且带实际打手的单，配一条挂在它上面的待审核申请。
  // 已完结的单不能直接退款，只能走售后审核——批准走服务层，是真实的链路。
  const orderId = "ord-seed-1003-01";
  const userId = "u-1003";
  const companionId = "cp-1";

  const before = await orderNow(orderId);
  assert.equal(before.status, "completed", "前置：这一单是已完结");
  assert.equal(before.actualCompanionId, companionId);
  await getCompanionChatDetail(companionId, orderId);
  await userSends(userId, orderId, "退三成之前的一句", "current");

  // 真实链路：预置的待审核申请 + 服务端按 30% 批准
  await approveAdminRefund("rf-seed-1003-01", "admin-1", {
    idempotencyKey: unique("key"),
    ...refundDecision("30"),
  });

  const after = await orderNow(orderId);
  assert.ok(after.refundedAmount > 0, "前置：确实退了一部分钱");
  assert.ok(
    after.refundedAmount < after.actualPaidAmount,
    "前置：这一笔必须是**部分**退款（没退满），否则证明不了「判据不是金额」",
  );
  assert.equal(after.status, "completed", "部分退款不改订单真实状态");

  // 写权限：两侧都还开着（只读 6 验过区分度，这里验的是「completed + 部分退款」这一档）
  const assignment = (await userView(userId, orderId)).segments.find(
    (s) => s.kind === "assignment",
  );
  assert.ok(assignment);
  assert.equal(assignment.isReadOnly, false, "部分退款之后用户这一侧仍然可写");

  const companionDetail = await getCompanionChatDetail(companionId, orderId);
  assert.ok(companionDetail);
  assert.equal(
    companionDetail.isReadOnly,
    false,
    "部分退款不锁写：判据是真实订单状态，不是「退过钱」",
  );

  // 打手端展示状态与真实状态**分开**：这是 rule 7 的正面证据
  const companionOrder = await getCompanionOrderDetail(companionId, orderId);
  assert.ok(companionOrder);
  assert.equal(
    companionOrder.displayStatus,
    "refunded",
    "打手端展示状态：钱已经全没了，必须显示「已退款」",
  );
  assert.equal(
    companionOrder.status,
    "completed",
    "但订单真实状态不变——展示状态【不】参与可写性判断，两者不是一回事",
  );

  await userSends(userId, orderId, "退三成之后仍要能说", "current");
  await companionSends(companionId, orderId, "退三成之后仍要能回");
  // ⚠️ 发完**重新取一次**：上面那份 companionDetail 是发送之前的快照，
  //    拿它来断言「三句话都在」只会证明发送没成功
  assert.deepEqual(
    bodiesOf((await getCompanionChatDetail(companionId, orderId)).messages),
    ["退三成之前的一句", "退三成之后仍要能说", "退三成之后仍要能回"].sort(),
    "三句话都在同一段里，没有因为退款被拒或被改道",
  );
});
