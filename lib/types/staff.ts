import type { CompanionReleaseSource } from "./companionRelease";
import type { StaffCompletionListItem } from "./completion";
import type { StaffComplaintListItem } from "./complaint";
import type { DispatchState } from "./dispatch";
import type { MessageSenderRole } from "./message";
import type { OrderAddonSnapshot, OrderStatus, OrderTimelineEntry } from "./order";
import type { StaffRefundListItem } from "./refund";

/**
 * 客服账号、客服端会话与客服工作台 DTO。
 *
 * ⚠️ **客服账号是第三类身份**，既不是普通用户，也不是管理员：
 *
 * - 普通用户（`UserRecord`）在 `lib/types/user.ts`，**没有角色字段**，也不会有用户名与头像白名单；
 * - 管理员（`AdminAccount`）在 `lib/types/admin.ts`，只有 `admin` 能进 `/admin`；
 * - 客服（本文件）在 `lib/data/staffRepository.ts`，只有 `customer_service` 能进 `/staff`。
 *
 * 三者的 Cookie、仓储与开关各不相同，且**两两之间没有转换函数**：
 * 不存在「用用户身份换客服身份」的代码路径，反之亦然。
 *
 * ⚠️ 客服账号**不进消费排行榜、不出现在任何用户端名单里**。
 * 排行榜读的是用户仓储（`userRepository.listUsers()`），与这份数据没有交集，
 * 因此「把客服账号混成普通用户」在数据层就做不到，不需要页面记得过滤。
 */

/**
 * 客服端角色。
 *
 * ⚠️ 两个取值都定义出来，但**只有 `customer_service` 能进入客服工作台**。
 * `companion`（护航）在这里只作为「会被拒绝的身份」存在：护航是平台的服务提供方、
 * 有自己的工作台（后续阶段），不是受理用户问题的人。
 *
 * 管理者新增客服账号时只能创建 `customer_service`——请求体里的 `role` 一律不读
 * （见 `lib/services/adminStaff.ts`），因此「管理端建出一个护航账号」也写不出来。
 */
export type StaffRole = "customer_service" | "companion";

/**
 * 客服账号（仓储内部类型）。
 *
 * ⚠️ **没有密码字段**。真实客服账号与密码属于后续阶段，本阶段的登录是一个模拟入口，
 * 因此这里不存在「密码」『密码哈希』『盐』这类字段——没有字段，就不会有把凭据
 * 下发到浏览器、写进日志或提交进仓库的可能。登录页会明确标注这是 Mock 认证。
 *
 * 这个类型**不出现在任何响应里**：管理端一律返回 `AdminStaffDetail`，
 * 客服端一律返回 `StaffSessionUser`。
 */
export type StaffAccount = {
  id: string;
  /** 登录名。去空白后不能为空，**大小写不敏感唯一** */
  username: string;
  /** 工作台顶部与消息里显示的客服名称 */
  displayName: string;
  /** Mock 白名单头像（`MOCK_AVATAR_OPTIONS`），不是任意地址 */
  avatarUrl: string;
  role: StaffRole;
  /** 停用（`false`）的账号与不存在等价：登录不进去，已有会话也立即失效 */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 上次登录时间；从未登录为 null。由服务端写 */
  lastLoginAt: string | null;
  /**
   * 软删除时间。**删除只写这个字段**：历史消息要保留，
   * 而且消息用的是发送时的名称 / 头像快照，不依赖这条记录还在不在。
   */
  removedAt: string | null;
};

/**
 * 客服端会话用户 DTO。
 *
 * **显式挑字段**：`enabled` / `removedAt` / `lastLoginAt` 都不在这里——前两者是服务端的
 * 拒绝依据（客户端拿到它们只会产生「我明明是 true 为什么进不去」的困惑），
 * 后者是审计信息。这里只有「他是谁、是什么角色」。
 */
export type StaffSessionUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: StaffRole;
  /** 角色文案，与服务端同源，前端不自己映射 */
  roleLabel: string;
};

/**
 * 会话状态的完整判定结果。
 *
 * 分成三态而不是「有 / 没有」两态，是因为**页面与接口需要的粒度不同**：
 * 页面只关心「能不能进」，两态足够（都引导到登录页）；接口需要把
 * 「没登录」（401，去登录）与「登录了但不是客服」（403，换账号也没用）分开。
 */
