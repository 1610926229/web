import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminProduct } from "@/lib/services/adminProducts";

/**
 * 移除商品（软删除）：`POST /api/admin/products/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 移除是**软删除**，记录保留、只是不再对用户端可见：
 * 直链 404、不进首页与分类页、不能结算。这样做是因为**历史数据必须还查得到**：
 * - 历史订单读的是下单快照，本来就不受商品变化影响；
 * - 历史收藏仍然存在，显示「商品已删除」并允许移除——如果这里硬删记录，
 *   收藏里那条引用就会变成一个查不到任何信息的空 id。
 *
 * 后台可以用「已移除」筛选把它找回来。重复移除是幂等的：
 * 不刷新 `removedAt`（保留第一次移除的时间）、不写第二条审计。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/products/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminProduct(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
