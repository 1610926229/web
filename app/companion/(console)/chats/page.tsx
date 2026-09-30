/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_CHAT_LIST_NO_MESSAGE,
  COMPANION_CHAT_LIST_READONLY_LABEL,
} from "@/lib/constants/companionConsole";
import {
  COMPANION_CHAT_EMPTY_DESCRIPTION,
  COMPANION_CHAT_EMPTY_TITLE,
  COMPANION_CHAT_PAGE_TITLE,
  companionMessageSenderLabel,
} from "@/lib/constants/conversations";
import { isOrderStatus, ORDER_STATUS_CLASS } from "@/lib/constants/orders";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { listCompanionChats } from "@/lib/services/companionConversations";
import type { CompanionChatListItem } from "@/lib/types/companionChat";

/**
 * 打手订单聊天列表（P0-14，`/companion/chats`）。
 *
 * ## 首屏由本页直接取数，不经过 HTTP 请求自己的接口
 *
 * 与「我的订单」同一个取舍：Server Component 直连服务层。浏览器端只在
 * 刷新 / 发送 / 标记已读时才走 `lib/services/companionHttp.ts`。
 *
 * ## 行来自订单，不来自会话
 *
 * `listCompanionChats` 以 `Order.actualCompanionId` 为查询条件返回正在服务的单，
 * 因此刚接单、还没人开口的单也会出现（那正是「去打个招呼」的入口）。换人之后
 * 这一单同时从「我的订单」与本列表消失——归属判定只有服务端一处。
 */
export default async function CompanionChatsPage() {
  const user = await getSessionUser();
  // 未登录时布局已经在渲染用户端的登录控件；这里什么都不做
  if (!user) return null;

  const access = await resolveCompanionAccess(user.id);
  // 不是护航 / 资格已下架：布局已经渲染了对应的提示页
  if (access.kind !== "granted") return null;

  const data = await listCompanionChats(access.companion.companionId);

  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-[14px] font-semibold text-ink">{COMPANION_CHAT_PAGE_TITLE}</h2>
          {data.totalUnread > 0 ? (
            <span className="rounded-full bg-brand-red px-1.5 py-0.5 text-[11px] font-medium text-white">
              {data.totalUnread}
            </span>
          ) : null}
        </div>
        <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
          {data.notice}
        </p>
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          title={COMPANION_CHAT_EMPTY_TITLE}
          description={COMPANION_CHAT_EMPTY_DESCRIPTION}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.items.map((item) => (
            <li key={item.orderId}>
              <CompanionChatCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 列表里的一行：一张正在服务的单 + 它与下单用户这一段的聊天状态。 */
function CompanionChatCard({ item }: { item: CompanionChatListItem }) {
  const statusClass = isOrderStatus(item.orderStatus)
    ? ORDER_STATUS_CLASS[item.orderStatus]
    : "";

  // 打手只看得到「自己」与「下单用户」两种消息；称呼由共用函数按角色算，不在这里拼
  const lastLabel = item.lastMessageRole
    ? companionMessageSenderLabel(item.lastMessageRole, item.lastMessageRole === "companion")
    : "";

  return (
    <Link
      href={`/companion/chats/${item.orderId}`}
      className="block rounded-2xl border border-line px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {item.orderNo}
        </span>
        {/* 只读与否由服务端算好（`isReadOnly`），页面不拿 orderStatus 再判一次 */}
        {item.isReadOnly ? (
          <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-ink-3">
            {COMPANION_CHAT_LIST_READONLY_LABEL}
          </span>
        ) : null}
        {/* 状态中文名由服务端给，颜色只从 `ORDER_STATUS_CLASS` 取 */}
        <span className={`shrink-0 text-[13px] font-medium ${statusClass}`}>
          {item.orderStatusLabel}
        </span>
      </div>

      <div className="mt-2 flex gap-3">
        <img
          src={item.productCoverUrl}
          alt={item.productTitle}
          loading="lazy"
          className="h-16 w-16 shrink-0 rounded-[8px] border border-line object-cover"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
            {item.productTitle}
          </h3>
          <p className="mt-1 truncate text-[12px] text-ink-3">
            下单用户：{item.customerNickname}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          {item.lastMessageBody
            ? `${lastLabel}：${item.lastMessageBody}`
            : COMPANION_CHAT_LIST_NO_MESSAGE}
        </span>
        {item.unreadCount > 0 ? (
          <span className="shrink-0 rounded-full bg-brand-red px-1.5 py-0.5 text-[11px] font-medium text-white">
            {item.unreadCount}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
