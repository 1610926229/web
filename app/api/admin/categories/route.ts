import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  createAdminCategory,
  queryAdminCategoryList,
  resolveAdminCategoryListQuery,
} from "@/lib/services/adminCategories";

/**
 * 管理端类目列表与新建：`GET` / `POST /api/admin/categories`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。普通用户、客服、护航与停用管理员
 * 一律 401 / 403 —— 权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * GET 返回**全部**类目（含停用与已移除，`removal=removed` 筛出后者）：
 * 「后台看不到自己停用过哪条类目」是不行的——停用与移除都必须是可回查的状态。
 *
 * POST 的可改字段就是 `AdminCategoryProfilePatch` 那些（所属游戏、名称、排序、
 * 启用状态）。`removedAt`、`createdAt`、`updatedAt`、`id` 在服务端**没有读取的位置**，
 * 客户端多传一个也不会有任何效果（§九：客户端伪造 ID、状态、时间必须被忽略）。
 *
 * 数据源只有一份：本接口与用户端分类导航读的是同一个仓储。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminCategoryListQuery(searchParams, true);

    return ok(await queryAdminCategoryList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminCategory(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
