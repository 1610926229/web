import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  COUPON_SETTLEMENT_UNSUPPORTED_REASON,
  COUPON_USE_DISABLED_REASON,
  COUPON_USE_UNSUPPORTED_REASON,
  couponThresholdNotMetReason,
  resolveCouponClaimGate,
  resolveCouponSettlementUsability,
  toOwnedCouponItem,
} from "../lib/constants/coupons.ts";
import { acceptDispatch, sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import {
  cancelAcceptedOrder,
  replaceOrderCompanionByStaff,
  startCompanionOrder,
} from "../lib/data/companionOrderTransaction.ts";
import { approveCompletion, submitCompletion } from "../lib/data/completionTransaction.ts";
import { couponStore } from "../lib/data/mockCouponRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import {
  grantCouponToUser,
  listCouponGrantOptions,
  searchGrantTargetUsers,
} from "../lib/services/adminCoupons.ts";
import { approveAdminRefund } from "../lib/services/adminRefunds.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { claimCouponForUser, queryCouponsForUser } from "../lib/services/coupons.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { createRefundForOrder, directRefundOrderForUser } from "../lib/services/refunds.ts";

/**
 * P1-4 **验收整改轮**：退款返券、管理员发放、账户 / 结算口径一致。
 *
 * ## 这个文件覆盖的三块新规则
 *
 * | 块 | 裁定出处 | 用例 |
 * |---|---|---|
 * | 退款后优惠券返还 | §一 / §二 / §三 | 1–11、28 |
 * | 管理员向指定用户发放 | §四 – §七 | 12–19 |
 * | 账户「可用」与 checkout 一致 | §八 – §十、§十四 | 20–23 |
 * | 服务端最终真值 / 原子性 | §十一 / §十二 | 24–25、27、29–30 |
 *
 * 裁定 §十三 列了 30 条。其中**第 26 条（preview 不消耗券）**与第 27 条的
 * 「建支付请求不核销」两半已经由 `tests/couponCheckoutChain.test.mjs` 逐字段钉住
 * （那边有 `preview 反复试算不消耗券` 与 `支付成功那一刻才核销` 两条），
 * 本文件不复制它们，只补第 27 条**缺的那一半**：建单**失败**时不消耗券。
 *
 * ## ⚠️ 全部走真实服务 / 仓储链，没有一处把业务逻辑抄进测试
 *
 * 尤其 §十四 那条回归（本文件 §C 的第一条）：它必须**真的**经过
 * `queryCouponsForUser` 与 `previewCheckout` 两条链路，而不是「调一个纯函数看返回值」。
 * 理由是人工验收现场正是从这两条链路之间穿过去才发现的缺陷——
 * 只测纯函数的话，两条链路各自换成不同的口径也照样全绿。
 *
 * ## ⚠️ 时间被钉在数据层
 *
 * 结算侧（`previewCheckout` / `createPaymentRequest`）**没有 `now` 注入**，
 * 它们内部用 `new Date()`。种子券的 `validTo` 是 2026-12-31，直接依赖真实时间
 * 会让这个文件在 2027 年集体变红——而那与「券还不还」毫无关系。
 *
 * 因此凡是需要「一张仍然在有效期内的券」的地方，都在**数据层**把那张领取记录的
 * 快照有效期放宽（`patchClaim`），改的是夹具数据，不是判定逻辑。
 * 「过期后不能核销」这一类语义反而**必须**靠收紧夹具来构造（用例 11）。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const UNIT_PRICE = 2990;
/** 满减券种子：满 10000 减 1000（整数分）。 */
const THRESHOLD_COUPON = "cpn-mock-new-user";
/** 折扣券种子：`formKey === "discount"`，两个可计算字段恒为 null。 */
const DISCOUNT_COUPON = "cpn-mock-holiday";
/** 无门槛券种子：`formKey === "gift"`。 */
const GIFT_COUPON = "cpn-mock-no-threshold";
/** 已停用的种子券：`enabled === false`。 */
const DISABLED_COUPON = "cpn-mock-disabled";
/** 走满 10000 门槛需要 4 份：2990 × 4 = 11960。 */
const QUANTITY = 4;

const COMPANION = "cp-1";
const OTHER_COMPANION = "cp-2";
const STAFF = { id: "staff-1", name: "客服小雨" };
const ADMIN = "admin-1";

/**
 * 真实存在的种子用户。
 *
 * ⚠️ **管理员发券会校验用户存在**（`grantCouponToUser` → `findUserById`），
 * 因此凡是走 `grantCouponToUser` 的用例都**不能**用 `unique("u-…")` 合成的 id——
 * 那些 id 在自助领券那条链路上能过（那条不查用户），在发券这条链路上会得到
 * 「用户不存在」。用种子里真的有的账户，才是在测发券本身。
 *
 * ⚠️ 避开 `u-1001`：种子里那三条历史领取记录都属于它（`couponSeed.ts`），
 * 会让「他手上有几张券」这类计数断言读到一个非零的起点。
 */
const SEEDED_USER = "u-1002";

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
  return unique("cpnret");
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

/** 就地改一条券模板，返回还原函数。 */
function patchCouponTemplate(couponId, patch) {
  const record = couponStore().coupons.get(couponId);
  assert.ok(record, `预置券模板 ${couponId} 必须存在`);
  const original = { ...record };
  Object.assign(record, patch);
  return () => {
    Object.assign(record, original);
  };
}

function claimOf(claimId) {
  return couponStore().claims.get(claimId) ?? null;
}

/** 把一张领取记录的有效期放宽到远未来（见文件头对「时间」的说明）。 */
function widen(claimId) {
  const claim = claimOf(claimId);
  assert.ok(claim, `领取记录 ${claimId} 必须存在`);
  patchClaim(claimId, {
    snapshot: { ...claim.snapshot, validFrom: WIDE_FROM, validTo: WIDE_TO },
  });
  return claimId;
}

/** 给一个用户领一张满减券，并把夹具有效期放宽。 */
async function issueUsableCoupon(userId, couponId = THRESHOLD_COUPON) {
  const { claimId } = await claimCouponForUser(
    userId,
    couponId,
    { idempotencyKey: uniqueKey() },
    "server",
    undefined,
    CLAIM_NOW,
  );
  return widen(claimId);
}

