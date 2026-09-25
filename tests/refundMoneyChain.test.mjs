import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  REFUND_DECISION_EXCEEDS_PAID_MESSAGE,
  REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE,
  REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE,
  REFUND_DECISION_RATE_INVALID_MESSAGE,
  REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE,
  REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE,
  assertRefundAmountWithinPaid,
  computeRefundDecisionAmounts,
  isFullyRefunded,
  resolveFinalDecisionAmounts,
  sumApprovedCompanionReversal,
  validateRefundDecisionInput,
} from "../lib/constants/refunds.ts";
import { previewRefundDecisionAmounts } from "../lib/constants/adminRefunds.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  acceptDispatch,
  sweepExpiredDispatches,
} from "../lib/data/companionDispatchTransaction.ts";
import {
  releaseOrderByStaff,
  startCompanionOrder as startCompanionOrderTransaction,
} from "../lib/data/companionOrderTransaction.ts";
import { directRefundOrder } from "../lib/data/directRefundTransaction.ts";
import { approveCompletion, submitCompletion } from "../lib/data/completionTransaction.ts";
import { sweepMaturedEarnings } from "../lib/data/earningTransaction.ts";
import { applyEarningReversal, earningStore } from "../lib/data/mockEarningRepository.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { notificationStore } from "../lib/data/mockNotificationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { applyOrderRefund } from "../lib/data/mockPaymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import {
  approveAdminRefund,
  getAdminRefundDetail,
} from "../lib/services/adminRefunds.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { getStaffRefundDetail } from "../lib/services/staffRefunds.ts";
import {
  createRefundForOrder,
  getRefundDetailForUser,
} from "../lib/services/refunds.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";

/**
 * P0-13「退款资金联动」的持续测试。
 *
 * 本文件只钉**钱这条线**：一次退款决策之后，钱在「用户 / 平台 / 打手」三方之间
 * 到底动了多少、动在哪一条记录上、谁看得到谁看不到。
 * 状态机、幂等的意图绑定、审计条数由 `tests/adminRefunds.test.mjs` 覆盖；
 * 这里不重复，只在自己需要的边界上补一条。
 *
 * ## 冻结的规则（`docs/03-dev/rounds/P0-13/02-decisions.md`）
 *
 * | 责任归属 | 打手冲回额 |
 * | --- | --- |
 * | `platform` | 恒为 `0` |
 * | `companion` | `floor(companionBaseIncome × refundRateBp / 10000)` |
 * | `shared` | `floor(companionBaseIncome × refundRateBp × liabilityBp / 10000 / 10000)` |
 *
 * 三条派生事实一起被钉住：
 *
 * 1. `platformBorneAmount = refundAmount − companionReversalAmount`，**用减法构造**
 *    因此恒等式 `refundAmount === reversal + platformBorne` 在定义上成立；
 *    **允许为负**（§17：打手按原价分账，券由平台承担）；
 * 2. `0 <= Earning.reversedAmount <= Earning.incomeAmount`（Q2-d），
 *    且部分冲回**不改状态**、整笔冲完才 `reversed`（Q2-c / D5）；
 * 3. 冲回有**明细**（`EarningAdjustment`，Q2-b）：读用总数、审计用明细，
 *    两者必须同时对得上。
 *
 * ## 一条刻意的写法
 *
 * 期望的金额一律由**订单自己的冻结快照**（`actualPaidAmount` / `companionBaseIncome`）
 * 现算，不硬编码数字：商品价与分账比例改一次，硬编码的数字就会变成一句
 * 「以前是这样」的假话，而这条链路要钉的是**公式**。
 * 公式本身另有一组纯函数用例，用**手算得出**的字面量断言（见第一节）。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const ADMIN = "admin-1";
const STAFF = { id: "staff-1", name: "客服小雨" };
const COMPANION_A = "cp-1";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function now() {
  return new Date().toISOString();
}

function decisionBody(overrides = {}) {
  return { refundRatePercent: "100", responsibility: "platform", ...overrides };
}

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("dispatch");
  resetMockStore("earning");
  resetMockStore("completion");
  resetMockStore("adminAudit");
  resetMockStore("notification");
  resetMockStore("complaint");
});

// ————————————————————————— 读取辅助 —————————————————————————

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function refundOf(refundId) {
  const refund = await getRefundRepository().findRefundById(refundId);
  assert.ok(refund, `退款 ${refundId} 必须存在`);
  return refund;
}

/** 这一单的收益（可能还没生成——`serving` 单退款时就是这种情况，见 D9）。 */
function earningOfOrder(orderId) {
  return [...earningStore().earnings.values()].find((earning) => earning.orderId === orderId) ?? null;
}

function adjustmentsOf(earningId) {
  return [...earningStore().adjustments.values()]
    .filter((adjustment) => adjustment.earningId === earningId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function allNotifications() {
  return [...notificationStore().notifications.values()];
}

// ————————————————————————— 构造一张有收益的订单 —————————————————————————

/**
 * 走完整链路把一张新订单推到 `completed` 并拿到它的收益（`frozen`）。
 *
 * 与 `tests/earning.test.mjs` 的同类辅助保持同一套时刻关系（接单 −41 / 开始服务 −21 /
 * 提交材料 −11），因此这里不需要重新论证一遍链路自身的先后关系。
 */
async function completedOrder({ completedAt = plusMinutes(now(), 62) } = {}) {
  const user = unique("u-p13");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      idempotencyKey: unique("p13key"),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  const orderId = confirmed.order.id;

  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(dispatch, "支付成功后必须有一条派单记录");
  const accepted = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(completedAt, -41),
  });
  assert.equal(accepted.kind, "ok");

  const started = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId,
    at: plusMinutes(completedAt, -21),
  });
  assert.equal(started.kind, "ok");

  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -11),
  });
  assert.equal(submitted.kind, "ok");

  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.name,
    at: completedAt,
  });
  assert.equal(approved.kind, "ok");

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed", "前置条件：订单必须走到 completed");
  const earning = earningOfOrder(orderId);
  assert.ok(earning, "completed 必须生成收益");
  assert.equal(earning.status, "frozen", "前置条件：收益刚生成时是冻结的");
  assert.equal(earning.reversedAmount, 0, "前置条件：还没有任何冲回");

  return { user, order, orderId, earning };
}

/**
 * 一张还在 `serving`（尚未结算、因此**还没有收益**）的订单。
 *
 * 它专门用来验 D9：退款时收益还不存在，冲回必须**记在退款决策上**，
 * 等这一单将来结算时再补记，而不是当场丢掉。
 */
async function servingOrder({ at = plusMinutes(now(), 32) } = {}) {
  const user = unique("u-p13s");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      idempotencyKey: unique("p13key"),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  const orderId = confirmed.order.id;

  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  const accepted = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(at, -21),
  });
  assert.equal(accepted.kind, "ok");
  const started = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId,
    at,
  });
  assert.equal(started.kind, "ok");

  const order = await orderOf(orderId);
  assert.equal(order.status, "serving", "前置条件：订单必须在护航中");
  assert.equal(earningOfOrder(orderId), null, "前置条件：还在护航的单没有收益");
  return { user, order, orderId };
}

