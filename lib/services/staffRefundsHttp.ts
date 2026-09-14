import { apiGet, apiPost } from "@/lib/api/client";
import { STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import type { StaffRefundStatusFilter } from "@/lib/constants/staffRefunds";
import type { StaffRefundDetail, StaffRefundListData, StaffRefundWriteResult } from "@/lib/types/refund";

/**
 * 客服工作台「退款处理」的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/staffRefunds.ts` 分开是必须的：那个模块依赖 `lib/data`
 * 与 `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：客服会话由服务端下发的 HttpOnly Cookie
 * （`mock_staff_id`）维护，客户端连「我是谁」都不自己存一份。
 *
 * ⚠️ 所有写接口都带 `idempotencyKey`，且由**调用方**生成（同一次用户意图内保持不变）。
 * 按钮禁用只能挡住手快，真正的防重在服务端按这个键做重放判定。
 */

/** 退款列表的查询条件。**全部是可选的**：不传即默认第一页、待审核。 */
export type StaffRefundListRequest = {
  status?: StaffRefundStatusFilter;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页退款申请。
 *
 * 只有**筛选与分页**参数，没有任何用户标识：退款申请属于谁、访问资格如何，
 * 全部由服务端按客服会话决定。
 */
export function fetchStaffRefunds(input: StaffRefundListRequest = {}): Promise<StaffRefundListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? STAFF_PAGE_SIZE));

  return apiGet<StaffRefundListData>(`/api/staff/refunds?${params.toString()}`);
}

/** 取一条退款申请详情（含原因、说明、凭证、审核信息、会话入口与服务端判定的可执行动作）。 */
export function fetchStaffRefund(id: string): Promise<StaffRefundDetail> {
  return apiGet<StaffRefundDetail>(`/api/staff/refunds/${encodeURIComponent(id)}`);
}

/**
 * 两个审核动作。都是 POST，请求体只有幂等键（驳回另加审核意见）。
 *
 * ⚠️ **没有 approve**：通过会在同一次写入里把订单改成「已退款」，属于资金最终划拨，
 * 留在管理员侧。客服端的取数文件里连这个函数都没有——按钮不存在，地址也不存在。
 *
 * ⚠️ **请求体里没有金额**：退款金额取申请创建时的服务端订单实付快照，客服不可修改。
 */
export function startReviewStaffRefund(
  id: string,
  idempotencyKey: string,
): Promise<StaffRefundWriteResult> {
  return apiPost<StaffRefundWriteResult>(
    `/api/staff/refunds/${encodeURIComponent(id)}/start-review`,
    { idempotencyKey },
  );
}

/** 驳回：**必须填写审核意见**（服务端校验），订单状态与消费金额都不变。 */
export function rejectStaffRefund(
  id: string,
  idempotencyKey: string,
  reviewNote: string,
): Promise<StaffRefundWriteResult> {
  return apiPost<StaffRefundWriteResult>(`/api/staff/refunds/${encodeURIComponent(id)}/reject`, {
    idempotencyKey,
    reviewNote,
  });
}
