import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminCompanionFlags } from "@/lib/services/adminCompanions";

/**
 * 启用：`POST /api/admin/companions/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 启用只把记录放回「在架」，**不自动变成可接单**：可接单是一个独立的业务决定，
 * 一个刚启用的护航常常还需要补资料（这正是审核通过时新建的记录
 * `available = false` / 原因「资料待完善」的由来）。要开接单就再调一次「恢复接单」，
 * 或者用编辑表单把两个开关一起提交。
 *
 * 保留原有的不可接单原因：启用前若正处于暂停状态，原因仍然成立，不该被清掉。
 *
 * ⚠️ 已移除的记录不能被启用（400）——移除是终态，要让人回来必须走新的流程，
 * 而不是把一个软删除的记录重新点亮，让历史订单与评价指向一条「复活」的资料。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminCompanionFlags(id, "enable", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
