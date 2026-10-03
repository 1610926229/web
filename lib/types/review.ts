/**
 * 订单评价的类型与对外 DTO（P1-8 闭环）。
 *
 * ## 一句话
 *
 * **一张订单只有一个逻辑 `OrderReview`**（`R1`）。它内部最多包含两个**评价维度**：
 * 商品维度与打手维度。用户一次提交可以只评其中一个、也可以两个都评（`D3`），
 * 但**永远不存在「同一单的第二条评价」**。
 *
 * ## 双维度为什么不是两条记录
 *
 * 产品目标把「本单商品」与「本单实际服务打手」并列为评价对象（`D1`），
 * 但「一次订单最多评价一次」是对**一次提交动作**说的。把它做成两条记录，
 * 「一单一评」的唯一键含义立刻变模糊（是用户+订单，还是用户+订单+对象？），
 * 且会出现「评了商品没评打手」这种半截状态需要额外的状态位去表达——
 * 而 D3 明确说：没评的那个维度就是 `null`，不需要另一个状态位。
 *
 * ## 快照与身份分开（`R4`）
 *
 * `productId` / `specId` / `companion.id` 是**聚合身份**，决定这条评价计入谁的平均分；
 * `productTitle` / `productCoverUrl` / `specName` / `companion.name` 是**历史展示事实**，
 * 商品改名、打手换头像都不能改写已经发生过的评价。**二者不能互相替代**：
 * 只有身份则历史会跟着改名漂移，只有快照则永远聚合不出真实评分。
 *
 * ## 审核是公开闸，不是数据删除（`R2`）
 *
 * 评价一旦提交就真实存在。`status` 只决定「公开面能不能看到它」，
 * 任何状态迁移都**不删除**记录——`rejected` 也保留着，用户在原记录上改完重提。
 */

import type { PageResult } from "./common";
import type { SupportEvidence } from "./evidence";
import type { OrderCompanionSnapshot, OrderStatus } from "./order";
import type { AdminUserSummary } from "./user";

/** 星级：1–5，只允许这五个整数。 */
export type ReviewRating = 1 | 2 | 3 | 4 | 5;

/** 时间筛选。`all` 表示不限时间。 */
export type ReviewRange = "all" | "month" | "threeMonths" | "halfYear" | "year";

/** 两个 Tab：已评价的记录 / 待评价的已完成订单。 */
export type ReviewTabKey = "reviewed" | "pending";

/**
 * 审核状态（`D7`）。
 *
 * ```
 * pending → approved
 * pending → rejected
 * approved → hidden
 * hidden → approved
 * rejected → pending     ← 只能由用户「重新提交」触发（D9）
 * ```
 *
 * ⚠️ **不得**用 `Order.status` 或其它领域状态代替它：订单的状态回答「这笔交易走到哪了」，
 * 评价的状态回答「这条内容能不能被公开看到」，两者没有一一对应关系——
 * 例如「订单已全额退款（`status = refunded`）」与「评价已公开」可以同时成立（`D20`）。
 */
export type ReviewStatus = "pending" | "approved" | "rejected" | "hidden";

/** 评价维度的标识。商品 / 打手在数据模型里是**对称**的两侧（`D2`）。 */
export type ReviewDimensionKey = "product" | "companion";

/**
 * 一个评价维度。
 *
 * 「星级必填、文字可选」（`D3`）：`content` 允许为 `null`，
 * 而 `rating` 只要这个维度存在就一定有值——**没有「打了字却没给星」这种维度**。
 */
export type ReviewDimension = {
  rating: ReviewRating;
  content: string | null;
};

/**
 * 评价（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律使用下面的 DTO，
 * `userId` 与订单快照之外的字段不会顺带泄漏出去。
 */
