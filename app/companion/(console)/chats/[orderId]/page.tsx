import Link from "next/link";
import { notFound } from "next/navigation";
import CompanionChatConsole from "@/components/companion/CompanionChatConsole";
import { getSessionUser } from "@/lib/auth/session";
import { COMPANION_CHAT_BACK_LABEL } from "@/lib/constants/companionConsole";
import { COMPANION_CHAT_PAGE_TITLE } from "@/lib/constants/conversations";
import { COMPANION_ORDER_DETAIL_PAGE_TITLE } from "@/lib/constants/dispatch";
import { isOrderStatus, ORDER_STATUS_CLASS } from "@/lib/constants/orders";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { getCompanionChatDetail } from "@/lib/services/companionConversations";
import type { CompanionChatDetail } from "@/lib/types/companionChat";

/**
 * 打手订单聊天页（P0-14，`/companion/chats/[orderId]`）。
 *
 * ## 为什么这里没有 `loading.tsx`
 *
 * 与 `app/companion/(console)/orders/[id]/` 同一条理由：加载边界一旦罩住它，
 * 外壳会先以 200 发出，迟到的 `notFound()` 只能改内容、改不了状态码——
 * 「不是你的订单 / 你已被换下」就变成一屏 200 的 404 文案。整棵 `chats/` 因此
 * 都不挂 loading 边界。
 *
 * ## 取不到就是 404
 *
 * `getCompanionChatDetail` 重新校验归属（`Order.actualCompanionId === 当前 companionId`）
 * 且只会取到**当前那一段**履约会话；订单不存在、不是本人、已被换下，对外完全一致 →
 * `notFound()`。列表入口隐藏不是保护：接口可以被直接请求。
 */
export default async function CompanionChatPage({
  params,
}: PageProps<"/companion/chats/[orderId]">) {
  const { orderId } = await params;

  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const detail = await getCompanionChatDetail(access.companion.companionId, orderId ?? "");
  if (!detail) notFound();

  return (
    <>
      <h2 className="text-[14px] font-semibold text-ink">{COMPANION_CHAT_PAGE_TITLE}</h2>

      <ChatSummarySection detail={detail} />

      <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
        {detail.notice}
      </p>

      <CompanionChatConsole
        orderId={detail.orderId}
        initialMessages={detail.messages}
        isReadOnly={detail.isReadOnly}
      />

      <div className="flex flex-col gap-2 pb-2">
        <Link
          href={`/companion/orders/${detail.orderId}`}
          className="flex h-11 items-center justify-center rounded-full border border-line text-[15px] text-ink-2"
        >
          {COMPANION_ORDER_DETAIL_PAGE_TITLE}
        </Link>
        <Link
          href="/companion/chats"
          className="flex h-11 items-center justify-center rounded-full border border-line text-[15px] text-ink-2"
        >
          {COMPANION_CHAT_BACK_LABEL}
        </Link>
      </div>
    </>
  );
}

/** 订单摘要：订单号、状态、下单用户昵称。状态色只从 `ORDER_STATUS_CLASS` 取。 */
function ChatSummarySection({ detail }: { detail: CompanionChatDetail }) {
  const statusClass = isOrderStatus(detail.orderStatus)
    ? ORDER_STATUS_CLASS[detail.orderStatus]
    : "";

  return (
    <section className="rounded-2xl border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {detail.orderNo}
        </span>
        <span className={`shrink-0 text-[13px] font-medium ${statusClass}`}>
          {detail.orderStatusLabel}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-ink">下单用户：{detail.customerNickname}</p>
    </section>
  );
}
