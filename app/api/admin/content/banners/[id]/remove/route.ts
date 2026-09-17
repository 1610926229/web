import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminBanner } from "@/lib/services/adminBanners";

/**
 * 移除活动图（软删除）：`POST /api/admin/content/banners/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 移除是**软删除**：记录保留（投出去过的那张图，事后要能回答「当时首页上是什么」），
 * 后台可以用 `removal=removed` 筛到，详情也照常打开。移除之后用户端立刻换掉它
 * （回落规则见 `disable` 那条），这条记录也不再接受编辑与启停。
 *
 * 重复移除是幂等的：不刷新时间戳、不写第二条审计。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/banners/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminBanner(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
