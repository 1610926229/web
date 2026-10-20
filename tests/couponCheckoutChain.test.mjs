import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  COUPON_NOT_FOUND_MESSAGE,
  COUPON_USE_DISABLED_REASON,
  COUPON_USE_EXPIRED_REASON,
  COUPON_USE_NOT_STARTED_REASON,
  COUPON_USE_UNSUPPORTED_REASON,
  COUPON_USE_USED_REASON,
  couponThresholdNotMetReason,
} from "../lib/constants/coupons.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  computeRefundDecisionAmounts,
  isFullyRefunded,
  platformNetIncome,
} from "../lib/constants/refunds.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder } from "../lib/data/companionOrderTransaction.ts";
import { approveCompletion, submitCompletion } from "../lib/data/completionTransaction.ts";
import { getCouponRepository } from "../lib/data/couponRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { couponStore } from "../lib/data/mockCouponRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { approveAdminRefund, getAdminRefundDetail } from "../lib/services/adminRefunds.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { claimCouponForUser } from "../lib/services/coupons.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { createRefundForOrder, getRefundDetailForUser } from "../lib/services/refunds.ts";
import { getStaffRefundDetail } from "../lib/services/staffRefunds.ts";
import { resolveSource } from "./app-path.mjs";
import { readSource, stripComments } from "./source-text.mjs";

/**
 * P1-4「券进入结算链路」的**服务层 / 端到端**测试。
 *
 * ## 这个文件补的是什么
 *
 * `tests/couponMoneyChain.test.mjs` 已经在**纯函数**层钉住了券的金额公式
 * （券不改变原价 / 不降低打手收益 / 平台承担 / 退款基数是实付……），
 * `tests/coupons.test.mjs` 钉住了**领取**侧（隔离、幂等、并发、可领取判定）。
 * 两者之间还空着一整层：**这些公式在真实下单 / 支付 / 订单 / 退款链路上
 * 是不是真的这样被调用**。本文件只补这一层：
 *
 * 1. **核销语义（裁定 §5）**——`preview` 反复试算不消耗券；券只在支付成功的
 *    原子区段里从 `unused → used`；同一张券**只能成功核销一次**；
 * 2. **拒绝语义（裁定 §1/§2/D-P1-4-5）**——停用 / 过期 / 未开始 / 非满减券
 *    在**试算与下单两个入口**都表现为「一句明确的报错」，不静默按 0 元成交；
 * 3. **门槛边界（裁定 §2）**——正好等于门槛可用、差 1 分被拒、超门槛抵扣为面额；
 * 4. **preview 与 create 同口径（D-P1-4-6）**——两者算出的金额逐字段相等；
 * 5. **改券不追溯（裁定 §9）**——先下单用券、后台再改券模板，历史订单金额与
 *    券展示一个字不变；
 * 6. **退款链路（裁定 §6/§10）**——有券订单的 10% / 50% / 100% 退款退的是
 *    **实付**、不是原价；退款不退券；打手净额 0；平台净收入 = 实付 − 退款额；
 * 7. **三处展示同源（cmd 第 17 项）**——结算试算 / 订单详情 / 管理端退款详情
 *    给出的实付金额是同一个数；
 * 8. **券相关 DTO 的键集合（cmd 第 15 项）**。
 *
 * ## 为什么用真实实现
 *
 * 全部走 `lib/services/checkout.ts` 与真实的 Mock 仓储。没有任何一处把业务逻辑
 * 抄进测试再比对——那种写法只能证明「两份拷贝一样」。
 *
 * ## ⚠️ 时间是被**钉住**的，而且是数据层的
 *
 * 券的有效期在领券 / 结算两侧都由**当前时间**判定。领取侧的 `claimCouponForUser`
 * 支持传 `now`（本文件传 `CLAIM_NOW`），但**结算侧的 `previewCheckout` /
 * `createPaymentRequest` 没有 `now` 参数**——它们内部用 `new Date()`。
 * 种子券的 `validTo` 是 2026-12-31，直接依赖真实时间会让本文件在 2027 年集体变红，
 * 而那与「券的金额算得对不对」毫无关系。
 *
 * 因此下面凡是需要「一张可用的券」的地方，都在**数据层**把这张领取记录的
 * 快照有效期放宽到 `WIDE_FROM ~ WIDE_TO`（改的是夹具数据，不是判定逻辑）。
 * 有效期本身的分档语义（未开始 / 已过期 / 停用）在 `tests/coupons.test.mjs`
 * 用注入的 `now` 单独覆盖，本文件不重复。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const UNIT_PRICE = 2990;
/** 满减券种子：满 10000 减 1000（整数分）。 */
const THRESHOLD_COUPON = "cpn-mock-new-user";
/** 折扣券种子：`formKey === "discount"`，两个可计算字段恒为 null。 */
const DISCOUNT_COUPON = "cpn-mock-holiday";
/** 走满 10000 门槛需要 4 份：2990 × 4 = 11960。 */
const QUANTITY = 4;
const ORIGINAL_AMOUNT = UNIT_PRICE * QUANTITY;

const COMPANION = "cp-1";
const STAFF = { id: "staff-1", name: "客服小雨" };
const ADMIN = "admin-1";

/** 领取时刻（显式钉死，避免依赖真实时间）。 */
const CLAIM_NOW = new Date("2026-09-13T12:00:00.000Z");
/** 夹具放宽后的有效期：足够远的两端，让结算侧的真实 `new Date()` 落在里面。 */
const WIDE_FROM = "2020-01-01T00:00:00.000Z";
const WIDE_TO = "2099-12-31T15:59:59.000Z";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function uniqueKey() {
  return unique("cpnchk");
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
  resetMockStore("coupon");
});

// ——————————————————————————— 夹具与辅助 ———————————————————————————

function selection(overrides = {}) {
  return {
    productId: PRODUCT.productId,
    specId: PRODUCT.specId,
    quantity: QUANTITY,
    region: PRODUCT.region,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
    couponClaimId: null,
    ...overrides,
  };
}

function preview(input = {}) {
  return previewCheckout(selection(input), input.userId ?? "u-1", undefined, "server");
}

function create(input = {}) {
  return createPaymentRequest({ ...selection(input), idempotencyKey: uniqueKey() }, input.userId);
}

/** 就地改一条券模板，返回还原函数。存储里的对象是共享的，必须还原。 */
function patchCouponTemplate(couponId, patch) {
  const record = couponStore().coupons.get(couponId);
  assert.ok(record, `预置券模板 ${couponId} 必须存在`);
  const original = { ...record };
  Object.assign(record, patch);
  return () => {
    Object.assign(record, original);
  };
}