/** 走完「下单 → 支付」，返回订单。`couponClaimId` 传了就带上券。 */
async function paidOrder(input = {}) {
  const user = input.userId;
  const created = await createPaymentRequest(
    { ...selection(input), idempotencyKey: uniqueKey() },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true, "前置：这张订单必须创建成功");
  return confirmed.order;
}

/** 一张**从未被承接**的已付款订单（公共池里的等待单）。 */
async function paidNeverAccepted(input = {}) {
  const user = input.userId ?? unique("u-never");
  const claimId = await issueUsableCoupon(user);
  const order = await paidOrder({ ...input, userId: user, couponClaimId: claimId });
  assert.ok(order.coupon, "前置：订单上必须冻结了券快照");
  assert.equal(order.everAcceptedAt, null, "前置：新建订单尚未被承接");
  assert.equal(order.status, "paid");
  return { user, claimId, order };
}

function dispatchOf(orderId) {
  return getDispatchRepository().findDispatchByOrderId(orderId);
}

/** 把订单推进到 `accepted`（打手自己接单）。 */
async function acceptOrder(orderId, companionId = COMPANION) {
  const dispatch = await dispatchOf(orderId);
  assert.ok(dispatch, "前置：支付成功后必须有派单记录");
  const at = new Date().toISOString();
  assert.equal((await acceptDispatch(dispatch.id, { companionId, at })).kind, "ok");
  return at;
}

async function refundViaAdmin(orderId, user, percent) {
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
  return approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: uniqueKey(),
    refundRatePercent: String(percent),
  });
}

/** 账户页看到的这张券（走真实服务链路）。 */
async function ownedItem(userId, claimId) {
  const page = await queryCouponsForUser(userId, new URLSearchParams({ tab: "owned" }), "server");
  return page.items.find((item) => item.id === claimId) ?? null;
}

/** 结算页能给这一单选的券（走真实服务链路）。 */
async function checkoutCoupons(userId, overrides = {}) {
  const draft = await previewCheckout(selection(overrides), userId, undefined, "server");
  return draft;
}

// ═══════════════ A. 退款后优惠券返还（裁定 §一 / §二 / §三） ═══════════════

test("§一.1 paid 且从未 accepted → 用户直接退款 → 券恢复 unused 且清掉 usedAt", async () => {
  const { user, claimId, order } = await paidNeverAccepted();

  // 前置：这一单真的用掉了券
  assert.equal(claimOf(claimId).status, "used", "前置：支付成功就该核销券");
  assert.equal(order.status, "paid");

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = claimOf(claimId);
  assert.equal(after.status, "unused", "从未被承接的订单退款后，券的使用资格必须还回来");
  assert.equal(after.usedAt, null, "「未使用」的券不该还留着一个核销时刻");
  assert.equal(after.id, claimId, "还回去的必须是**原来那张**，不能新建一张");
});

test("§一.1 返券不得创建第二张券：整个用户的领取记录数不变", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const before = [...couponStore().claims.values()].filter((c) => c.userId === user).length;

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = [...couponStore().claims.values()].filter((c) => c.userId === user);
  assert.equal(after.length, before, "裁定 §一.1 明文「不得创建一张新的重复券」");
  assert.deepEqual(
    after.map((c) => c.id),
    [claimId],
    "那一张就是当初核销掉的那张",
  );
});

test("§一.1 公共池无人接单系统退款 → 券同样恢复 unused", async () => {
  const { claimId, order } = await paidNeverAccepted();

  const dispatch = await dispatchOf(order.id);
  assert.ok(dispatch, "前置：必须有派单记录");
  // 未指定打手 ⇒ 直接进公共池。用它的截止时刻触发清扫，走的是真实超时路径
  assert.equal(dispatch.state, "public", "前置：这是公共池里的等待单");

  const swept = sweepExpiredDispatches(dispatch.publicDeadlineAt);
  assert.ok(swept.refundedOrderIds.includes(order.id), "前置：这一单必须被系统退款");

  const refunded = await getPaymentRepository().findOrderById(order.id);
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.refundedAmount, refunded.actualPaidAmount, "超时自动退款是全额");

  assert.equal(claimOf(claimId).status, "unused", "从未被承接 ⇒ 系统退款同样还券");
  assert.equal(claimOf(claimId).usedAt, null);
});

test("§一.2 accepted 时退款 → 不返券", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  await acceptOrder(order.id);

  const accepted = await getPaymentRepository().findOrderById(order.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.everAcceptedAt !== null, true, "接单之后必须留下「曾被承接」的痕迹");

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = claimOf(claimId);
  assert.equal(after.status, "used", "已经被承接过的单，退款不还券");
  assert.equal(typeof after.usedAt, "string", "usedAt 不该被清掉");
});

test("§一.2 serving 时退款 → 不返券", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const at = await acceptOrder(order.id);
  assert.equal(
    (await startCompanionOrder({ companionId: COMPANION, orderId: order.id, at })).kind,
    "ok",
  );
  assert.equal((await getPaymentRepository().findOrderById(order.id)).status, "serving");

  await refundViaAdmin(order.id, user, 100);

  assert.equal(claimOf(claimId).status, "used", "护航中退款不还券");
});

test("§一.2 completed 后退款 → 不返券", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const at = await acceptOrder(order.id);
  assert.equal(
    (await startCompanionOrder({ companionId: COMPANION, orderId: order.id, at })).kind,
    "ok",
  );
  const submitted = await submitCompletion({
    companionId: COMPANION,
    orderId: order.id,
    summary: "已完成护航服务",
    evidence: [],
    at,
  });
  assert.equal(submitted.kind, "ok");
  assert.equal(
    (await approveCompletion({
      submissionId: submitted.submissionId,
      staffId: STAFF.id,
      staffName: STAFF.name,
      at,
    })).kind,
    "ok",
  );
  assert.equal((await getPaymentRepository().findOrderById(order.id)).status, "completed");

  await refundViaAdmin(order.id, user, 100);

  assert.equal(claimOf(claimId).status, "used", "已完成后退款不还券");
});

