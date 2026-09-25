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
 *
 * ⚠️ **P0-12 起这一页只服务「已经开始服务」之后的售后申请**（`serving` / `completed`）。
 * `paid` / `accepted` 走订单详情页的「直接退款」按钮（免审批、当场全额退），
 * 因此这里对那两档不给表单——理由与那一支的注释写在下面。
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

  /*
    尚未开始服务（`paid` / `accepted`）的订单**不走这张表单**（P0-12）：它们当场全额退款、
    免审批，因此没有原因、没有说明、没有凭证要填——让人填一张「申请」表，再等着谁来批，
    正是 2026-09-23 新规明文禁止的那种转成人工审批的做法。

    ⚠️ 这一支**必须排在 `refundSummary` 之前**。这两条同时成立是可能的：P0-12 之前
    创建的、还挂着的退款申请会留在订单上（那两档当时确实走人工审核）。此时用户该看到的
    仍然是「直接退款」这个入口——去看一条永远等不到审批的进度，只会让他以为还得等。
    申请本身不因此作废：用户可以自己在退款详情页把它撤销。
  */
  if (detail.allowedActions.canDirectRefund) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="该订单可直接全额退款"
          description={`尚未开始服务的订单无需申请，也不需要客服审核，在订单详情页即可直接全额退款。订单当前状态：${ORDER_STATUS_LABELS[detail.status]}。`}
        />
        <BackLink href={`/orders/${detail.id}`} label="返回订单详情退款" />
      </div>
    );
  }

  /*
    不能申请退款时，**为什么不能**决定用户下一步该去哪，因此分两种说法：
    还挂着一笔进行中的申请 → 引到退款进度页；订单状态本身不可退 → 说明原因。

    ⚠️ 闸门是服务端的 `canRequestRefund`，**不是「这一单有没有退款记录」**。
    P0-13（D10）起已拒绝 / 已撤销过的订单可以再次申请，所以订单上「有一条旧记录」
    完全不等于「不能再申请」——拿记录的存在与否当闸门，会让那条裁定在页面上失效：
    服务端说「可以申请」，页面却把表单换成了「已有退款申请」。

    ⚠️ 有记录时那条分支**排在上面**：`canRequestRefund === false` 的原因可能是
    「有进行中的申请」（此时 `refundSummary` 就是它），也可能是订单状态不可退
    （此时 `refundSummary` 可能是历史记录，引到进度页也答不了「为什么不能再申请」）。
    只有前者该给「查看退款进度」。
  */
  if (!detail.allowedActions.canRequestRefund) {
    const pending = detail.refundSummary;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        {pending ? (
          <>
            <EmptyState
              title="该订单已有退款申请"
              description={`当前状态：${REFUND_STATUS_LABELS[pending.status]}。一笔申请正在处理中，前一笔出结果之后才能再发起。`}
            />
            <BackLink href={`/refunds/${pending.id}`} label="查看退款进度" />
          </>
        ) : (
          <>
            <EmptyState
              title="该订单当前不可申请退款"
              description={`${REFUND_ORDER_NOT_ALLOWED_MESSAGE}。订单当前状态：${ORDER_STATUS_LABELS[detail.status]}。`}
            />
            <BackLink href={`/orders/${detail.id}`} label="返回订单详情" />
          </>
        )}
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
        // 用户申请的是**整单**：金额直接取订单实付金额，页面与表单都没有编辑入口。
        // ⚠️ 「申请了多少」与「最后退多少」是两个数（P0-13 起可以由管理员按比例核定），
        // 表单这里只能报申请金额，实际退款金额在退款详情页显示
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