export type StaffSessionState =
  /**
   * 没有有效会话：未登录、Cookie 里的 id 查不到账号、或开关未开启。
   *
   * ⚠️ **已移除与已停用不在这里**。那两种情形 Cookie 指向的记录**查得到**，
   * 只是这条记录不能进工作台，因此落进下面的 `forbidden`（403）而不是 401。
   * 这条区分是有意的：401 的意思是「换个身份再来」，而一个被移除的账号
   * 换什么身份都没用——把它报成 401 会让人一直去重新登录。
   */
  | { kind: "anonymous" }
  /** 带着一个查得到的客服账号，但它不能进工作台（已停用、已移除，或角色不是客服） */
  | { kind: "forbidden" }
  | { kind: "granted"; staff: StaffSessionUser };

/**
 * 客服登录页上可选的测试账号。
 *
 * ⚠️ 只包含**启用中且未移除**的客服账号：登录页列出停用或已删除的账号，
 * 等于给出一个「点了一定失败」的入口，也等于泄漏了这些账号存在。
 *
 * ⚠️ 这份名单**只出现在客服登录页**，不进用户端任何页面：用户前台不提供账号切换器。
 */
export type StaffLoginOption = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  lastLoginAt: string | null;
};

/** 管理端列表 / 详情共用的客服状态。三种互斥，由服务端算好，页面不推断。 */
export type AdminStaffState = "enabled" | "disabled" | "removed";

/**
 * 管理端客服账号列表项 DTO。
 *
 * ⚠️ 列表与详情**是两个类型**：列表不带「能不能进工作台」的判断依据，
 * 那是详情页与登录结果才需要的信息。
 * 这里也**没有** Cookie、密码、会话标识或仓储内部索引——那三样在这份数据里根本不存在。
 */
export type AdminStaffListItem = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  roleLabel: string;
  state: AdminStaffState;
  stateLabel: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  removedAt: string | null;
};

/** 管理端客服列表页一次取回的全部数据（一页 + 各状态角标）。 */
export type AdminStaffListData = {
  items: AdminStaffListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /** 三个状态各有多少条。已移除的记录**不进**前两个数 */
  counts: { enabled: number; disabled: number; removed: number; total: number };
  notice: string;
};

/**
 * 管理端客服详情 DTO。
 *
 * 比列表多两样：`role`（管理端要看得出这条记录是什么角色）与
 * `canEnterStaffConsole`（由服务端算，页面不自己判角色）。
 * 仍然**没有**任何凭据：本阶段不存在真实密码。
 */
export type AdminStaffDetail = AdminStaffListItem & {
  role: StaffRole;
  canEnterStaffConsole: boolean;
};

/**
 * 管理端五个写操作的返回。
 *
 * ⚠️ **返回的是完整详情 DTO**，不是「改了哪几个字段」：页面拿到之后直接以服务端
 * 的最新值为准，不需要自己拿响应片段拼出一个新状态——那样拼出来的状态迟早会和
 * 真实记录分叉（尤其是幂等重放时，服务端什么都没改，返回的却是当前真实值）。
 *
 * `changed` 为 false 表示**这次调用什么都没改**（幂等重放，或本来就处于目标状态）。
 * 它不是错误：重复点一次「停用」不该报错，也不该写第二条审计。
 */
export type AdminStaffWriteResult = {
  staff: AdminStaffDetail;
  changed: boolean;
};

// ——————————————————————————— 客服工作台 ———————————————————————————

/**
 * 客服工作台的会话列表项 DTO。
 *
 * ⚠️ **刻意不含**游戏 ID、订单备注与完整消息历史：工作台列表要回答的是
 * 「哪几单需要跟进」，不是把订单详情抄一遍。这三样要么属于隐私（游戏 ID / 备注），
 * 要么量大（消息历史，只有详情页按需取）。
 */
export type StaffConversationListItem = {
  orderId: string;
  orderNo: string;
  userNickname: string;
  productTitle: string;
  orderStatus: string;
  orderStatusLabel: string;
  lastMessageBody: string | null;
  lastMessageRole: MessageSenderRole | null;
  /** 最后一条消息的发送者在工作台里的称呼（我 / 用户 / 护航） */
  lastMessageRoleLabel: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  /**
   * **当前客服**没读过的用户消息条数。
   *
   * ⚠️ 与用户侧的未读数是两个方向、两份状态：客服读了不清用户的未读，
   * 用户读了也不清客服的未读（见 `lib/data/messageRepository.ts`）。
   */
  unreadCount: number;
};