test("§一.2 accepted → Companion cancel/repool → 又回到 paid → 用户退款 → 仍不返券", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const at = await acceptOrder(order.id);

  // 打手主动取消 → 订单退回 paid（`acceptedAt` 会被清空）
  assert.equal(
    (
      await cancelAcceptedOrder({
        companionId: COMPANION,
        orderId: order.id,
        reason: "临时有事，这一单接不了了",
        idempotencyKey: uniqueKey(),
        at,
      })
    ).kind,
    "ok",
  );

  const repooled = await getPaymentRepository().findOrderById(order.id);
  assert.equal(repooled.status, "paid", "前置：取消接单后订单回到 paid");
  assert.equal(repooled.acceptedAt, null, "前置：acceptedAt 会被清空——这正是它不能当判据的原因");
  assert.equal(repooled.actualCompanionId, null);
  assert.equal(
    repooled.everAcceptedAt !== null,
    true,
    "⚠️ everAcceptedAt 必须**原样留着**：被承接过的历史不因为人走了就消失",
  );

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = claimOf(claimId);
  assert.equal(
    after.status,
    "used",
    "裁定 §一.2 点名列出这条路径：只判 `status === \"paid\"` 会在这里错误地还券",
  );
  assert.equal(typeof after.usedAt, "string");
});

test("§一.3 Staff 直接指定打手 → 退款 → 不返券（不得复用接单榜的 acceptedVia 判断）", async () => {
  const { user, claimId, order } = await paidNeverAccepted();

  // 客服「直接指定 / 直接换人」的状态闸只允许 `accepted` / `serving`，
  // 因此这一条的组织方式是：先有人接单，客服再把他**换掉**。
  const firstAcceptAt = await acceptOrder(order.id, COMPANION);
  const everAcceptedAt = (await getPaymentRepository().findOrderById(order.id)).everAcceptedAt;
  assert.equal(everAcceptedAt !== null, true, "前置：这一单已经有人接过");

  const replacedAt = new Date(Date.parse(firstAcceptAt) + 60_000).toISOString();
  assert.equal(
    (
      await replaceOrderCompanionByStaff({
        orderId: order.id,
        newCompanionId: OTHER_COMPANION,
        staffId: STAFF.id,
        at: replacedAt,
      })
    ).kind,
    "ok",
    "前置：客服把打手换成了另一位",
  );

  const accepted = await getPaymentRepository().findOrderById(order.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.actualCompanionId, OTHER_COMPANION);

  // ⚠️ 裁定 §一.3 的两半都在这一条里：
  //
  // 1. 客服 direct assignment **不是**打手主动接单（P1-5 接单榜口径，`acceptedVia: "staff"`
  //    不产生接单事件），但它**确实让订单进入了 `accepted`**——因此它算「已被承接」。
  //    优惠券返还看的是后者，所以这里不还券。
  // 2. 判据必须是「有没有被承接」，而**不是**「是谁、以什么方式承接的」。
  //    换人把 `actualCompanionId` 改了、`acceptedAt` 被重写了，但
  //    `everAcceptedAt` 由 `??` 保护、**不被刷新**——它是历史事实，不是绑定。
  assert.equal(
    accepted.everAcceptedAt,
    everAcceptedAt,
    "换人不刷新「第一次被承接的时刻」（写入用 `??`）",
  );

  await directRefundOrderForUser(order.id, user, undefined, "server");

  assert.equal(
    claimOf(claimId).status,
    "used",
    "客服指定 / 换人的单同样算「已被承接」，券不返还；用 acceptedVia === companion 判会在这里出错",
  );
});

test("§二 返券不动订单历史：coupon 快照 / actualPaidAmount / couponDiscountAmount 一个都不变", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const before = {
    coupon: { ...order.coupon },
    actualPaidAmount: order.actualPaidAmount,
    couponDiscountAmount: order.couponDiscountAmount,
    originalAmount: order.originalAmount,
  };

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = await getPaymentRepository().findOrderById(order.id);
  assert.deepEqual(after.coupon, before.coupon, "订单上的券快照必须原样保留");
  assert.equal(after.actualPaidAmount, before.actualPaidAmount, "历史实付不得被改动");
  assert.equal(after.couponDiscountAmount, before.couponDiscountAmount);
  assert.equal(after.originalAmount, before.originalAmount);

  // 而且订单仍然**指得出**当初用的是哪一张券——「用过」这件事没有被抹掉
  assert.equal(after.coupon.claimId, claimId);
  assert.equal(after.status, "refunded");
});

test("§二 / §三 返还后能不能用仍要重新判：模板已停用 → 不能核销", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  await directRefundOrderForUser(order.id, user, undefined, "server");
  assert.equal(claimOf(claimId).status, "unused", "前置：券已经还回来了");

  // 还回来之后平台把这张券停用了
  const restore = patchCouponTemplate(THRESHOLD_COUPON, { enabled: false });
  try {
    const gate = resolveCouponClaimGate(claimOf(claimId), new Date(), false);
    assert.equal(gate.ok, false);
    assert.equal(gate.code, "disabled");
    assert.equal(gate.reason, COUPON_USE_DISABLED_REASON);

    // 真的拿它去试算：服务端必须判为不可用，不能因为「刚退过款」就放行
    const draft = await checkoutCoupons(user, { couponClaimId: claimId });
    assert.equal(draft.coupon?.applicable, false, "停用的券不得被采用");
    assert.equal(draft.couponDiscountAmount, 0, "不可用的券不得产生任何抵扣");
    assert.match(draft.couponReason, /停用/, "而且要说得出为什么");
  } finally {
    restore();
  }
});

test("§二 / §三 返还后已过期 → 不能用（还的是「未使用资格」，不是绕过有效期）", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  await directRefundOrderForUser(order.id, user, undefined, "server");
  assert.equal(claimOf(claimId).status, "unused");

  // 把这张券的快照有效期收到过去——它就是「已经过期」的定义
  const restore = patchClaim(claimId, {
    snapshot: { ...claimOf(claimId).snapshot, validFrom: WIDE_FROM, validTo: "2020-01-02T00:00:00.000Z" },
  });
  try {
    const gate = resolveCouponClaimGate(claimOf(claimId), new Date(), true);
    assert.equal(gate.ok, false);
    assert.equal(gate.code, "expired");

    const draft = await checkoutCoupons(user, { couponClaimId: claimId });
    assert.equal(draft.coupon?.applicable, false, "过期的券不得被采用");
    assert.equal(draft.couponDiscountAmount, 0, "过期的券不得产生任何抵扣");
    assert.match(draft.couponReason, /有效期/, "而且要说得出为什么");
  } finally {
    restore();
  }
});

