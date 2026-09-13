import type { EvidenceKind } from "@/lib/types/evidence";
import type {
  SuggestionListItem,
  SuggestionPage,
  SuggestionStatus,
  SuggestionTypeKey,
} from "@/lib/types/suggestion";
import { countCharacters } from "@/lib/utils/text";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 意见反馈的类型、状态与表单规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除 `lib/utils/text.ts`（字符计数）与 `./pagination`（纯函数）外没有运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三条规则写在这里，页面与接口共用同一份实现：
 *
 * 1. **状态由平台侧决定**：用户的反馈只会以「已提交」创建，「已回复 / 已关闭」
 *    只能来自预置数据或将来后台的返回；
 * 2. **字数由 `countCharacters` 计算**（汉字、字母、普通 Emoji 都算 1 个），
 *    与昵称、简介、评价正文用的是同一套计数规则；
 * 3. **不承诺任何回报**：文案里不出现奖励、补偿、返现这类平台没有承诺过的结论。
 */

export const SUGGESTION_PAGE_TITLE = "功能建议";
export const SUGGESTION_CREATE_PAGE_TITLE = "我要反馈";

/** 三个状态，顺序与列表卡片的展示顺序一致（进行中在前，结束的在后）。 */
export const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ["submitted", "replied", "closed"];

export const SUGGESTION_STATUS_LABELS: Record<SuggestionStatus, string> = {
  submitted: "已提交",
  replied: "已回复",
  closed: "已关闭",
};

export const SUGGESTION_STATUS_CLASS: Record<SuggestionStatus, string> = {
  submitted: "text-status-pending",
  replied: "text-status-success",
  closed: "text-status-muted",
};

/** 状态说明。**只说明处在哪一步，不承诺任何处理结论**。 */
export const SUGGESTION_STATUS_HINTS: Record<SuggestionStatus, string> = {
  submitted: "建议已提交，平台会查看你的反馈。",
  replied: "平台已回复，回复内容见下方。",
  closed: "本次建议已关闭。",
};