/** 客服工作台会话列表页一次取回的全部数据。 */
export type StaffConversationListData = {
  items: StaffConversationListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  notice: string;
};

/**
 * 工作台消息 DTO。
 *
 * `senderName` / `senderAvatarUrl` 是**发送时的快照**，不是现查账号得到的：
 * 客服账号被停用或软删除之后，历史消息仍然显示得出当时的名字与头像，不会变成空白。
 */
export type StaffConversationMessage = {
  id: string;
  senderRole: MessageSenderRole;
  senderRoleLabel: string;
  senderName: string;
  senderAvatarUrl: string;
  body: string;
  createdAt: string;
  /** 是不是当前登录的这位客服自己发的（决定气泡靠左还是靠右） */
  isSelf: boolean;
};

/**
 * 客服工作台里的**用户摘要**（退款列表 / 投诉列表与详情共用）。
 *
 * ⚠️ **只有三个字段，而且每一个都是「客服要能对上话」所必需的**：
 * `nickname` 用来称呼对方、`avatarUrl` 用来在列表里区分、`id` 是平台自己的展示标识
 * （`StaffConversationDetail.user` 早就把它给了客服——工作台要靠它跟会话对上）。
 *
 * ⚠️ **与 `AdminUserSummary` 是两个类型**（同形，但不是同一个）：
 * 复用管理端的类型，会让「管理端给用户摘要加一个字段」直接变成「客服也看得到它」，
 * 而那个字段该不该给客服看本该是另一次判断。
 *
 * ⚠️ 这三样都**不是凭据**：没有 OpenID、没有 UnionID、没有手机号、没有会话标识，
 * 也没有任何能用来登录或支付的字符串。用户仓储里确实存在的支付相关字段
 * 一个都不在这张表上。
 */
export type StaffUserSummary = {
  id: string;
  nickname: string;
  /** Mock 白名单头像；不是用户上传的任意地址 */
  avatarUrl: string;
};

/**
 * 客服**订单页**的用户摘要 = `StaffUserSummary` + `displayId`（P0-10 整改）。
 *
 * ⚠️ **为什么是另一个类型，而不是给 `StaffUserSummary` 加一个字段**：
 * 那个类型被会话、退款、投诉、完成材料四处共用，而它们的检索口径里都没有
 * `displayId` 这一路。给它加字段，等于让那四处**同时**多出一个字段——正是
 * `StaffUserSummary` 自己的注释反对的那种「顺手扩大暴露面」。
 * 产品负责人只要求改 `/staff/orders`（`P0-10/02-decisions.md` §九 A9-11，方案 B）。
 *
 * ⚠️ `displayId` **不是新增暴露**：它就是用户资料页上那串「ID: …」，
 * 用户打电话来报的正是它；客服拿它对人属于「履职需要的信息」（用户权限表 §10）。
 * 管理端订单 DTO 早就给了同一个值（`AdminUserSummary.displayId`），
 * 客服订单页与管理端订单页在这里是**同一套口径**。
 *
 * `id` 仍是内部用户标识（客服会话页给的是同一个值），保留是为了不砍掉既有搜索路径：
 * 两个标识在客服端**都看得见、都能搜**（`orderMatchesKeyword` 的两个字段）。
 */
export type StaffOrderUserSummary = StaffUserSummary & { displayId: string };

/**
 * 一条履约退出历史，**客服视野里的版本**（P0-6）。
 *
 * 打手在开始服务前主动取消接单之后，订单上的 `actualCompanionId` / `companion`
 * 会被清空（订单必须能重新进公共池），因此「谁曾经接过、为什么走」不再有任何
 * 现成字段回答得了——而客服处理与这一单有关的投诉 / 退款 / 会话时，恰恰要先能回答
 * 「我明明看到有人接过，怎么又回到等待接单了」。这一份就是那个答案。
 *
 * ⚠️ **刻意不含 `id` 与 `actorId`**：
 *
 * - `id` 是仓储主键，客服履职不需要拿它做任何二次查询；
 * - `actorId` 是「谁触发的」，而本轮唯一的写入路径（打手主动取消）里它恒等于
 *   `companionId`——给出它只会多一条内部标识的泄漏路径，回答不了任何客服要回答的问题。
 *
 * 两者都是**内部字段**，这是 DTO 最小化的一部分：少一个字段就少一条泄漏路径。
 *
 * ⚠️ 上面说「不给 `actorId`」与下面保留 `companionId` **不矛盾**，别看成同一个东西：
 * 本轮两者恰好同值只是当前写入路径的巧合，而 `companionId` 是需求点名的那个事实本身
 * ——「保留**原打手**」（`EX-SERVICE-01` / 业务流程表）。`companionName` 在护航资料
 * 被彻底删除时会回落成 id，客服要核对「退出的是哪一位」也只能靠它。
 * **不要因为「它和 actorId 一样」就删掉 `companionId`**，删了就违反需求。
 *
 * ⚠️ 这里也**没有任何金额字段**：本轮退出不退款、不罚款、不扣减收益（BF-15），
 * 退出历史与钱无关，带上金额只会让人以为那笔钱被动过。
 */
