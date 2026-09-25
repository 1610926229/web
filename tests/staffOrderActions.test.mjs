import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { isCompanionAcceptingOrders } from "../lib/constants/companions.ts";
import { canTransitionCompletion } from "../lib/constants/completions.ts";
import {
  COMPANION_RELEASE_REASON_DISABLED,
  DISPATCH_NOTIFICATION_COMPANION_DISABLED,
  DISPATCH_NOTIFICATION_STAFF_REASSIGNED,
  DISPATCH_NOTIFICATION_STAFF_REPLACED,
  ORDER_DATA_INCONSISTENT_MESSAGE,
  plusMinutes,
} from "../lib/constants/dispatch.ts";
import { ORDER_STATUS_LABELS, ORDER_TRANSITIONS } from "../lib/constants/orders.ts";
import {
  STAFF_ORDER_COMPANION_NOT_FOUND_MESSAGE,
  STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
  STAFF_ORDER_NOT_FOUND_MESSAGE,
  STAFF_ORDER_NOT_RELEASABLE_MESSAGE,
  STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
  STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE,
  STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE,
  STAFF_ORDER_SAME_COMPANION_MESSAGE,
  STAFF_ORDER_SELF_ORDER_MESSAGE,
  staffOrderAllowedActions,
} from "../lib/constants/staff.ts";
import { removeCompanion, setCompanionFlags } from "../lib/data/adminCompanionTransaction.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import {
  cancelAcceptedOrder,
  releaseOrdersForCompanion,
  startCompanionOrder as startCompanionOrderTransaction,
} from "../lib/data/companionOrderTransaction.ts";
import {
  approveCompletion,
  rejectCompletion,
  submitCompletion,
  sweepCompletionAutoApprovals,
} from "../lib/data/completionTransaction.ts";
import { getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { companionStore } from "../lib/data/mockCompanionRepository.ts";
import { companionReleaseStore } from "../lib/data/mockCompanionReleaseRepository.ts";
import { completionStore } from "../lib/data/mockCompletionRepository.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { readPlatformConfig } from "../lib/data/mockPlatformConfigRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  listStaffOrderReplaceCandidates,
  releaseStaffOrder,
  replaceStaffOrderCompanion,
} from "../lib/services/staffOrderActions.ts";
import { getStaffOrderDetail } from "../lib/services/staffOrders.ts";
import { collectFiles, readSource, stripComments, withoutImports } from "./source-text.mjs";

/**
 * P0-11「客服换打手 / 打手停用回池 / pending 完成材料作废」。
 *
 * ## 这一批守住的四件事
 *
 * 1. **一次释放必须同时成立五件事**（`lib/data/companionOrderTransaction.ts` 文件头）：
 *    pending 完成材料作废、写退出历史、清订单履约绑定、派单的去向、通知下单用户。
 *    少做任何一件都会留下一个**自相矛盾的状态**——最典型的是「派单说被 A 接了、
 *    订单说等待接单」，而这两条都能被别的读路径看到。
 * 2. **`available` 与 `enabled` 方向相反**（EX-SERVICE-05 vs EX-COMP-01/02）：
 *    暂停接单**不释放**他手上的单，停用**必须释放**。把它们合成一个判断的写法
 *    必然在其中一侧出错，因此两侧都要有用例。
 * 3. **`serving → accepted` 这条边不存在**：直换靠 `serving → paid → accepted`。
 *    真要写出第一条边，中间那个 `paid` 就会暴露给并发抢单（`cmd_p0-11.md:42`）。
 * 4. **作废过的完成材料既不可人工审、也不可自动通过**：只有把
 *    `approveCompletion` / `rejectCompletion` / `sweepCompletionAutoApprovals`
 *    真的各跑一遍才验得出来。
 *
 * ## 最后两组（§十、§十一）需要真实服务
 *
 * §十 是**失败路径**的 HTTP 契约（401 / 403 / 404 / 400 / 405 / 500），
 * §十一 是**正常结果**那一格（200 且订单真的变了）——《用户权限表》§十三 第 8 条
 * 要求权限矩阵覆盖 401 / 403 / 404 / 正常结果四条。两节都设 `APP_BASE_URL` 才跑。
 * ⚠️ §十一 会在真实服务上从零造订单（不碰任何预置数据），因此可以反复跑。
 *
 * ## 用例之间怎么隔离
 *
 * `beforeEach` 重建九份存储。⚠️ 完成材料 / 退出历史 / 收益**没有预置数据**，
 * 但**订单、派单、护航、客服**都有——因此：
 *
 * - 涉及「通知」「退出历史」的断言一律**只针对本用例自己造的那一单**，
 *   而且下单用户是**本用例新造的合成 id**（`createPaymentRequest` 不校验用户存在），
 *   预置数据里绝不会有它，所以收件箱可以从空开始直接计数；
 * - 涉及「在履约单数」的断言**一律写成增量**（`m1 === m0 + 1`），
 *   不写绝对值——预置里有正在履约的订单，绝对值会随种子规模漂移。
 *
 * ## 关于护航 id
 *
 * 预置的 `cp-1` / `cp-2` / `cp-3` 都是 `enabled` + `available` + 未移除，
 * 但它们**各自还挂着预置的 accepted/serving 订单**。因此：
 *
 * - 换人 / 回池这类**按单收窄**的用例用它们，断言不受影响；
 * - 「停用一位护航」这类**按人扩大**的用例改用 `cp-5`——它与 `cp-8` / `cp-9` 一样
 *   没挂任何预置在履约的单，受影响集合恰好是本用例造的那两单，结果确定；
 * - `cp-4` / `cp-6` 是预置里 `available: false` 的两位，`cp-7` 是唯一的 `enabled: false`；
 * - `cp-10` 绑 `u-1022`、`cp-11` 绑 `u-1023`：用于「不能指定给下单用户本人」。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 可接单 + 未移除，但**挂着预置在履约单**：只用于按单收窄的用例。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";
const COMPANION_C = "cp-3";

/** `available: false`（暂停接单）：不释放已有订单，但也不能被指定为新打手。 */
const COMPANION_PAUSED = "cp-4";
/** 唯一的 `enabled: false`（已下架）：不能被指定，也不能被当成候选。 */
const COMPANION_DISABLED_SEED = "cp-7";
/** 可接单 + 未移除 + **没有挂任何预置在履约的单**：停用类用例用它。 */
const COMPANION_FREE = "cp-5";
/** 绑 `userId: "u-1022"` 的那位，用于禁止自接单。 */
const COMPANION_BOUND = "cp-10";
const BOUND_USER = "u-1022";

/** 客服会话身份的**最小形状**：测试只需要 `id`，但类型要求六个字段齐全。 */
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
  return `${prefix}-p011-${process.pid}-${seq}`;
}

/** 一次管理端写操作。`operationId` 每次唯一，因此不会撞上幂等重放。 */
function adminCtx() {
  return {
    actorId: "admin-1",
    actorRole: "admin",
    actorName: null,
    operationId: unique("op"),
    at: new Date().toISOString(),
  };
}

/**
 * 走完整下单链路（创建支付请求 → 支付成功），返回订单。
 *
 * ⚠️ 下单用户默认是**本用例新造的合成 id**：`createPaymentRequest` 不校验用户存在，
 * 而用一个预置里没有的 userId 能让「这一单产生了哪几条通知」变成可以直接计数的断言。
 */
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

function dispatchOf(orderId) {
  const record = dispatchStore().dispatches.get(dispatchIdOf(orderId));
  assert.ok(record, `订单 ${orderId} 的派单记录必须还在 store 里`);
  return record;
}

/** 把订单推到 `accepted`（有人接了，还没开始服务）。返回接单时刻。 */
async function acceptOrder(orderId, companionId) {
  const at = new Date().toISOString();
  const accepted = await acceptDispatch(dispatchIdOf(orderId), { companionId, at });
  assert.equal(accepted.kind, "ok", `订单 ${orderId} 必须能被 ${companionId} 接走`);
  return at;
}

/** 把订单推到 `serving`（接了且已经开始服务）。返回接单时刻。 */
async function serveOrder(orderId, companionId) {
  const at = await acceptOrder(orderId, companionId);
  const started = await startCompanionOrderTransaction({
    companionId,
    orderId,
    at: plusMinutes(at, 5),
  });
  assert.equal(started.kind, "ok", "开始服务必须成功");
  return at;
}

function releasesOf(orderId) {
  return getCompanionReleaseRepository().listReleasesByOrderId(orderId);
}

/** 按标题认出「因为这一单被处置」而产生的那条通知（接单成功也会发通知）。 */
async function notificationsTitled(userId, title) {
  const all = await getNotificationRepository().listNotifications(userId);
  return all.filter((item) => item.title === title);
}

/**
 * 给某个订单拍一张「失败时不得被改动」的快照。
 *
 * ⚠️ 收件箱**不是空的**：把订单推到 serving 的路上，接单那一步已经给下单用户发过
 * 一条通知了。因此这里记的是**当时有哪些**，而不是假定它为空。
 */
async function snapshotOf(order) {
  const notices = await getNotificationRepository().listNotifications(order.userId);
  return {
    userId: order.userId,
    order: { ...paymentStore().orders.get(order.id) },
    dispatch: { ...dispatchOf(order.id) },
    notificationIds: notices.map((item) => item.id),
    submissionCount: completionStore().submissions.size,
  };
}

