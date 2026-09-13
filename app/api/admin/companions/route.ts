import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { queryAdminCompanionList, resolveAdminCompanionListQuery } from "@/lib/services/adminCompanions";

/**
 * 管理端护航名单：`GET /api/admin/companions`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 与公开接口 `GET /api/companions` 的区别不只是权限：那边只返回「在架且未移除」的记录，
 * 这边返回**全部**，包括已停用与已移除的（`removal=removed` 专门用来筛出后者）。
 * 「后台看不到自己停用过谁」是不行的——停用与移除都必须是可回查的状态，不是消失。
 *
 * 数据源只有一份：本接口与用户端列表 / 详情 / 结算页读的是同一个仓储，
 * 因此后台改完刷新，前台立刻是新值，不需要任何同步动作。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = await resolveAdminCompanionListQuery(searchParams, true);

    return ok(await queryAdminCompanionList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
