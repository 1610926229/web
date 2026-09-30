import assert from "node:assert/strict";
import test from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";

import {
  COMPANION_CHAT_HISTORY_NOTICE,
  COMPANION_CHAT_REFUNDED_NOTICE,
} from "../lib/constants/conversations.ts";
import {
  COMPANION_ORDER_REFUNDED_MESSAGE,
  MESSAGE_ORDER_REFUNDED_MESSAGE,
} from "../lib/constants/service.ts";

/**
 * P0-14 HTTP 契约 —— 打手端订单聊天与用户端分段落点的**权限矩阵**
 * （`cmd_p0-14.md` §十四 25～32）。
 *
 * ## 这一层与 `tests/assignmentConversations.test.mjs` 的分工
 *
 * 那个文件在服务层证明「谁看得到什么」；这个文件证明**那些结论真的穿过了 HTTP 边界**：
 * 守卫是不是第一件事、失败是不是同一个 404、响应里是不是真的没有内部键。
 * 两处都要有，因为中间隔着一个响应序列化，而「服务层返回了干净的 DTO」与
 * 「HTTP 响应里没有那个键」是两件不同的事。
 *
 * ## 为什么这一批不能只在进程内跑
 *
 * 打手身份建立在**用户会话 + 名下护航资料**之上（`lib/api/companionRoute.ts`），
 * 而会话是 Cookie。进程内的服务层调用**没有**这一层，因此「未登录 401」
 * 「登录了但不是打手 403」这两格只能在真实服务上验。
 *
 * ## 用例之间怎么隔离
 *
 * 这一批跑在**另一个进程**里，`resetMockStore()` 够不着它。因此每一组断言都
 * **只用自己的那几张订单**：下单用户是预置用户，但订单是当场新造的，
 * 且每一组都新造一张。绝不假设全局只有自己那一单。
 *
 * 依赖真实服务：没设 `APP_BASE_URL` 时整批自动跳过（与 `earningsHttp.test.mjs` /
 * `completionHttp.test.mjs` 同一取舍）。按门禁要求，正式验收时 `skip` 必须为 0。
 */

const BASE = process.env.APP_BASE_URL;

// ⚠️ 必须在**发起任何请求之前**执行——这一行加上 --test-concurrency=1，才是「本文件的断言读到的是预置状态」的保证。
await resetServerStores();
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://127.0.0.1:3214），跳过 P0-14 聊天 HTTP 契约";

/** `u-1022` 名下是 `cp-10`、`u-1023` 名下是 `cp-11`：两位**有效**打手，互不相干。 */
const USER_COMPANION_A = "u-1022";
const USER_COMPANION_B = "u-1023";
const COMPANION_A = "cp-10";
const COMPANION_B = "cp-11";
/**
 * 下单用户（**也是**「登录了但不是打手」那一格的样本：名下没有护航资料）。
 *
 * ⚠️ 下单的人**必须**与接单的人不同：`listCompanionPools` 会把
 * 「自己下的单」从自己的池子里剔掉（`lib/constants/dispatch.ts` 的 `self-order` 文案），
 * 因此让 A 自己下单再自己接，池子里永远找不到它——这一组会空转。
 * 这也是既有 HTTP 用例（`tests/staffOrderActions.test.mjs`）里下单用户是 `u-1001`、
 * 接单打手是 `u-1022` 的原因。
 */
const USER_ORDER = "u-1001";

/** 目录里真实存在的可购买商品。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游", quantity: 1, addonIds: [] };

// ————————————————————————— 底层 —————————————————————————

async function send(pathname, { cookie, method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应（网关错误页等）留空
  }
  return { status: response.status, json };
}

async function loginAs(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

/** 走完整下单链路（下单 → 支付成功），返回订单 id。全程 HTTP，不碰预置订单。 */
async function placeOrder(cookie) {
  const pay = await send("/api/orders/pay", {
    cookie,
    method: "POST",
    body: {
      idempotencyKey: crypto.randomUUID(),
      ...PRODUCT,
      gameAccountId: "moyu_http",
      remark: "",
      companionId: null,
    },
  });
  assert.equal(pay.status, 200, `HTTP 下单必须成功：${JSON.stringify(pay.json)}`);
  const paymentRequestId = pay.json?.data?.id;
  assert.ok(paymentRequestId, "下单响应里必须有支付请求 id");

  const confirm = await send("/api/payments/mock-confirm", {
    cookie,
    method: "POST",
    body: { paymentRequestId, result: "success" },
  });
  assert.equal(
    confirm.status,
    200,
    `HTTP 支付确认必须成功（需要服务端开着 ENABLE_MOCK_PAYMENT）：${JSON.stringify(confirm.json)}`,
  );
  const orderId = confirm.json?.data?.orderId;
  assert.ok(orderId, "支付成功后必须拿到 orderId");
  return orderId;
}

