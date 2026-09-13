import { apiGet, apiPost } from "@/lib/api/client";
import { COMPLAINT_PAGE_SIZE } from "@/lib/constants/complaints";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import type { PageResult } from "@/lib/types/common";
import type { ComplaintDetail, ComplaintListItem } from "@/lib/types/complaint";

/**
 * 投诉的**浏览器端**取数（列表 / 加载更多 / 提交 / 详情）。
 *
 * 与服务端模块 `lib/services/complaints.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 投诉列表与详情页的首屏由 Server Component 直接取数，不经过本文件。
 */

export type ComplaintListRequest = {
  /** 投诉状态；空串表示「全部」 */
  status: string;
  page?: number;
  pageSize?: number;
};

export function fetchComplaints(input: ComplaintListRequest): Promise<PageResult<ComplaintListItem>> {
  const params = new URLSearchParams();
  // 空值不发送：接口把「参数缺失」与「显式空值」都当作「全部」
  if (input.status) params.set("status", input.status);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? COMPLAINT_PAGE_SIZE));

  return apiGet<PageResult<ComplaintListItem>>(`/api/complaints?${params.toString()}`);
}

export type ComplaintSubmitInput = {
  typeKey: string;
  description: string;
  contact: string;
  /** 只提交类型与文件名；凭证的 id 与地址一律由服务端生成 */
  evidence: EvidenceDraft[];
  /** 关联订单 id；不关联时为空串 */
  orderId: string;
  idempotencyKey: string;
};

/** 提交投诉。返回新投诉的 id，由页面跳到投诉详情页。 */
export function submitComplaint(
  input: ComplaintSubmitInput,
): Promise<{ complaintId: string; created: boolean }> {
  return apiPost<{ complaintId: string; created: boolean }>("/api/complaints", input);
}

/** 读取投诉详情。 */
export function fetchComplaintDetail(complaintId: string): Promise<ComplaintDetail> {
  return apiGet<ComplaintDetail>(`/api/complaints/${encodeURIComponent(complaintId)}`);
}
