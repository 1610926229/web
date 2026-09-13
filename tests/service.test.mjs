import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  MESSAGE_EMPTY_MESSAGE,
  MESSAGE_MAX_LENGTH,
  MESSAGE_TOO_LONG_MESSAGE,
  normalizeMessageBody,
} from "../lib/constants/service.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { messageSeed } from "../lib/mocks/fixtures/messageSeed.ts";
import { notificationSeed } from "../lib/mocks/fixtures/notificationSeed.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import {
  getMessagesForUser,
  listConversationsForUser,
  markConversationReadForUser,
  sendMessageForUser,
} from "../lib/services/conversations.ts";
import {
  markNotificationReadForUser,
  queryNotificationsForUser,
} from "../lib/services/notifications.ts";

/**
 * 客服专区（订单沟通 / 系统通知）的持续测试。
 *
 * 跑真实实现：真实的 Mock 仓储 + 真实的 `lib/services/conversations.ts` /
 * `lib/services/notifications.ts`。重点覆盖：**只能看 / 只能发自己的订单会话**、
 * **发送者身份由服务端写入**、**空消息与重复发送被挡住**、**只读得到自己的通知**。
 *
 * 每个用例开始前重建消息与通知 store。支付 / 订单 store 不重建：
 * 发消息与标记已读都不该改动订单。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 有预置会话、且对方发来的消息未读的订单 */
const UNREAD_ORDER = "ord-seed-1001-04";
/** 没有任何会话的订单（属于 USER_A）：用来验证「主动发起沟通」 */
const NO_CONVERSATION_ORDER = "ord-seed-1001-02";
/** USER_B 的订单 */
const OTHER_USER_ORDER = "ord-seed-1002-01";

function key() {
  return crypto.randomUUID();
}

function messageBody(text, overrides = {}) {
  return { body: text, idempotencyKey: key(), ...overrides };
}

async function expectApiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("message");
  resetMockStore("notification");
});

test("会话列表只包含自己的订单会话，且不含游戏 ID 与备注", async () => {
  const conversations = await listConversationsForUser(USER_A, undefined, "server");
  const myOrders = new Set(
    orderSeed.filter((order) => order.userId === USER_A).map((order) => order.id),
  );

  // 每一条会话都必须挂在**自己的**订单上
  assert.ok(conversations.length > 0);
  assert.ok(conversations.every((item) => myOrders.has(item.orderId)));

  // 预置里有消息的会话都在
  const seeded = new Set(messageSeed.filter((item) => item.userId === USER_A).map((item) => item.orderId));
  const listed = new Set(conversations.map((item) => item.orderId));
  for (const orderId of seeded) {
    assert.ok(listed.has(orderId), `预置会话 ${orderId} 没有出现在会话列表里`);
  }

  // 刚发起、还没有任何消息的会话也要在列表里：会话的存在不以「有消息」为条件
  const empty = conversations.find((item) => item.orderId === "ord-seed-1001-07");
  assert.ok(empty, "还没有消息的会话也应当出现在列表里");
  assert.equal(empty.messageCount, 0);
  assert.equal(empty.lastMessageBody, null);
  assert.equal(empty.lastMessageAt, null);

  const sample = conversations[0];
  assert.equal(sample.gameAccountId, undefined);
  assert.equal(sample.remark, undefined);
  assert.ok(sample.orderNo.length > 0);
  assert.ok(sample.productTitle.length > 0);

  // 另一个用户只看得到自己的那一笔
  const other = await listConversationsForUser(USER_B, undefined, "server");
  assert.deepEqual(
    other.map((item) => item.orderId),
    [OTHER_USER_ORDER],
  );
});