/** 把刚下单的订单交给指定的那位打手（公共池先到先得；此处只有它自己在抢）。 */
async function acceptAs(companionCookie, orderId) {
  const pool = await send("/api/companion/dispatches", { cookie: companionCookie });
  assert.equal(pool.status, 200, "打手必须能读订单池");
  const item = [...(pool.json?.data?.exclusive ?? []), ...(pool.json?.data?.public ?? [])].find(
    (each) => each.orderId === orderId,
  );
  assert.ok(item, `刚下单的 ${orderId} 必须出现在池子里，否则这一组空转`);
  assert.ok(item.dispatchId, "池子行里必须有派单 id");

  const accept = await send(`/api/companion/dispatches/${item.dispatchId}/accept`, {
    cookie: companionCookie,
    method: "POST",
  });
  assert.equal(accept.status, 200, `接单必须成功：${JSON.stringify(accept.json)}`);
  // 接单之后订单的归属是「服务端说的那一位」，不是「我们以为的那一位」——回读验证
  const detail = await send(`/api/companion/orders/${orderId}`, { cookie: companionCookie });
  assert.equal(detail.status, 200, "接单之后这位打手必须能读到这一单");
}

async function staffLogin() {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId: "staff-1" }),
  });
  if (response.status !== 200) return null;
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

// ————————————————————————— 会话（首次用到时才建） —————————————————————————

const SESSION_A = BASE ? await loginAs(USER_COMPANION_A) : null;
const SESSION_B = BASE ? await loginAs(USER_COMPANION_B) : null;
/**
 * 下单用户，同时也是「登录了但不是打手」那一格的样本。
 * 两件事用同一份 Cookie 是**故意的**：它们本来就是「一个普通用户」这一个身份的两面，
 * 分成两个账号反而会让人以为 403 那一格测的是某个特殊账号。
 */
const SESSION_ORDER = BASE ? await loginAs(USER_ORDER) : null;
const SESSION_STAFF = BASE ? await staffLogin() : null;

const MISSING_ORDER = "ord-does-not-exist";

const SKIP_SESSION =
  SKIP ||
  (SESSION_A && SESSION_B && SESSION_ORDER && SESSION_STAFF
    ? false
    : "服务端未开启 ENABLE_MOCK_AUTH（或未开启 Mock 支付），跳过需要登录态的用例");

/** 造一张「A 已接单」的订单：下单的是普通用户，接单的是 A——**两个人**。 */
async function sceneAcceptedByA() {
  const orderId = await placeOrder(SESSION_ORDER);
  await acceptAs(SESSION_A, orderId);
  return orderId;
}

/** 客服把这一单换给 B。 */
async function replaceWithB(orderId) {
  const replaced = await send(`/api/staff/orders/${orderId}/replace`, {
    cookie: SESSION_STAFF,
    method: "POST",
    body: { companionId: COMPANION_B },
  });
  assert.equal(replaced.status, 200, `换人必须成功：${JSON.stringify(replaced.json)}`);
}

// ————————————————————————— 一、守卫（25、26） —————————————————————————

test("HTTP 25：打手聊天四个路由未登录一律 401，且守卫在**读任何输入之前**", { skip: SKIP }, async () => {
  const endpoints = [
    { path: "/api/companion/conversations", method: "GET" },
    { path: `/api/companion/conversations/${MISSING_ORDER}`, method: "GET" },
    { path: `/api/companion/conversations/${MISSING_ORDER}/messages`, method: "POST" },
    { path: `/api/companion/conversations/${MISSING_ORDER}/read`, method: "POST" },
  ];

  for (const endpoint of endpoints) {
    const anon = await send(endpoint.path, {
      method: endpoint.method,
      ...(endpoint.method === "POST"
        ? { body: { body: "hi", idempotencyKey: crypto.randomUUID() } }
        : {}),
    });
    assert.equal(anon.status, 401, `（${endpoint.method} ${endpoint.path}）匿名必须 401`);
    assert.equal(anon.json?.error?.code, "UNAUTHORIZED");
  }

  // 伪造 / 指向不存在的用户：会话查不到 → 与未登录同一句话
  for (const forged of [
    "mock_user_id=u-does-not-exist",
    "mock_user_id=",
    "mock_admin_id=admin-1",
    "mock_staff_id=staff-1",
  ]) {
    const response = await send("/api/companion/conversations", { cookie: forged });
    assert.equal(response.status, 401, `（${forged}）应当 401`);
    assert.equal(response.json?.error?.code, "UNAUTHORIZED");
  }
});