export type OrderReview = {
  id: string;
  /** ⚠️ 内部字段：任何对外 DTO 都不带它（`D13` 禁止公开用户标识） */
  userId: string;
  orderId: string;
  orderNo: string;

  // —— 聚合身份（R4）——
  /** 商品 id：决定这条评价计入哪件商品的平均分 */
  productId: string;
  /** 规格 id：与商品 id 一起构成「这一单买的是什么」的稳定身份 */
  specId: string;

  // —— 双维度（D2 / D3）——
  /** 商品维度；用户没评商品时为 `null` */
  productReview: ReviewDimension | null;
  /** 打手维度；用户没评打手、或这一单没有实际履约打手时为 `null` */
  companionReview: ReviewDimension | null;

  /** Mock 凭证：地址由服务端写成本地占位图。两个维度共用一组（一次消费一次举证） */
  evidence: SupportEvidence[];

  // —— 审核（D7 / R2）——
  status: ReviewStatus;
  /** 驳回原因，只有 `rejected` 时非空（`D10` 要求必填） */
  rejectReason: string | null;
  /** 隐藏原因，只有 `hidden` 时非空（`D10` 要求必填）；作者可见（`D8`） */
  hideReason: string | null;
  /** 最后一次审核动作的执行者；从未被审核过时为 `null` */
  reviewedBy: string | null;
  reviewedByName: string | null;
  /** 最后一次审核动作的时刻 */
  reviewedAt: string | null;

  /** **首次**提交时间。作者侧列表按它排序，页面上也叫「评价时间」 */
  createdAt: string;
  /**
   * 最近一次**内容变更**的时间（提交 / 重新提交）。
   *
   * 与 `createdAt` 分开是因为「这条评价是什么时候写的」与「用户最后一次改它是什么时候」
   * 是两个都会被追问的问题；`rejected` 后重提会让它前进，而 `createdAt` 不动。
   */
  updatedAt: string;

  // —— 订单快照：提交评价那一刻从订单抄下来 ——
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  /** 订单完成时间快照 */
  completedAt: string;
  /**
   * **实际履约打手**的快照（`Order.actualCompanionId` 的那一位，`D4`）。
   *
   * ⚠️ **不是** `Order.exclusiveCompanionId`——那是「用户当初指定了谁」，
   * 换人之后仍然留着，拿它当评价对象就会变成「评价一个根本没服务过的人」。
   * 下单时未绑定时为 `null`（页面上明确写「未绑定」）。
   */
  companion: OrderCompanionSnapshot | null;
};

/**
 * 已评价记录 DTO（**作者本人**视角，`D8`）。
 *
 * 作者看得见自己的**全部状态**，包括 `pending` / `rejected` / `hidden`，
 * 因此这里带上 `status` 与审核给出的原因。
 * ⚠️ 仍然**不带** `userId`：作者不需要，别人更不需要。
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

  productReview: ReviewDimension | null;
  companionReview: ReviewDimension | null;
  evidence: SupportEvidence[];

  status: ReviewStatus;
  /** 状态的中文说法，由服务端给出，前端不自己拼 */
  statusLabel: string;
  rejectReason: string | null;
  hideReason: string | null;

  /** 评价时间（首次提交） */
  createdAt: string;
  updatedAt: string;
  /** 只有 `rejected` 时为真：作者获得一次「重新提交」入口（`D9`） */
  canResubmit: boolean;
};

/**
 * 待评价订单 DTO：**已经完成、且这一单还没有评价记录**的订单。
 *
 * `allowedActions` 是**服务端给出的权限**：前端只按它显示「评价服务」入口或不可评价的原因，
 * 不自己用订单状态推断——「能不能评价」取决于**这一单有没有完成过服务**（`completedAt`），
 * 而不是订单当前状态：全额退款的订单状态是 `refunded`，但它**照样可以评价**（`D19`）。
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
  /** 已评价记录数（**含全部状态**，作者自己的历史一条都不隐藏） */
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

