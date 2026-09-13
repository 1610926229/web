import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { EVIDENCE_PLACEHOLDER_URL } from "../lib/constants/evidence.ts";
import {
  REVIEW_ALREADY_REVIEWED_MESSAGE,
  REVIEW_CONTENT_MAX_LENGTH,
  REVIEW_CONTENT_TOO_LONG_MESSAGE,
  REVIEW_EVIDENCE_MAX_COUNT,
  REVIEW_MOCK_NOTICE,
  REVIEW_NOT_COMPLETED_MESSAGE,
  REVIEW_ORDER_NOT_FOUND_MESSAGE,
  REVIEW_ORDER_REFUNDED_MESSAGE,
  REVIEW_PAGE_SIZE,
  REVIEW_RANGES,
  REVIEW_RANGE_INVALID_MESSAGE,
  REVIEW_RATINGS,
  REVIEW_REFUND_ACTIVE_MESSAGE,
  REVIEW_TABS,
  REVIEW_TAB_INVALID_MESSAGE,
  canReviewOrder,
  isWithinReviewRange,
  mergePendingReviewPage,
  mergeReviewPage,
  normalizeReviewContent,
  parseReviewListQuery,
  reviewFieldErrors,
  reviewRangeStart,
} from "../lib/constants/reviews.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE } from "../lib/constants/writes.ts";
import { BEIJING_OFFSET_MINUTES } from "../lib/utils/format.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getReviewRepository } from "../lib/data/reviewRepository.ts";
import { reviewSeed } from "../lib/mocks/fixtures/reviewSeed.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import {
  createReviewForOrder,
  getReviewTargetForUser,
  queryReviewsForUser,
} from "../lib/services/reviews.ts";

/**
 * 评价的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/reviews.ts`，因此
 * 「只能评价自己的已完成订单」「退款中 / 已退款不能评价」「一单一评」「幂等重试与并发提交
 * 只产生一条」「伪造身份与状态无效」「时间筛选边界正确」「DTO 不泄漏订单私密字段」
 * 这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * 时间一律显式钉死在 `NOW`（时间筛选依赖当前时间，传真实时间的话用例会在某一天突然变红）。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 北京时间 2026-09-13 20:00。 */
const NOW = new Date("2026-09-13T12:00:00.000Z");

/** 已完成、且种子里**没有**评价的订单（A 的）。 */
const PENDING_ORDER = "ord-seed-1001-08";
/** 已完成、且种子里已经评价过的订单（A 的）。 */
const REVIEWED_ORDER = "ord-seed-1001-05";
/** 已退款订单（A 的）。 */
const REFUNDED_ORDER = "ord-seed-1001-06";
/** B 的已完成订单：A 拿它当入参必须得到 404。 */
const OTHER_USER_ORDER = "ord-seed-1002-02";

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

function submit(orderId, userId, body = {}, now = NOW) {
  return createReviewForOrder(
    orderId,
    userId,
    {
      // 默认给一个幂等键：每次调用都是一次新的「提交意图」。
      // 需要验证「缺少幂等键」的用例显式传空串覆盖掉它。
      idempotencyKey: uniqueKey(),
      rating: 5,
      content: "打得很稳，沟通顺畅。（Mock 文案）",
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

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 直接往退款仓储里塞一条退款申请：用来构造「已完成但有退款」的订单。 */
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
    description: "测试用退款申请：用来验证退款期间的订单不能评价。",
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
  const target = result.items.find((item) => item.orderId === PENDING_ORDER);
  assert.deepEqual(target.allowedActions, { canReview: true, reason: "" });

  assert.equal((await pending(USER_B)).items[0].orderId, "ord-seed-1002-02");
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
  assert.equal(submitted.rating, 5);
  // 同一条订单不会留在「待评价」里
  assert.equal(
    (await pending(USER_A)).items.some((item) => item.orderId === PENDING_ORDER),
    false,
  );
});

test("提交后能从评价列表与订单详情两个入口读到同一条评价", async () => {
  const created = await submit(PENDING_ORDER, USER_A, {
    rating: 4,
    content: "配合得不错，中间换了一次英雄也处理得挺利落。（Mock 文案）",
    evidence: [{ kind: "image", name: "结算截图.png" }],
  });

  const found = (await reviewed(USER_A)).items.find((item) => item.id === created.reviewId);
  assert.ok(found);
  assert.equal(found.rating, 4);
  assert.equal(found.evidence.length, 1);
  // 凭证地址由服务端写成占位图，客户端提交的文件名只用于展示
  assert.equal(found.evidence[0].url, EVIDENCE_PLACEHOLDER_URL);

  // 订单详情：评价过之后不再有评价入口，摘要里有星级
  const detail = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  assert.equal(detail.allowedActions.canReview, false);
  assert.equal(detail.reviewSummary.rating, 4);
  assert.equal(detail.reviewSummary.id, created.reviewId);

  // 还没评价的订单则相反：有入口、没有摘要
  const before = await getOrderDetailForUser("ord-seed-1002-02", USER_B, undefined, "server");
  assert.equal(before.allowedActions.canReview, true);
  assert.equal(before.reviewSummary, null);
});

test("只有「已完成」的订单可以评价：已付款 / 已接单 / 护航中 / 已退款都不行", async () => {
  for (const orderId of NOT_COMPLETED_ORDERS) {
    await expectApiError(
      submit(orderId, USER_A),
      "BAD_REQUEST",
      REVIEW_NOT_COMPLETED_MESSAGE,
    );
    // 列表里的入口也照样不存在——判定只有一处实现
    const blocked = await target(orderId, USER_A);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, REVIEW_NOT_COMPLETED_MESSAGE);
  }

  // 已退款的订单：订单状态本身就不是「已完成」，因此给的是同一句原因
  await expectApiError(
    submit(REFUNDED_ORDER, USER_A),
    "BAD_REQUEST",
    REVIEW_NOT_COMPLETED_MESSAGE,
  );

  // 一条都没写进去
  assert.equal((await reviewed(USER_A)).total, 3);
});

