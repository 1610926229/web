import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { EVIDENCE_PLACEHOLDER_URL } from "../lib/constants/evidence.ts";
import {
  REVIEW_ALREADY_REVIEWED_MESSAGE,
  REVIEW_CONTENT_MAX_LENGTH,
  REVIEW_CONTENT_TOO_LONG_MESSAGE,
  REVIEW_DIMENSION_MISSING_MESSAGE,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_MOCK_NOTICE,
  REVIEW_MODERATION_ACTIONS,
  REVIEW_MODERATION_AUDIT_ACTIONS,
  REVIEW_MODERATION_REQUIRES_REASON,
  REVIEW_MODERATION_SOURCE_STATUS,
  REVIEW_MODERATION_TARGET_STATUS,
  REVIEW_NOT_COMPLETED_MESSAGE,
  REVIEW_ORDER_NOT_FOUND_MESSAGE,
  REVIEW_PAGE_SIZE,
  REVIEW_RANGES,
  REVIEW_RANGE_INVALID_MESSAGE,
  REVIEW_RATING_REQUIRED_MESSAGE,
  REVIEW_RATINGS,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_TRANSITIONS,
  REVIEW_TABS,
  REVIEW_TAB_INVALID_MESSAGE,
  canApplyReviewModeration,
  canReviewOrder,
  canTransitionReviewStatus,
  countReviewDimensions,
  isPendingReview,
  isWithinReviewRange,
  mergePendingReviewPage,
  mergeReviewPage,
  normalizeReviewContent,
  normalizeReviewReason,
  parseReviewListQuery,
  reviewDimensionErrors,
  reviewRangeStart,
} from "../lib/constants/reviews.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE } from "../lib/constants/writes.ts";
import { BEIJING_OFFSET_MINUTES } from "../lib/utils/format.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getReviewRepository } from "../lib/data/reviewRepository.ts";
import { reviewSeed } from "../lib/mocks/fixtures/reviewSeed.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import {
  createReviewForOrder,
  getReviewTargetForUser,
  queryReviewsForUser,
  resubmitReviewForUser,
} from "../lib/services/reviews.ts";

/**
 * 评价的持续测试（P1-8 双维度闭环）。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/reviews.ts`，因此
 * 「只能评价自己的已完成订单」「一单一评」「幂等重试与并发提交只产生一条」
 * 「伪造身份与状态无效」「时间筛选边界正确」「DTO 不泄漏订单私密字段」
 * 这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * ⚠️ **退款与评价资格无关**（`D18` / `D19`）：这个文件里刻意**没有**任何
 * 「退款中 / 已退款不能评价」的用例——那条规则已被产品裁定推翻。
 * 取而代之的是「已完成之后发生退款**仍然可以评价**」，以及「完成前退款
 * （没有 `completedAt`）不可评价」。判据只有一条：`completedAt`。
 *
 * ⚠️ 评分与正文在**两个维度**上各自独立（`D2`）：一条评价最多一个商品维度、
 * 一个打手维度，两者不互相复制，没评的那个是 `null`（`D3`）。
 *
 * 时间一律显式钉死在 `NOW`（时间筛选依赖当前时间，传真实时间的话用例会在某一天突然变红）。
 */
const USER_A = "u-1001";
/**
 * 对照用户：**种子里一条评价都没有**，但有两单已完成、未评价的订单
 * （`ord-seed-1007-01` / `-02`），因此既能验证空态、又能走完整的提交与分页。
 */
const USER_B = "u-1007";

/** 北京时间 2026-09-13 20:00。 */
const NOW = new Date("2026-09-13T12:00:00.000Z");

/** 已完成、且种子里**没有**评价的订单（A 的，实际履约打手 cp-3）。 */
const PENDING_ORDER = "ord-seed-1001-08";
/** 已完成、且种子里已经评价过的订单（A 的）。 */
const REVIEWED_ORDER = "ord-seed-1001-05";
/** 已退款订单（A 的）：**完成前**就退款了，因此没有完成时间，不可评价（D19）。 */
const REFUNDED_ORDER = "ord-seed-1001-06";
/** 别人的已完成订单（u-1002 的）：A 拿它当入参必须得到 404。 */
const OTHER_USER_ORDER = "ord-seed-1002-02";
/** B 自己的两单：可用于提交与翻页。 */
const B_ORDERS = ["ord-seed-1007-01", "ord-seed-1007-02"];