/** 提交 / 重新提交评价的结果。重复提交返回第一次的结果，`created` 为 false。 */
export type ReviewCreateResult = {
  reviewId: string;
  orderId: string;
  /** 这次调用**真的写下了内容**（新建或重新提交）？重放与重复提交都是 false */
  created: boolean;
  status: ReviewStatus;
};

/**
 * 订单详情里的评价摘要。
 *
 * ⚠️ 这里**不带星级**：一条评价最多有两个星级（商品 / 打手），
 * 挑一个显示等于在订单详情上偷偷决定「哪个星级更代表这次消费」——
 * 那是评价页要回答的问题。订单详情只需要回答「评价这件事走到哪一步了」。
 */
export type ReviewSummary = {
  id: string;
  status: ReviewStatus;
  statusLabel: string;
  createdAt: string;
  /** 只有 `rejected` 时为真：订单详情上给「重新提交」入口（`D9` / `D14`） */
  canResubmit: boolean;
};

/**
 * 评价表单页读到的东西。
 *
 * 五种状态互斥且完整，页面据此显示表单或说明——**判定只在服务端做一次**，
 * 前端不拿订单状态自己推断。
 *
 * `rejected` 单独一态而不是并进 `reviewed`：它是**唯一**允许用户回到表单的状态（`D9`），
 * 页面据此预填上次的内容并改成「重新提交」的说法。
 */
export type ReviewTarget =
  | { status: "ready"; order: ReviewPendingItem }
  | { status: "reviewed"; review: ReviewListItem }
  | { status: "rejected"; review: ReviewListItem }
  | { status: "blocked"; reason: string; orderStatus: OrderStatus }
  | { status: "missing" };

/* ───────────────────── 管理端（P1-8）───────────────────── */

/**
 * 管理端评价列表项。
 *
 * 与用户侧的 `ReviewListItem` 有三处刻意的不同：
 *
 * | | 用户侧 | 管理端 |
 * |---|---|---|
 * | 作者 | **不出现** | `user`：管理员要能回答「这是谁写的」 |
 * | 审核人 | 不出现 | `reviewedBy` / `reviewedByName` / `reviewedAt`：审核是可回查的 |
 * | 可执行动作 | `canResubmit` | `allowedActions`：四个审核动作各自的可用性 |
 *
 * ⚠️ **两个维度都在**（`D2`）：管理员必须同时看到商品侧与打手侧才能判断「这条到底该不该公开」。
 * 只给一个维度会让他看不见用户实际写的另一半。
 *
 * ⚠️ 这里的 `user` 是 `AdminUserSummary`（与订单 / 退款 / 投诉三张后台列表**同一套**），
 * 不是公开面的脱敏昵称（`D13`）：`D13` 管的是**公开面**
 * （商品详情 / 打手详情上那条任何人都能看到的列表），而后台是审核面——
 * 管理员看不见作者是谁就没有办法核实「这条评价是不是刷的」。
 * 两者不是「一个更宽松、一个更严格」，而是**两个不同的用途**，
 * 因此用的是两套字段，而不是给公开面加个开关。
 */
export type AdminReviewListItem = {
  id: string;
  orderId: string;
  orderNo: string;
  /** 作者。字段表照抄其它后台列表的 `AdminUserSummary` */
  user: AdminUserSummary;

  productId: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  companion: OrderCompanionSnapshot | null;
  completedAt: string;

  productReview: ReviewDimension | null;
  companionReview: ReviewDimension | null;
  evidence: SupportEvidence[];

  status: ReviewStatus;
  /** 状态的中文说法，由服务端给出 */
  statusLabel: string;
  rejectReason: string | null;
  hideReason: string | null;

  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;

  createdAt: string;
  updatedAt: string;

  /** 服务端判定的可执行动作。**前端不自己按状态推断**（`D21`：权限在服务端） */
  allowedActions: AdminReviewAllowedActions;
};

