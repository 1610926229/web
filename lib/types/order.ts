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

import type { CompanionReleaseRecord } from "./companionRelease";
import type { OrderComplaintSummary } from "./complaint";
import type { ConversationStats } from "./message";
import type { RefundSummary } from "./refund";
import type { ReviewSummary } from "./review";
import type { AdminUserSummary } from "./user";

/**
 * 用户端订单状态。
 *
 * - `paid`      已付款（下单即此状态；此时允许还没有打手）
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
   * **实际接到这单**的打手 id；还没有人接时为 null（P0-5 改名，原名 `companionId`）。
   *
   * ⚠️ 它回答的是「**谁在履约**」，不是「用户想要谁」。两件事现在是两个字段：
   *
   * | 问题 | 字段 | 写入时机 |
   * |---|---|---|
   * | 用户**指定**过谁 | `Dispatch.exclusiveCompanionId` | 下单那一刻（结算页选的人） |
   * | 实际**接到**的是谁 | 本字段 | 接单那一刻 |
   *
   * 一条真实路径：用户指定 A → A 十分钟内没接 → 自动进公共池 → B 接单。
   * 此时 `Dispatch.exclusiveCompanionId` 是 A、本字段是 B，两个事实都留得住。
   *
   * 旧名字同时表达这两件事，是 P0-5 之前「下单即绑定」那套模型的遗留：那时
   * 「选的人」与「接的人」必然是同一个。现在它们可以是两个人，一个字段就再也
   * 表达不了——这也正是改名的理由。
   *
   * ⚠️ 它**只由接单事务写**（`lib/data/companionDispatchTransaction.ts`），
   * 而且与 `Dispatch.acceptedByCompanionId` 在同一段无 `await` 的代码里一起写：
   * 两处永远一致，结构上不可能只写一边。
   *
   * 「还没有人接」只允许出现在 `paid`：已接单 / 护航中 / 已完成必须有打手，
   * 否则页面会显示成「等待接单」，与真实进度矛盾。
   */
  actualCompanionId: string | null;
  /** 实际接单打手的公开信息快照；还没有人接时为 null */
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

/**
 * 派单进度摘要（P0-5）：这一单现在在哪个池子里等人接、等到什么时候。
 *
 * ⚠️ 只有**还在等人接**的订单有这一项（`paid` 且未被人接走），其余为 null：
 * 已接单 / 已退款时订单自己的状态已经说明了一切，再显示一行池子进度只会和状态栏打架。
 *
 * ⚠️ 这里**不说「用户当初指定了谁」**。那是用户自己做的选择，但把他人的昵称与头像
 * 搬进订单详情属于另一件事（谁有权看到某位护航的资料），本批次不做。
 * 「指定」与「实际」两个事实的对照在**管理端**订单详情上（见 `AdminOrderDetail`）。
 */
