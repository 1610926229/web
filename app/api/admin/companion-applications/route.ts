import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import {
  queryAdminApplicationList,
  resolveAdminApplicationListQuery,
} from "@/lib/services/adminCompanionApplications";

/**
 * 管理端入驻申请列表：`GET /api/admin/companion-applications`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。
 *
 * 列表 DTO **不含完整正文、联系方式、凭证与审核意见**（§六），
 * 想看那些必须进详情页——列表是「一屏几十条」的场合，把正文一起发出去
 * 等于让一次列表请求带走全部申请人的隐私。字段裁剪在 `toAdminCompanionApplicationListItem()`，
 * 不在本文件：DTO 的形状只有一处定义。
 *
 * 分页与筛选都由服务层完成：`page` / `pageSize` 越界规范化，`status` / `gameId`
 * 传了非法值回 400——**静默按「全部」处理会让调用方拿着与筛选栏不符的结果往下用**。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminApplicationListQuery(searchParams, true);

    return ok(await queryAdminApplicationList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
