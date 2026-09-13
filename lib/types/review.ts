/**
 * 订单评价的类型与对外 DTO。
 *
 * 评价在**订单已完成之后**由用户本人提交，一单一评（业务唯一键是「用户 + 订单」）。
 * 评分与正文由用户填写，其余字段（订单号、商品快照、打手快照、完成时间、评价时间）
 * 都由服务端在提交那一刻从订单上抄一份存下来：
 *
 * - **抄一份，而不是每次查评价时再去联表读订单**：订单将来改名、改商品、打手改名换头像，
 *   历史评价的展示都不应该跟着变（与订单自己的快照口径一致）；
 * - **`userId` 只在仓储实体里**：`OrderReview` 带 `userId`，对外 DTO 一律不带，
 *   接口也不可能返回「别人的评价」。
 *
 * 金额与等级体系不在这里：评价不影响订单金额，也不参与消费等级计算。
 */

import type { PageResult } from "./common";
import type { SupportEvidence } from "./evidence";
import type { OrderCompanionSnapshot, OrderStatus } from "./order";

/** 星级：1–5，只允许这五个整数。 */
export type ReviewRating = 1 | 2 | 3 | 4 | 5;

/** 时间筛选。`all` 表示不限时间。 */
export type ReviewRange = "all" | "month" | "threeMonths" | "halfYear" | "year";

/** 两个 Tab：已评价的记录 / 待评价的已完成订单。 */
export type ReviewTabKey = "reviewed" | "pending";

/**
 * 评价（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律使用下面的 DTO，
 * `userId` 与订单快照之外的字段不会顺带泄漏出去。
 */
export type OrderReview = {
  id: string;
  userId: string;
  orderId: string;
  orderNo: string;

  rating: ReviewRating;
  /** 已去首尾空格，长度由服务端按字符数校验 */
  content: string;
  /** Mock 凭证：地址由服务端写成本地占位图 */
  evidence: SupportEvidence[];
  /** 评价时间，由服务端写 */
  createdAt: string;

  // —— 订单快照：提交评价那一刻从订单抄下来 ——
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  /** 订单完成时间快照 */
  completedAt: string;
  /** 打手快照；下单时未绑定时为 null（页面上明确写「未绑定」） */
  companion: OrderCompanionSnapshot | null;
};

/**
 * 已评价记录 DTO。
 *
 * **刻意不含**游戏 ID、订单备注、退款与投诉摘要：这些属于订单，不属于评价。
 * `companion` 为 null 时页面必须显示「未绑定」而不是留空。
 */
export type ReviewListItem = {
  id: string;
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  companion: OrderCompanionSnapshot | null;
  /** 订单完成时间 */
  completedAt: string;
  rating: ReviewRating;
  content: string;
  evidence: SupportEvidence[];
  /** 评价时间 */
  createdAt: string;
};

/**
 * 待评价订单 DTO：已完成、且这一单还没有评价记录的订单。
 *
 * `allowedActions` 是**服务端给出的权限**：前端只按它显示「评价服务」入口或不可评价的原因，
 * 不自己用订单状态推断——「能不能评价」既看订单状态，也看这一单有没有评价、有没有退款，
 * 前端只看状态一定会算错。
 */
export type ReviewPendingItem = {
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  companion: OrderCompanionSnapshot | null;
  completedAt: string;
  allowedActions: ReviewAllowedActions;
};

export type ReviewAllowedActions = {
  canReview: boolean;
  /** 不能评价时的原因；可以评价时为空串 */
  reason: string;
};

/** 两个 Tab 的数量，随每一页一起返回，前端不自己累加。 */
export type ReviewTabCounts = {
  /** 已评价记录数 */
  reviewed: number;
  /** 待评价的已完成订单数 */
  pending: number;
};

/** 分页结果 + Tab 标识 + 两个角标。 */
export type ReviewPage<T> = PageResult<T> & {
  tab: ReviewTabKey;
  counts: ReviewTabCounts;
};

export type ReviewedReviewPage = ReviewPage<ReviewListItem> & { tab: "reviewed" };
export type PendingReviewPage = ReviewPage<ReviewPendingItem> & { tab: "pending" };

/** 评价列表接口的返回：哪个 Tab 对应哪一份数据。 */
export type ReviewListPage = ReviewedReviewPage | PendingReviewPage;

/** 提交评价的结果。重复提交返回第一次的结果，`created` 为 false。 */
export type ReviewCreateResult = {
  reviewId: string;
  orderId: string;
  created: boolean;
};

/**
 * 订单详情里的评价摘要：只回答「评价过没有、几星、什么时候」，
 * 正文与凭证要去我的评价页看（与退款 / 投诉摘要同一原则）。
 */
export type ReviewSummary = {
  id: string;
  rating: ReviewRating;
  createdAt: string;
};

/**
 * 评价表单页读到的东西。
 *
 * 四种状态互斥且完整，页面据此显示表单或说明——**判定只在服务端做一次**，
 * 前端不拿订单状态自己推断（「能不能评价」还取决于有没有评价、有没有退款）。
 */
export type ReviewTarget =
  | { status: "ready"; order: ReviewPendingItem }
  | { status: "reviewed"; review: ReviewListItem }
  | { status: "blocked"; reason: string; orderStatus: OrderStatus }
  | { status: "missing" };
