import { apiGet, apiPost } from "@/lib/api/client";
import { STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import type {
  StaffComplaintStatusFilter,
  StaffComplaintTypeFilter,
} from "@/lib/constants/staffComplaints";
import type {
  StaffComplaintDetail,
  StaffComplaintListData,
  StaffComplaintWriteResult,
} from "@/lib/types/complaint";

/**
 * 客服端「投诉处理」的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/staffComplaints.ts` 分开是必须的：那些模块依赖
 * `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被
 * 打进浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：客服会话由服务端下发的 HttpOnly Cookie
 * （`mock_staff_id`）维护，客户端连「我是谁」都不自己存一份。
 *
 * ⚠️ 所有写接口都带 `idempotencyKey`，且由**调用方**生成（同一次用户意图内保持不变）。
 * 请求体里**没有** `actorId` / `actorRole` / `actorName`：处理人是谁由服务端会话推导。
 */

/** 投诉列表的查询条件。**全部是可选的**：不传即默认第一页、默认筛选。 */
export type StaffComplaintListRequest = {
  status?: StaffComplaintStatusFilter;
  type?: StaffComplaintTypeFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/** 取一页投诉。列表**不含正文、凭证、联系方式与处理结果**。 */
export function fetchStaffComplaints(
  input: StaffComplaintListRequest = {},
): Promise<StaffComplaintListData> {
  const params = new URLSearchParams();
  // ⚠️ 「不限」必须**显式发成 `all`**，不能靠「不传这个参数」来表达：
  // 服务端把「没有 status 参数」读作**默认筛选**而不是「不限」
  // （`readStaffComplaintStatusFilter(null)` → `DEFAULT_STAFF_COMPLAINT_STATUS_FILTER`，
  // 即「待处理」）。省略它会让筛选栏写着「全部」、列表里却只有待处理——
  // 客服按状态去找一条已处理的投诉，就会得出「没有这条投诉」的错误结论。
  // 退款侧 `staffRefundsHttp.ts` 一直是显式发送的，这里与它对齐。
  if (input.status) params.set("status", input.status);
  if (input.type) params.set("type", input.type);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? STAFF_PAGE_SIZE));

  return apiGet<StaffComplaintListData>(`/api/staff/complaints?${params.toString()}`);
}

/** 取一条投诉详情（含正文、凭证、联系方式、处理信息、会话入口与服务端判定的可执行动作）。 */
export function fetchStaffComplaint(id: string): Promise<StaffComplaintDetail> {
  return apiGet<StaffComplaintDetail>(`/api/staff/complaints/${encodeURIComponent(id)}`);
}

/**
 * 三个处理动作。都是 POST，请求体只有幂等键（解决与关闭另加处理结果 / 关闭说明）。
 *
 * ⚠️ **请求体里没有任何订单、金额或身份字段**：投诉处理不修改订单、也不产生退款，
 * 处理人是谁由服务端会话决定。用户提交的正文、凭证与联系方式同样没有可传的位置。
 *
 * ⚠️ 「开始处理」不传 `result`：它不产生结论，服务端也不会读这个字段。
 */
export function startProcessingStaffComplaint(
  id: string,
  idempotencyKey: string,
): Promise<StaffComplaintWriteResult> {
  return apiPost<StaffComplaintWriteResult>(
    `/api/staff/complaints/${encodeURIComponent(id)}/start-processing`,
    { idempotencyKey },
  );
}

/** 解决投诉：**必须填写处理结果**。处理结果会同步展示给提交投诉的用户。 */
export function resolveStaffComplaint(
  id: string,
  idempotencyKey: string,
  result: string,
): Promise<StaffComplaintWriteResult> {
  return apiPost<StaffComplaintWriteResult>(
    `/api/staff/complaints/${encodeURIComponent(id)}/resolve`,
    { idempotencyKey, result },
  );
}

/** 关闭投诉：**必须填写关闭说明**。`closed` 是终态，之后不能再改为已处理。 */
export function closeStaffComplaint(
  id: string,
  idempotencyKey: string,
  result: string,
): Promise<StaffComplaintWriteResult> {
  return apiPost<StaffComplaintWriteResult>(
    `/api/staff/complaints/${encodeURIComponent(id)}/close`,
    { idempotencyKey, result },
  );
}
