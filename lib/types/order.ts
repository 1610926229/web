/**
 * 订单类型与对外 DTO。
 *
 * 订单在**支付成功那一刻**生成，因此没有「待付款」状态；支付失败与取消只留下一条
 * 支付请求记录，不会出现在订单列表里。
 *
 * 商品名称、图片、规格名称、单价、游戏名与陪玩公开信息都是**下单那一刻的快照**：
 * 之后改价、换图、商品下架、陪玩改名，历史订单的展示与金额都不受影响。
 *
 * 金额一律是「分」为单位的整数，且**只由服务端计算写入**——客户端提交的任何金额字段都被忽略。
 *
 * ⚠️ 列表 DTO（`OrderListItem`）与详情 DTO（`OrderDetail`）是分开的两个类型，
 * 不是「详情少几个字段」的同一份：列表接口不应携带游戏 ID、备注、增值服务明细等
 * 只有详情页才需要的信息（见各自注释）。仓储返回的是完整 `Order`，转成 DTO 由
 * `lib/services/orders.ts` 负责。
 */

import type { OrderComplaintSummary } from "./complaint";
import type { ConversationStats } from "./message";
import type { RefundSummary } from "./refund";
import type { ReviewSummary } from "./review";
import type { AdminUserSummary } from "./user";

/**
 * 用户端订单状态。
 *
 * - `paid`      已付款（下单即此状态；此时允许还没有陪玩）
 * - `accepted`  已接单（必须有陪玩）
 * - `serving`   护航中（必须有陪玩）
 * - `completed` 已完成（必须有陪玩）
 * - `refunded`  已退款（保留完整商品与金额快照）
 *
 * 状态的推进由后续阶段（接单 / 分配 / 退款）完成，本阶段不提供任何修改状态的用户端接口。
 */
export type OrderStatus = "paid" | "accepted" | "serving" | "completed" | "refunded";

/** 增值服务快照：下单时的名称与价格，之后目录改名改价不影响历史订单。 */
export type OrderAddonSnapshot = {
  id: string;
  name: string;
  /** 单位：分 */
  price: number;
};

/** 陪玩公开信息快照。未绑定陪玩时整项为 null。 */
export type OrderCompanionSnapshot = {
  id: string;
  name: string;
  avatarUrl: string;
};

/**
 * 订单（仓储内部类型）。
 *
 * 页面与接口**不直接返回本类型**：对外一律使用下面的两个 DTO，
 * 避免「列表顺手把详情字段也带上」这类越权。
 */
export type Order = {
  id: string;
  /** 展示用订单号 */
  orderNo: string;
  userId: string;
  status: OrderStatus;
  createdAt: string;
  paidAt: string;

  // —— 状态时间节点：未发生时为 null，详情页只展示已存在的节点 ——
  acceptedAt: string | null;
  servingAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;

  // —— 下单内容快照 ——
  productId: string;
  productTitle: string;
  productCoverUrl: string;
  specId: string;
  specName: string;
  /** 单位：分 */
  unitPrice: number;

  quantity: number;
  /** 游戏名快照，与商品无关地独立保存 */
  gameName: string;
  region: string;
  gameAccountId: string;
  remark: string;
  addons: OrderAddonSnapshot[];

  // —— 下单内容金额（服务端计算，单位：分）——
  /** 单价 × 数量 */
  itemsAmount: number;
  /** 增值服务合计（按单计费，不随数量变化） */
  addonsAmount: number;
  /**
   * 商品金额 + 增值服务金额。**支付渠道实际收的钱**（退款也按它算）。
   *
   * ⚠️ 与金额域的 `originalAmount` 当前是同一个数（无券时渠道实收就等于优惠前应付），
   * 但两者的定义不同：这一个说的是「渠道收了多少钱」，那一个说的是「优惠前的应付总额」。
   * 优惠券接入（P1-6）会让它们分开——那时渠道实收会小于原价。
   */
  totalAmount: number;

  // —— 金额域（P0-3，服务端计算，单位：分）——
  // 这一组回答「这一单的钱怎么分、退过多少」，与上面三个（卖了什么、收了多少）分开表达。
  // 当前没有优惠券，因此 originalAmount === totalAmount、actualPaidAmount === originalAmount；
  // 券接入（P1-6）之后两者才会分开。
  /**
   * **用户这一单优惠前的原始应付总金额** = 商品金额 + 全部增值服务金额。
   *
   * ⚠️ 它**不表达「哪些钱参与分账」**——那是 `resolveCompanionRevenueBase()` 的事。
   * 当前两者数值相同（R3 已确认：由打手实际履约提供的增值服务参与分账），
   * 但这个等式是**规则的结果**，不是 `originalAmount` 的定义；
   * 将来出现平台自己履约的收费项时，它会进原价而不进分账基数。
   *
   * 下单那一刻算好并**存进订单**：读取时不得用今日的规则或今日的商品价格重算——
   * 商品改价不影响历史订单。
   */
  originalAmount: number;
  /** 优惠券抵扣金额。P0 恒为 0，P1 接入优惠券后才有非 0 值 */
  couponDiscountAmount: number;
  /** 用户实付 = originalAmount − couponDiscountAmount。**分账的起点** */
  actualPaidAmount: number;
  /** 分账比例快照（基点，8000 = 80%），下单时从商品冻结 */
  companionRateSnapshot: number;
  /** 护航收益 = floor(分账基数 × 比例 / 10000)。唯一的取整处 */
  companionBaseIncome: number;
  /** 平台净收入 = actualPaidAmount − companionBaseIncome。**允许为负**（券由平台承担时） */
  clubNetIncome: number;
  /** 累计已退。全额退款后等于 actualPaidAmount（P1 接入退款金额公式时维护） */
  refundedAmount: number;

  /**
   * 陪玩快照；未绑定时为 null。
   *
   * 「未绑定」只允许出现在 `paid`：已接单 / 护航中 / 已完成必须有陪玩，
   * 否则页面会显示成「等待接单」，与真实进度矛盾。
   */
  companionId: string | null;
  companion: OrderCompanionSnapshot | null;
};

