import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { isCompanionAcceptingOrders } from "../lib/constants/companions.ts";
import {
  DISPATCH_NOTIFICATION_ACCEPTED,
  DISPATCH_NOTIFICATION_STAFF_ASSIGNED,
  ORDER_DATA_INCONSISTENT_MESSAGE,
} from "../lib/constants/dispatch.ts";
import {
  STAFF_ORDER_ASSIGN_EXPIRED_MESSAGE,
  STAFF_ORDER_ASSIGN_NOT_ELIGIBLE_MESSAGE,
  STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
  STAFF_ORDER_NOT_ASSIGNABLE_MESSAGE,
  STAFF_ORDER_NOT_FOUND_MESSAGE,
  STAFF_ORDER_SELF_ORDER_MESSAGE,
  STAFF_ORDER_ASSIGN_EXCLUSIVE_NOTICE,
} from "../lib/constants/staff.ts";
import { companionStore } from "../lib/data/mockCompanionRepository.ts";
import { companionAcceptStore } from "../lib/data/mockCompanionAcceptRepository.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  assignStaffOrderCompanion,
  listStaffOrderAssignCandidates,
} from "../lib/services/staffOrderActions.ts";

/**
 * PROD-4「客服给还没有人接的订单指派护航」。
 *
 * ## 这一批守住的四件事
 *
 * 1. **指派不绕过派单规则**：专属期内只能指派用户指定的那位；公共池只能指派给
 *    此刻可接单、且不是下单用户本人的护航。
 * 2. **状态判据是唯一幂等判据**：第二次点击 → 400，且**一笔不写**。
 * 3. **订单进入 accepted ≠ 产生接单事件**：派单写 `acceptedVia: "staff"`，
 *    `companion_accept_events` 不增加——指派不计入接单榜。
 * 4. **审计与业务写入同生共死**：每次成功指派恰好一条 `order.assign`，
 *    写明操作者来自客服会话、操作前后状态与护航。
 *
 * Mock 伪事务的原子性来自「区段内无 `await`」，因此这里的断言都在同一进程内完成；
 * 真事务那一层由 `tests/pgW1Transactions.test.mjs` 的 T-ASSIGN 打真库验证。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 可接单 + 未移除，但挂着预置在履约单：只用于按单收窄的用例。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";
/** `available: false`（暂停接单）：不能接单，也不能被指派。 */
const COMPANION_PAUSED = "cp-4";
/** 唯一的 `enabled: false`（已下架）。 */
const COMPANION_DISABLED = "cp-7";
/** 绑 `userId: "u-1022"` 的那位，用于禁止自接单。 */
const COMPANION_BOUND = "cp-10";
const BOUND_USER = "u-1022";

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
  return `${prefix}-assign-${process.pid}-${seq}`;
}

beforeEach(() => {
  for (const store of [
    "payment",
    "dispatch",
    "completion",
    "companionRelease",
    "notification",
    "companion",
    "platformConfig",
    "earning",
    "adminAudit",
    "companionAccept",
  ]) {
    resetMockStore(store);
  }
});

/**
 * 造一张 `paid` 订单。`companionId=null` → 公共池；给了人 → 专属池。
 *
 * ⚠️ 下单用户默认是本用例的新合成 id，收件箱因此可以从空开始计数。
 */
async function placeOrder({ userId, companionId = null } = {}) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId,
      idempotencyKey: unique("key"),
    },
    userId ?? unique("u"),
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", created.request.userId);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
  return confirmed.order;
}

function dispatchRecordOf(orderId) {
  const id = dispatchStore().dispatchIdByOrder.get(orderId);
  assert.ok(id, `订单 ${orderId} 必须有派单记录`);
  const record = dispatchStore().dispatches.get(id);
  assert.ok(record, `订单 ${orderId} 的派单记录必须还在 store 里`);
  return record;
}

async function noticesOf(userId, title) {
  const all = await getNotificationRepository().listNotifications(userId);
  return all.filter((item) => item.title === title);
}

function auditsOf(orderId) {
  return [...adminAuditStore().audits.values()].filter(
    (entry) => entry.targetType === "order" && entry.targetId === orderId,
  );
}

