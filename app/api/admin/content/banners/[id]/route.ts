import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  ADMIN_BANNER_NOT_FOUND_MESSAGE,
  getAdminBannerDetail,
  updateAdminBanner,
} from "@/lib/services/adminBanners";

/**
 * 管理端活动图详情与编辑：`GET` / `PATCH /api/admin/content/banners/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的活动图照样返回（软删除不是记录消失），编辑页回填因此不必
 * 先等列表加载完。
 *
 * PATCH 改不了 `removedAt`：一次普通保存永远无法把一条已移除的活动图改回未移除。
 *
 * ⚠️ 这里的编辑**可能直接改变用户端首页上的那张图**：改 `sortOrder` 把它排到最前、
 * 或者把启用勾去掉，保存之后用户刷新看到的就是新的结果。这不是副作用，
 * 而是这个页面的主要用途——正因如此，`enabled` 与 `sortOrder` 都是**显式提交**的字段，
 * 不存在「没传就保持原样」的猜测。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/content/banners/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminBannerDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_BANNER_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/content/banners/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminBanner(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
