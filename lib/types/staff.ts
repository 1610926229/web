import type { MessageSenderRole } from "./message";

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
