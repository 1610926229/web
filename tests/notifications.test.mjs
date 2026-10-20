import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import { NOTIFICATION_KIND_LABELS } from "../lib/constants/service.ts";
import {
  appendNotification,
  newNotificationId,
  notificationStore,
} from "../lib/data/mockNotificationRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { notificationSeed } from "../lib/mocks/fixtures/notificationSeed.ts";
import {
  createNotificationForUser,
  queryNotificationsForUser,
} from "../lib/services/notifications.ts";

/**
 * P0-2「站内通知写入能力」的持续测试。
 *
 * 这一批补的是通知**唯一的写入路径**：在此之前通知只能来自预置数据，
 * 订单超时退款、订单回公共池这类业务事件没有任何办法通知到用户。
 *
 * 重点是三件事：
 *
 * 1. **写入是同步的**（`appendNotification`）。业务写入（如订单超时退款）发生在
 *    「读—判断—写」的原子区段内，区段里不允许出现 `await`；通知必须与业务数据
 *    在同一段同步代码里写下去，否则会出现「订单退了但没通知」。
 * 2. **归属不可串**。给 A 写的通知不能出现在 B 的列表里，未读数也不能涨。
 * 3. **内容边界在写入口就挡住**。通知正文不带订单敏感信息、`href` 只允许站内路径，
 *    这两条以前只由预置数据的自检保证，现在写入路径也必须守住。
 *
 * 每个用例开始前重建通知 store（拿到干净的预置数据）。
 */

const USER_A = "u-1001";
const USER_B = "u-1002";

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

