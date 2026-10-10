import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE,
  getAdminQuickEntryDetail,
  updateAdminQuickEntry,
} from "@/lib/services/adminQuickEntries";

/**
 * 管理端快捷入口的详情与编辑：`GET` / `PATCH /api/admin/content/quick-entries/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的入口照样返回：后台要能查到「这条入口被移除过」。
 * 返回 404 等于把软移除变成了记录消失，那正是软删除要避免的事。
 *
 * PATCH 是**编辑**而不是「随便改」：它改不了 `removedAt`，因此一次普通保存
 * 永远无法把一条已移除的入口改回未移除——要让它回来必须走新流程，
 * 而不是靠一次「重新勾上启用」。校验失败返回 400，message 是**第一条**字段错误；
 * 目标地址不安全返回的也是明确的 400，而不是笼统的「保存失败」。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/content/quick-entries/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminQuickEntryDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/content/quick-entries/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminQuickEntry(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
