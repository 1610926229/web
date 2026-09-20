import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPANION_POOL_PAUSED_NOTICE,
  EXCLUSIVE_WAIT_MINUTES,
  plusMinutes,
} from "../lib/constants/dispatch.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import { approveAdminApplication } from "../lib/services/adminCompanionApplications.ts";
import { setAdminCompanionFlags } from "../lib/services/adminCompanions.ts";
import { acceptDispatchForCompanion, listCompanionPools } from "../lib/services/companionDispatch.ts";
import { resolveCompanionAccess } from "../lib/services/companionAccess.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";

/**
 * `enabled` 与 `available` 的分界（P0-5 手工验收时冻结的语义）。
 *
 * ## 这两件事为什么必须分开
 *
 * | 字段 | 回答的问题 | 关掉之后 |
 * |---|---|---|
 * | `enabled` | 这个 User 还有没有**打手工作资格** | 连工作台都进不去（`disabled`） |
 * | `available` | 现在**允不允许接新的订单** | 进得去、看得到自己的资料，但接不了新单 |
 *
 * 把它们混起来的代价是具体的：一位想歇两天的护航会被当成「资格没了」，
 * 进不去工作台、看不到自己的资料，只能去找管理员重开资格——而他要的只是暂时不接单。
 *
 * ## 这一批真正要钉住的四条
 *
 * 1. **`available = false` 不影响「能不能进工作台」**：`resolveCompanionAccess()`
 *    只看 `enabled`，把 `available` 加进去就等于「暂停接单 = 取消资格」；
 * 2. **不能只靠 UI 隐藏**：公共池不返回可接订单只是「诚实」，
 *    真正的拦住发生在 `acceptDispatch` 的原子区段里——伪造请求也一样被拒；
 * 3. **历史事实不因 `available` 改变**：用户指定给我的专属派单照常可见，
 *    `exclusiveCompanionId` 不被改写，到点仍按原规则转公共池；
 * 4. **不新增「主动拒绝」**：暂停接单只让这个人接不了单，
 *    不会产生一条「他拒绝了这一单」的记录（派单域里根本没有这种字段）。
 *
 * ## 用例之间怎么隔离
 *
 * 预置的入驻申请里只有 `ca-1002` / `ca-1003` 两条是可以被通过的，因此这里
 * **每个申请只通过一次**（结果被记住，见 `newlyApprovedCompanion()` /
 * `pausedCandidate()`），用例之间复用同一条护航资料。
 * 复用是安全的，因为**每个用例在开头都会把自己需要的状态显式摆好**
 * （`pause()` / `resume()` 都是幂等的：已经是目标状态时不会写坏任何东西），
 * 不依赖上一个用例留下了什么。
 *
 * 时间同样一次都不等：所有判定用的 `at` 都由订单的 `paidAt` 推算后显式传入。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的一位，`enabled: true` / `available: true` / 未移除。只读，本文件不改它。 */
const COMPANION_AVAILABLE = "cp-1";

let seq = 0;
function unique(tag) {
  seq += 1;
  return `${tag}-p05avail-${process.pid}-${seq}`;
}

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

/** 走真实的审核服务通过一条预置申请，返回它产生的护航资料 id。 */
async function approveSeedApplication(applicationId) {
  const result = await approveAdminApplication(applicationId, unique("adm"), {
    idempotencyKey: unique("key"),
  });
  assert.equal(result.status, "approved", `${applicationId} 应当可以被通过`);
  assert.ok(result.companionId, "通过入驻申请必须产生护航资料");
  return result.companionId;
}

/** 后台的「暂停接单 / 恢复接单」，走真实服务（原因校验、幂等键都是真的）。 */
async function setFlags(companionId, intent, body = {}) {
  const result = await setAdminCompanionFlags(companionId, intent, unique("adm"), {
    idempotencyKey: unique("key"),
    ...body,
  });
  assert.equal(result.companionId, companionId);
  return result;
}

/** 暂停接单：`enabled` 保持 true，只关掉 `available`。 */
async function pause(companionId) {
  const result = await setFlags(companionId, "pause", { unavailableReason: "本轮验收临时休息" });
  assert.equal(result.enabled, true, "暂停接单不得影响工作资格");
  assert.equal(result.available, false);
}