/** 断言「一笔都没写」：订单、派单、退出历史、通知全部保持原样。 */
async function assertNothingWritten(orderId, snapshot) {
  assert.deepEqual(
    { ...paymentStore().orders.get(orderId) },
    snapshot.order,
    "失败的调用不得改动订单——尤其是不得把状态拉回 paid",
  );
  assert.deepEqual({ ...dispatchOf(orderId) }, snapshot.dispatch, "失败的调用不得改动派单");
  assert.deepEqual(await releasesOf(orderId), [], "失败的调用不得写退出历史");
  assert.deepEqual(
    (await getNotificationRepository().listNotifications(snapshot.userId)).map((item) => item.id),
    snapshot.notificationIds,
    "失败的调用不得发通知——一条「你的护航换了」发出去就收不回来",
  );
  assert.equal(completionStore().submissions.size, snapshot.submissionCount, "不得凭空建完成材料");
}

/** 把订单推到 `completed`（走完 提交 → 人工通过 两条既有路径）。 */
async function completeOrder(orderId, companionId) {
  const submitted = await submitCompletion({
    companionId,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(submitted.kind, "ok", "提交完成材料必须成功");
  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    at: new Date().toISOString(),
  });
  assert.equal(approved.kind, "ok", "人工通过必须成功");
  assert.equal(paymentStore().orders.get(orderId).status, "completed");
  return submitted;
}

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("completion");
  resetMockStore("companionRelease");
  resetMockStore("notification");
  resetMockStore("companion");
  resetMockStore("platformConfig");
  resetMockStore("earning");
  resetMockStore("adminAudit");
});

// ——————————————————— 零、前置：这批用例依赖的种子事实 ———————————————————

test("前置：cp-5 干净可接单、cp-4 暂停接单、cp-7 已下架——后面几组用例的地基", () => {
  const companions = companionStore().companions;

  for (const id of [COMPANION_A, COMPANION_B, COMPANION_C, COMPANION_FREE]) {
    const companion = companions.get(id);
    assert.ok(companion, `${id} 必须在预置名单里`);
    assert.equal(
      isCompanionAcceptingOrders(companion),
      true,
      `${id} 必须可接单，否则「指定他接替」那几组用例全部空转`,
    );
  }

  const paused = companions.get(COMPANION_PAUSED);
  assert.equal(paused.available, false);
  assert.equal(
    paused.enabled,
    true,
    "cp-4 是**暂停接单**、不是下架——第四组用例正是在区分这两件事",
  );
  assert.equal(isCompanionAcceptingOrders(paused), false);

  const disabled = companions.get(COMPANION_DISABLED_SEED);
  assert.equal(disabled.enabled, false, "cp-7 必须是 enabled: false");
  assert.equal(isCompanionAcceptingOrders(disabled), false);

  assert.equal(companions.get(COMPANION_BOUND).userId, BOUND_USER, "禁止自接单的用例依赖这条绑定");

  // cp-5 没有挂任何预置在履约的单：停用类用例的受影响集合因此只包含本用例造的单
  const liveForFree = [...paymentStore().orders.values()].filter(
    (order) =>
      order.actualCompanionId === COMPANION_FREE &&
      (order.status === "accepted" || order.status === "serving"),
  );
  assert.deepEqual(liveForFree, [], "cp-5 必须没有预置在履约的单，否则停用类断言不再确定");
});

// ——————————————————— 一、客服退回公共池 ———————————————————

test("回池 1：原因必填（缺 / 空 / 只有空白都是 400），且失败时一笔都没写", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const snapshot = await snapshotOf(order);

  for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "\n\t " }]) {
    await assert.rejects(
      () => releaseStaffOrder(order.id, STAFF, body),
      (error) =>
        error.code === "BAD_REQUEST" &&
        error.status === 400 &&
        error.message === STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE,
      `body=${JSON.stringify(body)} 必须被拒绝：原因必填`,
    );
  }

  await assertNothingWritten(order.id, snapshot);
});

test("回池 2：serving → paid，五件事一次完成（清 servingAt、重冻公共池、写历史、发通知）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);

  const timeout = readPlatformConfig().publicPoolTimeoutMinutes;
  assert.ok(Number.isFinite(timeout) && timeout > 0, "平台配置里必须有公共池超时");

  const before = dispatchOf(order.id);
  assert.equal(before.state, "accepted");
  const enteredBefore = before.publicPoolEnteredAt;

  const reason = "原护航联系不上，客户要求换人";
  const result = await releaseStaffOrder(order.id, STAFF, { reason });

  /* —— 1. 返回值 —— */
  assert.equal(result.status, "paid");
  assert.equal(result.statusLabel, ORDER_STATUS_LABELS.paid);
  assert.equal(result.orderId, order.id);
  assert.equal(result.orderNo, order.orderNo);
  assert.equal(result.changed, true);
  assert.ok(result.releaseRecordId, "必须给出退出历史 id：那是「谁在什么时候把谁换掉」的唯一指针");

  /* —— 2. 订单：履约绑定整体解除 —— */
  const updated = paymentStore().orders.get(order.id);
  assert.equal(updated.status, "paid");
  assert.equal(updated.actualCompanionId, null, "必须清掉当前履约人");
  assert.equal(updated.companion, null, "展示快照必须与字段一起清：只清一个会留下一个还会说话的幽灵");
  assert.equal(updated.servingAt, null, "回到 paid 时清空 servingAt");
  assert.equal(updated.acceptedAt, null, "接受时刻同样属于上一位");

  /* —— 3. 派单：回公共池，三个 public 字段按**此刻**的配置重冻 —— */
  const dispatch = dispatchOf(order.id);
  assert.equal(dispatch.state, "public", "回池之后必须真的在池子里等人接");
  assert.equal(dispatch.acceptedByCompanionId, null);
  assert.equal(dispatch.acceptedAt, null);
  assert.equal(dispatch.publicPoolEnteredAt, result.releasedAt, "进池时刻就是这次释放的时刻");
  assert.equal(
    dispatch.publicDeadlineAt,
    plusMinutes(result.releasedAt, timeout),
    "截止时间必须用**此刻**的平台配置重算：沿用上一次的等于把已经过期的规则又承诺一遍",
  );
  assert.equal(dispatch.publicTimeoutMinutesSnapshot, timeout);
  assert.ok(
    Date.parse(dispatch.publicPoolEnteredAt) >= Date.parse(enteredBefore),
    "这一次是**重新**进池：进池时刻不得早于上一次",
  );

  /* —— 4. 退出历史 —— */
  const releases = await releasesOf(order.id);
  assert.equal(releases.length, 1, "一次释放写且只写一条退出历史");
  const release = releases[0];
  assert.equal(release.companionId, COMPANION_A, "历史记的是**被解除**的那位");
  assert.equal(release.source, "staff_reassign");
  assert.equal(release.reason, reason, "客服写下的原因必须原样保存");
  assert.equal(release.actorId, STAFF.id, "触发者来自会话，不来自请求体");
  assert.equal(release.createdAt, result.releasedAt);

  /* —— 5. 下单用户收到通知 —— */
  const notices = await notificationsTitled(order.userId, DISPATCH_NOTIFICATION_STAFF_REASSIGNED.title);
  assert.equal(notices.length, 1, "用户必须收到一条「护航已更换」");
  assert.equal(notices[0].href, `/orders/${order.id}`, "通知要指向这一单");

  /* —— 6. 详情上的动作随之消失（判据是服务端算的）—— */
  const detail = await getStaffOrderDetail(order.id, new URLSearchParams(), "server");
  assert.ok(detail);
  assert.deepEqual(
    detail.allowedActions,
    { canRelease: false, canReplace: false },
    "回到 paid 之后这一单不该再有处置动作",
  );
});

test("回池 3：accepted（还没开始服务）同样支持，且不需要 servingAt 就能清", async () => {
  const order = await placeOrder();
  await acceptOrder(order.id, COMPANION_A);
  assert.equal(paymentStore().orders.get(order.id).status, "accepted");
  assert.equal(paymentStore().orders.get(order.id).servingAt, null);

  const result = await releaseStaffOrder(order.id, STAFF, { reason: "客户改时间" });
  assert.equal(result.status, "paid");
  assert.equal(paymentStore().orders.get(order.id).status, "paid");
  assert.equal(dispatchOf(order.id).state, "public");
  assert.equal((await releasesOf(order.id)).length, 1);
});