/** 用户发起整单退款申请，返回退款 id。 */
async function requestRefund(orderId, userId) {
  const { refundId } = await createRefundForOrder(
    orderId,
    userId,
    {
      reasonKey: "other",
      description: "临时有事，这一单打不了了，麻烦帮我退掉。",
      evidence: [],
      idempotencyKey: unique("p13key"),
    },
    undefined,
    "server",
  );
  return refundId;
}

/** 管理员批一笔退款（决策由调用方给全）。 */
async function approve(refundId, body) {
  return approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: unique("p13key"),
    ...body,
  });
}

// ————————————————————————— 一、公式与校验（纯函数，手算字面量） —————————————————————————
//
// 这一节**不碰订单**，因此期望值可以写成手算出来的字面量：
// `base = 2000` / `paid = 1500` / 比例 30% / 责任比例 50%，
// 四个数都是整百，乘除之后不会出现「读代码算一遍再断言」那种自证。

test("公式：平台承担 → 冲回 0，平台承担额等于退款额", () => {
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: 1500,
    companionBaseIncome: 2000,
    reversedSoFar: 0,
    input: { refundRateBp: 3000, responsibility: "platform", companionLiabilityRateBp: null },
  });

  // 1500 × 30% = 450，打手一分不冲
  assert.equal(amounts.refundAmount, 450);
  assert.equal(amounts.companionReversalAmount, 0);
  assert.equal(amounts.platformBorneAmount, 450);
});

test("公式：打手承担 → 按同一退款比例冲回打手的基础收益", () => {
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: 1500,
    companionBaseIncome: 2000,
    reversedSoFar: 0,
    input: { refundRateBp: 3000, responsibility: "companion", companionLiabilityRateBp: null },
  });

  // 退款：1500 × 30% = 450；冲回：2000 × 30% = 600
  assert.equal(amounts.refundAmount, 450);
  assert.equal(amounts.companionReversalAmount, 600);
  // 450 − 600 = −150：**允许为负**（§17）。打手按原价分账，券由平台承担，
  // 因此「从打手手里收回来」的可以比「退给用户」的更多
  assert.equal(amounts.platformBorneAmount, -150);
});

test("公式：按比例分担 → 退款比例 × 打手责任比例，两级取整都向下", () => {
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: 1500,
    companionBaseIncome: 2000,
    reversedSoFar: 0,
    input: { refundRateBp: 3000, responsibility: "shared", companionLiabilityRateBp: 5000 },
  });

  // 2000 × 30% × 50% = 300。两级都 floor，因此结果永远不大于先乘后除
  assert.equal(amounts.refundAmount, 450);
  assert.equal(amounts.companionReversalAmount, 300);
  assert.equal(amounts.platformBorneAmount, 150);
});

test("公式：取整一律向下 —— 除不尽时冲回额不向上进一分", () => {
  // base = 1001，比例 33%：1001 × 3300 / 10000 = 330.33 → 330
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: 1001,
    companionBaseIncome: 1001,
    reversedSoFar: 0,
    input: { refundRateBp: 3300, responsibility: "companion", companionLiabilityRateBp: null },
  });

  assert.equal(amounts.refundAmount, 330);
  assert.equal(amounts.companionReversalAmount, 330);
  assert.equal(amounts.platformBorneAmount, 0);
});

test("公式：恒等式在三种责任归属下都成立（减法构造的落点）", () => {
  const cases = [
    { responsibility: "platform", companionLiabilityRateBp: null },
    { responsibility: "companion", companionLiabilityRateBp: null },
    { responsibility: "shared", companionLiabilityRateBp: 3700 },
  ];

  for (const item of cases) {
    // 刻意用除不尽的数：如果平台承担额是**各自取整**算出来的，
    // 这里会出现差 1 分，而减法构造不会
    const amounts = computeRefundDecisionAmounts({
      actualPaidAmount: 2999,
      companionBaseIncome: 1777,
      reversedSoFar: 0,
      input: { refundRateBp: 3711, ...item },
    });

    assert.equal(
      amounts.platformBorneAmount,
      amounts.refundAmount - amounts.companionReversalAmount,
      `${item.responsibility}：平台承担额必须是减法算出来的`,
    );
    assert.equal(
      amounts.refundAmount,
      amounts.companionReversalAmount + amounts.platformBorneAmount,
      `${item.responsibility}：三方金额必须闭合`,
    );
  }
});

test("公式：钳制把累计冲回锁在剩余可冲回额以内（Q2-d）", () => {
  const clamped = computeRefundDecisionAmounts({
    actualPaidAmount: 4000,
    companionBaseIncome: 2000,
    // 已经冲回 1800，只剩 200 可冲
    reversedSoFar: 1800,
    input: { refundRateBp: 10000, responsibility: "companion", companionLiabilityRateBp: null },
  });

  assert.equal(clamped.companionReversalAmount, 200, "不能冲得比剩余的还多");
  // 退款额不受冲回额影响：退给用户多少只看实付 × 比例
  assert.equal(clamped.refundAmount, 4000);
  assert.equal(clamped.platformBorneAmount, 3800);

  const exhausted = computeRefundDecisionAmounts({
    actualPaidAmount: 4000,
    companionBaseIncome: 2000,
    reversedSoFar: 2000,
    input: { refundRateBp: 10000, responsibility: "companion", companionLiabilityRateBp: null },
  });

  assert.equal(exhausted.companionReversalAmount, 0, "已经冲满：这一次一分都不再冲");
});

test("校验：责任比例只属于「按比例分担」，其它两种给了就是报错而不是静默忽略", () => {
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: 10000,
      responsibility: "platform",
      companionLiabilityRateBp: 5000,
    }),
    REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE,
  );
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: 10000,
      responsibility: "companion",
      companionLiabilityRateBp: 5000,
    }),
    REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE,
  );
  // 反过来：「按比例分担」缺责任比例也必须报错
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: 10000,
      responsibility: "shared",
      companionLiabilityRateBp: null,
    }),
    REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE,
  );
});

/*
  ⚠️ 「没填」与「填错」在这一层是两件事，别指望两条文案都能在这里断出来：
  `validateRefundDecisionInput` 面对的是**已经解析过的**输入，它分不出
  「管理员没选责任归属」和「选了一个不在枚举里的值」——两者到这里都是
  「不是 `RefundResponsibility`」。前者由接口层的
  `readAdminRefundDecisionInput` 回答（空字符串 / 缺失 → 「请选择…」），
  下面接口层那一条用例钉的就是它。这里只钉规则层能回答的那部分。
*/
test("校验：比例与责任归属填错都给出明确原因", () => {
  // NaN「不是整数」被判成**缺失**而不是越界：对管理员来说两者都是「这个框没填对」，
  // 而「必须在 0~100 之间」这句对一个填了 NaN 的人毫无帮助。两条文案各答各的问题
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: Number.NaN,
      responsibility: "platform",
      companionLiabilityRateBp: null,
    }),
    REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  );
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: 10001,
      responsibility: "platform",
      companionLiabilityRateBp: null,
    }),
    REFUND_DECISION_RATE_INVALID_MESSAGE,
  );
  assert.equal(
    validateRefundDecisionInput({
      refundRateBp: 10000,
      responsibility: "whatever",
      companionLiabilityRateBp: null,
    }),
    REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE,
  );
});