export type StaffCompanionReleaseEntry = {
  /** 原打手（履约退出者）的平台标识 */
  companionId: string;
  /** 原打手的展示名；查不到该护航记录时回落到 companionId，**不许留空串** */
  companionName: string;
  source: CompanionReleaseSource;
  /** 中文标签，取自 `COMPANION_RELEASE_SOURCE_LABELS` */
  sourceLabel: string;
  /** 退出原因原文；无原因时为 null（本轮恒有值） */
  reason: string | null;
  /** 退出发生的时间（ISO 串） */
  createdAt: string;
};

/**
 * 订单只读摘要（工作台右侧）。
 *
 * ⚠️ 边界由字段表本身保证：这里**没有**支付凭据、Cookie、OpenID / UnionID，
 * 也**没有**游戏 ID 与订单备注——客服当前阶段不需要它们，
 * 而少一个字段就少一条泄漏路径。
 */
export type StaffOrderSummary = {
  orderId: string;
  orderNo: string;
  orderStatus: string;
  orderStatusLabel: string;
  productTitle: string;
  specName: string;
  quantity: number;
  /** 单位：分。只读展示，客服不能改 */
  totalAmount: number;
  userNickname: string;
  /** 护航摘要：未接单时是一句「等待接单」，接了单就是陪玩名 */
  companionSummary: string;
  /**
   * 这一单的履约退出历史（P0-6），按退出时间正序。
   *
   * ⚠️ **空数组而不是 `null`**：没有退出过是**正常情况**，不是「查不到」。
   * 用 `null` 只会让页面多出一条「要不要显示这个区块」的空值分支。
   *
   * ⚠️ 它**只对客服 / 管理员可见**。用户端订单详情与打手端订单 DTO 都不带它：
   * 下单用户收到的是「护航已取消接单」这条通知，普通打手也没有理由看到
   * 「上一位为什么走」。
   */
  releaseHistory: StaffCompanionReleaseEntry[];
};

/**
 * 会话详情 DTO：订单摘要 + 用户 + 三方历史消息 + 当前客服的已读位置。
 *
 * ⚠️ **消息实体不直接作为响应**：这里每一条都经过 `senderRoleLabel` / `isSelf`
 * 这类展示层加工，仓储里那条带 `userId` 的记录不会原样下发。
 */
export type StaffConversationDetail = {
  order: StaffOrderSummary;
  user: { id: string; nickname: string; avatarUrl: string };
  messages: StaffConversationMessage[];
  /** 当前客服读到的时间；null 表示这位客服从未读过这个会话 */
  staffLastReadAt: string | null;
};

/**
 * 工作台首页的五个数。全部来自仓储实时聚合，不是写死的展示值。
 *
 * ⚠️ 前三个（会话）来自消息仓储，后两个（退款 / 投诉）来自退款与投诉仓储。
 * 这里**刻意没有把它们合并成一次聚合查询**：P8D-2 加的这两个数只要求
 * 「实时、可解释」，把三份数据源塞进一个仓储方法换来的只是耦合。
 * 页面各调各的，哪一个慢了或空了都不影响另外几个。
 */
