import type { ReviewRating } from "./review";

/**
 * 陪玩的类型与对外 DTO。
 *
 * 陪玩**只有一份数据**：结算页的「推荐陪玩」选择面板（P4）、公开的陪玩列表与陪玩详情
 * 读的是同一份记录、同一个数据源（`lib/data/source.ts`），因此同一位陪玩在三个页面上
 * 的昵称、头像与可用状态必然一致。本阶段**不建立第二套陪玩名单**。
 *
 * ⚠️ 边界：陪玩与订单的最终绑定关系、陪玩定价、排班与接单流程**均未确认**，
 * 因此本文件里没有任何价格、佣金、排期或接单字段——不是「暂时留空」，
 * 而是这些规则还没有定论，提前定下来就是在自行发明业务规则。
 *
 * P8A 起，护航可以由**入驻申请审核通过**产生（见 `lib/data/companionRepository.ts`），
 * 因此实体上多了三个内部字段：`userId`（关联用户）、`applicationId`（来源申请）、
 * `removedAt`（软移除）。三者都是**平台侧管理信息**，一律不进公开 DTO；
 * 公开的 `CompanionListItem` / `CompanionDetail` 依旧是原来那一组字段。
 *
 * 对外的两个 DTO（`CompanionListItem` / `CompanionDetail`）**显式挑字段**：
 * 登录用户 ID、微信 OpenID / UnionID、手机号、微信号、QQ、入驻申请内容、内部审核备注、
 * 身份证与银行卡信息、具体订单、用户游戏 ID、收益与结算数据、仓储内部字段
 * 一律不出现在任何响应里。
 */

/**
 * 陪玩（仓储内部类型）。
 *
 * `available` 与 `enabled` 是**两件事**，不能合并：
 * - `enabled`：这条记录是否在平台上架。下架（`false`）的陪玩不进公开列表，
 *   直链打开详情只会看到一页只读的「当前不可提供服务」，没有任何选择入口；
 * - `available`：在架但当前接不了单（休息中 / 已排满）。这类陪玩**仍然出现在列表里**
 *   并标注原因——直接隐藏会让人以为名单里没有这个人。
 */
export type Companion = {
  id: string;
  /**
   * 关联的用户（`UserRecord.id`），由审核通过时写入。
   *
   * ⚠️ **内部字段，不进任何公开 DTO**（`tests/companions.test.mjs` 会检查它不外泄）。
   * 管理后台的护航详情会展示它，因为后台本来就要回答「这条护航对应哪个用户」；
   * 用户端则完全不需要——公开资料里没有任何身份关联。
   *
   * 预置的 Mock 陪玩（`cp-*`）一律为 `null`：他们是平台早期数据，没有对应的入驻申请。
   * **关联不用昵称**：昵称可以改、可以重名，用昵称关联等于用展示文案做主键。
   */
  userId: string | null;
  /**
   * 创建这条护航资料的入驻申请 id；预置数据为 `null`。
   *
   * 存在的意义是**可追溯**：后台要能回答「这条护航是哪一次审核产生的」。
   * 同样不进任何公开 DTO。
   */
  applicationId: string | null;
  /**
   * 软移除时间；未移除为 `null`。
   *
   * ⚠️ 移除**不是删除记录**：历史订单、评价、鸡腿记录都要继续指得到这条资料，
   * 因此移除只写这个时间戳，前台各处把它当作「不在名单里」。
   * 与 `enabled` 的区别见 `lib/constants/adminCompanions.ts`。
   */
  removedAt: string | null;
  /**
   * 昵称。列表 / 详情 / 结算页共用这一个字段，三处不会出现两种叫法。
   * 展示前一律加「（占位）」后缀：这是 Mock 身份，不标清楚会被当成真人。
   */
  displayName: string;
  avatarUrl: string;
  /** 结算页选择面板里的一行小字（如「钻石打手」）。仅 P4 面板使用，不进公开 DTO。 */
  rankLabel: string;

  /** 自我介绍。列表页只给截断后的摘要，完整内容在详情页 */
  intro: string;
  /** 擅长游戏，取自 `gameSeed` 的真实游戏 id */
  gameIds: string[];
  /** 可服务的游戏大区 / 平台，取值属于游戏本身（如「手游」「端游」） */
  regions: string[];
  /** 服务标签，如「护航」「陪练」。取值由 `lib/constants/companions.ts` 约束 */
  serviceTags: string[];

  /** 在架但当前能否接单 */
  available: boolean;
  /** `available` 为 `false` 时给用户看的具体原因；可选时为空串 */
  unavailableReason: string;

  completedOrderCount: number;
  /** 平均分；**没有评价时为 null**（原型显示「暂无评分」），不用 0 冒充 */
  rating: number | null;
  /** 收到的鸡腿数（展示用的计数，不涉及任何金额换算规则） */
  tipsCount: number;
  reviewCount: number;

  /** 排序权重，越小越靠前；相等时按 id 兜底，保证分页顺序稳定 */
  sortOrder: number;
  /** 是否上架 */
  enabled: boolean;

  /** Mock 评价摘要（详情页展示用）。列表 DTO 不带正文 */
  reviews: CompanionReview[];
};