test("金额闸：判据是**累计**，单次看不出来；0 元退款单独拦", () => {
  assert.equal(
    assertRefundAmountWithinPaid({ refundAmount: 0, alreadyRefundedAmount: 0, actualPaidAmount: 100 }),
    "退款金额为 0，无法提交退款决策",
  );
  // 单次 60 <= 100 看着没问题，但累计已经 50 了
  assert.notEqual(
    assertRefundAmountWithinPaid({
      refundAmount: 60,
      alreadyRefundedAmount: 50,
      actualPaidAmount: 100,
    }),
    null,
  );
  assert.equal(
    assertRefundAmountWithinPaid({
      refundAmount: 50,
      alreadyRefundedAmount: 50,
      actualPaidAmount: 100,
    }),
    null,
  );
});

test("退满判据：只有累计达到实付才算退满；实付为 0 的订单永不「退满」", () => {
  assert.equal(isFullyRefunded(99, 100), false);
  assert.equal(isFullyRefunded(100, 100), true);
  assert.equal(isFullyRefunded(101, 100), true, "超过也算退满（异常数据不该卡在中间态）");
  assert.equal(isFullyRefunded(0, 0), false, "0 元单不是「已退满」");
});

// ————————————————————————— 二、接口层：决策入参 —————————————————————————

test("接口层：非「按比例分担」却带责任比例 → 400，且一个字都不写", async () => {
  const { user, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  await assert.rejects(
    approve(refundId, decisionBody({ responsibility: "platform", companionLiabilityRatePercent: "50" })),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE);
      return true;
    },
  );

  const refund = await refundOf(refundId);
  assert.equal(refund.status, "pending", "被拒的决策不得改动退款状态");
  assert.equal(refund.decision, null, "被拒的决策不得留下半条决策");
  assert.equal(earningOfOrder(orderId).reversedAmount, 0);
  assert.equal(adjustmentsOf(earning.id).length, 0);
  assert.equal((await orderOf(orderId)).refundedAmount, 0);
});

test("接口层：「还没选责任归属」与「填错了」是两条不同的提示", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  // 未选择：界面上是一个空字符串（`ResponsibilityChoice` 的初值刻意不是 platform，
  // 否则「没选」会被静默当成「平台承担」）
  await assert.rejects(
    approve(refundId, { refundRatePercent: "100", responsibility: "" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE);
      return true;
    },
  );

  // 选了一个不在枚举里的值
  await assert.rejects(
    approve(refundId, { refundRatePercent: "100", responsibility: "club" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE);
      return true;
    },
  );

  // 比例缺失同理：空字符串是「没填」，不是「0%」
  await assert.rejects(
    approve(refundId, { responsibility: "platform" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    approve(refundId, { refundRatePercent: "", responsibility: "platform" }),
    (error) => {
      assert.equal(error.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);
      return true;
    },
  );

  // 四种情况都是「一个字节都没写」
  const refund = await refundOf(refundId);
  assert.equal(refund.status, "pending");
  assert.equal(refund.decision, null);
  assert.equal((await orderOf(orderId)).refundedAmount, 0);
});

test("接口层：管理员只输入比例，金额由服务端按订单快照算 —— 请求体里没有金额的位置", async () => {
  const { user, order, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  // 请求体里塞满金额字段：一律被忽略，算出来的必须是公式值
  await approve(refundId, {
    ...decisionBody({ responsibility: "companion" }),
    refundAmount: 1,
    decidedAmount: 1,
    companionReversalAmount: 99999999,
    platformBorneAmount: -99999999,
    refundedAmount: 1,
  });

  const refund = await refundOf(refundId);
  const expectedRefund = Math.floor((order.actualPaidAmount * 10000) / 10000);
  const expectedReversal = Math.floor((order.companionBaseIncome * 10000) / 10000);

  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.refundAmount, order.actualPaidAmount, "100% 就是实付全额");
  assert.equal(refund.decision.companionReversalAmount, expectedReversal);
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome, "100% 冲满");
  assert.equal(refund.decision.platformBorneAmount, expectedRefund - expectedReversal);
});

// ————————————————————————— 三、打手承担的完整链路 —————————————————————————

test("打手承担：部分退款 → 收益被同比例冲回，订单状态与收益状态都不变", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  await approve(refundId, decisionBody({ refundRatePercent: "30", responsibility: "companion" }));

  const refund = await refundOf(refundId);
  const expectedRefund = Math.floor((order.actualPaidAmount * 3000) / 10000);
  const expectedReversal = Math.floor((order.companionBaseIncome * 3000) / 10000);
  assert.ok(expectedReversal > 0, "这条用例需要一次真的冲回");

  // 退款决策六项字段齐全，且平台承担额与冲回额闭合
  assert.equal(refund.decision.refundRateBp, 3000);
  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.responsibility, "companion");
  assert.equal(refund.decision.companionLiabilityRateBp, null);
  assert.equal(refund.decision.companionReversalAmount, expectedReversal);
  assert.equal(
    refund.decision.platformBorneAmount,
    expectedRefund - expectedReversal,
    "平台承担额必须由减法得出",
  );
  assert.equal(refund.decision.decidedBy, ADMIN);
  assert.equal(typeof refund.decision.decidedAt, "string");

  // 订单：部分退款不改状态，只累计已退额
  const afterOrder = await orderOf(orderId);
  assert.equal(afterOrder.status, "completed", "部分退款不得把订单改成已退款");
  assert.equal(afterOrder.refundedAmount, expectedRefund);
  assert.equal(afterOrder.refundedAt, null, "没退满就不该有退款时间");
  assert.equal(afterOrder.actualCompanionId, order.actualCompanionId, "派单归属不动");

  // 收益：**留在原状态**（D5）——部分冲回绝不能让冻结提前结束
  const afterEarning = earningOfOrder(orderId);
  assert.equal(afterEarning.status, "frozen", "部分冲回不得把 frozen 变成 available");
  assert.equal(afterEarning.incomeAmount, earning.incomeAmount, "原始承诺额一个字不改（Q2-a）");
  assert.equal(afterEarning.reversedAmount, expectedReversal);

  // 明细：读的总数必须等于明细之和（Q2-b / 「读用总数、审计用明细」）
  const adjustments = adjustmentsOf(earning.id);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].refundId, refundId);
  assert.equal(adjustments[0].type, "refund_reversal");
  assert.equal(adjustments[0].amount, expectedReversal);
  assert.equal(adjustments[0].responsibility, "companion");
  assert.equal(adjustments[0].orderId, orderId);
  assert.equal(adjustments[0].adminId, ADMIN);
  assert.equal(
    afterEarning.reversedAmount,
    adjustments.reduce((total, item) => total + item.amount, 0),
    "收益上的累计冲回额必须等于明细之和",
  );

  /*
    打手端 DTO 上的净额 = 原额 − 累计冲回。

    ⚠️ 走 `listCompanionEarnings`（服务层）而不是仓储：`netAmount` 是 DTO 字段，
    仓储给的是存储记录，上面没有它——在仓储上断言净额会得到一个 `undefined`，
    而 `undefined === 数字` 恰好是 false，用例会红得莫名其妙。
  */
  const mine = (await listCompanionEarnings(COMPANION_A)).items.find(
    (row) => row.orderId === orderId,
  );
  assert.ok(mine, "打手必须能读到自己的收益");
  assert.equal(mine.reversedAmount, expectedReversal);
  assert.equal(mine.netAmount, mine.incomeAmount - expectedReversal);
});

