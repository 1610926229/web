import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE,
  getAdminAnnouncementDetail,
  updateAdminAnnouncement,
} from "@/lib/services/adminAnnouncements";

/**
 * 管理端公告详情与编辑：`GET` / `PATCH /api/admin/content/announcements/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的公告照样返回：后台要能查到「这条素材被移除过」，
 * 返回 404 等于把软删除变成了记录消失，那正是软删除要避免的事。
 * 编辑页的回填因此也不必先等列表加载完。
 *
 * PATCH 是**编辑**而不是「随便改」：它改不了 `removedAt`，因此一次普通保存
 * 永远无法把一条已移除的公告改回未移除——要让人回来必须走新的流程。
 *
 * 校验失败返回 400，message 是**第一条**字段错误（按表单上的字段顺序），
 * 与表单的字段级错误同源，运营据此把错误挂到具体那一栏上。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/content/announcements/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminAnnouncementDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/content/announcements/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminAnnouncement(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
