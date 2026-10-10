import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { approveAdminRefund } from "@/lib/services/adminRefunds";

/**
 * 审核通过退款：`POST /api/admin/refunds/[id]/approve`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。**这是全仓唯一能由人工裁定退款金额的入口**：
 * 客服侧只有 `[id]` / `[id]/reject` / `[id]/start-review` 三个地址，**没有 approve**，
 * 客服只能调查、记录、提出处理意见。
 * （其它改钱的入口——`directRefundOrder`、公共池超时自动退——退的都是**固定全额**，
 * 没有可按比例裁量的空间，因此不构成「裁定」。）
 *
 * 通过必须在**同一次写入**里完成六件事：① 退款申请变为 `approved` 并写入资金决策
 * （`decision`：退款比例、退款额、打手冲回额、决策人与决策时间）；② 记录管理者、
 * 审核意见与审核时间；③ 订单写入 `refundedAmount`；④ 该订单的 Earning **整笔**冲销
 * （`reversedAmount = incomeAmount`，**状态留在 `frozen`**——见下）并补一条
 * `EarningAdjustment`；⑤ **只有全额退款**
 * 时才关闭派单并通知打手；⑥ 写一条管理审计。六件事在 `lib/data/adminRefundTransaction.ts`
 * 的一段无 `await` 的同步区段里完成，因此不存在「退款已通过但订单未退款」或相反的状态。
 *
 * ⚠️ **净额归零之后收益仍停在 `frozen`，不进入 `reversed`**（P0-15 产品裁定，
 * `02-decisions.md` §二 Q5）：这笔钱永远不会变成可提现，而「冻结中」正是这个事实。
 * `sweepMaturedEarnings` 里因此多了一道净额闸（`isEarningFullyReversed()`），
 * 保证被冲光的收益**不会在窗口到期后又被释放**。打手端看到的那句话也不取状态表，
 * 而是按净额判（`earningHintFor()`），否则会对它说「到期自动转为可提现」。
 *
 * ⚠️ **只有比例 100% 才把订单变成 `refunded`**（判据单点：`isFullyRefunded`）。
 * 部分退款（10% / 50%）**不改 `Order.status`**——这一单按原进度继续做。
 * 打手端看到的「已退款」是**派生的展示状态**（`resolveCompanionDisplayStatus`），
 * 与订单状态不是同一条线，也**不参与任何可写性判断**（聊天可写性只看真实状态）。
 *
 * ⚠️ **金额是服务端算出来的，不是请求体传进来的**：请求体只收一个业务字段
 * `refundRatePercent`（百分比字符串），外加幂等键与 `reviewNote`（选填），
 * **没有任何接收金额的位置**。两个金额一律由 `computeRefundDecisionAmounts()`
 * 按订单的**冻结经济快照**（`actualPaidAmount` / `companionBaseIncome`）计算：
 * `refundAmount = floor(actualPaidAmount × 比例)`，
 * `companionReversalAmount` **恒等于** `companionBaseIncome`（**整笔**，与比例无关）。
 * 客户端不做金额算术，但管理端界面会**实时预览**——预览复用服务端同一批纯函数。
 *
 * ⛔ **P0-15 删掉了三个请求体字段**（`responsibility` / `companionLiabilityRatePercent` /
 * `refundFullRemaining`）**与整个责任模型**：`platform` / `companion` / `shared`、
 * `companionLiabilityRate`、`platformBorneAmount` 已从类型、常量、仓储、事务、DTO、界面删除。
 * 传这些字段**不会报错，但也不会生效**（请求体按白名单挑字段）。
 * 平台最终收入是一个派生量：`actualPaidAmount − refundAmount`。
 *
 * ⚠️ **一个订单至多一次退款**：第二次申请在仓储层就被拒（`order_already_has_refund`，
 * 不看状态），因此这里不存在「累计退满」这条路径——它已被「一单一退」取代。
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