/**
 * 订单列表项 DTO。
 *
 * **刻意不含**游戏 ID、备注、增值服务明细与单项金额：列表一次返回多条，
 * 这些字段只有详情页用得上，列表接口不应顺带返回。
 */
export type OrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  /** 下单（支付成功）时间，列表按它倒序 */
  paidAt: string;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  totalAmount: number;
  /** 未绑定时为 null，页面显示「等待接单」 */
  companion: OrderCompanionSnapshot | null;
};

/** 详情页的状态时间轴节点：只包含**已经发生**的节点。 */
export type OrderTimelineEntry = {
  key: OrderStatus;
  label: string;
  at: string;
};

/**
 * 订单详情页可以执行的动作。
 *
 * **由服务端给出**（见 `lib/services/orders.ts`），前端只负责按值显示或隐藏入口，
 * 不允许自己用订单状态推断——「能不能退款」既取决于订单状态，也取决于这一单有没有退款记录，
 * 前端只看状态一定会算错。写接口同样会再校验一次，按钮只是提示，不是权限。
 */
export type OrderAllowedActions = {
  canRequestRefund: boolean;
  canCancelRefund: boolean;
  canOpenConversation: boolean;
  canSubmitComplaint: boolean;
  /**
   * 能不能评价这一单。
   *
   * 与退款同理，**不是只看订单状态**：还要看这一单有没有评价、有没有进行中 / 已通过的退款
   * （见 `lib/constants/reviews.ts` 的 `canReviewOrder`）。前端只按这个值显示入口。
   */
  canReview: boolean;
};

/**
 * 订单详情 DTO：在列表项之上补齐详情页所需字段。
 *
 * 游戏 ID 属于用户订单信息，只在这里出现，且只返回给订单所属用户。
 *
 * 三个售后摘要都是**摘要**：只回答「有没有、到哪一步了」，原因说明、凭证、投诉描述、
 * 消息正文都不在这里——那些内容要进对应的详情页看。列表 DTO 更是一个都不带。
 */
