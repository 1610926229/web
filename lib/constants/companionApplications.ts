import type { EvidenceKind } from "@/lib/types/evidence";
import type {
  CompanionApplication,
  CompanionApplicationDetail,
  CompanionApplicationStatus,
  CompanionApplicationTimelineEntry,
} from "@/lib/types/companionApplication";
import { countCharacters } from "@/lib/utils/text";

/**
 * 护航入驻申请的表单规则、状态机与时间轴（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除 `lib/utils/text.ts`（字符计数）外没有运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 四条边界，本文件是它们唯一被写下来的地方：
 *
 * 1. **用户能造出来的状态只有两种**：提交产生 `pending`，撤销产生 `withdrawn`。
 *    `reviewing` / `approved` / `rejected` 只能来自预置数据或将来后台的返回——
 *    本阶段没有任何面向用户的改状态接口，页面上也没有「模拟通过 / 模拟拒绝」按钮。
 * 2. **通过申请不等于成为护航**：审核结果与用户角色、陪玩公开资料、接单权限之间的
 *    规则尚未确认，因此文案里不承诺「已开通接单权限」这类结论。
 * 3. **不收集敏感信息**：没有真实姓名、身份证、银行卡、住址、微信标识。
 *    联系方式只留一个明确标注为 Mock 的纯文本说明。
 * 4. **时间轴只列已经发生的节点**，不编造未来的审核时间。
 */

export const COMPANION_JOIN_PAGE_TITLE = "成为护航";
export const COMPANION_JOIN_STATUS_PAGE_TITLE = "入驻进度";

/** 表单与进度页顶部的 Mock 标注。 */
export const COMPANION_APPLICATION_MOCK_NOTICE =
  "入驻申请与审核结果均为本地 Mock 数据，凭证以占位图展示；本阶段不接真实上传，也不接任何真实审核流程。";

/** 提交前的说明。**不承诺任何回报，也不承诺处理时限**。 */
export const COMPANION_APPLICATION_SUBMIT_NOTE =
  "提交后由平台查看，本阶段不会因为提交申请自动获得打手身份、接单权限或任何收益；审核规则待确认。";

/** 已经有一条申请时的提示。 */
export const COMPANION_APPLICATION_EXISTS_MESSAGE = "你已有一条入驻申请，请在入驻进度页查看";

// ——————————————————————————— 状态机 ———————————————————————————

export const COMPANION_APPLICATION_STATUSES: readonly CompanionApplicationStatus[] = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "withdrawn",
];

export const COMPANION_APPLICATION_STATUS_LABELS: Record<CompanionApplicationStatus, string> = {
  pending: "待查看",
  reviewing: "审核中",
  approved: "已通过",
  rejected: "未通过",
  withdrawn: "已撤销",
};

/** 状态文字色。颜色令牌集中在 `app/globals.css`，这里只引用，不写死色值。 */
export const COMPANION_APPLICATION_STATUS_CLASS: Record<CompanionApplicationStatus, string> = {
  pending: "text-status-pending",
  reviewing: "text-status-info",
  approved: "text-status-success",
  rejected: "text-status-danger",
  withdrawn: "text-status-muted",
};

export function isCompanionApplicationStatus(value: string): value is CompanionApplicationStatus {
  return (COMPANION_APPLICATION_STATUSES as readonly string[]).includes(value);
}

/** 只有「待查看」可以由用户撤销。其余状态一律不可以——这条规则只写在这里。 */
export function canWithdrawCompanionApplication(status: CompanionApplicationStatus): boolean {
  return status === "pending";
}

/**
 * 「已有一条申请，所以不再显示表单」时给用户看的说明。
 *
 * `rejected` 与 `withdrawn` 的区别很重要：一条说明**被拒的原因**，另一条说明**是自己撤销的**；
 * 但两者都只能如实说「重新申请规则待确认」，不能给出一个本阶段并不存在的「重新申请」按钮。
 */
