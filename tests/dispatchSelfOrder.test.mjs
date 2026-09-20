import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  DISPATCH_ACCEPT_FAILURE_LABELS,
  DISPATCH_NOTIFICATION_ACCEPTED,
  DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT,
  EXCLUSIVE_WAIT_MINUTES,
  plusMinutes,
} from "../lib/constants/dispatch.ts";
import { sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { approveAdminApplication } from "../lib/services/adminCompanionApplications.ts";
import { setAdminCompanionFlags } from "../lib/services/adminCompanions.ts";
import {
  acceptDispatchForCompanion,
  listCompanionPools,
} from "../lib/services/companionDispatch.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";

/**
 * EX-DISPATCH-08「禁止自接单」——**一个人不能接自己下的单**。
 *
 * ## 这条规则为什么只能在服务端
 *
 * 公共池 DTO **刻意不含 `userId`**（BF-16「接单前只给接单决策所需最小信息」、
 * 权限表 §10 数据最小化）：打手在池子里本来就分不出哪张单是自己的。
 * 「前端不显示那个按钮」在这里连一个可用的判据都没有——能拦住它的地方只有
 * `acceptDispatch` 的原子区段那一次比对。
 *
 * ## 它不属于「专属资格」那一条
 *
 * 专属池的「只有指定的人能接」只在 `state === "exclusive"` 时成立，而自己接自己的单
 * 在公共池里同样要拦。两条判定合在一起写的话，公共池会漏、转池之后会漏。
 * 因此这里两个池子各跑一遍。
 *
 * ## 产品负责人给定的六步验收顺序
 *
 * 1. 用户 U 下单；2. U 同时持有有效的护航身份；3. U 去接自己这一单；4. 服务端拒绝；
 * 5. 派单 / 订单 / 通知三处都**没有成功副作用**；6. 另一位合法护航仍然接得到这张单。
 *
 * 第四节另守**另一层**：这一单根本不进他自己的池子（见那一节的说明——
 * 池子过滤是诚实性，accept Guard 才是保护，两组用例谁也不替谁背书）。
 *
 * U 与他的护航身份都**走真实服务**构造，不手写存储记录：通过预置申请 `ca-1002`
 * 会产生一条 `userId` 就是申请人的护航资料（与 `tests/companionAvailability.test.mjs`
 * 是同一条路径）。下单用的用户就是那条资料的 `userId`，不写死字面量。
 *
 * ## 为什么单独一个文件
 *
 * 这六步要 `payment` + `dispatch` + `companion` + `notification` 四份存储同时装配，
 * 追加进 `tests/dispatch.test.mjs` 会改变那个文件每个既有用例的重建假设。
 *
 * ## 用例之间怎么隔离
 *
 * 预置申请里只有 `ca-1002` / `ca-1003` 两条可以被通过，因此这里**只通过一次**
 * （结果被记住，见 `selfActor()`）。也正因为如此，`beforeEach` **不清**
 * `companion` / `companionApplication` / `qualification` / `adminAudit` 这四份存储：
 * 被通过的申请与它产生的护航资料要跨用例复用，清掉它们会让记住的 id 指向一条
 * 不存在的记录。清掉的是本文件**每次都会往里写新记录**的那几份。
 *
 * 时间一次都不等：所有判定用的 `at` 都由订单的 `paidAt` 推算后显式传入。
 */

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的一位：`enabled: true` / `available: true` / `userId: null` / 未移除。 */
const OTHER_COMPANION = "cp-1";

let seq = 0;
function unique(tag) {
  seq += 1;
  return `${tag}-p05self-${process.pid}-${seq}`;
}

beforeEach(() => {
  // 本文件每次都会新写订单、派单、通知，这三份从预置数据重新建仓。
  // ⚠️ 护航那一族存储（companion / companionApplication / qualification / adminAudit）
  // **不能清**：被通过的那条申请与它产生的护航资料是整个文件共用的，
  // 而预置申请通过第二次会撞上 `invalid-transition`——清掉就再也建不回来。
  // 那几份存储在本文件里只在 `selfActor()` 里写一次，之后全是只读。
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("notification");
  // 公共池超时时长决定转池之后还剩多久可以接。本文件不读具体数值，
  // 但把它恢复成预置值，免得将来某条用例改了参数而影响这里
  resetMockStore("platformConfig");
});

/** 结算选择。默认不指定护航（直接进公共池）。 */
function selection(overrides = {}) {
  return {
    ...PRODUCT,
    quantity: 1,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
    ...overrides,
  };
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
async function placeOrder(user, overrides = {}) {
  const created = await createPaymentRequest(
    { ...selection(overrides), idempotencyKey: unique("key") },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
  return confirmed.order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function companionRecord(companionId) {
  const record = await getCompanionRepository().findCompanionById(companionId);
  assert.ok(record, `护航 ${companionId} 必须存在`);
  return record;
}

/**
 * **这一张单**产生的通知。
 *
 * ⚠️ 通知记录里**没有 `orderId` 字段**（`lib/types/notification.ts` 刻意只有 `href`），
 * 因此「这一单的通知」只能用 `href` 认——那正是设计里唯一的订单引用，
 * 而且它只带 id，不带任何说明。
 */
async function notificationsForOrder(userId, orderId) {
  const mine = await getNotificationRepository().listNotifications(userId);
  return mine.filter((item) => item.href === `/orders/${orderId}`);
}

/** 后台的「恢复接单」，走真实服务（原因处理、幂等键、审计都是真的）。 */
async function resume(companionId) {
  const result = await setAdminCompanionFlags(companionId, "resume", unique("adm"), {
    idempotencyKey: unique("key"),
  });
  assert.equal(result.enabled, true, "恢复接单不得影响工作资格");
  assert.equal(result.available, true);
  return result;
}

/**
 * U —— 同时是「下单的用户」与「有护航身份的人」。
 *
 * 走真实的审核服务通过预置申请 `ca-1002`：产生的那条护航资料 `userId` 就是申请人。
 * ⚠️ 预置申请只有两条能通过，重复通过会撞 `invalid-transition`，
 * 因此结果被记住，整个文件只通过一次。
 */
let selfOnce = null;
async function selfActor() {
  if (!selfOnce) {
    const result = await approveAdminApplication("ca-1002", unique("adm"), {
      idempotencyKey: unique("key"),
    });
    assert.equal(result.status, "approved", "ca-1002 应当可以被通过");
    assert.ok(result.companionId, "通过入驻申请必须产生护航资料");

    const record = await companionRecord(result.companionId);
    assert.ok(record.userId, "审核通过产生的护航必须关联到一个用户");
    selfOnce = { companionId: result.companionId, userId: record.userId };
  }
  return selfOnce;
}

/* ───────────────── 一、公共池与专属池：这条规则两个池子都要成立 ───────────────── */

test("自接单 1：公共池——自己下的单自己接不了，且派单/订单/通知三处一个字节都没写", async () => {
  const { companionId, userId } = await selfActor();
  // 新审核通过的护航是 `available: false`（可接单安排还没人确认过），先恢复接单
  await resume(companionId);

  const order = await placeOrder(userId);
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public", "没指定护航就直接进公共池");

  // —— 拒绝的理由**不能**是「你当前不能接单」——
  // 把这两个标志写在尝试之前：这位护航此刻 enabled / available 都是 true，
  // 因此 `companion-unavailable` 那条分支不可能是这次拒绝的解释
  const before = await companionRecord(companionId);
  assert.equal(before.enabled, true, "资格在架");
  assert.equal(before.available, true, "没有暂停接单——拒绝不是「你接不了单」，而是「这单是你的」");

  const at = plusMinutes(order.paidAt, 1);
  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(
    outcome.kind,
    "self-order",
    "自己下的单必须被拒：公共池里没有任何客户端判据能认出这是自己的单，只有服务端这次比对能拦",
  );

  // —— 第 5 步：没有任何成功副作用 ——
  const after = await dispatchOf(order.id);
  assert.equal(after.state, "public", "派单还在公共池里等别人，没被这一下改动");
  assert.equal(after.acceptedByCompanionId, null);
  assert.equal(after.acceptedAt, null);

  const orderAfter = await orderOf(order.id);
  assert.equal(orderAfter.status, "paid", "订单状态没有前进");
  assert.equal(orderAfter.actualCompanionId, null, "订单不得写上实际打手");
  assert.equal(orderAfter.companion, null, "接单快照同理不得被一次失败的接单写上");

  assert.deepEqual(
    await notificationsForOrder(userId, order.id),
    [],
    "被拒绝的接单不得给用户发出「订单已被接单」——通知一条都不许多",
  );
});

test("自接单 2：专属池——用户把自己指定成护航时，专属资格会放行，拦下它的是「禁止自接单」", async () => {
  const { companionId, userId } = await selfActor();
  // 结算页只让选 enabled && available 的护航（checkout 的 resolveCompanion），
  // 因此这份「异常数据」要在下单**之前**恢复接单，否则这一单根本下不出来
  await resume(companionId);

  const order = await placeOrder(userId, { companionId });
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "exclusive");
  assert.equal(
    dispatch.exclusiveCompanionId,
    companionId,
    "异常数据：用户把自己指定成了这一单的专属护航",
  );
  assert.equal(
    dispatch.exclusiveDeadlineAt,
    plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES),
    "专属窗口固定 10 分钟",
  );

  const at = plusMinutes(order.paidAt, 1);
  assert.ok(
    Date.parse(at) < Date.parse(dispatch.exclusiveDeadlineAt),
    "这一次尝试落在专属窗口内，还没到点",
  );

  // ⚠️ 这一条是本次的核心对照：专属资格那一步**会放行**
  //（`state === "exclusive"` 且 `exclusiveCompanionId` 就是我，所以不是 `not-eligible`），
  // 因此拒绝只可能来自「禁止自接单」。两条规则混在一起写的话，异常数据就能从专属池进来
  const before = await companionRecord(companionId);
  assert.equal(before.enabled, true, "资格在架");
  assert.equal(before.available, true, "没有暂停接单——拒绝不是「你接不了单」");

  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(
    outcome.kind,
    "self-order",
    "拦下它的是「这一单是你自己下的」，不是「你不在专属范围内」，也不是「你接不了单」",
  );

  const after = await dispatchOf(order.id);
  assert.equal(after.state, "exclusive", "专属池照旧在等人");
  assert.equal(after.acceptedByCompanionId, null);
  assert.equal(after.acceptedAt, null);
  assert.equal(after.exclusiveCompanionId, companionId, "被拒不得改写「用户当初指定的是谁」");

  const orderAfter = await orderOf(order.id);
  assert.equal(orderAfter.status, "paid");
  assert.equal(orderAfter.actualCompanionId, null);

  assert.deepEqual(
    await notificationsForOrder(userId, order.id),
    [],
    "被拒绝的接单不得发出通知",
  );
});

test("自接单 3：专属池到点转公共池之后重试，还是接不了——重试不是一条进来的路", async () => {
  const { companionId, userId } = await selfActor();
  await resume(companionId);

  const order = await placeOrder(userId, { companionId });
  const dispatch = await dispatchOf(order.id);
  const deadline = dispatch.exclusiveDeadlineAt;

  // 到点（清扫还没跑）时先试一次：此时「同一个人」这条判定还轮不到，
  // 但结果同样是接不到——到点就是到点
  const late = await acceptDispatchForCompanion(companionId, dispatch.id, deadline);
  assert.notEqual(late.kind, "ok", "专属窗口一关，这个人就再也接不到这一单");

  // 把已经到点的事实写成记录：这一单进公共池
  sweepExpiredDispatches(deadline);
  const moved = await dispatchOf(order.id);
  assert.equal(moved.state, "public");
  assert.deepEqual(
    (await notificationsForOrder(userId, order.id)).map((item) => item.title),
    [DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT.title],
    "转公共池只发这一条通知",
  );

  // ⚠️ 公共池里「指定给谁」这回事已经不存在了：此时能拦住他的**只剩**
  // 「禁止自接单」这一条（时限没到、订单还在 paid、他本人可接单）。
  // 如果这条判定只写在专属池那一步，这里会返回 ok——「等到它转公共池再点一次」
  // 就成了绕开规则的后门
  const retry = await acceptDispatchForCompanion(
    companionId,
    moved.id,
    plusMinutes(deadline, 1),
  );
  assert.equal(
    retry.kind,
    "self-order",
    "换到公共池重试仍然是「你自己下的单」——池子会变，下单人不会变",
  );

  const after = await dispatchOf(order.id);
  assert.equal(after.state, "public", "这一单还留在公共池里，没被这一下拿走");
  assert.equal(after.acceptedByCompanionId, null);
  assert.equal(after.acceptedAt, null);
  assert.equal((await orderOf(order.id)).actualCompanionId, null);
  assert.deepEqual(
    (await notificationsForOrder(userId, order.id)).map((item) => item.title),
    [DISPATCH_NOTIFICATION_EXCLUSIVE_TIMEOUT.title],
    "这一次重试不得发出「订单已被接单」——重试不是一条进来的路",
  );
});

/* ───────────────── 二、第 6 步：拒绝不能把这一单锁死，也不能误伤别人 ───────────────── */

test("自接单 4：被拒之后，另一位合法护航仍然接得到同一张单（第 6 步）", async () => {
  const { companionId, userId } = await selfActor();
  await resume(companionId);

  const order = await placeOrder(userId);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  assert.equal(
    (await acceptDispatchForCompanion(companionId, dispatch.id, at)).kind,
    "self-order",
    "先被自己人拒一次",
  );

  // 拒绝只是「你不能接」，不是「这一单作废」：换一位护航，它照常接得走
  const outcome = await acceptDispatchForCompanion(OTHER_COMPANION, dispatch.id, at);
  assert.equal(outcome.kind, "ok", "被自己人拒过之后，这一单必须仍然能被别人接走");
  assert.equal(outcome.orderId, order.id);
  assert.equal(outcome.replayed, false);

  const accepted = await dispatchOf(order.id);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acceptedByCompanionId, OTHER_COMPANION, "接下它的是后来这位");

  const orderAfter = await orderOf(order.id);
  assert.equal(orderAfter.status, "accepted");
  assert.equal(orderAfter.actualCompanionId, OTHER_COMPANION);
  assert.equal(orderAfter.companion?.id, OTHER_COMPANION, "接单快照写的是真正的接单人");

  const notifications = await notificationsForOrder(userId, order.id);
  assert.equal(notifications.length, 1, "一次接单只发一条通知");
  assert.equal(notifications[0].title, DISPATCH_NOTIFICATION_ACCEPTED.title);
  assert.equal(notifications[0].href, `/orders/${order.id}`, "通知只带订单 id，不带任何说明");
  assert.equal(notifications[0].readAt, null);
});

test("自接单 5：userId 为 null 的护航不是任何人的「自己」——这条规则不产生凭空造出来的拒绝", async () => {
  const other = await companionRecord(OTHER_COMPANION);
  assert.equal(other.userId, null, "预置护航是平台早期数据，没有关联用户");
  assert.equal(other.enabled, true);
  assert.equal(other.available, true);

  const user = unique("u");
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);

  const outcome = await acceptDispatchForCompanion(
    OTHER_COMPANION,
    dispatch.id,
    plusMinutes(order.paidAt, 1),
  );
  assert.equal(
    outcome.kind,
    "ok",
    "没有关联用户的护航必须照常接单：判定要在护航有 userId 时才比，直接比两个值会让「没有关联用户的护航」与「没有下单人的订单」被判成同一个人（null === null），那是一条凭空造出来的拒绝",
  );
  assert.equal(
    (await orderOf(order.id)).actualCompanionId,
    OTHER_COMPANION,
    "接单事实照常写下去",
  );
  assert.equal((await dispatchOf(order.id)).state, "accepted");
});

