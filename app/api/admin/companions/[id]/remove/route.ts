import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminCompanion } from "@/lib/services/adminCompanions";

/**
 * 移除护航：`POST /api/admin/companions/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 移除是**软删除**：写 `removedAt` 时间戳，**不物理删除这条记录**。
 * 三条后果都是刻意的：
 * - 用户端列表与结算页不再出现（与停用相同的对外表现）；
 * - 后台仍能用 `removal=removed` 把它筛出来，详情照样能打开；
 * - 订单、评价、鸡腿记录里指向它的部分继续有效——历史不是后台能改写的东西。
 *
 * 移除还会让这位用户不再占用「一名用户最多一条有效护航」的名额：
 * 索引里那条关联会被删掉，因此他日后再被审核通过时能正常建出新的一条，
 * 而不会被自己的历史记录挡住。
 *
 * 重复移除返回同一个结果且 `changed: false`，因此**不会写下第二条审计**。
 *
 * 影响面大，界面必须二次确认（§八）；但真正的守卫是这里的幂等键与服务端状态，
 * 二次确认只是少让手滑发生一次。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminCompanion(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