export type StaffConversationMetrics = {
  /** 会话总数（有沟通记录的订单数，与当前筛选无关） */
  conversationCount: number;
  /** 当前客服还有未读的会话数 */
  unreadConversationCount: number;
  /** 今天（北京时间）新产生的消息条数 */
  todayMessageCount: number;
  /**
   * 待处理退款数：状态是 `pending`（待审核）或 `reviewing`（审核中）的退款申请。
   *
   * ⚠️ 口径是「**平台还没给出结论的**」，不是「待审核」——一笔被客服认领过
   * （`reviewing`）的退款仍然是待办，把它排除掉会让「认领过的就没人管了」。
   * 已通过 / 已拒绝 / 已撤销都不计入：那是已经结束的事。
   */
  pendingRefundCount: number;
  /** 待处理投诉数。口径同上：`pending` 与 `processing` 都算，两个终态都不算。 */
  pendingComplaintCount: number;
  generatedAt: string;
  notice: string;
};

/* ───────────────────────── 客服工作台 · 全量订单查询（P0-10） ───────────────────────── */

/**
 * 客服工作台「订单」列表项（P0-10）。
 *
 * 这是**全平台订单的只读查询入口**：客服要回答「用户报的这个订单号现在是什么状态、
 * 是谁在跟」，因此筛选与排序的口径必须与订单列表一致（`createdAt` 的北京时间自然日、
 * 创建时间倒序），而不是按会话有没有消息。
 *
 * ## 刻意不含什么，为什么
 *
 * ⚠️ **`gameAccountId`（游戏账号）与 `remark`（用户备注）不在列表上**：
 * 这是 `StaffConversationListItem` / `StaffOrderSummary` 已经确立的同一条边界——
 * 数据最小化（用户权限表 §10「只开放履职需要的信息」）。列表一次返回多条，
 * 把别人的游戏账号与备注带进响应，等于让「谁进得了工作台」直接等于「看得到全部隐私」。
 * 它们连**详情**也不给（见 `StaffOrderDetail`）。
 *
 * ⚠️ **一个平台 / 分账字段都没有**：`clubNetIncome`（平台净收入）、
 * `companionRateSnapshot`（分账比例快照）、`companionBaseIncome`（护航收益）
 * 全部不在这里，也不在详情里。用户权限表 §7.2 明确禁止客服查看分账比例；
 * 而三者的任一个都足以把分账算回来（后两者与比例是同一个数的三种写法）。
 *
 * ⚠️ **不暴露内部用户主键**：对外只给 `StaffUserSummary`——它早就是
 * 「客服能看到的用户身份」（`StaffConversationDetail.user` 给的是同一个值）。
 * 订单上的 `Order.userId` 本身不进任何 DTO。
 *
 * ⚠️ 也**不含**支付内部字段（幂等键、支付请求快照）与售后摘要：
 * 前者从来不进任何对外 DTO，后者只在详情页可见（同 `ADMIN_ORDER_LIST_FIELDS_NOTE` 的口径）。
 */
export type StaffOrderListItem = {
  id: string;
  orderNo: string;
  status: OrderStatus;
  /** 状态中文名（`ORDER_STATUS_LABELS`）。服务端给，页面不自己维护一份文案 */
  statusLabel: string;
  /** 下单（支付成功）时间。列表按它倒序，时间筛选也按它算——两处必须是同一个字段 */
  createdAt: string;
  paidAt: string;
  /**
   * 游戏名快照（下单那一刻的名称）。它同时是**筛选依据**：
   * 订单里没有游戏 id，而且游戏改名 / 下架都不该让历史订单换个游戏。
   */
  gameName: string;
  productTitle: string;
  specName: string;
  quantity: number;
  /** 单位：分。渠道实收（商品 + 增值服务）的订单快照。只读展示，客服不能改 */
  totalAmount: number;
  /**
   * 下单用户摘要（`StaffOrderUserSummary`：id / 昵称 / 头像 / `displayId`）。
   *
   * ⚠️ 它进列表**不是**顺手带的：`keyword` 支持按用户昵称与两个平台标识搜索，
   * 命中理由必须看得见，否则会出现「搜到了但看不出来为什么搜到」。
   */
  user: StaffOrderUserSummary;
};

/** 客服工作台订单列表页一次取回的全部数据。 */
export type StaffOrderListData = {
  items: StaffOrderListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /**
   * 游戏筛选项：取自在库订单里出现过的游戏名（去重排序）。
   *
   * ⚠️ 与管理端同规则、同一个纯函数：**不用当前商品目录**。目录里新加了游戏但一单没有时，
   * 放进筛选栏只会得到一次必然为空的查询；游戏下架后历史订单仍要能筛出来。
   */
  games: string[];
  notice: string;
};

