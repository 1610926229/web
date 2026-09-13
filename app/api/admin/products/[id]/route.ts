import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_PRODUCT_NOT_FOUND_MESSAGE } from "@/lib/constants/adminProducts";
import { getAdminProductDetail, updateAdminProduct } from "@/lib/services/adminProducts";

/**
 * 管理端商品详情与编辑：`GET` / `PATCH /api/admin/products/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的商品照样返回：后台要能查到「这件商品被移除过」。
 * 返回 404 等于把软删除变成了记录消失，那正是软删除要避免的事
 * （用户端的直链是另一条路径：`findProductById()` 对已移除的商品返回 null，
 * 因此 `/product/xxx` 在移除后是 404；但**下架**的商品直链仍然可看，只显示「已下架」。）
 *
 * PATCH 是**一次原子写入**：商品与它的全部规格要么一起生效、要么都不生效，
 * 不会出现「标题改了、价格没改」的半截状态。上架校验（类目可用 + 至少一个有效规格）
 * 在原子区段里判定，因此「先查后写」之间那条并发缝隙不存在。
 *
 * 编辑**不改历史订单**：已下单的订单读的是下单时的快照，价格改动只影响之后的试算与支付。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/products/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminProductDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_PRODUCT_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/products/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminProduct(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