export type OrderDispatchProgress = {
  /** 当前所在的池 */
  pool: "exclusive" | "public";
  /** 池子的显示名（文案集中在 `lib/constants/dispatch.ts`） */
  poolLabel: string;
  /** 当前池子的截止时间 */
  deadlineAt: string;
  /**
   * 服务端算好的剩余秒数。**只用于显示**，不参与任何判定——
   * 能不能接、要不要退款一律由服务端的 `deadline <= now` 决定，
   * 客户端算出来的时间不可信。
   */
  remainingSeconds: number;
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

  /**
   * 派单进度：还在等人接时给出当前池与截止时间，其余为 null（P0-5）。
   *
   * 它回答的是「我的单现在在哪等人接」，与「等的是谁」是两件事：
   * 用户当初指定的人记在派单上，被谁接走则体现在 `companion` 与订单状态里。
   */
  dispatchProgress: OrderDispatchProgress | null;

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

/* ───────────────────────── 打手端订单 DTO（P0-6） ───────────────────────── */

/**
 * 打手「我的订单」列表项。
 *
 * ## 归属只按 `actualCompanionId`
 *
 * 列表与服务端详情的归属判定都是**同一件事**：
 * `Order.actualCompanionId === 当前 companionId`。
 * `exclusiveCompanionId === 当前 companionId` **绝不等于**订单归本人——
 * 那是「用户当初选了谁」的历史事实，与「现在谁在履约」是两个字段
 * （见 `Order.actualCompanionId` 与 `Dispatch.exclusiveCompanionId`）。
 *
 * ## 刻意不含的东西
 *
 * ⚠️ **平台金额域一个都没有**：`clubNetIncome` / `companionBaseIncome` /
 * `companionRateSnapshot` / `refundedAmount` 全部不在本 DTO 上。
 * 打手要完成这一单所需的信息里没有一分钱是必须的，而「护航收益」属于收益域、
 * 「平台净收入」属于平台自己的账——把它们带进打手端响应，只是让内部账目
 * 顺着接口流到浏览器。
 *
 * ⚠️ **也不含**：`userId`（下单人是另一个人，给 id 没有用途）、
 * 管理员备注（内部信息）、售后 / 投诉 / 退款摘要（那属于用户与客服的页面）、
 * `exclusiveCompanionId`（那是用户的选择，服务端据此收窄归属，
 * 但「用户当初想要谁」不该反过来告诉接单的人），以及任何内部审计记录。
 *
 * ⚠️ 本类型与其它的订单 DTO 一样是**显式挑字段**的：给 `Order` 新增字段
 * 不会自动出现在打手端响应里。
 */
export type CompanionOrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  /** 状态中文名（`ORDER_STATUS_LABELS`）。服务端给，页面不自己维护一份文案 */
  statusLabel: string;
  /** 下单（支付成功）时间 */
  paidAt: string;
  /** 接单时间；本列表里都是他接过的单，因此正常有值，历史数据缺失时为 null */
  acceptedAt: string | null;
  productTitle: string;
  productCoverUrl: string;
  specName: string;
  quantity: number;
  gameName: string;
  region: string;
  /**
   * 此刻能不能主动取消接单。
   *
   * ⚠️ **由服务端算好**（就是 `status === "accepted"`）：前端不得自己用状态推断。
   * 状态与规则各写一份，分叉的那一天页面上会出现一个点下去必然失败的按钮。
   * 这里只是**诚实性**提示，真正的保护在 `cancelAcceptedOrder` 的原子区段里。
   */
  canCancel: boolean;
};

/**
 * 打手订单详情：在列表项之上补齐履约必需的字段。
 *
 * ⚠️ `gameAccountId` 与 `remark` **只在这里出现**（与公共池 DTO 刻意相反）：
 * 接单**之前**打手没有任何理由看到别人的游戏账号；接单**之后**他要照账号进游戏
 * 才能完成这一单，不给就等于让他做不了活。这条界线是「履约所需」，
 * 不是「打手能看的都给他」——因此详情里仍然没有联系方式、平台展示 ID、头像、
 * 金额域与售后摘要。
 *
 * ⚠️ `Order` 上**没有**「服务要求」这个字段：需求里提到过它，但它从未落到订单模型上
 * （用户提交的就是 `remark`）。这里不为了凑一个字段名去虚构它——
 * 那会让页面读到一个永远为空的字段，而真正有内容的 `remark` 反而没人看。
 */
export type CompanionOrderDetail = CompanionOrderListItem & {
  gameAccountId: string;
  remark: string;
  addons: OrderAddonSnapshot[];
  /** 增值服务合计（分） */
  addonsAmount: number;
  /** 单价（分） */
  unitPrice: number;
  /** 单价 × 数量（分） */
  itemsAmount: number;
  /** 商品 + 增值服务合计（分）。**不含**平台分账信息 */
  totalAmount: number;
  /**
   * 下单用户的**必要**信息：只够在页面上称呼对方。
   *
   * ⚠️ 刻意**只有昵称**：没有联系方式、没有 `displayId`、没有头像。
   * 打手与用户的联系发生在聊天里（后续批次），不需要靠订单详情带出身份信息。
   * 用户记录查不到时给空串，而不是让整页报错——订单本身是有效的。
   */
  customerNickname: string;
};

/** 打手「我的订单」一次要显示的全部内容。 */
export type CompanionOrderListData = {
  items: CompanionOrderListItem[];
};

