import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCompanionFlags } from "@/lib/services/adminCompanions";

/**
 * 恢复接单：`POST /api/admin/companions/[id]/resume`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 暂停的逆操作：重新可接单，**并清空不可接单原因**。
 * 原因不清掉的话，一个已经能接单的人身上还挂着「生病休息中」，用户端看起来自相矛盾。
 *
 * 请求体只需要幂等键：目标状态由服务端决定，客户端没有「恢复成什么」可填。
 *
 * ⚠️ 对**已停用**的记录恢复接单会被拒绝（400）：停用状态下强制不可接单，
 * 要让人重新出现得先启用。这个顺序不是限制，而是「停用」这个动作本身的含义。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]/resume">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCompanionFlags(id, "resume", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
