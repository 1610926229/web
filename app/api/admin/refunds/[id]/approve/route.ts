import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { approveAdminRefund } from "@/lib/services/adminRefunds";

/**
 * 审核通过退款：`POST /api/admin/refunds/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。**这是全仓唯一能由人工裁定退款金额与资金责任的入口**：
 * 客服侧只有 `[id]` / `[id]/reject` / `[id]/start-review` 三个地址，**没有 approve**，
 * 客服只能调查、记录、提出处理意见（P0-13 权限口径）。
 * （其它改钱的入口——`directRefundOrder`、公共池超时自动退——退的都是**固定全额**，
 * 没有可按比例裁量的空间，因此不构成「裁定」。）
 *
 * 通过必须在**同一次写入**里完成六件事：① 退款申请变为 `approved` 并写入资金决策
 * （`decision`：责任归属、退款比例、打手责任比例与三个金额）；② 记录管理者、审核意见
 * 与审核时间；③ 订单**累计**写入 `refundedAmount`；④ 该订单的 Earning 累计冲回
 * `reversedAmount` 并补一条 `EarningAdjustment`；⑤ 累计退满时才关闭派单并通知打手；
 * ⑥ 写一条管理审计。六件事在 `lib/data/adminRefundTransaction.ts` 的一段无 `await`
 * 的同步区段里完成，因此不存在「退款已通过但订单未退款」或相反的状态。
 *
 * ⚠️ **订单只在累计退满时才变成 `refunded`**（P0-13 把触发条件收窄为「累计退满」）：
 * 部分退款只累计 `refundedAmount`，订单状态不变——这一单还要继续做。
 *
 * ⚠️ **金额是服务端算出来的，不是请求体传进来的**：请求体只收
 * `refundRatePercent` / `companionLiabilityRatePercent`（百分比字符串，`shared` 时才要
 * 后者）与 `responsibility`，外加幂等键与 `reviewNote`（选填），
 * **没有任何接收金额的位置**。金额一律由 `computeRefundDecisionAmounts()`
 * 按订单的**冻结经济快照**（`actualPaidAmount` / `companionBaseIncome`）计算，
 * 客户端不做金额算术。
 *
 * ⚠️ **这是 Mock 审核结果**：不调用真实微信退款、不生成微信退款单号、
 * 也不代表款项已经真实退回。页面必须原样展示 `ADMIN_REFUND_MOCK_NOTICE`。
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