/** 非「已完成」的订单：已付款 / 已接单 / 护航中。 */
const NOT_COMPLETED_ORDERS = ["ord-seed-1001-01", "ord-seed-1001-03", "ord-seed-1001-04"];

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `review-test-key-${process.pid}-${keySeq}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function list(userId, params = {}, now = NOW) {
  return queryReviewsForUser(userId, page(params), "server", now);
}

function reviewed(userId, params = {}, now = NOW) {
  return list(userId, { tab: "reviewed", ...params }, now);
}

function pending(userId, params = {}, now = NOW) {
  return list(userId, { tab: "pending", ...params }, now);
}

/**
 * 提交一条评价。默认**只评商品维度**：这样「另一个维度是 `null`」是一眼可见的，
 * 需要验证双维度或只评打手的用例显式覆盖 `companionReview`。
 */
function submit(orderId, userId, body = {}, now = NOW) {
  return createReviewForOrder(
    orderId,
    userId,
    {
      // 默认给一个幂等键：每次调用都是一次新的「提交意图」。
      // 需要验证「缺少幂等键」的用例显式传空串覆盖掉它。
      idempotencyKey: uniqueKey(),
      productReview: { rating: 5, content: "打得很稳，沟通顺畅。（Mock 文案）" },
      companionReview: null,
      evidence: [],
      ...body,
    },
    undefined,
    "server",
    now,
  );
}

function resubmit(reviewId, userId, body = {}, now = NOW) {
  return resubmitReviewForUser(
    reviewId,
    userId,
    {
      productReview: { rating: 4, content: "改过之后的正文。（Mock 文案）" },
      companionReview: null,
      evidence: [],
      ...body,
    },
    undefined,
    "server",
    now,
  );
}

function target(orderId, userId) {
  return getReviewTargetForUser(orderId, userId, undefined, "server");
}

/** 直接读仓储实体：维度切分、`productId` 这类**内部**事实在这里断言，DTO 里看不到。 */
function stored(reviewId) {
  return getReviewRepository().findReviewById(reviewId);
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 直接往退款仓储里塞一条退款申请：用来构造「已完成之后又有退款」的订单。 */
function fakeRefund(orderId, status) {
  return {
    id: `rf-test-${status}`,
    refundNo: `RFTEST${status}`,
    userId: USER_A,
    orderId,
    status,
    amount: 3590,
    reasonKey: "service_quality",
    reasonLabel: "服务问题",
    description: "测试用退款申请：用来验证退款不影响评价资格（D18 / D19）。",
    evidence: [],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    reviewingAt: status === "pending" ? null : "2026-09-12T01:00:00.000Z",
    reviewedAt: null,
    reviewNote: "",
    cancelledAt: null,
  };
}

async function attachRefund(orderId, status) {
  const outcome = await getRefundRepository().createRefundRequest(
    fakeRefund(orderId, status),
    uniqueKey(),
  );
  assert.equal(outcome.ok, true);
}

beforeEach(() => {
  resetMockStore("review");
  // 退款也要回到干净状态：有的用例会给订单挂上一条退款申请
  resetMockStore("refund");
});

// ——————————————————————————— 列表 ———————————————————————————

test("已评价列表只包含当前用户的评价，且按评价时间倒序", async () => {
  const result = await reviewed(USER_A);

  assert.equal(result.tab, "reviewed");
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["rev-seed-1001-01", "rev-seed-1001-02", "rev-seed-1001-03"],
  );
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].createdAt >= result.items[index].createdAt);
  }

  // 作者看得见自己的**全部状态**（D8）：种子这三条都是 approved，但 DTO 不是「只返回已通过」
  for (const item of result.items) assert.equal(item.status, "approved");

  // B 一条评价都没有：空态不需要额外的调试开关就能看到
  const other = await reviewed(USER_B);
  assert.equal(other.total, 0);
  assert.deepEqual(other.items, []);
});

test("待评价列表是「已完成且没有评价」的订单，与已评价列表不重叠", async () => {
  const result = await pending(USER_A);

  assert.equal(result.tab, "pending");
  // A 的待评价订单不止一条：除种子里的那一单，还有排行榜周期榜预置的今日订单
  // （`buildRankingPeriodOrders`，见 `orderSeed.ts`）。那条订单的完成时间相对**真实当前时间**
  // 构造，因此在钉死 `NOW` 的用例里不能断言「列表里只有哪几条」——
  // 这里只断言种子那一单在、已评价的那一单不在，与真实执行日期无关。
  const pendingIds = result.items.map((item) => item.orderId);
  assert.equal(pendingIds.includes(PENDING_ORDER), true, "种子里未评价的已完成订单应当出现");
  assert.equal(pendingIds.includes(REVIEWED_ORDER), false, "已评价的订单不该出现在待评价里");

  // 已完成但已经评价过的订单不会同时出现在两处
  const reviewedIds = new Set((await reviewed(USER_A)).items.map((item) => item.orderId));
  for (const item of result.items) assert.equal(reviewedIds.has(item.orderId), false);

  // 待评价订单带上服务端算出的权限：这一单可以评价，因此没有原因文案
  const pendingItem = result.items.find((item) => item.orderId === PENDING_ORDER);
  assert.deepEqual(pendingItem.allowedActions, { canReview: true, reason: "" });

  // B 的待评价列表就是他两单已完成的订单，一条评价都没有
  assert.deepEqual(
    (await pending(USER_B, { pageSize: 50 })).items.map((item) => item.orderId).sort(),
    [...B_ORDERS].sort(),
  );
});

test("两个 Tab 的角标由服务端给出，提交后立刻更新", async () => {
  const before = (await reviewed(USER_A)).counts;
  // 已评价的口径只由评价种子决定（3 条），与订单预置数据无关
  assert.equal(before.reviewed, 3);
  // 待评价的条数含排行榜周期榜预置的订单，因此只断言「前后差一」，不写死绝对值：
  // 写死就会变成一条依赖真实执行日期的用例
  assert.ok(before.pending >= 1, "至少种子里的那一单待评价");

  await submit(PENDING_ORDER, USER_A);

  const after = await reviewed(USER_A);
  assert.deepEqual(after.counts, { reviewed: before.reviewed + 1, pending: before.pending - 1 });
  // 刚提交的评价立刻能从列表里读到
  const submitted = after.items.find((item) => item.orderId === PENDING_ORDER);
  assert.ok(submitted, "刚提交的评价应当立刻出现在已评价列表里");
  assert.equal(submitted.productReview.rating, 5);
  assert.equal(submitted.companionReview, null, "没评的那个维度是 null，不是空对象");
  // 提交后是「审核中」而不是「已通过」：评价必须经过审核才公开（D7）
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.statusLabel, REVIEW_STATUS_LABELS.pending);
  assert.equal(submitted.canResubmit, false, "只有被驳回的才给重新提交入口");
  // 同一条订单不会留在「待评价」里
  assert.equal(
    (await pending(USER_A)).items.some((item) => item.orderId === PENDING_ORDER),
    false,
  );
});

test("提交后能从评价列表与订单详情两个入口读到同一条评价", async () => {
  const created = await submit(PENDING_ORDER, USER_A, {
    productReview: {
      rating: 4,
      content: "配合得不错，中间换了一次英雄也处理得挺利落。（Mock 文案）",
    },
    evidence: [{ kind: "image", name: "结算截图.png" }],
  });

  const found = (await reviewed(USER_A)).items.find((item) => item.id === created.reviewId);
  assert.ok(found);
  assert.equal(found.productReview.rating, 4);
  assert.equal(found.evidence.length, 1);
  // 凭证地址由服务端写成占位图，客户端提交的文件名只用于展示
  assert.equal(found.evidence[0].url, EVIDENCE_PLACEHOLDER_URL);

  // 订单详情：评价过之后不再有评价入口；摘要只说「走到哪一步」，**不带星级**——
  // 一条评价最多两个星级，挑一个显示等于替用户决定哪个代表这次消费
  const detail = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  assert.equal(detail.allowedActions.canReview, false);
  assert.equal(detail.reviewSummary.id, created.reviewId);
  assert.equal(detail.reviewSummary.status, "pending");
  assert.equal(detail.reviewSummary.statusLabel, REVIEW_STATUS_LABELS.pending);
  assert.equal(detail.reviewSummary.canResubmit, false);
  assert.equal("rating" in detail.reviewSummary, false, "订单详情摘要不该出现星级");

  // 还没评价的订单则相反：有入口、没有摘要
  const before = await getOrderDetailForUser(B_ORDERS[1], USER_B, undefined, "server");
  assert.equal(before.allowedActions.canReview, true);
  assert.equal(before.reviewSummary, null);
});

// ——————————————————————————— 双维度（D1 / D2 / D3）———————————————————————————

test("一条评价最多两个维度：只评商品 / 只评打手 / 两个都评都合法", async () => {
  // ① 只评商品
  const productOnly = await submit(PENDING_ORDER, USER_A, {
    productReview: { rating: 4, content: "只评商品。（Mock 文案）" },
    companionReview: null,
  });
  const productEntity = await stored(productOnly.reviewId);
  assert.deepEqual(productEntity.productReview, { rating: 4, content: "只评商品。（Mock 文案）" });
  assert.equal(productEntity.companionReview, null);

  // ② 只评打手（同一个订单要先清掉上一轮的记录）
  resetMockStore("review");
  const companionOnly = await submit(PENDING_ORDER, USER_A, {
    productReview: null,
    companionReview: { rating: 3, content: "只评打手。（Mock 文案）" },
  });
  const companionEntity = await stored(companionOnly.reviewId);
  assert.equal(companionEntity.productReview, null);
  assert.deepEqual(companionEntity.companionReview, { rating: 3, content: "只评打手。（Mock 文案）" });

  // ③ 两个都评：两个维度**各自独立**，没有任何「互相复制」的痕迹（D2）
  resetMockStore("review");
  const both = await submit(PENDING_ORDER, USER_A, {
    productReview: { rating: 5, content: "商品侧正文。（Mock 文案）" },
    companionReview: { rating: 2, content: "打手侧正文。（Mock 文案）" },
  });
  const bothEntity = await stored(both.reviewId);
  assert.deepEqual(bothEntity.productReview, { rating: 5, content: "商品侧正文。（Mock 文案）" });
  assert.deepEqual(bothEntity.companionReview, { rating: 2, content: "打手侧正文。（Mock 文案）" });
  assert.equal(countReviewDimensions(bothEntity), 2);
  assert.notDeepEqual(bothEntity.productReview, bothEntity.companionReview, "两个维度不该被互相复制");

  // 一个维度都没有：直接拒绝（D3「至少一个有效维度」）。
  // ⚠️ 必须先把上面那条清掉——这一单已经有评价时，重复提交会走「一单一评」的快路径
  // 返回既有结果，压根不会走到维度校验，那样就验不到这条规则了。
  resetMockStore("review");
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { productReview: null, companionReview: null }),
    "BAD_REQUEST",
    REVIEW_DIMENSION_MISSING_MESSAGE,
  );
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { productReview: null }),
    "BAD_REQUEST",
    REVIEW_DIMENSION_MISSING_MESSAGE,
  );
  // 无效提交不占用「一单一评」的名额：这一单仍然是待评价
  assert.equal((await reviewed(USER_A)).total, 3);
  assert.equal((await target(PENDING_ORDER, USER_A)).status, "ready");
});

test("商品维度与打手维度的聚合身份分开：打手维度认实际履约打手，不认指定打手（D4 / R4）", async () => {
  const created = await submit(PENDING_ORDER, USER_A, {
    productReview: { rating: 5, content: null },
    companionReview: { rating: 5, content: null },
  });
  const entity = await stored(created.reviewId);
  // 读**订单实体**而不是订单 DTO：`productId` / `specId` 是内部聚合身份，
  // 不该出现在面向用户的订单详情里，这里要断言的是「评价抄的是订单那一份」
  const order = await getPaymentRepository().findOrderById(PENDING_ORDER);
  const detail = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");

  // 聚合身份来自订单：商品维度的 productId 与打手维度的实际履约打手
  assert.equal(entity.productId, order.productId);
  assert.equal(entity.specId, order.specId);
  assert.equal(entity.companion.id, order.companion.id);
  // 打手维度认的是**实际履约打手**（D4）：它就是 DTO 上展示的那一位
  assert.equal(entity.companion.id, detail.companion.id);
  // 快照也是从订单抄的，不跟着商品改名漂移
  assert.equal(entity.productTitle, order.productTitle);
  assert.equal(entity.specName, order.specName);
  assert.equal(entity.completedAt, order.completedAt ?? order.paidAt);
});

// ——————————————————————————— 评价资格（D18 / D19 / D20）———————————————————————————

test("只有真正完成过服务的订单可以评价：已付款 / 已接单 / 护航中都还没有完成时间", async () => {
  for (const orderId of NOT_COMPLETED_ORDERS) {
    await expectApiError(submit(orderId, USER_A), "BAD_REQUEST", REVIEW_NOT_COMPLETED_MESSAGE);
    // 列表里的入口也照样不存在——判定只有一处实现
    const blocked = await target(orderId, USER_A);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, REVIEW_NOT_COMPLETED_MESSAGE);
  }

  // 完成前就退款的订单（`paid → refunded`）：从来没有过完成时间，因此给的是同一句原因（D19）
  await expectApiError(submit(REFUNDED_ORDER, USER_A), "BAD_REQUEST", REVIEW_NOT_COMPLETED_MESSAGE);
  assert.equal((await target(REFUNDED_ORDER, USER_A)).status, "blocked");

  // 一条都没写进去
  assert.equal((await reviewed(USER_A)).total, 3);
});

test("退款不影响评价资格：已完成之后退款（审核中 / 已通过）仍然可以评价（D18 / D19）", async () => {
  // 退款审核中：服务已经完成过，评价资格不受影响
  await attachRefund(PENDING_ORDER, "reviewing");
  assert.equal((await target(PENDING_ORDER, USER_A)).status, "ready");
  const reviewing = await submit(PENDING_ORDER, USER_A);
  assert.equal(reviewing.created, true);
  assert.equal(reviewing.status, "pending");

  // 退款已通过（钱退回去了）：**仍然**可以评价——退款回答「钱退了多少」，
  // 评价回答「这次服务怎么样」，两者可以同时成立
  resetMockStore("refund");
  resetMockStore("review");
  await attachRefund(PENDING_ORDER, "approved");
  assert.equal((await target(PENDING_ORDER, USER_A)).status, "ready");
  const refunded = await submit(PENDING_ORDER, USER_A);
  assert.equal(refunded.created, true);

  // 待评价列表与订单详情上的入口同样不受影响：判定只有一处实现
  resetMockStore("refund");
  resetMockStore("review");
  await attachRefund(PENDING_ORDER, "approved");
  const pendingItem = (await pending(USER_A)).items.find((item) => item.orderId === PENDING_ORDER);
  assert.deepEqual(pendingItem.allowedActions, { canReview: true, reason: "" });
  const detail = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  assert.equal(detail.allowedActions.canReview, true);
});

// ——————————————————————————— 一单一评 / 幂等 / 并发 ———————————————————————————

test("一单一评：重复提交返回第一次的结果，且不修改已有评价", async () => {
  const first = await submit(REVIEWED_ORDER, USER_A, {
    productReview: { rating: 1, content: "想改成差评。（Mock 文案）" },
  });

  assert.equal(first.created, false);
  assert.equal(first.reviewId, "rev-seed-1001-01");
  // 原来那条评价的内容没有被覆盖
  const original = (await reviewed(USER_A)).items.find((item) => item.id === "rev-seed-1001-01");
  assert.equal(original.productReview.rating, 5);
  assert.equal((await reviewed(USER_A)).total, 3);
});

test("幂等重试与并发提交都只产生一条评价", async () => {
  const key = uniqueKey();
  const first = await submit(PENDING_ORDER, USER_A, { idempotencyKey: key });
  assert.equal(first.created, true);

  // 同一个幂等键重发：返回第一次的结果，不产生第二条
  const retry = await submit(PENDING_ORDER, USER_A, { idempotencyKey: key });
  assert.equal(retry.created, false);
  assert.equal(retry.reviewId, first.reviewId);

  // 换一个幂等键重发：真正兜底的是「用户 + 订单」业务唯一键
  const other = await submit(PENDING_ORDER, USER_A);
  assert.equal(other.reviewId, first.reviewId);

  assert.equal((await reviewed(USER_A)).total, 4);

  // 并发提交：8 个请求同时到达，只能有一次真正创建
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () => submit(B_ORDERS[0], USER_B)),
  );
  const ids = new Set(concurrent.map((item) => item.reviewId));
  assert.equal(ids.size, 1, "并发提交必须收敛到同一条评价");
  assert.equal(concurrent.filter((item) => item.created).length, 1, "只能有一次真正创建");
  assert.equal((await reviewed(USER_B)).total, 1);
});

test("缺少幂等键直接拒绝", async () => {
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { idempotencyKey: "" }),
    "BAD_REQUEST",
    IDEMPOTENCY_KEY_MISSING_MESSAGE,
  );
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { idempotencyKey: "short" }),
    "BAD_REQUEST",
    IDEMPOTENCY_KEY_MISSING_MESSAGE,
  );
  assert.equal((await reviewed(USER_A)).total, 3);
});

test("别人的订单拿不到、也评价不了：一律 404", async () => {
  await expectApiError(submit(OTHER_USER_ORDER, USER_A), "NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
  // 不存在的订单与「不属于你」对外完全一样，因此不能拿订单 id 试探别人有哪些订单
  await expectApiError(submit("ord-not-exist", USER_A), "NOT_FOUND", REVIEW_ORDER_NOT_FOUND_MESSAGE);
  assert.equal((await target(OTHER_USER_ORDER, USER_A)).status, "missing");
  assert.equal((await target("ord-not-exist", USER_A)).status, "missing");
  // 别人的评价也不会出现在自己的列表里：B 评的是他自己的单子
  await submit(B_ORDERS[0], USER_B);
  assert.equal((await reviewed(USER_A)).total, 3);
  assert.equal((await reviewed(USER_B)).total, 1);
});

test("客户端伪造的 userId / orderStatus / companionId / status / createdAt 一概无效", async () => {
  const created = await submit(PENDING_ORDER, USER_A, {
    idempotencyKey: uniqueKey(),
    productReview: { rating: 4, content: "正常评价内容。（Mock 文案）" },
    // 全是客户端不该能决定的东西
    userId: USER_B,
    orderId: OTHER_USER_ORDER,
    orderStatus: "paid",
    // `status` 尤其重要：管理员才改状态（D12），用户提交的评价永远是 `pending`
    status: "approved",
    companionId: "cp-forged",
    companion: { id: "cp-forged", name: "伪造打手", avatarUrl: "/mock/x.svg" },
    productId: "p-forged",
    specId: "sp-forged",
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  const item = (await reviewed(USER_A)).items.find((entry) => entry.id === created.reviewId);
  const order = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  const entity = await stored(created.reviewId);

  // 归属、订单号、打手快照、聚合身份、评价时间、状态全部来自服务端，伪造值一个都没生效
  assert.equal(order.reviewSummary.id, created.reviewId);
  assert.equal(item.orderId, PENDING_ORDER);
  assert.equal(item.orderNo, order.orderNo);
  assert.deepEqual(item.companion, order.companion);
  assert.equal(item.createdAt, NOW.toISOString());
  assert.notEqual(item.companion?.name, "伪造打手");
  const orderEntity = await getPaymentRepository().findOrderById(PENDING_ORDER);
  assert.equal(entity.productId, orderEntity.productId);
  assert.equal(entity.specId, orderEntity.specId);
  assert.equal(entity.status, "pending");
  assert.equal(entity.reviewedBy, null);

  // 伪造的订单 id 没有让评价落到别人的单子上
  assert.equal((await reviewed(USER_B)).total, 0);
});

// ——————————————————————————— 维度校验 ———————————————————————————

test("维度的服务端校验：星级必填、正文可选、超长拒绝", async () => {
  const dimension = (body) => submit(PENDING_ORDER, USER_A, { productReview: body });

  // 星级必填：0 / 6 / 非整数 / 缺省都不构成一个维度
  await expectApiError(dimension({ rating: 0 }), "BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);
  await expectApiError(dimension({ rating: 6 }), "BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);
  await expectApiError(dimension({ rating: "5.5" }), "BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);
  // 只写字不选星：同样拒绝——星级才是这个维度存在的标志（D3）
  await expectApiError(dimension({ content: "写了字但没打分" }), "BAD_REQUEST", REVIEW_RATING_REQUIRED_MESSAGE);

  // 正文可选（D3）：缺省、空串、全空格都合法，一律收敛成 null
  for (const body of [{ rating: 5 }, { rating: 5, content: "" }, { rating: 5, content: "   " }]) {
    resetMockStore("review");
    const created = await submit(PENDING_ORDER, USER_A, { productReview: body });
    const entity = await stored(created.reviewId);
    assert.deepEqual(entity.productReview, { rating: 5, content: null }, `${JSON.stringify(body)} 应当收敛成 null`);
  }

  // 超长拒绝
  resetMockStore("review");
  await expectApiError(
    dimension({ rating: 5, content: "好".repeat(REVIEW_CONTENT_MAX_LENGTH + 1) }),
    "BAD_REQUEST",
    REVIEW_CONTENT_TOO_LONG_MESSAGE,
  );

  // 恰好到上限可以提交，且首尾空格不会把计数顶上去
  resetMockStore("review");
  const boundary = await submit(PENDING_ORDER, USER_A, {
    productReview: { rating: 5, content: `  ${"好".repeat(REVIEW_CONTENT_MAX_LENGTH)}  ` },
  });
  assert.equal(boundary.created, true);
  const trimmed = await stored(boundary.reviewId);
  assert.equal(trimmed.productReview.content.length, REVIEW_CONTENT_MAX_LENGTH);

  // 字数按**字符**算：一个汉字、一个字母、一个普通 Emoji 都算 1 个
  resetMockStore("review");
  const emoji = "🎮".repeat(REVIEW_CONTENT_MAX_LENGTH);
  const ok = await submit(PENDING_ORDER, USER_A, { productReview: { rating: 5, content: emoji } });
  assert.equal(ok.created, true);
  resetMockStore("review");
  await expectApiError(
    submit(PENDING_ORDER, USER_A, {
      productReview: { rating: 5, content: "🎮".repeat(REVIEW_CONTENT_MAX_LENGTH + 1) },
    }),
    "BAD_REQUEST",
    REVIEW_CONTENT_TOO_LONG_MESSAGE,
  );
});

test("凭证只收图片，最多 4 张", async () => {
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { evidence: [{ kind: "video", name: "录屏.mp4" }] }),
    "BAD_REQUEST",
    "凭证只支持图片",
  );
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { evidence: [{ kind: "audio", name: "录音.mp3" }] }),
    "BAD_REQUEST",
  );

  const five = Array.from({ length: REVIEW_EVIDENCE_MAX_COUNT + 1 }, (_, index) => ({
    kind: "image",
    name: `截图-${index}.png`,
  }));
  await expectApiError(submit(PENDING_ORDER, USER_A, { evidence: five }), "BAD_REQUEST");

  const four = five.slice(0, REVIEW_EVIDENCE_MAX_COUNT);
  const created = await submit(PENDING_ORDER, USER_A, { evidence: four });
  const entity = await stored(created.reviewId);
  assert.equal(entity.evidence.length, REVIEW_EVIDENCE_MAX_COUNT);
  // 客户端提交的 id 与 url 不被采用：id 由服务端生成，地址一律写成占位图
  assert.equal(entity.evidence[0].url, EVIDENCE_PLACEHOLDER_URL);
  assert.ok(entity.evidence[0].id.startsWith("ev_"));
  assert.equal(entity.evidence[0].name, "截图-0.png");
});

// ——————————————————————————— 重新提交（D9 / R2）———————————————————————————

test("被驳回的评价重新提交：同一条记录回到待审核，不新建第二条", async () => {
  const created = await submit(PENDING_ORDER, USER_A);
  const before = await stored(created.reviewId);

  // 还没被驳回：不能重提（其余状态不可改，D9）
  await expectApiError(
    resubmit(created.reviewId, USER_A),
    "BAD_REQUEST",
    REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  );

  // 由管理员驳回（这里直接走仓储的状态写入，等价于后台通过审核动作落到的那一笔）
  await getReviewRepository().applyReviewStatus(created.reviewId, {
    status: "rejected",
    rejectReason: "内容不符合规范",
    hideReason: null,
    reviewedBy: "admin-test",
    reviewedByName: null,
    reviewedAt: NOW.toISOString(),
  });

  // 表单页读到的是「被驳回」这一态：回到表单，可以重新提交
  const rejectedTarget = await target(PENDING_ORDER, USER_A);
  assert.equal(rejectedTarget.status, "rejected");
  assert.equal(rejectedTarget.review.canResubmit, true);
  assert.equal(rejectedTarget.review.rejectReason, "内容不符合规范");

  const redone = await resubmit(created.reviewId, USER_A);
  assert.equal(redone.created, true);
  assert.equal(redone.status, "pending");
  // **同一条记录**：id / createdAt / 订单绑定都不变
  const after = await stored(created.reviewId);
  assert.equal(after.id, before.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.orderId, before.orderId);
  assert.equal(after.productId, before.productId);
  assert.equal(after.updatedAt, NOW.toISOString());
  assert.equal(after.status, "pending");
  // 驳回原因随状态一起清掉：`rejectReason` 只在 `rejected` 时非空
  assert.equal(after.rejectReason, null);
  // 内容确实换成了新版
  assert.deepEqual(after.productReview, { rating: 4, content: "改过之后的正文。（Mock 文案）" });
  // 没有第二条记录：总数仍是 4（3 条种子 + 这一条）
  assert.equal((await reviewed(USER_A)).total, 4);
});

test("重新提交保持「至少一个有效维度」：零维度照样拒绝", async () => {
  const created = await submit(PENDING_ORDER, USER_A);
  await getReviewRepository().applyReviewStatus(created.reviewId, {
    status: "rejected",
    rejectReason: "内容不符合规范",
    hideReason: null,
    reviewedBy: "admin-test",
    reviewedByName: null,
    reviewedAt: NOW.toISOString(),
  });

  await expectApiError(
    resubmit(created.reviewId, USER_A, { productReview: null, companionReview: null }),
    "BAD_REQUEST",
    REVIEW_DIMENSION_MISSING_MESSAGE,
  );
  const unchanged = await stored(created.reviewId);
  assert.equal(unchanged.status, "rejected", "校验失败不该把状态改掉");
});

test("别人的评价重提不了：与「不存在」同口径", async () => {
  await expectApiError(
    resubmit("rev-seed-1001-01", USER_B),
    "NOT_FOUND",
    REVIEW_ORDER_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    resubmit("rev-not-exist", USER_A),
    "NOT_FOUND",
    REVIEW_ORDER_NOT_FOUND_MESSAGE,
  );
});

// ——————————————————————————— 时间筛选 ———————————————————————————

test("时间筛选：五个取值各自筛出正确的记录数", async () => {
  const counts = {};
  for (const range of ["all", "month", "threeMonths", "halfYear", "year"]) {
    counts[range] = (await reviewed(USER_A, { range })).total;
  }

  // 种子里三条评价分别落在 2026-09-10 / 2026-08-30 / 2026-03-20
  assert.deepEqual(counts, { all: 3, month: 2, threeMonths: 2, halfYear: 3, year: 3 });

  // 待评价订单同样按完成时间筛选：推到 12 月，9 月完成的那一单就不在「近一月」里了。
  // 这里按订单 id 断言而不是数条数：排行榜周期榜预置的订单完成时间相对真实当前时间，
  // 数条数会变成一条依赖执行日期的用例。
  const later = new Date("2026-12-01T12:00:00.000Z");
  assert.equal(
    (await pending(USER_A, { range: "all" }, later)).items.some(
      (item) => item.orderId === PENDING_ORDER,
    ),
    true,
    "「全部」不受时间下界限制，种子那一单仍然在",
  );
  assert.equal(
    (await pending(USER_A, { range: "month" }, later)).items.some(
      (item) => item.orderId === PENDING_ORDER,
    ),
    false,
    "「近一月」不该包含 9 月完成的那一单",
  );
  assert.equal((await reviewed(USER_A, { range: "month" }, later)).total, 0);
  assert.equal((await reviewed(USER_A, { range: "year" }, later)).total, 3);
});

test("时间筛选的纯函数：边界、跨月回退与坏时间", () => {
  // 近一月的下界 = 北京时间 2026-08-13 20:00（= UTC 12:00），到点算在内
  assert.equal(isWithinReviewRange("2026-08-13T12:00:00.000Z", "month", NOW), true);
  assert.equal(isWithinReviewRange("2026-08-13T11:59:59.999Z", "month", NOW), false);

  // 「今年」是自然年：北京时间 2026-01-01 00:00 起算
  assert.equal(isWithinReviewRange("2025-12-31T16:00:00.000Z", "year", NOW), true);
  assert.equal(isWithinReviewRange("2025-12-31T15:59:59.999Z", "year", NOW), false);

  // 31 号往前推一个月不能变成「3 月 3 日」，而是收到 2 月的最后一天。
  // `reviewRangeStart` 返回的是「北京时间那一面」（与展示口径同一个时区），
  // 因此减掉 8 小时才是真实的 UTC 时刻。
  const endOfMarch = new Date("2026-03-31T12:00:00.000Z");
  const startOfWindow = new Date(
    reviewRangeStart("month", endOfMarch) - BEIJING_OFFSET_MINUTES * 60_000,
  );
  assert.equal(startOfWindow.toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(isWithinReviewRange("2026-02-28T12:00:00.000Z", "month", endOfMarch), true);
  assert.equal(isWithinReviewRange("2026-02-28T11:59:59.999Z", "month", endOfMarch), false);

  // 不限时间与坏时间：`all` 不过滤，坏时间按「不在范围内」处理
  assert.equal(reviewRangeStart("all", NOW), null);
  assert.equal(isWithinReviewRange("not-a-date", "all", NOW), true);
  assert.equal(isWithinReviewRange("not-a-date", "month", NOW), false);
});

// ——————————————————————————— 纯函数：资格 / 状态机 / 表单 ———————————————————————————

test("评价资格判定的纯函数：只认完成时间，退款完全不参与（D18 / D19 / D20）", () => {
  const completed = { status: "completed", completedAt: "2026-09-10T12:00:00.000Z" };

  // 完成过服务 ⇒ 可以评价。之后的退款（部分 / 全额）都不改变这件事——
  // 订单状态可能已经变成 refunded，但 `completedAt` 还在
  for (const status of ["completed", "refunded"]) {
    assert.deepEqual(
      canReviewOrder({ status, completedAt: completed.completedAt }, { hasReview: false }),
      { canReview: true, reason: "" },
      `${status} + 有完成时间应当可以评价`,
    );
  }

  // 从来没有完成时间 ⇒ 不可以评价。含「完成前就退款」的两种路径（D19）
  for (const status of ["paid", "accepted", "serving", "refunded"]) {
    assert.deepEqual(
      canReviewOrder({ status, completedAt: null }, { hasReview: false }),
      { canReview: false, reason: REVIEW_NOT_COMPLETED_MESSAGE },
      `${status} + 没有完成时间不该可以评价`,
    );
  }

  // 已经评价过是最高优先级：状态与退款都无从改变结论
  assert.deepEqual(canReviewOrder(completed, { hasReview: true }), {
    canReview: false,
    reason: REVIEW_ALREADY_REVIEWED_MESSAGE,
  });
  assert.equal(
    canReviewOrder({ status: "refunded", completedAt: completed.completedAt }, { hasReview: true }).reason,
    REVIEW_ALREADY_REVIEWED_MESSAGE,
  );

  // 待评价的判据与 canReviewOrder **同源**：两处结论必须永远一致
  for (const [status, completedAt] of [
    ["completed", "2026-09-10T12:00:00.000Z"],
    ["refunded", "2026-09-10T12:00:00.000Z"],
    ["paid", null],
    ["refunded", null],
  ]) {
    const order = { status, completedAt, paidAt: "2026-09-01T00:00:00.000Z", id: "ord-x" };
    assert.equal(
      isPendingReview(order, false),
      canReviewOrder(order, { hasReview: false }).canReview,
      `${status} + ${completedAt} 两处判定不一致`,
    );
    assert.equal(isPendingReview(order, true), false, "已经评价过就不再是待评价");
  }
});

test("审核状态机与四个动作：起点与目标一一对应（D7 / D10 / D12 / D22）", () => {
  // 状态机本身
  assert.deepEqual(REVIEW_STATUS_TRANSITIONS.pending, ["approved", "rejected"]);
  assert.deepEqual(REVIEW_STATUS_TRANSITIONS.approved, ["hidden"]);
  assert.deepEqual(REVIEW_STATUS_TRANSITIONS.rejected, ["pending"]);
  assert.deepEqual(REVIEW_STATUS_TRANSITIONS.hidden, ["approved"]);
  // 已公开过的内容不能「驳回」——那等于凭空消失，正确动作是隐藏（R2）
  assert.equal(canTransitionReviewStatus("approved", "rejected"), false);
  assert.equal(canTransitionReviewStatus("hidden", "rejected"), false);

  // 动作 → 起点：approve 与 unhide 的目标相同（都是 approved），但起点必须不同，
  // 否则「把隐藏中的评价恢复公开」会被记成 review.approve（D22：审计要答得出做了什么）
  assert.equal(canApplyReviewModeration("pending", "approve"), true);
  assert.equal(canApplyReviewModeration("hidden", "approve"), false);
  assert.equal(canApplyReviewModeration("approved", "hide"), true);
  assert.equal(canApplyReviewModeration("hidden", "unhide"), true);
  assert.equal(canApplyReviewModeration("rejected", "unhide"), false);
  assert.equal(canApplyReviewModeration("rejected", "approve"), false);
  assert.equal(canApplyReviewModeration("approved", "reject"), false);
  assert.equal(canApplyReviewModeration("pending", "hide"), false);

  // 起点表覆盖四个动作，且每一条都对应状态机里真实存在的一条边
  for (const action of REVIEW_MODERATION_ACTIONS) {
    const from = REVIEW_MODERATION_SOURCE_STATUS[action];
    assert.equal(
      canTransitionReviewStatus(from, REVIEW_MODERATION_TARGET_STATUS[action]),
      true,
      `${action} 的起点与目标不是状态机里的一条边`,
    );
  }

  // 只有驳回与隐藏必须写原因（D10）；四个动作各有独立的审计动作名（D22）
  assert.deepEqual(REVIEW_MODERATION_REQUIRES_REASON, {
    approve: false,
    reject: true,
    hide: true,
    unhide: false,
  });
  assert.deepEqual(REVIEW_MODERATION_AUDIT_ACTIONS, {
    approve: "review.approve",
    reject: "review.reject",
    hide: "review.hide",
    unhide: "review.unhide",
  });

  // 原因规范化：trim 之后非空才算填了（D10）；不需要原因时空串收敛成 null
  assert.deepEqual(normalizeReviewReason("  理由  ", true), { ok: true, reason: "理由" });
  assert.equal(normalizeReviewReason("   ", true).ok, false);
  assert.equal(normalizeReviewReason("\n\t ", true).ok, false);
  assert.deepEqual(normalizeReviewReason("   ", false), { ok: true, reason: null });
  assert.equal(normalizeReviewReason("好".repeat(REVIEW_REASON_MAX_LENGTH + 1), false).ok, false);
});

test("表单校验与查询规则的纯函数", () => {
  // 没点过提交就不报「请选择评分」
  assert.deepEqual(reviewDimensionErrors({ rating: 0, content: "", attempted: false }), {
    rating: null,
    content: null,
  });
  assert.equal(reviewDimensionErrors({ rating: 0, content: "有内容", attempted: true }).rating, "请选择评分");
  // ⚠️ 正文是选填的（D3）：全空格**不报错**，提交时收敛成 null
  assert.equal(reviewDimensionErrors({ rating: 5, content: "   ", attempted: true }).content, null);
  // 超长是实时的：不用点提交就能看到
  assert.equal(
    reviewDimensionErrors({
      rating: 5,
      content: "好".repeat(REVIEW_CONTENT_MAX_LENGTH + 1),
      attempted: false,
    }).content,
    REVIEW_CONTENT_TOO_LONG_MESSAGE,
  );

  assert.deepEqual(normalizeReviewContent("  好评  "), { ok: true, content: "好评" });
  assert.deepEqual(normalizeReviewContent("   "), { ok: true, content: null });

  const fallback = parseReviewListQuery(page());
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.query, { tab: "reviewed", range: "all", page: 1, pageSize: REVIEW_PAGE_SIZE });
  assert.equal(parseReviewListQuery(page({ tab: "pending", range: "year" })).query.tab, "pending");
  assert.equal(parseReviewListQuery(page({ page: "abc" })).query.page, 1);
  assert.equal(parseReviewListQuery(page({ pageSize: 999 })).query.pageSize, 20);
});

test("Tab 与时间筛选取值非法一律 400，不静默回退", async () => {
  assert.equal(parseReviewListQuery(page({ tab: "all" })).ok, false);
  assert.equal(parseReviewListQuery(page({ range: "week" })).ok, false);

  await expectApiError(list(USER_A, { tab: "all" }), "BAD_REQUEST", REVIEW_TAB_INVALID_MESSAGE);
  await expectApiError(list(USER_A, { range: "week" }), "BAD_REQUEST", REVIEW_RANGE_INVALID_MESSAGE);
});

// ——————————————————————————— DTO ———————————————————————————

test("列表 DTO 不泄漏订单私密字段与内部标识", async () => {
  const item = (await reviewed(USER_A)).items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "canResubmit",
    "companion",
    "companionReview",
    "completedAt",
    "createdAt",
    "evidence",
    "hideReason",
    "id",
    "orderId",
    "orderNo",
    "productCoverUrl",
    "productReview",
    "productTitle",
    "quantity",
    "rejectReason",
    "specName",
    "status",
    "statusLabel",
    "updatedAt",
  ]);
  // 游戏 ID 与备注属于订单信息，不属于评价 DTO；审核人与聚合身份也不外泄
  for (const key of [
    "userId",
    "gameAccountId",
    "remark",
    "totalAmount",
    "gameName",
    "reviewedBy",
    "reviewedByName",
    "reviewedAt",
  ]) {
    assert.equal(key in item, false, `评价 DTO 不该出现 ${key}`);
  }

  const pendingItem = (await pending(USER_A)).items[0];
  assert.deepEqual(Object.keys(pendingItem).sort(), [
    "allowedActions",
    "companion",
    "completedAt",
    "orderId",
    "orderNo",
    "productCoverUrl",
    "productTitle",
    "quantity",
    "specName",
  ]);
  for (const key of [
    "userId",
    "gameAccountId",
    "remark",
    "totalAmount",
    "productReview",
    "companionReview",
    "rating",
    "content",
  ]) {
    assert.equal(key in pendingItem, false, `待评价 DTO 不该出现 ${key}`);
  }

  // 分页结果的形状固定：两个角标始终随每一页一起返回
  assert.deepEqual(Object.keys(await reviewed(USER_A)).sort(), [
    "counts",
    "hasMore",
    "items",
    "page",
    "pageSize",
    "tab",
    "total",
  ]);
});

test("分页稳定不重复，加载更多是合并不是替换", async () => {
  // B 的两单都评上：一页一条，正好翻得动页
  for (const orderId of B_ORDERS) await submit(orderId, USER_B);
  assert.equal((await reviewed(USER_B)).total, 2);

  const first = await reviewed(USER_B, { page: 1, pageSize: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true, "还有第二页");

  const second = await reviewed(USER_B, { page: 2, pageSize: 1 });
  assert.equal(second.items.length, 1);
  assert.equal(second.hasMore, false, "第二页取完必须停下，否则最后一页会被重复取一次");
  assert.notEqual(first.items[0].id, second.items[0].id, "两页不能是同一条");

  // 翻页取回的条数拼起来正好是全部：不重不漏
  assert.equal(new Set([first.items[0].id, second.items[0].id]).size, 2);

  // 同一页重复合并：去重后条数不变，多出来的字段也还在（「加载更多」连点两次的兜底）
  const merged = mergeReviewPage(first, first);
  assert.equal(merged.items.length, first.items.length);
  assert.equal(merged.tab, "reviewed");
  assert.deepEqual(merged.counts, first.counts);

  // 两页合并：追加而不是替换，且不重复
  const both = mergeReviewPage(first, second);
  assert.equal(both.items.length, 2);
  assert.equal(both.hasMore, false, "hasMore 采用最新一页的");
  assert.equal(both.tab, "reviewed");

  // 待评价列表按 `orderId` 去重，因此用另一份合并函数
  const pendingPage = await pending(USER_B, { pageSize: 1 });
  const mergedPending = mergePendingReviewPage(pendingPage, pendingPage);
  assert.equal(mergedPending.items.length, pendingPage.items.length);
  assert.equal(mergedPending.tab, "pending");
});

// ——————————————————————————— Mock 数据契约 ———————————————————————————

test("评价数据是明确标注的 Mock，且不参与任何金额或等级计算", async () => {
  for (const review of reviewSeed) {
    // 每个非空维度的正文都必须标明 Mock。两个维度各自独立（D2），
    // 因此这里逐维度检查而不是只看某一条
    let marked = 0;
    for (const dimension of [review.productReview, review.companionReview]) {
      if (!dimension || dimension.content === null) continue;
      marked += 1;
      assert.ok(dimension.content.includes("（Mock 文案）"), `${review.id} 的正文必须标明 Mock`);
    }
    assert.ok(marked >= 1, `${review.id} 至少要有一个带正文的维度`);
    for (const item of review.evidence) assert.equal(item.url, EVIDENCE_PLACEHOLDER_URL);
  }

  // 评价实体里没有任何金额字段：评价不改订单金额，也不参与消费等级
  const entity = await getReviewRepository().findReviewByOrderId(USER_A, REVIEWED_ORDER);
  for (const key of ["amount", "totalAmount", "price", "level", "tier"]) {
    assert.equal(key in entity, false, `评价实体不该出现 ${key}`);
  }

  // 提交评价不改动订单：状态、金额、完成时间都原样保留
  const before = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  await submit(PENDING_ORDER, USER_A);
  const after = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.equal(after.totalAmount, before.totalAmount);
  assert.equal(after.completedAt, before.completedAt);
  assert.equal(after.timeline.length, before.timeline.length);
});

test("页面上的取值与文案与原型一致，且说明里写明是 Mock", () => {
  // 时间筛选 chips 的取值与文案（原型：全部 / 近一月 / 近三月 / 近半年 / 今年）
  assert.deepEqual(
    REVIEW_RANGES.map((item) => item.label),
    ["全部", "近一月", "近三月", "近半年", "今年"],
  );
  // 两个 Tab：已评价在前，标题分别对应「我的评价」与「待评价订单」
  assert.deepEqual(
    REVIEW_TABS.map((item) => [item.key, item.label, item.heading]),
    [
      ["reviewed", "已评价", "我的评价"],
      ["pending", "待评价", "待评价订单"],
    ],
  );
  assert.deepEqual(REVIEW_RATINGS, [1, 2, 3, 4, 5]);

  // 状态文案（D8）：`hidden` 的说法必须让作者知道这不是自己操作的结果
  assert.deepEqual(REVIEW_STATUS_LABELS, {
    pending: "审核中",
    approved: "已通过",
    rejected: "已驳回",
    hidden: "已被管理员隐藏",
  });

  // 说明里明确写着数据和凭证都是 Mock：不会被当成真实用户评价或平台素材
  assert.ok(REVIEW_MOCK_NOTICE.includes("Mock"));
  assert.ok(REVIEW_MOCK_NOTICE.includes("凭证"));
});
