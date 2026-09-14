import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { approveAdminRefund } from "@/lib/services/adminRefunds";

/**
 * 审核通过退款：`POST /api/admin/refunds/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 通过必须在**同一次写入**里完成四件事：① 退款申请变为 `approved`；
 * ② 记录管理者、审核意见与审核时间；③ 订单变为 `refunded`；④ 写一条管理审计。
 * 四件事在 `lib/data/adminRefundTransaction.ts` 的一段无 `await` 的同步区段里完成，
 * 因此不存在「退款已通过但订单未退款」或相反的状态。
 *
 * ⚠️ **这是 Mock 审核结果**：不调用真实微信退款、不生成微信退款单号、
 * 也不代表款项已经真实退回。页面必须原样展示 `ADMIN_REFUND_MOCK_NOTICE`。
 *
 * ⚠️ **金额不可修改**：退款金额取申请创建时的服务端订单实付快照。
 * 请求体里只读幂等键与审核意见（选填），**没有任何接收金额的字段**。
 *
 * ⚠️ **不改用户的累计消费字段**：订单变成 `refunded` 之后就不再计入累计有效消费，
 * 消费等级与周期排行榜自然排除这一单。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/refunds/[id]/approve">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await approveAdminRefund(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