async function list(userId, params = page()) {
  return queryNotificationsForUser(userId, params, "server");
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 一条合法输入。每个用例按需覆盖其中一两个字段，避免重复写六行。 */
function input(overrides = {}) {
  return {
    userId: USER_A,
    kind: "dispatch",
    title: "订单超时已退款",
    summary: "订单在公共池无人接单，已自动全额退款",
    body: "订单在公共订单池等待超过约定时长仍无人接单，订单已停止接取并全额退回。",
    href: "/orders/ord-demo-1",
    ...overrides,
  };
}

beforeEach(() => {
  resetMockStore("notification");
});

// ——————————————————————— 一、类型与标签 ———————————————————————

test("通知类型标签覆盖全部 kind，且新增的派单类型有中文标签", () => {
  // Kinds 是**联合类型**，运行时取不到；从类型文件里读出来，确保「类型加了成员但忘了登记标签」会失败
  const source = readFileSync(new URL("../lib/types/notification.ts", import.meta.url), "utf8");
  const line = source.split("\n").find((row) => row.startsWith("export type NotificationKind"));
  assert.ok(line, "没找到 NotificationKind 的类型声明");

  const declared = [...line.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(declared, ["complaint", "dispatch", "order", "refund", "system"]);
  assert.deepEqual(Object.keys(NOTIFICATION_KIND_LABELS).sort(), declared);

  for (const [kind, label] of Object.entries(NOTIFICATION_KIND_LABELS)) {
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `${kind} 的标签不能为空`);
  }
  assert.equal(NOTIFICATION_KIND_LABELS.dispatch, "派单");
});

// ——————————————————————— 二、同步写入器 ———————————————————————

test("appendNotification 是同步的：原子区段里调用它拿到的是记录，不是 Promise", () => {
  // ⚠️ 这一条不是风格问题：返回 Promise 会让「订单超时退款 + 写通知」不得不在
  // 原子区段里 await，区段一旦被 await 切断，两个用户同时触发就会各写各的。
  const record = appendNotification({
    id: "nt-atomic-1",
    userId: USER_A,
    kind: "dispatch",
    title: "标题",
    summary: "摘要",
    body: "正文",
    createdAt: "2026-09-17T00:00:00.000Z",
    readAt: null,
    href: null,
  });

  assert.equal(record instanceof Promise, false);
  assert.equal(record.id, "nt-atomic-1");
  assert.equal(notificationStore().notifications.get("nt-atomic-1"), record);
});

test("已有通知不会被新记录顶掉：id 重复时 appendNotification 抛错，原记录原样保留", async () => {
  const existing = notificationSeed[0];
  const before = notificationStore().notifications.get(existing.id);

  assert.throws(
    () =>
      appendNotification({
        ...existing,
        title: "顶掉它的标题",
        summary: "顶掉它的摘要",
      }),
    /拒绝覆盖/,
  );

  // 一条已经写给用户的业务事实不能被静默替换
  assert.deepEqual(notificationStore().notifications.get(existing.id), before);
});

test("newNotificationId 生成的 id 当前一定没被占用，且互不相同", () => {
  const current = notificationStore().notifications;
  const generated = new Set();

  for (let index = 0; index < 200; index += 1) {
    const id = newNotificationId();
    assert.equal(current.has(id), false, `生成的 id 已被占用：${id}`);
    assert.equal(generated.has(id), false, `本次生成了重复的 id：${id}`);
    generated.add(id);
  }

  // 写下去之后，再生成的下一个 id 仍然不会与它冲突
  const record = appendNotification({
    id: newNotificationId(),
    userId: USER_A,
    kind: "dispatch",
    title: "标题",
    summary: "摘要",
    body: "正文",
    createdAt: "2026-09-17T00:00:00.000Z",
    readAt: null,
    href: null,
  });
  assert.equal(notificationStore().notifications.get(record.id), record);
  assert.equal(current.has(newNotificationId()), false);
});

test("appendNotification 写进去的通知能被列表查到，且只属于接收人", async () => {
  const before = await list(USER_B);

  appendNotification({
    id: "nt-atomic-2",
    userId: USER_A,
    kind: "dispatch",
    title: "标题",
    summary: "摘要",
    body: "正文",
    createdAt: "2026-09-17T00:00:00.000Z",
    readAt: null,
    href: null,
  });

  const mine = await list(USER_A);
  assert.equal(mine.items.filter((item) => item.id === "nt-atomic-2").length, 1);

  // 别人的列表与未读数都不受影响
  const other = await list(USER_B);
  assert.equal(other.total, before.total);
  assert.equal(other.unreadCount, before.unreadCount);
  assert.equal(other.items.some((item) => item.id === "nt-atomic-2"), false);
});

test("新通知初始未读：未读数 +1，且排在列表最前面", async () => {
  const before = await list(USER_A);

  const created = await createNotificationForUser(input());

  assert.equal(created.readAt, null);
  assert.equal(created.kind, "dispatch");
  assert.equal(created.userId, USER_A);

  const after = await list(USER_A);
  assert.equal(after.total, before.total + 1);
  assert.equal(after.unreadCount, before.unreadCount + 1);
  assert.equal(after.items[0].id, created.id);
});

test("仓储生成的通知 id 不与既有记录冲突，也不与同一批连续创建的其他记录冲突", async () => {
  const repository = getNotificationRepository();
  const existing = new Set(notificationSeed.map((item) => item.id));
  const created = new Set();
  const seedCountForA = notificationSeed.filter((item) => item.userId === USER_A).length;

  for (let index = 0; index < 50; index += 1) {
    const notification = await repository.createNotification(input({ summary: `摘要 ${index}` }));
    assert.equal(existing.has(notification.id), false, `id 与预置数据冲突：${notification.id}`);
    assert.equal(created.has(notification.id), false, `id 与本次创建冲突：${notification.id}`);
    created.add(notification.id);
  }

  // 落库的条数对得上：不是创建成功但写丢了
  assert.equal((await list(USER_A)).total, seedCountForA + 50);
  assert.equal(notificationStore().notifications.size, notificationSeed.length + 50);
});

// ——————————————————————— 三、服务层写入口 ———————————————————————

test("服务层写入：创建后立刻能在自己的列表里读到，字段原样保留", async () => {
  const created = await createNotificationForUser(
    input({ title: "订单已回到公共池", summary: "原接单打手已放弃", body: "订单已回到公共订单池，等待其他打手接单。", href: null }),
  );

  const page = await list(USER_A);
  const found = page.items.find((item) => item.id === created.id);
  assert.ok(found, "刚创建的通知应当立刻出现在列表里");
  assert.equal(found.title, "订单已回到公共池");
  assert.equal(found.summary, "原接单打手已放弃");
  assert.equal(found.href, null);
  assert.equal(found.userId, USER_A);
  assert.ok(found.createdAt > "2026-09-12T18:20:00.000Z", "创建时间应当是当前时刻之后");
});

test("服务层写入：给 A 创建的通知不会出现在 B 的列表里，B 的未读数也不变", async () => {
  const before = await list(USER_B);
  await createNotificationForUser(input({ userId: USER_A }));

  const after = await list(USER_B);
  assert.equal(after.total, before.total);
  assert.equal(after.unreadCount, before.unreadCount);
  assert.equal(after.items.every((item) => item.userId === USER_B), true);
});

test("收件人与正文缺一不可：任何一种缺失都是 400，且什么都不写", async () => {
  const before = await list(USER_A);
  const store = notificationStore();

  for (const broken of [
    { userId: "" },
    { userId: "   " },
    { title: "" },
    { title: "  " },
    { summary: "" },
    { body: "" },
    { body: "   " },
  ]) {
    await expectApiError(createNotificationForUser(input(broken)), "BAD_REQUEST");
  }

  assert.equal(store.notifications.size, notificationSeed.length);
  const after = await list(USER_A);
  assert.equal(after.total, before.total);
  assert.equal(after.unreadCount, before.unreadCount);
});

test("跳转地址只允许站内路径：带查询串或不是以 / 开头都会被拒", async () => {
  const before = notificationStore().notifications.size;

  for (const href of ["/orders/ord-demo-1?reason=超时", "reason=超时", "https://example.com", "orders/1"]) {
    await expectApiError(createNotificationForUser(input({ href })), "BAD_REQUEST");
  }

  // href 允许为空：不是每条通知都有可跳转的页面
  const created = await createNotificationForUser(input({ href: null }));
  assert.equal(created.href, null);
  assert.equal(notificationStore().notifications.size, before + 1);
});

test("服务层写入的仍是当前用户：请求体里传别人的 userId 由服务端决定归属", async () => {
  // 这一条锁住「归属只能来自参数，不能来自请求体」这条边界在写入路径上同样成立：
  // 服务层的入参就是接收人本身，没有第二个可以覆盖它的字段
  const created = await createNotificationForUser(input({ userId: USER_B }));
  assert.equal(created.userId, USER_B);

  const mine = await list(USER_A);
  assert.equal(mine.items.some((item) => item.id === created.id), false);
  const other = await list(USER_B);
  assert.equal(other.items.some((item) => item.id === created.id), true);
});

// ——————————————————————— 四、仓储边界 ———————————————————————

test("通知仓储只有这四个方法：没有任何删除或修改正文的入口", async () => {
  const repository = getNotificationRepository();

  assert.deepEqual(
    Object.keys(repository).sort(),
    ["createNotification", "findNotificationById", "listNotifications", "markNotificationRead"],
  );
  for (const forbidden of ["delete", "remove", "update", "save", "append"]) {
    assert.equal(typeof repository[forbidden], "undefined", `通知仓储不该有 ${forbidden}`);
  }
});

test("仓储层不生成已读时间：新记录一定是未读", async () => {
  const created = await getNotificationRepository().createNotification(input());
  assert.equal(created.readAt, null);
  // 重新读一次仍然是未读——读取不会顺手标记已读
  const again = await getNotificationRepository().findNotificationById(created.id);
  assert.equal(again.readAt, null);
});