/** 恢复接单。已经是可接单状态时是幂等的空操作。 */
async function resume(companionId) {
  const result = await setFlags(companionId, "resume");
  assert.equal(result.enabled, true);
  assert.equal(result.available, true);
}

/** 去掉注释后再做「源码里有没有某个词」的断言（本仓库的注释会把反例写进去）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * 「刚审核通过的那条护航」——同一个申请只通过一次。
 *
 * ⚠️ 预置数据里可被通过的申请只有两条，重复通过会撞上 `invalid-transition`，
 * 因此这里把结果记住，而不是每个用例各通过一次。
 */
let approvedOnce = null;
function newlyApprovedCompanion() {
  approvedOnce ??= approveSeedApplication("ca-1002");
  return approvedOnce;
}

/**
 * 「会被反复暂停 / 恢复的那条护航」——同样只通过一次，用例之间复用。
 *
 * 它同时充当「用户指定的那位」：测试里需要它在下单时是可选的（结算页只让选
 * `enabled && available` 的护航），这一点由每个用例自己 `resume()` 保证。
 */
let candidateOnce = null;
function pausedCandidate() {
  candidateOnce ??= approveSeedApplication("ca-1003");
  return candidateOnce;
}

/* ───────────────── 一、新审核通过的护航：进得去，但接不了新单 ───────────────── */

test("可用性 1：新审核通过的护航 enabled=true / available=false，仍然可以进入工作台", async () => {
  const companionId = await newlyApprovedCompanion();
  const record = await companionRecord(companionId);

  assert.equal(record.enabled, true, "审核通过 = 拿到打手工作资格");
  assert.equal(record.available, false, "刚通过审核还没被开启接单，因此不是「正在接单」");
  assert.equal(record.removedAt, null);

  // 工作台壳层与接口守卫读的就是这一个结果：只有 granted 才会渲染工作台
  const access = await resolveCompanionAccess(record.userId);
  assert.equal(access.kind, "granted", "available=false 不得影响「能不能进工作台」");
  assert.equal(access.companion.companionId, companionId);
  assert.ok(access.companion.displayName, "身份信息照常可读（身份卡要显示它）");
});

test("可用性 2：暂停接单的护航不具备公共池接单资格（同一条单，别人看得到）", async () => {
  const companionId = await pausedCandidate();
  await pause(companionId);

  const user = unique("u");
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const mine = await listCompanionPools(companionId, at);
  assert.equal(mine.canAccept, false, "canAccept 必须来自服务端判定，不能由页面推断");
  assert.equal(mine.notice, COMPANION_POOL_PAUSED_NOTICE, "顶部要换成「暂停接单」的那句说明");
  assert.equal(
    mine.public.find((item) => item.dispatchId === dispatch.id),
    undefined,
    "暂停接单期间公共池不得返回可接订单——列表承诺不了点下去必然失败的事",
  );

  // 对照：同一条单，一位当前可接单的护航照常看得到（证明过滤的是人，不是单）
  const other = await listCompanionPools(COMPANION_AVAILABLE, at);
  assert.ok(
    other.public.find((item) => item.dispatchId === dispatch.id),
    "可接单的护航必须看得到这张单，否则过滤就变成了「谁都没单」",
  );
  assert.equal(other.canAccept, true);
});

test("可用性 3：伪造接单请求绕不过去——原子区段拒绝，且什么事实都没写", async () => {
  const companionId = await pausedCandidate();
  await pause(companionId);

  const user = unique("u");
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  // 接口可以被直接请求，页面上的按钮藏没藏与这里无关
  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(outcome.kind, "companion-unavailable", "暂停接单时直接调接口也必须失败");

  // 「什么事实都没写」：派单、订单、通知三处都必须原样
  const untouched = await dispatchOf(order.id);
  assert.equal(untouched.state, "public", "派单状态不得改变");
  assert.equal(untouched.acceptedByCompanionId, null);
  assert.equal(untouched.acceptedAt, null);

  const orderAfter = await orderOf(order.id);
  assert.equal(orderAfter.actualCompanionId, null, "订单不得写上实际打手");
  assert.equal(orderAfter.companion, null, "接单快照同理不得提前写");
  assert.equal(orderAfter.status, "paid");

  assert.deepEqual(
    await getNotificationRepository().listNotifications(user),
    [],
    "被拒绝的接单不得发出「订单已被接单」通知",
  );
});