test("打手承担：收益已 available 时部分冲回 → 状态仍是 available", async () => {
  const { user, orderId, earning } = await completedOrder();
  // 让收益先变成可用：越过计划解冻时刻清扫一次
  const swept = sweepMaturedEarnings(plusMinutes(earning.availableAt, 1));
  assert.ok(swept.releasedEarningIds.includes(earning.id), "前置条件：收益必须先解冻");
  assert.equal(earningOfOrder(orderId).status, "available");

  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody({ refundRatePercent: "40", responsibility: "companion" }));

  const after = earningOfOrder(orderId);
  const expectedReversal = Math.floor((after.incomeAmount * 4000) / 10000);
  assert.ok(expectedReversal > 0 && expectedReversal < after.incomeAmount);
  assert.equal(after.status, "available", "部分冲回留在原状态：可用的仍然可用");
  assert.equal(after.reversedAmount, expectedReversal);
  assert.equal(after.availableAt, earning.availableAt, "冲回不刷新计划解冻时刻");
});

test("整笔冲完 → 收益变 reversed、净额为 0，此时才有资格说「已冲销」", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  await approve(refundId, decisionBody({ responsibility: "companion" }));

  const after = earningOfOrder(orderId);
  assert.equal(after.reversedAmount, after.incomeAmount, "整笔冲完");
  assert.equal(after.status, "reversed");
  assert.equal(after.incomeAmount, earning.incomeAmount, "原额仍然不改");

  // 冲满之后订单也退满了：这才是「已退款」
  const afterOrder = await orderOf(orderId);
  assert.equal(afterOrder.refundedAmount, order.actualPaidAmount);
  assert.equal(afterOrder.status, "refunded");
  assert.equal(typeof afterOrder.refundedAt, "string");
});

test("按比例分担：冲回额 = 退款比例 × 打手责任比例，剩下由平台承担", async () => {
  const { user, order, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  await approve(
    refundId,
    decisionBody({
      refundRatePercent: "50",
      responsibility: "shared",
      companionLiabilityRatePercent: "60",
    }),
  );

  const refund = await refundOf(refundId);
  const expectedRefund = Math.floor((order.actualPaidAmount * 5000) / 10000);
  const expectedReversal = Math.floor((order.companionBaseIncome * 5000 * 6000) / 10000 / 10000);

  assert.equal(refund.decision.refundRateBp, 5000);
  assert.equal(refund.decision.companionLiabilityRateBp, 6000);
  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.companionReversalAmount, expectedReversal);
  assert.equal(refund.decision.platformBorneAmount, expectedRefund - expectedReversal);

  const after = earningOfOrder(orderId);
  assert.equal(after.reversedAmount, expectedReversal);
  assert.equal(
    after.status,
    expectedReversal >= after.incomeAmount ? "reversed" : "frozen",
    "状态只由「有没有整笔冲完」决定",
  );
});

// ————————————————————————— 四、多次退款：累计与幂等 —————————————————————————

test("同一笔收益可以被多次冲减：两次部分退款 → 两条明细、累计额等于两次之和", async () => {
  const { user, order, orderId, earning } = await completedOrder();

  const firstRefund = await requestRefund(orderId, user);
  await approve(firstRefund, decisionBody({ refundRatePercent: "20", responsibility: "companion" }));
  const firstReversal = earningOfOrder(orderId).reversedAmount;
  assert.ok(firstReversal > 0);

  // D10：前一笔已经结束（已通过）之后，同一单还能再申请一次
  const secondRefund = await requestRefund(orderId, user);
  assert.notEqual(secondRefund, firstRefund);
  await approve(secondRefund, decisionBody({ refundRatePercent: "30", responsibility: "companion" }));

  const after = earningOfOrder(orderId);
  const expectedTotal = firstReversal + Math.floor((after.incomeAmount * 3000) / 10000);
  assert.equal(after.reversedAmount, expectedTotal, "累计冲回是加法，不是覆盖");
  assert.ok(after.reversedAmount <= after.incomeAmount, "不变式：冲回不超过原额");

  const adjustments = adjustmentsOf(earning.id);
  assert.equal(adjustments.length, 2, "两次退款两条明细");
  assert.deepEqual(
    adjustments.map((item) => item.refundId),
    [firstRefund, secondRefund],
  );
  assert.equal(
    after.reversedAmount,
    adjustments.reduce((total, item) => total + item.amount, 0),
  );

  // 订单侧同样是累计
  assert.equal(
    (await orderOf(orderId)).refundedAmount,
    Math.floor((order.actualPaidAmount * 2000) / 10000) +
      Math.floor((order.actualPaidAmount * 3000) / 10000),
  );
});

test("幂等：同一次退款决策重放不会冲回两次（明细与累计额都不动）", async () => {
  const { user, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  const operationId = unique("p13key");

  const first = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    ...decisionBody({ refundRatePercent: "25", responsibility: "companion" }),
  });
  assert.equal(first.changed, true);
  const afterFirst = earningOfOrder(orderId).reversedAmount;
  assert.ok(afterFirst > 0);

  const replay = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    ...decisionBody({ refundRatePercent: "25", responsibility: "companion" }),
  });
  assert.equal(replay.changed, false, "同键重放不算改动");

  const after = earningOfOrder(orderId);
  assert.equal(after.reversedAmount, afterFirst, "重放不得再冲一次");
  assert.equal(adjustmentsOf(earning.id).length, 1, "重放不得多写一条明细");
  assert.equal(
    [...adminAuditStore().audits.values()].filter((entry) => entry.targetId === refundId).length,
    1,
  );
});

// ————————————————————————— 五、边界：没有收益、收益已提现 —————————————————————————

