import { COMPANION_APPLICATION_STATUS_LABELS, buildCompanionApplicationTimeline } from "@/lib/constants/companionApplications";
import type {
  AdminCompanionApplicationAllowedActions,
  AdminCompanionApplicationDetail,
  AdminCompanionApplicationListItem,
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import { countCharacters } from "@/lib/utils/text";
import { clampPage, clampPageSize } from "./pagination";
import { readCompanionGameId, readCompanionKeyword } from "./companions";

/**
 * 管理端「入驻审核」的筛选规则、状态机与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型、`./pagination`、`./companions` 与 `lib/utils/text.ts` 外没有运行时依赖，
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三条规则写在这里，是本阶段新增的**唯一**落点：
 *
 * 1. **状态机**（§六）：`pending → reviewing | approved | rejected`；
 *    `reviewing → approved | rejected`；`approved` / `rejected` / `withdrawn`
 *    是**终态**，从终态出发没有任何合法迁移。「开始审核」只把状态改成 `reviewing`，
 *    它不等于通过、也不产生任何护航资料。
 * 2. **可执行动作由服务端给出**：`adminApplicationAllowedActions()` 是唯一实现，
 *    列表页与详情页都不拿状态自己写 `if`。前端多一处判断，就多一处会跟服务端分叉的规则。
 * 3. **拒绝必须填写审核意见**：校验只写在 `normalizeAdminReviewNote()` 一处。
 */

export const ADMIN_APPLICATION_LIST_TITLE = "入驻申请";
export const ADMIN_APPLICATION_DETAIL_TITLE = "申请详情";

/** 列表默认每页条数。后台是 PC 宽屏，比用户端一页多放几条。 */
export const ADMIN_APPLICATION_PAGE_SIZE = 10;
export const ADMIN_APPLICATION_MAX_PAGE_SIZE = 50;
export const ADMIN_APPLICATION_MAX_PAGE = 1000;

/** 列表顶部的说明：讲清楚这张列表的口径与动作后果。 */
export const ADMIN_APPLICATION_LIST_NOTICE =
  "列表默认按提交时间倒序。通过申请会新增（或关联）一条护航资料并发放护航资格，" +
  "申请人原有的老板身份不变；这两件事与审核记录一起写入，不会出现只写一半的状态。";

/** 列表为空时的提示。 */
export const ADMIN_APPLICATION_EMPTY_MESSAGE = "当前筛选下没有入驻申请。";

// ——————————————————————————— 状态筛选 ———————————————————————————

/**
 * 状态筛选。`all` 表示不限。
 *
 * `withdrawn` 可以筛、但不进概览的统计卡片——撤销是用户自己的动作，
 * 不是平台待处理的工作量；列表里却必须能看到它，否则「这个人为什么没通过」
 * 会变成一个查不到答案的问题。
 */
export type AdminApplicationStatusFilter = CompanionApplicationStatus | "all";

export const ADMIN_APPLICATION_STATUS_FILTERS: readonly AdminApplicationStatusFilter[] = [
  "all",
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "withdrawn",
];

export const ADMIN_APPLICATION_STATUS_FILTER_LABELS: Record<AdminApplicationStatusFilter, string> =
  {
    all: "全部",
    ...COMPANION_APPLICATION_STATUS_LABELS,
  };

/**
 * 默认筛选：**待查看**。
 *
 * 不默认「全部」是刻意的：这个页面的主要用途是处理待办，打开就是几十条历史记录
 * 并不好用。地址栏参数非法时也收敛到它（`normalizeAdminApplicationStatusFilter`），
 * 一个手改坏了的地址不该变成错误页。
 */
export const DEFAULT_ADMIN_APPLICATION_STATUS_FILTER: AdminApplicationStatusFilter = "pending";

export const ADMIN_APPLICATION_STATUS_INVALID_MESSAGE =
  "筛选条件 status 只能是 all / pending / reviewing / approved / rejected / withdrawn";

export function isAdminApplicationStatusFilter(value: string): value is AdminApplicationStatusFilter {
  return (ADMIN_APPLICATION_STATUS_FILTERS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认筛选处理。 */
export function readAdminApplicationStatusFilter(
  raw: string | null,
): AdminApplicationStatusFilter | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_APPLICATION_STATUS_FILTER;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_APPLICATION_STATUS_FILTER;
  return isAdminApplicationStatusFilter(value) ? value : null;
}

/** 宽松规范化：非法值回到默认筛选（页面地址栏用）。 */
export function normalizeAdminApplicationStatusFilter(
  raw: string | null,
): AdminApplicationStatusFilter {
  return readAdminApplicationStatusFilter(raw) ?? DEFAULT_ADMIN_APPLICATION_STATUS_FILTER;
}

// ——————————————————————————— 状态机 ———————————————————————————

/**
 * 合法迁移表。**这是状态机唯一的定义处。**
 *
 * 终态写空数组而不是省略：`Record` 要求每个状态都出现，
 * 将来新增一个状态时，漏掉它的迁移规则会直接编译不过。
 */
export const ADMIN_APPLICATION_TRANSITIONS: Record<
  CompanionApplicationStatus,
  readonly CompanionApplicationStatus[]
> = {
  pending: ["reviewing", "approved", "rejected"],
  reviewing: ["approved", "rejected"],
  approved: [],
  rejected: [],
  withdrawn: [],
};

/** 这次迁移是否合法。`from === to` 一律不合法（那不是一个「迁移」）。 */
export function canTransitionCompanionApplication(
  from: CompanionApplicationStatus,
  to: CompanionApplicationStatus,
): boolean {
  return ADMIN_APPLICATION_TRANSITIONS[from].includes(to);
}

/**
 * 服务端判定的可执行动作。
 *
 * 三个动作都是「迁移到某个状态」的别名，因此它们全从 `ADMIN_APPLICATION_TRANSITIONS`
 * 推导，没有第二条规则：终态（已通过 / 未通过 / 已撤销）三项都是 false。
 */
export function adminApplicationAllowedActions(
  status: CompanionApplicationStatus,
): AdminCompanionApplicationAllowedActions {
  return {
    canStartReview: canTransitionCompanionApplication(status, "reviewing"),
    canApprove: canTransitionCompanionApplication(status, "approved"),
    canReject: canTransitionCompanionApplication(status, "rejected"),
  };
}

/** 没有可执行动作时的说明。页面据此显示一行原因，而不是给一排灰按钮。 */
export const ADMIN_APPLICATION_TERMINAL_NOTICE = "这份申请已结束，没有可执行的动作。";

/** 服务端拒绝写操作时的提示。与接口 400 / 404 的 message 同源。 */
export const ADMIN_APPLICATION_NOT_FOUND_MESSAGE = "入驻申请不存在";
export const ADMIN_APPLICATION_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_APPLICATION_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/**
 * 状态机拒绝了这次迁移时的提示。
 *
 * **带上当前状态**：接口返回「当前状态是『未通过』，不能通过审核」比一句
 * 「操作不合法」有用得多——后者会让人以为是自己点错了按钮。
 */
export function adminApplicationTransitionMessage(status: CompanionApplicationStatus): string {
  return `当前状态是「${COMPANION_APPLICATION_STATUS_LABELS[status]}」，不能执行这个操作`;
}

/**
 * 通过 / 拒绝的二次确认文案。
 *
 * 通过那条要说清楚**会发生什么**：它会真的建出一条护航资料并发放资格，
 * 不是「改个状态」。拒绝那条要说清楚申请人会看到什么。
 */
export const ADMIN_APPLICATION_CONFIRM_TEXTS = {
  approve:
    "通过后会给申请人追加护航资格，并创建（或关联）一条护航资料；" +
    "对方的老板身份不变。这三件事与审核记录一起写入。确定通过？",
  reject: "拒绝后申请人看到的进度页会变成「未通过」，审核意见会展示给对方。确定拒绝？",
} as const;

/** 按钮文案。列表与详情共用同一份。 */
export const ADMIN_APPLICATION_ACTION_LABELS = {
  startReview: "开始审核",
  approve: "通过",
  reject: "拒绝",
} as const;;

// ——————————————————————————— 审核意见 ———————————————————————————

export const ADMIN_REVIEW_NOTE_MAX_LENGTH = 200;

export const ADMIN_REVIEW_NOTE_EMPTY_MESSAGE = "请填写审核意见";
export const ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE = `审核意见不能超过 ${ADMIN_REVIEW_NOTE_MAX_LENGTH} 个字符`;

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 审核意见（拒绝时必填）。
 *
 * ⚠️ 这条规则**只在服务端生效一次**，但校验实现写在这里，两端共用：
 * 前端用它做即时提示，服务端用同一份函数做最终判定，因此不会出现
 * 「前端说可以提交、服务端却拒绝」这种对不上的情况。
 *
 * 通过申请时不需要理由，此时传空串会失败——因此调用方在「通过」这条路径上
 * 根本不该调用它（`reviewNote` 不是通过的入参）。
 */
export function normalizeAdminReviewNote(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: ADMIN_REVIEW_NOTE_EMPTY_MESSAGE };
  if (countCharacters(value) > ADMIN_REVIEW_NOTE_MAX_LENGTH) {
    return { ok: false, message: ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

// ——————————————————————————— 列表查询 ———————————————————————————

/**
 * 管理端申请列表查询条件（已解析、已校验）。
 *
 * 排序**不是参数**：默认（也是唯一）的排序是按提交时间倒序，见 `compareApplicationsForAdmin`。
 * 做成参数只会让人以为可以按别的字段排，而「按状态排」在分页下几乎总是错的用法。
 */
export type AdminApplicationListQuery = {
  /** `all` 表示不限状态 */
  status: AdminApplicationStatusFilter;
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
  page: number;
  pageSize: number;
};

/** 关键词：只去首尾空格。搜索词不是业务枚举，过长不会造成危害，也不静默截断。 */
export function readAdminApplicationKeyword(raw: string | null): string {
  return readCompanionKeyword(raw);
}

/** 游戏筛选：必须是真实存在的游戏，未知 id 返回 null（由接口抛 400）。 */
export function readAdminApplicationGameId(
  raw: string | null,
  knownGameIds: readonly string[],
): string | null {
  return readCompanionGameId(raw, knownGameIds);
}

export function buildAdminApplicationListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的状态筛选（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  status: AdminApplicationStatusFilter;
  /** 已经解析好的游戏筛选；空串表示全部游戏 */
  gameId: string;
}): AdminApplicationListQuery {
  return {
    status: input.status,
    keyword: readAdminApplicationKeyword(input.params.get("keyword")),
    gameId: input.gameId,
    page: clampPage(input.params.get("page"), ADMIN_APPLICATION_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_APPLICATION_PAGE_SIZE,
      ADMIN_APPLICATION_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * 默认排序：提交时间倒序，同一时间按 id 兜底。
 *
 * 兜底那一层不是可有可无的：两条申请的时间戳相同（预置数据里就有）时，
 * 顺序不确定会让同一条在第一页出现过、翻到第二页又出现一次。
 */
export function compareApplicationsForAdmin(
  a: Pick<CompanionApplication, "submittedAt" | "id">,
  b: Pick<CompanionApplication, "submittedAt" | "id">,
): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 关键词是否命中：**申请单号 / 陪玩昵称**两处任一包含即可。
 *
 * 只用这两个字段，是因为它们正是审核的人手里能拿到的东西——申请人报的是单号或昵称。
 * 正文（经验说明 / 自我介绍）不参与搜索：那是内容，不是标识，用它搜出来的结果
 * 没人能预期。
 */
export function applicationMatchesAdminKeyword(
  application: Pick<CompanionApplication, "applicationNo" | "displayName">,
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  if (application.applicationNo.toLowerCase().includes(needle)) return true;
  return application.displayName.toLowerCase().includes(needle);
}

// ——————————————————————————— DTO 转换 ———————————————————————————

function toGames(
  gameIds: readonly string[],
  gameNameById: Readonly<Record<string, string>>,
): { id: string; name: string }[] {
  return gameIds.map((id) => ({ id, name: gameNameById[id] ?? id }));
}

/**
 * 内部实体 → 管理端列表项。
 *
 * ⚠️ **显式挑字段**，不是 `{ ...application }` 再删几个：正文、联系说明、凭证、
 * 审核意见与 `userId` 因此默认不会外流——只有写在这里的字段才会被浏览器看到。
 * 与公开 DTO 的做法完全一致（见 `lib/constants/companions.ts` 的 `toCompanionBase`）。
 */
export function toAdminCompanionApplicationListItem(
  application: CompanionApplication,
  gameNameById: Readonly<Record<string, string>>,
): AdminCompanionApplicationListItem {
  return {
    id: application.id,
    applicationNo: application.applicationNo,
    status: application.status,
    statusLabel: COMPANION_APPLICATION_STATUS_LABELS[application.status],
    displayName: application.displayName,
    games: toGames(application.gameIds, gameNameById),
    regions: [...application.regions],
    serviceTags: [...application.serviceTags],
    submittedAt: application.submittedAt,
    updatedAt: application.updatedAt,
    reviewedAt: application.reviewedAt,
  };
}

/** 申请人摘要的输入：由服务层从用户仓储与资格/护航仓储取好，本层只做拼装。 */
export type AdminApplicantSummaryInput = {
  userId: string;
  nickname: string;
  linkedCompanionId: string | null;
  hasCompanionQualification: boolean;
};

/** 内部实体 → 管理端详情。在列表项之上补齐正文、凭证、申请人摘要与可执行动作。 */
export function toAdminCompanionApplicationDetail(
  application: CompanionApplication,
  gameNameById: Readonly<Record<string, string>>,
  applicant: AdminApplicantSummaryInput,
): AdminCompanionApplicationDetail {
  return {
    ...toAdminCompanionApplicationListItem(application, gameNameById),
    experience: application.experience,
    introduction: application.introduction,
    contactNote: application.contactNote,
    evidence: application.evidence,
    reviewNote: application.reviewNote,
    applicant,
    timeline: buildCompanionApplicationTimeline(application),
    allowedActions: adminApplicationAllowedActions(application.status),
  };
}
