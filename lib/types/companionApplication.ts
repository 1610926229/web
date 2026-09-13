import type { SupportEvidence } from "./evidence";

/**
 * 护航入驻申请的类型与对外 DTO。
 *
 * ⚠️ 这个实体**不产生订单、不产生支付**，也**不改变用户身份**。
 *
 * P8A 起审核通过会做的事情（§七）只有三件：申请状态变成 `approved`、
 * 给申请人**追加**一条护航资格、创建（或关联）**一条**护航资料。
 * 这三件事与审计记录写在**同一段不可打断的区段**里
 * （`lib/data/adminCompanionTransaction.ts`），不会留下半完成的数据：
 * 要么四样都写成，要么一样都没写。
 *
 * 通过申请**不会**做这些事：不改 `UserRecord`（通过审核的人仍然是老板，
 * 还能下单、还能看自己的订单与收藏）、不自动接单、不绑定订单、不产生收益、
 * 不写任何价格或佣金字段。
 *
 * **不收集**：身份证号码 / 身份证照片 / 银行卡 / 真实姓名 / 住址 /
 * 微信 OpenID / 微信 UnionID / 登录 Cookie / 未经确认的联系方式。
 * 原型表单里的「真实姓名 / 性别 / 所在城市 / QQ / 微信 / 手机号 / 联系邮箱」因此**没有**实现；
 * 联系方式只留一个明确标注为 Mock 的纯文本 **联系说明**（`contactNote`），
 * 它只出现在申请人自己的进度页，**永远不进任何陪玩 DTO**。
 */

/**
 * 申请状态。
 *
 * 用户能造出来的只有 `pending`（提交）与 `withdrawn`（撤销）；
 * `reviewing` / `approved` / `rejected` **只能来自预置数据或管理后台的审核动作**——
 * 用户端没有任何改状态接口，`withdrawn` 与 `approved` 也不可能互相到达。
 */
export type CompanionApplicationStatus =
  | "pending"
  | "reviewing"
  | "approved"
  | "rejected"
  | "withdrawn";

/**
 * 入驻申请（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律用下面的 DTO，
 * `userId` 不会顺带泄漏出去；进度页拿到的是属于本人的详情 DTO。
 */
export type CompanionApplication = {
  id: string;
  /** 申请单号，由服务端生成，客户端提交什么都会被忽略 */
  applicationNo: string;
  userId: string;

  displayName: string;
  gameIds: string[];
  /** 游戏大区 / 平台，必须属于所选游戏 */
  regions: string[];
  serviceTags: string[];
  /** 经验说明 */
  experience: string;
  /** 自我介绍 */
  introduction: string;
  /** Mock 专用的联系说明（纯文本）；只在本人进度页展示 */
  contactNote: string;
  /** Mock 凭证：地址由服务端写成本地占位图 */
  evidence: SupportEvidence[];

  status: CompanionApplicationStatus;
  /** 提交时间，由服务端写 */
  submittedAt: string;
  updatedAt: string;
  /** 审核时间；还没有结果时为 null */
  reviewedAt: string | null;
  /** 审核备注。只可能来自预置数据或将来后台的返回，用户端写不了 */
  reviewNote: string;
};

/** 申请时间轴的一项。`at` 一定已经发生——不编造未来的审核时间。 */
export type CompanionApplicationTimelineEntry = {
  key: CompanionApplicationStatus;
  label: string;
  at: string;
  note: string;
};

/**
 * 入驻申请摘要 DTO。
 *
 * 只有「状态 + 单号 + 时间」三类信息：它用于「有没有申请、到哪一步了」这类判断，
 * 表单内容与凭证不进这里，因此即便被用在不需要正文的位置也不会多暴露一分。
 */
export type CompanionApplicationSummary = {
  id: string;
  applicationNo: string;
  status: CompanionApplicationStatus;
  /** 状态文案，与服务端同源，前端不自己映射 */
  statusLabel: string;
  submittedAt: string;
  updatedAt: string;
};

/**
 * 入驻申请详情 DTO（**仅本人可见**）。
 *
 * 带上表单内容、Mock 凭证、时间轴与可能的审核备注，并给出服务端判定的
 * `allowedActions`——前端不拿状态自己推断能不能撤销。
 */
export type CompanionApplicationDetail = CompanionApplicationSummary & {
  displayName: string;
  games: { id: string; name: string }[];
  regions: string[];
  serviceTags: string[];
  experience: string;
  introduction: string;
  contactNote: string;
  evidence: SupportEvidence[];
  reviewNote: string;
  reviewedAt: string | null;
  timeline: CompanionApplicationTimelineEntry[];

  allowedActions: {
    /** 只有 `pending` 可以由用户撤销；其余状态一律不可撤销 */
    canWithdraw: boolean;
  };
};

/**
 * 入驻申请表单里的游戏选项。
 *
 * 带上各自的大区，是因为表单的「可服务大区」**跟着已选游戏变化**：
 * 服务端要求大区必须属于所选游戏之一，可选项由服务端给出，页面就不需要
 * 自己维护一份「哪个游戏有哪些大区」的映射（那份映射迟早会跟游戏目录分叉）。
 */
export type CompanionApplicationGameOption = {
  id: string;
  name: string;
  regions: string[];
};

/** 提交申请的结果。重复提交（同一幂等键）返回第一次的结果，`created` 为 false。 */
export type CompanionApplicationCreateResult = {
  applicationId: string;
  applicationNo: string;
  status: CompanionApplicationStatus;
  created: boolean;
};

