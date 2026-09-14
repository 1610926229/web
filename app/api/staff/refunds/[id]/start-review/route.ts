import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { startReviewStaffRefund } from "@/lib/services/staffRefunds";

/**
 * 客服开始审核退款：`POST /api/staff/refunds/[id]/start-review`。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前：把解析成本交给未认证的请求，
 * 等于给出一条「匿名也能探测接口存在」的路径。
 *
 * ⚠️ 请求体只读**幂等键**。操作者（actorId / actorRole / actorName）不在这里：
 * 客服身份来自守卫返回的会话，写进审计的快照也是那一份。
 *
 * ⚠️ 只改退款申请（`pending → reviewing`），订单状态、金额与消费统计都不变。
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext<"/api/staff/refunds/[id]">) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await startReviewStaffRefund(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