test("HTTP 26：登录了但不是打手 → 403；别人的订单 → 404，且两种 404 同形", { skip: SKIP_SESSION }, async () => {
  const notCompanion = await send("/api/companion/conversations", { cookie: SESSION_ORDER });
  assert.equal(notCompanion.status, 403, "登录了但名下没有有效护航资料");
  assert.equal(notCompanion.json?.error?.code, "FORBIDDEN");

  const orderId = await sceneAcceptedByA();

  // A 接下的单，B 来读：404 必须与「订单不存在」**完全同形**，
  // 否则响应体本身就是一条存在性预言机（`api-contract.md` §2.9）
  const someoneElse = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_B });
  const missing = await send(`/api/companion/conversations/${MISSING_ORDER}`, { cookie: SESSION_B });
  assert.equal(someoneElse.status, 404, "别人接的单必须 404");
  assert.equal(missing.status, 404, "不存在的订单必须 404");
  assert.equal(
    someoneElse.json?.error?.message,
    missing.json?.error?.message,
    "两种「查不到」必须同一句话",
  );

  // 写路径同形
  const write = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_B,
    method: "POST",
    body: { body: "我不该能说话", idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(write.status, 404);
  assert.equal(write.json?.error?.message, missing.json?.error?.message);

  // 已读路径同形；且一个「空白订单号」不得退化成「查到全部」
  const read = await send(`/api/companion/conversations/${orderId}/read`, {
    cookie: SESSION_B,
    method: "POST",
  });
  assert.equal(read.status, 404);
  const blank = await send("/api/companion/conversations/%20", { cookie: SESSION_A });
  assert.equal(blank.status, 404, "空白订单号必须 404，不得被当成「查全部」");
});

// ————————————————————————— 二、正常路径（27、28） —————————————————————————

test("HTTP 27 / 28：GET happy path（读即建段）与 POST happy path（发送者身份由服务端写）", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();

  const before = await send("/api/companion/conversations", { cookie: SESSION_A });
  assert.equal(before.status, 200);
  const row = before.json?.data?.items?.find((item) => item.orderId === orderId);
  assert.ok(row, "刚接的单必须出现在打手端聊天列表里——行来自订单，不是来自「已经聊过的会话」");
  assert.equal(row.messageCount, 0);
  assert.equal(row.unreadCount, 0);
  assert.equal(row.lastMessageBody, null);
  assert.ok(before.json.data.notice, "列表必须带一段「你只能看到本次护航」的说明");

  // 打开聊天页：读取路径会顺手建立这一段会话（幂等）
  const detail = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json?.data?.messages, []);
  assert.ok(detail.json.data.notice);

  // 发送者身份：请求体里塞满伪造字段，服务端一个都不读
  const sent = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: {
      body: "我上线了",
      idempotencyKey: crypto.randomUUID(),
      senderId: COMPANION_B,
      senderRole: "customer_service",
      senderName: "冒充客服",
      userId: "u-0000",
    },
  });
  assert.equal(sent.status, 200, `发送必须成功：${JSON.stringify(sent.json)}`);
  assert.ok(sent.json?.data?.messageId);

  const after = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.deepEqual(
    after.json.data.messages.map((message) => [message.body, message.senderRole, message.senderLabel]),
    [["我上线了", "companion", "我"]],
    "伪造的 senderRole / senderName 一律无效：角色由服务端写成 companion，称呼按 senderId 判成「我」",
  );

  // 已读：打手读完，列表未读归零
  const read = await send(`/api/companion/conversations/${orderId}/read`, {
    cookie: SESSION_A,
    method: "POST",
  });
  assert.equal(read.status, 200);
  const listed = await send("/api/companion/conversations", { cookie: SESSION_A });
  assert.equal(listed.json.data.items.find((item) => item.orderId === orderId).unreadCount, 0);
});

