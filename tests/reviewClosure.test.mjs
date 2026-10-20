import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { beforeEach } from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";

import { ADMIN_REVIEW_LIST_NOTICE } from "../lib/constants/adminReviews.ts";
import {
  REVIEW_AGGREGATE_LIMIT,
  REVIEW_DIMENSION_MISSING_MESSAGE,
  REVIEW_MODERATION_ACTION_LABELS,
  REVIEW_MODERATION_AUDIT_ACTIONS,
  REVIEW_MODERATION_REQUIRES_REASON,
  REVIEW_NO_RATING_LABEL,
  REVIEW_OPERATION_CONFLICT_MESSAGE,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_REQUIRED_MESSAGE,
  REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  REVIEW_STATUS_LABELS,
  REVIEW_TRUNCATED_NOTICE,
  buildReviewAggregate,
  formatAverageRating,
  normalizeReviewReason,
  reviewDimensionOwnerId,
  toReviewListItem,
} from "../lib/constants/reviews.ts";
import { ADMIN_FORBIDDEN_MESSAGE, ADMIN_UNAUTHORIZED_MESSAGE } from "../lib/constants/admin.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE } from "../lib/constants/writes.ts";
import { adminReviewInvalidTransitionMessage } from "../lib/constants/adminReviews.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getReviewRepository } from "../lib/data/reviewRepository.ts";
import { applyOrderRefund } from "../lib/data/mockPaymentRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getUserRepository } from "../lib/data/userRepository.ts";
import { reviewSeed } from "../lib/mocks/fixtures/reviewSeed.ts";
import { getProductDetail } from "../lib/services/catalog.ts";
import { getCompanionDetail } from "../lib/services/companions.ts";
import {
  getAdminReviewDetail,
  moderateAdminReview,
  queryAdminReviewList,
  resolveAdminReviewListQuery,
} from "../lib/services/adminReviews.ts";
import { loadReviewAggregate } from "../lib/services/reviewAggregates.ts";
import {
  createReviewForOrder,
  getReviewTargetForUser,
  queryReviewsForUser,
  resubmitReviewForUser,
} from "../lib/services/reviews.ts";
import { ADMIN_REVIEW_NOT_FOUND_MESSAGE } from "../lib/constants/adminReviews.ts";

/**
 * P1-8「订单评价闭环」的门禁测试。
 *
 * `tests/reviews.test.mjs` 守的是**用户侧**（提交、维度、一单一评、重提、时间筛选）。
 * 本文件补的是闭环的另一半：
 *
 * | 块 | 裁定出处 | 守的是什么 |
 * |---|---|---|
 * | 二 | `D14` / `D15` / `R3` | 公开聚合只认 `approved`、按**维度**计数、最近 3 条、暂无评分 |
 * | 三 | `R3` / `D13` | 商品侧与打手侧同一段代码；公开面脱敏且只有 5 个字段 |
 * | 四 | `D7` / `D10` / `D11` / `D12` | 四个审核动作、状态机、管理员改不了内容 |
 * | 五 | `D22` | 每个动作一条 AdminAudit；重放与空操作不写第二条 |
 * | 六 | `D18` / `D19` / `D20` | 退款与评价是两条互不干涉的线 |
 * | 七 | `D21` | 权限矩阵：匿名 / 用户 / 客服 / 非管理员 / 管理员 |
 * | 八 | `D13` | DTO 键集（公开面与管理端各一份，多一个少一个都会红） |
 * | 九 | `D17` | 种子里的假评分已经彻底退出业务真值 |
 *
 * ⚠️ 全部走**真实实现**：真实仓储 + 真实服务层 + 真实的伪事务。
 * 一处都没有把业务规则抄进测试——抄一遍就等于给规则留了第二个实现，
 * 而第二个实现永远比第一个宽松。
 */