test("D9：护航中退款时还没有收益 → 决策照记，结算时补记冲回", async () => {
  const { user, orderId } = await servingOrder();
  const refundId = await requestRefund(orderId, user);

  // 30% 部分退款：订单必须继续护航（退满会转「已退款」，那样就结算不了了）
  await approve(refundId, decisionBody({ refundRatePercent: "30", responsibility: "companion" }));

  const refund = await refundOf(refundId);
  assert.equal(refund.status, "approved");
  assert.ok(refund.decision.companionReversalAmount > 0, "决策上必须记下该冲多少");
  assert.equal(earningOfOrder(orderId), null, "此时收益确实还不存在");
  assert.equal(
    (await orderOf(orderId)).status,
    "serving",
    "部分退款不改订单状态：这一单还要继续履约",
  );

  // 履约完成 → 结算
  const completedAt = plusMinutes(now(), 62);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -5),
  });
  assert.equal(submitted.kind, "ok");
  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.name,
    at: completedAt,
  });
  assert.equal(approved.kind, "ok");

  const earning = earningOfOrder(orderId);
  assert.ok(earning, "结算必须生成收益");
  assert.equal(
    earning.reversedAmount,
    refund.decision.companionReversalAmount,
    "退款时算好的冲回额必须在结算时补记，不能丢",
  );
  assert.equal(earning.incomeAmount, (await orderOf(orderId)).companionBaseIncome);

  const adjustments = adjustmentsOf(earning.id);
  assert.equal(adjustments.length, 1, "补记也要留下明细");
  assert.equal(adjustments[0].refundId, refundId);
  assert.equal(adjustments[0].amount, refund.decision.companionReversalAmount);
  assert.equal(adjustments[0].type, "refund_reversal");

  // 状态规则与即时冲回同一条：部分冲回留在原状态
  assert.equal(earning.status, "frozen");
});

test("D17：收益已提现 → 本轮不冲回，金额 0，多出来的由平台承担", async () => {
  const { user, order, orderId, earning } = await completedOrder();

  // 直接把它置为「已提现」：本阶段还没有提现通道，这一步模拟「打手已经把钱拿走」
  const current = earningStore().earnings.get(earning.id);
  earningStore().earnings.set(earning.id, { ...current, status: "withdrawn" });

  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody({ responsibility: "companion" }));

  const refund = await refundOf(refundId);
  assert.equal(refund.decision.responsibility, "companion");
  assert.equal(refund.decision.companionReversalAmount, 0, "已提现的钱这一轮不追回");
  assert.equal(
    refund.decision.platformBorneAmount,
    refund.decision.refundAmount,
    "冲回 0 → 退款全部由平台承担",
  );

  const after = earningOfOrder(orderId);
  assert.equal(after.status, "withdrawn", "不得因为退款把状态改掉");
  assert.equal(after.reversedAmount, 0, "一个字节都不冲");
  assert.equal(adjustmentsOf(earning.id).length, 0, "没有金额就不要写一条空明细");

  // 退款本身照常执行：订单该退还是退
  const afterOrder = await orderOf(orderId);
  assert.equal(afterOrder.refundedAmount, order.actualPaidAmount);
  assert.equal(afterOrder.status, "refunded");
});

test("存储层护栏：即使调用方算错，收益也不会被冲得比挣的还多", () => {
  // 独立于伪事务，直接打在存储原语上——它是最后一道
  const created = {
    id: unique("earn"),
    companionId: COMPANION_A,
    orderId: unique("ord"),
    orderNo: "P13",
    incomeAmount: 100,
    reversedAmount: 0,
    status: "frozen",
    frozenAt: now(),
    availableAt: null,
  };
  const store = earningStore();
  store.earnings.set(created.id, created);
  store.earningIdByOrder.set(created.orderId, created.id);

  applyEarningReversal(created.id, 60);
  assert.equal(store.earnings.get(created.id).reversedAmount, 60);
  assert.equal(store.earnings.get(created.id).status, "frozen", "部分冲回不改状态");

  applyEarningReversal(created.id, 999);
  const after = store.earnings.get(created.id);
  assert.equal(after.reversedAmount, 100, "钳制在 incomeAmount 上");
  assert.equal(after.status, "reversed");

  // 负数与 0 不是一次写入
  const before = { ...after };
  assert.equal(applyEarningReversal(created.id, 0).changed, false);
  assert.equal(applyEarningReversal(created.id, -5).changed, false);
  assert.deepEqual(store.earnings.get(created.id), before);
});

// ————————————————————————— 六、退满的副作用与可见性 —————————————————————————

test("退满才关派单并通知打手；部分退款两件事都不做", async () => {
  const partial = await completedOrder();
  const partialRefund = await requestRefund(partial.orderId, partial.user);
  const notificationsBefore = allNotifications().length;
  await approve(
    partialRefund,
    decisionBody({ refundRatePercent: "50", responsibility: "companion" }),
  );

  const dispatchAfterPartial = await getDispatchRepository().findDispatchByOrderId(partial.orderId);
  assert.notEqual(dispatchAfterPartial.state, "timed_out", "部分退款不得关闭派单");
  assert.equal(allNotifications().length, notificationsBefore, "部分退款不通知打手");

  const full = await completedOrder();
  const fullRefund = await requestRefund(full.orderId, full.user);
  await approve(fullRefund, decisionBody({ responsibility: "companion" }));

  const dispatchAfterFull = await getDispatchRepository().findDispatchByOrderId(full.orderId);
  assert.equal(dispatchAfterFull.state, "timed_out", "退满必须关闭派单");
  assert.equal(
    dispatchAfterFull.acceptedByCompanionId,
    COMPANION_A,
    "关闭派单不得抹掉「谁接的」这段历史",
  );
  assert.equal(
    (await orderOf(full.orderId)).actualCompanionId,
    COMPANION_A,
    "订单也必须留着 actualCompanionId",
  );

  assert.ok(
    allNotifications().length > notificationsBefore,
    "退满必须给打手留一条通知",
  );
});

test("D13：责任归属与平台承担额只给管理员；客服与用户只看到实退金额", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(
    refundId,
    decisionBody({
      refundRatePercent: "40",
      responsibility: "shared",
      companionLiabilityRatePercent: "50",
    }),
  );

  const decided = (await refundOf(refundId)).decision;

  // 管理员：六项俱全
  const admin = await getAdminRefundDetail(refundId, undefined, "server");
  assert.deepEqual(admin.decision, decided);
  assert.equal(admin.decidedAmount, decided.refundAmount);

  // 客服：只看得到金额
  const staff = await getStaffRefundDetail(refundId, undefined, "server");
  assert.equal(staff.decidedAmount, decided.refundAmount);
  assert.equal("decision" in staff, false, "客服不得拿到完整的资金决策");
  const staffJson = JSON.stringify(staff);
  for (const forbidden of ["responsibility", "companionReversalAmount", "platformBorneAmount"]) {
    assert.equal(staffJson.includes(forbidden), false, `客服 DTO 出现了 ${forbidden}`);
  }

  // 用户：同样只看得到金额
  const userDetail = await getRefundDetailForUser(refundId, user, undefined, "server");
  assert.equal(userDetail.decidedAmount, decided.refundAmount);
  assert.equal("decision" in userDetail, false, "用户不得拿到完整的资金决策");
  const userJson = JSON.stringify(userDetail);
  for (const forbidden of ["responsibility", "companionReversalAmount", "platformBorneAmount"]) {
    assert.equal(userJson.includes(forbidden), false, `用户 DTO 出现了 ${forbidden}`);
  }
});

