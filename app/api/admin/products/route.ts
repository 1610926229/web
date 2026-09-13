import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  createAdminProduct,
  queryAdminProductList,
  resolveAdminProductListQuery,
} from "@/lib/services/adminProducts";

/**
 * 管理端商品列表与新建：`GET` / `POST /api/admin/products`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 返回**全部**商品（含已下架与已移除，分别用 `status=off`、`removal=removed` 筛出）：
 * 「后台看不到自己下架过哪件商品」是不行的。
 *
 * POST 的可改字段是 `ProductProfilePatch`（所属游戏与类目、标题、副标题、封面、
 * 详情图文、标签、展示排序、推荐状态、上下架状态、规格数组）。
 * `id`、`removedAt`、`createdAt`、`updatedAt`、`monthlySales`、`gameTag`
 * 在服务端**没有读取的位置**——客户端传了也不会有任何效果（§八、§九）。
 *
 * ⚠️ 价格只从「元」文本转成整数分（严格正则，不接受浮点、负号、科学计数法）。
 * 规格行的 `id` 由服务端签发（新建）或必须命中已有规格（编辑），
 * **数组下标从来不是身份**——否则中间插一行就会把别人的价格挪走。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminProductListQuery(searchParams, true);

    return ok(await queryAdminProductList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminProduct(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