test("§十二 退款**实际成功**之后才还券：第二次退款不执行，也不再有第二次还券", async () => {
  const { user, claimId, order } = await paidNeverAccepted();

  await directRefundOrderForUser(order.id, user, undefined, "server");
  const first = claimOf(claimId);
  assert.equal(first.status, "unused");

  // 先人为把它再核销一次（模拟「券又被用掉了」），然后对**同一张已退款的订单**再退一次。
  // 一单一退（P0-15）会在 `applyOrderRefund` 里静默挡下，`changed === false`，
  // 因此退券那一步不该被触发 —— 否则用户的第二张券会被凭空还回来。
  patchClaim(claimId, { status: "used", usedAt: new Date().toISOString() });

  const again = await directRefundOrderForUser(order.id, user, undefined, "server").catch((cause) => cause);
  assert.ok(again, "第二次退款不该把整个请求炸掉，它应当被幂等地挡下");

  assert.equal(
    claimOf(claimId).status,
    "used",
    "退款没有真正发生 ⇒ 不得还券（裁定 §十二：不能先返券后退款失败）",
  );
});

test("§十三.29 有券订单退款退的是**实付**，不是原价（返券不改金额基线）", async () => {
  const { user, order } = await paidNeverAccepted();
  assert.ok(order.couponDiscountAmount > 0, "前置：这一单真的减了钱");
  assert.equal(order.actualPaidAmount, order.originalAmount - order.couponDiscountAmount);

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");
  assert.equal(result.refundedAmount, order.actualPaidAmount, "退的是实付");
  assert.notEqual(result.refundedAmount, order.originalAmount, "不是原价");

  const refunded = await getPaymentRepository().findOrderById(order.id);
  assert.equal(refunded.refundedAmount, order.actualPaidAmount);
  // 券还回去了，但「这一单当初抵了多少」仍然写得明明白白
  assert.equal(refunded.couponDiscountAmount, order.couponDiscountAmount);
});

test("§十三.30 返券不得让 P0-15 的收益归零 / 平台净收入口径回归", async () => {
  const { user, order } = await paidNeverAccepted();
  const discount = order.couponDiscountAmount;
  const paid = order.actualPaidAmount;

  const at = await acceptOrder(order.id);
  assert.equal(
    (await startCompanionOrder({ companionId: COMPANION, orderId: order.id, at })).kind,
    "ok",
  );
  await refundViaAdmin(order.id, user, 50);

  const refunded = await getPaymentRepository().findOrderById(order.id);
  assert.equal(refunded.status, "serving", "部分退款不改订单状态（P0-15）");
  assert.equal(refunded.refundedAmount, Math.floor((paid * 5000) / 10000), "退款额按实付算");

  // 打手本单收益**全部**冲回（与比例无关），因此净额为 0
  const earnings = await listCompanionEarnings(COMPANION);
  const forOrder = earnings.items.filter((item) => item.orderId === order.id);
  for (const item of forOrder) {
    assert.equal(
      item.incomeAmount - item.reversedAmount,
      0,
      "P0-15：不论退款比例，打手本单净收益恒为 0",
    );
  }

  // 平台净收入 = 实付 − 退款额（券的成本由平台承担，不从这里再扣一次）。
  // ⚠️ 两边同减 `refundedAmount`，所以这条**代数上退化为** `paid === refunded.actualPaidAmount`，
  // 也就是「退款**不改**实付」。写成减法只是让口径在测试里也读得出来——
  // 判别力来自右边的 `actualPaidAmount`，**不是**来自减法本身。
  assert.equal(
    refunded.actualPaidAmount - refunded.refundedAmount,
    paid - refunded.refundedAmount,
    "平台净收入仍以 actualPaidAmount 为基（退化为「退款不改实付」）",
  );

  // 退款**不改**订单上的券抵扣额。
  // ⚠️ 比的是「退款**前**捕获的那份」`discount` 与「退款**后**重新读到的那份」`refunded` —— 两个**不同对象**
  // （`findOrderById` 返回 Map 里的活对象，而每次写入都用 `{ ...order, ...patch }` 换掉整个条目，
  // 因此 `order` 停在退款前那一份）。⚠️ 曾经这里写的是 `assert.equal(discount, order.couponDiscountAmount)`：
  // 那是**同一个表达式求值两次**，恒真、永远不会红 —— 一条空的防线。
  assert.equal(refunded.couponDiscountAmount, discount, "券的抵扣额不参与这条公式");
});

// ═══════════════ B. 管理员向指定用户发放（裁定 §四 – §七） ═══════════════

test("§四 管理员可以给指定用户发券；§六 来源与审计字段写对", async () => {
  const user = SEEDED_USER;
  const result = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );

  assert.equal(result.userId, user);
  assert.equal(result.couponId, THRESHOLD_COUPON);
  assert.equal(result.created, true);

  const claim = claimOf(result.claimId);
  assert.equal(claim.userId, user);
  assert.equal(claim.status, "unused");
  assert.equal(claim.source, "admin_grant");
  assert.equal(claim.grantedByAdminId, ADMIN, "最小审计：谁发的");
  assert.equal(claim.usedAt, null);
  assert.equal(typeof claim.claimedAt, "string", "claimedAt 就是发放时刻（不另设 grantedAt）");
});

test("§四.4 Admin grant 后用户账户**立即可见**（同一份数据，无需同步动作）", async () => {
  const user = SEEDED_USER;
  const { claimId } = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );

  const item = await ownedItem(user, claimId);
  assert.ok(item, "发放之后用户在「我的优惠券」里必须立刻看得到它");
  assert.equal(item.id, claimId);
  assert.equal(item.status, "unused");
  assert.equal(item.source, "admin_grant");
  assert.equal(item.settlementUsable, true, "一张未使用、启用的满减券就是可用于结算的");
});