test("可用性 4：后台恢复接单后，同一个人可以看到并接下公共池的订单", async () => {
  const companionId = await pausedCandidate();
  await resume(companionId);

  const user = unique("u");
  const order = await placeOrder(user);
  const dispatch = await dispatchOf(order.id);
  const at = plusMinutes(order.paidAt, 1);

  const pools = await listCompanionPools(companionId, at);
  assert.equal(pools.canAccept, true);
  assert.ok(
    pools.public.find((item) => item.dispatchId === dispatch.id),
    "恢复接单后公共池必须重新出现这张单",
  );
  assert.notEqual(pools.notice, COMPANION_POOL_PAUSED_NOTICE, "顶部说明要换回默认那句");

  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.replayed, false);

  const accepted = await orderOf(order.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.actualCompanionId, companionId);
  assert.equal(accepted.companion?.id, companionId, "接单快照写的是这位护航的公开信息");
});

/* ───────────────── 二、专属池：历史可见性与当前接单资格是两件事 ───────────────── */

test("可用性 5：指定给 A 之后 A 被暂停——历史指定不被改写，A 看得到但接不了", async () => {
  const companionId = await pausedCandidate();
  // 下单时必须可选：结算页只让选 enabled && available 的护航（这条规则本批次不动）
  await resume(companionId);

  const user = unique("u");
  const order = await placeOrder(user, { companionId });
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "exclusive");

  await pause(companionId);
  const paused = await companionRecord(companionId);
  assert.equal(paused.enabled, true, "暂停接单不是取消资格");
  assert.equal(paused.available, false);

  // ① 历史事实：用户当初指定的是谁，一个字都不改
  const after = await dispatchOf(order.id);
  assert.equal(after.exclusiveCompanionId, companionId, "暂停接单不得改写 exclusiveCompanionId");
  assert.equal(after.state, "exclusive", "专属池照样在等他，转池只看时限");
  assert.equal(after.acceptedByCompanionId, null);

  const at = plusMinutes(order.paidAt, 1);
  const pools = await listCompanionPools(companionId, at);

  // ② 历史可见性：属于自己的专属派单照常看得到（页面据此隐藏接单按钮，而不是藏掉这一单）
  assert.equal(pools.canAccept, false, "没有接单资格");
  const item = pools.exclusive.find((entry) => entry.dispatchId === dispatch.id);
  assert.ok(item, "暂停接单不影响「用户指定给我的单」的可见性");
  assert.equal(item.pool, "exclusive");

  // ③ 直接调接口：失败，且不写任何事实
  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(outcome.kind, "companion-unavailable");

  const untouched = await dispatchOf(order.id);
  assert.equal(untouched.state, "exclusive");
  assert.equal(untouched.acceptedByCompanionId, null);
  assert.equal((await orderOf(order.id)).actualCompanionId, null);
});

test("可用性 6：期限内重新恢复接单，仍然可以正常接下这一单", async () => {
  const companionId = await pausedCandidate();
  await resume(companionId);

  const user = unique("u");
  const order = await placeOrder(user, { companionId });
  const dispatch = await dispatchOf(order.id);

  // 先暂停再恢复：暂停期间接不了，恢复之后接得动——唯一的变量就是 available
  await pause(companionId);
  assert.equal(
    (await acceptDispatchForCompanion(companionId, dispatch.id, plusMinutes(order.paidAt, 1))).kind,
    "companion-unavailable",
  );

  await resume(companionId);
  const at = plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES - 1);
  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, at);
  assert.equal(outcome.kind, "ok", "deadline 还没到，恢复接单后应当能接");

  const accepted = await dispatchOf(order.id);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acceptedByCompanionId, companionId);
  assert.equal(accepted.exclusiveCompanionId, companionId, "指定值与实际值此时是同一个人，但仍是两个字段");
});