function acceptEventsOf(orderId) {
  return [...companionAcceptStore().events.values()].filter((event) => event.orderId === orderId);
}

/** 一次失败调用前后的完整业务快照。 */
async function snapshotOf(order) {
  return {
    order: { ...paymentStore().orders.get(order.id) },
    dispatch: { ...dispatchRecordOf(order.id) },
    auditIds: auditsOf(order.id).map((entry) => entry.id),
    noticeIds: (await getNotificationRepository().listNotifications(order.userId)).map(
      (item) => item.id,
    ),
    acceptEventIds: acceptEventsOf(order.id).map((event) => event.id),
  };
}

async function assertNothingWritten(order, snapshot) {
  assert.deepEqual({ ...paymentStore().orders.get(order.id) }, snapshot.order, "订单不得被改动");
  assert.deepEqual({ ...dispatchRecordOf(order.id) }, snapshot.dispatch, "派单不得被改动");
  assert.deepEqual(
    auditsOf(order.id).map((entry) => entry.id),
    snapshot.auditIds,
    "失败的指派不得写审计",
  );
  assert.deepEqual(
    (await getNotificationRepository().listNotifications(order.userId)).map((item) => item.id),
    snapshot.noticeIds,
    "失败的指派不得发通知",
  );
  assert.deepEqual(
    acceptEventsOf(order.id).map((event) => event.id),
    snapshot.acceptEventIds,
    "任何路径都不得凭空写接单事件",
  );
}

// ——————————————————— 一、成功路径 ———————————————————

test("指派 1：公共池订单指派成功——订单 / 派单 / 通知 / 审计同时成立，且不写接单事件", async () => {
  const order = await placeOrder();
  const before = { ...paymentStore().orders.get(order.id) };
  const dispatchBefore = { ...dispatchRecordOf(order.id) };
  assert.equal(before.status, "paid");
  assert.equal(dispatchBefore.state, "public");

  const result = await assignStaffOrderCompanion(order.id, STAFF, {
    companionId: COMPANION_A,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.statusLabel, "已接单");
  assert.equal(result.companionId, COMPANION_A);
  assert.equal(result.changed, true);

  const after = paymentStore().orders.get(order.id);
  assert.equal(after.status, "accepted");
  assert.equal(after.actualCompanionId, COMPANION_A);
  assert.equal(after.acceptedAt, result.assignedAt);
  assert.equal(after.everAcceptedAt, result.assignedAt, "第一次被承接要写下来");
  assert.equal(after.companion?.id, COMPANION_A, "订单上的护航快照必须一起写入");

  const dispatch = dispatchRecordOf(order.id);
  assert.equal(dispatch.state, "accepted");
  assert.equal(dispatch.acceptedByCompanionId, COMPANION_A);
  assert.equal(dispatch.acceptedAt, result.assignedAt);
  assert.equal(dispatch.acceptedVia, "staff", "指派不是护航主动接单");

  assert.equal(
    acceptEventsOf(order.id).length,
    0,
    "订单进入 accepted ≠ 产生接单事件：指派不计入接单榜",
  );

  const notices = await noticesOf(order.userId, DISPATCH_NOTIFICATION_STAFF_ASSIGNED.title);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].href, `/orders/${order.id}`);
  assert.equal(
    (await noticesOf(order.userId, DISPATCH_NOTIFICATION_ACCEPTED.title)).length,
    0,
    "不能让用户以为这是护航自己接的单",
  );

  const audits = auditsOf(order.id);
  assert.equal(audits.length, 1, "一次指派写且只写一条审计");
  assert.equal(audits[0].action, "order.assign");
  assert.equal(audits[0].actorId, STAFF.id, "操作者来自客服会话");
  assert.equal(audits[0].actorRole, "customer_service");
  assert.equal(audits[0].actorName, STAFF.displayName);
  assert.match(audits[0].operationId, /^op_/, "operationId 由服务端生成");
  assert.equal(audits[0].before.status, "paid");
  assert.equal(audits[0].before.actualCompanionId, null);
  assert.equal(audits[0].before.dispatchState, "public");
  assert.equal(audits[0].after.status, "accepted");
  assert.equal(audits[0].after.actualCompanionId, COMPANION_A);
  assert.equal(audits[0].after.acceptedVia, "staff");

  // 审计快照里只有标量，不夹带用户 / 订单的整份对象
  for (const snapshot of [audits[0].before, audits[0].after]) {
    for (const value of Object.values(snapshot)) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        "审计快照只允许标量",
      );
    }
  }
});