test("§五 同一模板可以 Admin grant **多次**：每次一张独立 Claim", async () => {
  const user = SEEDED_USER;
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await grantCouponToUser(
      ADMIN,
      { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
      "server",
    );
    assert.equal(r.created, true, `第 ${i + 1} 次发放必须真的新建一张`);
    ids.push(r.claimId);
  }

  assert.equal(new Set(ids).size, 3, "三次发放必须是三张不同的券");
  for (const id of ids) {
    assert.equal(claimOf(id).userId, user);
    assert.equal(claimOf(id).couponId, THRESHOLD_COUPON);
  }
});

test("§五 多个相同模板的 Claim 由 claimId 区分：核销其中一张不影响另一张", async () => {
  const user = SEEDED_USER;
  const first = (
    await grantCouponToUser(
      ADMIN,
      { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
      "server",
    )
  ).claimId;
  const second = (
    await grantCouponToUser(
      ADMIN,
      { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
      "server",
    )
  ).claimId;
  widen(first);
  widen(second);

  const order = await paidOrder({ userId: user, couponClaimId: first });
  assert.equal(order.coupon.claimId, first, "订单必须指向被选中的那一张");

  assert.equal(claimOf(first).status, "used");
  assert.equal(claimOf(second).status, "unused", "另一张同样的券不受影响");
});

test("§五 Admin grant **不占用** self-claim quota：已自行领过的用户还能被再发", async () => {
  const user = SEEDED_USER;
  const selfClaim = await issueUsableCoupon(user);

  // 自己领过之后，再自己领一次 → 仍然只有原来那一张（一模板一次，不回归）
  const again = await claimCouponForUser(
    user,
    THRESHOLD_COUPON,
    { idempotencyKey: uniqueKey() },
    "server",
    undefined,
    CLAIM_NOW,
  );
  assert.equal(again.claimId, selfClaim, "self-claim 的一模板一次规则不得回归");
  assert.equal(again.created, false);

  // 但管理员照样可以发
  const granted = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );
  assert.equal(granted.created, true, "Admin grant 是独立发放行为，不受 self-claim quota 约束");
  assert.notEqual(granted.claimId, selfClaim);

  const held = [...couponStore().claims.values()].filter(
    (c) => c.userId === user && c.couponId === THRESHOLD_COUPON,
  );
  assert.equal(held.length, 2, "一张自己领的 + 一张管理员发的");
  assert.deepEqual(
    held.map((c) => c.source).sort(),
    ["admin_grant", "self_claim"],
  );
});

test("§七 Admin 发放按**当前模板**生成快照；模板后改不追溯已发出的 Claim", async () => {
  const user = SEEDED_USER;
  const { claimId } = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );

  const before = { ...claimOf(claimId).snapshot };
  const restore = patchCouponTemplate(THRESHOLD_COUPON, {
    thresholdAmount: 20000,
    discountAmount: 3000,
    valueLabel: "满 200 减 30",
    validTo: WIDE_TO,
  });
  try {
    const after = claimOf(claimId).snapshot;
    assert.deepEqual(after, before, "模板改了之后，已经发出去的 Claim 快照一个字都不动");
    assert.equal(after.thresholdAmount, 10000, "仍然是发放那一刻的门槛");
    assert.equal(after.discountAmount, 1000);
  } finally {
    restore();
  }
});

test("§七 / §十九 模板 disabled 之后，Admin 已发的 Claim 不能使用（current enabled 说了算）", async () => {
  const user = SEEDED_USER;
  const { claimId } = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );
  widen(claimId);

  // 停用之前能用
  assert.equal((await checkoutCoupons(user, { couponClaimId: claimId })).coupon?.claimId, claimId);

  const restore = patchCouponTemplate(THRESHOLD_COUPON, { enabled: false });
  try {
    assert.equal(
      resolveCouponClaimGate(claimOf(claimId), new Date(), false).code,
      "disabled",
      "snapshot 说这张券是什么，current enabled 说平台现在允不允许用",
    );
    const draft = await checkoutCoupons(user, { couponClaimId: claimId });
    assert.equal(draft.coupon?.applicable, false, "已停用 ⇒ 服务端拒绝采用");
    assert.equal(draft.couponDiscountAmount, 0);
    assert.match(draft.couponReason, /停用/);
    const item = await ownedItem(user, claimId);
    assert.equal(item.settlementUsable, false, "账户页也必须同步说「不可用于结算」");
  } finally {
    restore();
  }
});

test("§四.2 只能发**当前启用**的模板：选到已停用的模板一律拒绝", async () => {
  const user = SEEDED_USER;
  await assert.rejects(
    () =>
      grantCouponToUser(
        ADMIN,
        { userId: user, couponId: DISABLED_COUPON, idempotencyKey: uniqueKey() },
        "server",
      ),
    /停用/,
    "发出去一张已停用的券 = 给用户一张废纸",
  );
});

test("§四 可选模板列表**只含 enabled 的**：停用的不在里面", async () => {
  const options = await listCouponGrantOptions(undefined, "server");
  const ids = options.map((item) => item.id);
  assert.ok(ids.length > 0, "至少要有可发的模板");
  assert.equal(ids.includes(DISABLED_COUPON), false, "已停用的模板不得出现在可选列表里");
  for (const option of options) {
    const template = couponStore().coupons.get(option.id);
    assert.equal(template.enabled, true, `${option.id} 必须是启用状态`);
  }
});

