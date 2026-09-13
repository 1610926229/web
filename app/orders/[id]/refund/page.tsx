import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import RefundForm from "@/components/refunds/RefundForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { REFUND_ORDER_NOT_ALLOWED_MESSAGE, REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { getOrderDetailForUser } from "@/lib/services/orders";

/**
 * 申请退款页（需登录）。
 *
 * **这一页不判断「能不能退」**：能不能退由服务端的 `allowedActions.canRequestRefund` 决定，
 * 前端只照着它显示表单或说明。理由是「能不能退」既看订单状态、也看这一单有没有退款记录，
 * 前端只看状态一定算错——比如已撤销过的订单状态仍然可退，但不该再出现表单。
 *
 * 即使有人绕过这一页直接调接口，服务端也会再校验一次；这个页面只是把结果如实呈现出来。
 */
export default async function RefundApplyPage({ params }: PageProps<"/orders/[id]/refund">) {
  const { id } = await params;

  return (
    <>
      <NavBar title="申请退款" showBack />

      <RequireAuth>
        {(user) => <RefundApplyBody orderId={id ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function RefundApplyBody({ orderId, userId }: { orderId: string; userId: string }) {
  const detail = await getOrderDetailForUser(orderId, userId, undefined, "server");

  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="订单不存在"
          description="该订单可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        />
        <BackLink href="/orders" label="返回订单列表" />
      </div>
    );
  }

  // 已经有退款申请：把用户引到退款进度页，而不是给一句「不可退」就结束
  if (detail.refundSummary) {
    const { id: refundId, status } = detail.refundSummary;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="该订单已有退款申请"
          description={`当前状态：${REFUND_STATUS_LABELS[status]}。一笔订单只能发起一次退款申请，可以在退款详情里查看进度。`}
        />
        <BackLink href={`/refunds/${refundId}`} label="查看退款进度" />
      </div>
    );
  }

  // 订单状态本身不可退（已完成 / 已退款）
  if (!detail.allowedActions.canRequestRefund) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="该订单当前不可申请退款"
          description={`${REFUND_ORDER_NOT_ALLOWED_MESSAGE}。订单当前状态：${ORDER_STATUS_LABELS[detail.status]}。`}
        />
        <BackLink href={`/orders/${detail.id}`} label="返回订单详情" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip">
      <RefundForm
        orderId={detail.id}
        orderNo={detail.orderNo}
        productTitle={detail.productTitle}
        productCoverUrl={detail.productCoverUrl}
        specName={detail.specName}
        quantity={detail.quantity}
        // 整单退款：金额直接取订单实付金额，页面与表单都没有编辑入口
        amount={detail.totalAmount}
      />
    </div>
  );
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
    >
      {label}
    </Link>
  );
}