test("回池 4：paid / completed 一律 400——订单存在，只是这个动作不该出现", async () => {
  const paid = await placeOrder();
  const paidSnapshot = await snapshotOf(paid);
  await assert.rejects(
    () => releaseStaffOrder(paid.id, STAFF, { reason: "想退回去" }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_RELEASABLE_MESSAGE,
    "还没人接的单没有「退回公共池」这回事",
  );
  await assertNothingWritten(paid.id, paidSnapshot);

  const completed = await placeOrder();
  await serveOrder(completed.id, COMPANION_A);
  await completeOrder(completed.id, COMPANION_A);
  const doneSnapshot = await snapshotOf(completed);
  await assert.rejects(
    () => releaseStaffOrder(completed.id, STAFF, { reason: "想退回去" }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_RELEASABLE_MESSAGE,
  );
  await assertNothingWritten(completed.id, doneSnapshot);
  assert.equal(
    paymentStore().orders.get(completed.id).actualCompanionId,
    COMPANION_A,
    "终态订单的 actualCompanionId 是「谁做的」，不是「谁在做」——不得被清除",
  );
});

test("回池 5：订单不存在 404；旧打手在释放后**立刻**失去全部操作权", async () => {
  await assert.rejects(
    () => releaseStaffOrder("ord-根本不存在", STAFF, { reason: "试试" }),
    (error) => error.status === 404 && error.message === STAFF_ORDER_NOT_FOUND_MESSAGE,
  );

  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  await releaseStaffOrder(order.id, STAFF, { reason: "换人" });

  // 三件事都必须失败，而且都是「查不到这一单」——不是「这一单此刻不是那个状态」。
  // 口径是刻意的：告诉他「你还挂着这一单，只是状态不对」会让他一直在页面上刷新。
  assert.deepEqual(
    await startCompanionOrderTransaction({
      companionId: COMPANION_A,
      orderId: order.id,
      at: new Date().toISOString(),
    }),
    { kind: "not-found" },
    "旧打手不得再开始服务",
  );

  assert.equal(
    (
      await cancelAcceptedOrder({
        companionId: COMPANION_A,
        orderId: order.id,
        reason: "我不做了",
        idempotencyKey: unique("cancel"),
        at: new Date().toISOString(),
      })
    ).kind,
    "not-found",
    "旧打手不得再取消这一单",
  );

  assert.equal(
    (
      await submitCompletion({
        companionId: COMPANION_A,
        orderId: order.id,
        summary: "我做完了",
        evidence: [],
        at: new Date().toISOString(),
      })
    ).kind,
    "not-found",
    "旧打手不得再提交完成材料",
  );
});

// ——————————————————— 二、客服直接换人 ———————————————————

test("换人 1：状态表里**没有** `serving → accepted`，而落点是 serving → paid → accepted", () => {
  assert.equal(
    ORDER_TRANSITIONS.serving.includes("accepted"),
    false,
    "这条边被写出来就意味着可以「从服务中直接跳到别人手里」——中间那个 paid 会暴露给并发抢单",
  );
  assert.equal(ORDER_TRANSITIONS.serving.includes("paid"), true, "直换靠这一条边");
  assert.equal(ORDER_TRANSITIONS.paid.includes("accepted"), true, "然后再走一次接单");
  assert.equal(ORDER_TRANSITIONS.accepted.includes("paid"), true, "accepted 起步的直换同理");
});

test("换人 2：serving 的单直换——新 acceptedAt、清 servingAt、派单改绑且**不经过**公共池", async () => {
  const order = await placeOrder();
  const servedAt = await serveOrder(order.id, COMPANION_A);
  const before = dispatchOf(order.id);
  const enteredBefore = before.publicPoolEnteredAt;
  const deadlineBefore = before.publicDeadlineAt;
  assert.equal(before.acceptedByCompanionId, COMPANION_A);

  const result = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });

  /* —— 返回值 —— */
  assert.equal(result.status, "accepted", "新打手拿到的与他自己点接单完全一样：accepted");
  assert.equal(result.statusLabel, ORDER_STATUS_LABELS.accepted);
  assert.equal(result.previousCompanionId, COMPANION_A);
  assert.equal(result.newCompanionId, COMPANION_B);
  assert.equal(result.changed, true);
  assert.ok(result.releaseRecordId);
  assert.equal(result.orderNo, order.orderNo);

  /* —— 订单：换了人，状态回到 accepted，时间戳都是新的 —— */
  const updated = paymentStore().orders.get(order.id);
  assert.equal(updated.status, "accepted");
  assert.equal(updated.actualCompanionId, COMPANION_B);
  assert.equal(updated.acceptedAt, result.replacedAt, "acceptedAt 是**本次接手**的时刻");
  assert.notEqual(updated.acceptedAt, plusMinutes(servedAt, 5), "不得沿用上一位的开始时刻");
  assert.equal(updated.servingAt, null, "新打手还没点「开始服务」，servingAt 必须为空");
  assert.equal(updated.companion?.id, COMPANION_B, "展示快照必须换成新打手");

  /* —— 派单：改绑，**不回公共池** —— */
  const dispatch = dispatchOf(order.id);
  assert.equal(dispatch.state, "accepted");
  assert.equal(dispatch.acceptedByCompanionId, COMPANION_B);
  assert.equal(dispatch.acceptedAt, result.replacedAt);
  assert.equal(
    dispatch.publicPoolEnteredAt,
    enteredBefore,
    "直换不经过公共池：`publicPoolEnteredAt` 是历史事实，不得被伪造成「刚才进过池」",
  );
  assert.equal(
    dispatch.publicDeadlineAt,
    deadlineBefore,
    "同上：不得重冻一个从未发生过的进池截止时间",
  );

  /* —— 退出历史 —— */
  const releases = await releasesOf(order.id);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].companionId, COMPANION_A, "历史记的是被换掉的那位");
  assert.equal(releases[0].source, "staff_reassign");
  assert.equal(releases[0].actorId, STAFF.id);
  assert.equal(releases[0].reason, null, "直换没有「客服写的原因」这回事，不编一句出来");

  /* —— 通知 —— */
  const notices = await notificationsTitled(order.userId, DISPATCH_NOTIFICATION_STAFF_REPLACED.title);
  assert.equal(
    notices.length,
    1,
    "直换与回池必须用**不同**的通知：一个说「等别人接」，一个说「已经有人了」",
  );

  /* —— 新打手可以自己开始服务；旧打手不能 —— */
  const startAt = plusMinutes(result.replacedAt, 1);
  const started = await startCompanionOrderTransaction({
    companionId: COMPANION_B,
    orderId: order.id,
    at: startAt,
  });
  assert.equal(started.kind, "ok", "新打手必须能自己点「开始服务」");
  assert.equal(
    paymentStore().orders.get(order.id).servingAt,
    startAt,
    "新一任的 servingAt 由**他自己**点击那一刻写入",
  );
  assert.equal(
    (
      await startCompanionOrderTransaction({
        companionId: COMPANION_A,
        orderId: order.id,
        at: plusMinutes(result.replacedAt, 2),
      })
    ).kind,
    "not-found",
    "旧打手不得再对同一单做任何事",
  );
});

test("换人 3：accepted（还没开始服务）同样支持，且不必经过 serving", async () => {
  const order = await placeOrder();
  await acceptOrder(order.id, COMPANION_A);

  const result = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  assert.equal(result.status, "accepted");
  assert.equal(paymentStore().orders.get(order.id).actualCompanionId, COMPANION_B);
  assert.equal(paymentStore().orders.get(order.id).servingAt, null);
  assert.equal((await releasesOf(order.id)).length, 1);
});

test("换人 4：没指定人 / 指定的人不存在 / 就是当前那位——三种 400 分得开", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const snapshot = await snapshotOf(order);

  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, {}),
    (error) => error.status === 400 && error.message === STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE,
  );
  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, { companionId: "   " }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE,
    "只打了空格的 id 视同没填",
  );
  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, { companionId: "cp-不存在" }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_COMPANION_NOT_FOUND_MESSAGE,
  );
  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_SAME_COMPANION_MESSAGE,
    "指定的就是正在履约的那位：没有「换」这件事可做。这一条必须**先于**资格判定——他正在做着这一单，说他「不能接单」是反的",
  );

  await assertNothingWritten(order.id, snapshot);
});

test("换人 5：暂停接单 / 已下架 / 已移除 三种人都不能被指定（共用一句 400）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const snapshot = await snapshotOf(order);

  // 已移除：预置里没有样本，就在本用例里真的移除一位
  const removed = await removeCompanion(COMPANION_C, adminCtx());
  assert.equal(removed.kind, "ok");
  assert.notEqual(companionStore().companions.get(COMPANION_C).removedAt, null);

  for (const [companionId, label] of [
    [COMPANION_PAUSED, "暂停接单（available=false）"],
    [COMPANION_DISABLED_SEED, "已下架（enabled=false）"],
    [COMPANION_C, "已移除（removedAt 非空）"],
  ]) {
    await assert.rejects(
      () => replaceStaffOrderCompanion(order.id, STAFF, { companionId }),
      (error) => error.status === 400 && error.message === STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
      `${label} 不得被指定为接替者`,
    );
  }

  await assertNothingWritten(order.id, snapshot);
});

test("换人 6：不能把订单指定给**下单用户本人**（与用户端接单的反自接单同一条）", async () => {
  const order = await placeOrder(BOUND_USER);
  await serveOrder(order.id, COMPANION_A);
  const snapshot = await snapshotOf(order);

  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_BOUND }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_SELF_ORDER_MESSAGE,
  );
  await assertNothingWritten(order.id, snapshot);
});

test("换人 7：paid / completed 不得被直换——本轮不做「给还没人接的单指派打手」", async () => {
  const paid = await placeOrder();
  await assert.rejects(
    () => replaceStaffOrderCompanion(paid.id, STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
    "公共池的单属于所有可接单的人：直接指派会同时绕过「先到先得」与「用户指定」两套既有规则",
  );

  const completed = await placeOrder();
  await serveOrder(completed.id, COMPANION_A);
  await completeOrder(completed.id, COMPANION_A);
  await assert.rejects(
    () => replaceStaffOrderCompanion(completed.id, STAFF, { companionId: COMPANION_B }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
  );

  await assert.rejects(
    () => replaceStaffOrderCompanion("ord-根本不存在", STAFF, { companionId: COMPANION_B }),
    (error) => error.status === 404 && error.message === STAFF_ORDER_NOT_FOUND_MESSAGE,
  );
});

test("换人 8：不需要管理员审批——客服会话 + 裸请求体就能换", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);

  // 请求体里**只有** companionId：没有 operationId、没有审批号、没有管理员身份。
  // 它成功本身就证明了「客服的会话身份就是全部授权」
  const result = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  assert.equal(result.newCompanionId, COMPANION_B);

  const source = stripComments(
    readSource(path.join(ROOT, "lib", "services", "staffOrderActions.ts")),
  );
  for (const forbidden of ["requireAdmin", "adminWriteSupport", "adminAuditRepository"]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `客服换人不得依赖管理端设施（${forbidden}）：引入它就意味着这个动作需要管理员在场`,
    );
  }
});