export const COMPANION_APPLICATION_EXISTING_HINTS: Record<CompanionApplicationStatus, string> = {
  pending: "你的入驻申请已提交，正在等待平台查看。审核规则待确认，本阶段不能重复提交。",
  reviewing: "你的入驻申请正在审核中。审核规则待确认，本阶段不能重复提交。",
  approved:
    "你的入驻申请已通过。陪玩公开资料、接单权限与收益规则的绑定方式待确认，本阶段不会自动开通。",
  rejected: "这次入驻申请未通过。重新申请规则待确认，本阶段不能再次提交。",
  withdrawn: "你已撤销这次入驻申请。重新申请规则待确认，本阶段不能再次提交。",
};

/** 时间轴节点的说明文案。 */
const TIMELINE_NOTES: Record<CompanionApplicationStatus, string> = {
  pending: "入驻申请已提交，等待平台查看",
  reviewing: "平台已开始查看这份申请",
  approved: "入驻申请已通过",
  rejected: "入驻申请未通过",
  withdrawn: "你撤销了这次入驻申请",
};

/**
 * 申请时间轴。
 *
 * **只列已经发生的节点**：没有发生的步骤既不补一个「待审核」占位，
 * 也不推测时间。审核备注只在有结果时作为对应节点的说明出现。
 */