export type OrderDetail = OrderListItem & {
  createdAt: string;
  gameName: string;
  region: string;
  gameAccountId: string;
  remark: string;
  /** 单位：分 */
  unitPrice: number;
  itemsAmount: number;
  addonsAmount: number;
  addons: OrderAddonSnapshot[];

  /**
   * 金额域（P0-3）：详情页用它显示「原价 / 实付 / 护航收益」三行。
   *
   * ⚠️ **不含 `clubNetIncome`**：平台净收入是平台自己的账，用户端没有任何展示位置，
   * 放进 DTO 只会让它顺着接口响应流到浏览器。管理端的订单详情另有 DTO。
   */
  originalAmount: number;
  couponDiscountAmount: number;
  actualPaidAmount: number;
  companionRateSnapshot: number;
  /** 护航收益：这一单分给打手的钱（用户可见，用于「护航收益 ¥40」这一行） */
  companionBaseIncome: number;
  refundedAmount: number;
  /** 已发生的状态节点，按时间先后排列 */
  timeline: OrderTimelineEntry[];

  /** 这一单的退款申请摘要；没有申请过为 null */
  refundSummary: RefundSummary | null;
  /** 这一单的投诉摘要；没有投诉过为 null */
  complaintSummary: OrderComplaintSummary | null;
  /** 这一单的订单沟通摘要；没有会话为 null */
  conversationSummary: ConversationStats | null;
  /** 这一单的评价摘要；没有评价过为 null */
  reviewSummary: ReviewSummary | null;
  allowedActions: OrderAllowedActions;
};

/* ───────────────────────── 管理端订单 DTO（P8C） ───────────────────────── */

/**
 * 管理端订单列表项。
 *
 * **刻意不含**游戏账号、备注、增值服务明细、退款原因与投诉正文：列表一次返回多条，
 * 这些内容只属于详情页。用户摘要只有三样（见 `AdminUserSummary`），
 * 没有任何微信身份、会话标识或仓储内部索引。
 *
 * `gameName` 进列表是刻意的：后台要按游戏筛单，而订单里的游戏是**下单那一刻的名称快照**
 * （见 `Order.gameName`），因此这个字段同时也是筛选依据（见 `lib/constants/adminOrders.ts`）。
 */
export type AdminOrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  statusLabel: string;
  /** 下单（支付成功）时间。后台列表按它倒序——后台要回答「这段时间进来了哪些单」 */
  createdAt: string;
  paidAt: string;
  gameName: string;
  productTitle: string;
  specName: string;
  quantity: number;
  /** 单位：分。订单实付金额快照 */
  totalAmount: number;
  user: AdminUserSummary;
};

/**
 * 管理端订单详情：在列表项之上补齐订单自身的明细与四份售后摘要。
 *
 * ⚠️ **本阶段订单详情是只读的**，因此这里**没有** `allowedActions` 字段，
 * 页面上也没有任何改状态、改金额、改商品或改用户的按钮。这不是「还没做」，
 * 是刻意留白：订单的推进属于后续阶段（分配 / 改派护航），本阶段唯一会动订单的
 * 写入是「退款审核通过」，而那条路径的主语是退款申请，不是订单。
 *
 * 游戏 ID 与备注属于用户订单信息，只在这里出现——管理端要能看到用户填错的大区/账号，
 * 才能回答「这一单为什么打不了」。它们**不进任何列表 DTO**。
 */
export type AdminOrderDetail = AdminOrderListItem & {
  region: string;
  gameAccountId: string;
  remark: string;
  productCoverUrl: string;
  /** 单位：分。单价 × 数量 = itemsAmount */
  unitPrice: number;
  itemsAmount: number;
  addonsAmount: number;
  addons: OrderAddonSnapshot[];
  /** 已发生的状态节点，按时间先后排列 */
  timeline: OrderTimelineEntry[];
  companion: OrderCompanionSnapshot | null;

  /** 这一单的退款申请摘要；没有申请过为 null。完整内容要去退款详情看 */
  refundSummary: RefundSummary | null;
  /** 这一单的投诉摘要；没有投诉过为 null。完整内容要去投诉详情看 */
  complaintSummary: OrderComplaintSummary | null;
  conversationSummary: ConversationStats | null;
  reviewSummary: ReviewSummary | null;
};

/**
 * 管理端订单列表接口一次返回的全部数据。
 *
 * `games` 是**游戏筛选项**，而且取自订单数据里出现过的游戏名快照，不是当前的商品目录：
 * 目录里新增了一个游戏、但一单都还没有时，把它放进筛选栏只会得到一次必然为空的查询；
 * 反过来，某个游戏被下架了，历史订单仍然要能按它筛出来。
 */
export type AdminOrderListData = {
  items: AdminOrderListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** 订单里出现过的游戏名，已去重并排序 */
  games: string[];
  notice: string;
};