test("自接单 6：同一个护航接别人的单照常成功——它比的是「同一个人」，不是「有没有关联用户」", async () => {
  const { companionId } = await selfActor();
  await resume(companionId);

  // 下单的**不是**这位护航本人
  const otherUser = unique("u");
  const order = await placeOrder(otherUser);
  const dispatch = await dispatchOf(order.id);

  const outcome = await acceptDispatchForCompanion(
    companionId,
    dispatch.id,
    plusMinutes(order.paidAt, 1),
  );
  assert.equal(
    outcome.kind,
    "ok",
    "有护航身份的人不是「一律接不了自己名下的单」：被拒的唯一理由是两条记录的 userId 相等",
  );

  const orderAfter = await orderOf(order.id);
  assert.equal(orderAfter.userId, otherUser, "这一单的下单人确实是别人");
  assert.equal(orderAfter.actualCompanionId, companionId);
});

test("自接单 7：下单人缺失（异常数据）时，两个 null 也不被判成同一个人", async () => {
  const other = await companionRecord(OTHER_COMPANION);
  assert.equal(other.userId, null);

  // 真实业务里订单一定有下单人（userId 来自会话）。这里故意走一遍「没有下单人」的
  // 异常数据，因为那条 `!== null` 判定要防的正是它的另一半：订单与护航**都**拿不到
  // 用户时，直接比较两个值会把它们判成同一个人。
  const order = await placeOrder(null);
  assert.equal(order.userId, null, "这一条用例的前提就是订单没有下单人");
  const dispatch = await dispatchOf(order.id);

  let outcome = null;
  let thrown = null;
  try {
    outcome = await acceptDispatchForCompanion(
      OTHER_COMPANION,
      dispatch.id,
      plusMinutes(order.paidAt, 1),
    );
  } catch (error) {
    // 顺带记下一个已有的边界（不是本文件要守的那一条）：没有下单人就**没有通知收件人**，
    // 通知在写入之前就构造失败，因此这一单接不下去。真实业务里订单必有下单人，
    // 这里只把它记下来，不让它冒充「禁止自接单」的拒绝
    thrown = error;
  }

  assert.notEqual(
    outcome?.kind,
    "self-order",
    "两个 null 不是同一个人：判定必须先确认护航有 userId 再比，否则「没有关联用户的护航 + 没有下单人的订单」会被判成自接单",
  );
  if (thrown === null) {
    assert.equal(outcome.kind, "ok", "没有被自接单规则拦下时，它就应当照常接单");
  }
});

