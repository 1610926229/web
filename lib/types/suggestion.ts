import type { PageResult } from "./common";
import type { SupportEvidence } from "./evidence";

/**
 * 意见反馈的类型与对外 DTO。
 *
 * 反馈**只是把想法记下来交给平台**：它不产生订单、不产生支付、不改变任何已有的业务状态，
 * 因此这里的字段里没有任何金额、优惠、奖励相关的项。平台回复只可能来自预置数据或
 * 将来后台的返回——用户端既不产生回复，也不展示平台没有承诺过的结论（奖励、补偿、返现等）。
 *
 * 与投诉的区别：投诉针对**某一笔订单**，反馈针对**平台本身**，因此反馈不关联订单。
 */

/** 反馈状态。四个字与文案见 `lib/constants/suggestions.ts`，用户端写不了。 */
export type SuggestionStatus = "submitted" | "replied" | "closed";

/** 反馈类型。取值由服务端校验，文案只此一份。 */
export type SuggestionTypeKey = "feature" | "experience" | "content" | "other";

/**
 * 反馈（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律使用下面的 DTO，
 * `userId` 不会顺带泄漏出去。
 */
export type Suggestion = {
  id: string;
  userId: string;
  typeKey: SuggestionTypeKey;
  /** 类型文案快照：类型将来改名或下架，历史反馈的展示不变 */
  typeLabel: string;
  /** 已去首尾空格，长度由服务端按字符数校验 */
  content: string;
  /** 联系方式（选填，最多 `SUGGESTION_CONTACT_MAX_LENGTH` 个字符） */
  contact: string;
  /** Mock 凭证：地址由服务端写成本地占位图 */
  evidence: SupportEvidence[];

  /** 初始状态由服务端写死为 `submitted` */
  status: SuggestionStatus;
  /** 平台回复。用户新提交的一定为空串，只可能是预置或将来后台写入的内容 */
  reply: string;
  /** 平台回复时间；还没有回复时为 null */
  repliedAt: string | null;

  /** 提交时间，由服务端写 */
  createdAt: string;
};

/**
 * 反馈列表项 DTO。
 *
 * ⚠️ 这里**带着完整的正文与平台回复**，与投诉列表（列表只给摘要、内容去详情页看）
 * 刻意不同：本阶段**没有反馈详情页**，列表就是唯一的落点，卡片必须能完整展开
 * 用户提交的内容与平台回复，否则用户提交完就再也看不到自己写了什么。
 *
 * 因此本 DTO 不返回的内容只有两类：`userId` 这类身份字段，以及平台侧的内部信息
 * （处理人、内部备注等——本阶段根本不存在）。联系方式属于用户自己提交的内容，
 * 没有详情页的情况下同样要能回看，因此保留。
 */
export type SuggestionListItem = {
  id: string;
  typeKey: SuggestionTypeKey;
  typeLabel: string;
  content: string;
  contact: string;
  evidence: SupportEvidence[];
  status: SuggestionStatus;
  /** 状态文案，与服务端同源，前端不自己映射 */
  statusLabel: string;
  /** 平台回复；没有回复时为空串 */
  reply: string;
  repliedAt: string | null;
  createdAt: string;
};

/** 反馈分页结果。 */
export type SuggestionPage = PageResult<SuggestionListItem>;

/** 提交反馈的结果。重复提交返回第一次的结果，`created` 为 false。 */
export type SuggestionCreateResult = {
  suggestionId: string;
  created: boolean;
};