/**
 * 派单进度摘要（P0-10）：这一单在哪个池子里等人接、等到什么时候、结果是什么。
 *
 * ## 刻意不含什么，为什么
 *
 * ⚠️ **`exclusiveCompanionId` 与 `acceptedByCompanionId` 都不给**：
 * 「用户当初指定了谁」不在 `cmd_p0-10.md` 的详情必列清单里，而「**实际**是谁在履约」
 * 已经由订单快照回答（`StaffOrderSummary.companionSummary`）——
 * 两个 id 都只是内部记录，给出来只多两条泄漏路径。
 * 「谁曾经接过又退出」由**履约退出历史**回答（`StaffOrderSummary.releaseHistory`），
 * 那才是客服要核对的事实。
 *
 * ⚠️ **`publicTimeoutMinutesSnapshot` 不给**：那是平台参数的内部快照，
 * 客服需要的是「截止到几点」（`publicDeadlineAt`），不是「当时配置是多少分钟」。
 *
 * ⚠️ 也**不含** `id` / `orderId` / `createdAt` / `updatedAt`：仓储主键与内部时间戳
 * 都不是客服履职要用的东西（`DTO 最小化`：少一个字段就少一条泄漏路径）。
 *
 * ⚠️ 这里**没有** `state` 之外的可执行判断（没有 `canAccept` 一类字段）：
 * 派单进度只回答「这一单在哪个池子里等过、结果如何」，它**不回答**「客服能做什么」——
 * 那是 `StaffOrderDetail.allowedActions` 的事（P0-11），而它的判据是**订单状态**，
 * 与派单此刻在哪个池子里无关。两者混在一起会出现「派单已超时关闭、订单却还显示可换人」
 * 这类由两个字段各自推断出来的矛盾。
 */
export type StaffOrderDispatchSummary = {
  state: DispatchState;
  /** 状态中文名（`DISPATCH_STATE_LABELS`）。服务端给，页面不自己映射 */
  stateLabel: string;
  /** 进入专属池的时刻；用户没指定打手时为 null */
  exclusiveEnteredAt: string | null;
  /** 专属池的截止时刻；未进过专属池时为 null */
  exclusiveDeadlineAt: string | null;
  /** 进入公共池的时刻；未进过公共池时为 null */
  publicPoolEnteredAt: string | null;
  /** 公共池的截止时刻；未进过公共池时为 null */
  publicDeadlineAt: string | null;
  /** 被接单的时刻；还没有人接时为 null */
  acceptedAt: string | null;
  /**
   * **派单关闭的时刻**；没有关闭过时为 null。
   *
   * ⚠️ 不叫「超时关闭时刻」：这个状态有两种来路（公共池到点无人接 / 订单在开始服务前
   * 被用户直接退款，P0-12），写死成「超时」会让客服把用户取消的单说成无人接单。
   */
  timedOutAt: string | null;
};

/**
 * 客服工作台订单详情（P0-10）。
 *
 * 在列表项之上补齐「这一单长什么样」与「这一单做过什么」。四份摘要都是**摘要**：
 * 退款 / 投诉 / 完成材料的正文、凭证与审核意见各自留在它们的详情页，
 * 这里只回答「有没有、到哪一步了」。
 *
 * ## 刻意不含什么，为什么（这就是边界）
 *
 * | 排除字段 | 理由 |
 * |---|---|
 * | `clubNetIncome` | **平台净收入**。`Order` 的注释已确立它「不进任何 DTO」；`cmd_p0-10.md` 明令不得暴露平台净利润 |
 * | `companionRateSnapshot` | **分账比例快照**。用户权限表 §7.2 禁止客服查看分账比例 |
 * | `companionBaseIncome` | **护航收益**。它与比例是同一个数的两种写法——给了它等于给了比例；而本轮金额裁决在 Admin（`cmd_p0-13.md`），客服不需要它 |
 * | `gameAccountId` | 游戏账号。既有客服 DTO 已确立其不进客服视野（数据最小化 §10），本轮只读查询不需要它 |
 * | `remark` | 用户备注。同上，而且备注里可能有用户写的隐私内容 |
 * | `userId`（内部主键） | 对外只给 `StaffUserSummary.id`（平台标识），内部主键不进响应 |
 * | `exclusiveCompanionId` | 用户当初指定的人。「原打手是谁」由退出历史回答，不额外暴露指定对象 |
 * | 支付内部字段 | `idempotencyKey` / `PaymentRequest.snapshot` 等本就不在任何对外 DTO 里 |
 *
 * ⚠️ **金额口径**：客服看的是「**用户侧的钱**」——原价 / 优惠 / 实付 / 已退
 * （`originalAmount` / `couponDiscountAmount` / `actualPaidAmount` / `refundedAmount`），
 * 因为客服要判断「这单还能退多少」就必须知道实付与已退。
 * 客服**不看**「分账与平台的账」（比例 / 护航收益 / 平台净收入）。
 * 这里**不做任何金额计算**：四个数都是下单时冻结的订单快照，原样展示。
 *
 * ⚠️ 本类型是**显式挑字段**的，绝不是 `{ ...order }`：
 * 给 `Order` 新增字段不会自动出现在客服响应里。新增字段必须在这里再写一行，
 * 而那正是「该不该给客服看」被重新判断一次的地方。
 */