test("D14：审计快照留下六个字段，事后能回答「这笔钱谁承担」", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(
    refundId,
    decisionBody({
      refundRatePercent: "40",
      responsibility: "shared",
      companionLiabilityRatePercent: "50",
    }),
  );

  const decision = (await refundOf(refundId)).decision;
  const entries = [...adminAuditStore().audits.values()].filter(
    (entry) => entry.targetId === refundId && entry.action === "refund.approve",
  );
  assert.equal(entries.length, 1);
  const after = entries[0].after;
  assert.equal(after.refundRateBp, decision.refundRateBp);
  assert.equal(after.refundAmount, decision.refundAmount);
  assert.equal(after.responsibility, decision.responsibility);
  assert.equal(after.companionLiabilityRateBp, decision.companionLiabilityRateBp);
  assert.equal(after.companionReversalAmount, decision.companionReversalAmount);
  assert.equal(after.platformBorneAmount, decision.platformBorneAmount);
});

// ————————————————————————— 七、不变式的持续检查 —————————————————————————

test("不变式：任意一批退款跑完，收益的累计冲回额都等于明细之和且在区间内", async () => {
  const { user, orderId, earning } = await completedOrder();

  const rates = ["10", "20", "30", "35"];
  for (const rate of rates) {
    const refundId = await requestRefund(orderId, user);
    await approve(refundId, decisionBody({ refundRatePercent: rate, responsibility: "companion" }));
  }

  const after = earningOfOrder(orderId);
  const adjustments = adjustmentsOf(earning.id);
  assert.equal(after.reversedAmount, adjustments.reduce((total, item) => total + item.amount, 0));
  assert.ok(after.reversedAmount >= 0);
  assert.ok(after.reversedAmount <= after.incomeAmount);
  assert.equal(adjustments.length, rates.length, "每一次退款恰好一条明细");

  // 累计已退不超过实付，且没退满时状态不是 refunded
  const order = await orderOf(orderId);
  assert.ok(order.refundedAmount <= order.actualPaidAmount);
  assert.equal(order.status, isFullyRefunded(order.refundedAmount, order.actualPaidAmount)
    ? "refunded"
    : "completed");
});

// ————————————————— 八、组合路径：部分退款 + 客服回池（P0-13 整改） —————————————————

/**
 * ## 这一节为什么存在
 *
 * 部分退款（P0-13）**不改订单状态**，而 P0-11 的「客服回池」把订单打回 `paid` 时
 * **不碰 `refundedAmount`**。两条合起来就造出一个新状态：
 * **一张「累计已退 > 0、但状态是 `paid` / `accepted`」的订单**。
 *
 * 而「未开始服务 ⇒ 退全额」的两条路径（用户直接退款、公共池超时自动退款）
 * 判的都是**状态**，因此它们都会走上这张订单。P0-13 把
 * `applyOrderRefund` 的第三个参数从「覆盖成多少」改成「本次增量」之后，
 * 这两处若仍传 `actualPaidAmount`，就会把「已退 300 + 实付 1000」加成 1300——
 * **退出去的钱超过实付**。
 *
 * ⚠️ 这一格在整改前**零覆盖**，而且门禁全绿：现有用例里的直退与超时清扫
 * 都建立在「累计已退 = 0」的前置上，从未先退过一笔再走这两条路。
 * 下面两条用例就是补这一格，断言同一个数的两个方向：
 * `refundedAmount` **恰好**等于 `actualPaidAmount`——少了是没退满，多了是超退。
 */
async function partialRefundThenRelease() {
  const { user, orderId } = await servingOrder();

  // ① 管理员批 30%（打手责任）。部分退款**不改订单状态**，订单还在 `serving`
  const refundId = await requestRefund(orderId, user);
  await approve(
    refundId,
    decisionBody({ refundRatePercent: "30", responsibility: "companion" }),
  );
  const afterPartial = await orderOf(orderId);
  assert.equal(afterPartial.status, "serving", "前置条件：部分退款不改订单状态");
  assert.ok(afterPartial.refundedAmount > 0, "前置条件：这一单必须已经退过一笔");
  assert.ok(
    afterPartial.refundedAmount < afterPartial.actualPaidAmount,
    "前置条件：这一笔必须是**部分**退款（没退满）",
  );

  // ② 客服把这一单退回公共池：订单回到 `paid`，**退款累计原样保留**
  const released = await releaseOrderByStaff({
    orderId,
    staffId: STAFF.id,
    reason: "打手无法继续服务，退回公共池",
    at: now(),
  });
  assert.equal(released.kind, "ok");
  const afterRelease = await orderOf(orderId);
  assert.equal(afterRelease.status, "paid", "回池后订单回到「未开始服务」那一档");
  assert.equal(
    afterRelease.refundedAmount,
    afterPartial.refundedAmount,
    "回池只改履约，不动退款累计",
  );

  return { user, orderId, afterRelease };
}

test("组合路径：部分退款 → 客服回池 → 用户直接退款，累计恰好退满实付（不超退）", async () => {
  const { user, orderId, afterRelease } = await partialRefundThenRelease();

  // ③ 直退入口按**状态**给，因此它此刻仍然出现——这是对的：
  //    这一单确实回到了「未开始服务」。错的是金额，所以金额必须由服务端算好给出
  const detail = await getOrderDetailForUser(orderId, user, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.allowedActions.canDirectRefund, true, "paid 单必须有直退入口");
  assert.equal(
    detail.allowedActions.directRefundAmountCents,
    afterRelease.actualPaidAmount - afterRelease.refundedAmount,
    "页面报的必须是**差额**，不是实付全额",
  );
  assert.equal(
    detail.allowedActions.alreadyRefundedAmountCents,
    afterRelease.refundedAmount,
    "已退额一并给出，页面才解释得清「为什么不是实付全额」",
  );

  // ④ 真的退一次：累计退到实付为止
  const result = await directRefundOrder(orderId, now());
  assert.equal(result.kind, "ok");

  const finalOrder = await orderOf(orderId);
  assert.equal(finalOrder.status, "refunded");
  assert.equal(
    finalOrder.refundedAmount,
    finalOrder.actualPaidAmount,
    "累计已退必须**恰好**等于实付：少了是没退满，多了是超退",
  );
  assert.equal(
    result.refundedAmount,
    finalOrder.actualPaidAmount,
    "返回值报的是累计已退，退满后与实付相等",
  );
});