/* ───────────────── 三、这个结果必须有话对打手说 ───────────────── */

test("自接单 8：每一种接单失败都要有自己的一句话，且不能被合并成「你资格不够」", () => {
  const labels = DISPATCH_ACCEPT_FAILURE_LABELS;

  // 结果集合是硬编码的一份清单（与接口清单门禁同一个思路）：新增一种失败
  // 就必须同时给它一句话——少一条，页面上就会出现一句 `undefined`，
  // 而打手看到的是一张点不动的卡加一串乱码
  assert.deepEqual(
    Object.keys(labels).sort(),
    [
      "companion-unavailable",
      "expired",
      "not-eligible",
      "not-found",
      "not-open",
      "order-closed",
      "self-order",
    ],
    "接单失败的结果集合变了：每一种都要有文案",
  );

  for (const [kind, label] of Object.entries(labels)) {
    assert.equal(typeof label, "string", `${kind} 必须有文案`);
    assert.ok(label.trim().length > 0, `${kind} 的文案不能是空的`);
  }

  const selfOrder = labels["self-order"];
  assert.notEqual(
    selfOrder,
    labels["companion-unavailable"],
    "「你资格不够，去找管理员」与「这是你自己下的单，什么都不用做」对打手要做的事完全不同，合并了就没人知道要不要重试",
  );
  assert.notEqual(
    selfOrder,
    labels["not-eligible"],
    "「你不是这一单指定的人」与「这一单是你自己下的」不是同一件事",
  );
});