test("HTTP：缺幂等键 / 空内容都是 400；同一个键重放只产生一条消息", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();

  const noKey = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "没有幂等键" },
  });
  assert.equal(noKey.status, 400);

  const blank = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "   ", idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(blank.status, 400, "只有空格不算消息");

  const key = crypto.randomUUID();
  const first = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "连点一次", idempotencyKey: key },
  });
  const replay = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "连点一次", idempotencyKey: key },
  });
  assert.equal(first.json?.data?.messageId, replay.json?.data?.messageId);
  assert.equal(replay.json?.data?.created, false, "重放必须明确告知「没有新建」");

  const detail = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(detail.json.data.messages.length, 1, "连点两次只有一条消息");
});

// ————————————————————————— 三、换人后的隔离（29、30） —————————————————————————

test("HTTP 29：换人之后旧打手的四个路由**全部** 404，新打手只看得到自己的那一段", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();

  // A 先在自己的这一段里留一句话
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "这是 A 说的话", idempotencyKey: crypto.randomUUID() },
  });

  await replaceWithB(orderId);

  // —— 旧打手：读 / 写 / 已读 / 列表，四条路径一起断 ——
  const oldDetail = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(oldDetail.status, 404, "被换下之后读不到");
  const oldWrite = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "我不该还能说话", idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(oldWrite.status, 404);
  const oldRead = await send(`/api/companion/conversations/${orderId}/read`, {
    cookie: SESSION_A,
    method: "POST",
  });
  assert.equal(oldRead.status, 404, "已读也是「碰这一段」的一种，同样要断");
  const oldList = await send("/api/companion/conversations", { cookie: SESSION_A });
  assert.equal(
    oldList.json.data.items.some((item) => item.orderId === orderId),
    false,
    "这一单必须同时从他的聊天列表里消失——不能出现「列表里没了、详情还进得去」",
  );

  // —— 新打手：拿到的是**新的一段**，看不到 A 的话 ——
  const newDetail = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_B });
  assert.equal(newDetail.status, 200, "接手的那位必须能进");
  assert.deepEqual(newDetail.json.data.messages, [], "他看不到旧打手那一段的任何消息");
});

test("HTTP 30：新打手在列表里只看到自己的段——旧段的消息数与未读都不算到他头上", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "A 说的话，B 不该看到", idempotencyKey: crypto.randomUUID() },
  });
  // 用户也往 A 那一段里说一句：B 接手后这条**既不该算进未读、也不该算进消息数**
  await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "用户对 A 说的话", idempotencyKey: crypto.randomUUID(), target: "current" },
  });

  await replaceWithB(orderId);

  const listB = await send("/api/companion/conversations", { cookie: SESSION_B });
  const rowB = listB.json.data.items.find((item) => item.orderId === orderId);
  assert.ok(rowB, "B 接手的单必须出现在他的列表里");
  assert.equal(rowB.messageCount, 0, "旧段的消息条数不得算进 B 的消息数");
  assert.equal(rowB.unreadCount, 0, "旧段的未读不得算到 B 头上");
  assert.equal(rowB.lastMessageBody, null, "B 的列表上不该显示旧段的最后一条");

  // 用户往**当前段**（B 的段）里说一句，这时才该出现未读
  await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "用户对 B 说的话", idempotencyKey: crypto.randomUUID(), target: "current" },
  });
  const afterUser = await send("/api/companion/conversations", { cookie: SESSION_B });
  const rowB2 = afterUser.json.data.items.find((item) => item.orderId === orderId);
  assert.equal(rowB2.messageCount, 1, "这才只算他自己的那一段");
  assert.equal(rowB2.unreadCount, 1);
  assert.equal(rowB2.lastMessageBody, "用户对 B 说的话");
});

// ————————————————————————— 四、用户端与客服端（31、32） —————————————————————————