test("组合路径：部分退款 → 客服回池 → 公共池超时，清扫只退差额（不超退）", async () => {
  const { orderId, afterRelease } = await partialRefundThenRelease();

  // ③ 回池后的派单记录：等别的护航来接，有公共池截止时刻
  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(dispatch, "回池后必须有派单记录");
  assert.equal(dispatch.state, "public", "回池的落点就是公共池");
  assert.ok(dispatch.publicDeadlineAt, "公共池必须有截止时刻");

  // ④ 跑到公共池截止之后：清扫自动退款，退的必须是差额
  const swept = sweepExpiredDispatches(dispatch.publicDeadlineAt);
  assert.equal(swept.refundedOrderIds.includes(orderId), true, "超时清扫应当退掉这一单");

  const finalOrder = await orderOf(orderId);
  assert.equal(finalOrder.status, "refunded");
  assert.equal(
    finalOrder.refundedAmount,
    finalOrder.actualPaidAmount,
    "清扫同样只退差额：累计恰好等于实付",
  );
  assert.ok(
    afterRelease.refundedAmount < finalOrder.actualPaidAmount,
    "这一条之所以有意义，正因为退之前累计已退**小于**实付",
  );
});

test("写入器护栏：即使调用方把「实付全额」当增量传，累计也不会超过实付", async () => {
  const { orderId } = await partialRefundThenRelease();
  const before = await orderOf(orderId);

  // 直接调用写原语，模拟「调用方算错了、传了实付全额」这种错法。
  // 这一层护栏的意义不是替调用方擦屁股，而是让 `refundedAmount <= actualPaidAmount`
  // 这条冻结约束**在唯一的写入点上成为结构性的**——
  // 而不是「每个调用方自己记得把增量算对」
  const written = applyOrderRefund(orderId, now(), before.actualPaidAmount);

  assert.ok(written);
  assert.equal(written.changed, true);
  assert.equal(
    written.updated.refundedAmount,
    before.actualPaidAmount,
    "传多了也只退到实付为止",
  );
  assert.equal(written.updated.status, "refunded");
});

// —————— 十、验收整改：订单金额快照与实时预览（P0-13 验收第 1 项，D19） ——————
//
// 这一节钉的是**界面与账本一致**这件事：
//
// 1. 详情 DTO 必须带上订单金额快照（基数 / 已退 / 剩余可退 / 双方收益），
//    否则管理员看不到「这个比例是谁的」；
// 2. `previewRefundDecisionAmounts()` 算出来的三个数，必须与
//    `approveRefund` **真正写进退款记录**的三个数逐项相等。
//
// 第 2 条是本节存在的理由：只要它红了，就说明界面上的「预计金额」与账上的钱
// 不是同一个公式算出来的——而那正是本次整改要消灭的歧义。

test("纯函数：D17「已提现不冲回」——只有 withdrawn 改写，null 与其它状态原样返回", () => {
  const amounts = { refundAmount: 3000, companionReversalAmount: 800, platformBorneAmount: 2200 };

  for (const status of [null, "frozen", "available", "reversed"]) {
    assert.deepEqual(
      resolveFinalDecisionAmounts(amounts, status),
      amounts,
      `${status} 必须原样返回：读一侧与写一侧只有这一个入口`,
    );
  }

  const withdrawn = resolveFinalDecisionAmounts(amounts, "withdrawn");
  assert.equal(withdrawn.refundAmount, 3000, "退款金额不变：退给用户的钱一分不少");
  assert.equal(withdrawn.companionReversalAmount, 0, "已提现的收益本轮不冲回");
  assert.equal(withdrawn.platformBorneAmount, 3000, "冲回掉的那 800 改由平台承担");
  assert.equal(
    withdrawn.refundAmount,
    withdrawn.companionReversalAmount + withdrawn.platformBorneAmount,
    "恒等式在任何分支下都必须成立（减法构造）",
  );

  // `null` 是 `serving` 单退款时的情形（D9：收益还没结算）。
  // 它**不能**被当成 withdrawn——那会让平台凭空少承担一笔本该冲回的钱
  assert.notDeepEqual(resolveFinalDecisionAmounts(amounts, null), withdrawn);
});

test("纯函数：已冲回额只认「已批准」的决策，且容忍没有决策的记录", () => {
  const decision = (amount) => ({ companionReversalAmount: amount });

  assert.equal(sumApprovedCompanionReversal([]), 0);
  assert.equal(
    sumApprovedCompanionReversal([
      { status: "approved", decision: decision(300) },
      { status: "approved", decision: decision(200) },
    ]),
    500,
    "多笔已批准要累加，不是取最后一条",
  );
  assert.equal(
    sumApprovedCompanionReversal([
      { status: "approved", decision: decision(300) },
      { status: "pending", decision: decision(999) },
      { status: "reviewing", decision: decision(999) },
      { status: "rejected", decision: decision(999) },
      { status: "cancelled", decision: decision(999) },
    ]),
    300,
    "只有已批准算数：没决策完与被驳回的申请一个字节都没动打手的钱",
  );
  // 已批准但决策为 null 属于不该出现的组合；这里要求的是**不抛错**，
  // 因为「读取侧挂在一条脏数据上」比「少算一笔」更难查
  assert.equal(sumApprovedCompanionReversal([{ status: "approved", decision: null }]), 0);
});