export function isSuggestionStatus(value: string): value is SuggestionStatus {
  return (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

/** 反馈类型。**必选**，取值由服务端校验，文案只此一份。 */
export const SUGGESTION_TYPES: readonly { key: SuggestionTypeKey; label: string }[] = [
  { key: "feature", label: "功能建议" },
  { key: "experience", label: "体验问题" },
  { key: "content", label: "内容问题" },
  { key: "other", label: "其他" },
];

export const SUGGESTION_TYPE_LABELS = SUGGESTION_TYPES.reduce<Record<string, string>>(
  (labels, item) => {
    labels[item.key] = item.label;
    return labels;
  },
  {},
);

export function isSuggestionType(value: string): value is SuggestionTypeKey {
  return SUGGESTION_TYPES.some((item) => item.key === value);
}

/**
 * 反馈正文的长度上限。
 *
 * 原型没有标注字数上限，这里取一个**保守的 Mock 上限**并写在唯一一处
 * （与投诉描述同为 300，两处口径一致，将来确认后只改这一个常量）。
 */
export const SUGGESTION_CONTENT_MAX_LENGTH = 300;

/** 联系方式长度上限。联系方式是**选填**，本阶段不采集更敏感的信息。 */
export const SUGGESTION_CONTACT_MAX_LENGTH = 50;

/** 反馈凭证数量上限。与评价一致：原型写的是「最多 4 张」，因此只收图片。 */
export const SUGGESTION_EVIDENCE_MAX_COUNT = 4;

/**
 * 反馈凭证允许的类型。
 *
 * 与 `SUGGESTION_EVIDENCE_MAX_COUNT` 一起传给 `EvidencePicker` 与服务端的
 * `parseEvidenceInput`：界面上的入口、提示文案、服务端校验用的是同一个数组。
 */
export const SUGGESTION_EVIDENCE_KINDS: readonly EvidenceKind[] = ["image"];

export const SUGGESTION_TYPE_REQUIRED_MESSAGE = "请选择反馈类型";
export const SUGGESTION_CONTENT_EMPTY_MESSAGE = "请填写反馈内容";
export const SUGGESTION_CONTENT_TOO_LONG_MESSAGE = `反馈内容不能超过 ${SUGGESTION_CONTENT_MAX_LENGTH} 个字符`;
export const SUGGESTION_CONTACT_TOO_LONG_MESSAGE = `联系方式不能超过 ${SUGGESTION_CONTACT_MAX_LENGTH} 个字符`;

/** 提交后给用户看的说明。**不承诺任何回报**，也不替平台许下处理时限。 */
export const SUGGESTION_SUBMIT_NOTE =
  "反馈会记录给平台，不会因为提交建议自动获得奖励或补偿；平台回复以实际反馈为准。";

/** 列表顶部的 Mock 标注。 */
export const SUGGESTION_MOCK_NOTICE =
  "反馈记录与平台回复均为本地 Mock 数据，凭证以占位图展示。反馈不影响订单金额，也不参与消费等级计算。";

/** 列表默认每页条数。 */
export const SUGGESTION_PAGE_SIZE = 10;

export const SUGGESTION_MAX_PAGE_SIZE = 20;

/** 页码上限：与订单、投诉列表共用 `clampPage` 的默认上限。 */
export const SUGGESTION_MAX_PAGE = 1000;

// ——————————————————————————— 查询条件 ———————————————————————————

export type SuggestionListQuery = {
  page: number;
  pageSize: number;
};

/**
 * 解析反馈列表的查询条件。
 *
 * 本阶段**没有状态筛选**（原型上也没有），因此只有分页参数：非法值走规范化，
 * 坏掉的页码不该让整页报错。分页参数的解析规则与订单 / 投诉 / 评价列表一致。
 */
export function parseSuggestionListQuery(params: URLSearchParams): SuggestionListQuery {
  return {
    page: clampPage(params.get("page"), SUGGESTION_MAX_PAGE),
    pageSize: clampPageSize(params.get("pageSize"), SUGGESTION_PAGE_SIZE, SUGGESTION_MAX_PAGE_SIZE),
  };
}

// ——————————————————————————— 排序与转换 ———————————————————————————

/**
 * 默认排序：提交时间倒序，最新的在最前面。
 *
 * 时间相同时用 id 兜底，保证同一份数据每次排出来的顺序**完全一致**——
 * 否则分页时可能出现同一条反馈在第一页出现过、第二页又出现一次。
 */
export function compareSuggestionsNewestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 反馈 → 列表项。**显式挑字段**：`userId` 不出现在接口响应里。 */
export function toSuggestionListItem(suggestion: {
  id: string;
  typeKey: SuggestionTypeKey;
  typeLabel: string;
  content: string;
  contact: string;
  evidence: SuggestionListItem["evidence"];
  status: SuggestionStatus;
  reply: string;
  repliedAt: string | null;
  createdAt: string;
}): SuggestionListItem {
  return {
    id: suggestion.id,
    typeKey: suggestion.typeKey,
    typeLabel: suggestion.typeLabel,
    content: suggestion.content,
    contact: suggestion.contact,
    evidence: suggestion.evidence,
    status: suggestion.status,
    // 文案在这里补上：前端不自己维护一份状态映射，两侧不会出现不一致的说法
    statusLabel: SUGGESTION_STATUS_LABELS[suggestion.status],
    reply: suggestion.reply,
    repliedAt: suggestion.repliedAt,
    createdAt: suggestion.createdAt,
  };
}

/** 「加载更多」的合并：追加 + 去重，通用规则见 `lib/constants/pagination.ts`。 */
export function mergeSuggestionPage(current: SuggestionPage, next: SuggestionPage): SuggestionPage {
  return mergePageResult(current, next);
}

// ——————————————————————————— 表单校验 ———————————————————————————

/** 正文的规范化结果：去首尾空格后按字符数校验。 */
export function normalizeSuggestionContent(
  raw: string,
): { ok: true; content: string } | { ok: false; message: string } {
  const content = raw.trim();
  if (!content) return { ok: false, message: SUGGESTION_CONTENT_EMPTY_MESSAGE };
  if (countCharacters(content) > SUGGESTION_CONTENT_MAX_LENGTH) {
    return { ok: false, message: SUGGESTION_CONTENT_TOO_LONG_MESSAGE };
  }
  return { ok: true, content };
}

/** 联系方式的规范化结果：选填，只校验长度。 */
export function normalizeSuggestionContact(
  raw: string,
): { ok: true; contact: string } | { ok: false; message: string } {
  const contact = raw.trim();
  if (countCharacters(contact) > SUGGESTION_CONTACT_MAX_LENGTH) {
    return { ok: false, message: SUGGESTION_CONTACT_TOO_LONG_MESSAGE };
  }
  return { ok: true, contact };
}

/**
 * 表单字段的错误提示。
 *
 * 与「编辑资料」「评价表单」同一套做法：错误从当前输入**推导**出来，不额外存一份状态，
 * 用户改到合法之后提示自动消失；「请填写反馈内容」只在点过提交之后出现，
 * 而超限是**实时**的（打字时就该看到自己超了）。
 */
export function suggestionFieldErrors(input: {
  content: string;
  contact: string;
  /** 是否已经点过一次提交：没点过就先不报「请填写」 */
  attempted: boolean;
}): { content: string | null; contact: string | null } {
  const content = input.content.trim();

  return {
    content: !content
      ? input.attempted
        ? SUGGESTION_CONTENT_EMPTY_MESSAGE
        : null
      : countCharacters(content) > SUGGESTION_CONTENT_MAX_LENGTH
        ? SUGGESTION_CONTENT_TOO_LONG_MESSAGE
        : null,
    contact:
      countCharacters(input.contact.trim()) > SUGGESTION_CONTACT_MAX_LENGTH
        ? SUGGESTION_CONTACT_TOO_LONG_MESSAGE
        : null,
  };
}