/** 就地改一张领取记录（含快照），返回还原函数。 */
function patchClaim(claimId, patch) {
  const record = couponStore().claims.get(claimId);
  assert.ok(record, `领取记录 ${claimId} 必须存在`);
  const original = { ...record, snapshot: { ...record.snapshot } };
  Object.assign(record, patch);
  return () => {
    Object.assign(record, original);
    record.snapshot = original.snapshot;
  };
}

/**
 * 给一个用户领一张可用的满减券，并把它**夹具层的**有效期放宽到远未来。
 *
 * 见文件头：结算侧没有 `now` 注入，放宽快照有效期是本文件让用例不随时钟变红的
 * 唯一手段。改的是数据，判定逻辑一行没动。
 */
async function issueUsableCoupon(userId, couponId = THRESHOLD_COUPON) {
  const { claimId } = await claimCouponForUser(
    userId,
    couponId,
    { idempotencyKey: uniqueKey() },
    "server",
    undefined,
    CLAIM_NOW,
  );
  patchClaim(claimId, { snapshot: { ...couponStore().claims.get(claimId).snapshot, validFrom: WIDE_FROM, validTo: WIDE_TO } });
  return claimId;
}

function claimOf(userId, claimId) {
  return getCouponRepository().findClaimById(userId, claimId);
}

/** 走完「下单 → 支付」，返回订单（不推进履约）。 */
async function paidOrder(input = {}) {
  const user = input.userId;
  const draft = await preview({ ...input, userId: user });
  const created = await create(input);
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true, "前置：这张订单必须创建成功");
  return { user, preview: draft, request: created.request, order: confirmed.order };
}

/**
 * 一张**用了满减券且已经完成**的订单（退款审批要求订单到 `completed` / `serving`）。
 *
 * 时刻关系与 `tests/refundMoneyChain.test.mjs` 的同类辅助保持一致。
 */
async function completedCouponOrder() {
  const user = unique("u-cpn-completed");
  const claimId = await issueUsableCoupon(user);
  const { preview: draft, request, order } = await paidOrder({ userId: user, couponClaimId: claimId });

  assert.ok(order.coupon, "前置：订单上必须冻结了券快照");
  assert.equal(order.coupon.claimId, claimId);
  assert.ok(order.couponDiscountAmount > 0, "前置：这一单真的减了钱");
  assert.equal(order.actualPaidAmount, order.originalAmount - order.couponDiscountAmount);

  const completedAt = plusMinutes(new Date().toISOString(), 62);
  const dispatch = await getDispatchRepository().findDispatchByOrderId(order.id);
  assert.ok(dispatch, "前置：支付成功后必须有派单记录");
  assert.equal(
    (await acceptDispatch(dispatch.id, { companionId: COMPANION, at: plusMinutes(completedAt, -41) }))
      .kind,
    "ok",
  );
  assert.equal(
    (await startCompanionOrder({ companionId: COMPANION, orderId: order.id, at: plusMinutes(completedAt, -21) }))
      .kind,
    "ok",
  );
  const submitted = await submitCompletion({
    companionId: COMPANION,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -11),
  });
  assert.equal(submitted.kind, "ok");
  assert.equal(
    (await approveCompletion({
      submissionId: submitted.submissionId,
      staffId: STAFF.id,
      staffName: STAFF.name,
      at: completedAt,
    })).kind,
    "ok",
  );

  const completed = await getPaymentRepository().findOrderById(order.id);
  assert.equal(completed.status, "completed", "前置：订单必须走到 completed");
  return { user, claimId, request, preview: draft, order: completed };
}

async function requestRefund(orderId, user) {
  const { refundId } = await createRefundForOrder(
    orderId,
    user,
    {
      reasonKey: "other",
      description: "临时有事，这一单打不了了，麻烦帮我退掉。",
      evidence: [],
      idempotencyKey: uniqueKey(),
    },
    undefined,
    "server",
  );
  return refundId;
}

function approve(refundId, percent) {
  return approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: uniqueKey(),
    refundRatePercent: String(percent),
  });
}

// —————————————————— 一、§5 核销语义：preview 不消耗、只核销一次 ——————————————————

test("preview 反复试算不消耗券：领取记录仍是 unused，usedAt 仍是 null", async () => {
  const user = unique("u-preview");
  const claimId = await issueUsableCoupon(user);

  const before = await claimOf(user, claimId);
  assert.equal(before.status, "unused", "前置：刚领到的券是未使用");

  // Mock 存储里带着种子数据，因此比的是**增量**，不是绝对数
  const requestsBefore = paymentStore().paymentRequests.size;
  const ordersBefore = paymentStore().orders.size;

  // 反复试算：改数量再来一次、原样再来一次——试算是**只读**的
  const first = await preview({ userId: user, couponClaimId: claimId });
  const second = await preview({ userId: user, couponClaimId: claimId });
  const bigger = await preview({ userId: user, couponClaimId: claimId, quantity: 8 });

  assert.equal(first.couponDiscountAmount, 1000);
  assert.equal(second.couponDiscountAmount, 1000);
  assert.equal(bigger.couponDiscountAmount, 1000);

  const after = await claimOf(user, claimId);
  assert.equal(after.status, "unused", "试算不得消耗券——核销只发生在支付成功的原子区段里");
  assert.equal(after.usedAt, null, "试算不得写下核销时刻");
  // 试算是只读的：不新建支付请求，也不建订单
  assert.equal(paymentStore().paymentRequests.size, requestsBefore, "试算不得创建支付请求");
  assert.equal(paymentStore().orders.size, ordersBefore, "试算不得创建订单");
});

test("支付成功那一刻才核销：领取记录变 used、usedAt 写入，订单券快照指向它", async () => {
  const user = unique("u-redeem");
  const claimId = await issueUsableCoupon(user);

  // ① 建支付请求**不**核销：此刻还只是「用户选了一张券」
  const created = await create({ userId: user, couponClaimId: claimId });
  assert.equal(created.request.coupon.claimId, claimId);
  assert.equal((await claimOf(user, claimId)).status, "unused", "建支付请求不得核销券");

  // ② 支付成功 → 核销
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true);

  const redeemed = await claimOf(user, claimId);
  assert.equal(redeemed.status, "used");
  assert.equal(typeof redeemed.usedAt, "string", "核销必须写下时刻");
  assert.equal(confirmed.order.coupon.claimId, claimId, "订单券快照指向被核销的那张领取记录");
  assert.equal(confirmed.order.coupon.couponId, THRESHOLD_COUPON);
});

