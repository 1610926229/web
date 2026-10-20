/**
 * 管理后台的身份类型与对外 DTO。
 *
 * ⚠️ 管理端身份与用户端身份是**两套完全独立的东西**，本文件是这条边界在类型上的落点：
 *
 * - 用户端会话（`lib/auth/session.ts`）读的是 `UserRecord`，**没有角色字段**，
 *   因此一个普通用户不管怎么改 Cookie、怎么往请求体里塞 `role: "admin"`，
 *   都不可能变成管理者；
 * - 管理端会话（`lib/auth/adminSession.ts`）读的是下面这个 `AdminAccount`，
 *   它与用户仓储是两份数据、两个 Cookie、两个查询入口；
 * - 两者之间没有转换函数。不存在「用用户身份换管理身份」的代码路径，
 *   也不存在「用管理身份换用户身份」的代码路径。
 */

/**
 * 管理端角色。
 *
 * ⚠️ 三个取值都定义出来，但**只有 `admin` 能进入管理后台**。
 * `customer_service`（客服）与 `companion`（护航）在本阶段仅作为「会被拒绝的身份」存在：
 * 客服工作台与客服账号管理属于后续阶段，护航是平台的服务提供方、不是平台的管理者。
 *
 * 这一层刻意不做 RBAC：没有权限点、没有角色继承、没有授权表。
 * 本阶段只有一条规则——「是不是 admin」，它写在 `lib/constants/admin.ts` 的
 * `canEnterAdminConsole()` 里，全站只有那一处。规则变复杂时改那一个函数，
 * 而不是去搜「哪里判断了角色」。
 */
export type AdminRole = "admin" | "customer_service" | "companion";

/**
 * 管理端账号（仓储内部类型）。
 *
 * ⚠️ **没有密码字段**。真实管理员账号与密码属于后续阶段，本阶段的登录是一个
 * 固定的模拟入口，因此这里不存在「密码」「密码哈希」「盐」这类字段——
 * 没有字段，就不会有把密码下发到浏览器、写进日志或提交进仓库的可能。
 *
 * 这个类型**不出现在任何响应里**：接口一律返回下面的 `AdminSessionUser`。
 */
export type AdminAccount = {
  id: string;
  /** 登录名。仅管理端内部使用，不进入用户端任何数据 */
  username: string;
  displayName: string;
  role: AdminRole;
  /** 停用（`false`）的账号与不存在等价：登录不进去，已有会话也立即失效 */
  enabled: boolean;
  /** 上次登录时间；从未登录为 null。由服务端写 */
  lastLoginAt: string | null;
};

/**
 * 管理端会话用户 DTO。
 *
 * **显式挑字段**：`enabled` 与 `lastLoginAt` 都不在这里——前者是服务端的拒绝依据
 * （客户端拿到它也没有用，只会有「我明明是 true 为什么进不去」的困惑），
 * 后者是审计信息。这里只有「他是谁、是什么角色、角色怎么称呼」。
 */
export type AdminSessionUser = {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  /** 角色文案，与服务端同源，前端不自己映射 */
  roleLabel: string;
};

/** 管理端登录结果。`created` 语义与全站一致的地方在于：这里是登录，不是创建，故不设该字段。 */
export type AdminLoginResult = {
  admin: AdminSessionUser;
};

/**
 * 管理后台概览的一项指标。
 *
 * `key` 是稳定的机器标识（测试与测试选择器用它），`label` 是文案，
 * `href` 指向该指标对应的列表筛选地址——「点摘要卡进列表」这条交互因此
 * 由服务端给出，页面不自己拼地址（拼错了只会得到一个空列表）。
 */
export type AdminOverviewMetric = {
  key: string;
  label: string;
  value: number;
  href: string;
  /** 该指标的口径说明。数字必须能被解释，不能只给一个孤立的数 */
  hint: string;
};

/** 管理后台概览 DTO。 */
export type AdminOverview = {
  metrics: AdminOverviewMetric[];
  /** 数据来源与口径的说明，页面顶部展示 */
  notice: string;
  /** 生成时间（服务端时间），用于判断看到的是什么时候的数据 */
  generatedAt: string;
};

/**
 * 经营首页（P1-1）的三个「今日」数字。
 *
 * ⚠️ **金额一律是整数「分」**（与全仓一致），转成元只发生在展示层
 * （`formatYuan()`）。这里没有「元」字段——两个单位同时存在一定会有人读错。
 *
 * ⚠️ 字段就是这三个，**没有第四个**：DTO 是这份数据的全部对外形状，
 * 精确键测试（`tests/adminDashboard.test.mjs`）会把它钉死。
 */
export type AdminDashboardMetrics = {
  /** 今天支付成功的订单数（含今天又被退款的） */
  todayOrderCount: number;
  /** 今天成功支付订单的实付金额之和（分）；退款不倒扣 */
  todayGmvAmount: number;
  /** 今天实际退出去的金额之和（分）：直接退款 + 售后审核通过 */
  todayRefundAmount: number;
};

/**
 * 经营首页的三个待办数字 —— 「尚未终结且仍需管理员动作」的条目数。
 *
 * ⚠️ 字段名 `refunds` 而不是「售后」：本项目**没有**售后聚合实体，
 * 退款与投诉是两个模块（见 `lib/constants/admin.ts` 的既有说明）。
 * 这个数就是退款申请里还停在待审核 / 审核中的条数。
 */
export type AdminDashboardPending = {
  /** 待审核 + 审核中的入驻申请 */
  applications: number;
  /** 待审核 + 审核中的退款申请 */
  refunds: number;
  /** 待处理 + 处理中的投诉 */
  complaints: number;
};

/**
 * 经营首页 DTO（P1-1）。
 *
 * **只返回聚合结果**：没有订单数组、没有用户对象、没有游戏账号、没有备注、
 * 没有分账比例或收益、没有仓储原始记录。要看明细，点卡片进对应的管理页——
 * 那些页面的 DTO 各自负责自己的字段裁剪。
 *
 * `businessDate` 由**服务端**算好（北京时间，`YYYY-MM-DD`）并放进 DTO：
 * 浏览器不做任何时间计算，因此不可能出现「页面按本地时区算今天、
 * 服务端按 UTC+8 算今天」这种两侧不一致。
 */
export type AdminDashboardDTO = {
  /** 这份数字属于哪一天（北京时间自然日，`YYYY-MM-DD`） */
  businessDate: string;
  metrics: AdminDashboardMetrics;
  pending: AdminDashboardPending;
};

