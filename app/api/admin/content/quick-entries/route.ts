import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { resolveContentRemovalFilter } from "@/lib/constants/adminContent";
import {
  createAdminQuickEntry,
  queryAdminQuickEntryList,
} from "@/lib/services/adminQuickEntries";

/**
 * 管理端首页快捷入口的列表与新建：`GET` / `POST /api/admin/content/quick-entries`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。普通用户、客服、护航与停用管理员
 * 一律 401 / 403 —— 权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * GET 返回**全部**入口（含停用与已移除，`removal=removed` 筛出后者）：
 * 「后台看不到自己停用过哪条入口」是不行的——停用与移除都必须是可回查的状态。
 * 不分页，理由见 `queryAdminQuickEntryList()`。
 *
 * POST 的可改字段就是 `AdminQuickEntryProfilePatch` 那些（名称、图标、目标地址、
 * 排序、启用状态）。`id`、`createdAt`、`updatedAt`、`removedAt` 在服务端
 * **没有读取的位置**，客户端多传一个也不会有任何效果（§九：客户端伪造 ID、状态、
 * 时间必须被忽略）。目标地址要过两级安全校验，见服务层与事务层的注释。
 *
 * 数据源只有一份：本接口与用户端首页四宫格读的是同一个仓储。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const removal = resolveContentRemovalFilter(searchParams.get("removal"));

    return ok(await queryAdminQuickEntryList(removal, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminQuickEntry(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