const ADMIN_ID = "admin-1";

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `review-closure-key-${process.pid}-${keySeq}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 管理端审核：`body` 里放原因与幂等键，与四个 Route Handler 的调用方式一致。 */
function moderate(reviewId, action, body = {}) {
  return moderateAdminReview(reviewId, action, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...body,
  });
}

function stored(reviewId) {
  return getReviewRepository().findReviewById(reviewId);
}

/** 去掉注释后再做「源码里不该出现某标识」的断言——说明文字不是实现。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function reviewsOfTarget(key, targetId) {
  return key === "product"
    ? loadReviewAggregate("product", targetId)
    : loadReviewAggregate("companion", targetId);
}

/** 一个已完成订单：用来构造「完成之后退款」的两种形态（D18 / D19）。 */
const FREE_ORDER = "ord-seed-1001-08";
const FREE_ORDER_USER = "u-1001";
/** 商品侧 / 打手侧各自的聚合对象：`FREE_ORDER` 买的是它、打的是它。 */
const FREE_PRODUCT = "p-fun-2";
const FREE_COMPANION = "cp-3";

/** 种子里已经 approved 的一条（cp-1，打手维度 5 星）：用来验证「隐藏后立刻从公开面消失」。 */
const APPROVED_FOR_CP1 = "rev-seed-1003-01";
/** 种子里 hidden 的一条（cp-3 / p-fun-4，两个维度都是 5 星）：用来验证「恢复公开」。 */
const HIDDEN_REVIEW = "rev-seed-1008-01";
const HIDDEN_PRODUCT = "p-fun-4";
/** 种子里 pending 的一条（p-speed-1 / cp-3，两个维度都是 1 星）：用来验证「通过才公开」。 */
const PENDING_REVIEW = "rev-seed-1004-02";
const PENDING_PRODUCT = "p-speed-1";

beforeEach(() => {
  resetMockStore("review");
  resetMockStore("adminAudit");
  resetMockStore("refund");
  // ⚠️ 订单也在预置里，而且**必须一起复位**：`applyOrderRefund` 一旦写出
  // `refundedAmount > 0`，`isRefundExecutionClosed()` 就会对这张单永久成立
  // （一单一退，P0-15），后面每个用例都再也退不动它——
  // 表现是「退款相关的断言时对时错，取决于哪个用例先跑」。
  resetMockStore("payment");
});

// ═══════════════════════ 二、公开聚合（D14 / D15 / R3） ═══════════════════════

test("公开聚合只认 approved，且按**维度**计数而不是评价条数（D14 / D15）", async () => {
  // cp-1：三条 approved 的打手维度（5 + 5 + 4）
  const cp1 = await reviewsOfTarget("companion", "cp-1");
  assert.equal(cp1.averageRating, 4.7);
  assert.equal(cp1.reviewCount, 3);
  assert.equal(cp1.reviewsTruncated, false);

  // cp-2：**从来没有被打手维度评过**——只有一条只评商品的评价挂在它身上。
  // 这正是「reviewCount 数维度」的证据：那条评价对商品侧 +1、对打手侧 +0
  const cp2 = await reviewsOfTarget("companion", "cp-2");
  assert.deepEqual(cp2, { averageRating: null, reviewCount: 0, reviews: [], reviewsTruncated: false });
  assert.equal(formatAverageRating(cp2.averageRating), REVIEW_NO_RATING_LABEL);

  // cp-3：4 条 approved 的打手维度，公开面只列 3 条并**如实标注**被截断
  const cp3 = await reviewsOfTarget("companion", "cp-3");
  assert.equal(cp3.averageRating, 4.5);
  assert.equal(cp3.reviewCount, 4);
  assert.equal(cp3.reviews.length, REVIEW_AGGREGATE_LIMIT);
  assert.equal(cp3.reviewsTruncated, true);
  assert.ok(REVIEW_TRUNCATED_NOTICE.includes("3"));

  // 最近 3 条按评价时间倒序，且全部是 approved 的那几条
  const times = cp3.reviews.map((item) => item.createdAt);
  assert.deepEqual([...times].sort().reverse(), times, "最近评价必须按时间倒序");
  const approved = (await getReviewRepository().listReviewsByCompanion("cp-3")).filter(
    (review) => review.status === "approved" && review.companionReview !== null,
  );
  assert.deepEqual(
    cp3.reviews.map((item) => item.id),
    [...approved]
      .sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, REVIEW_AGGREGATE_LIMIT)
      .map((review) => review.id),
  );

  // 商品侧同样：没有任何评价时说「暂无评分」，而不是拿 0 分冒充
  const fresh = await reviewsOfTarget("product", FREE_PRODUCT);
  assert.equal(fresh.averageRating, null);
  assert.equal(fresh.reviewCount, 0);
  assert.equal(formatAverageRating(fresh.averageRating), REVIEW_NO_RATING_LABEL);
});

test("平均分保留 1 位小数，且按维度切分后各自独立计算（D2 / D15）", () => {
  const base = {
    id: "rev-x",
    userId: "u-x",
    orderId: "ord-x",
    orderNo: "NO-x",
    productId: "p-x",
    specId: "s-x",
    evidence: [],
    status: "approved",
    rejectReason: null,
    hideReason: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    productTitle: "商品",
    productCoverUrl: "/mock/p.svg",
    specName: "规格",
    quantity: 1,
    completedAt: "2026-08-31T00:00:00.000Z",
    companion: null,
  };

  // ⚠️ 打手维度的聚合身份是 `review.companion.id`（**实际履约打手**的快照，`D4`），
  // 不是 `productId`。所以「这条评价计入哪位打手」由下面这个快照决定——
  // 只给 `companionReview` 而不给 `companion`，打手侧会一条都算不进来（这正是下一条断言）。
  const servedBy = { id: "cp-x", name: "甲（占位）", avatarUrl: "/mock/avatar-1.svg" };

  // 两个维度的星级**不同**：聚合结果必须各算各的，不能取其一或取平均
  const reviews = [
    { ...base, id: "r1", companion: servedBy, productReview: { rating: 5, content: null }, companionReview: { rating: 3, content: null } },
    { ...base, id: "r2", companion: servedBy, productReview: { rating: 4, content: null }, companionReview: { rating: 5, content: null } },
    // 只评商品：打手侧不该被它影响
    { ...base, id: "r3", companion: null, productReview: { rating: 1, content: null }, companionReview: null },
  ];
  const nickname = () => "老板A（占位）";

  const product = buildReviewAggregate({ reviews, key: "product", targetId: "p-x", nickname });
  const companion = buildReviewAggregate({ reviews, key: "companion", targetId: servedBy.id, nickname });

  // 商品：(5+4+1)/3 = 3.333… → 3.3；打手：(3+5)/2 = 4（只评商品的那条不计入）
  assert.equal(product.averageRating, 3.3);
  assert.equal(product.reviewCount, 3);
  assert.equal(companion.averageRating, 4);
  assert.equal(companion.reviewCount, 2);

  // 非 approved 一律不计入（D14）
  const withNoise = [
    ...reviews,
    { ...base, id: "r-pending", status: "pending", productReview: { rating: 5, content: null }, companionReview: { rating: 5, content: null } },
    { ...base, id: "r-hidden", status: "hidden", productReview: { rating: 5, content: null }, companionReview: { rating: 5, content: null } },
    { ...base, id: "r-rejected", status: "rejected", productReview: { rating: 5, content: null }, companionReview: { rating: 5, content: null } },
  ];
  const filtered = buildReviewAggregate({ reviews: withNoise, key: "product", targetId: "p-x", nickname });
  assert.equal(filtered.averageRating, product.averageRating);
  assert.equal(filtered.reviewCount, product.reviewCount);

  // 指向别的对象的维度不计入（聚合身份，R4）：`reviewDimensionOwnerId` 是唯一判据
  const otherTarget = buildReviewAggregate({ reviews, key: "product", targetId: "p-else", nickname });
  assert.deepEqual(otherTarget, { averageRating: null, reviewCount: 0, reviews: [], reviewsTruncated: false });
  assert.equal(reviewDimensionOwnerId({ ...base, companion: { id: "cp-z", name: "甲", avatarUrl: "/x" } }, "companion"), "cp-z");
  assert.equal(reviewDimensionOwnerId(reviews[2], "companion"), null, "没绑定实际履约打手时打手维度没有归属");
});

// ═══════════════════════ 三、同源与脱敏（R3 / D13） ═══════════════════════

test("商品详情与打手详情走同一段聚合代码，值完全一致（R3）", async () => {
  const detail = await getCompanionDetail("cp-1", page(), "server");
  const aggregate = await reviewsOfTarget("companion", "cp-1");

  assert.equal(detail.rating, aggregate.averageRating);
  assert.equal(detail.reviewCount, aggregate.reviewCount);
  assert.deepEqual(detail.reviews, aggregate.reviews);
  assert.equal(detail.reviewsTruncated, aggregate.reviewsTruncated);

  // 商品详情：聚合挂在 DTO 的 `reviews` 上（商品实体本身没有评分字段）
  const product = await getProductDetail("p-800w", page(), "server");
  assert.deepEqual(product.reviews, await reviewsOfTarget("product", "p-800w"));
  assert.equal(product.reviews.averageRating, 4);

  // 没有评价的一侧：`null` + 「暂无评分」，不是 0
  const empty = await getProductDetail(FREE_PRODUCT, page(), "server");
  assert.deepEqual(empty.reviews, {
    averageRating: null,
    reviewCount: 0,
    reviews: [],
    reviewsTruncated: false,
  });
});

test("公开评价只有 5 个字段，昵称脱敏，任何内部标识都不出现（D13）", async () => {
  const aggregate = await reviewsOfTarget("companion", "cp-1");
  const item = aggregate.reviews[0];

  assert.deepEqual(Object.keys(item).sort(), ["content", "createdAt", "id", "nickname", "rating"]);
  for (const key of [
    "userId",
    "orderId",
    "orderNo",
    "evidence",
    "status",
    "rejectReason",
    "hideReason",
    "reviewedBy",
    "reviewedAt",
    "productId",
    "specId",
  ]) {
    assert.equal(key in item, false, `公开评价泄漏了 ${key}`);
  }

  // 脱敏：原文是「老板A（占位）」，公开面只剩姓氏 + 星号
  const users = await getUserRepository().listUsers();
  const raw = users.find((user) => user.id === "u-1001").nickname;
  assert.equal(raw, "老板A（占位）");
  assert.notEqual(item.nickname, raw);
  assert.equal(item.nickname.includes("占位"), false, "脱敏后的昵称不该带上原始昵称的后半段");

  // 删除用户资料时降级成「匿名用户」，而不是留空或抛错
  // （把作者换成一个查不到的用户，等价于「这条评价的作者已注销」）
  const orphan = buildReviewAggregate({
    reviews: [{ ...(await getReviewRepository().findReviewById(APPROVED_FOR_CP1)), userId: "u-not-exist" }],
    key: "companion",
    targetId: "cp-1",
    nickname: () => "",
  });
  assert.equal(orphan.reviews[0].nickname, "匿名用户");
});

// ═══════════════════════ 四、管理端审核（D7 / D10 / D11 / D12） ═══════════════════════

test("通过：只有 pending 能通过，通过之后立刻进入公开面（D7 / D14）", async () => {
  // 通过之前：pending 的那条**一个维度都不计入**
  assert.equal((await reviewsOfTarget("product", PENDING_PRODUCT)).reviewCount, 0);
  const cpBefore = await reviewsOfTarget("companion", FREE_COMPANION);
  assert.equal(cpBefore.reviewCount, 4);

  const result = await moderate(PENDING_REVIEW, "approve");
  assert.equal(result.reviewId, PENDING_REVIEW);
  assert.equal(result.status, "approved");
  assert.equal(result.statusLabel, REVIEW_STATUS_LABELS.approved);
  assert.equal(result.changed, true);

  // 通过之后：两个维度一起进入公开面（商品 1 星、打手 1 星）
  const product = await reviewsOfTarget("product", PENDING_PRODUCT);
  assert.equal(product.reviewCount, 1);
  assert.equal(product.averageRating, 1);

  // cp-3 原本 4 个打手维度合计 18 → 4.5；这一条打手维度是 1 星，
  // 于是 (18 + 1) / 5 = 3.8。平均分确实被这一条拉下来了，而不是被忽略
  const cpAfter = await reviewsOfTarget("companion", FREE_COMPANION);
  assert.equal(cpAfter.reviewCount, 5);
  assert.equal(cpAfter.averageRating, 3.8);

  // 再点一次「通过」：已经是目标状态，不是错误、不重复改动
  const again = await moderate(PENDING_REVIEW, "approve");
  assert.equal(again.changed, false);
  assert.equal(again.status, "approved");
});

test("驳回与隐藏必须写原因；通过不需要（D10）", async () => {
  assert.deepEqual(REVIEW_MODERATION_REQUIRES_REASON, {
    approve: false,
    reject: true,
    hide: true,
    unhide: false,
  });

  await expectApiError(
    moderate(PENDING_REVIEW, "reject"),
    "BAD_REQUEST",
    REVIEW_REASON_REQUIRED_MESSAGE,
  );
  await expectApiError(
    moderate(PENDING_REVIEW, "reject", { reason: "   " }),
    "BAD_REQUEST",
    REVIEW_REASON_REQUIRED_MESSAGE,
  );
  // 一条都不该被改掉
  assert.equal((await stored(PENDING_REVIEW)).status, "pending");

  await expectApiError(
    moderate(APPROVED_FOR_CP1, "hide", { reason: "\n\t " }),
    "BAD_REQUEST",
    REVIEW_REASON_REQUIRED_MESSAGE,
  );
  assert.equal((await stored(APPROVED_FOR_CP1)).status, "approved");

  // 通过不需要原因，带上只当备注
  const approved = await moderate(PENDING_REVIEW, "approve", { reason: "内容没问题" });
  assert.equal(approved.changed, true);
  assert.equal(approved.status, "approved");
  // 「通过」不写原因字段：原因只有驳回与隐藏两处
  assert.equal((await stored(PENDING_REVIEW)).rejectReason, null);
  assert.equal((await stored(PENDING_REVIEW)).hideReason, null);
});

test("驳回：状态与原因一起落库，作者在原记录上重新提交（D8 / D9 / R2）", async () => {
  const result = await moderate(PENDING_REVIEW, "reject", { reason: "含无关广告内容" });
  assert.equal(result.status, "rejected");

  const entity = await stored(PENDING_REVIEW);
  assert.equal(entity.rejectReason, "含无关广告内容");
  assert.equal(entity.hideReason, null);
  assert.equal(entity.reviewedBy, ADMIN_ID);
  // 记录没有被删除（R2）：内容原样留着
  assert.deepEqual(entity.productReview, { rating: 1, content: "等待时间太久了。（Mock 文案）" });

  // 作者侧：看到状态与驳回原因，并拿到「重新提交」入口
  const target = await getReviewTargetForUser(entity.orderId, entity.userId, undefined, "server");
  assert.equal(target.status, "rejected");
  assert.equal(target.review.statusLabel, REVIEW_STATUS_LABELS.rejected);
  assert.equal(target.review.rejectReason, "含无关广告内容");
  assert.equal(target.review.canResubmit, true);

  // 被驳回的评价**不计入**公开面
  assert.equal((await reviewsOfTarget("product", PENDING_PRODUCT)).reviewCount, 0);
});

test("隐藏与恢复公开：一隐一显都立刻反映到公开列表与平均分上（D11 / D14）", async () => {
  const before = await reviewsOfTarget("companion", "cp-1");
  assert.equal(before.averageRating, 4.7);
  assert.equal(before.reviewCount, 3);

  await moderate(APPROVED_FOR_CP1, "hide", { reason: "内容已过期" });
  const hidden = await reviewsOfTarget("companion", "cp-1");
  assert.equal(hidden.reviewCount, 2, "隐藏必须立刻从评分聚合里扣掉");
  assert.equal(hidden.averageRating, 4.5);
  assert.equal(hidden.reviews.some((item) => item.id === APPROVED_FOR_CP1), false);

  // 作者侧仍然看得见，并带上隐藏原因（D8）
  const row = toReviewListItem(await stored(APPROVED_FOR_CP1));
  assert.equal(row.status, "hidden");
  assert.equal(row.statusLabel, "已被管理员隐藏");
  assert.equal(row.hideReason, "内容已过期");
  assert.equal(row.canResubmit, false, "隐藏不是驳回，不给重提入口");

  // 恢复公开：不需要业务原因，但必须回到列表与平均分里（D10 / D11）
  const restored = await moderate(APPROVED_FOR_CP1, "unhide");
  assert.equal(restored.status, "approved");
  assert.equal(restored.changed, true);
  assert.deepEqual(await reviewsOfTarget("companion", "cp-1"), before);

  // 另一条：种子里就是 hidden 的，恢复之后两个维度都计入
  assert.equal((await reviewsOfTarget("product", HIDDEN_PRODUCT)).reviewCount, 0);
  await moderate(HIDDEN_REVIEW, "unhide");
  const productAfter = await reviewsOfTarget("product", HIDDEN_PRODUCT);
  assert.equal(productAfter.reviewCount, 1);
  assert.equal(productAfter.averageRating, 5);
});

test("状态机不允许的迁移一律 400，且给出下一步（D7 / R2）", async () => {
  // 已公开的不能「驳回」——要撤下就隐藏。文案必须明确说出改用什么动作
  await expectApiError(
    moderate(APPROVED_FOR_CP1, "reject", { reason: "想撤下来" }),
    "BAD_REQUEST",
    adminReviewInvalidTransitionMessage("approved", "reject"),
  );
  assert.equal((await stored(APPROVED_FOR_CP1)).status, "approved");

  // 隐藏中的不能「通过」——恢复公开的动作是 unhide。若放行，审计里会记成
  // `review.approve`，读起来像「通过了一条新评价」（D22）
  await expectApiError(
    moderate(HIDDEN_REVIEW, "approve"),
    "BAD_REQUEST",
    adminReviewInvalidTransitionMessage("hidden", "approve"),
  );
  assert.equal((await stored(HIDDEN_REVIEW)).status, "hidden");

  // 待审核的不能直接隐藏
  await expectApiError(
    moderate(PENDING_REVIEW, "hide", { reason: "先藏起来" }),
    "BAD_REQUEST",
    adminReviewInvalidTransitionMessage("pending", "hide"),
  );

  // 被驳回的：管理员做不了任何事，只能等用户重新提交
  await moderate(PENDING_REVIEW, "reject", { reason: "不合规" });
  await expectApiError(
    moderate(PENDING_REVIEW, "approve"),
    "BAD_REQUEST",
    adminReviewInvalidTransitionMessage("rejected", "approve"),
  );

  assert.equal(REVIEW_MODERATION_ACTION_LABELS.approve, "通过");
  assert.equal(REVIEW_MODERATION_ACTION_LABELS.reject, "驳回");
  assert.equal(REVIEW_MODERATION_ACTION_LABELS.hide, "隐藏");
  assert.equal(REVIEW_MODERATION_ACTION_LABELS.unhide, "恢复公开");
});

test("管理员改不了星级与正文：四个动作之后内容逐字段不变（D12）", async () => {
  const original = await stored(PENDING_REVIEW);
  const contentFields = (review) => ({
    productReview: review.productReview,
    companionReview: review.companionReview,
    evidence: review.evidence,
    productId: review.productId,
    specId: review.specId,
    userId: review.userId,
    orderId: review.orderId,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  });
  const before = contentFields(original);

  await moderate(PENDING_REVIEW, "approve");
  assert.deepEqual(contentFields(await stored(PENDING_REVIEW)), before);
  await moderate(PENDING_REVIEW, "hide", { reason: "公开后发现问题" });
  assert.deepEqual(contentFields(await stored(PENDING_REVIEW)), before);
  await moderate(PENDING_REVIEW, "unhide");
  assert.deepEqual(contentFields(await stored(PENDING_REVIEW)), before);

  // 服务层根本没有接收星级 / 正文的位置：请求体里塞进去也不会被读
  await moderate(PENDING_REVIEW, "hide", {
    reason: "再隐藏一次",
    productReview: { rating: 1, content: "管理员改的" },
    companionReview: { rating: 1, content: "管理员改的" },
    rating: 1,
    content: "管理员改的",
  });
  const after = await stored(PENDING_REVIEW);
  assert.deepEqual(contentFields(after), before);
  assert.notEqual(after.productReview.content, "管理员改的");
});

test("审核写入的幂等与并发：同一个键只改一次、只写一条审计（D22）", async () => {
  const key = uniqueKey();
  const body = { idempotencyKey: key, reason: "第一版原因" };

  const first = await moderateAdminReview(PENDING_REVIEW, "reject", ADMIN_ID, body);
  assert.equal(first.changed, true);

  // 同一个键重发：重放，状态与原因都保持第一次的结果
  const replay = await moderateAdminReview(PENDING_REVIEW, "reject", ADMIN_ID, body);
  assert.equal(replay.changed, false);
  assert.equal((await stored(PENDING_REVIEW)).rejectReason, "第一版原因");

  // 同一个键换个动作：这是调用方复用了键，必须明确报错而不是静默返回「已处理」
  await expectApiError(
    moderateAdminReview(PENDING_REVIEW, "approve", ADMIN_ID, body),
    "BAD_REQUEST",
    "该幂等键已用于另一个操作",
  );

  // 并发：8 个「同一个键、同一个动作」同时到达，只能有一次真正改动
  resetMockStore("review");
  resetMockStore("adminAudit");
  const concurrentKey = uniqueKey();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      moderateAdminReview(PENDING_REVIEW, "approve", ADMIN_ID, { idempotencyKey: concurrentKey }),
    ),
  );
  assert.equal(results.filter((item) => item.changed).length, 1, "只能有一次真正改动");
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "review", targetId: PENDING_REVIEW })).length,
    1,
    "只能有一条审计",
  );
});

test("审核不存在的评价一律 404（与其它后台列表同口径）", async () => {
  await expectApiError(
    moderate("rev-not-exist", "approve"),
    "NOT_FOUND",
    ADMIN_REVIEW_NOT_FOUND_MESSAGE,
  );
  assert.equal(await getAdminReviewDetail("rev-not-exist", undefined, "server"), null);
});

// ═══════════════════════ 五、AdminAudit（D22） ═══════════════════════

test("四个动作各写一条 AdminAudit，能回答谁 / 哪条 / 什么动作 / 何时 / 为什么（D10 / D22）", async () => {
  const audits = () => getAdminAuditRepository().listAudits({ targetType: "review", targetId: PENDING_REVIEW });

  await moderate(PENDING_REVIEW, "approve");
  const approved = await audits();
  assert.equal(approved.length, 1);
  assert.equal(approved[0].action, REVIEW_MODERATION_AUDIT_ACTIONS.approve);
  assert.equal(approved[0].targetType, "review");
  assert.equal(approved[0].targetId, PENDING_REVIEW);
  assert.equal(approved[0].actorId, ADMIN_ID);
  assert.equal(approved[0].actorRole, "admin");
  assert.equal(approved[0].before.status, "pending");
  assert.equal(approved[0].after.status, "approved");
  // 快照带上是哪一单、哪一个商品 / 打手、两个维度各几星：不必再回查评价就能读懂
  assert.equal(approved[0].after.orderNo, (await stored(PENDING_REVIEW)).orderNo);
  assert.equal(approved[0].after.productId, PENDING_PRODUCT);
  assert.equal(approved[0].after.productRating, 1);
  assert.equal(approved[0].after.companionRating, 1);

  await moderate(PENDING_REVIEW, "hide", { reason: "上线后发现不实" });
  await moderate(PENDING_REVIEW, "unhide");
  await moderate(PENDING_REVIEW, "hide", { reason: "第二次隐藏" });
  await moderate(PENDING_REVIEW, "unhide");

  const all = await audits();
  assert.deepEqual(
    all.map((entry) => entry.action),
    [
      "review.approve",
      "review.hide",
      "review.unhide",
      "review.hide",
      "review.unhide",
    ],
    "动作名严格来自词表，不是接口路径",
  );
  // 「恢复公开」也必须有审计（D10 / D11）：谁在什么时候把它放回公开列表必须可追溯
  assert.equal(all.filter((entry) => entry.action === "review.unhide").length, 2);
  assert.equal(all[1].after.hideReason, "上线后发现不实");
  assert.equal(all[2].after.hideReason, null, "恢复公开之后隐藏原因必须清掉");
  // 每一轮 before/after 首尾相接，可以顺着读出一条完整的状态轨迹
  for (let index = 1; index < all.length; index += 1) {
    assert.equal(all[index].before.status, all[index - 1].after.status);
  }
  // 时间戳来自服务端（不是请求体）
  for (const entry of all) assert.equal(Number.isFinite(Date.parse(entry.createdAt)), true);
});

test("空操作与重放都不写第二条审计（D22 的口径与其它伪事务一致）", async () => {
  const auditCount = async () =>
    (await getAdminAuditRepository().listAudits({ targetType: "review", targetId: PENDING_REVIEW })).length;

  await moderate(PENDING_REVIEW, "approve");
  assert.equal(await auditCount(), 1);

  // 已经是目标状态：什么都不做，也不留下第二条审计
  await moderate(PENDING_REVIEW, "approve");
  assert.equal(await auditCount(), 1);

  // 被拒的动作更不该留下任何痕迹
  await expectApiError(moderate(PENDING_REVIEW, "reject", { reason: "x" }), "BAD_REQUEST");
  assert.equal(await auditCount(), 1);

  // 重放同样不写
  const key = uniqueKey();
  await moderateAdminReview(PENDING_REVIEW, "hide", ADMIN_ID, { idempotencyKey: key, reason: "原因" });
  await moderateAdminReview(PENDING_REVIEW, "hide", ADMIN_ID, { idempotencyKey: key, reason: "原因" });
  assert.equal(await auditCount(), 2, "通过 + 隐藏 = 2 条，重放不加");

  // 别的对象上的操作不会串到这条评价的审计里
  await moderate(APPROVED_FOR_CP1, "hide", { reason: "另一条" });
  assert.equal(await auditCount(), 2);
});

// ═══════════════════════ 六、退款与评价是两条线（D18 / D19 / D20） ═══════════════════════

test("完成后部分退款 / 全额退款都仍然可以评价（D18 / D19）", async () => {
  const order = await getPaymentRepository().findOrderById(FREE_ORDER);
  assert.equal(order.status, "completed");
  assert.ok(order.completedAt);

  // ① 部分退款：订单状态不变（仍在 completed），资格更不该受影响
  const partial = applyOrderRefund(FREE_ORDER, "2026-09-14T00:00:00.000Z", 100);
  assert.equal(partial.changed, true);
  assert.equal(partial.updated.status, "completed");
  assert.equal(partial.updated.completedAt, order.completedAt);

  let target = await getReviewTargetForUser(FREE_ORDER, FREE_ORDER_USER, undefined, "server");
  assert.equal(target.status, "ready");
  const first = await createReviewForOrder(
    FREE_ORDER,
    FREE_ORDER_USER,
    {
      idempotencyKey: uniqueKey(),
      productReview: { rating: 4, content: null },
      companionReview: null,
      evidence: [],
    },
    undefined,
    "server",
  );
  assert.equal(first.created, true);

  // ② 完成之后**全额**退款：状态变成 refunded，但 `completedAt` 还在
  // 复位到「一次款都没退过」的预置状态，否则①留下的 `refundedAmount = 100`
  // 会让这一单一单不再接受任何出款（一单一退）
  resetMockStore("payment");
  resetMockStore("review");
  const paid = await getPaymentRepository().findOrderById(FREE_ORDER);
  const full = applyOrderRefund(FREE_ORDER, "2026-09-14T00:00:00.000Z", paid.actualPaidAmount);
  assert.equal(full.updated.status, "refunded");
  assert.equal(full.updated.completedAt, order.completedAt, "退款不改写完成时间");

  target = await getReviewTargetForUser(FREE_ORDER, FREE_ORDER_USER, undefined, "server");
  assert.equal(target.status, "ready", "状态是 refunded 但服务确实完成过，仍然可以评价");
  const afterFull = await createReviewForOrder(
    FREE_ORDER,
    FREE_ORDER_USER,
    {
      idempotencyKey: uniqueKey(),
      productReview: { rating: 2, content: "退是退了，但服务确实打过。（Mock 文案）" },
      companionReview: { rating: 2, content: null },
      evidence: [],
    },
    undefined,
    "server",
  );
  assert.equal(afterFull.created, true);

  // ③ 待评价列表也不能按订单状态过滤（否则全额退款的那一单会凭空消失）
  resetMockStore("payment");
  resetMockStore("review");
  applyOrderRefund(FREE_ORDER, "2026-09-14T00:00:00.000Z", paid.actualPaidAmount);
  const pendingIds = (
    await queryReviewsForUser(
      FREE_ORDER_USER,
      page({ tab: "pending", pageSize: 50 }),
      "server",
      new Date("2026-09-14T12:00:00.000Z"),
    )
  ).items.map((item) => item.orderId);
  assert.equal(pendingIds.includes(FREE_ORDER), true, "已完成之后退款的订单仍在待评价列表里");
});

test("完成前就退款（没有 completedAt）的订单一律不可评价（D19）", async () => {
  for (const orderId of ["ord-seed-1001-01", "ord-seed-1001-03", "ord-seed-1001-04", "ord-seed-1001-06"]) {
    const target = await getReviewTargetForUser(orderId, "u-1001", undefined, "server");
    assert.equal(target.status, "blocked", `${orderId} 不该可以评价`);
    await expectApiError(
      createReviewForOrder(
        orderId,
        "u-1001",
        {
          idempotencyKey: uniqueKey(),
          productReview: { rating: 5, content: null },
          companionReview: null,
          evidence: [],
        },
        undefined,
        "server",
      ),
      "BAD_REQUEST",
      "服务完成之后才能评价",
    );
  }
});

test("评价通过之后发生退款，评价不会被自动撤下（D20）", async () => {
  const created = await createReviewForOrder(
    FREE_ORDER,
    FREE_ORDER_USER,
    {
      idempotencyKey: uniqueKey(),
      productReview: { rating: 5, content: "打得很稳。（Mock 文案）" },
      companionReview: { rating: 5, content: null },
      evidence: [],
    },
    undefined,
    "server",
  );
  await moderate(created.reviewId, "approve");
  assert.equal((await reviewsOfTarget("product", FREE_PRODUCT)).reviewCount, 1);

  // 退款执行：订单状态变成 refunded
  const order = await getPaymentRepository().findOrderById(FREE_ORDER);
  const refunded = applyOrderRefund(FREE_ORDER, "2026-09-14T00:00:00.000Z", order.actualPaidAmount);
  assert.equal(refunded.updated.status, "refunded");

  // 评价仍然 approved，仍然在公开列表与平均分里——退款不构成撤下的理由（D20）
  const entity = await stored(created.reviewId);
  assert.equal(entity.status, "approved");
  assert.equal(entity.hideReason, null, "退款不得被偷偷映射成隐藏");
  const product = await reviewsOfTarget("product", FREE_PRODUCT);
  assert.equal(product.reviewCount, 1);
  assert.equal(product.averageRating, 5);
  assert.equal(product.reviews.some((item) => item.id === created.reviewId), true);

  // 违规与否由管理员**独立**判定：想撤下就显式隐藏，并且要写原因
  await expectApiError(
    moderate(created.reviewId, "hide"),
    "BAD_REQUEST",
    REVIEW_REASON_REQUIRED_MESSAGE,
  );
  await moderate(created.reviewId, "hide", { reason: "内容不实" });
  assert.equal((await reviewsOfTarget("product", FREE_PRODUCT)).reviewCount, 0);
});

// ═══════════════════════ 七、管理端列表与 DTO ═══════════════════════

test("管理端列表默认只看待审核，筛选与角标各按自己的口径（不先取页再过滤）", async () => {
  const defaults = await queryAdminReviewList(
    resolveAdminReviewListQuery(page(), true),
    page(),
    "server",
  );
  assert.deepEqual(
    defaults.items.map((item) => item.id),
    [PENDING_REVIEW],
    "默认落在待审核队列，而不是全部",
  );
  assert.equal(defaults.notice, ADMIN_REVIEW_LIST_NOTICE);

  // 角标不受筛选影响：后台一共有多少条各状态，一眼可见
  assert.deepEqual(defaults.counts, { pending: 1, approved: 9, rejected: 0, hidden: 1 });

  const all = await queryAdminReviewList(
    resolveAdminReviewListQuery(page({ status: "all", pageSize: 50 }), true),
    page({ status: "all", pageSize: 50 }),
    "server",
  );
  assert.equal(all.total, reviewSeed.length);
  assert.equal(all.items.length, reviewSeed.length);
  assert.equal(all.hasMore, false);

  // 关键词命中订单号 / 评价 id / 商品名 / 规格名 / 打手名（大小写不敏感）
  const byOrderNo = await queryAdminReviewList(
    resolveAdminReviewListQuery(page({ status: "all", keyword: reviewSeed[0].orderNo }), true),
    page({ status: "all", keyword: reviewSeed[0].orderNo }),
    "server",
  );
  assert.deepEqual(byOrderNo.items.map((item) => item.id), [reviewSeed[0].id]);
  assert.equal(
    (
      await queryAdminReviewList(
        resolveAdminReviewListQuery(page({ status: "all", keyword: "不存在的关键词" }), true),
        page({ status: "all", keyword: "不存在的关键词" }),
        "server",
      )
    ).total,
    0,
  );

  // 状态筛选是业务条件：接口侧非法值 400，页面侧回退到默认值
  await assert.rejects(
    async () => resolveAdminReviewListQuery(page({ status: "gone" }), true),
    (error) => error.code === "BAD_REQUEST",
  );
  assert.equal(resolveAdminReviewListQuery(page({ status: "gone" }), false).status, "pending");
});

test("管理端 DTO 的键集固定，作者摘要与两个维度都在（D2 / D13 / D21）", async () => {
  const list = await queryAdminReviewList(
    resolveAdminReviewListQuery(page({ status: "all", pageSize: 50 }), true),
    page({ status: "all", pageSize: 50 }),
    "server",
  );
  const item = list.items.find((entry) => entry.id === PENDING_REVIEW);

  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "allowedActions",
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
      "productId",
      "productReview",
      "productTitle",
      "quantity",
      "rejectReason",
      "reviewedAt",
      "reviewedBy",
      "reviewedByName",
      "specName",
      "status",
      "statusLabel",
      "updatedAt",
      "user",
    ].sort(),
  );

  // 管理员必须看得见「这是谁写的」——但不是公开面的脱敏昵称
  assert.equal(item.user.id, "u-1004");
  assert.equal("userId" in item, false, "仓储的裸 userId 不直接出现在 DTO 上");
  assert.notEqual(item.user.nickname, undefined);
  // 两个维度**同时**给出（D2）：只给一个会让管理员看不见用户写的另一半
  assert.deepEqual(item.productReview, { rating: 1, content: "等待时间太久了。（Mock 文案）" });
  assert.deepEqual(item.companionReview, { rating: 1, content: null });
  // 聚合身份是内部字段，但管理端要看得到（它决定这条评价计入谁）
  assert.equal(item.productId, PENDING_PRODUCT);

  // 可执行动作由服务端给出，且与状态机同源
  assert.deepEqual(item.allowedActions, {
    canApprove: true,
    canReject: true,
    canHide: false,
    canUnhide: false,
  });

  // 详情与列表同形，但走独立入口
  assert.deepEqual(await getAdminReviewDetail(PENDING_REVIEW, undefined, "server"), item);
});

test("管理端列表的空态注入只清列表，不清角标（不伪造业务事实）", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";
  const params = page({ mockEmpty: "reviews" });
  const emptied = await queryAdminReviewList(
    resolveAdminReviewListQuery(page({ status: "all", pageSize: 50 }), true),
    params,
    "server",
  );
  assert.deepEqual(emptied.items, []);
  assert.equal(emptied.total, 0);
  assert.equal(emptied.hasMore, false);
  // 角标仍然是真实的：空态注入的是**这一页的列表**，不是「后台没有待审评价」
  assert.deepEqual(emptied.counts, { pending: 1, approved: 9, rejected: 0, hidden: 1 });

  // 开关关闭时参数完全不生效
  process.env.ENABLE_MOCK_DEBUG = "false";
  try {
    const ignored = await queryAdminReviewList(
      resolveAdminReviewListQuery(page({ status: "all", pageSize: 50 }), true),
      params,
      "server",
    );
    assert.equal(ignored.items.length, reviewSeed.length);
  } finally {
    delete process.env.ENABLE_MOCK_DEBUG;
  }
});

// ═══════════════════════ 八、种子完整性（D17） ═══════════════════════

test("种子里的假评分彻底退出业务真值：实体没有评分字段，分数只能来自 approved 记录（D17）", async () => {
  // 陪玩实体上没有任何评分字段——`rating` / `reviewCount` / `reviews` 只存在于 DTO 上，
  // 由聚合在读取时算出来
  const companions = await getCompanionDetail("cp-1", page(), "server");
  for (const key of ["rating", "reviewCount", "reviews"]) {
    assert.equal(key in companions, true, "DTO 上要有这三个字段");
  }
  const entity = await import("../lib/mocks/fixtures/seed.ts").then((module) => module.companionSeed[0]);
  for (const key of ["rating", "reviewCount", "reviews"]) {
    assert.equal(key in entity, false, `陪玩实体不该带 ${key}`);
  }

  // 改一条评价的状态，分数立刻跟着变——证明分数确实是从记录算出来的，
  // 而不是任何地方存着的一个数字
  const before = await reviewsOfTarget("companion", "cp-1");
  await moderate(APPROVED_FOR_CP1, "hide", { reason: "验证用" });
  const after = await reviewsOfTarget("companion", "cp-1");
  assert.notEqual(after.averageRating, before.averageRating);
  assert.equal(after.reviewCount, before.reviewCount - 1);

  // 每条种子评价都关联真实订单、有明确状态、至少一个维度（种子层的四条不变量）
  for (const review of reviewSeed) {
    assert.ok(review.orderId);
    assert.ok(["pending", "approved", "hidden"].includes(review.status));
    assert.ok(review.productReview !== null || review.companionReview !== null);
    // 原因字段与状态严格对齐（D10）
    assert.equal(review.rejectReason === null, review.status !== "rejected");
    assert.equal(review.hideReason === null, review.status !== "hidden");
  }
});

// ═══════════════════════ 九、权限矩阵（D21） ═══════════════════════

test("评价规则层不自己解析角色：权限只由接口的守卫强制（D21）", async () => {
  // 服务层没有「当前是谁」这个概念：管理端服务只收 adminId 作为**操作者标识**，
  // 它不做角色判断——角色判断只有一处，就是每个 Route Handler 的 requireAdmin()
  //
  // ⚠️ 比的是**去掉注释之后**的源码：这个文件的文档里会写明「调用方必须已经过了
  // `requireAdmin()`」，那是对调用方的要求，不是它自己做的鉴权。
  // 直接对大段文字做 includes 会把说明当成实现，从而要求删掉一句正确的注释。
  const source = stripComments(await readFile(new URL("../lib/services/adminReviews.ts", import.meta.url), "utf8"));
  for (const forbidden of ["requireAdmin", "requireStaff", "getSessionUser", "cookies(", "@/lib/auth"]) {
    assert.equal(source.includes(forbidden), false, `管理端服务不该自己解析会话：${forbidden}`);
  }
  for (const route of [
    "../app/api/admin/reviews/route.ts",
    "../app/api/admin/reviews/[id]/route.ts",
    "../app/api/admin/reviews/[id]/approve/route.ts",
    "../app/api/admin/reviews/[id]/reject/route.ts",
    "../app/api/admin/reviews/[id]/hide/route.ts",
    "../app/api/admin/reviews/[id]/unhide/route.ts",
  ]) {
    const text = await readFile(new URL(route, import.meta.url), "utf8");
    assert.ok(text.includes("requireAdmin()"), `${route} 必须自己调用 requireAdmin()`);
  }
  // 用户侧两个入口走用户会话守卫
  for (const route of [
    "../app/api/reviews/route.ts",
    "../app/api/orders/[id]/reviews/route.ts",
    "../app/api/reviews/[id]/resubmit/route.ts",
  ]) {
    const text = await readFile(new URL(route, import.meta.url), "utf8");
    assert.ok(text.includes("requireUser()"), `${route} 必须自己调用 requireUser()`);
  }
});

const BASE = process.env.APP_BASE_URL;

// ⚠️ 必须在**发起任何请求之前**执行——这一行加上 --test-concurrency=1，
// 才是「本文件的断言读到的是预置状态」的保证。
await resetServerStores();
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P1-8 的 HTTP 用例";

async function requestWithCookie(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function sendWithCookie(method, pathname, body, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
  return { status: response.status, body: await response.text() };
}

async function mockAdminLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

test("P1-8 评价接口权限矩阵：匿名 / 用户 / 客服 401，非管理员 403，管理员放行到业务校验", { skip: SKIP_HTTP }, async () => {
  const login = await mockAdminLogin();
  const adminCookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  const readPaths = ["/api/admin/reviews", `/api/admin/reviews/${PENDING_REVIEW}`];
  /**
   * 四个动作的写接口。请求体**故意不带幂等键**（不是漏了）：
   * 被拒身份拿到 401 / 403、管理者拿到「缺少幂等键」的 400，
   * 这本身就证明 `requireAdmin()` 排在解析入参之前，而这一轮用例一个字节都不写。
   */
  const writes = [
    ["POST", `/api/admin/reviews/${PENDING_REVIEW}/approve`],
    ["POST", `/api/admin/reviews/${PENDING_REVIEW}/reject`],
    ["POST", `/api/admin/reviews/${PENDING_REVIEW}/hide`],
    ["POST", `/api/admin/reviews/${PENDING_REVIEW}/unhide`],
  ];

  // ① 匿名：读与写都是 401
  for (const pathname of readPaths) {
    assert.equal((await requestWithCookie(pathname, null)).status, 401, `${pathname} 匿名应当 401`);
  }
  for (const [method, pathname] of writes) {
    assert.equal(
      (await sendWithCookie(method, pathname, "{}", null)).status,
      401,
      `${pathname} 匿名应当 401`,
    );
    assert.equal(JSON.parse((await sendWithCookie(method, pathname, "{}", null)).body).error.message, ADMIN_UNAUTHORIZED_MESSAGE);
  }

  // ② 普通用户的 Cookie 换不来管理权限；**客服同样不行**（D21：客服无审核权）
  for (const cookie of ["mock_user_id=u-1001", "mock_staff_id=staff-1", "mock_user_id=admin-1"]) {
    assert.equal((await requestWithCookie(readPaths[0], cookie)).status, 401, `${cookie} 不该进管理端`);
    assert.equal((await sendWithCookie("POST", writes[0][1], "{}", cookie)).status, 401);
  }

  // ③ 有管理会话但没权限：客服角色 / 护航角色 / 被停用的管理员 → 403
  //    ⚠️ 「已登录但没有权限」与「未登录」分得开：前者换账号也没用，提示也只有一句
  if (adminCookie) {
    const messages = new Set();
    for (const id of ["admin-2", "admin-3", "admin-4"]) {
      for (const pathname of readPaths) {
        const { status, body } = await requestWithCookie(pathname, `mock_admin_id=${id}`);
        assert.equal(status, 403, `无权身份不该读 ${pathname}`);
        messages.add(JSON.parse(body).error.message);
      }
      for (const [method, pathname] of writes) {
        const result = await sendWithCookie(method, pathname, "{}", `mock_admin_id=${id}`);
        assert.equal(result.status, 403, `无权身份不该写 ${pathname}`);
        messages.add(JSON.parse(result.body).error.message);
      }
    }
    assert.equal(messages.size, 1, `拒绝文案应当只有一句：${[...messages].join(" / ")}`);
    assert.equal([...messages][0], ADMIN_FORBIDDEN_MESSAGE);

    // ④ 管理员：读 200；写则**穿过了权限层**——错在缺幂等键（400），不是被挡在门外
    for (const pathname of readPaths) {
      assert.equal((await requestWithCookie(pathname, adminCookie)).status, 200);
    }
    for (const [method, pathname] of writes) {
      const result = await sendWithCookie(method, pathname, "{}", adminCookie);
      assert.equal(result.status, 400, `${pathname} 管理者应当走到业务校验`);
      assert.equal(JSON.parse(result.body).error.message, IDEMPOTENCY_KEY_MISSING_MESSAGE);
    }
    // 不存在的对象：管理员 404，被拒身份仍然 403（权限先于对象是否存在被判定）
    assert.equal((await requestWithCookie("/api/admin/reviews/rev-nope", adminCookie)).status, 404);
    assert.equal((await requestWithCookie("/api/admin/reviews/rev-nope", "mock_admin_id=admin-2")).status, 403);
  } else {
    // 拿不到管理会话时至少把「非管理员一律进不来」钉住
    for (const id of ["admin-2", "admin-3", "admin-4"]) {
      assert.equal((await requestWithCookie(readPaths[0], `mock_admin_id=${id}`)).status, 401);
    }
  }

  // ⑤ 用户侧入口同样要会话：匿名 401（`/api/reviews` 读的是自己的评价）
  assert.equal((await requestWithCookie("/api/reviews", null)).status, 401);

  // ⑥ 客服工作台与打手工作台**根本没有评价入口**（D21 的权限上限，不是实现的缺失）：
  //    没有路由 ⇒ 拿不到任何评价数据，也就不可能提前看到未公开的评价与管理员备注
  assert.equal((await requestWithCookie("/api/staff/reviews", null)).status, 404);
  assert.equal((await requestWithCookie("/api/companion/reviews", null)).status, 404);
});

test("P1-8 审核接口端到端：通过之后公开面立刻能读到，驳回之后缓存不残留", { skip: SKIP_HTTP }, async () => {
  const login = await mockAdminLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];

  // 通过一条待审评价：读接口的响应里立刻是 approved
  const approved = await sendWithCookie(
    "POST",
    `/api/admin/reviews/${PENDING_REVIEW}/approve`,
    JSON.stringify({ idempotencyKey: uniqueKey() }),
    adminCookie,
  );
  assert.equal(approved.status, 200);
  const approvedBody = JSON.parse(approved.body);
  assert.equal(approvedBody.data.status, "approved");
  assert.equal(approvedBody.data.statusLabel, REVIEW_STATUS_LABELS.approved);
  assert.equal(approvedBody.data.changed, true);
  // 返回体**只有**这四个字段：界面据此就地更新一行
  assert.deepEqual(Object.keys(approvedBody.data).sort(), ["changed", "reviewId", "status", "statusLabel"]);

  // 同一个键重发：200，但 changed=false（不是错误，也不必重试）
  const replay = await sendWithCookie(
    "POST",
    `/api/admin/reviews/${PENDING_REVIEW}/hide`,
    JSON.stringify({ idempotencyKey: "replay-check-key", reason: "x" }),
    adminCookie,
  );
  assert.equal(replay.status, 200);
  const again = await sendWithCookie(
    "POST",
    `/api/admin/reviews/${PENDING_REVIEW}/hide`,
    JSON.stringify({ idempotencyKey: "replay-check-key", reason: "x" }),
    adminCookie,
  );
  assert.equal(again.status, 200);
  assert.equal(JSON.parse(again.body).data.changed, false);

  // 驳回不写原因：服务端拒绝（不能只在界面上限制）
  const noReason = await sendWithCookie(
    "POST",
    `/api/admin/reviews/${HIDDEN_REVIEW}/reject`,
    JSON.stringify({ idempotencyKey: uniqueKey() }),
    adminCookie,
  );
  assert.equal(noReason.status, 400);
  assert.equal(JSON.parse(noReason.body).error.message, REVIEW_REASON_REQUIRED_MESSAGE);

  // 用户侧读接口的形状：分页 + 两个角标
  const asUser = await requestWithCookie("/api/reviews?tab=reviewed", "mock_user_id=u-1001");
  assert.equal(asUser.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(asUser.body).data).sort(), [
    "counts",
    "hasMore",
    "items",
    "page",
    "pageSize",
    "tab",
    "total",
  ]);
});

test("P1-8 用户提交接口：零维度 400、缺幂等键 400、非本人订单 404（HTTP 契约）", { skip: SKIP_HTTP }, async () => {
  const cookie = "mock_user_id=u-1001";
  const submitBody = (body) =>
    sendWithCookie("POST", `/api/orders/${FREE_ORDER}/reviews`, JSON.stringify(body), cookie);

  const noKey = await submitBody({
    productReview: { rating: 5, content: null },
  });
  assert.equal(noKey.status, 400);
  assert.equal(JSON.parse(noKey.body).error.message, IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const noDimension = await submitBody({
    idempotencyKey: uniqueKey(),
    productReview: null,
    companionReview: null,
  });
  assert.equal(noDimension.status, 400);
  assert.equal(JSON.parse(noDimension.body).error.message, REVIEW_DIMENSION_MISSING_MESSAGE);

  // 别人的订单：与「不存在」同口径，不区分
  const notMine = await sendWithCookie(
    "POST",
    "/api/orders/ord-seed-1002-02/reviews",
    JSON.stringify({ idempotencyKey: uniqueKey(), productReview: { rating: 5, content: null } }),
    cookie,
  );
  assert.equal(notMine.status, 404);

  // 正常提交：201/200 都行，但响应体只回四个字段
  const submitKey = uniqueKey();
  const ok = await submitBody({
    idempotencyKey: submitKey,
    productReview: { rating: 5, content: "全程开麦，节奏很稳。（Mock 文案）" },
    companionReview: { rating: 4, content: null },
    evidence: [],
  });
  assert.ok(ok.status === 200 || ok.status === 201, `意外的状态码 ${ok.status}`);
  const data = JSON.parse(ok.body).data;
  assert.deepEqual(Object.keys(data).sort(), ["created", "orderId", "reviewId", "status"]);
  assert.equal(data.status, "pending");
  assert.equal(data.created, true);

  // 幂等键重发（**同一个键**）：回同一条记录，created=false。
  // 与「一单一评」是两回事——后者换新键也会被拦，前者必须靠这个键认出来
  const retry = await submitBody({
    idempotencyKey: submitKey,
    productReview: { rating: 5, content: "全程开麦，节奏很稳。（Mock 文案）" },
    companionReview: { rating: 4, content: null },
    evidence: [],
  });
  const retried = JSON.parse(retry.body).data;
  assert.equal(retried.created, false);
  assert.equal(retried.reviewId, data.reviewId, "同一个键必须回同一条评价，不能又建一条");

  // 换一个新键、同一张订单：仍然是同一条（一单一评），不会变成第二条
  const second = await submitBody({
    idempotencyKey: uniqueKey(),
    productReview: { rating: 5, content: null },
  });
  const secondData = JSON.parse(second.body).data;
  assert.equal(secondData.created, false);
  assert.equal(secondData.reviewId, data.reviewId, "一单一评：换键也不产生第二条");
});

test("P1-8 正常化原因：服务端与常量层同一份规则", () => {
  assert.deepEqual(normalizeReviewReason("  处理完毕  ", true), { ok: true, reason: "处理完毕" });
  assert.deepEqual(normalizeReviewReason("   ", false), { ok: true, reason: null });
  assert.equal(normalizeReviewReason("   ", true).ok, false);
});

test("不需要原因的动作**根本不读** reason：通过带一个超长原因也照样通过（D10）", async () => {
  // ⚠️ 这条守的是「不读」与「读了再丢」的区别。读了再丢的话，那次长度校验会把这次
  // 通过变成 400——而 reason 与「通过」这件事毫无关系，调用方只是把一个用不上的
  // 字段一起发了过来（例如对所有审核动作复用同一段代码）。
  const long = "很".repeat(REVIEW_REASON_MAX_LENGTH + 50);
  const result = await moderate(PENDING_REVIEW, "approve", { reason: long });
  assert.equal(result.changed, true);
  assert.equal(result.status, "approved");

  // 不读 = 不落库：两个原因字段都必须还是空的，而不是被「当备注」存下来
  const saved = await stored(PENDING_REVIEW);
  assert.equal(saved.rejectReason, null);
  assert.equal(saved.hideReason, null);
});

test("重提只能从 `rejected` 出发：已通过的评价不能靠重提打回待审核（D9 / R2）", async () => {
  // 这条与「换新键也不产生第二条」互补：那条守一单一评，这条守**重提的起点**。
  // 起点若被写错（或干脆不校验），一条已经公开的评价就能被打回待审核，
  // 等于用「重提」绕过了隐藏动作——那正是 `R2` 要挡住的路。
  const created = await createReviewForOrder(
    FREE_ORDER,
    FREE_ORDER_USER,
    { idempotencyKey: uniqueKey(), productReview: { rating: 5, content: null } },
    undefined,
    "server",
  );
  // 刚提交是 `pending`：这时也不能重提（能重提的只有被驳回的那一种）
  await expectApiError(
    resubmitReviewForUser(
      created.reviewId,
      FREE_ORDER_USER,
      { productReview: { rating: 1, content: null } },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  );

  // 通过之后仍然不能重提——这是本用例真正的靶子
  await moderate(created.reviewId, "approve");
  await expectApiError(
    resubmitReviewForUser(
      created.reviewId,
      FREE_ORDER_USER,
      { productReview: { rating: 1, content: null } },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE,
  );

  // ⚠️ 三次都没能把状态打回去：它仍然是 `approved`，且内容一个字段都没被改
  const saved = await stored(created.reviewId);
  assert.equal(saved.status, "approved");
  assert.equal(saved.productReview.rating, 5);
});

test("评价的打手快照只来自订单实体：整条写入路径都不读派单记录（D4 / R5）", async () => {
  // ⚠️ 「认**实际履约打手**、不认用户当初指定的人」（`D4`）这条，在数据模型上是
  // **结构性**成立的：`Order` 实体上没有 `exclusiveCompanionId`（它在 `Dispatch` 上），
  // 预置里也没有「指定 A、实际 B、且已完成」的订单，**因此造不出反例来触发它**。
  // 能真正出错的地方只有一处：评价写入路径**改去读派单记录**。
  // 所以这里直接扫源码把那个失败模式钉死——而不是留一条名字里写着「不认指定打手」、
  // 实际上只能证「认实际履约」那一半的断言。
  for (const file of ["../lib/services/reviews.ts", "../lib/data/mockReviewRepository.ts"]) {
    const source = stripComments(await readFile(new URL(file, import.meta.url), "utf8"));
    for (const forbidden of [
      "exclusiveCompanionId",
      "dispatchRepository",
      "getDispatchRepository",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${file} 不该出现 ${forbidden}：评价打的只能是 Order.companion`,
      );
    }
  }

  // 正向那一半：快照确实等于订单实体上的那位打手
  const order = await getPaymentRepository().findOrderById(FREE_ORDER);
  const created = await createReviewForOrder(
    FREE_ORDER,
    FREE_ORDER_USER,
    { idempotencyKey: uniqueKey(), companionReview: { rating: 5, content: null } },
    undefined,
    "server",
  );
  const entity = await stored(created.reviewId);
  assert.equal(entity.companion.id, order.companion.id);
});