test("指派 2：第二次到达 → 400「当前订单状态不允许指派护航」，且一笔不写", async () => {
  const order = await placeOrder();
  await assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A });
  const snapshot = await snapshotOf(order);

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_ASSIGNABLE_MESSAGE,
  );
  await assertNothingWritten(order, snapshot);
});

test("指派 3：订单不存在 → 404；已有履约人（accepted）→ 400，一笔不写", async () => {
  await assert.rejects(
    () => assignStaffOrderCompanion("ord-不存在", STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 404 && error.message === STAFF_ORDER_NOT_FOUND_MESSAGE,
  );

  const order = await placeOrder();
  await assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A });

  // 让另一张单直接以 accepted 出发：先指派，再尝试换一个人
  const snapshot = await snapshotOf(order);
  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_ASSIGNABLE_MESSAGE,
  );
  await assertNothingWritten(order, snapshot);
});

test("指派 4：没指定人 → 400，在读订单之前判定", async () => {
  await assert.rejects(
    () => assignStaffOrderCompanion("ord-不存在", STAFF, {}),
    (error) => error.status === 400,
  );
});

// ——————————————————— 二、资格与专属池 ———————————————————

test("资格 1：暂停接单 / 已下架 / 下单用户本人 → 400，且一笔不写", async () => {
  const order = await placeOrder();
  const snapshot = await snapshotOf(order);

  for (const companionId of [COMPANION_PAUSED, COMPANION_DISABLED]) {
    await assert.rejects(
      () => assignStaffOrderCompanion(order.id, STAFF, { companionId }),
      (error) => error.status === 400 && error.message === STAFF_ORDER_COMPANION_UNAVAILABLE_MESSAGE,
      `${companionId} 此刻不能接单`,
    );
  }

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: "cp-不存在" }),
    (error) => error.status === 400 && error.message === "指定的护航不存在",
  );

  await assertNothingWritten(order, snapshot);
});

test("资格 2：不能指派给下单用户本人（EX-DISPATCH-08）", async () => {
  const order = await placeOrder({ userId: BOUND_USER });
  assert.equal(companionStore().companions.get(COMPANION_BOUND)?.userId, BOUND_USER);

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_BOUND }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_SELF_ORDER_MESSAGE,
  );
  assert.equal(paymentStore().orders.get(order.id).status, "paid");
});

test("专属池 1：只能指派用户指定的那位——指派别人 400，指派本人成功", async () => {
  const order = await placeOrder({ companionId: COMPANION_B });
  const dispatch = dispatchRecordOf(order.id);
  assert.equal(dispatch.state, "exclusive");
  assert.equal(dispatch.exclusiveCompanionId, COMPANION_B);
  const snapshot = await snapshotOf(order);

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_ASSIGN_NOT_ELIGIBLE_MESSAGE,
  );
  await assertNothingWritten(order, snapshot);

  const result = await assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B });
  assert.equal(result.companionId, COMPANION_B);
  assert.equal(paymentStore().orders.get(order.id).status, "accepted");
  assert.equal(dispatchRecordOf(order.id).acceptedVia, "staff");
});

test("专属池 2：等待时限已过 → 400「不能直接指派」，一笔不写", async () => {
  const order = await placeOrder({ companionId: COMPANION_B });
  const dispatch = dispatchRecordOf(order.id);
  dispatchStore().dispatches.set(dispatch.id, {
    ...dispatch,
    exclusiveDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const snapshot = await snapshotOf(order);

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_B }),
    (error) => error.status === 400 && error.message === STAFF_ORDER_ASSIGN_EXPIRED_MESSAGE,
  );
  await assertNothingWritten(order, snapshot);
});