export function buildCompanionApplicationTimeline(
  application: Pick<
    CompanionApplication,
    "status" | "submittedAt" | "updatedAt" | "reviewedAt" | "reviewNote"
  >,
): CompanionApplicationTimelineEntry[] {
  const entries: CompanionApplicationTimelineEntry[] = [
    {
      key: "pending",
      label: COMPANION_APPLICATION_STATUS_LABELS.pending,
      at: application.submittedAt,
      note: TIMELINE_NOTES.pending,
    },
  ];

  const { status } = application;

  if (status === "reviewing") {
    entries.push({
      key: "reviewing",
      label: COMPANION_APPLICATION_STATUS_LABELS.reviewing,
      // 实体里没有单独的「开始审核时间」字段，状态变更时间就是它的时间
      at: application.updatedAt,
      note: TIMELINE_NOTES.reviewing,
    });
  }

  if ((status === "approved" || status === "rejected") && application.reviewedAt) {
    entries.push({
      key: status,
      label: COMPANION_APPLICATION_STATUS_LABELS[status],
      at: application.reviewedAt,
      note: application.reviewNote || TIMELINE_NOTES[status],
    });
  }

  if (status === "withdrawn") {
    entries.push({
      key: "withdrawn",
      label: COMPANION_APPLICATION_STATUS_LABELS.withdrawn,
      at: application.updatedAt,
      note: TIMELINE_NOTES.withdrawn,
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

// ——————————————————————————— 表单字段约束 ———————————————————————————

/** 昵称上限。与用户昵称同为 20，两处口径一致。 */
export const COMPANION_APPLICATION_NAME_MAX_LENGTH = 20;
export const COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH = 200;
export const COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH = 300;
export const COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH = 50;

/** 凭证数量上限与允许的类型：与原型「上传照片」一致，只收图片。 */
export const COMPANION_APPLICATION_EVIDENCE_MAX_COUNT = 4;
export const COMPANION_APPLICATION_EVIDENCE_KINDS: readonly EvidenceKind[] = ["image"];

/**
 * 服务标签目录。
 *
 * ⚠️ 取值是**开发阶段的 Mock 规则**，不是平台已确认的服务分类；
 * 与游戏大区一样用纯文本，因为它只是展示与筛选用的标签，没有独立业务含义。
 */
export const COMPANION_SERVICE_TAGS: readonly string[] = [
  "护航",
  "陪练",
  "上分",
  "语音开黑",
  "新手带打",
];

export const COMPANION_APPLICATION_NAME_EMPTY_MESSAGE = "请填写陪玩昵称";
export const COMPANION_APPLICATION_NAME_TOO_LONG_MESSAGE = `陪玩昵称不能超过 ${COMPANION_APPLICATION_NAME_MAX_LENGTH} 个字符`;
export const COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE = "请至少选择一个擅长游戏";
export const COMPANION_APPLICATION_GAME_INVALID_MESSAGE = "所选游戏不是有效游戏，请重新选择";
export const COMPANION_APPLICATION_REGION_REQUIRED_MESSAGE = "请至少选择一个可服务的大区";
export const COMPANION_APPLICATION_REGION_INVALID_MESSAGE =
  "所选大区不属于已选的游戏，请重新选择";
export const COMPANION_APPLICATION_TAG_REQUIRED_MESSAGE = "请至少选择一个服务标签";
export const COMPANION_APPLICATION_TAG_INVALID_MESSAGE = "所选服务标签无效，请重新选择";
export const COMPANION_APPLICATION_EXPERIENCE_EMPTY_MESSAGE = "请填写经验说明";
export const COMPANION_APPLICATION_EXPERIENCE_TOO_LONG_MESSAGE = `经验说明不能超过 ${COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH} 个字符`;
export const COMPANION_APPLICATION_INTRODUCTION_EMPTY_MESSAGE = "请填写自我介绍";
export const COMPANION_APPLICATION_INTRODUCTION_TOO_LONG_MESSAGE = `自我介绍不能超过 ${COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH} 个字符`;
export const COMPANION_APPLICATION_CONTACT_NOTE_TOO_LONG_MESSAGE = `联系说明不能超过 ${COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH} 个字符`;

/** 进度页上给联系说明加的一句限定：它只是说明，不是平台已确认的联系方式。 */
export const COMPANION_APPLICATION_CONTACT_NOTE_HINT =
  "选填。这里只收一句便于联系的说明（纯文本），本阶段不采集手机号、微信号、QQ、邮箱等具体联系方式。";

// ——————————————————————————— 表单校验 ———————————————————————————

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

function normalizeText(raw: string, max: number, empty: string, tooLong: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: empty };
  if (countCharacters(value) > max) return { ok: false, message: tooLong };
  return { ok: true, value };
}

/** 昵称：去首尾空格后非空，且不超长。 */
export function normalizeCompanionApplicationName(raw: string): FieldResult<string> {
  return normalizeText(
    raw,
    COMPANION_APPLICATION_NAME_MAX_LENGTH,
    COMPANION_APPLICATION_NAME_EMPTY_MESSAGE,
    COMPANION_APPLICATION_NAME_TOO_LONG_MESSAGE,
  );
}

export function normalizeCompanionApplicationExperience(raw: string): FieldResult<string> {
  return normalizeText(
    raw,
    COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH,
    COMPANION_APPLICATION_EXPERIENCE_EMPTY_MESSAGE,
    COMPANION_APPLICATION_EXPERIENCE_TOO_LONG_MESSAGE,
  );
}

export function normalizeCompanionApplicationIntroduction(raw: string): FieldResult<string> {
  return normalizeText(
    raw,
    COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH,
    COMPANION_APPLICATION_INTRODUCTION_EMPTY_MESSAGE,
    COMPANION_APPLICATION_INTRODUCTION_TOO_LONG_MESSAGE,
  );
}

/** 联系说明：**选填**，只校验长度。 */
export function normalizeCompanionApplicationContactNote(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (countCharacters(value) > COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH) {
    return { ok: false, message: COMPANION_APPLICATION_CONTACT_NOTE_TOO_LONG_MESSAGE };
  }
  return { ok: true, value };
}

/** 表单的错误提示（从当前输入推导，不额外存一份状态）。 */
export type CompanionApplicationFieldErrors = {
  displayName: string | null;
  gameIds: string | null;
  regions: string | null;
  serviceTags: string | null;
  experience: string | null;
  introduction: string | null;
  contactNote: string | null;
};

/**
 * 推导表单各字段的错误。
 *
 * 与「编辑资料」「评价表单」「反馈表单」同一套做法：
 * - **超限是实时的**（打字时就该看到自己超了），但「请填写」只在点过提交之后出现，
 *   否则用户刚打开表单就是一片红；
 * - 输入框**不使用 `maxLength` 静默截断**：可以一直输入，由这里给出错误提示。
 */
export function companionApplicationFieldErrors(input: {
  displayName: string;
  gameIds: readonly string[];
  regions: readonly string[];
  serviceTags: readonly string[];
  experience: string;
  introduction: string;
  contactNote: string;
  /** 是否已经点过一次提交 */
  attempted: boolean;
}): CompanionApplicationFieldErrors {
  const name = input.displayName.trim();
  const experience = input.experience.trim();
  const introduction = input.introduction.trim();

  const required = (value: string, message: string) =>
    value ? null : input.attempted ? message : null;

  return {
    displayName: name
      ? countCharacters(name) > COMPANION_APPLICATION_NAME_MAX_LENGTH
        ? COMPANION_APPLICATION_NAME_TOO_LONG_MESSAGE
        : null
      : required(name, COMPANION_APPLICATION_NAME_EMPTY_MESSAGE),
    gameIds: input.gameIds.length > 0
      ? null
      : input.attempted
        ? COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE
        : null,
    regions:
      input.regions.length > 0
        ? null
        : input.attempted
          ? COMPANION_APPLICATION_REGION_REQUIRED_MESSAGE
          : null,
    serviceTags:
      input.serviceTags.length > 0
        ? null
        : input.attempted
          ? COMPANION_APPLICATION_TAG_REQUIRED_MESSAGE
          : null,
    experience: experience
      ? countCharacters(experience) > COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH
        ? COMPANION_APPLICATION_EXPERIENCE_TOO_LONG_MESSAGE
        : null
      : required(experience, COMPANION_APPLICATION_EXPERIENCE_EMPTY_MESSAGE),
    introduction: introduction
      ? countCharacters(introduction) > COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH
        ? COMPANION_APPLICATION_INTRODUCTION_TOO_LONG_MESSAGE
        : null
      : required(introduction, COMPANION_APPLICATION_INTRODUCTION_EMPTY_MESSAGE),
    contactNote:
      countCharacters(input.contactNote.trim()) > COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH
        ? COMPANION_APPLICATION_CONTACT_NOTE_TOO_LONG_MESSAGE
        : null,
  };
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 内部实体 → 进度页详情 DTO。
 *
 * 显式挑字段：`userId` 不出现在响应里。`reviewNote` 只在有值时透出——
 * 没有结果时给一个空串，前端不会画出「审核备注：」这一行。
 */
export function toCompanionApplicationDetail(
  application: CompanionApplication,
  gameNameById: Readonly<Record<string, string>>,
): CompanionApplicationDetail {
  return {
    id: application.id,
    applicationNo: application.applicationNo,
    status: application.status,
    statusLabel: COMPANION_APPLICATION_STATUS_LABELS[application.status],
    submittedAt: application.submittedAt,
    updatedAt: application.updatedAt,

    displayName: application.displayName,
    games: application.gameIds.map((id) => ({ id, name: gameNameById[id] ?? id })),
    regions: [...application.regions],
    serviceTags: [...application.serviceTags],
    experience: application.experience,
    introduction: application.introduction,
    contactNote: application.contactNote,
    evidence: application.evidence,

    reviewNote: application.reviewNote,
    reviewedAt: application.reviewedAt,
    timeline: buildCompanionApplicationTimeline(application),

    // 权限由服务端给出：前端只按这个值显示撤销按钮，不拿状态自己判断
    allowedActions: { canWithdraw: canWithdrawCompanionApplication(application.status) },
  };
}
