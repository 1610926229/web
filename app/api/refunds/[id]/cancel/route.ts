import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { cancelRefundForUser } from "@/lib/services/refunds";

/**
 * 撤销退款申请接口（浏览器端调用）。
 *
 * 只有**待审核**的申请可以由用户撤销；审核中的申请本阶段不允许撤销（返回 400 与明确提示）。
 * 撤销只改退款申请的状态，**不动订单**：订单按原进度继续。
 *
 * 这里也是用户端唯一能改动退款状态的地方——没有任何「审核通过 / 拒绝」的接口。
 *
 * 归属与状态在同一段同步代码里判断（见 `mockRefundRepository.cancelRefund`），
 * 因此不存在「查到的时候还是待审核、写的时候已经变了」的窗口。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/refunds/[id]/cancel">) {
  try {
    const user = await requireUser();
    const { id } = await params;

    return ok(await cancelRefundForUser(id ?? "", user.id));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