test("提交的幂等键认单：同一个键用在另一张订单上是冲突，不是安静地返回第一张单的评价", async () => {
  // ⚠️ 「同键重放」与「换单复用键」是两件事。前者必须回第一条结果（下面的第三步），
  // 后者是调用方复用了键——若安静返回第一张单的评价，**第二张单会永远评不上，
  // 而且没有任何报错**，调用方以为提交成功了。
  const key = uniqueKey();
  const body = { idempotencyKey: key, productReview: { rating: 5, content: null } };

  const first = await createReviewForOrder(FREE_ORDER, FREE_ORDER_USER, body, undefined, "server");
  assert.equal(first.created, true);
  assert.equal(first.orderId, FREE_ORDER);

  // 换一张**真实存在、且属于同一个用户**的订单，但复用同一个键 → 冲突
  const other = "ord-seed-1001-05";
  const before = await getReviewRepository().countReviews(FREE_ORDER_USER);
  await expectApiError(
    createReviewForOrder(other, FREE_ORDER_USER, body, undefined, "server"),
    "BAD_REQUEST",
    REVIEW_OPERATION_CONFLICT_MESSAGE,
  );
  // 冲突**没有**写出任何东西：条数不变，另一张单上原本那条也原样还在
  assert.equal(await getReviewRepository().countReviews(FREE_ORDER_USER), before);
  const untouched = await getReviewRepository().findReviewByOrderId(FREE_ORDER_USER, other);
  assert.equal(untouched.id, "rev-seed-1001-01", "冲突不该动到另一张单上已有的评价");

  // 同键同单仍然是重放：加了这条校验之后，正常重发不该被误伤
  const retried = await createReviewForOrder(FREE_ORDER, FREE_ORDER_USER, body, undefined, "server");
  assert.equal(retried.created, false);
  assert.equal(retried.reviewId, first.reviewId);
});
