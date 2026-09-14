import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { startReviewAdminRefund } from "@/lib/services/adminRefunds";

/**
 * 开始审核退款：`POST /api/admin/refunds/[id]/start-review`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **只改退款申请**：`pending → reviewing`。订单状态、金额与用户的消费统计都不变，
 * 也**不写审核人与审核意见**——那两样是「结果」，这一步还没有结果。
 *
 * 请求体只读幂等键（`idempotencyKey`）：金额、状态、审核人、审核时间都不从请求体读，
 * 客户端伪造这些字段不会有任何效果（§九）。
 *
 * 重复点击、网络重试与并发请求不会重复迁移状态、也不会重复写审计：
 * 判定在 `lib/data/adminRefundTransaction.ts` 的原子区段里。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/refunds/[id]/start-review">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await startReviewAdminRefund(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