test("HTTP 31：用户端返回**完整历史**（含已失效段落），但不泄露内部履约键", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "A 的那一段", idempotencyKey: crypto.randomUUID() },
  });
  await replaceWithB(orderId);

  const user = await send(`/api/orders/${orderId}/messages`, { cookie: SESSION_ORDER });
  assert.equal(user.status, 200);
  const data = user.json?.data;

  assert.deepEqual(
    data.segments.map((segment) => [segment.kind, segment.isCurrent, segment.isReadOnly]),
    [
      ["service", false, false],
      ["assignment", false, true],
      ["assignment", true, false],
    ],
    "用户看得到历史段，但它必须是只读的；客服段永远可写",
  );
  assert.deepEqual(
    data.segments.flatMap((segment) => segment.messages.map((message) => message.body)),
    ["A 的那一段"],
    "历史段的消息一条不丢",
  );

  // 内部键一律不得出现：整个响应体里连一次履约键的形状都不该有
  const raw = JSON.stringify(user.json);
  assert.equal(raw.includes(`${orderId}#s`), false, "响应体里不得出现 `${orderId}#s${seq}` 这种内部键");
  assert.equal(raw.includes("conversationId"), false);
  assert.equal(raw.includes("assignmentKey"), false);
  assert.equal(raw.includes("companionId"), false, "用户端不得看到打手 id");
  assert.equal(raw.includes("companionLastReadAt"), false, "用户端不得看到打手的已读游标");

  // 分段 DTO 的键集合是精确的
  assert.deepEqual(
    Object.keys(data.segments[0]).sort(),
    ["index", "isCurrent", "isReadOnly", "kind", "messages", "title"],
  );
  assert.deepEqual(
    Object.keys(data.messages[0]).sort(),
    ["body", "createdAt", "id", "orderId", "senderAvatarUrl", "senderId", "senderName", "senderRole", "userId"],
  );

  // 用户仍能对**当前**段发消息，而历史段在结构上就写不进去
  const toCurrent = await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "只发给当前打手", idempotencyKey: crypto.randomUUID(), target: "current" },
  });
  assert.equal(toCurrent.status, 200);
  for (const target of ["assignment", `${orderId}#s0`, "companion"]) {
    const bad = await send(`/api/orders/${orderId}/messages`, {
      cookie: SESSION_ORDER,
      method: "POST",
      body: { body: "试图写进历史段", idempotencyKey: crypto.randomUUID(), target },
    });
    assert.equal(bad.status, 400, `target=${target} 必须被拒绝，而不是回退默认值`);
  }

  const after = await send(`/api/orders/${orderId}/messages`, { cookie: SESSION_ORDER });
  assert.deepEqual(
    after.json.data.segments[1].messages.map((message) => message.body),
    ["A 的那一段"],
    "被拒绝的请求一条都没写进去",
  );
});

test("HTTP 32：客服端返回调查所需的全部分段与退出历史，且不泄露无关隐私", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();
  // 用户先找过客服（默认落点就是客服会话），再与 A 私聊，最后被换成 B：
  // 这才是售后调查真正会遇到的形状——三段并存
  await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "用户找客服问过一句", idempotencyKey: crypto.randomUUID() },
  });
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "A 的那一段", idempotencyKey: crypto.randomUUID() },
  });
  await replaceWithB(orderId);

  // 换人之后、新打手还没开口之前：客服看得到**历史**，但看不到还不存在的一段。
  // 这正是「会话惰性创建」在客服视野里的样子（`02-decisions.md` D3 / R3）——
  // 一段从未有人打开过的会话不是「丢了」，而是**还没有发生**。
  const beforeNewSegment = await send(`/api/staff/conversations/${orderId}`, {
    cookie: SESSION_STAFF,
  });
  assert.equal(beforeNewSegment.status, 200);
  assert.deepEqual(
    beforeNewSegment.json?.data?.segments.map((segment) => [segment.kind, segment.isCurrent, segment.companionId]),
    [
      ["service", false, null],
      ["assignment", false, COMPANION_A],
    ],
    "⚠️ 被换下的那一段**必须还在**（cmd §八：不因换人丢失旧聊天）——这是售后调查最常问的那一格",
  );

  // B 打开一次自己的聊天（新的一段由此建立），再看客服视野
  await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_B });

  const detail = await send(`/api/staff/conversations/${orderId}`, { cookie: SESSION_STAFF });
  assert.equal(detail.status, 200);
  const data = detail.json?.data;

  assert.deepEqual(
    data.segments.map((segment) => [segment.kind, segment.isCurrent, segment.companionId]),
    [
      ["service", false, null],
      ["assignment", false, COMPANION_A],
      ["assignment", true, COMPANION_B],
    ],
    "客服要看得到「这一单换过谁」——这正是售后调查要的东西",
  );
  assert.deepEqual(
    data.segments.flatMap((segment) => segment.messages.map((message) => message.body)),
    ["用户找客服问过一句", "A 的那一段"],
    "三段的消息一条不丢，客服才查得清「谁在什么时候说了什么」",
  );
  assert.ok(data.segments[1].companionName, "历史段的护航名必须显示得出来（他被换下之后仍然查得到资料）");
  assert.equal(data.segments[0].companionName, null, "客服会话不属于任何一位护航");
  assert.equal(data.segments[2].messages.length, 0, "B 还没说话，他这一段是空的——空段落照样出现");
  assert.equal(data.order.releaseHistory.length, 1, "退出历史与历史段一一对应");
  assert.ok(data.messageTargetNotice, "客服必须被告知「你的回复只进客服沟通那一段」");

  // 调查所需之外的东西一律不在
  const raw = JSON.stringify(detail.json);
  assert.equal(raw.includes(`${orderId}#s`), false, "内部履约键对客服也没有信息量");
  assert.equal(raw.includes("assignmentKey"), false);
  assert.equal(raw.includes("conversationId"), false);
  assert.equal(raw.includes("gameAccountId"), false, "游戏 ID 不在客服当前需要的字段里");
  assert.equal(raw.includes("remark"), false, "备注同理");

  // 客服回复落进客服会话，不进任何一段履约会话
  const sent = await send(`/api/staff/conversations/${orderId}/messages`, {
    cookie: SESSION_STAFF,
    method: "POST",
    body: { body: "客服在跟进", idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(sent.status, 200);

  const after = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_B });
  assert.deepEqual(after.json.data.messages, [], "客服的话绝不能插进用户与打手的私聊");
});

