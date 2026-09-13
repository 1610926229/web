import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminCategory } from "@/lib/services/adminCategories";

/**
 * 移除类目（软删除）：`POST /api/admin/categories/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 两条硬规则，判定都在 `lib/data/adminCatalogTransaction.ts` 的**原子区段**里
 * （数与写不能分开，否则「先数了是 0、写的时候已经有商品了」会被并发穿透）：
 * - 类目下还有**未移除**的商品时**拒绝移除**；
 * - **不级联删除商品**——一次点击静默下架一批还在卖的东西是不可接受的。
 *
 * 移除是**软删除**：记录保留（类目 id 是商品归属的一部分，硬删会让
 * 「这条商品原本属于哪个类目」永久查不到），后台可以用「已移除」筛选查到。
 * 重复移除是幂等的：不刷新时间戳、不写第二条审计。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/categories/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminCategory(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
