import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminBannerEnabled } from "@/lib/services/adminBanners";

/**
 * 启用活动图：`POST /api/admin/content/banners/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 窄写入（只改 `enabled`）：列表上的开关不该顺带把名称、图片、排序一起写回去，
 * 否则两位管理员同时操作时，后写的那次会覆盖另一位刚改好的内容。
 *
 * ⚠️ 启用**不等于**上线：用户端取的是启用中排序最前的那一张。因此这个按钮的
 * 效果是「这张素材进入候选」，要它真的出现在首页，还要它的排序在前
 * ——后台列表展示的顺序与用户端的挑选顺序是同一个全序，运营照着列表第一条调即可。
 *
 * 重复启用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/banners/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminBannerEnabled(id, true, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