test("详情 DTO 带上订单金额快照：基数、已退与剩余可退都来自订单冻结快照", async () => {
  const { user, orderId, order } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  const detail = await getAdminRefundDetail(refundId, undefined, "server");
  assert.ok(detail);
  const money = detail.orderMoney;

  assert.equal(money.actualPaidAmount, order.actualPaidAmount, "比例的基数就是订单实付");
  assert.equal(money.originalAmount, order.originalAmount);
  assert.equal(money.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(money.refundedAmount, order.refundedAmount);
  assert.equal(
    money.remainingRefundableAmount,
    order.actualPaidAmount - order.refundedAmount,
    "剩余可退 = 实付 − 累计已退，与服务端金额闸用的是同一个算式",
  );
  assert.equal(money.companionBaseIncome, order.companionBaseIncome);
  assert.equal(money.clubNetIncome, order.clubNetIncome);
  assert.equal(money.reversedSoFarAmount, 0, "这笔是第一次退款，没有任何既往冲回");
  assert.equal(
    money.companionEarningStatus,
    "frozen",
    "completed 单的收益刚生成就是 frozen（还没有收益时才是 null）",
  );
});

test("退过一次之后：剩余可退与已冲回跟着变，第二次的预览才钳得住", async () => {
  const { user, orderId } = await completedOrder();
  const firstId = await requestRefund(orderId, user);
  const first = await approve(firstId, {
    refundRatePercent: "40",
    responsibility: "companion",
  });
  const firstDecision = (await refundOf(firstId)).decision;
  assert.ok(firstDecision);
  assert.ok(firstDecision.companionReversalAmount > 0, "这一条要有意义，冲回额必须大于 0");

  const afterFirst = await orderOf(orderId);
  assert.equal(afterFirst.refundedAmount, first.decidedAmount, "订单累计的就是本次退出去的数");

  const secondId = await requestRefund(orderId, user);
  const detail = await getAdminRefundDetail(secondId, undefined, "server");

  assert.equal(detail.orderMoney.refundedAmount, afterFirst.refundedAmount);
  assert.equal(
    detail.orderMoney.remainingRefundableAmount,
    afterFirst.actualPaidAmount - afterFirst.refundedAmount,
    "第二次的「还能退多少」必须扣掉第一次",
  );
  assert.equal(
    detail.orderMoney.reversedSoFarAmount,
    firstDecision.companionReversalAmount,
    "已冲回额读的是退款记录上的决策——与写入路径同一个函数",
  );
});

test("预览与服务端写下去的金额逐项相等（三种责任归属各一次）", async () => {
  const cases = [
    { label: "平台承担", body: { refundRatePercent: "30", responsibility: "platform" } },
    { label: "打手承担", body: { refundRatePercent: "30", responsibility: "companion" } },
    {
      label: "按比例分担",
      body: {
        refundRatePercent: "30",
        responsibility: "shared",
        companionLiabilityRatePercent: "40",
      },
    },
  ];

  for (const item of cases) {
    const { user, orderId } = await completedOrder();
    const refundId = await requestRefund(orderId, user);

    const detail = await getAdminRefundDetail(refundId, undefined, "server");
    const preview = previewRefundDecisionAmounts({
      orderMoney: detail.orderMoney,
      refundRatePercent: item.body.refundRatePercent,
      responsibility: item.body.responsibility,
      companionLiabilityRatePercent: item.body.companionLiabilityRatePercent ?? "",
    });
    assert.equal(preview.ok, true, `${item.label}：预览必须算得出来`);
    assert.equal(preview.exceedsPaid, false, `${item.label}：这组比例不该超限`);

    const written = await approve(refundId, item.body);
    const stored = (await refundOf(refundId)).decision;
    assert.ok(stored);

    assert.equal(
      preview.amounts.refundAmount,
      written.decidedAmount,
      `${item.label}：退款金额——界面上的预计值与响应里的一致`,
    );
    assert.equal(
      preview.amounts.refundAmount,
      stored.refundAmount,
      `${item.label}：退款金额——与真正写进退款记录的决策一致`,
    );
    assert.equal(
      preview.amounts.companionReversalAmount,
      stored.companionReversalAmount,
      `${item.label}：打手冲回额——与写下去的一致`,
    );
    assert.equal(
      preview.amounts.platformBorneAmount,
      stored.platformBorneAmount,
      `${item.label}：平台承担额——与写下去的一致`,
    );
  }
});

test("预览的「超过剩余可退」与服务端金额闸是同一个判断", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  // 先退掉一大部分，把剩余额度压小
  await approve(refundId, { refundRatePercent: "90", responsibility: "platform" });
  const afterFirst = await orderOf(orderId);
  const remaining = afterFirst.actualPaidAmount - afterFirst.refundedAmount;
  assert.ok(remaining > 0, "这一条要有意义，剩余额度必须还有一点");

  const secondId = await requestRefund(orderId, user);
  const detail = await getAdminRefundDetail(secondId, undefined, "server");

  // 用一个注定超限的比例（剩余额度必然小于实付）
  const preview = previewRefundDecisionAmounts({
    orderMoney: detail.orderMoney,
    refundRatePercent: "100",
    responsibility: "platform",
    companionLiabilityRatePercent: "",
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.exceedsPaid, true, "100% 一定超过剩余可退");

  // 服务端给出的是**同一个判断**的另一种表达：它拒绝，并说明原因
  await assert.rejects(
    approve(secondId, { refundRatePercent: "100", responsibility: "platform" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_EXCEEDS_PAID_MESSAGE);
      return true;
    },
  );
});

test("预览：字段没填全时说「还没算出来」，填错时说规则层那句话", () => {
  const money = {
    originalAmount: 5000,
    couponDiscountAmount: 0,
    actualPaidAmount: 5000,
    refundedAmount: 2000,
    remainingRefundableAmount: 3000,
    companionBaseIncome: 2000,
    clubNetIncome: 3000,
    reversedSoFarAmount: 0,
    companionEarningStatus: "frozen",
  };

  // 什么都没填：比例缺失
  const empty = previewRefundDecisionAmounts({
    orderMoney: money,
    refundRatePercent: "",
    responsibility: "",
    companionLiabilityRatePercent: "",
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);

  // 填了比例没选责任：文案必须说「请选择责任归属」，不能静默按平台承担算
  const noResponsibility = previewRefundDecisionAmounts({
    orderMoney: money,
    refundRatePercent: "30",
    responsibility: "",
    companionLiabilityRatePercent: "",
  });
  assert.equal(noResponsibility.ok, false);
  assert.equal(noResponsibility.message, REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE);

  // 填了比例、选了分担、没填责任比例
  const noLiability = previewRefundDecisionAmounts({
    orderMoney: money,
    refundRatePercent: "30",
    responsibility: "shared",
    companionLiabilityRatePercent: "",
  });
  assert.equal(noLiability.ok, false);
  assert.equal(noLiability.message, REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE);

  // 非分担制却带了责任比例：预览与服务端一样**报错**，不静默忽略
  const unexpected = previewRefundDecisionAmounts({
    orderMoney: money,
    refundRatePercent: "30",
    responsibility: "platform",
    companionLiabilityRatePercent: "40",
  });
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.message, REFUND_DECISION_LIABILITY_UNEXPECTED_MESSAGE);
});

test("预览：收益已提现时冲回 0、平台承担全部（D17），且不越过钳制上限", () => {
  const base = {
    originalAmount: 5000,
    couponDiscountAmount: 0,
    actualPaidAmount: 5000,
    refundedAmount: 0,
    remainingRefundableAmount: 5000,
    companionBaseIncome: 2000,
    clubNetIncome: 3000,
    reversedSoFarAmount: 0,
  };

  const withdrawn = previewRefundDecisionAmounts({
    orderMoney: { ...base, companionEarningStatus: "withdrawn" },
    refundRatePercent: "50",
    responsibility: "companion",
    companionLiabilityRatePercent: "",
  });
  assert.equal(withdrawn.ok, true);
  assert.equal(withdrawn.amounts.refundAmount, 2500);
  assert.equal(withdrawn.amounts.companionReversalAmount, 0, "已提现：一分都不冲回");
  assert.equal(withdrawn.amounts.platformBorneAmount, 2500);

  // 钳制上限：已有 1800 冲回、基数 2000，本次最多只能再冲 200
  const clamped = previewRefundDecisionAmounts({
    orderMoney: { ...base, reversedSoFarAmount: 1800, companionEarningStatus: "available" },
    refundRatePercent: "100",
    responsibility: "companion",
    companionLiabilityRatePercent: "",
  });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.amounts.companionReversalAmount, 200, "累计冲回不得超过打手收益");
  assert.equal(
    clamped.amounts.refundAmount,
    clamped.amounts.companionReversalAmount + clamped.amounts.platformBorneAmount,
    "钳制之后恒等式仍然成立",
  );
});