test("支付失败 / 取消不核销券：券仍是 unused，可再次使用", async () => {
  for (const result of ["failure", "cancel"]) {
    const user = unique(`u-fail-${result}`);
    const claimId = await issueUsableCoupon(user);
    const created = await create({ userId: user, couponClaimId: claimId });
    const settled = await confirmPaymentRequest(created.request.id, result, user);

    assert.equal(settled.orderCreated, false);
    const claim = await claimOf(user, claimId);
    assert.equal(claim.status, "unused", `${result}：失败的支付不得把券永久标记 used`);
    assert.equal(claim.usedAt, null);

    // 正面：同一张券随后**真的**能用成一次
    const retry = await create({ userId: user, couponClaimId: claimId });
    const ok = await confirmPaymentRequest(retry.request.id, "success", user);
    assert.equal(ok.orderCreated, true, `${result} 之后这张券必须还能用`);
    assert.equal((await claimOf(user, claimId)).status, "used");
  }
});

test("同一张券只能成功核销一次：第二笔用同一 claim 下单被拒，且不留下支付请求与订单", async () => {
  const user = unique("u-once");
  const claimId = await issueUsableCoupon(user);

  const first = await create({ userId: user, couponClaimId: claimId });
  const confirmed = await confirmPaymentRequest(first.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true);

  const ordersBefore = [...paymentStore().orders.values()].filter((item) => item.userId === user).length;
  const key = uniqueKey();

  await assert.rejects(
    () =>
      createPaymentRequest(
        { ...selection({ couponClaimId: claimId }), idempotencyKey: key },
        user,
      ),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_USE_USED_REASON);
      return true;
    },
    "已核销的券必须被服务端明确拒绝，而不是静默按原价成交",
  );

  // 被拒的请求不留痕迹
  assert.equal(await getPaymentRepository().findPaymentRequestByKey(user, key), null);
  assert.equal(
    [...paymentStore().orders.values()].filter((item) => item.userId === user).length,
    ordersBefore,
    "被拒的下单不得多出订单",
  );

  // 正面 ①：同一用户再领同一张券，拿到的是**同一条**领取记录（§5 一人一券只有一张），
  //          它已经 used，所以不会「再发一张新的」把上面的拒绝绕过去。
  const reclaim = await issueUsableCoupon(user);
  assert.equal(reclaim, claimId, "同一用户同一张券只能有一条领取记录");
  assert.equal((await claimOf(user, reclaim)).status, "used");

  // 正面 ②：换一个用户领同一张券仍然能正常用——拒绝的是「这张券」，不是「这张券模板」。
  const other = unique("u-once-other");
  const otherClaim = await issueUsableCoupon(other);
  assert.notEqual(otherClaim, claimId);
  const ok = await create({ userId: other, couponClaimId: otherClaim });
  assert.equal(ok.request.coupon.claimId, otherClaim);
  assert.equal(ok.request.couponDiscountAmount, 1000);
});

test("双花防线：同一张券建两笔待支付请求，第二笔支付成功被拒、不建单也不二次核销", async () => {
  const user = unique("u-double");
  const claimId = await issueUsableCoupon(user);

  // 两笔请求都合法地创建出来（建请求时券还是 unused）——这正是真实的双花窗口
  const first = await create({ userId: user, couponClaimId: claimId });
  const second = await create({ userId: user, couponClaimId: claimId });
  assert.equal(first.request.coupon.claimId, claimId);
  assert.equal(second.request.coupon.claimId, claimId);

  const okFirst = await confirmPaymentRequest(first.request.id, "success", user);
  assert.equal(okFirst.orderCreated, true);
  const usedAtAfterFirst = (await claimOf(user, claimId)).usedAt;
  const ordersAfterFirst = [...paymentStore().orders.values()].filter(
    (item) => item.userId === user,
  ).length;

  await assert.rejects(
    () => confirmPaymentRequest(second.request.id, "success", user),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_USE_USED_REASON);
      return true;
    },
    "第二笔必须在建单之前复查券状态，抛错而不是核销第二次",
  );

  // 第二笔没建单：这一单的支付请求仍是 pending，也没有订单
  const secondRequest = await getPaymentRepository().findPaymentRequestById(second.request.id);
  assert.equal(secondRequest.status, "pending");
  assert.equal(secondRequest.orderId, null);
  const redeemed = await claimOf(user, claimId);
  assert.equal(redeemed.status, "used");
  assert.equal(redeemed.usedAt, usedAtAfterFirst, "核销时刻不得被第二笔覆盖——只核销了一次");
  assert.equal(
    [...paymentStore().orders.values()].filter((item) => item.userId === user).length,
    ordersAfterFirst,
    "被拒的第二笔不得多出订单",
  );
});

// —————————————————— 二、金额一致性：preview 与 create 同口径 ——————————————————

test("有券下单：preview 与 create 算出的金额逐字段一致，订单金额等于预估值", async () => {
  const user = unique("u-amount");
  const claimId = await issueUsableCoupon(user);

  const draft = await preview({ userId: user, couponClaimId: claimId });

  assert.equal(draft.originalAmount, ORIGINAL_AMOUNT, "门槛基数是优惠前应付");
  assert.equal(draft.couponDiscountAmount, 1000);
  assert.equal(draft.actualPaidAmount, ORIGINAL_AMOUNT - 1000);
  assert.equal(draft.couponReason, "", "券可用时没有「未生效的原因」");
  assert.equal(draft.coupon.applicable, true);
  assert.equal(draft.coupon.claimId, claimId);
  // 券没有改变原价：原价仍是「商品金额 + 增值服务金额」
  assert.equal(draft.originalAmount, UNIT_PRICE * QUANTITY);

  const created = await create({ userId: user, couponClaimId: claimId });
  // —— 同口径：两者用的是同一个 `resolveCouponApplication()` / 同一个金额合成点 ——
  assert.equal(created.request.totalAmount, draft.originalAmount);
  assert.equal(created.request.couponDiscountAmount, draft.couponDiscountAmount);
  assert.equal(created.request.actualPaidAmount, draft.actualPaidAmount);
  assert.deepEqual(created.request.coupon, {
    claimId,
    couponId: THRESHOLD_COUPON,
    name: draft.coupon.name,
    formKey: "threshold",
    thresholdAmount: 10_000,
    discountAmount: 1000,
    valueLabel: draft.coupon.valueLabel,
    conditionLabel: draft.coupon.conditionLabel,
  });

  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  const order = confirmed.order;

  assert.equal(order.originalAmount, draft.originalAmount);
  assert.equal(order.couponDiscountAmount, draft.couponDiscountAmount);
  assert.equal(order.actualPaidAmount, draft.actualPaidAmount);
  assert.equal(order.totalAmount, order.originalAmount, "totalAmount 仍是**优惠前**应付总额");
  assert.deepEqual(order.coupon, created.request.coupon, "订单上的券快照与请求上冻结的那份逐字段相同");

  // 恒等式在有券时仍然成立，且全部是整数分
  assert.equal(order.companionRateSnapshot > 0, true);
  assert.equal(order.companionBaseIncome + order.clubNetIncome, order.actualPaidAmount);
  for (const amount of [
    order.originalAmount,
    order.couponDiscountAmount,
    order.actualPaidAmount,
    order.companionBaseIncome,
    order.clubNetIncome,
  ]) {
    assert.ok(Number.isInteger(amount), "金额必须是整数分");
  }
  // 券由平台承担：打手收益按**原价**分，因此平台净收入比无券时低（可以更低甚至为负）
  assert.equal(
    order.companionBaseIncome,
    Math.floor((order.originalAmount * order.companionRateSnapshot) / 10000),
    "券不得降低打手收益的理论基础",
  );
});

