import type { OrderCompanionSnapshot, OrderStatus } from "./order";
import type { AdminUserSummary } from "./user";

/**
 * 管理端「售后工作台」的 DTO（P1-3）。
 *
 * ## 这里**没有新的领域状态**
 *
 * 工作台把**退款申请**与**投诉**放进同一张待办队列，于是本文件只有
 * 「一行案件属于哪一类 / 属于哪个视图」两个新枚举，以及一个跨领域的行 DTO。
 * 案件自己的状态仍然是 `RefundStatus` / `ComplaintStatus`——原因见
 * `lib/constants/adminAftersales.ts`：`open` / `processing` / `closed` 是
 * **视图分组**，不是写进存储的状态，两个方向都由那一组常量派生。
 *
 * ## 为什么是「一行」而不是「一条退款或一条投诉」
 *
 * 两个领域的记录形状相差很远（退款有金额与决策，投诉只有一段文字），
 * 合成一个联合类型会让每个消费方都要先判 `caseType` 再各写一套渲染分支，
 * 而队列真正要回答的问题只有一句：「现在有哪些案件等着人处理」。
 * 因此这里是**一张表的一行**：两类记录各自映射到同一组列，
 * 列里没有的东西就是 `null`（投诉没有金额，退款一定有订单）。
 */

/** 案件类型。**只有两类**，工作台不再细分。 */
export type AdminAftersaleCaseType = "refund" | "complaint";

/**
 * 视图。
 *
 * ⚠️ `open` 沿用各领域自己的 open 集合（未完结）；`processing` **是 `open` 的子集**
 * （已经有人接手）；`closed` = `open` 的补集。
 *
 * ⚠️ **三个视图不互斥**：`processing ⊆ open`，因此 `open + processing + closed`
 * **不等于** `all`。正确的关系是 `all === open + closed` 且 `processing ⊆ open`。
 * 把三桶当互斥来读（第一版就是这么实现的），会让「未完结」页签漏掉 `reviewing`
 * 的退款——那正是等着管理员批准的那一批（见 D-P1-3-2 / D-P1-3-8）。
 */
export type AdminAftersaleView = "all" | "open" | "processing" | "closed";

/**
 * 一行案件落在哪个**精确桶**（不含 `all`）。
 *
 * ⚠️ 它回答的是「这一行**最细**属于哪一桶」，由状态单向派生（`aftersale*ViewOf`）。
 *
 * ⚠️ **它既不用于筛选，也不是 `counts` 的来源**——但两条理由不同，改一处时要对着另一处读：
 * - **按视图收窄**走 `aftersaleRowInView`（按**状态集合**判断，见
 *   `lib/constants/adminAftersales.ts`）：`open` 是未完结全集，一条 `reviewing` 的行的
 *   精确桶是 `processing`，但它同时属于 `open`——拿本类型去比会把它从「未完结」里漏掉，
 *   那正是 BLOCKER-1。
 * - **`counts`** 另走服务层按本类型**精确桶分批**（`lib/services/adminAftersales.ts` 的计数循环），
 *   `counts.open` 因此含 `processing` 那一桶。
 *
 * 两条路径**同源于同一组常量**（`OPEN_*` 与 `AFTERSALE_IN_PROGRESS_STATUSES`），数值等价、
 * 不会分叉；写「收窄与计数都走 `aftersaleRowInView`」是**错的**，计数并不调它。
 */
export type AdminAftersaleRowView = "open" | "processing" | "closed";

/**
 * 工作台的一行。
 *
 * ## 为什么复用 `OrderCompanionSnapshot`
 *
 * 全仓库只有这一个「订单上的打手公开快照」形状（`id` / `name` / `avatarUrl`），
 * 它记在订单自己身上（`Order.companion`）。工作台要回答的正是
 * 「**这一单实际是谁在做**」，取的就是订单记的那份快照——因此**不新造第二个同形类型**
 * （同形的两份定义迟早会漂移），也**不查派单仓储**：那张表回答的是
 * 「谁被派了单 / 谁指定了谁」，与「实际履约的是谁」是两件事
 * （`Order.actualCompanionId` 与 `Dispatch.exclusiveCompanionId`）。
 *
 * ## 为什么不整包返回 Order / User / Companion 实体
 *
 * ⚠️ 每一行都是**显式挑字段**的结果（§十 权限开发纪律第 4 条「DTO 最小化」）：
 * 整包返回 `Order` 会顺带带上 `gameAccountId` / `remark`（用户填写的隐私内容）
 * 与六个平台金额字段；返回 `Companion` 实体会带上 `enabled` / `removedAt` / 统计；
 * 返回 `UserProfile` 会带上头像与简介。工作台要回答的只有
 * 「这条案件是谁的、涉及哪一单、现在什么状态」，上面列出的每一个字段都为这句话服务。
 * 所以这里**没有**微信身份、会话凭据、游戏账号、备注、正文与凭证。
 */