test("退款中与已退款的已完成订单不能评价，原因与退款状态有关", async () => {
  await attachRefund(PENDING_ORDER, "reviewing");

  // 审核中：暂时不能评价
  await expectApiError(submit(PENDING_ORDER, USER_A), "BAD_REQUEST", REVIEW_REFUND_ACTIVE_MESSAGE);
  assert.equal((await target(PENDING_ORDER, USER_A)).reason, REVIEW_REFUND_ACTIVE_MESSAGE);
  // 待评价列表里也带着同一句原因，前端照原样显示
  const blockedItem = (await pending(USER_A)).items.find((item) => item.orderId === PENDING_ORDER);
  assert.equal(blockedItem.allowedActions.canReview, false);
  assert.equal(blockedItem.allowedActions.reason, REVIEW_REFUND_ACTIVE_MESSAGE);
  // 订单详情里的入口同样关掉
  const detail = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");
  assert.equal(detail.allowedActions.canReview, false);

  // 换成「已通过」：这一单的钱已经退回，同样不能评价，但原因不同
  resetMockStore("refund");
  await attachRefund(PENDING_ORDER, "approved");
  await expectApiError(submit(PENDING_ORDER, USER_A), "BAD_REQUEST", REVIEW_ORDER_REFUNDED_MESSAGE);

  // 被拒绝 / 已撤销的退款不影响评价：服务是正常完成的
  for (const status of ["rejected", "cancelled"]) {
    resetMockStore("refund");
    await attachRefund(PENDING_ORDER, status);
    const created = await submit(PENDING_ORDER, USER_A);
    assert.equal(created.created, true);
    resetMockStore("review");
  }
});

test("一单一评：重复提交返回第一次的结果，且不修改已有评价", async () => {
  const first = await submit(REVIEWED_ORDER, USER_A, { rating: 1, content: "想改成差评。（Mock 文案）" });

  assert.equal(first.created, false);
  assert.equal(first.reviewId, "rev-seed-1001-01");
  // 原来那条评价的内容没有被覆盖
  const original = (await reviewed(USER_A)).items.find((item) => item.id === "rev-seed-1001-01");
  assert.equal(original.rating, 5);
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
    Array.from({ length: 8 }, () => submit("ord-seed-1002-02", USER_B)),
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
  // 别人的评价也不会出现在自己的列表里
  await submit(OTHER_USER_ORDER, USER_B);
  assert.equal((await reviewed(USER_A)).total, 3);
});

