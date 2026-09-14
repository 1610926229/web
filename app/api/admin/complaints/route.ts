import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import {
  queryAdminComplaintList,
  resolveAdminComplaintListQuery,
} from "@/lib/services/adminComplaints";

/**
 * 管理端投诉列表：`GET /api/admin/complaints`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。
 *
 * 列表 DTO **不含投诉正文、凭证、联系方式与处理结果**（§投诉处理）：
 * 联系方式尤其不进列表，它只在详情页出现且是只读的。
 * 想看那些必须进详情页——列表是「一屏几十条」的场合，把正文与联系方式一起发出去
 * 等于让一次列表请求带走全部投诉人的隐私。字段裁剪在 `toAdminComplaintListItem()`。
 *
 * ⚠️ 关键词**只搜「投诉编号 / 订单号 / 用户昵称 / 平台展示 ID」**，不搜正文、处理结果
 * 与联系方式：把它们当搜索对象，等于让任何一个能进后台的人用关键词把别人的手机号试出来。
 *
 * 分页与筛选都由服务层完成；`status` / `type` 传了非法值回 400，分页越界走规范化。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminComplaintListQuery(searchParams, true);

    return ok(await queryAdminComplaintList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