// ——————————————————— 三、换人候选名单 ———————————————————

test("候选 1：只装此刻能接单的人，且排除当前履约人与下单用户本人", async () => {
  const order = await placeOrder(BOUND_USER);
  await serveOrder(order.id, COMPANION_A);

  const list = await listStaffOrderReplaceCandidates(order.id);
  assert.ok(list.items.length > 0, "预置名单里必须有可接单的护航，否则这一组空转");

  const companions = companionStore().companions;
  for (const item of list.items) {
    assert.equal(
      isCompanionAcceptingOrders(companions.get(item.companionId)),
      true,
      `${item.companionId} 出现在「可以指定」的名单里，但资格谓词说不可以——两份口径分叉了`,
    );
  }

  const ids = list.items.map((item) => item.companionId);
  assert.equal(ids.includes(COMPANION_A), false, "当前正在履约这一单的那位不是「可以换的人」");
  assert.equal(ids.includes(COMPANION_PAUSED), false, "暂停接单的人不进名单");
  assert.equal(ids.includes(COMPANION_DISABLED_SEED), false, "已下架的人不进名单");
  assert.equal(
    ids.includes(COMPANION_BOUND),
    false,
    "下单用户本人不进名单：列一个点了必然失败的人，是界面的问题",
  );
  assert.deepEqual(
    Object.keys(list.items[0]).sort(),
    ["activeOrderCount", "avatarUrl", "companionId", "displayName"],
    "候选项只给客服需要的那几样：昵称、头像、在履约单数。联系方式 / 分账 / 内部主键都不给",
  );
  assert.equal(list.notice.length > 0, true, "名单必须带一句口径说明——「已筛过」这件事客服看不出来");
});

test("候选 2：在履约单数只算 accepted + serving——完成一单不会让他的数字变大", async () => {
  // 被观察的那一单：挂给 cp-1，它的候选名单是我们要看的东西
  const observed = await placeOrder();
  await acceptOrder(observed.id, COMPANION_A);

  async function countOf(companionId) {
    const list = await listStaffOrderReplaceCandidates(observed.id);
    const item = list.items.find((candidate) => candidate.companionId === companionId);
    assert.ok(item, `${companionId} 可接单，必须在名单里`);
    return item.activeOrderCount;
  }

  const baseline = await countOf(COMPANION_C);

  // 接一单 → 计数 +1
  const extra = await placeOrder();
  await acceptOrder(extra.id, COMPANION_C);
  const afterAccept = await countOf(COMPANION_C);
  assert.equal(afterAccept, baseline + 1, "接下一单必须算进他手上的活");

  // 把这一单做完 → 计数回到接单前
  await startCompanionOrderTransaction({
    companionId: COMPANION_C,
    orderId: extra.id,
    at: new Date().toISOString(),
  });
  await completeOrder(extra.id, COMPANION_C);
  assert.equal(paymentStore().orders.get(extra.id).actualCompanionId, COMPANION_C);

  const afterComplete = await countOf(COMPANION_C);
  assert.equal(
    afterComplete,
    afterAccept - 1,
    "已完成的订单是「谁做过」，不是「谁手上还有活」——把它算进去会让候选名单越长越偏",
  );
});

test("候选 3：这一单不该有换人动作时**报错**，而不是回一份空名单", async () => {
  const paid = await placeOrder();
  await assert.rejects(
    () => listStaffOrderReplaceCandidates(paid.id),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
    "空名单会让界面说「当前没有可指定的护航」，而真实原因是「这一单不该有换人按钮」——两者对客服要做的事完全不同",
  );

  await assert.rejects(
    () => listStaffOrderReplaceCandidates("ord-根本不存在"),
    (error) => error.status === 404 && error.message === STAFF_ORDER_NOT_FOUND_MESSAGE,
  );
});

test("候选 4：全部护航都暂停接单时名单为空，给的是「没有谁可以换」而不是「加载失败」", async () => {
  // ⚠️ 先把订单接走、**再**暂停：接单本身要过 `isCompanionAcceptingOrders`，
  // 顺序反过来的话连这一单都接不成，测的就不是候选名单了
  const order = await placeOrder();
  await acceptOrder(order.id, COMPANION_A);

  const companions = companionStore().companions;
  for (const companion of [...companions.values()]) {
    if (!isCompanionAcceptingOrders(companion)) continue;
    const result = await setCompanionFlags(
      companion.id,
      "pause",
      { unavailableReason: "测试用：暂时不接单" },
      adminCtx(),
    );
    assert.equal(result.kind, "ok", `${companion.id} 必须能暂停`);
  }

  // 暂停**不释放**：订单上仍挂着 cp-1，因此这一单仍然「有换人动作」，只是没人可换
  assert.equal(paymentStore().orders.get(order.id).actualCompanionId, COMPANION_A);

  const list = await listStaffOrderReplaceCandidates(order.id);
  assert.deepEqual(list.items, [], "全部暂停之后确实没有谁可以换");
  assert.equal(
    list.notice.length > 0,
    true,
    "空名单仍然要有一句说明：说「没有谁可以换」，不说「加载失败」",
  );
});

// ——————————————————— 四、可用性（available）与下架（enabled）方向相反 ———————————————————

test("可用性 1：把打手设为**暂停接单**不释放他手上的订单（EX-SERVICE-05）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_FREE);

  const result = await setCompanionFlags(
    COMPANION_FREE,
    "pause",
    { unavailableReason: "休息几天" },
    adminCtx(),
  );
  assert.equal(result.kind, "ok");

  const companion = companionStore().companions.get(COMPANION_FREE);
  assert.equal(companion.available, false);
  assert.equal(companion.enabled, true, "暂停接单不动 enabled：那两件事必须分开");

  const still = paymentStore().orders.get(order.id);
  assert.equal(still.status, "serving", "暂停接单**不影响**已经在做的单");
  assert.equal(still.actualCompanionId, COMPANION_FREE);
  assert.notEqual(still.servingAt, null, "servingAt 也不得被动过");
  assert.equal(dispatchOf(order.id).state, "accepted");
  assert.deepEqual(await releasesOf(order.id), [], "暂停接单不写退出历史");
  assert.deepEqual(
    await notificationsTitled(order.userId, DISPATCH_NOTIFICATION_COMPANION_DISABLED.title),
    [],
    "暂停接单不该通知下单用户——这一单没有任何变化",
  );

  // 但他从此不能接新单：这正是与「下架」分开的那半边
  assert.equal(isCompanionAcceptingOrders(companion), false);
});

test("可用性 2：把打手**下架**必须释放他手上全部 accepted/serving 的单，completed 不动", async () => {
  const serving = await placeOrder();
  await serveOrder(serving.id, COMPANION_FREE);
  const accepted = await placeOrder();
  await acceptOrder(accepted.id, COMPANION_FREE);

  // 一单已完成：它同样挂着 actualCompanionId，但那是历史，必须保留
  const done = await placeOrder();
  await serveOrder(done.id, COMPANION_FREE);
  await completeOrder(done.id, COMPANION_FREE);

  const ctx = adminCtx();
  const result = await setCompanionFlags(COMPANION_FREE, "disable", { unavailableReason: "" }, ctx);
  assert.equal(result.kind, "ok");

  const companion = companionStore().companions.get(COMPANION_FREE);
  assert.equal(companion.enabled, false);
  assert.equal(
    companion.available,
    false,
    "下架强制不可接单：一条「已停用但可接单」的记录在结算页解释不清",
  );

  for (const order of [serving, accepted]) {
    const updated = paymentStore().orders.get(order.id);
    assert.equal(updated.status, "paid", `${order.id} 必须回到 paid 等别人接`);
    assert.equal(updated.actualCompanionId, null);
    assert.equal(updated.servingAt, null);
    assert.equal(dispatchOf(order.id).state, "public", `${order.id} 的派单必须真的回到池子里`);

    const releases = await releasesOf(order.id);
    assert.equal(releases.length, 1, `${order.id} 必须留下一条退出历史`);
    assert.equal(releases[0].companionId, COMPANION_FREE);
    assert.equal(releases[0].source, "companion_disabled");
    assert.equal(releases[0].reason, COMPANION_RELEASE_REASON_DISABLED);
    assert.equal(releases[0].actorId, ctx.actorId, "触发者是发起这次下架的管理员");

    const notices = await notificationsTitled(
      order.userId,
      DISPATCH_NOTIFICATION_COMPANION_DISABLED.title,
    );
    assert.equal(notices.length, 1, `${order.id} 的下单用户必须收到通知（EX-COMP-01/02）`);
  }

  // 已完成的那一单：一个字节都不动
  const finished = paymentStore().orders.get(done.id);
  assert.equal(finished.status, "completed");
  assert.equal(
    finished.actualCompanionId,
    COMPANION_FREE,
    "历史必须保留：抹掉已完成订单的履约人，等于让「这一单是谁做的」永久消失",
  );
  assert.deepEqual(await releasesOf(done.id), []);
  assert.deepEqual(
    await notificationsTitled(done.userId, DISPATCH_NOTIFICATION_COMPANION_DISABLED.title),
    [],
    "已完成的那一单不该收到「重新匹配护航」",
  );
});