test("§四 找不到用户 / 缺少幂等键 / 缺少字段：三种情况都是明确报错，且不写任何 Claim", async () => {
  const user = SEEDED_USER;
  const claimsBefore = couponStore().claims.size;

  await assert.rejects(
    () =>
      grantCouponToUser(
        ADMIN,
        { userId: "u-does-not-exist", couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
        "server",
      ),
    /用户不存在/,
  );
  await assert.rejects(
    () =>
      grantCouponToUser(ADMIN, { userId: user, couponId: THRESHOLD_COUPON }, "server"),
    /幂等键/,
  );
  await assert.rejects(
    () => grantCouponToUser(ADMIN, { idempotencyKey: uniqueKey() }, "server"),
    /缺少/,
  );

  assert.equal(couponStore().claims.size, claimsBefore, "三次失败都不得留下任何 Claim");
});

test("§四 同一个幂等键重复提交只发一张（不重复发放）", async () => {
  const user = SEEDED_USER;
  const key = uniqueKey();
  const body = { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: key };

  const first = await grantCouponToUser(ADMIN, body, "server");
  const second = await grantCouponToUser(ADMIN, body, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false, "同一个幂等键第二次到达必须是「没有新建」");
  assert.equal(second.claimId, first.claimId);
  assert.equal(
    [...couponStore().claims.values()].filter((c) => c.userId === user).length,
    1,
    "提交两次，发出去的只能是一张",
  );
});

test("§四 搜人接口：关键词能按昵称 / id 命中，空关键词不返回全量", async () => {
  const matches = await searchGrantTargetUsers("老板", undefined, "server");
  assert.ok(matches.length > 0, "「老板」应当能搜到账户");
  for (const item of matches) {
    assert.equal(typeof item.ownedCount, "number", "挑人时要能看出他手上已经有多少张券");
  }

  assert.deepEqual(await searchGrantTargetUsers("", undefined, "server"), []);
  assert.deepEqual(await searchGrantTargetUsers("   ", undefined, "server"), []);
});

// ═══════════════ C. 账户「可用」与 checkout 一致（裁定 §八 / §九 / §十 / §十四） ═══════════════

test("§十四 回归：账户里有多张「看起来可用」的券时，checkout 必须至少给出那张满减券", async () => {
  // 这一条**逐字**对应人工验收现场：一个用户手里躺着好几张券，
  // 账户页把它们都显示成「未使用」，一进结算页却「暂无可用优惠券」。
  const user = unique("u-consistency");

  // 三张形态各异的券：能用的满减券 + 折扣券 + 无门槛券
  const thresholdClaim = await issueUsableCoupon(user, THRESHOLD_COUPON);
  await issueUsableCoupon(user, DISCOUNT_COUPON);
  await issueUsableCoupon(user, GIFT_COUPON);

  // ① 账户页：三张都看得到
  const page = await queryCouponsForUser(
    user,
    new URLSearchParams({ tab: "owned", pageSize: "50" }),
    "server",
  );
  assert.equal(page.items.length, 3, "前置：账户里确实有三张券");

  // ② 结算页：**必须**至少出现那张满减券
  const draft = await previewCheckout(selection(), user, undefined, "server");
  const claimIds = draft.availableCoupons.map((item) => item.claimId);
  assert.ok(
    claimIds.includes(thresholdClaim),
    "⚠️ 这一条就是人工验收现场那个缺陷的回归：账户里有的满减券，结算页必须给得出来",
  );

  // ③ 折扣券与无门槛券**不得**被当成可参与结算的券送进结算页
  assert.equal(claimIds.length, 1, "P1-4 只有满减券参与结算，结算页只该给这一张");

  // ④ 账户页对三张券的「能不能用于结算」说法，与结算页的实际行为**一致**
  const byId = new Map(page.items.map((item) => [item.id, item]));
  assert.equal(byId.get(thresholdClaim).settlementUsable, true);
  for (const item of page.items) {
    if (item.id === thresholdClaim) continue;
    assert.equal(item.settlementUsable, false, `${item.name} 不是满减券，账户页不得写「可用于结算」`);
    assert.equal(item.settlementReason, COUPON_SETTLEMENT_UNSUPPORTED_REASON);
  }
});

test("§九 账户页口径与结算页口径是**同一个判定**：非满减券两处都说不可用", async () => {
  const user = unique("u-consistency-2");
  const discountClaim = await issueUsableCoupon(user, DISCOUNT_COUPON);

  const item = await ownedItem(user, discountClaim);
  assert.equal(item.status, "unused", "它的**记录状态**确实是未使用——旧口径就是被这一条骗了");
  assert.equal(
    item.settlementUsable,
    false,
    "但它不能参与结算。只报 status 就会出现「账户写可用、结算永远选不到」的前后矛盾",
  );

  const draft = await checkoutCoupons(user, { couponClaimId: discountClaim });
  assert.equal(draft.coupon?.applicable, false, "结算侧确实用不了——两边说的是同一件事");
  assert.equal(draft.couponDiscountAmount, 0);

  // ⚠️ 两页的**文案不同是刻意的**，不是第二套口径：
  //   · 账户页回答「这张券能不能用于结算」；
  //   · 结算页回答「这一单为什么用不上它」。
  // 两句话在 `lib/constants/coupons.ts` 里紧挨着，注释也写明「同一件事的两种说法，因为听众不同」。
  // **必须一致的是结论，不是措辞**——旧缺陷正是结论在两侧分了叉。
  assert.equal(
    resolveCouponClaimGate(claimOf(discountClaim), new Date(), true).code,
    "unsupported_form",
    "两处拦下它的是同一个闸、同一个原因（券的形态）",
  );
  assert.equal(draft.couponReason, COUPON_USE_UNSUPPORTED_REASON, "结算页说的是「这一单为什么用不上」");
  assert.equal(
    (await ownedItem(user, discountClaim)).settlementReason,
    COUPON_SETTLEMENT_UNSUPPORTED_REASON,
    "账户页说的是「能不能用于结算」",
  );
});

test("§九 账户页把已停用模板的券也说成「不可用于结算」", async () => {
  const user = unique("u-consistency-disabled");
  const claimId = await issueUsableCoupon(user);

  const restore = patchCouponTemplate(THRESHOLD_COUPON, { enabled: false });
  try {
    const item = await ownedItem(user, claimId);
    assert.equal(item.status, "unused");
    assert.equal(item.settlementUsable, false, "模板停用了，账户页也要跟着说不可以用");
    assert.equal(item.settlementReason, COUPON_USE_DISABLED_REASON);
  } finally {
    restore();
  }
});

test("§十 未达门槛：结算页**展示但禁用**，并写明「还差多少」", async () => {
  const user = unique("u-threshold-miss");
  const claimId = await issueUsableCoupon(user);

  // 只买 1 份：2990 < 10000 门槛。⚠️ 必须**真的把这张券带进试算**——
  // 不传 `couponClaimId` 的话它压根不参与判定，测的就不是「未达门槛」这条规则
  const draft = await previewCheckout(
    selection({ quantity: 1, couponClaimId: claimId }),
    user,
    undefined,
    "server",
  );

  const option = draft.availableCoupons.find((item) => item.claimId === claimId);
  assert.ok(option, "有券但金额不够时，券**必须仍然出现在列表里**——藏起来用户会一直找它");
  assert.equal(option.applicable, false, "它不能选");
  assert.equal(option.discountAmount, 0);

  const reason = couponThresholdNotMetReason(UNIT_PRICE, 10000);
  assert.equal(option.reason, reason);
  assert.match(option.reason, /还差/, "必须告诉他差额——那才是他能行动的信息（裁定 §十）");
  // 金额一律走 `formatYuan`（恒两位小数）。这里钉死小数位，是因为本文件曾经自带一个
  // 去掉尾零的 `formatCouponYuan`，把 ¥70.10 显示成「¥70.1」——与全站金额写法不一致。
  assert.match(option.reason, /满 ¥100\.00 可用/);
  assert.match(option.reason, /还差 ¥70\.10/);

  // 而且这一单确实没有减钱
  assert.equal(draft.couponDiscountAmount, 0);
  assert.equal(draft.coupon?.applicable, false, "未达门槛的券不得被采用");
  assert.equal(draft.couponReason, reason, "试算给出的原因与门槛判定同源，不是另写一句话");
});

test("§十 满足门槛后同一张券就能选：试算真的减了钱", async () => {
  const user = unique("u-threshold-hit");
  const claimId = await issueUsableCoupon(user);

  const draft = await previewCheckout(selection(), user, undefined, "server");
  const option = draft.availableCoupons.find((item) => item.claimId === claimId);
  assert.ok(option);
  assert.equal(option.applicable, true);
  assert.equal(option.discountAmount, 1000);
  assert.equal(option.reason, "");

  // 带上它下单，实付真的减了
  const chosen = await previewCheckout(selection({ couponClaimId: claimId }), user, undefined, "server");
  assert.equal(chosen.coupon.claimId, claimId);
  assert.equal(chosen.couponDiscountAmount, 1000);
  assert.equal(chosen.actualPaidAmount, chosen.originalAmount - 1000);
});

test("§十 一张可参与结算的券都没有时，才显示「暂无可用优惠券」", async () => {
  // 手里只有折扣券的用户：结算页的列表为空 —— 这是**正确**的，
  // 因为折扣券本来就不参与结算，而账户页也已经明说它「暂不可用于结算」
  const user = unique("u-none-usable");
  await issueUsableCoupon(user, DISCOUNT_COUPON);

  const draft = await checkoutCoupons(user);
  assert.deepEqual(draft.availableCoupons, [], "没有可参与结算的券 ⇒ 列表为空 ⇒ 页面显示「暂无可用优惠券」");

  // 但这与账户页**不矛盾**：账户页已经把这张券标成「暂不可用于结算」
  const page = await queryCouponsForUser(user, new URLSearchParams({ tab: "owned" }), "server");
  assert.equal(page.items[0].settlementUsable, false);
});

test("§十一 checkout 只能使用自己的 claimId：别人的券一律不认", async () => {
  const owner = unique("u-owner");
  const attacker = unique("u-attacker");
  const claimId = await issueUsableCoupon(owner);

  const draft = await checkoutCoupons(attacker, { couponClaimId: claimId });
  assert.equal(draft.coupon, null, "别人的券不得被采用");
  assert.equal(draft.couponDiscountAmount, 0);

  // 下单同样拒绝（不是「试算不给、下单却给」）
  await assert.rejects(
    () =>
      createPaymentRequest(
        { ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() },
        attacker,
      ),
    "下单必须与试算同口径地拒绝别人的券",
  );
  assert.equal(claimOf(claimId).status, "unused", "被拒绝的请求不得核销别人的券");
});

test("§十一 / §十二 重复核销拒绝：同一张券不可能被两笔订单各用一次", async () => {
  const user = unique("u-double-spend");
  const claimId = await issueUsableCoupon(user);

  const first = await createPaymentRequest(
    { ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() },
    user,
  );
  assert.equal((await confirmPaymentRequest(first.request.id, "success", user)).orderCreated, true);
  assert.equal(claimOf(claimId).status, "used");

  // 第二笔换一个幂等键，仍然必须被拒——而且是在**建支付请求**这一步就被拒，
  // 不是等用户付了钱再告诉他券用不了（那笔钱是要退回去的）
  await assert.rejects(
    () =>
      createPaymentRequest(
        { ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() },
        user,
      ),
    /已使用/,
  );

  // 而且不得建出第二张订单
  const orders = [...paymentStore().orders.values()].filter((o) => o.coupon?.claimId === claimId);
  assert.equal(orders.length, 1, "只可能有一张订单用掉这张券");
  assert.equal(claimOf(claimId).status, "used");
});

test("§十三.27 建单**失败**时不消耗券（拒绝发生在核销之前）", async () => {
  const user = unique("u-create-fail");
  const claimId = await issueUsableCoupon(user);

  // 拿一张**已停用**的券下单：服务端在核销之前就该拒绝
  const restore = patchCouponTemplate(THRESHOLD_COUPON, { enabled: false });
  try {
    await assert.rejects(() =>
      createPaymentRequest(
        { ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() },
        user,
      ),
    );
    assert.equal(claimOf(claimId).status, "unused", "建单失败之后券必须还是可用的");
    assert.equal(claimOf(claimId).usedAt, null);
  } finally {
    restore();
  }

  // 恢复之后这张券仍然能正常用掉——它的状态没有被那次失败污染
  const retry = await createPaymentRequest(
    { ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() },
    user,
  );
  assert.equal((await confirmPaymentRequest(retry.request.id, "success", user)).orderCreated, true);
  assert.equal(claimOf(claimId).status, "used");
});

test("§十一 服务端不信任前端传的金额：请求体里的 discountAmount 一律不读", async () => {
  const user = unique("u-forge");
  const claimId = await issueUsableCoupon(user);

  // 试算里塞伪造字段 —— 服务端只认 couponClaimId
  const draft = await previewCheckout(
    { ...selection({ couponClaimId: claimId }), discountAmount: 999999, thresholdAmount: 1 },
    user,
    undefined,
    "server",
  );
  assert.equal(draft.couponDiscountAmount, 1000, "抵扣额是服务端按快照算的，不是请求体给的");

  // 下单同样塞一份伪造金额
  const created = await createPaymentRequest(
    {
      ...selection({ couponClaimId: claimId }),
      discountAmount: 999999,
      thresholdAmount: 1,
      couponDiscountAmount: 999999,
      idempotencyKey: uniqueKey(),
    },
    user,
  );
  assert.equal(created.request.coupon.discountAmount, 1000, "支付请求上的券面额仍来自快照");
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.order.couponDiscountAmount, 1000, "订单上的抵扣额也来自服务端计算");
  assert.equal(confirmed.order.actualPaidAmount, confirmed.order.originalAmount - 1000);
});

