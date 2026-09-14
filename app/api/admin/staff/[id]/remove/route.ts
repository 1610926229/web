import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminStaff } from "@/lib/services/adminStaff";

/**
 * 移除客服账号：`POST /api/admin/staff/[id]/remove`（**软删除**）。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **不删除记录**：只写 `removedAt` 并同时把 `enabled` 置为 false。
 *
 * 两件事各有理由：
 * - 不删记录，是因为**历史消息要保留**。客服发过的消息带着发送时的名称与头像快照，
 *   后台也要能筛出「已移除」的账号，回答「这条消息当时是谁发的」。
 *   硬删除会让这个问题永久无解，而它正是后台存在的意义之一。
 * - 顺手停用，是为了让「已移除的账号一定是停用的」成为**结构上的事实**，
 *   而不是靠每一处读账号的地方都记得判 `removedAt !== null`。
 *
 * ⚠️ 移除后**不能登录**、不能进工作台、不能再启用，也没有「撤销移除」这个动作。
 *
 * 重复移除不是错误：已经移除过了就不刷新时间戳、不写第二条审计。
 */
export async function POST(request: Request, context: RouteContext<"/api/admin/staff/[id]/remove">) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminStaff(id ?? "", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