test("可用性 3：下架的通知不透露平台对这位打手做了什么", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_FREE);
  await setCompanionFlags(COMPANION_FREE, "disable", { unavailableReason: "" }, adminCtx());

  const notices = await notificationsTitled(
    order.userId,
    DISPATCH_NOTIFICATION_COMPANION_DISABLED.title,
  );
  assert.equal(notices.length, 1);
  const text = `${notices[0].title}${notices[0].summary}${notices[0].body}`;
  for (const forbidden of ["下架", "封禁", "停用", "处罚", "违规"]) {
    assert.equal(
      text.includes(forbidden),
      false,
      `通知不得出现「${forbidden}」：那是平台对打手的处置，与下单用户无关（原文：${text}）`,
    );
  }
});

test("可用性 4：某一单派单缺失 → 整次下架失败，标志位与退出历史**一笔都不写**", async () => {
  const first = await placeOrder();
  await serveOrder(first.id, COMPANION_FREE);
  const second = await placeOrder();
  await serveOrder(second.id, COMPANION_FREE);

  // 把第二单的派单索引与记录一起拆掉，制造一个不可能状态
  const brokenId = dispatchIdOf(second.id);
  dispatchStore().dispatchIdByOrder.delete(second.id);
  dispatchStore().dispatches.delete(brokenId);

  const before = companionStore().companions.get(COMPANION_FREE);
  const releaseCountBefore = companionReleaseStore().releases.size;

  const result = await setCompanionFlags(
    COMPANION_FREE,
    "disable",
    { unavailableReason: "" },
    adminCtx(),
  );
  assert.equal(
    result.kind,
    "inconsistent",
    "数据不自洽必须**整件事失败**：半途中止会留下「停用了、但有一单还挂着他」",
  );

  const after = companionStore().companions.get(COMPANION_FREE);
  assert.equal(after.enabled, before.enabled, "标志位不得被写：这一次下架没有成立");
  assert.equal(after.available, before.available);
  assert.equal(
    companionReleaseStore().releases.size,
    releaseCountBefore,
    "第一单也不得被解除——校验必须**全部先做完**再开始写",
  );
  assert.equal(paymentStore().orders.get(first.id).status, "serving", "第一单必须原样未动");
});

test("可用性 5：释放原语本身对「手上没有在履约的单」是空操作，不是错误", () => {
  const result = releaseOrdersForCompanion({
    companionId: COMPANION_FREE,
    actorId: "admin-1",
    reason: COMPANION_RELEASE_REASON_DISABLED,
    at: new Date().toISOString(),
  });
  assert.deepEqual(
    result,
    { kind: "ok", companionId: COMPANION_FREE, releasedOrderIds: [] },
    "一位从没接过单的护航被下架是正常情况：没有东西要释放，不是失败",
  );
});

test("可用性 6：某一单的 pending 索引与记录对不上 → 整次下架在**校验阶段**失败，第一单也不得被解除", async () => {
  const first = await placeOrder();
  await serveOrder(first.id, COMPANION_FREE);
  const second = await placeOrder();
  await serveOrder(second.id, COMPANION_FREE);

  // 制造「索引在、记录丢」：写入循环里**唯一**可能失败的那一件事。
  // ⚠️ 只有进程内直接改 store 才构造得出来（正常的提交 / 审核都在同一段同步代码里
  // 维护索引），但它正是「全量校验 → 全量写」这个形状要防的那一类失败
  completionStore().pendingSubmissionIdByOrder.set(second.id, "sub-根本不存在");

  const before = companionStore().companions.get(COMPANION_FREE);
  const releaseCountBefore = companionReleaseStore().releases.size;

  const result = await setCompanionFlags(
    COMPANION_FREE,
    "disable",
    { unavailableReason: "" },
    adminCtx(),
  );
  assert.equal(
    result.kind,
    "inconsistent",
    "作废会失败就必须**在校验阶段**报出来，而不是写到第二单才发现",
  );

  const after = companionStore().companions.get(COMPANION_FREE);
  assert.equal(after.enabled, before.enabled, "标志位不得被写：这一次下架没有成立");
  assert.equal(after.available, before.available);
  assert.equal(
    companionReleaseStore().releases.size,
    releaseCountBefore,
    "第一单也不得被解除——校验里漏掉作废这一步的话，这里会是 1",
  );
  assert.equal(paymentStore().orders.get(first.id).status, "serving", "第一单必须原样未动");
  assert.equal(paymentStore().orders.get(second.id).status, "serving");
});

// ——————————————————— 五、pending 完成材料作废 ———————————————————

test("作废 1：释放时该单 pending 的完成材料立即失效，且记录**保留**（只改状态）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(submitted.kind, "ok");

  await releaseStaffOrder(order.id, STAFF, { reason: "客户要求换人" });
  const release = (await releasesOf(order.id))[0];

  const submission = completionStore().submissions.get(submitted.submissionId);
  assert.ok(submission, "作废是**改状态**，不是删记录：历史必须留着");
  assert.equal(submission.status, "invalidated");
  assert.equal(submission.invalidatedAt, release.createdAt, "作废时刻就是这一次释放的时刻");
  assert.equal(submission.reviewSource, null, "作废不是一次审核结论：不得写成 staff 或 system");
  assert.equal(submission.reviewedByStaffId, null);
  assert.equal(submission.reviewedAt, null);
  assert.equal(submission.rejectReason, null);
});

test("作废 2：pending 索引必须一起清理——否则「这一单已有一份待审」会永远为真", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(completionStore().pendingSubmissionIdByOrder.get(order.id), submitted.submissionId);

  await releaseStaffOrder(order.id, STAFF, { reason: "换人" });

  assert.equal(
    completionStore().pendingSubmissionIdByOrder.has(order.id),
    false,
    "索引不清理的话，新打手接手后会撞上 `pending-exists`——而那份 pending 已经作废了",
  );
});

test("作废 3：invalidated 的材料既不可人工通过、也不可人工驳回", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });
  await releaseStaffOrder(order.id, STAFF, { reason: "换人" });

  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    at: new Date().toISOString(),
  });
  assert.equal(approved.kind, "invalid-status", "作废的材料不得再被通过");
  assert.equal(approved.status, "invalidated");

  const rejected = await rejectCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    rejectReason: "材料不全",
    at: new Date().toISOString(),
  });
  assert.equal(
    rejected.kind,
    "invalid-status",
    "作废的材料也不得被驳回：它不是「被拒绝」，是「这次提交不再属于这一单」",
  );

  assert.equal(completionStore().submissions.get(submitted.submissionId).status, "invalidated");
  assert.equal(
    paymentStore().orders.get(order.id).status,
    "paid",
    "订单不得因为有人试图审核一份作废材料而变成 completed",
  );
});

test("作废 4：自动通过**永远**不得通过一份作废材料（即使它的 deadline 早已过去）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    // 两小时前提交：deadline（快照 + 10 分钟）早已过去
    at: plusMinutes(new Date().toISOString(), -120),
  });
  assert.equal(submitted.kind, "ok");
  await releaseStaffOrder(order.id, STAFF, { reason: "换人" });

  const sweepAt = new Date().toISOString();
  assert.ok(
    Date.parse(submitted.autoApprovalDeadlineAt) < Date.parse(sweepAt),
    "前置条件：deadline 必须已经过去，否则这条用例测的是「还没到点」",
  );

  const swept = sweepCompletionAutoApprovals(sweepAt);
  assert.equal(
    swept.autoApprovedSubmissionIds.includes(submitted.submissionId),
    false,
    "作废的材料不得被自动通过：白名单只认 pending",
  );
  assert.equal(completionStore().submissions.get(submitted.submissionId).status, "invalidated");
  assert.equal(paymentStore().orders.get(order.id).status, "paid", "订单不得被推进成 completed");

  // 对照：同样一份材料留在 pending，它**会**被自动通过——
  // 证明上面那条不是因为清扫本身没工作
  const control = await placeOrder();
  await serveOrder(control.id, COMPANION_B);
  const controlSubmission = await submitCompletion({
    companionId: COMPANION_B,
    orderId: control.id,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(new Date().toISOString(), -120),
  });
  const secondSweep = sweepCompletionAutoApprovals(new Date().toISOString());
  assert.equal(
    secondSweep.autoApprovedSubmissionIds.includes(controlSubmission.submissionId),
    true,
    "对照失败：清扫本身必须有效，否则上面那条断言什么都没证明",
  );
  assert.equal(paymentStore().orders.get(control.id).status, "completed");
});

test("作废 5：新打手接手后可以提交**新的**完成材料，旧的那份仍然留在历史里", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const oldSubmission = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "第一位打手的说明",
    evidence: [],
    at: new Date().toISOString(),
  });

  await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  await startCompanionOrderTransaction({
    companionId: COMPANION_B,
    orderId: order.id,
    at: new Date().toISOString(),
  });

  const fresh = await submitCompletion({
    companionId: COMPANION_B,
    orderId: order.id,
    summary: "第二位打手的说明",
    evidence: [],
    at: new Date().toISOString(),
  });
  assert.equal(fresh.kind, "ok", "作废清掉了索引，新打手必须能重新提交");
  assert.notEqual(
    fresh.submissionId,
    oldSubmission.submissionId,
    "重新提交是**新建一条**，不覆盖旧审核历史",
  );

  assert.equal(completionStore().submissions.get(oldSubmission.submissionId).status, "invalidated");
  assert.equal(completionStore().submissions.get(fresh.submissionId).status, "pending");
  assert.equal(completionStore().pendingSubmissionIdByOrder.get(order.id), fresh.submissionId);

  // 旧的那份永远停在 invalidated：它不是「被驳回」，也没有理由再动
  assert.equal(
    canTransitionCompletion("invalidated", "approved"),
    false,
    "状态表里 invalidated 是终态——这一条是上面所有作废断言的根",
  );
});