/**
 * 陪玩评价摘要。
 *
 * ⚠️ 只有「昵称 + 星级 + 正文 + 时间」四项，**没有 userId、没有 orderId、没有凭证**：
 * 陪玩详情是游客可见的公开页面，评价摘要里不需要、也不应该出现任何可以反查到
 * 具体订单或具体用户的信息。
 */
export type CompanionReview = {
  id: string;
  nickname: string;
  rating: ReviewRating;
  content: string;
  createdAt: string;
};

/** 陪玩关联的游戏（筛选用的 id + 展示用的名称，一次给全，前端不用自己维护映射）。 */
export type CompanionGameTag = {
  id: string;
  name: string;
};

/**
 * 陪玩列表项 DTO。
 *
 * 只带列表卡片真正要画的字段：`introBrief` 是**截断后**的自我介绍，
 * 完整自我介绍与评价正文只在详情 DTO 里。内部字段（`sortOrder` / `enabled` /
 * `rankLabel` / `reviews`）与任何身份字段都不在这里。
 */
export type CompanionListItem = {
  id: string;
  displayName: string;
  avatarUrl: string;
  /** 截断后的自我介绍，用于列表卡片 */
  introBrief: string;
  games: CompanionGameTag[];
  regions: string[];
  serviceTags: string[];
  rating: number | null;
  completedOrderCount: number;
  tipsCount: number;
  reviewCount: number;
  available: boolean;
  /** 不可选时的具体原因；可选时为空串 */
  unavailableReason: string;
};