/**
 * 四个审核动作各自的可用性。
 *
 * ⚠️ 与状态机同源（`REVIEW_STATUS_TRANSITIONS`），不是把状态名重复一遍：
 * `approve` 可用的条件就是「`canTransitionReviewStatus(status, "approved")`」。
 * 页面据此决定按钮的禁用态，**但真正的拦截在服务端**——
 * 这个字段只是让界面不要显示一个必然失败的按钮（`D21`）。
 */
export type AdminReviewAllowedActions = {
  canApprove: boolean;
  canReject: boolean;
  canHide: boolean;
  canUnhide: boolean;
};

/** 管理端评价详情。本阶段与列表项同形：审核需要的字段列表里已经全有了。 */
export type AdminReviewDetail = AdminReviewListItem;

/**
 * 管理端评价列表页一次取回的全部数据（一页评价 + 状态角标）。
 *
 * 与其它后台列表一致：**不在接口层做「先取一页再过滤」**——
 * 筛选与分页都发生在仓储里，`total` 才是筛选后的总数。
 */
export type AdminReviewListData = {
  items: AdminReviewListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** 状态角标：每个状态各多少条（不受分页影响） */
  counts: Record<ReviewStatus, number>;
  /** 页面顶部的说明文案（审核口径），由服务端给出，前后台不各写一份 */
  notice: string;
};

/**
 * 审核动作的返回：**只有状态字段**。
 *
 * 界面据此就地更新那一行（改状态、显示原因），不需要为了刷新一条评价重新拉一整页。
 * `changed` 用来区分「真的改了」与「本来就是目标状态 / 重放」——
 * 两者都是成功（`200`），但文案不同（「已通过」vs「该评价已是已通过状态」）。
 */
export type AdminReviewWriteResult = {
  reviewId: string;
  status: ReviewStatus;
  statusLabel: string;
  /** 本次调用是否真的改变了状态 */
  changed: boolean;
};

/* ───────────────────── 公开面（D6 / D13 / R3）───────────────────── */

/**
 * 公开评价条目 —— 商品详情与打手详情**共用同一个形状**（`R3`）。
 *
 * 只有四项：谁写的（**脱敏昵称**）、几星、写了什么、什么时候写的。
 * `userId` / 订单号 / 订单 id / 凭证 / 审核备注**一律不在**——
 * 公开面要能回答「这件商品好不好」，不需要也不应该暴露「是谁、哪一单」。
 */
export type PublicReviewItem = {
  id: string;
  /** 脱敏后的用户昵称（`D13`）。脱敏规则全仓只有一份 */
  nickname: string;
  rating: ReviewRating;
  content: string | null;
  createdAt: string;
};

/**
 * 一个对象的公开评分聚合（`D14` / `D15` / `R3`）。
 *
 * ⚠️ **`reviewCount` 数的是「该对象实际拥有的 approved 评价维度数量」，不是评价条数**：
 * 一条只评了商品的评价 ⇒ 商品侧 +1、打手侧 +0（`D15`）。
 * 因此这个值**必须**由按维度切分后的聚合产生，不能拿 `OrderReview` 的总条数顶上。
 */
export type ReviewAggregate = {
  /** 平均分，保留 1 位小数；没有任何 approved 评价时为 `null`（页面显示「暂无评分」） */
  averageRating: number | null;
  /** approved 的评价维度数量 */
  reviewCount: number;
  /** 最近若干条 approved 评价（`D15`：最多 3 条） */
  reviews: PublicReviewItem[];
  /** 是否还有更多（本阶段不提供完整列表页，`D16`；页面据此显示「仅显示最近 N 条」） */
  reviewsTruncated: boolean;
};

/**
 * 空聚合（没有 `approved` 评价时的唯一答案）定义在 `lib/constants/reviews.ts`
 * 的 `EMPTY_REVIEW_AGGREGATE`：本文件是**类型**文件，不放运行时常量，
 * 否则「哪里是规则、哪里是形状」就分不清了。
 */