test("作废 6：数据不自洽时释放与换人都报 500，且一笔都没写（对外契约的那一格）", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const snapshot = await snapshotOf(order);

  // 「索引在、记录丢」：作废那一步会失败，而它是原子区段的第一件
  completionStore().pendingSubmissionIdByOrder.set(order.id, "sub-根本不存在");

  await assert.rejects(
    () => releaseStaffOrder(order.id, STAFF, { reason: "换人" }),
    (error) =>
      error.status === 500 &&
      error.message === ORDER_DATA_INCONSISTENT_MESSAGE &&
      error.code === "SERVER_ERROR",
    "不可能状态必须报 500 并给一句「请联系技术支持」，而不是 400 那几句「别点了」",
  );
  await assertNothingWritten(order.id, snapshot);

  await assert.rejects(
    () => replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B }),
    (error) => error.status === 500 && error.message === ORDER_DATA_INCONSISTENT_MESSAGE,
  );
  await assertNothingWritten(order.id, snapshot);
});

// ——————————————————— 六、多次换人 ———————————————————

test("多次换人：A→B→C→回池→再接，每一位都留下自己的退出历史，且不设次数上限", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);

  // A（serving）→ B（accepted）
  const first = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  assert.equal(first.previousCompanionId, COMPANION_A);
  assert.equal(first.newCompanionId, COMPANION_B);
  assert.equal(paymentStore().orders.get(order.id).status, "accepted");

  // B 自己开始服务，再被换给 C
  await startCompanionOrderTransaction({
    companionId: COMPANION_B,
    orderId: order.id,
    at: new Date().toISOString(),
  });
  const second = await replaceStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_C });
  assert.equal(second.previousCompanionId, COMPANION_B);
  assert.equal(second.newCompanionId, COMPANION_C);
  assert.equal(paymentStore().orders.get(order.id).status, "accepted", "每一次换人都回到 accepted");

  // 第三位：回公共池（这次没有人接替）
  const pool = await releaseStaffOrder(order.id, STAFF, { reason: "第三位也联系不上" });
  assert.equal(pool.status, "paid");
  assert.equal(dispatchOf(order.id).state, "public");

  // 回池之后，之前被换掉的 A 可以重新接——先到先得只约束「此刻」可接单的人
  const accepted = await acceptDispatch(dispatchIdOf(order.id), {
    companionId: COMPANION_A,
    at: new Date().toISOString(),
  });
  assert.equal(accepted.kind, "ok", "回池之后任何此刻可接单的人都能接");
  assert.equal(paymentStore().orders.get(order.id).actualCompanionId, COMPANION_A);
  assert.equal(paymentStore().orders.get(order.id).status, "accepted");

  const releases = await releasesOf(order.id);
  assert.equal(releases.length, 3, "A、B、C 各一条——换人不设次数上限，每一次都要留痕");
  assert.deepEqual(
    releases.map((item) => item.companionId).sort(),
    [COMPANION_A, COMPANION_B, COMPANION_C].sort(),
    "三次退出各记一次**被换掉**的那位，一位都不能漏",
  );
  assert.deepEqual(
    releases.map((item) => item.source),
    ["staff_reassign", "staff_reassign", "staff_reassign"],
    "三次都是客服换人（最后一次是回池，但来源与直换共用同一个值，见 02-decisions）",
  );
  // ⚠️ 这里**不**断言 companionId 的三元顺序：三次释放可能落在同一毫秒里，
  // 而仓储对同一时刻的两条按 id 兜底排序（那正是它注释里写的「保证顺序稳定」）。
  // 拿同一个毫秒内的先后当业务事实，测的是一串随机 uuid 的字典序。
  for (let i = 1; i < releases.length; i += 1) {
    assert.ok(releases[i - 1].createdAt <= releases[i].createdAt, "退出历史必须按时间正序");
  }
});

// ——————————————————— 七、`allowedActions` 判据 ———————————————————

test("判据 1：allowedActions 的真值表——含「状态说有人在履约、字段却是空」这一格", () => {
  const cases = [
    { status: "paid", actualCompanionId: null, expect: false },
    { status: "accepted", actualCompanionId: COMPANION_A, expect: true },
    { status: "serving", actualCompanionId: COMPANION_A, expect: true },
    { status: "completed", actualCompanionId: COMPANION_A, expect: false },
    { status: "refunded", actualCompanionId: null, expect: false },
    // 「状态说有人在履约、字段却是空」：必须**不**给按钮，
    // 否则客服点下去拿到的是 500（数据不自洽），而不是 400（这个按钮不该出现）
    { status: "accepted", actualCompanionId: null, expect: false },
    { status: "serving", actualCompanionId: null, expect: false },
  ];

  for (const item of cases) {
    assert.deepEqual(
      staffOrderAllowedActions(item),
      { canRelease: item.expect, canReplace: item.expect },
      `status=${item.status} / actualCompanionId=${item.actualCompanionId} 的判据不对`,
    );
  }
});

test("判据 2：界面不给按钮时接口也拒绝，给按钮时接口也接受——两边同一条判据", async () => {
  const order = await placeOrder();
  assert.equal(
    staffOrderAllowedActions(paymentStore().orders.get(order.id)).canRelease,
    false,
    "paid 时不给按钮",
  );
  await assert.rejects(
    () => releaseStaffOrder(order.id, STAFF, { reason: "试试" }),
    (error) => error.status === 400,
    "界面不给按钮 + 接口也拒绝",
  );

  await serveOrder(order.id, COMPANION_A);
  assert.equal(staffOrderAllowedActions(paymentStore().orders.get(order.id)).canRelease, true);
  const ok = await releaseStaffOrder(order.id, STAFF, { reason: "确实要换" });
  assert.equal(ok.changed, true, "界面给按钮 + 接口也接受");
});

test("判据 3：详情接口发出来的 allowedActions 就是服务端算的那份，不是前端推断", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);

  const detail = await getStaffOrderDetail(order.id, new URLSearchParams(), "server");
  assert.ok(detail);
  assert.deepEqual(
    detail.allowedActions,
    staffOrderAllowedActions(paymentStore().orders.get(order.id)),
    "详情 DTO 上那份必须与判据函数逐字相同——两处各算一遍就会在某个状态上分叉",
  );
  assert.deepEqual(detail.allowedActions, { canRelease: true, canReplace: true });
});

// ——————————————————— 八、既有能力不回归 ———————————————————

test("回归 1：打手主动取消（P0-6）仍然按幂等键工作，没被这次重构改坏", async () => {
  const order = await placeOrder();
  await acceptOrder(order.id, COMPANION_A);
  const key = unique("cancel");

  const first = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason: "临时有事",
    idempotencyKey: key,
    at: new Date().toISOString(),
  });
  assert.equal(first.kind, "ok");

  const second = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: order.id,
    reason: "临时有事",
    idempotencyKey: key,
    at: new Date().toISOString(),
  });
  assert.equal(second.kind, "replayed", "同一个键再来一次是重放");
  assert.equal((await releasesOf(order.id)).length, 1, "重放不得写第二条退出历史");

  const release = (await releasesOf(order.id))[0];
  assert.equal(release.source, "companion_cancel", "主动取消的来源不得被串成 staff_reassign");
  assert.equal(release.actorId, COMPANION_A);
  assert.equal(release.reason, "临时有事");
});

test("回归 2：正常的人工审核（P0-8）仍然能把订单推进到 completed，且不写退出历史", async () => {
  const order = await placeOrder();
  await serveOrder(order.id, COMPANION_A);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: new Date().toISOString(),
  });

  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.displayName,
    at: new Date().toISOString(),
  });
  assert.equal(approved.kind, "ok");
  assert.equal(completionStore().submissions.get(submitted.submissionId).status, "approved");
  assert.equal(completionStore().submissions.get(submitted.submissionId).reviewSource, "staff");
  assert.equal(paymentStore().orders.get(order.id).status, "completed");
  assert.deepEqual(await releasesOf(order.id), [], "正常完成不该写退出历史");
});

// ——————————————————— 九、结构门禁 ———————————————————

test("门禁 1：整个履约事务文件里**没有一个 `await`**——那是它的原子性依据", () => {
  const source = stripComments(
    readSource(path.join(ROOT, "lib", "data", "companionOrderTransaction.ts")),
  );
  assert.equal(
    /\bawait\b/.test(source),
    false,
    "本文件靠「读—判断—写之间不让出执行权」保证原子性。加一个 await（哪怕 await Promise.resolve()）就会出现「订单说等待接单、派单说被 A 接了」的中间态",
  );
  assert.equal(
    /export async function releaseOrdersForCompanion/.test(source),
    false,
    "封禁回池必须写成**同步**函数：写成 async 后正确性就依赖「调用方记得不要 await」这条口头约定",
  );
  assert.equal(
    /export function releaseOrdersForCompanion/.test(source),
    true,
    "同步入口必须存在——否则上面那条断言只是把一个函数删掉了而已",
  );
});