test("客户端伪造的 userId / orderStatus / companionId / createdAt 一概无效", async () => {
  const created = await submit(PENDING_ORDER, USER_A, {
    idempotencyKey: uniqueKey(),
    content: "正常评价内容。（Mock 文案）",
    // 全是客户端不该能决定的东西
    userId: USER_B,
    orderId: OTHER_USER_ORDER,
    orderStatus: "paid",
    companionId: "cp-forged",
    companion: { id: "cp-forged", name: "伪造打手", avatarUrl: "/mock/x.svg" },
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  const item = (await reviewed(USER_A)).items.find((entry) => entry.id === created.reviewId);
  const order = await getOrderDetailForUser(PENDING_ORDER, USER_A, undefined, "server");

  // 归属、订单号、打手快照、评价时间全部来自订单与服务端，伪造值一个都没生效
  assert.equal(order.reviewSummary.id, created.reviewId);
  assert.equal(item.orderId, PENDING_ORDER);
  assert.equal(item.orderNo, order.orderNo);
  assert.deepEqual(item.companion, order.companion);
  assert.equal(item.createdAt, NOW.toISOString());
  assert.notEqual(item.companion?.name, "伪造打手");

  // 伪造的订单 id 没有让评价落到别人的单子上
  assert.equal((await reviewed(USER_B)).total, 0);
});

test("评分与正文的服务端校验：非法评分、空正文、超长正文都拒绝", async () => {
  await expectApiError(submit(PENDING_ORDER, USER_A, { rating: 0 }), "BAD_REQUEST");
  await expectApiError(submit(PENDING_ORDER, USER_A, { rating: 6 }), "BAD_REQUEST");
  await expectApiError(submit(PENDING_ORDER, USER_A, { rating: "5.5" }), "BAD_REQUEST");
  await expectApiError(submit(PENDING_ORDER, USER_A, { content: "   " }), "BAD_REQUEST");
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { content: "好".repeat(REVIEW_CONTENT_MAX_LENGTH + 1) }),
    "BAD_REQUEST",
    REVIEW_CONTENT_TOO_LONG_MESSAGE,
  );

  // 恰好到上限可以提交，且首尾空格不会把计数顶上去
  const boundary = await submit(PENDING_ORDER, USER_A, {
    content: `  ${"好".repeat(REVIEW_CONTENT_MAX_LENGTH)}  `,
  });
  assert.equal(boundary.created, true);
  const stored = (await reviewed(USER_A)).items.find((item) => item.id === boundary.reviewId);
  assert.equal(stored.content.length, REVIEW_CONTENT_MAX_LENGTH);

  resetMockStore("review");
  // 字数按**字符**算：一个汉字、一个字母、一个普通 Emoji 都算 1 个
  const emoji = "🎮".repeat(REVIEW_CONTENT_MAX_LENGTH);
  const ok = await submit(PENDING_ORDER, USER_A, { content: emoji });
  assert.equal(ok.created, true);
  resetMockStore("review");
  await expectApiError(
    submit(PENDING_ORDER, USER_A, { content: "🎮".repeat(REVIEW_CONTENT_MAX_LENGTH + 1) }),
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
  const stored = (await reviewed(USER_A)).items.find((item) => item.id === created.reviewId);
  assert.equal(stored.evidence.length, REVIEW_EVIDENCE_MAX_COUNT);
  // 客户端提交的 id 与 url 不被采用：id 由服务端生成，地址一律写成占位图
  assert.equal(stored.evidence[0].url, EVIDENCE_PLACEHOLDER_URL);
  assert.ok(stored.evidence[0].id.startsWith("ev_"));
  assert.equal(stored.evidence[0].name, "截图-0.png");
});

test("时间筛选：五个取值各自筛出正确的记录数", async () => {
  const counts = {};
  for (const range of ["all", "month", "threeMonths", "halfYear", "year"]) {
    counts[range] = (await reviewed(USER_A, { range })).total;
  }

  // 种子里三条评价分别落在 2026-09-10 / 2026-08-31 / 2026-03-21
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

test("评价资格判定的纯函数：状态 × 退款状态的完整组合", () => {
  const cases = [
    ["completed", null, true],
    ["completed", "rejected", true],
    ["completed", "cancelled", true],
    ["completed", "pending", false],
    ["completed", "reviewing", false],
    ["completed", "approved", false],
    ["paid", null, false],
    ["accepted", null, false],
    ["serving", null, false],
    ["refunded", null, false],
  ];

  for (const [status, refundStatus, expected] of cases) {
    assert.equal(
      canReviewOrder(status, { hasReview: false, refundStatus }).canReview,
      expected,
      `${status} + ${refundStatus}`,
    );
  }

  // 已经评价过是最高优先级：状态与退款都无从改变结论
  const reviewed = canReviewOrder("completed", { hasReview: true, refundStatus: null });
  assert.deepEqual(reviewed, { canReview: false, reason: REVIEW_ALREADY_REVIEWED_MESSAGE });
  assert.equal(
    canReviewOrder("completed", { hasReview: true, refundStatus: "reviewing" }).reason,
    REVIEW_ALREADY_REVIEWED_MESSAGE,
  );
});

test("表单校验与查询规则的纯函数", () => {
  // 没点过提交就不报「请选择 / 请填写」
  assert.deepEqual(reviewFieldErrors({ rating: 0, content: "", attempted: false }), {
    rating: null,
    content: null,
  });
  assert.equal(reviewFieldErrors({ rating: 0, content: "有内容", attempted: true }).rating, "请选择评分");
  assert.equal(reviewFieldErrors({ rating: 5, content: "   ", attempted: true }).content, "请填写评价内容");
  // 超长是实时的：不用点提交就能看到
  assert.equal(
    reviewFieldErrors({
      rating: 5,
      content: "好".repeat(REVIEW_CONTENT_MAX_LENGTH + 1),
      attempted: false,
    }).content,
    REVIEW_CONTENT_TOO_LONG_MESSAGE,
  );

  assert.deepEqual(normalizeReviewContent("  好评  "), { ok: true, content: "好评" });
  assert.equal(normalizeReviewContent("   ").ok, false);

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

test("列表 DTO 不泄漏订单私密字段与内部标识", async () => {
  const item = (await reviewed(USER_A)).items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "companion",
    "completedAt",
    "content",
    "createdAt",
    "evidence",
    "id",
    "orderId",
    "orderNo",
    "productCoverUrl",
    "productTitle",
    "quantity",
    "rating",
    "specName",
  ]);
  // 游戏 ID 与备注属于订单信息，不属于评价 DTO
  for (const key of ["userId", "gameAccountId", "remark", "totalAmount", "gameName"]) {
    assert.equal(key in item, false, `评价 DTO 不该出现 ${key}`);
  }

  const order = (await pending(USER_A)).items[0];
  assert.deepEqual(Object.keys(order).sort(), [
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
  for (const key of ["userId", "gameAccountId", "remark", "totalAmount", "rating", "content"]) {
    assert.equal(key in order, false, `待评价 DTO 不该出现 ${key}`);
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
  // 先给 B 造出多条评价：把 B 的订单逐条评价掉
  const bOrders = [
    "ord-seed-1002-01",
    "ord-seed-1002-02",
    "ord-seed-1002-03",
  ];
  // 只有「已完成」的能评价，其余会失败——这里只关心记录条数
  for (const orderId of bOrders) {
    try {
      await submit(orderId, USER_B);
    } catch {
      // 未完成的订单评不了，跳过
    }
  }
  assert.equal((await reviewed(USER_B)).total, 1);

  const seen = new Set();
  const first = await reviewed(USER_B, { page: 1, pageSize: 1 });
  for (const item of first.items) seen.add(item.id);
  assert.equal(seen.size, 1);
  assert.equal(first.hasMore, false);

  // 同一页重复合并：去重后条数不变，多出来的字段也还在（「加载更多」连点两次的兜底）
  const merged = mergeReviewPage(first, first);
  assert.equal(merged.items.length, first.items.length);
  assert.equal(merged.tab, "reviewed");
  assert.deepEqual(merged.counts, first.counts);

  // 待评价列表按 `orderId` 去重，因此用另一份合并函数
  const pendingPage = await pending(USER_A, { pageSize: 1 });
  const mergedPending = mergePendingReviewPage(pendingPage, pendingPage);
  assert.equal(mergedPending.items.length, pendingPage.items.length);
  assert.equal(mergedPending.tab, "pending");
});

test("评价数据是明确标注的 Mock，且不参与任何金额或等级计算", async () => {
  for (const review of reviewSeed) {
    assert.ok(review.content.includes("（Mock 文案）"), `${review.id} 的正文必须标明 Mock`);
    for (const item of review.evidence) assert.equal(item.url, EVIDENCE_PLACEHOLDER_URL);
  }

  // 评价实体里没有任何金额字段：评价不改订单金额，也不参与消费等级
  const stored = await getReviewRepository().findReviewByOrderId(USER_A, REVIEWED_ORDER);
  for (const key of ["amount", "totalAmount", "price", "level", "tier"]) {
    assert.equal(key in stored, false, `评价实体不该出现 ${key}`);
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

  // 说明里明确写着数据和凭证都是 Mock：不会被当成真实用户评价或平台素材
  assert.ok(REVIEW_MOCK_NOTICE.includes("Mock"));
  assert.ok(REVIEW_MOCK_NOTICE.includes("凭证"));
});
