import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_CATEGORY_NOT_FOUND_MESSAGE } from "@/lib/constants/adminCategories";
import { getAdminCategoryDetail, updateAdminCategory } from "@/lib/services/adminCategories";

/**
 * 管理端类目详情与编辑：`GET` / `PATCH /api/admin/categories/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的类目照样返回：后台要能查到「这条类目被移除过」。
 * 返回 404 等于把软删除变成了记录消失，那正是软删除要避免的事
 * （用户端是另一条路径：已移除的类目不进导航，商品归属也仍指得到它）。
 *
 * PATCH 是**编辑**而不是「随便改」：它改不了 `removedAt`，因此一次普通保存
 * 永远无法把一条已移除的类目改回未移除——要让人回来必须走新流程。
 * 校验失败返回 400，message 是**第一条**字段错误；重名返回的也是同一句话，
 * 与表单的字段级错误同源。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/categories/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminCategoryDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_CATEGORY_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/categories/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminCategory(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