test("门禁 2：释放原语只有一份定义，三条释放路径共用它", () => {
  const source = stripComments(
    readSource(path.join(ROOT, "lib", "data", "companionOrderTransaction.ts")),
  );

  assert.equal(
    [...source.matchAll(/function releaseCurrentAssignment\(/g)].length,
    1,
    "释放原语只能有一份定义：各写一份就会出现三套「五件事」",
  );
  assert.equal(
    [...source.matchAll(/releaseCurrentAssignment\(\{/g)].length,
    4,
    "调用点应当是四个：打手主动取消 / 客服退回公共池 / 客服直换 / 封禁回池（回池与直换共用写入器）",
  );
});

test("门禁 3：客服三个新地址都在，且都先 `requireStaff()` 再读请求体", () => {
  const dir = path.join(ROOT, "app", "api", "staff", "orders", "[id]");
  const found = collectFiles(dir)
    .filter((file) => file.endsWith("route.ts"))
    .map((file) => path.relative(dir, file).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(found, [
    "release/route.ts",
    "replace-candidates/route.ts",
    "replace/route.ts",
    "route.ts",
  ]);

  // 去掉 import 才判「谁是第一个动作」：`import { readJsonBody }` 出现在文件开头，
  // 但它只是一个名字，与「什么时候解析请求体」毫无关系
  for (const relative of [
    ["release", "route.ts"],
    ["replace", "route.ts"],
    ["replace-candidates", "route.ts"],
  ]) {
    const source = withoutImports(stripComments(readSource(path.join(dir, ...relative))));
    const guard = source.indexOf("requireStaff");
    assert.notEqual(guard, -1, `${relative.join("/")} 缺少客服身份守卫`);

    const readsBody = source.indexOf("readJsonBody");
    if (readsBody !== -1) {
      assert.ok(
        guard < readsBody,
        `${relative.join("/")} 的守卫必须是第一个动作：解析请求体不得发生在鉴权之前`,
      );
    }
    assert.ok(
      source.includes("force-dynamic"),
      `${relative.join("/")} 必须显式声明 force-dynamic：这些接口读的是会变的订单状态`,
    );
  }
});

test("门禁 4：释放路径不得触碰金额——不写退款、不改订单金额、不动打手收益", () => {
  for (const relative of [
    ["lib", "data", "companionOrderTransaction.ts"],
    ["lib", "services", "staffOrderActions.ts"],
  ]) {
    const source = stripComments(readSource(path.join(ROOT, ...relative)));
    for (const forbidden of [
      "refundRepository",
      "RefundRepository",
      "earningRepository",
      "EarningRepository",
      "applyOrderRefunded",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${relative.join("/")} 出现了 ${forbidden}：换人 / 回池不产生任何资金事件`,
      );
    }
  }
});

// ——————————————————— 十、HTTP 契约（需要真实服务） ———————————————————

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过客服端订单处置的 HTTP 用例";

/** 一个不可能存在的订单 id：三个接口在「身份合法但订单不存在」时的表现要一致。 */
const MISSING_ORDER = "ord-does-not-exist";

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

test("HTTP 身份矩阵：三个处置地址对非客服身份一律 401，护航 / 停用 / 已移除 403", { skip: SKIP_HTTP }, async () => {
  // ⚠️ 每个地址要**按自己真实的方法**请求。三个地址不是同一个方法：
  // 两个写入是 POST，候选名单是 GET。
  // 方法用错时 Next 在进入路由处理器**之前**就回 405——那是框架行为，
  // 与这里要验的「身份门」无关，混在一起会把 405 读成 401 的失败。
  // 方法本身另有断言（见本文件最下面那一条）。
  const endpoints = [
    { path: `/api/staff/orders/${MISSING_ORDER}/release`, method: "POST" },
    { path: `/api/staff/orders/${MISSING_ORDER}/replace`, method: "POST" },
    { path: `/api/staff/orders/${MISSING_ORDER}/replace-candidates`, method: "GET" },
  ];
  const asAnon = (endpoint, cookie) =>
    requestWithCookie(endpoint.path, cookie, { method: endpoint.method });

  for (const endpoint of endpoints) {
    assert.equal((await asAnon(endpoint, null)).status, 401, `${endpoint.path} 匿名应为 401`);
    assert.equal(
      (await asAnon(endpoint, "mock_user_id=u-1001")).status,
      401,
      `${endpoint.path} 用户端 Cookie 不得进入处置接口`,
    );
    assert.equal(
      (await asAnon(endpoint, "mock_admin_id=admin-1")).status,
      401,
      `${endpoint.path} 管理端 Cookie 不得进入客服处置接口：两者是两套身份`,
    );
    for (const forged of ["mock_staff_id=u-1001", "mock_staff_id=admin-1", "mock_staff_id=staff-999"]) {
      assert.equal((await asAnon(endpoint, forged)).status, 401, `${forged} 不该通过`);
    }
  }

  const login = await staffLogin("staff-1");
  if (login.status !== 200) {
    // 开关关闭：连真实客服 id 的伪造 Cookie 也进不来
    assert.equal(login.status, 404);
    for (const endpoint of endpoints) {
      assert.equal((await asAnon(endpoint, "mock_staff_id=staff-1")).status, 401);
    }
    return;
  }

  // staff-3 已停用 / staff-4 角色是护航 / staff-5 已停用且已移除：
  // 记录查得到，但都进不了客服工作台
  for (const id of ["staff-3", "staff-4", "staff-5"]) {
    for (const endpoint of endpoints) {
      assert.equal(
        (await asAnon(endpoint, `mock_staff_id=${id}`)).status,
        403,
        `${endpoint.path} 的 ${id} 应 403`,
      );
    }
  }
});


test("HTTP 404 与 400：不存在的订单 404；缺原因 / 缺人一律 400", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const cookie = login.setCookie[0].split(";")[0];

  const missing = await requestWithCookie(`/api/staff/orders/${MISSING_ORDER}/release`, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "换人" }),
  });
  assert.equal(missing.status, 404, "订单不存在必须是 404");
  assert.deepEqual(JSON.parse(missing.body), {
    error: { code: "NOT_FOUND", message: STAFF_ORDER_NOT_FOUND_MESSAGE },
  });

  // 原因必填必须在**读订单之前**判定：否则一次缺参数的请求会变成 404，
  // 而这个订单可能其实是存在的
  const noReason = await requestWithCookie(`/api/staff/orders/${MISSING_ORDER}/release`, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noReason.status, 400, "缺原因必须是 400，不是 404");

  const noCompanion = await requestWithCookie(`/api/staff/orders/${MISSING_ORDER}/replace`, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(noCompanion.status, 400, "缺 companionId 必须是 400");

  const candidates = await requestWithCookie(
    `/api/staff/orders/${MISSING_ORDER}/replace-candidates`,
    cookie,
  );
  assert.equal(candidates.status, 404, "候选名单对不存在的订单同样是 404，不是空名单");
  assert.deepEqual(JSON.parse(candidates.body), {
    error: { code: "NOT_FOUND", message: STAFF_ORDER_NOT_FOUND_MESSAGE },
  });
});

test("HTTP 405：每个处置地址只认自己那一个方法，别的一律 405（且 405 发生在身份门之前）", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  const cookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  // ⚠️ 「405 发生在身份门之前」是这一条的**前提**，也必须写下来，
  // 否则下一个人会在上一条（身份矩阵）里看到 405 并读成「没鉴权就放行了」：
  // 方法用错时 Next 在进入路由处理器**之前**就回 405，连 `requireStaff()` 都没走到。
  // 上一条之所以要「按真实方法请求」，就是因为这个。
  //
  // 也正因为 405 在门之前，这条边界必须有人守：哪天 `/release` 顺手加一个 GET
  // （比如「先预览再退回」），那条 GET 会**绕过上一条里所有的 401 / 403 断言**
  // 成为新的匿名入口——所以下面按「地址 × 方法」逐格点名，而不是只抽查两个。
  const allowed = [
    { path: `/api/staff/orders/${MISSING_ORDER}/release`, method: "POST", why: "释放只有 POST：给一个会改状态的地址开放 GET，等于给爬虫与预取留了一个写入口" },
    { path: `/api/staff/orders/${MISSING_ORDER}/replace`, method: "POST", why: "换人只有 POST" },
    { path: `/api/staff/orders/${MISSING_ORDER}/replace-candidates`, method: "GET", why: "候选名单是只读的：多一个 POST 就多了一个没被设计过的写入口" },
  ];
  const allMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  for (const endpoint of allowed) {
    for (const method of allMethods) {
      if (method === endpoint.method) continue;
      assert.equal(
        (await requestWithCookie(endpoint.path, cookie, { method })).status,
        405,
        `${method} ${endpoint.path} 应 405——${endpoint.why}`,
      );
    }
  }
});

test("HTTP 500 文案：数据不自洽时给的是「请联系技术支持」，不复用 400 那几句", { skip: SKIP_HTTP }, async () => {
  // 这一条只验文案：要真的造出「订单有履约人、派单记录丢了」的**线上**状态需要进程外的
  // 存储操作。行为本身已经被服务层的「可用性 4」覆盖（那里断言了整件事失败且一笔没写）。
  assert.equal(
    ORDER_DATA_INCONSISTENT_MESSAGE.length > 0,
    true,
    "数据不自洽必须有一句面向使用者的说明，而不是一个栈",
  );
  for (const message of [
    STAFF_ORDER_NOT_RELEASABLE_MESSAGE,
    STAFF_ORDER_NOT_REPLACEABLE_MESSAGE,
    STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
  ]) {
    assert.notEqual(
      ORDER_DATA_INCONSISTENT_MESSAGE,
      message,
      "500 不能复用 400 的文案：两者要客服做的事完全不同（一个是重试或找技术，一个是别点了）",
    );
  }
});

// ——————————————————— 十一、HTTP 正例（200）：三个地址的「正常结果」那一格 ———————————————————

/**
 * ## 为什么必须有这一组
 *
 * 上面那几条 HTTP 用例只覆盖了 401 / 403 / 404 / 400 / 405 / 500——**没有一条**
 * 「客服带着合法请求打过去 → 200，而且订单真的变了」。
 * 《用户权限表》§十三 第 8 条要求每个受保护接口的权限矩阵覆盖
 * **401 / 403 / 404 / 正常结果**四条，缺的就是最后那条。
 *
 * 缺了它会怎样：把 `release/route.ts` 里的 service 调用改错（例如先读请求体再鉴权、
 * 传错参数、`await context.params` 丢掉），**现有的断言一条都不会红**——
 * 因为现有的每一条都只看失败路径。这条正例同时钉住「路由真的接通了 service」
 * 与「service 的返回值真的被 `ok()` 包起来了」。
 *
 * ## ⚠️ 这一组**不是只读**的：它会在真实服务上从零造订单
 *
 * 与 `tests/companionPoolOrder.test.mjs` 同一做法：
 * `POST /api/orders/pay` → `POST /api/payments/mock-confirm` 造一张单，
 * 再让一位真打手通过 `POST /api/companion/dispatches/[id]/accept` 把它接走。
 * **不碰任何预置订单**（预置单被改掉之后，其它用例文件与服务上的手工验收都会看到
 * 一个别人改过的世界），因此这一组可以反复跑。
 *
 * ⚠️ 三件事必须同时成立才跑，否则**如实跳过**：`APP_BASE_URL` 已设置、
 * 服务端开着用户端 Mock 登录、能拿到客服会话（`ENABLE_MOCK_STAFF`）。
 */

const HTTP_ORDER_USER = "u-1001";
/** 一启动就已经是有效打手的那位（`lib/constants/mockUsers.ts`），不必先走审核。 */
const HTTP_COMPANION_USER = "u-1022";

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

/** 发一次请求并把 JSON 解开。失败响应也解——错误体的形状本身是要断言的东西。 */
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
  const text = await response.text();
  return { status: response.status, raw: text, json: text ? JSON.parse(text) : null };
}

let httpSessionsPromise = null;
/** 三套会话（老板 / 打手 / 客服）各拿一次，整组共用。拿不到就返回 null。 */
function httpSessions() {
  httpSessionsPromise ??= (async () => {
    const order = await loginAs(HTTP_ORDER_USER);
    const companion = await loginAs(HTTP_COMPANION_USER);
    const staff = await staffLogin("staff-1");
    if (!order || !companion || staff.status !== 200) return null;
    return { order, companion, staff: staff.setCookie[0].split(";")[0] };
  })();
  return httpSessionsPromise;
}

/** 走完整链路造一张「已被打手接单」的订单，返回订单 id。全程 HTTP，不碰预置数据。 */
async function placeAcceptedOrderOverHttp(sessions) {
  const pay = await send("/api/orders/pay", {
    cookie: sessions.order,
    method: "POST",
    body: {
      idempotencyKey: unique("http-key"),
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
    },
  });
  assert.equal(pay.status, 200, `HTTP 下单必须成功：${pay.raw}`);
  const paymentRequestId = pay.json.data.id;

  const confirm = await send("/api/payments/mock-confirm", {
    cookie: sessions.order,
    method: "POST",
    body: { paymentRequestId, result: "success" },
  });
  assert.equal(
    confirm.status,
    200,
    `HTTP 支付确认必须成功（需要服务端开着 ENABLE_MOCK_PAYMENT）：${confirm.raw}`,
  );
  const orderId = confirm.json.data.orderId;
  assert.ok(orderId, "支付成功后必须拿到 orderId");

  const pool = await send("/api/companion/dispatches", { cookie: sessions.companion });
  assert.equal(pool.status, 200, `打手会话必须能读到订单池：${pool.raw}`);
  const item = [...pool.json.data.exclusive, ...pool.json.data.public].find(
    (each) => each.orderId === orderId,
  );
  assert.ok(item, `刚支付成功的单必须出现在 ${HTTP_COMPANION_USER} 的池子里，否则这一组空转`);

  const accept = await send(`/api/companion/dispatches/${item.dispatchId}/accept`, {
    cookie: sessions.companion,
    method: "POST",
  });
  assert.equal(accept.status, 200, `接单必须成功：${accept.raw}`);
  return orderId;
}

test("HTTP 正例（回池）：客服带原因打过去真的把订单退回公共池——不是只回一个 200", { skip: SKIP_HTTP }, async () => {
  const sessions = await httpSessions();
  if (!sessions) return; // 服务端没开 Mock 登录：与其它几条一样，如实不跑

  const orderId = await placeAcceptedOrderOverHttp(sessions);

  // 处置之前：服务端算出来的判据说这一单两个动作都能做
  const before = await send(`/api/staff/orders/${orderId}`, { cookie: sessions.staff });
  assert.equal(before.status, 200, `客服详情必须能读到这一单：${before.raw}`);
  assert.deepEqual(
    before.json.data.allowedActions,
    { canRelease: true, canReplace: true },
    "刚被接单的单必须给出两个处置动作",
  );

  const candidates = await send(`/api/staff/orders/${orderId}/replace-candidates`, {
    cookie: sessions.staff,
  });
  assert.equal(candidates.status, 200, `候选名单必须能读到：${candidates.raw}`);
  assert.ok(candidates.json.data.items.length > 0, "名单里必须有可指定的护航，否则这一条空转");

  const reason = "验收用：原护航联系不上";
  const released = await send(`/api/staff/orders/${orderId}/release`, {
    cookie: sessions.staff,
    method: "POST",
    body: { reason },
  });
  assert.equal(released.status, 200, `回池必须成功：${released.raw}`);
  assert.equal(released.json.data.status, "paid");
  assert.equal(released.json.data.orderId, orderId);
  assert.equal(released.json.data.changed, true);
  assert.ok(released.json.data.releaseRecordId, "必须给出退出历史 id");
  assert.ok(released.json.data.releasedAt, "必须给出这一次释放的时刻");

  // ⚠️ 200 本身什么都证明不了。用**服务端自己的两个只读接口**回读一次：
  // 这条路不经过我刚写的那两个写入接口，因此「真的改了」是被独立证据证明的
  const after = await send(`/api/staff/orders/${orderId}`, { cookie: sessions.staff });
  assert.equal(after.status, 200);
  assert.deepEqual(
    after.json.data.allowedActions,
    { canRelease: false, canReplace: false },
    "回到 paid 之后这一单不该再有处置动作——判据是服务端从订单现算的",
  );

  const candidatesAfter = await send(`/api/staff/orders/${orderId}/replace-candidates`, {
    cookie: sessions.staff,
  });
  assert.equal(
    candidatesAfter.status,
    400,
    "回到 paid 之后候选名单必须报「这一单不该有换人按钮」，而不是回一份空名单",
  );
});

test("HTTP 正例（换人）：客服指定新护航真的换成了他——新旧两人在候选名单里此消彼长", { skip: SKIP_HTTP }, async () => {
  const sessions = await httpSessions();
  if (!sessions) return;

  const orderId = await placeAcceptedOrderOverHttp(sessions);

  const candidates = await send(`/api/staff/orders/${orderId}/replace-candidates`, {
    cookie: sessions.staff,
  });
  assert.equal(candidates.status, 200, `候选名单必须能读到：${candidates.raw}`);
  const target = candidates.json.data.items[0];
  assert.ok(target, "预置名单里必须有可接单的护航，否则这一条空转");

  const replaced = await send(`/api/staff/orders/${orderId}/replace`, {
    cookie: sessions.staff,
    method: "POST",
    body: { companionId: target.companionId },
  });
  assert.equal(replaced.status, 200, `换人必须成功：${replaced.raw}`);
  assert.equal(replaced.json.data.orderId, orderId);
  assert.equal(replaced.json.data.status, "accepted", "新护航拿到的与他自己点接单一样：accepted");
  assert.equal(replaced.json.data.newCompanionId, target.companionId);
  assert.equal(replaced.json.data.changed, true);
  assert.ok(replaced.json.data.orderNo, "接口必须回单号：客服要向用户报的就是它");
  const previous = replaced.json.data.previousCompanionId;
  assert.ok(previous, "必须告诉客服「换掉的是谁」");
  assert.notEqual(previous, target.companionId);

  // 回读：新接手的从「可指定」里消失，被换掉的那位重新变成「可指定」
  const after = await send(`/api/staff/orders/${orderId}/replace-candidates`, {
    cookie: sessions.staff,
  });
  assert.equal(after.status, 200, "换人之后这一单仍在 accepted，仍然有处置动作");
  const ids = after.json.data.items.map((item) => item.companionId);
  assert.equal(
    ids.includes(target.companionId),
    false,
    "新接手的这位正在履约这一单，不该再出现在「可以指定」的名单里",
  );
  assert.equal(
    ids.includes(previous),
    true,
    "被换掉的那位已经空闲且仍可接单，应当重新回到名单里——这一格证明订单真的换了人",
  );
});

/*
 * ⚠️ 这里**刻意没有**「支付通道关着就跳过」的探测：`/api/payments/mock-confirm`
 * 在关着与「这个支付请求不存在」两种情况下**都是 404**（前者是路由第一行的
 * `模拟支付未启用`，后者是 `支付请求不存在`），只看状态码分不开。
 * 早期版本按 `probe.status === 404` 提前 `return`，结果是**两条正例全都空转**
 * ——测试绿着，却一行断言都没执行（受控 mutation 才把它暴露出来）。
 * 因此这里直接走真链路：支付开关关着就让它在断言上炸出声，而不是静默通过。
 */