// ————————————————————————— 五、全额退款后的只读（裁定 `TBD-P0-14-1`） —————————————————————————

/** 把这一单当场全额直退（`accepted` / `paid` 这一档走的就是这条路，请求体是空的）。 */
async function directRefund(orderId) {
  const refunded = await send(`/api/orders/${orderId}/direct-refund`, {
    cookie: SESSION_ORDER,
    method: "POST",
  });
  assert.equal(refunded.status, 200, `直退必须成功：${JSON.stringify(refunded.json)}`);
}

test("HTTP 只读：全额退款之后打手**读得到、发不出**——404 与 400 是两种不同的拒绝", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "退款之前说的一句", idempotencyKey: crypto.randomUUID() },
  });
  await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "用户退款之前说的一句", idempotencyKey: crypto.randomUUID(), target: "current" },
  });

  // 对照面：退款之前既读得到也发得出去
  const before = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(before.status, 200);
  assert.equal(before.json.data.isReadOnly, false);
  assert.equal(before.json.data.notice, COMPANION_CHAT_HISTORY_NOTICE);

  await directRefund(orderId);

  // —— 读：照旧。这正是裁定要保留的那一半 ——
  const after = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(after.status, 200, "退款后打手**仍然进得去**——记录要「保留可查」");
  assert.equal(after.json.data.isReadOnly, true);
  assert.equal(after.json.data.notice, COMPANION_CHAT_REFUNDED_NOTICE, "说明要换成「已退款」这一句");
  assert.notEqual(after.json.data.notice, COMPANION_CHAT_HISTORY_NOTICE);
  assert.deepEqual(
    after.json.data.messages.map((message) => message.body),
    ["退款之前说的一句", "用户退款之前说的一句"],
    "历史一条不少（两段视角合起来看：他自己那句与用户那句）",
  );

  // —— 写：400，而不是 404 ——
  // ⚠️ 这一格是**本组与 HTTP 29 的分水岭**：被换下是 404（这段聊天不再属于你），
  //    已退款是 400（属于你、但已经不能写）。若这里返回 404，
  //    客户端会把「这一单退掉了」当成「这段聊天不见了」，历史也跟着被藏掉。
  const refused = await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "退款之后还想说", idempotencyKey: crypto.randomUUID() },
  });
  assert.equal(refused.status, 400, "已退款是 400，不是 404");
  assert.equal(refused.json?.error?.message, COMPANION_ORDER_REFUNDED_MESSAGE);
  assert.notEqual(refused.status, 404, "404 会让人以为这段聊天不见了");

  // 被拒之后一条都没写进去
  const still = await send(`/api/companion/conversations/${orderId}`, { cookie: SESSION_A });
  assert.equal(still.json.data.messages.length, 2, "被拒的请求不得留下任何一条");

  // —— 已读仍然可以标：它是读侧动作，退款不该让它失效 ——
  const read = await send(`/api/companion/conversations/${orderId}/read`, {
    cookie: SESSION_A,
    method: "POST",
  });
  assert.equal(read.status, 200, "已读是「读过了」的记账，退款不改变这件事");

  // —— 列表：这一行**必须还在**（藏掉入口等于让记录查不到），且标着只读 ——
  const list = await send("/api/companion/conversations", { cookie: SESSION_A });
  const row = list.json.data.items.find((item) => item.orderId === orderId);
  assert.ok(row, "退款后这一单仍留在打手的聊天列表里");
  assert.equal(row.isReadOnly, true, "列表与详情必须给出同一个答案");
  assert.equal(row.lastMessageBody, "用户退款之前说的一句", "最后一条消息仍然显示得出来");
});

