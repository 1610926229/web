import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { SUGGESTION_PAGE_SIZE } from "@/lib/constants/suggestions";
import type { SuggestionCreateResult, SuggestionPage } from "@/lib/types/suggestion";

/**
 * 意见反馈的**浏览器端**取数（加载更多 / 提交）。
 *
 * 与服务端模块 `lib/services/suggestions.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 列表首屏由 Server Component 直接取数，不经过本文件。
 */

export type SuggestionListRequest = {
  page?: number;
  pageSize?: number;
};

/** 按页取当前用户的反馈列表。 */
export function fetchSuggestions(input: SuggestionListRequest = {}): Promise<SuggestionPage> {
  const params = new URLSearchParams();
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? SUGGESTION_PAGE_SIZE));

  return apiGet<SuggestionPage>(`/api/suggestions?${params.toString()}`);
}

/** 提交反馈时提交给服务端的字段，全部是用户填写的内容。 */
export type SuggestionSubmitInput = {
  typeKey: string;
  content: string;
  contact: string;
  evidence: EvidenceDraft[];
  idempotencyKey: string;
};

/**
 * 提交反馈。
 *
 * 请求体里**只有**类型、内容、联系方式、凭证与幂等键：`userId` / 状态 / 回复 /
 * 提交时间都由服务端写，客户端塞什么都不算。重复提交不会报错，返回第一次的结果。
 */
export function submitSuggestion(input: SuggestionSubmitInput): Promise<SuggestionCreateResult> {
  return apiPost<SuggestionCreateResult>("/api/suggestions", {
    typeKey: input.typeKey,
    content: input.content,
    contact: input.contact,
    evidence: input.evidence,
    idempotencyKey: input.idempotencyKey,
  });
}
