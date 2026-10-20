import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminQuickEntry } from "@/lib/services/adminQuickEntries";

/**
 * 移除快捷入口（软移除）：`POST /api/admin/content/quick-entries/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 移除是**软移除**：记录保留（首页四宫格是运营每天在调的位置，事后要能回答
 * 「当时这个格子指向哪里」），后台可以用 `removal=removed` 查到它。
 * 与「停用」的区别是**去向**：停用是可逆的中间状态，移除之后这条记录
 * 不再接受编辑与启停（事务层返回 `{kind:"removed"}`，服务层转成 400）。
 *
 * 重复移除是幂等的：不刷新时间戳、不写第二条审计。
 *
 * ⚠️ 移除**没有级联后果**：它不删任何东西，也不影响其它入口的排序值——
 * 剩下的格子按自己的 `sortOrder` 排在前面，运营看到的就是用户看到的那一列。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/quick-entries/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminQuickEntry(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