test("可用性 7：一直没恢复接单，到点后仍按原规则转公共池，不新增主动拒绝", async () => {
  const companionId = await pausedCandidate();
  await resume(companionId);

  const user = unique("u");
  const order = await placeOrder(user, { companionId });
  const dispatch = await dispatchOf(order.id);
  await pause(companionId);

  // 到点那一刻（不是「谁碰巧来看了一眼」的时刻）
  sweepExpiredDispatches(dispatch.exclusiveDeadlineAt);

  const moved = await dispatchOf(order.id);
  assert.equal(moved.state, "public", "专属池到点仍然转公共池");
  assert.equal(moved.exclusiveCompanionId, companionId, "转公共池也不改写历史指定");
  assert.equal(moved.acceptedByCompanionId, null);
  assert.equal(moved.timedOutAt, null, "转公共池不是超时关闭");
  assert.equal((await orderOf(order.id)).status, "paid", "转公共池不退款、不进售后");

  const afterDeadline = plusMinutes(dispatch.exclusiveDeadlineAt, 1);
  assert.equal(
    (await acceptDispatchForCompanion(companionId, dispatch.id, afterDeadline)).kind,
    "companion-unavailable",
    "暂停期间即使单已经进了公共池，他也接不了",
  );

  // 恢复之后从公共池接走：转池是正常业务，不是被谁「拒绝」掉的
  await resume(companionId);
  const pools = await listCompanionPools(companionId, afterDeadline);
  assert.ok(
    pools.public.find((item) => item.dispatchId === dispatch.id),
    "恢复接单后这张单应当出现在公共池里",
  );

  const outcome = await acceptDispatchForCompanion(companionId, dispatch.id, plusMinutes(afterDeadline, 1));
  assert.equal(outcome.kind, "ok");
  assert.equal((await dispatchOf(order.id)).acceptedByCompanionId, companionId);
});

/* ───────────────── 三、与「资格停用」的分界，以及结构性约束 ───────────────── */

test("可用性 8：enabled=false 仍是身份问题，与暂停接单不是同一件事", async () => {
  const companionId = await pausedCandidate();
  const record = await companionRecord(companionId);
  const userId = record.userId;
  assert.ok(userId, "审核通过产生的护航必须关联到一个用户");

  // 停用（enabled=false）：连工作台都进不去，而且与「根本没有护航资料」分开表达
  assert.equal((await setFlags(companionId, "disable")).enabled, false);

  const disabled = await resolveCompanionAccess(userId);
  assert.equal(disabled.kind, "disabled", "停用是身份层的拒绝");
  assert.equal(disabled.companion.companionId, companionId, "仍然说得出是哪一条资料被停用");
  assert.equal(
    disabled.kind === "not-a-companion",
    false,
    "「资格被停用」不等于「不是护航」——恢复之后他就回来了",
  );

  const stranger = await resolveCompanionAccess(unique("u"));
  assert.equal(stranger.kind, "not-a-companion", "没有护航资料的人是另一种结果，两者不可混");

  // 恢复启用后重新进得去；`enable` 不动 available（回到名单 ≠ 马上能接单）
  const reenabled = await setFlags(companionId, "enable");
  assert.equal(reenabled.enabled, true);
  assert.equal(reenabled.available, false, "重新启用不等于重新开始接单");

  const back = await resolveCompanionAccess(userId);
  assert.equal(back.kind, "granted", "资格回来了，工作台照常进得去");
});

test("可用性 9：结构性约束——`available` 进不了资格判定，也进不了「拒绝」路径", () => {
  // 资格判定只回答 `enabled` / `removedAt`。把 available 加进来 = 暂停接单即取消资格
  for (const relative of ["lib/services/companionAccess.ts", "lib/api/companionRoute.ts"]) {
    assert.equal(
      stripComments(readSource(relative)).includes("available"),
      false,
      `${relative} 不得读 available：资格与接单能力必须分开`,
    );
  }

  // 原子接单区段里必须真的再判一次（公共池不返回只是诚实，拦住靠的是这里）
  const transaction = stripComments(readSource("lib/data/companionDispatchTransaction.ts"));
  assert.ok(
    transaction.includes("isCompanionAcceptingOrders"),
    "接单的原子区段必须再判一次接单能力，否则伪造请求就能绕过",
  );

  // 「不接」就是拒绝：派单域里没有、也不该有「主动拒绝 / 放弃」这条写入路径
  for (const relative of [
    "lib/types/dispatch.ts",
    "lib/data/companionDispatchTransaction.ts",
    "lib/services/companionDispatch.ts",
  ]) {
    assert.equal(
      /declin|reject/i.test(stripComments(readSource(relative))),
      false,
      `${relative} 不该出现「拒绝 / 放弃」的能力：暂停接单只让这个人接不了单，不产生拒绝记录`,
    );
  }
});