export type AdminAftersaleRow = {
  id: string;
  caseType: AdminAftersaleCaseType;
  caseTypeLabel: string;
  /** 退款单号或投诉单号 */
  caseNo: string;
  status: string;
  statusLabel: string;
  /**
   * 这一行的**精确桶**（`open` / `processing` / `closed`，见 `AdminAftersaleRowView`）。
   *
   * ⚠️ 服务端用它给 `counts` 分桶，**不用于按视图收窄**——「未完结」是未完结全集，
   * 含 `processing` 那一桶，拿它去比 `view` 会把 `reviewing` 的退款漏掉。
   */
  view: AdminAftersaleRowView;
  /** 案件的 `createdAt`（退款是申请时间，投诉是提交时间） */
  submittedAt: string;
  /** 退款：申请创建时的实付快照（分）；投诉没有金额，为 `null` */
  amount: number | null;
  /** 退款：管理员核定退给用户的金额（分）；未决策或投诉为 `null` */
  decidedAmount: number | null;
  user: AdminUserSummary;
  orderId: string | null;
  orderNo: string | null;
  /** 订单**当前**的业务状态（退款审核期间它不会变成 `refunded`） */
  orderStatus: OrderStatus | null;
  orderStatusLabel: string | null;
  productTitle: string | null;
  /** 这一单**实际接单**的打手公开快照；还没有人接为 `null` */
  companion: OrderCompanionSnapshot | null;
};

/**
 * 列表分页上的视图计数。
 *
 * ⚠️ 三个数**分别等于各自标签下真实的行数**：`open` 是未完结全集、`processing`
 * 是它的**子集**、`closed` 是它的补集（见 `AdminAftersaleView`）。因此
 *
 * ```
 * all === open + closed       ← 构造性成立（closed 补上 open）
 * processing ⊆ open           ← 构造性成立（open 额外收下 processing 这一桶）
 * open + processing + closed === all   ← ⛔ 不成立，不要按它写断言
 * ```
 *
 * 这三个数是给筛选栏当角标的：`counts.open` 必须等于点开「未完结」看到的条数，
 * `counts.processing` 同理。**不得**为了让三数相加等于 `all` 而把 `open`
 * 收窄成「待接手」——那会让默认视图漏掉等着批准的那一批（见 D-P1-3-8）。
 */
export type AdminAftersaleCounts = {
  all: number;
  /** 未完结全集（含 `processing`） */
  open: number;
  /** `open` 的子集：已经有人接手的那一部分 */
  processing: number;
  /** `open` 的补集 */
  closed: number;
};

/** 工作台列表接口一次返回的全部数据。 */
export type AdminAftersaleListData = {
  items: AdminAftersaleRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /**
   * ⚠️ **不含视图筛选**、但**含** `caseType` / `keyword` / 日期筛选的计数；
   * 因此每个数恒等于**它的标签下真实的行数**——`all === open + closed`，
   * 而 `processing ⊆ open`（三桶**不**互斥，见 `AdminAftersaleCounts`）。
   *
   * 「不含视图筛选」是刻意的：计数是给筛选栏上的三个页签当角标的，
   * 若把当前视图也算进去，停在「处理中」时另外两个角标会一起变成 0，
   * 而它们本该回答「切过去还有多少条」。
   */
  counts: AdminAftersaleCounts;
  notice: string;
};

/** 工作台列表查询条件（已解析、已校验）。 */
export type AdminAftersaleListQuery = {
  view: AdminAftersaleView;
  caseType: AdminAftersaleCaseType | "all";
  /** 已去首尾空格；空串表示不搜索 */
  keyword: string;
  /** `YYYY-MM-DD`；空串表示不限 */
  from: string;
  to: string;
  page: number;
  pageSize: number;
};