test("HTTP 只读：用户仍看得到完整历史，但对打手发不出；客服会话与客服调查都不受影响", { skip: SKIP_SESSION }, async () => {
  const orderId = await sceneAcceptedByA();
  await send(`/api/companion/conversations/${orderId}/messages`, {
    cookie: SESSION_A,
    method: "POST",
    body: { body: "打手在退款前说的话", idempotencyKey: crypto.randomUUID() },
  });
  await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "用户也给客服说一句", idempotencyKey: crypto.randomUUID() },
  });

  await directRefund(orderId);

  // —— 用户：读得到完整历史 ——
  const view = await send(`/api/orders/${orderId}/messages`, { cookie: SESSION_ORDER });
  assert.equal(view.status, 200);
  const assignment = view.json.data.segments.find((segment) => segment.kind === "assignment");
  assert.ok(assignment, "履约会话必须还在");
  assert.equal(assignment.isCurrent, true, "退款**不**把这一段变成历史段：人没被换掉");
  assert.equal(
    assignment.isReadOnly,
    true,
    "这一格就是 P0-14 交付时不存在的组合：isCurrent 与 isReadOnly 同时为真",
  );
  assert.deepEqual(
    assignment.messages.map((message) => message.body),
    ["打手在退款前说的话"],
    "历史一条不少",
  );

  // 内部键仍然一个都没有——退款不该成为泄露判据的借口
  const raw = JSON.stringify(view.json);
  assert.equal(raw.includes(`${orderId}#s`), false);
  assert.equal(raw.includes("conversationId"), false);

  // —— 用户：对打手发不出（400），对客服照常（200）——
  const toCompanion = await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "退款之后还想发给打手", idempotencyKey: crypto.randomUUID(), target: "current" },
  });
  assert.equal(toCompanion.status, 400, "对已退款订单的履约段发消息必须被拒");
  assert.equal(toCompanion.json?.error?.message, MESSAGE_ORDER_REFUNDED_MESSAGE);

  const toService = await send(`/api/orders/${orderId}/messages`, {
    cookie: SESSION_ORDER,
    method: "POST",
    body: { body: "退款之后要找客服问清楚", idempotencyKey: crypto.randomUUID(), target: "service" },
  });
  assert.equal(toService.status, 200, "退款冻的是履约段——退款之后恰恰最需要问客服");

  // 落点也要对：这一句必须进客服会话，不能因为退款被改道或丢弃
  const service = (await send(`/api/orders/${orderId}/messages`, { cookie: SESSION_ORDER })).json.data
    .segments.find((segment) => segment.kind === "service");
  assert.equal(service.isReadOnly, false, "客服段永远可写");
  assert.deepEqual(
    service.messages.map((message) => message.body),
    ["用户也给客服说一句", "退款之后要找客服问清楚"],
  );

  // —— 客服调查：段与消息一条不少 ——
  const staff = await send(`/api/staff/conversations/${orderId}`, { cookie: SESSION_STAFF });
  assert.equal(staff.status, 200, "退款不得让客服查不到这一单");
  assert.deepEqual(
    staff.json.data.segments.map((segment) => [segment.kind, segment.messages.length]),
    [
      ["service", 2],
      ["assignment", 1],
    ],
    "段一个不少、消息一条不少；客服端分段里**没有** isReadOnly（他对履约会话本来就不能写）",
  );
  for (const segment of staff.json.data.segments) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(segment, "isReadOnly"),
      false,
      "客服端不该因为退款多出一个 isReadOnly",
    );
  }
});