/* ───────────────── 四、池子不返回他接不了的那一张 ───────────────── */

/**
 * 池子返回的是一份**「可接订单」列表**，因此它本身就在承诺「这里每一张都接得动」。
 * 把他接不了的自己的单放进去，等于在页面上承诺一件点下去必然失败的事
 * （与 `available=false` 时不返回公共池是同一性质）。
 *
 * ⚠️ 这一层是**诚实性，不是安全性**：真正的保护只有 `acceptDispatch` 原子区段里
 * 那一次比对（上面第一、二节）。删掉这一层只会多一张点了被拒的单；删掉那一道
 * 就是一次真的自接单成功。测试因此分成两组，谁也不替谁背书。
 */
test("自接单 9：自己下的单不出现在自己的公共池里", async () => {
  const { companionId, userId } = await selfActor();
  await resume(companionId);

  const order = await placeOrder(userId);
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public", "没指定护航就直接进公共池");

  const pools = await listCompanionPools(companionId, plusMinutes(order.paidAt, 1));
  assert.equal(
    pools.public.some((item) => item.orderId === order.id),
    false,
    "自己下的单必须从自己的公共池里消失——它在列表里就等于承诺「这一张接得动」",
  );
  assert.equal(
    pools.canAccept,
    true,
    "这位护航此刻可以接单：它消失的原因只能是「这一单是他自己下的」，不是「他接不了单」",
  );

  // ⚠️ 过滤是「不给他看」，不是「把这一单关掉」：服务端的开放派单照旧，别人还接得到
  assert.equal(
    (await dispatchOf(order.id)).state,
    "public",
    "过滤不得改动派单状态——否则就成了用「隐藏」实现「拒绝」",
  );
  assert.equal(
    (await acceptDispatchForCompanion(OTHER_COMPANION, dispatch.id, plusMinutes(order.paidAt, 1)))
      .kind,
    "ok",
    "他不该看的这一张，别人仍然接得走",
  );
});