/** 撤销申请的结果。重复撤销返回同一条记录，`withdrawn` 为 false。 */
export type CompanionApplicationWithdrawResult = {
  applicationId: string;
  status: CompanionApplicationStatus;
  /** 这一次是否真的把状态改成了「已撤销」 */
  withdrawn: boolean;
};

// ——————————————————————————— 管理端 DTO ———————————————————————————

/**
 * 管理端可执行动作。**由服务端判定，前端不拿状态自己推断**（§六）。
 *
 * 与用户端 `allowedActions.canWithdraw` 同一个思路：状态机的合法迁移只写在
 * `lib/constants/adminApplications.ts` 一处，页面只是把这里为真的动作渲染成按钮。
 * 前端多一处判断，就多一处会跟服务端分叉的规则。
 */
export type AdminCompanionApplicationAllowedActions = {
  /** 只有 `pending` 能开始审核 */
  canStartReview: boolean;
  /** `pending` / `reviewing` 可以通过 */
  canApprove: boolean;
  /** `pending` / `reviewing` 可以拒绝（且拒绝必须填写审核意见） */
  canReject: boolean;
};

/**
 * 管理端申请**列表项** DTO。
 *
 * ⚠️ 本类型刻意**不带**四样东西（§六）：完整正文（`experience` / `introduction`）、
 * 联系方式（`contactNote`）、凭证（`evidence`）、审核意见（`reviewNote`）。
 * 列表要回答的是「有哪些申请、各到什么状态了」，这几样是打开详情才需要的内容；
 * 一份列表几十行，每一行都拖着一段正文与几张凭证地址，既没人看也无谓地扩大了暴露面。
 * 需要它们的是 {@link AdminCompanionApplicationDetail}。
 *
 * `userId` 也不在列表里：申请人摘要只在详情出现。
 */
export type AdminCompanionApplicationListItem = {
  id: string;
  applicationNo: string;
  status: CompanionApplicationStatus;
  /** 状态文案，与服务端同源，前端不自己映射 */
  statusLabel: string;
  /** 申请人填写的陪玩昵称 */
  displayName: string;
  games: { id: string; name: string }[];
  regions: string[];
  serviceTags: string[];
  submittedAt: string;
  updatedAt: string;
  reviewedAt: string | null;
};

/** 管理端申请列表分页结果。 */
export type AdminCompanionApplicationPage = {
  items: AdminCompanionApplicationListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

/**
 * 管理端申请**详情** DTO。
 *
 * 在列表项之上补齐审核所需的全部内容：正文、Mock 凭证、审核意见、时间轴、
 * 申请人摘要，以及服务端判定的可执行动作。
 *
 * ⚠️ `contactNote`（联系说明）**在这里出现**，这是它与用户端 DTO 的唯一区别：
 * 列表不带它，但审核的人要看得到——不然那条「联系说明」收来就没有意义。
 * 它是申请人自己填的一句纯文本，本阶段不采集手机号 / 微信 / QQ / 邮箱等具体联系方式。
 * 本 DTO 只会由 `requireAdmin()` 之后的管理接口返回。
 */
export type AdminCompanionApplicationDetail = AdminCompanionApplicationListItem & {
  /** 经验说明 */
  experience: string;
  /** 自我介绍 */
  introduction: string;
  /** Mock 联系说明（纯文本） */
  contactNote: string;
  /** Mock 凭证：地址由服务端写成本地占位图 */
  evidence: SupportEvidence[];
  /** 审核意见；还没有结果时为空串 */
  reviewNote: string;

  /**
   * 申请人摘要。
   *
   * ⚠️ `userId` 是**平台侧的用户标识**，只在管理端出现，不进任何用户端 DTO。
   * 这里给出它，是因为审核要回答「这个人是不是已经有一条护航了」——
   * 那正是「一名用户最多一条有效护航」（§七）在界面上的落点。
   */
  applicant: {
    userId: string;
    /** 用户昵称；用户不存在时为空串 */
    nickname: string;
    /** 已经关联的有效护航 id；没有则为 null */
    linkedCompanionId: string | null;
    /** 是否已经拿到护航资格 */
    hasCompanionQualification: boolean;
  };

  timeline: CompanionApplicationTimelineEntry[];
  allowedActions: AdminCompanionApplicationAllowedActions;
};

/** 审核动作的结果（开始审核 / 通过 / 拒绝共用）。 */
export type AdminApplicationReviewResult = {
  applicationId: string;
  status: CompanionApplicationStatus;
  statusLabel: string;
  reviewedAt: string | null;
  /**
   * 这一次是否真的改动了数据。
   *
   * 与全站的 `created` / `withdrawn` 同一套约定：重复提交（同一幂等键）返回
   * 第一次的结果，此时为 `false`——**不是错误**，因为那一次确实成功了。
   */
  changed: boolean;
  /** 通过时才有的信息：产生的（或已存在的）护航资料 id */
  companionId?: string;
};

/**
 * 管理端申请**列表**一次取回的全部数据。
 *
 * 与服务端页面、浏览器端 `lib/services/adminHttp.ts` 共用同一个形状，
 * 类型只有一处定义，两边不会各自漂移。
 */
export type AdminApplicationListData = AdminCompanionApplicationPage & {
  /** 筛选栏的游戏选项：取自真实游戏数据 */
  games: { id: string; name: string }[];
  /** 各状态条数，用来渲染筛选栏上的角标（与概览页同一个统计口径） */
  counts: Record<CompanionApplicationStatus, number>;
  /** 口径说明，页面顶部展示 */
  notice: string;
};