test("未读数只算对方发来的消息，自己发消息不会让自己变成未读", async () => {
  const [before] = (await listConversationsForUser(USER_A, undefined, "server")).filter(
    (item) => item.orderId === UNREAD_ORDER,
  );
  assert.ok(before.unreadCount > 0, "预置的会话应当有对方发来的未读消息");

  await sendMessageForUser(USER_A, UNREAD_ORDER, messageBody("在的，麻烦帮我看看进度"), undefined, "server");

  const [after] = (await listConversationsForUser(USER_A, undefined, "server")).filter(
    (item) => item.orderId === UNREAD_ORDER,
  );
  assert.equal(after.unreadCount, before.unreadCount);
});

test("用户隔离：读不到别人的会话，也发不了别人的订单", async () => {
  assert.equal(await getMessagesForUser(USER_B, UNREAD_ORDER, undefined, "server"), null);
  assert.equal(await getMessagesForUser(USER_A, OTHER_USER_ORDER, undefined, "server"), null);

  const before = await getMessagesForUser(USER_B, OTHER_USER_ORDER, undefined, "server");
  await expectApiError(
    sendMessageForUser(USER_A, OTHER_USER_ORDER, messageBody("你好"), undefined, "server"),
    "NOT_FOUND",
  );

  // 失败的发送没有留下任何消息
  const after = await getMessagesForUser(USER_B, OTHER_USER_ORDER, undefined, "server");
  assert.equal(after.messages.length, before.messages.length);
});

test("空消息与纯空白消息被拒绝，超长消息被拒绝", async () => {
  await expectApiError(
    sendMessageForUser(USER_A, UNREAD_ORDER, messageBody(""), undefined, "server"),
    "BAD_REQUEST",
  );
  await expectApiError(
    sendMessageForUser(USER_A, UNREAD_ORDER, messageBody("   \n  "), undefined, "server"),
    "BAD_REQUEST",
  );
  await expectApiError(
    sendMessageForUser(
      USER_A,
      UNREAD_ORDER,
      messageBody("啊".repeat(MESSAGE_MAX_LENGTH + 1)),
      undefined,
      "server",
    ),
    "BAD_REQUEST",
  );

  // 纯规则函数：去除空白后为空、或超长都不通过
  assert.equal(normalizeMessageBody("   ").ok, false);
  assert.equal(normalizeMessageBody("   ").message, MESSAGE_EMPTY_MESSAGE);
  assert.equal(normalizeMessageBody("啊".repeat(MESSAGE_MAX_LENGTH + 1)).message, MESSAGE_TOO_LONG_MESSAGE);
  // 去空白后的内容才会被存下来
  assert.deepEqual(normalizeMessageBody("  在吗  "), { ok: true, body: "在吗" });
});

test("重复发送：同一个幂等键只产生一条消息", async () => {
  const before = await getMessagesForUser(USER_A, UNREAD_ORDER, undefined, "server");
  const body = messageBody("麻烦帮我看一下这一单的进度");

  const first = await sendMessageForUser(USER_A, UNREAD_ORDER, body, undefined, "server");
  const second = await sendMessageForUser(USER_A, UNREAD_ORDER, body, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.messageId, first.messageId);

  const after = await getMessagesForUser(USER_A, UNREAD_ORDER, undefined, "server");
  assert.equal(after.messages.length, before.messages.length + 1);
});

test("发送者身份由服务端写入：请求体里的角色与发送者会被忽略", async () => {
  const { messageId } = await sendMessageForUser(
    USER_A,
    UNREAD_ORDER,
    messageBody("这条消息试图伪装成客服", {
      senderRole: "support",
      senderId: "support-01",
      senderName: "平台客服",
      userId: USER_B,
    }),
    undefined,
    "server",
  );

  const { messages } = await getMessagesForUser(USER_A, UNREAD_ORDER, undefined, "server");
  const sent = messages.find((message) => message.id === messageId);

  assert.equal(sent.senderRole, "user");
  assert.equal(sent.senderId, USER_A);
  assert.equal(sent.userId, USER_A);
  assert.equal(sent.orderId, UNREAD_ORDER);
  assert.ok(sent.createdAt.length > 0);
});

