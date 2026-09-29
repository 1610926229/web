import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import {
  queryAdminAftersaleList,
  resolveAdminAftersaleListQuery,
} from "@/lib/services/adminAftersales";

/**
 * 管理端售后工作台：`GET /api/admin/aftersales`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。
 *
 * ⚠️ **只读接口**：工作台把退款申请与投诉排进同一张待办队列，但**不做任何处置**——
 * 这里没有 POST，退款的三个审核动作与投诉的三个处理动作仍然在各自的专用接口上
 * （`/api/admin/refunds/**` 与 `/api/admin/complaints/**`）。
 * 分流入口与处置入口分开，是「两边动的东西不一样」这件事在接口层的体现。
 *
 * 列表 DTO **不含退款说明、审核意见、投诉正文、凭证与联系方式**：
 * 那些只在各自的详情页展示。字段裁剪在 `toRefundRow` / `toComplaintRow`，
 * 不在本文件。
 *
 * ⚠️ 关键词**只搜「案件编号 / 订单号 / 用户昵称 / 平台展示 ID / 打手昵称」**，
 * 不搜退款说明、审核意见、投诉正文与联系方式：那几段里可能有用户写的隐私信息，
 * 把它们当搜索对象等于给了一个探测入口。
 *
 * 分页与筛选都由服务层完成；`view` / `caseType` / 日期传了非法值回 400，
 * 分页越界走规范化。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminAftersaleListQuery(searchParams, true);

    return ok(await queryAdminAftersaleList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