/**
 * 主动取消接单的结果（事务层）。
 *
 * 失败情形**逐个分开**，与 `DispatchAcceptResult` 同一取舍：它们对打手要说的话
 * 不一样，页面上的处置也不一样。
 *
 * | 结果 | 含义 | 接口 |
 * |---|---|---|
 * | `ok` | 本次真的取消了 | 200 |
 * | `replayed` | 同一个幂等键第二次到达（连点两次、网络重试） | 200，`changed: false` |
 * | `not-found` | 订单不存在，**或**不是本人实际履约 | 404（不泄露存在性） |
 * | `not-accepted` | 是本人的单，但状态已不是 `accepted` | 400 |
 *
 * ⚠️ 两种失败**必须用不同的状态码**：`not-found` 是「这一单与你无关」，
 * 而 `not-accepted` 是「你点了一个此刻不该存在的按钮」——后者不是重放，
 * 也不能按幂等成功处理（见 D5）。
 *
 * ⚠️ 两个成功分支的 `status` 都是**字面量** `"paid"`，含义是
 * **「这次取消把订单置成了什么状态」**——即本次操作的结果，而**不是**「订单此刻的状态」。
 * 它会一直是 `"paid"`，因为在同一条原子区段里订单刚被写成 `paid`。
 *
 * 这解释了一个看似反直觉的场景：打手 A 用键 K 取消成功 → 订单回到 `paid` →
 * 打手 B 接走（订单变 `accepted`）→ A 用**同一个键 K** 重放，接口仍然回答 `status: "paid"`。
 * 这不是 bug：**重放必须返回与第一次完全相同的响应**（`api-contract.md` §2.8），
 * 去读实时状态反而会让同一个请求在两次到达时给出不同答案，那才是幂等被破坏。
 * 所以消费方**不要**把这个字段当作订单现状，要看现状请查详情接口。
 *
 * 唯一例外是 `not-accepted`：它带的是**当前**状态 `OrderStatus`，因为那正是
 * 「你点了一个此刻不该存在的按钮」这句话要回答的东西。
 */
export type CompanionCancelOutcome =
  | {
      kind: "ok";
      orderId: string;
      orderNo: string;
      status: "paid";
      /** 本次写入的退出历史 id */
      releaseRecordId: string;
      cancelledAt: string;
      changed: true;
    }
  | {
      kind: "replayed";
      orderId: string;
      orderNo: string;
      status: "paid";
      /** **第一次**写入的那条退出历史 id（重放不产生第二条） */
      releaseRecordId: string;
      /** **第一次**取消的时刻（重放不刷新它） */
      cancelledAt: string;
      changed: false;
    }
  | { kind: "not-found" }
  | { kind: "not-accepted"; status: OrderStatus };

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

  /**
   * 用户**指定**的护航；没指定为 null（P0-5，原字段名 `companion`）。
   *
   * 来自派单的 `exclusiveCompanionId`，**不是**订单上的字段：订单只记得「谁在履约」。
   * 它与实际接单的人可以**同时有值且不相同**——用户指定 A、A 十分钟没接、
   * B 从公共池接走，这一单在后台就该显示成「指定：A / 实际：B」。
   * 只给一个字段的话，「用户要的人没接」这件事在后台完全不可见，
   * 客服也就回答不了「我明明指定了 A，怎么是 B 在打」。
   */
  exclusiveCompanion: OrderCompanionSnapshot | null;
  /** **实际接到**这一单的护航；还没有人接为 null（来自 `Order.companion`） */
  actualCompanion: OrderCompanionSnapshot | null;

  /**
   * 这一单的最小履约退出历史（打手主动取消等）；**从没有人退出过为空数组**（P0-6）。
   *
   * 退出之后订单上的 `actualCompanionId` / `companion` 已经清空（订单要能重新进公共池），
   * 「谁曾经接过、为什么退出、何时退出」因此不再有任何现成字段回答得了——
   * 而客服恰恰要回答「我明明看到有人接过，怎么又回到等待接单了」。
   *
   * ⚠️ 空数组而不是 `null`：没有退出过是**正常情况**，不是「查不到」。
   * 用 `null` 会让页面多出一条「要不要显示这个区块」的空值分支。
   *
   * ⚠️ 本 DTO 是给管理端订单详情用的。退出历史**也出现在三个客服 DTO 上**
   * （`StaffOrderSummary` / `StaffComplaintOrderSummary` / `StaffRefundDetail`），
   * 因为管理端与客服工作台是**两套账号**——`canEnterAdminConsole(role)` 只对 `admin`
   * 为真，`customer_service` 进不了 `/admin`（`lib/constants/admin.ts`）。
   * 两边各自渲染，**不是**「进同一个后台」。
   *
   * ⚠️ 但用户端订单详情、打手端订单 DTO、公共池 DTO **都不带它**：
   * 普通打手与下单用户没有理由看到「上一位打手为什么走」。
   */
  releaseHistory: CompanionReleaseRecord[];

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