export type StaffOrderDetail = {
  /**
   * 这一单此刻**客服可以点的动作**（P0-11）。由服务端算好，页面只按值渲染。
   *
   * ⚠️ 放在这里是**刻意的**：客服看到的按钮不该由前端用订单状态自己推断
   * （`components/staff/StaffCompletionConsole.tsx` 已确立同一条：`allowedActions`
   * 从服务端来）。前端推断等于把权限规则抄到浏览器里，而浏览器里的那份改不改、
   * 对不对，服务端一无所知。
   */
  allowedActions: StaffOrderAllowedActions;
  /** 订单只读摘要（复用既有类型）：订单身份 / 状态 / 商品 / 打手 / 履约退出历史 */
  order: StaffOrderSummary;
  /** 下单用户摘要（`StaffOrderUserSummary`：比列表多一个 `displayId`，两处同一份） */
  user: StaffOrderUserSummary;
  /** 商品封面快照 */
  productCoverUrl: string;
  /** 游戏名快照 */
  gameName: string;
  /** 大区快照 */
  region: string;
  /** 单位：分。单价 × 数量 = `itemsAmount` */
  unitPrice: number;
  /** 单位：分。商品小计 */
  itemsAmount: number;
  /** 单位：分。增值服务合计（按单计费，不随数量变化） */
  addonsAmount: number;
  /** 增值服务快照（下单时的名称与价格，之后目录改名改价不影响历史订单） */
  addons: OrderAddonSnapshot[];
  /** 单位：分。优惠前的应付总额。下单时冻结，改商品配置不影响历史订单 */
  originalAmount: number;
  /** 单位：分。优惠券抵扣金额（P0 恒为 0） */
  couponDiscountAmount: number;
  /** 单位：分。用户实付 = `originalAmount − couponDiscountAmount` */
  actualPaidAmount: number;
  /** 单位：分。**累计已退**给用户的金额。客服据此判断这一单还能退多少 */
  refundedAmount: number;
  /** 已发生的状态节点，按时间先后排列（复用 `buildOrderTimeline`，与用户端 / 管理端同一口径） */
  timeline: OrderTimelineEntry[];
  /** 派单进度摘要；订单没有派单记录时为 null（历史数据） */
  dispatch: StaffOrderDispatchSummary | null;
  /**
   * 这一单的退款申请摘要；没有申请过为 null。
   *
   * ⚠️ 复用**客服退款列表项**类型，而不是另写一份摘要：退款在这两个页面上是同一件事，
   * 两份摘要迟早会出现「退款列表说审核中、订单详情说待审核」。
   * 完整内容（原因、说明、凭证、审核意见）要去退款详情页看。
   */
  refund: StaffRefundListItem | null;
  /**
   * 这一单的投诉摘要，按提交时间排列。
   *
   * ⚠️ **数组而不是单条或 null**：一单可以有多条投诉（不同时间、不同问题），
   * 服务端按订单查全部；**没有投诉时是空数组 `[]`，不是 null**——
   * 「一条都没有」是正常情况，用 null 只会让页面多出一条空值分支。
   */
  complaints: StaffComplaintListItem[];
  /**
   * 这一单最新的完成材料摘要；没有提交过为 null。
   *
   * 只回答「提交过没有、到哪一步了」——审核通过是订单进入 `completed` 的唯一入口，
   * 客服要能看出这一单为什么已经完成。凭证与审核意见在完成材料页看。
   */
  completion: StaffCompletionListItem | null;
};

/* ─────────────────── 客服工作台 · 订单处置：换人 / 退回公共池（P0-11） ─────────────────── */

