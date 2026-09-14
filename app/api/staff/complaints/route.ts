import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import {
  queryStaffComplaintList,
  resolveStaffComplaintListQuery,
} from "@/lib/services/staffComplaints";

/**
 * 客服工作台投诉列表：`GET /api/staff/complaints`。
 *
 * ⚠️ 第一件事是 `requireStaff()`（§六 明确要求）。身份矩阵：
 * 匿名 401、普通用户 Cookie 401、管理 Cookie 401、护航 / 停用 / 已移除客服 403，
 * 只有启用中的客服能通过。理由见 `lib/api/staffRoute.ts`。
 *
 * 支持的查询参数：`keyword`（投诉编号 / 订单号 / 用户昵称，只去空白不截断）、
 * `status` / `type`（投诉状态与类型筛选）、`page` / `pageSize`（越界自动收敛）。
 * 非法 `status` / `type` 返回 400——地址是用户随手可改的，但接口是可被直接请求的，
 * 两者对非法输入该有不同的反应（页面那条链路用 `strict: false` 规范化）。
 *
 * ⚠️ 列表 DTO **不含投诉正文、凭证、联系方式与处理结果**（§投诉处理）：
 * 联系方式尤其不进列表，它只在详情页出现且是只读的。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireStaff();
    const { searchParams } = new URL(request.url);
    const query = await resolveStaffComplaintListQuery(searchParams, true);

    return ok(await queryStaffComplaintList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
