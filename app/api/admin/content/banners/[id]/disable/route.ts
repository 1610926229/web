import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminBannerEnabled } from "@/lib/services/adminBanners";

/**
 * 停用活动图：`POST /api/admin/content/banners/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ 停用当前正在投的那张之后，用户端首页**自动回落到下一张启用中的**
 * （按排序值）；到一张都没有时活动位整块隐藏（服务端返回空串，
 * 不返回占位图——占位图会让「后台一张都没配」看起来像配好了）。
 *
 * 这个回落是 `lib/constants/homeContent.ts` 的 `selectActivityImageUrl()` 算出来的，
 * 接口层不做任何「换图」动作，也不写第二份「当前活动图」的指针
 * ——那会立刻多出一个可能与记录不一致的状态。
 *
 * 重复停用是幂等的：不写数据、不写第二条审计。已移除的活动图一律拒绝。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/banners/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminBannerEnabled(id, false, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