test("门槛边界：正好等于门槛可用、差 1 分被拒（两个入口都给同一句原因）", async () => {
  // —— ① 正好等于门槛：可用 ——
  const userEq = unique("u-bound-eq");
  const claimEq = await issueUsableCoupon(userEq);
  patchClaim(claimEq, {
    snapshot: { ...couponStore().claims.get(claimEq).snapshot, thresholdAmount: ORIGINAL_AMOUNT },
  });
  const eq = await preview({ userId: userEq, couponClaimId: claimEq });
  assert.equal(eq.coupon.applicable, true, "原价恰好等于门槛时必须可用");
  assert.equal(eq.couponDiscountAmount, 1000);
  assert.equal(eq.actualPaidAmount, ORIGINAL_AMOUNT - 1000);

  // —— ② 差 1 分：拒绝，且两个入口说的是同一句话 ——
  const userBelow = unique("u-bound-below");
  const claimBelow = await issueUsableCoupon(userBelow);
  patchClaim(claimBelow, {
    snapshot: { ...couponStore().claims.get(claimBelow).snapshot, thresholdAmount: ORIGINAL_AMOUNT + 1 },
  });
  const reason = couponThresholdNotMetReason(ORIGINAL_AMOUNT, ORIGINAL_AMOUNT + 1);

  const below = await preview({ userId: userBelow, couponClaimId: claimBelow });
  assert.equal(below.coupon.applicable, false);
  assert.equal(below.couponDiscountAmount, 0, "未达门槛不得静默按 0 元优惠继续");
  assert.equal(below.actualPaidAmount, ORIGINAL_AMOUNT);
  assert.equal(below.couponReason, reason, "试算要把「还差多少」告诉用户");
  assert.equal(below.coupon.reason, reason);

  await assert.rejects(
    () => create({ userId: userBelow, couponClaimId: claimBelow }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, reason, "下单入口必须给同一句话（同一个判定函数）");
      return true;
    },
  );
  assert.equal((await claimOf(userBelow, claimBelow)).status, "unused", "被拒不得核销");

  // —— ③ 超门槛 1 分：可用，抵扣就是面额 ——
  const userAbove = unique("u-bound-above");
  const claimAbove = await issueUsableCoupon(userAbove);
  patchClaim(claimAbove, {
    snapshot: { ...couponStore().claims.get(claimAbove).snapshot, thresholdAmount: ORIGINAL_AMOUNT - 1 },
  });
  const above = await preview({ userId: userAbove, couponClaimId: claimAbove });
  assert.equal(above.coupon.applicable, true);
  assert.equal(above.couponDiscountAmount, 1000);
});

test("面额大过原价：抵扣夹到原价，实付为 0 而不是负数", async () => {
  const user = unique("u-cap");
  const claimId = await issueUsableCoupon(user);
  patchClaim(claimId, {
    snapshot: {
      ...couponStore().claims.get(claimId).snapshot,
      thresholdAmount: 1000,
      discountAmount: ORIGINAL_AMOUNT + 50_000,
    },
  });

  const draft = await preview({ userId: user, couponClaimId: claimId });
  assert.equal(draft.coupon.applicable, true, "面额大于原价是封顶，不是拒绝");
  assert.equal(draft.couponDiscountAmount, ORIGINAL_AMOUNT, "抵扣被夹到原价");
  assert.equal(draft.actualPaidAmount, 0);
  assert.ok(draft.actualPaidAmount >= 0, "实付不得为负");

  const created = await create({ userId: user, couponClaimId: claimId });
  assert.equal(created.request.actualPaidAmount, 0);
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.order.actualPaidAmount, 0);
  assert.equal(confirmed.order.clubNetIncome, -confirmed.order.companionBaseIncome, "平台全额承担");
  assert.ok(confirmed.order.clubNetIncome < 0, "平台净收入可以为负，不得夹到 0");
  // 渠道收 0 元：支付记录也必须是实付
  const payment = [...paymentStore().payments.values()].find((item) => item.orderId === confirmed.order.id);
  assert.ok(payment);
  assert.equal(payment.amount, 0);
});

test("未达门槛的券仍出现在 availableCoupons 里（用户能看到还差多少），未选中时不报原因", async () => {
  const user = unique("u-list");
  await issueUsableCoupon(user);

  // 数量 1：2990 < 10000 —— 这张券未达门槛，但**必须列出来**
  const draft = await preview({ userId: user, quantity: 1, couponClaimId: null });
  assert.equal(draft.couponDiscountAmount, 0);
  assert.equal(draft.coupon, null, "没选券就没有「选中的券」");
  assert.equal(draft.couponReason, "", "没选券就不该报一个原因出来");

  const option = draft.availableCoupons.find((item) => item.claimId);
  assert.ok(option, "未达门槛的券必须留在列表里——否则用户会一直找「我刚领的券去哪了」");
  assert.equal(option.applicable, false);
  assert.equal(option.discountAmount, 0);
  assert.equal(option.reason, couponThresholdNotMetReason(1 * UNIT_PRICE, 10_000));
});

// —————————————————— 三、拒绝语义：四种不可用券，两个入口 ——————————————————

test("已停用的券（领取后被后台停用）：preview 报原因、create 抛 400", async () => {
  const user = unique("u-disabled");
  const claimId = await issueUsableCoupon(user);

  const restore = patchCouponTemplate(THRESHOLD_COUPON, { enabled: false });
  try {
    const draft = await preview({ userId: user, couponClaimId: claimId });
    assert.equal(draft.coupon.applicable, false);
    assert.equal(draft.couponDiscountAmount, 0);
    assert.equal(draft.couponReason, COUPON_USE_DISABLED_REASON);
    assert.equal(draft.coupon.reason, COUPON_USE_DISABLED_REASON);
    assert.equal(
      draft.availableCoupons.some((item) => item.claimId === claimId),
      false,
      "停用的券不该出现在可选列表里",
    );

    await assert.rejects(
      () => create({ userId: user, couponClaimId: claimId }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.message, COUPON_USE_DISABLED_REASON);
        return true;
      },
      "绕过界面直接下单也必须被拒",
    );
    assert.equal((await claimOf(user, claimId)).status, "unused", "被拒不得核销");
  } finally {
    restore();
  }

  // 还原之后这张券又能用了 —— 证明上面红的是「停用」，不是别的原因
  const restored = await preview({ userId: user, couponClaimId: claimId });
  assert.equal(restored.coupon.applicable, true);
});