test("数据 1：派单记录缺失 → 500「订单数据异常」，一笔不写", async () => {
  const order = await placeOrder();
  const snapshot = await snapshotOf(order);
  const dispatch = dispatchRecordOf(order.id);
  dispatchStore().dispatchIdByOrder.delete(order.id);
  dispatchStore().dispatches.delete(dispatch.id);

  await assert.rejects(
    () => assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A }),
    (error) => error.status === 500 && error.message === ORDER_DATA_INCONSISTENT_MESSAGE,
  );
  assert.equal(paymentStore().orders.get(order.id).status, "paid");
  assert.deepEqual(
    auditsOf(order.id).map((entry) => entry.id),
    snapshot.auditIds,
    "500 之前不得写审计",
  );
});

// ——————————————————— 三、候选名单 ———————————————————

test("候选 1：公共池名单只列此刻可接单的护航，且排除下单用户本人", async () => {
  const order = await placeOrder({ userId: BOUND_USER });
  const list = await listStaffOrderAssignCandidates(order.id);

  assert.ok(list.items.length > 0, "预置名单里必须有可接单的护航，否则这一条空转");
  assert.equal(
    list.notice.length > 0,
    true,
    "名单非空时也要说明口径（排除了谁、专属期规则）",
  );

  const ids = new Set(list.items.map((item) => item.companionId));
  for (const item of list.items) {
    const companion = companionStore().companions.get(item.companionId);
    assert.ok(companion);
    assert.equal(
      isCompanionAcceptingOrders(companion),
      true,
      "名单里出现的每一位都必须此刻可接单",
    );
    assert.notEqual(item.companionId, COMPANION_PAUSED);
    assert.notEqual(item.companionId, COMPANION_DISABLED);
    assert.notEqual(item.companionId, COMPANION_BOUND, "下单用户本人不在名单里");
    assert.equal(typeof item.activeOrderCount, "number");
  }
  assert.ok(!ids.has(COMPANION_BOUND));
});

test("候选 2：专属池名单只有用户指定的那位，并给出专属期口径", async () => {
  const order = await placeOrder({ companionId: COMPANION_B });
  const list = await listStaffOrderAssignCandidates(order.id);

  assert.deepEqual(
    list.items.map((item) => item.companionId),
    [COMPANION_B],
    "专属期内客服不能选别人",
  );
  assert.equal(list.notice, STAFF_ORDER_ASSIGN_EXCLUSIVE_NOTICE);
});

test("候选 3：不是 paid / 已过期 / 订单不存在 → 明确报错，而不是空名单", async () => {
  const order = await placeOrder();
  await assignStaffOrderCompanion(order.id, STAFF, { companionId: COMPANION_A });

  await assert.rejects(
    () => listStaffOrderAssignCandidates(order.id),
    (error) => error.status === 400 && error.message === STAFF_ORDER_NOT_ASSIGNABLE_MESSAGE,
    "已经有人接的单不该回空名单——那会让界面说「没有可指派的护航」",
  );

  await assert.rejects(
    () => listStaffOrderAssignCandidates("ord-不存在"),
    (error) => error.status === 404 && error.message === STAFF_ORDER_NOT_FOUND_MESSAGE,
  );

  const expired = await placeOrder({ companionId: COMPANION_B });
  const dispatch = dispatchRecordOf(expired.id);
  dispatchStore().dispatches.set(dispatch.id, {
    ...dispatch,
    exclusiveDeadlineAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await assert.rejects(
    () => listStaffOrderAssignCandidates(expired.id),
    (error) => error.status === 400 && error.message === STAFF_ORDER_ASSIGN_EXPIRED_MESSAGE,
  );
});

test("候选 4：派单缺失 → 500，而不是空名单", async () => {
  const order = await placeOrder();
  const dispatch = dispatchRecordOf(order.id);
  dispatchStore().dispatchIdByOrder.delete(order.id);
  dispatchStore().dispatches.delete(dispatch.id);

  await assert.rejects(
    () => listStaffOrderAssignCandidates(order.id),
    (error) => error.status === 500 && error.message === ORDER_DATA_INCONSISTENT_MESSAGE,
  );
});
