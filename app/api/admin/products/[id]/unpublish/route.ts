import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminProductStatus } from "@/lib/services/adminProducts";

/**
 * 下架商品：`POST /api/admin/products/[id]/unpublish`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 下架的效果有三层，都是**已经在实现里的既有行为**：
 * - 从首页 / 分类页 / 搜索结果里消失；
 * - **直链仍然可打开**，页面显示「已下架」而不是 404
 *   （`/product/p-off-1` 就是这条回归的锚点）；
 * - 不能结算——结算页会挡下不在架的商品。
 *
 * 也就是说下架是「停止销售」而不是「删除」。要让它彻底不可见用移除（软删除），
 * 两者是不同的动作，后台也分成两个按钮、两段二次确认文案。
 *
 * 重复下架是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[id]/unpublish">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminProductStatus(id, "off", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
