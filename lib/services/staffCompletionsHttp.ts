import { apiGet, apiPost } from "@/lib/api/client";
import { STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import type { StaffCompletionStatusFilter } from "@/lib/constants/staffCompletions";
import type {
  StaffCompletionDetail,
  StaffCompletionListData,
  StaffCompletionWriteResult,
} from "@/lib/types/completion";

/**
 * 客服工作台「完成材料审核」的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/staffCompletions.ts` 分开是必须的：那个模块依赖
 * `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进
 * 浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：客服会话由服务端下发的 HttpOnly Cookie
 * （`mock_staff_id`）维护，客户端连「我是谁」都不自己存一份。
 *
 * ⚠️ 两个写接口**没有幂等键、没有 operationId**：完成材料的审核结果是终态
 * （approved / rejected），幂等判据是**状态本身**（已经是目标状态就是重放），
 * 因此「通过」连请求体都没有，只有「驳回」带一个必填的 `reviewNote`。
 * 与 `staffRefundsHttp`（幂等键）是两条刻意不同的机制。
 */

/** 完成材料列表的查询条件。**全部是可选的**：不传即默认第一页、待审核。 */
export type StaffCompletionListRequest = {
  status?: StaffCompletionStatusFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页完成材料。
 *
 * 只有**筛选与分页**参数，没有任何用户标识：这些完成材料属于谁、访问资格如何，
 * 全部由服务端按客服会话决定。
 */
export function fetchStaffCompletions(
  input: StaffCompletionListRequest = {},
): Promise<StaffCompletionListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? STAFF_PAGE_SIZE));

  return apiGet<StaffCompletionListData>(`/api/staff/completions?${params.toString()}`);
}

/** 取一条完成材料详情（含完成说明、凭证、审核信息、订单现状与服务端判定的可执行动作）。 */
export function fetchStaffCompletion(id: string): Promise<StaffCompletionDetail> {
  return apiGet<StaffCompletionDetail>(`/api/staff/completions/${encodeURIComponent(id)}`);
}

/**
 * 通过完成材料：**没有请求体、没有幂等键**。
 *
 * 幂等判据是状态本身（已经是 approved 就是重放），审核人身份只来自服务端会话。
 * 因此 `apiPost` 不带 body——给它编一个键等于替服务端发明一条它并不要求的规则。
 */
export function approveStaffCompletion(id: string): Promise<StaffCompletionWriteResult> {
  return apiPost<StaffCompletionWriteResult>(
    `/api/staff/completions/${encodeURIComponent(id)}/approve`,
  );
}

/** 驳回完成材料：**必须填写驳回原因**（服务端校验）。订单继续 serving，打手可重新提交。 */
export function rejectStaffCompletion(
  id: string,
  reviewNote: string,
): Promise<StaffCompletionWriteResult> {
  return apiPost<StaffCompletionWriteResult>(
    `/api/staff/completions/${encodeURIComponent(id)}/reject`,
    { reviewNote },
  );
}