test("自接单 10：用户把自己指定成护航时，这一单也不出现在他自己的专属池里", async () => {
  const { companionId, userId } = await selfActor();
  await resume(companionId);

  const order = await placeOrder(userId, { companionId });
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "exclusive");
  assert.equal(dispatch.exclusiveCompanionId, companionId, "异常数据：用户把自己指定成了护航");

  const pools = await listCompanionPools(companionId, plusMinutes(order.paidAt, 1));
  assert.equal(
    pools.exclusive.some((item) => item.orderId === order.id),
    false,
    "专属池也不能给：这个池子唯一的作用就是「点它就能接」，而他接不了",
  );
  assert.equal(
    dispatch.exclusiveCompanionId,
    companionId,
    "不返回 ≠ 抹掉「用户当初指定的是谁」这条历史事实",
  );
});

test("自接单 11：过滤只针对「同一个人」——别人下的单照常出现在池子里", async () => {
  const { companionId } = await selfActor();
  await resume(companionId);

  // 下单的**不是**这位护航本人
  const otherUser = unique("u");
  const order = await placeOrder(otherUser);
  const dispatch = await dispatchOf(order.id);

  const pools = await listCompanionPools(companionId, plusMinutes(order.paidAt, 1));
  const item = pools.public.find((entry) => entry.orderId === order.id);
  assert.ok(item, "别人下的单必须照常出现——过滤过头会让池子凭空少单，比多一张更糟");
  assert.equal(item.dispatchId, dispatch.id);
  assert.equal(
    "userId" in item,
    false,
    "这条过滤**不**给池子 DTO 加 `userId`：判据留在服务端，浏览器拿不到",
  );
});