/**
 * 客服在订单详情页可以执行的动作（P0-11）。
 *
 * ⚠️ **两个布尔值今天是同一个值**（都由「这一单有人正在履约」推出），但它们**不合并**：
 * 这是两个独立的能力，将来任何一条的准入条件单独变化时（例如给某类订单禁用换人），
 * 合并过的那个字段就必须拆开，而拆开意味着前端要跟着改。
 *
 * ⚠️ 与 `StaffCompletionAllowedActions` 同一取舍：**只有 `true` 才代表按钮该出现**，
 * 页面不自己用 `order.status` 推断。反过来也成立——这个字段是 `false` 时，
 * 接口也一定会拒绝，两边用的是同一个判断（`staffOrderAllowedActions`）。
 *
 * ⚠️ 这里**没有** `canRefund`：退款是另一个域的动作（P0-12 及以后），
 * 它的准入条件与履约无关（`completed` 也能退），塞进同一个布尔组只会让两套规则看起来是一套。
 */
export type StaffOrderAllowedActions = {
  canRelease: boolean;
  canReplace: boolean;
};

/**
 * 客服「退回公共池」的接口返回（P0-11）。
 *
 * ⚠️ `status` 是字面量 `"paid"`，含义与 `CompanionCancelOutcome` 完全一致：
 * **「这次操作把订单置成了什么状态」**，不是「订单此刻的状态」。
 * 界面在写成功之后要重新拉详情，因此它只用于即时反馈。
 */
export type StaffOrderReleaseResult = {
  orderId: string;
  orderNo: string;
  status: "paid";
  statusLabel: string;
  /** 本次写入的退出历史 id */
  releaseRecordId: string;
  releasedAt: string;
  /** `true` = 本次真的解除了。这个动作没有重放分支（订单已不在履约中会直接 400） */
  changed: true;
};

/**
 * 客服「直接指定新打手」的接口返回（P0-11）。
 *
 * ⚠️ `status` 是 `"accepted"`：换人之后这一单**仍然有人在履约**，
 * 只是换了一位。新打手拿到的状态与他自己点接单完全一样（见
 * `StaffOrderReplaceOutcome` 的说明）——他没有跳过任何一步。
 */
export type StaffOrderReplaceResult = {
  orderId: string;
  orderNo: string;
  status: "accepted";
  statusLabel: string;
  /** 被解除的那位打手 */
  previousCompanionId: string;
  /** 新指定的打手 */
  newCompanionId: string;
  releaseRecordId: string;
  replacedAt: string;
  changed: true;
};

/**
 * 换人候选（P0-11）：客服在这一单上可以指定哪些打手。
 *
 * ⚠️ **资格过滤在服务端完成**（`enabled` / 未移除 / 当前可接单 / 不是下单用户本人 /
 * 不是此刻正在履约的那位），因此这个列表里出现的每一项都是**指定一定会成功**的。
 * 让前端拿着全量护航列表自己判断，就等于把资格规则抄进浏览器——
 * 那份副本与 `isCompanionAcceptingOrders()` 迟早会对同一位打手给出不同答案。
 *
 * ## 刻意不含什么
 *
 * ⚠️ 没有手机号、微信号、真实姓名等任何联系方式，也没有分账比例与收益：
 * 客服要挑的是「谁能接这一单」，不是「这个人赚多少」（用户权限表 §7.2）。
 * 也**没有** `userId`（内部主键）——「是不是下单用户本人」这件事已经在服务端判完了。
 */
export type StaffOrderReplaceCandidate = {
  companionId: string;
  displayName: string;
  avatarUrl: string;
  /**
   * 这位打手**手上正在履约**的订单数（`accepted` + `serving`）。
   *
   * ⚠️ 它进列表是为了让「换给谁」这件事可判断：把一单换给一个已经压了五单的人，
   * 是把问题从一位打手挪到另一位身上。这个数**不是新暴露**——
   * 客服本来就能在订单列表里按打手逐条查到这些单。
   *
   * 它**不含** `completed` / `refunded`：那些不是他手上的活。
   */
  activeOrderCount: number;
};

/** 换人候选列表接口一次返回的全部数据。 */
export type StaffOrderReplaceCandidateListData = {
  items: StaffOrderReplaceCandidate[];
  /** 候选为空时页面上要说的话；非空时是一句口径说明。服务端给，页面不自己拼 */
  notice: string;
};