test("消息按时间先后排列，且只包含本会话的消息", async () => {
  const { messages } = await getMessagesForUser(USER_A, UNREAD_ORDER, undefined, "server");
  assert.ok(messages.length > 0);
  assert.ok(messages.every((message) => message.orderId === UNREAD_ORDER));

  const times = messages.map((message) => message.createdAt);
  assert.deepEqual(times, [...times].sort());
});

test("主动发起沟通：没有会话的订单会在打开时建立会话，并出现在会话列表里", async () => {
  const before = await listConversationsForUser(USER_A, undefined, "server");
  assert.ok(!before.some((item) => item.orderId === NO_CONVERSATION_ORDER));

  const payload = await getMessagesForUser(USER_A, NO_CONVERSATION_ORDER, undefined, "server");
  assert.deepEqual(payload.messages, []);
  assert.equal(payload.conversation.orderId, NO_CONVERSATION_ORDER);
  assert.equal(payload.conversation.unreadCount, 0);

  const after = await listConversationsForUser(USER_A, undefined, "server");
  assert.ok(after.some((item) => item.orderId === NO_CONVERSATION_ORDER));
});

test("标记会话已读：未读归零，且改不了别人的会话", async () => {
  const marked = await markConversationReadForUser(USER_A, UNREAD_ORDER);
  assert.equal(marked, true);

  const conversations = await listConversationsForUser(USER_A, undefined, "server");
  const target = conversations.find((item) => item.orderId === UNREAD_ORDER);
  assert.equal(target.unreadCount, 0);

  // 别人的会话：直接返回 false，不产生任何改动
  assert.equal(await markConversationReadForUser(USER_B, UNREAD_ORDER), false);
});

test("通知只包含自己的：未读数、列表与归属都对得上", async () => {
  const page = await queryNotificationsForUser(USER_A, new URLSearchParams(), "server");
  const mine = notificationSeed.filter((item) => item.userId === USER_A);

  assert.equal(page.total, mine.length);
  assert.equal(page.unreadCount, mine.filter((item) => item.readAt === null).length);
  assert.ok(page.items.every((item) => item.userId === USER_A));

  // 列表按时间倒序
  const times = page.items.map((item) => item.createdAt);
  assert.deepEqual(times, [...times].sort().reverse());
});

test("通知可以标记已读，重复标记不改变第一次的已读时间", async () => {
  const page = await queryNotificationsForUser(USER_A, new URLSearchParams(), "server");
  const unread = page.items.find((item) => item.readAt === null);
  assert.ok(unread, "预置数据里应当有未读通知");

  const first = await markNotificationReadForUser(USER_A, unread.id);
  assert.ok(first.readAt);

  const second = await markNotificationReadForUser(USER_A, unread.id);
  assert.equal(second.readAt, first.readAt);

  const after = await queryNotificationsForUser(USER_A, new URLSearchParams(), "server");
  assert.equal(after.unreadCount, page.unreadCount - 1);
});

test("用户隔离：标记别人的通知返回 404，且对方的未读数不变", async () => {
  const other = notificationSeed.find((item) => item.userId === USER_B);
  await expectApiError(markNotificationReadForUser(USER_A, other.id), "NOT_FOUND");
  await expectApiError(markNotificationReadForUser(USER_A, "nt-not-exist"), "NOT_FOUND");

  const otherPage = await queryNotificationsForUser(USER_B, new URLSearchParams(), "server");
  assert.equal(otherPage.items[0].readAt, other.readAt);
});

test("通知内容不带订单敏感信息，跳转地址里只有资源 id", () => {
  for (const item of notificationSeed) {
    const text = `${item.title}${item.summary}${item.body}`;
    for (const word of ["游戏ID", "游戏 ID", "备注："]) {
      assert.ok(!text.includes(word), `通知 ${item.id} 的正文出现了「${word}」`);
    }
    if (item.href) {
      assert.ok(!item.href.includes("?"), `通知 ${item.id} 的跳转地址带了查询串`);
    }
  }
});