// ═══════════════ D. 纯口径的边界（不经过链路，只钉判定本身） ═══════════════

test("§九 resolveCouponSettlementUsability 与 resolveCouponClaimGate 永远同向", async () => {
  const user = unique("u-gate-parity");
  const claimId = await issueUsableCoupon(user);
  const claim = claimOf(claimId);
  const now = new Date();

  for (const enabled of [true, false]) {
    const gate = resolveCouponClaimGate(claim, now, enabled);
    const settlement = resolveCouponSettlementUsability(claim, now, enabled);
    assert.equal(
      settlement.usable,
      gate.ok,
      "账户页口径与前置闸必须同向——两套口径正是本轮那个缺陷的根因",
    );
  }
});

test("§九 非满减券在账户页的那句话，与结算页的那句话是同一件事的两种说法", async () => {
  const user = unique("u-wording");
  const claimId = await issueUsableCoupon(user, DISCOUNT_COUPON);
  const claim = claimOf(claimId);

  const item = toOwnedCouponItem(claim, new Date(), true);
  assert.equal(item.settlementReason, COUPON_SETTLEMENT_UNSUPPORTED_REASON);
  assert.match(item.settlementReason, /暂不可用于结算/);

  // 「可用于结算」是正面标记，只给真能用的那些
  const usable = toOwnedCouponItem(claimOf(await issueUsableCoupon(unique("u-wording-2"))), new Date(), true);
  assert.equal(usable.settlementUsable, true);
  assert.equal(usable.settlementReason, "");
});