test("已过期的券：preview 报原因、create 抛 400", async () => {
  const user = unique("u-expired");
  const claimId = await issueUsableCoupon(user);
  const restore = patchClaim(claimId, {
    snapshot: { ...couponStore().claims.get(claimId).snapshot, validTo: "2026-08-31T15:59:59.000Z" },
  });
  try {
    const draft = await preview({ userId: user, couponClaimId: claimId });
    assert.equal(draft.coupon.applicable, false);
    assert.equal(draft.couponDiscountAmount, 0);
    assert.equal(draft.couponReason, COUPON_USE_EXPIRED_REASON);

    await assert.rejects(
      () => create({ userId: user, couponClaimId: claimId }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.message, COUPON_USE_EXPIRED_REASON);
        return true;
      },
    );
  } finally {
    restore();
  }

  const restored = await preview({ userId: user, couponClaimId: claimId });
  assert.equal(restored.coupon.applicable, true);
});

test("尚未开始的券：preview 报原因、create 抛 400", async () => {
  const user = unique("u-upcoming");
  const claimId = await issueUsableCoupon(user);
  const restore = patchClaim(claimId, {
    snapshot: { ...couponStore().claims.get(claimId).snapshot, validFrom: "2098-01-01T00:00:00.000Z" },
  });
  try {
    const draft = await preview({ userId: user, couponClaimId: claimId });
    assert.equal(draft.coupon.applicable, false);
    assert.equal(draft.couponDiscountAmount, 0);
    assert.equal(draft.couponReason, COUPON_USE_NOT_STARTED_REASON);

    await assert.rejects(
      () => create({ userId: user, couponClaimId: claimId }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.message, COUPON_USE_NOT_STARTED_REASON);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("折扣券（非满减）不参与结算：两个入口都报「类型不支持」，不按 0 元成交", async () => {
  const user = unique("u-discount");
  const claimId = await issueUsableCoupon(user, DISCOUNT_COUPON);

  const draft = await preview({ userId: user, couponClaimId: claimId });
  assert.equal(draft.coupon.applicable, false);
  assert.equal(draft.couponDiscountAmount, 0, "不得静默按 0 元优惠继续下单");
  assert.equal(draft.actualPaidAmount, ORIGINAL_AMOUNT);
  assert.equal(draft.couponReason, COUPON_USE_UNSUPPORTED_REASON);
  assert.equal(
    draft.availableCoupons.some((item) => item.claimId === claimId),
    false,
    "不可计算的券不该出现在可选列表里",
  );

  await assert.rejects(
    () => create({ userId: user, couponClaimId: claimId }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_USE_UNSUPPORTED_REASON);
      return true;
    },
  );
  assert.equal((await claimOf(user, claimId)).status, "unused", "被拒不得核销");
});

test("别人的券不能用：拿别人的 claimId 下单在两个入口都被拒，且不泄露券面", async () => {
  const owner = unique("u-owner");
  const ownerClaim = await issueUsableCoupon(owner);
  const intruder = unique("u-intruder");

  const draft = await preview({ userId: intruder, couponClaimId: ownerClaim });
  assert.equal(draft.coupon, null, "查不到就当作没这张券——不能把别人的券面回给攻击者");
  assert.equal(draft.couponDiscountAmount, 0);
  assert.equal(draft.actualPaidAmount, ORIGINAL_AMOUNT);
  assert.equal(draft.couponReason, COUPON_NOT_FOUND_MESSAGE);

  await assert.rejects(
    () => create({ userId: intruder, couponClaimId: ownerClaim }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_NOT_FOUND_MESSAGE);
      return true;
    },
    "归属必须是查询条件的一部分，不能先按 id 查出来再比对 userId",
  );

  // 正面：券的归属者对同一张券完全正常
  const mine = await preview({ userId: owner, couponClaimId: ownerClaim });
  assert.equal(mine.coupon.applicable, true);
  assert.equal(mine.couponDiscountAmount, 1000);
  assert.equal((await claimOf(owner, ownerClaim)).status, "unused", "别人试一次不得动到我的券");
});

test("不存在的 claimId：同样被拒，且不建单", async () => {
  const user = unique("u-ghost");
  await assert.rejects(
    () => create({ userId: user, couponClaimId: "claim-does-not-exist" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_NOT_FOUND_MESSAGE);
      return true;
    },
  );
});

// —————————————————— 四、改券不追溯历史订单（裁定 §9） ——————————————————

test("后台改券模板：已下单的金额与券展示一个字不变，新领取的券才用新值", async () => {
  const user = unique("u-history");
  const claimId = await issueUsableCoupon(user);
  const { order } = await paidOrder({ userId: user, couponClaimId: claimId });

  const snapshotBefore = { ...order.coupon };
  const restore = patchCouponTemplate(THRESHOLD_COUPON, {
    name: "改过的券名（Mock）",
    valueLabel: "满 200 减 50",
    conditionLabel: "改过的条件文案",
    thresholdAmount: 20_000,
    discountAmount: 5_000,
  });
  try {
    // ① 订单本身（仓储里的那份）
    const after = await getPaymentRepository().findOrderById(order.id);
    assert.deepEqual(after.coupon, snapshotBefore, "历史订单的券展示必须原样冻结");
    assert.equal(after.couponDiscountAmount, order.couponDiscountAmount, "金额一个字不变");
    assert.equal(after.actualPaidAmount, order.actualPaidAmount);
    assert.equal(after.originalAmount, order.originalAmount);
    assert.equal(after.companionBaseIncome, order.companionBaseIncome);
    assert.equal(after.clubNetIncome, order.clubNetIncome);

    // ② 用户端详情 DTO 读的是同一份冻结
    const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
    assert.deepEqual(detail.coupon, snapshotBefore);
    assert.equal(detail.couponDiscountAmount, order.couponDiscountAmount);
    assert.equal(detail.actualPaidAmount, order.actualPaidAmount);

    // ③ 正向对照：改动**真的生效了**——新领取的券拿到的是新面额。
    //    没有这一步，上面那些「不变」在一个根本没改成功的补丁上也照样全绿。
    const other = unique("u-history-new");
    const otherClaim = await issueUsableCoupon(other);
    const fresh = await claimOf(other, otherClaim);
    assert.equal(fresh.snapshot.name, "改过的券名（Mock）");
    assert.equal(fresh.snapshot.discountAmount, 5_000);
    assert.equal(fresh.snapshot.thresholdAmount, 20_000);
    // 而这张新券在 11960 的单上未达新门槛，因此用不了
    const draft = await preview({ userId: other, couponClaimId: otherClaim });
    assert.equal(draft.coupon.applicable, false);
    assert.equal(draft.couponDiscountAmount, 0);
  } finally {
    restore();
  }
});

// —————————————————— 五、三处展示同源 + 支付金额 ——————————————————

test("结算试算 / 订单详情 / 管理端退款详情给出的实付金额是同一个数", async () => {
  const { user, order, preview: draft } = await completedCouponOrder();
  const refundId = await requestRefund(order.id, user);

  const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.equal(detail.originalAmount, order.originalAmount);
  assert.equal(detail.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(detail.actualPaidAmount, order.actualPaidAmount);
  // ⚠️ 这里原先还有一条 `detail.totalAmount === order.totalAmount`。P1-4 把 DTO 里那个
  // 字段收敛掉了：优惠前的原价在 DTO 上只有 `originalAmount` 一个名字（上面已断言），
  // 订单**实体**上仍叫 `totalAmount`。两个名字指同一个数时保留两份，正是让人
  // 把「原价」读成「实付」的入口——所以 DTO 侧只留一个。
  assert.deepEqual(detail.coupon, order.coupon);

  const admin = await getAdminRefundDetail(refundId, undefined, "server");
  assert.ok(admin);
  assert.equal(admin.orderMoney.originalAmount, order.originalAmount);
  assert.equal(admin.orderMoney.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(admin.orderMoney.actualPaidAmount, order.actualPaidAmount);

  // 三个面上的「实付」必须完全相等，且都严格小于原价（券真的减了钱）
  assert.equal(draft.actualPaidAmount, order.actualPaidAmount);
  assert.equal(detail.actualPaidAmount, admin.orderMoney.actualPaidAmount);
  assert.ok(order.actualPaidAmount < order.originalAmount);

  // 管理端退款详情的金额快照仍然是那六个字段（不因券而增减）
  assert.deepEqual(
    Object.keys(admin.orderMoney).sort(),
    [
      "actualPaidAmount",
      "clubNetIncome",
      "companionBaseIncome",
      "couponDiscountAmount",
      "originalAmount",
      "refundedAmount",
    ],
  );
});

test("退款详情两处「订单实付」读的也是实付：用户端与客服端不再拿优惠前原价充数", async () => {
  const { user, order } = await completedCouponOrder();
  const refundId = await requestRefund(order.id, user);

  // 前置就是这条用例的全部杀伤力：原价与实付**必须不相等**。
  // 种子订单没有券、两个数相等，所以任何拿 `totalAmount` 充「实付」的写法
  // 在别处都是绿的——只有这里会红。
  assert.ok(order.couponDiscountAmount > 0, "前置：这一单必须真的用了券");
  assert.notEqual(order.actualPaidAmount, order.totalAmount);

  // 用户端退款详情：那一行标着「订单实付」
  const mine = await getRefundDetailForUser(refundId, user, undefined, "server");
  assert.ok(mine);
  assert.equal(
    mine.orderTotalAmount,
    order.actualPaidAmount,
    "用户端退款详情的「订单实付」必须是实付，不是优惠前原价",
  );
  assert.notEqual(mine.orderTotalAmount, order.totalAmount, "拿原价充实付时这一条会红");

  // 客服端退款详情：那一行标着「原订单实付金额」
  const staff = await getStaffRefundDetail(refundId, undefined, "server");
  assert.ok(staff);
  assert.equal(
    staff.orderTotalAmount,
    order.actualPaidAmount,
    "客服端退款详情的「原订单实付金额」必须是实付，不是优惠前原价",
  );
  assert.notEqual(staff.orderTotalAmount, order.totalAmount);

  // 两处与订单详情必须同源：三个入口报的实付是同一个数
  const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.equal(mine.orderTotalAmount, detail.actualPaidAmount);
  assert.equal(staff.orderTotalAmount, detail.actualPaidAmount);
});

test("支付记录收的是实付而不是原价；无券链路两者相等（不回归）", async () => {
  // ① 有券：渠道只该收实付
  const user = unique("u-pay-coupon");
  const claimId = await issueUsableCoupon(user);
  const { order } = await paidOrder({ userId: user, couponClaimId: claimId });

  const payment = [...paymentStore().payments.values()].find((item) => item.orderId === order.id);
  assert.ok(payment, "支付成功必须留下一条支付记录");
  assert.equal(payment.amount, order.actualPaidAmount, "渠道实收 = 实付");
  assert.notEqual(payment.amount, order.originalAmount, "按原价扣款却给优惠就是多收用户的钱");

  // ② 无券：实付与原价是同一个数，链路零变化
  const plainUser = unique("u-pay-plain");
  const plain = await paidOrder({ userId: plainUser, couponClaimId: null });
  assert.equal(plain.order.coupon, null);
  assert.equal(plain.order.couponDiscountAmount, 0);
  assert.equal(plain.order.actualPaidAmount, plain.order.originalAmount);
  assert.equal(plain.order.coupon, plain.request.coupon);
  assert.equal(plain.request.couponClaimId, null);

  const plainPayment = [...paymentStore().payments.values()].find(
    (item) => item.orderId === plain.order.id,
  );
  assert.ok(plainPayment);
  assert.equal(plainPayment.amount, plain.order.actualPaidAmount);
  assert.equal(plainPayment.amount, plain.order.originalAmount);
});

// —————————————————— 六、退款链路（有券订单） ——————————————————

test("有券订单 10% 退款：退的是实付的 10%，打手净额 0，平台净收入 = 实付 − 退款额", async () => {
  const { user, order, claimId } = await completedCouponOrder();
  const refundId = await requestRefund(order.id, user);
  await approve(refundId, 10);

  const refund = await getRefundRepository().findRefundById(refundId);
  const expected = Math.floor((order.actualPaidAmount * 1000) / 10000);
  assert.ok(expected > 0 && expected < order.actualPaidAmount, "这是一笔**部分**退款");
  assert.equal(refund.decision.refundAmount, expected, "基数是实付，不是原价");
  assert.ok(refund.decision.refundAmount < order.originalAmount, "按原价算会超退");
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome);

  const after = await getPaymentRepository().findOrderById(order.id);
  assert.equal(after.refundedAmount, expected);
  assert.equal(after.status, "completed", "部分退款不改订单状态");

  const earning = (await listCompanionEarnings(COMPANION)).items.find((row) => row.orderId === order.id);
  assert.ok(earning, "打手必须能读到自己的收益");
  assert.equal(earning.netAmount, 0, "退款之后打手本单净额恒为 0");
  assert.equal(earning.reversedAmount, earning.incomeAmount);

  assert.equal(
    platformNetIncome(order.actualPaidAmount, refund.decision.refundAmount),
    order.actualPaidAmount - expected,
  );

  // 退款不退券（裁定 §6）
  assert.equal((await claimOf(user, claimId)).status, "used");
  assert.deepEqual((await getPaymentRepository().findOrderById(order.id)).coupon, order.coupon);
});

test("有券订单 50% 退款：同样以实付为基数，打手收益整笔零掉", async () => {
  const { user, order } = await completedCouponOrder();
  const refundId = await requestRefund(order.id, user);
  await approve(refundId, 50);

  const refund = await getRefundRepository().findRefundById(refundId);
  const expected = Math.floor((order.actualPaidAmount * 5000) / 10000);
  assert.equal(refund.decision.refundAmount, expected);
  assert.ok(refund.decision.refundAmount < order.actualPaidAmount);

  const earning = (await listCompanionEarnings(COMPANION)).items.find((row) => row.orderId === order.id);
  assert.equal(earning.netAmount, 0);
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome);

  const after = await getPaymentRepository().findOrderById(order.id);
  assert.equal(after.refundedAmount, expected);
  assert.equal(after.status, "completed");
  assert.equal(
    platformNetIncome(order.actualPaidAmount, refund.decision.refundAmount),
    order.actualPaidAmount - expected,
  );
});

test("有券订单 100% 退款：退款额精确等于实付（不是原价），订单转 refunded，券不返还", async () => {
  const { user, order, claimId } = await completedCouponOrder();
  const refundId = await requestRefund(order.id, user);
  await approve(refundId, 100);

  const refund = await getRefundRepository().findRefundById(refundId);
  assert.equal(refund.decision.refundRateBp, 10000);
  assert.equal(refund.decision.refundAmount, order.actualPaidAmount, "全额 = 实付全额");
  assert.ok(
    refund.decision.refundAmount < order.originalAmount,
    "退款基数是实付，按原价退就是超退",
  );

  const after = await getPaymentRepository().findOrderById(order.id);
  assert.equal(after.status, "refunded");
  assert.equal(after.refundedAmount, after.actualPaidAmount);
  assert.equal(isFullyRefunded(after.refundedAmount, after.actualPaidAmount), true);
  assert.equal(platformNetIncome(after.actualPaidAmount, refund.decision.refundAmount), 0);
  // 券快照与累计已退：退款不返还券，也不改写历史券展示
  assert.deepEqual(after.coupon, order.coupon);
  assert.equal(after.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal((await claimOf(user, claimId)).status, "used", "退款不返还优惠券");

  // 纯函数层与真实链路层给出同一个数（同一个公式，不是两份）
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: order.actualPaidAmount,
    companionBaseIncome: order.companionBaseIncome,
    input: { refundRateBp: 10000 },
  });
  assert.equal(amounts.refundAmount, refund.decision.refundAmount);
});

// —————————————————— 七、DTO 键集合（cmd 第 15 项） ——————————————————

test("券相关 DTO 的键集合精确固定：多一个少一个都要红", async () => {
  const user = unique("u-keys");
  const claimId = await issueUsableCoupon(user);
  const created = await create({ userId: user, couponClaimId: claimId });

  // 订单 / 支付请求上的券快照（裁定 §9 的七字段 + claimId）
  assert.deepEqual(
    Object.keys(created.request.coupon).sort(),
    [
      "claimId",
      "conditionLabel",
      "couponId",
      "discountAmount",
      "formKey",
      "name",
      "thresholdAmount",
      "valueLabel",
    ],
  );

  // 领取记录与它的券面快照（内部类型，但键集合变了就意味着快照语义变了）
  //
  // ⚠️ P1-4 验收整改轮 §六 加了**两个**字段，这里同步扩：
  //   · `source`（`"self_claim"` / `"admin_grant"`）——这张券是用户自己领的，
  //     还是管理员发的。**必填、无默认值**：给它一个默认值就等于让「忘了写」
  //     静默变成「自己领的」，而这两条路的审计要求完全不同。
  //   · `grantedByAdminId`——最小审计，**与 `source` 互为充要条件**
  //     （`admin_grant` ⇔ 非 null），下面那两句断言钉的就是这个配对。
  // ⚠️ 没有 `grantedAt`：`claimedAt` 对两种来源都是「这张券什么时刻到用户手上」，
  // 再开一个字段就是第二份真值（与 P0-15 拒绝 `platformBorneAmount` 同一条理由）。
  const claim = await claimOf(user, claimId);
  assert.deepEqual(Object.keys(claim).sort(), [
    "claimedAt",
    "couponId",
    "grantedByAdminId",
    "id",
    "snapshot",
    "source",
    "status",
    "usedAt",
    "userId",
  ]);
  assert.equal(claim.source, "self_claim", "这条链路上的券都是用户自己领的");
  assert.equal(claim.grantedByAdminId, null, "自己领的券没有发放人");
  assert.deepEqual(Object.keys(claim.snapshot).sort(), [
    "conditionLabel",
    "discountAmount",
    "formKey",
    "formLabel",
    "name",
    "thresholdAmount",
    "validFrom",
    "validTo",
    "valueLabel",
  ]);

  // 券模板 = 券面快照 + id + enabled + 两个时间戳
  //
  // ⚠️ P1-6 加了**两个**字段，这里同步扩：`createdAt` / `updatedAt`。
  //   后台的券模板列表要按建档时间倒序、要显示「最近更新」，没有这两个字段就排不了也显示不了；
  //   它们也进 `AdminCouponTemplateItem`（后台 DTO），但**不进任何用户端 DTO**——
  //   券面快照、结算页可选券项与订单里的券快照都仍然只字不提时间戳（下面几条断言即是）。
  //   与 P1-4 §六 给 `CouponClaim` 加 `source` 是同一套做法：键集合变了就同步扩这条门禁，
  //   而不是把断言放宽成「包含」。
  const template = await getCouponRepository().findCouponById(THRESHOLD_COUPON);
  assert.deepEqual(Object.keys(template).sort(), [
    "conditionLabel",
    "createdAt",
    "discountAmount",
    "enabled",
    "formKey",
    "formLabel",
    "id",
    "name",
    "thresholdAmount",
    "updatedAt",
    "validFrom",
    "validTo",
    "valueLabel",
  ]);

  // 结算页的可选券项：能用与不能用**同一个形状**（只是取值不同）
  const draft = await preview({ userId: user, couponClaimId: null });
  const option = draft.availableCoupons.find((item) => item.claimId === claimId);
  assert.ok(option);
  assert.deepEqual(Object.keys(option).sort(), [
    "applicable",
    "claimId",
    "conditionLabel",
    "couponId",
    "discountAmount",
    "name",
    "reason",
    "validFrom",
    "validTo",
    "valueLabel",
  ]);

  const under = await preview({ userId: user, quantity: 1, couponClaimId: null });
  const unusable = under.availableCoupons.find((item) => item.claimId === claimId);
  assert.ok(unusable);
  assert.deepEqual(
    Object.keys(unusable).sort(),
    Object.keys(option).sort(),
    "能用与不能用的券项必须是同一个形状，否则界面要多写一条分支",
  );
});

// —————————————— 八、结构约束：让上面的双花测试不会静默失去意义 ——————————————

test("结构：建单是纯构造，核销与派单在仓储的原子区段内同步完成且核销在前", () => {
  // 上面那条「双花」用例是在单线程里**顺序**调用两笔确认的。它之所以成立，
  // 靠的是一个没有写进任何断言的前提：**券核销与派单写入发生在支付仓储那一段
  // 没有 `await` 的原子区段之内**，因此「复查券状态 → 核销 → 建单」不会被让出执行权。
  //
  // 一旦有人往区段里加一个 `await`，真正的并发（两个请求各跑一半）就会交错，
  // 而顺序调用的测试**照样全绿**——这类静默失效只能靠源码结构断言拦住。
  // 与 `tests/companionServing.test.mjs` 的同类断言同一个理由。
  //
  // ⚠️ PROD-1D 起这三件事分到了三处，断言也随之分成三条（**少了任何一条，
  // 上面那条双花用例就又变成「不知道在守护什么」**）：
  //   ① `lib/services/checkout.ts` 的 `buildOrderFromRequest` 必须**纯**（一行都不写），
  //      否则 Pg 侧会变成「订单进库、券核销与派单进 Mock」的半迁移（Hard Rule 1）；
  //   ② Mock 侧的参与者 `commitMockCheckoutParticipants` 必须**同步**，
  //      且核销排在派单之前（否则失败时留下「有派单、没有订单」）；
  //   ③ 那个参与者必须**真的在**支付仓储的原子区段里被调用（放进区段外等于没保护）。
  const functionBody = (code, name) => {
    const start = code.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `\`${name}\` 必须还在源码里`);
    // ⚠️ 圈函数体**不能**用 `code.indexOf("\n}\n", start)`：
    // 本仓 `core.autocrlf=true`，这些文件检出为 **CRLF**，
    // 而 CRLF 里 `}` 后面跟的是 `\r` 不是 `\n`，所以 `"\n}\n"` **永远匹配不到**、
    // `end` 恒为 `-1`——这条断言在 Windows 上**无条件失败**。
    // 那是**假失败**：它红的原因与「原子区段里没有 await」毫无关系，
    // 于是真正的回归信号被这条噪音盖住。
    //
    // 改成「切到**下一个顶层声明**为止」：`^` 配 `/m` 在 LF 与 CRLF 下都落在行首，
    // 因此与行尾符、缩进、函数在文件中的位置都无关。
    const rest = code.slice(start + 1);
    const next = rest.search(
      /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|type|class|interface)\s/m,
    );
    const end = next === -1 ? code.length : start + 1 + next;
    const body = code.slice(start, end);
    // 圈出来的必须真的是一个**完整的函数体**，否则下面那条「没有 await」可能是在
    // 一个空片段或半截片段上通过——那才是真的把断言放空了
    assert.ok(body.trimEnd().endsWith("}"), `圈出的 \`${name}\` 片段必须以右花括号收尾`);
    return body;
  };

  /* ① 纯构造：一行都不写 */
  const checkout = stripComments(readSource(resolveSource("lib/services/checkout.ts")));
  const buildOrder = functionBody(checkout, "buildOrderFromRequest");
  assert.equal(
    /\bawait\b/.test(buildOrder),
    false,
    "建单的纯构造函数里出现 await：Pg 侧会变成「订单进库、券核销与派单进 Mock」的半迁移",
  );
  assert.equal(
    buildOrder.includes("redeemCouponClaimForOrder("),
    false,
    "券核销必须离开纯构造函数——留在里面，Pg 支付仓储一跑就把券核销写进 Mock",
  );
  assert.equal(
    buildOrder.includes("createDispatchForOrder("),
    false,
    "派单写入必须离开纯构造函数——留在里面，Pg 支付仓储一跑就把派单写进 Mock",
  );

  /* ② Mock 参与者：同步，且核销排在派单之前 */
  const commit = stripComments(
    readSource(resolveSource("lib/data/checkoutCommitTransaction.ts")),
  );
  const participants = functionBody(commit, "commitMockCheckoutParticipants");
  assert.equal(
    /\bawait\b/.test(participants),
    false,
    "原子区段里出现任何一个 await，双花测试就会静默失去意义（「读—判断—写」被拆到两个 tick 上）",
  );
  assert.ok(
    participants.includes("redeemCouponClaimForOrder("),
    "核销必须发生在这个原子区段里——放到区段外，双花窗口就重新打开了",
  );
  assert.ok(
    participants.indexOf("redeemCouponClaimForOrder(") <
      participants.indexOf("createDispatchForOrder("),
    "核销必须排在派单记录写入之前，否则失败时留下「有派单、没有订单」的半成品",
  );

  /* ③ 参与者必须在支付仓储的原子区段里被调用（且那一段本身没有 await）  */
  const repo = stripComments(readSource(resolveSource("lib/data/mockPaymentRepository.ts")));
  const segmentStart = repo.indexOf("confirmPaymentRequest(id, result, buildOrder) {");
  assert.notEqual(segmentStart, -1, "Mock 支付仓储必须还有 `confirmPaymentRequest`");
  const segmentEnd = repo.indexOf("async queryOrders(", segmentStart);
  const segment = repo.slice(segmentStart, segmentEnd === -1 ? repo.length : segmentEnd);
  assert.ok(
    segment.includes("commitMockCheckoutParticipants("),
    "券核销与派单必须在 `confirmPaymentRequest` 的原子区段里被调用，而不是在服务层另起一段",
  );
  assert.equal(
    /\bawait\b/.test(segment),
    false,
    "`confirmPaymentRequest` 的原子区段里出现 await，双花测试就会静默失去意义",
  );

});