test("自接单 12：两个 null 不是同一个人——护航与订单都拿不到 userId 时，这一单照样在池子里", async () => {
  const other = await companionRecord(OTHER_COMPANION);
  assert.equal(other.userId, null, "预置护航是平台早期数据，没有关联用户");

  // ⚠️ 订单这一侧也必须**真的**没有下单人：这是本用例唯一能触发
  // `companion.userId !== null` 这个子句的构造。若改用真实用户下单，
  // `order.userId` 永不为 null，把这个子句删掉用例照样绿——那就成了一条
  // 声称守住 null 判定、实际测不到的用例。走一遍异常数据才具备判别力：
  // 少了这一步，`null === null` 会让这张单从 cp-1 的池子里凭空消失。
  const order = await placeOrder(null);
  assert.equal(order.userId, null, "这一条用例的前提就是订单没有下单人");
  assert.equal((await dispatchOf(order.id)).state, "public");

  const pools = await listCompanionPools(OTHER_COMPANION, plusMinutes(order.paidAt, 1));
  assert.ok(
    pools.public.some((item) => item.orderId === order.id),
    "两个 null 不是同一个人：这条过滤与 accept Guard 都必须先确认护航有 userId 再比，否则订单会凭空消失",
  );
  assert.equal(pools.canAccept, true);
});