test("§二 返券把 usedAt 清成 null，但 claimedAt 不动（领取/发放时刻是历史事实）", async () => {
  const { user, claimId, order } = await paidNeverAccepted();
  const claimedAt = claimOf(claimId).claimedAt;

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const after = claimOf(claimId);
  assert.equal(after.usedAt, null);
  assert.equal(after.claimedAt, claimedAt, "返还不该改写这张券是什么时候来的");
  assert.equal(after.id, claimId);
});

test("§六 source 与 grantedByAdminId 互为充要条件", async () => {
  const user = SEEDED_USER;
  const selfClaim = await issueUsableCoupon(user);
  const granted = await grantCouponToUser(
    ADMIN,
    { userId: user, couponId: THRESHOLD_COUPON, idempotencyKey: uniqueKey() },
    "server",
  );

  for (const claim of couponStore().claims.values()) {
    if (claim.source === "self_claim") {
      assert.equal(claim.grantedByAdminId, null, "自己领的券没有发放人");
    } else {
      assert.equal(
        typeof claim.grantedByAdminId === "string",
        true,
        "管理员发的券必须留下发放人——这是 §六 要求的最小审计",
      );
    }
  }

  assert.equal(claimOf(selfClaim).source, "self_claim");
  assert.equal(claimOf(granted.claimId).source, "admin_grant");
});

test("§十三.29 订单详情与结算页对实付的说法一致（返券不改变任何一处的展示）", async () => {
  const { user, claimId, order } = await paidNeverAccepted();

  const detail = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.ok(detail, "前置：订单详情读得到");
  assert.equal(detail.actualPaidAmount, order.actualPaidAmount);
  assert.equal(detail.couponDiscountAmount, order.couponDiscountAmount);

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const afterRefund = await getOrderDetailForUser(order.id, user, undefined, "server");
  assert.ok(afterRefund, "退款之后订单仍然读得到（它是 refunded，不是消失）");
  assert.equal(afterRefund.actualPaidAmount, order.actualPaidAmount, "退款不改历史实付");
  assert.equal(afterRefund.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(afterRefund.coupon?.claimId, claimId, "订单仍然指得出当初用的是哪张券");
  assert.equal(claimOf(claimId).status, "unused", "而那张券的使用资格已经还回来了");
});

test("§十二 退款与还券在同一段无 await 的区段里：退款返回时券已经是 unused", async () => {
  const { user, claimId, order } = await paidNeverAccepted();

  const result = await directRefundOrderForUser(order.id, user, undefined, "server");

  // 因为退款事务是同步的，这一句在它返回之后立刻成立——不存在「钱退了、券还没还」的中间态
  assert.equal(result.refundedAmount, order.actualPaidAmount);
  assert.equal(
    claimOf(claimId).status,
    "unused",
    "裁定 §十二：退款实际成功 → 才恢复 Claim；两者之间不允许有可观察的窗口",
  );
  assert.equal((await getPaymentRepository().findOrderById(order.id)).status, "refunded");
});

test("§十三.30 未使用券的订单在 P0-15 口径下不产生任何 Earning（返券不影响这一条）", async () => {
  // 一条反向的不变量：paid 阶段退款的单从来没有 Earning，
  // 因此「返券」这件事不会凭空造出一条收益调整记录
  const { user, order } = await paidNeverAccepted();

  await directRefundOrderForUser(order.id, user, undefined, "server");

  const earnings = await listCompanionEarnings(COMPANION);
  assert.equal(
    earnings.items.filter((item) => item.orderId === order.id).length,
    0,
    "未接单就退款的单不该有收益记录",
  );
});