/** 陪玩列表分页结果。 */
export type CompanionPage = {
  items: CompanionListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

/**
 * 陪玩详情 DTO。
 *
 * 在列表项之上补两样东西：完整的自我介绍，以及**有限的**公开评价摘要
 * （最多 `COMPANION_DETAIL_REVIEW_LIMIT` 条，`reviewsTruncated` 说明是否还有更多）。
 *
 * 仍然没有：价格、佣金、排班、可接单时段、联系方式、入驻申请内容、内部审核备注。
 * 陪玩定价与绑定规则尚未确认，详情页不能先给出一个看起来像定价的数字。
 */
export type CompanionDetail = Omit<CompanionListItem, "introBrief"> & {
  intro: string;
  reviews: CompanionReview[];
  /** 评价是否只展示了前若干条 */
  reviewsTruncated: boolean;
  /**
   * 这位陪玩**是否在公开名单里**（对应仓储的 `enabled`）。
   *
   * 详情页需要这一个字段，是因为「下架」与「在架但暂不可用」对用户是两件不同的事：
   * - `listed: false`（下架）：这一页只给已公开的资料，**没有选择入口**，也没有下单入口；
   * - `listed: true` 且 `available: false`（休息中 / 已排满）：正常展示，按钮禁用并写出原因。
   * 只靠 `available` 分不出这两种情况——两种情况它都是 `false`。
   */
  listed: boolean;
  /**
   * 现在能不能「选择这位陪玩」。由**服务端**给出（`listed && available`），
   * 前端不拿 `available` 自己推断——前端只多一个判断就多一处会跟服务端分叉的规则。
   */
  selectable: boolean;
};

// ——————————————————————————— 管理端 DTO ———————————————————————————

/**
 * 管理端护航**列表项** DTO。
 *
 * 与公开 DTO 的差别只有一处立场：后台要管理记录，因此这里**带上**
 * `enabled` / `sortOrder` / `removedAt` / `linkedUserId` 这些公开侧不给的内部字段；
 * 公开侧仍然一个都看不到（`toCompanionListItem` / `toCompanionDetail` 显式挑字段）。
 *
 * ⚠️ 统计字段（`rating` / `completedOrderCount` / `reviewCount` / `tipsCount`）
 * 在这里**只读**：§八 明确禁止从客户端修改它们，因此编辑接口的入参里没有位置可写，
 * 这一份 DTO 给出它们只是为了让人看见现状。
 *
 * `intro` 不在列表里：与公开列表同一个理由，一整段自我介绍放进表格没有意义。
 */
export type AdminCompanionListItem = {
  id: string;
  displayName: string;
  avatarUrl: string;
  intro: string;
  games: CompanionGameTag[];
  regions: string[];
  serviceTags: string[];

  enabled: boolean;
  available: boolean;
  /** `available` 为 `false` 时的原因；可选时为空串 */
  unavailableReason: string;
  /** 展示排序，越小越靠前 */
  sortOrder: number;
  /** 软移除时间；未移除为 null */
  removedAt: string | null;

  /**
   * 关联的用户 id；预置陪玩（平台早期数据）为 null。
   *
   * ⚠️ 后台**看得见、改不了**：§八 禁止从客户端修改关联用户，
   * 因此编辑入参里没有这个字段。
   */
  linkedUserId: string | null;
  /** 来源入驻申请 id；预置陪玩为 null。同样只读 */
  applicationId: string | null;

  rating: number | null;
  completedOrderCount: number;
  reviewCount: number;
  tipsCount: number;
};

/** 管理端护航列表分页结果。 */
export type AdminCompanionPage = {
  items: AdminCompanionListItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

/** 管理端护航详情 DTO。字段与列表项一致（列表已经把可管理的字段给全了）。 */
export type AdminCompanionDetail = AdminCompanionListItem;

/**
 * 护航编辑表单的入参（**白名单**，§八）。
 *
 * ⚠️ 这份类型就是「客户端能改什么」的完整清单：统计（评分 / 完成单数 / 评价数 / 鸡腿数）、
 * 关联用户、来源申请、`removedAt`、`id` **都不在这里**——不是「暂时没做校验」，
 * 而是入参类型上就没有位置可写，插件式地多传一个字段也会被忽略。
 *
 * 规则的落点是 `lib/constants/adminCompanions.ts` 的 `normalizeCompanionProfilePatch()`：
 * 昵称非空、头像在白名单内、游戏与标签取自目录、**大区必须属于所选游戏**、
 * `enabled=false` 强制 `available=false`、`available=false` 必须给出原因。
 */
export type AdminCompanionProfilePatch = {
  displayName: string;
  avatarUrl: string;
  intro: string;
  gameIds: string[];
  regions: string[];
  serviceTags: string[];
  enabled: boolean;
  available: boolean;
  unavailableReason: string;
  sortOrder: number;
};

/** 护航写操作的结果（编辑 / 暂停 / 恢复 / 启用 / 停用 / 移除共用）。 */
export type AdminCompanionWriteResult = {
  companionId: string;
  enabled: boolean;
  available: boolean;
  unavailableReason: string;
  removedAt: string | null;
  /**
   * 这一次是否真的改动了数据。
   *
   * 重复提交（同一幂等键）、或「本来就是这个状态」时为 `false`——
   * 两者都不是错误：前者是幂等重放，后者是无可变更。**两种情形都不写审计记录**，
   * 因此「每项写操作有且只有一条审计」这条规则在多按几次之后依然成立。
   */
  changed: boolean;
};

/**
 * 管理端护航**列表**一次取回的全部数据。
 *
 * 定义在这里而不是服务层：服务端页面与浏览器端 `lib/services/adminHttp.ts` 拿的是
 * 同一个形状，类型只有一处，两边不会各自漂移。
 */
export type AdminCompanionListData = AdminCompanionPage & {
  /** 筛选栏的游戏选项：取自真实游戏数据，不写死第二份名单 */
  games: CompanionGameTag[];
  /** 各状态条数，与概览页同一个统计口径（`countCompanionStates`） */
  counts: { enabled: number; disabled: number; unavailable: number; total: number };
  /** 口径说明，页面顶部展示 */
  notice: string;
};

/**
 * 编辑表单要用的游戏选项。
 *
 * ⚠️ 比 `CompanionGameTag` 多一个 `regions`：大区必须属于**所选游戏**，
 * 因此表单需要「选了哪些游戏 → 可选哪些大区」这份映射，否则只能让人手打大区，
 * 而服务端一定会把它判为「所选大区不属于已选的游戏」。
 */
export type CompanionGameOption = CompanionGameTag & {
  regions: string[];
};
