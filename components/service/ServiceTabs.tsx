"use client";

/* eslint-disable @next/next/no-img-element -- 商品封面为 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import {
  CONVERSATION_EMPTY_DESCRIPTION,
  CONVERSATION_EMPTY_TITLE,
  NOTIFICATION_EMPTY_DESCRIPTION,
  NOTIFICATION_EMPTY_TITLE,
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_PAGE_SIZE,
  SERVICE_TABS,
  SUPPORT_CONTACT_PLACEHOLDER,
  SUPPORT_CONTACT_PLACEHOLDER_TITLE,
  SUPPORT_HELP_ITEMS,
  SUPPORT_INTRO_DESCRIPTION,
  SUPPORT_INTRO_TITLE,
  messageSenderLabel,
  type ServiceTabKey,
} from "@/lib/constants/service";
import { fetchNotifications, markNotificationRead } from "@/lib/services/serviceHttp";
import type { OrderConversation } from "@/lib/types/message";
import type { NotificationListItem, NotificationPage } from "@/lib/types/notification";
import { formatDateTime } from "@/lib/utils/format";

/** 可发起沟通的订单：只带够列表展示的字段。 */
export type ServiceOrderOption = {
  id: string;
  orderNo: string;
  productTitle: string;
  statusLabel: string;
};

type MoreStatus = "idle" | "loading" | "error";

/**
 * 客服页的三个子 Tab。
 *
 * 三个 Tab 的首屏数据都由 Server Component 取好后传进来，本组件**不在挂载时再请求一次**，
 * 因此切 Tab 不会闪一下加载中；之后只有「加载更多通知」与「标记已读」会发请求。
 *
 * 权限边界全在服务端：会话列表与通知列表只包含当前用户的数据（服务端按 userId 查的），
 * 本组件不做任何过滤——前端过滤挡不住任何人。
 *
 * 「联系客服」里**不出现任何 QQ / 微信 / 电话**：这些联系方式尚未确认，编造出来的号码
 * 会让用户真的去加。未定项一律用占位说明代替。
 *
 * 通知的已读标记：点开哪条就标记哪条。标记是幂等的，重复点不会改动第一次的已读时间。
 */
export default function ServiceTabs({
  initialTab,
  conversations,
  notifications,
  orders,
}: {
  initialTab: ServiceTabKey;
  conversations: OrderConversation[];
  notifications: NotificationPage;
  orders: ServiceOrderOption[];
}) {
  const [tab, setTab] = useState<ServiceTabKey>(initialTab);

  // 通知列表是唯一有本地状态的一份数据：展开、已读、加载更多都在这里推进
  const [items, setItems] = useState<NotificationListItem[]>(notifications.items);
  const [unreadCount, setUnreadCount] = useState(notifications.unreadCount);
  const [page, setPage] = useState(notifications.page);
  const [hasMore, setHasMore] = useState(notifications.hasMore);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");
  const [noticeError, setNoticeError] = useState("");

  const moreLoadingRef = useRef(false);
  // 已读标记的同步闸门：同一条通知连点两次只发一次请求
  const markingRef = useRef<Set<string>>(new Set());

  const unreadConversations = conversations.filter((item) => item.unreadCount > 0).length;

  async function toggleNotification(notification: NotificationListItem) {
    const opening = expandedId !== notification.id;
    setExpandedId(opening ? notification.id : null);
    setNoticeError("");
    if (!opening) return;

    // 先本地置为已读，界面立刻响应；请求失败时再把状态改回来并提示
    if (notification.readAt) return;
    if (markingRef.current.has(notification.id)) return;
    markingRef.current.add(notification.id);

    try {
      const updated = await markNotificationRead(notification.id);
      setItems((current) =>
        current.map((item) => (item.id === updated.id ? { ...item, readAt: updated.readAt } : item)),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch (cause) {
      setNoticeError(cause instanceof Error ? cause.message : "标记已读失败，请稍后重试");
    } finally {
      markingRef.current.delete(notification.id);
    }
  }

  async function loadMoreNotifications() {
    if (moreLoadingRef.current) return;
    moreLoadingRef.current = true;
    setMoreStatus("loading");
    setMoreError("");

    try {
      const next = await fetchNotifications(page + 1, NOTIFICATION_PAGE_SIZE);
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...next.items.filter((item) => !seen.has(item.id))];
      });
      setPage(next.page);
      setHasMore(next.hasMore);
      setUnreadCount(next.unreadCount);
      setMoreStatus("idle");
    } catch (cause) {
      // 加载更多失败：已经加载出来的通知保留在页面上
      setMoreStatus("error");
      setMoreError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    } finally {
      moreLoadingRef.current = false;
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {SERVICE_TABS.map((item) => {
            const active = item.key === tab;
            // 未读数分别来自会话列表与通知列表，都是当前用户自己的
            const badge =
              item.key === "chat" ? unreadConversations : item.key === "notice" ? unreadCount : 0;

            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => setTab(item.key)}
                className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-[5px] text-[13px] leading-[18px] ${
                  active ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {item.label}
                {badge > 0 ? (
                  <span
                    className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[11px] leading-none ${
                      active ? "bg-white text-brand-red" : "bg-brand-red text-white"
                    }`}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        {tab === "chat" ? (
          conversations.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-10">
              <EmptyState title={CONVERSATION_EMPTY_TITLE} description={CONVERSATION_EMPTY_DESCRIPTION} />
              <button
                type="button"
                onClick={() => setTab("contact")}
                className="mt-4 rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                去联系客服
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {conversations.map((conversation) => (
                <li key={conversation.orderId}>
                  <ConversationRow conversation={conversation} />
                </li>
              ))}
            </ul>
          )
        ) : null}

        {tab === "contact" ? (
          <div className="flex flex-col gap-2.5">
            <section className="rounded-[10px] bg-surface p-4">
              <h2 className="text-[15px] font-medium text-ink">{SUPPORT_INTRO_TITLE}</h2>
              <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{SUPPORT_INTRO_DESCRIPTION}</p>
            </section>

            <section className="rounded-[10px] bg-surface p-4">
              <h2 className="text-[15px] font-medium text-ink">可以做的事</h2>
              <ul className="mt-2 flex flex-col gap-2">
                {SUPPORT_HELP_ITEMS.map((item) => (
                  <li key={item.title}>
                    <p className="text-[13px] text-ink-2">{item.title}</p>
                    <p className="mt-0.5 text-[12px] leading-4 text-ink-3">{item.description}</p>
                  </li>
                ))}
              </ul>
              <Link
                href="/complaints/new"
                className="mt-3 flex h-10 items-center justify-center rounded-full border border-line text-[14px] text-ink-2"
              >
                提交投诉
              </Link>
            </section>

            {/* 选一笔订单发起沟通：会话在聊天页打开时建立，不需要先有历史消息 */}
            <section className="rounded-[10px] bg-surface p-4">
              <h2 className="text-[15px] font-medium text-ink">选择订单发起沟通</h2>
              {orders.length === 0 ? (
                <p className="mt-1.5 text-[13px] leading-5 text-ink-3">暂无可选择的订单。</p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {orders.map((order) => (
                    <li key={order.id}>
                      <Link
                        href={`/service/chat/${order.id}`}
                        className="block border-b border-line py-2 last:border-b-0"
                      >
                        <span className="line-clamp-1 text-[13px] text-ink">{order.productTitle}</span>
                        <span className="mt-0.5 block text-[12px] text-ink-3">
                          订单号 {order.orderNo} · {order.statusLabel}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 未确认的联系方式一律用占位说明，不编造 QQ / 微信 / 电话 */}
            <section className="rounded-[10px] bg-surface p-4">
              <h2 className="text-[15px] font-medium text-ink">{SUPPORT_CONTACT_PLACEHOLDER_TITLE}</h2>
              <p className="mt-1.5 text-[12px] leading-4 text-ink-3">{SUPPORT_CONTACT_PLACEHOLDER}</p>
            </section>
          </div>
        ) : null}

        {tab === "notice" ? (
          items.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-10">
              <EmptyState title={NOTIFICATION_EMPTY_TITLE} description={NOTIFICATION_EMPTY_DESCRIPTION} />
            </div>
          ) : (
            <>
              {noticeError ? (
                <p role="alert" className="mb-2 text-[12px] leading-4 text-brand-red">
                  {noticeError}
                </p>
              ) : null}

              <ul className="flex flex-col gap-2.5">
                {items.map((notification) => (
                  <li key={notification.id}>
                    <NotificationRow
                      notification={notification}
                      expanded={expandedId === notification.id}
                      onToggle={() => void toggleNotification(notification)}
                    />
                  </li>
                ))}
              </ul>

              <div className="mt-3">
                {hasMore ? (
                  <button
                    type="button"
                    disabled={moreStatus === "loading"}
                    onClick={() => void loadMoreNotifications()}
                    className="w-full rounded-full border border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
                  >
                    {moreStatus === "loading" ? "加载中…" : "加载更多"}
                  </button>
                ) : (
                  <p className="text-center text-[12px] text-ink-3">没有更多了</p>
                )}

                {moreStatus === "error" ? (
                  <div className="mt-2 flex flex-col items-center gap-2">
                    <p className="text-center text-[12px] leading-5 text-ink-3">{moreError}</p>
                    <button
                      type="button"
                      onClick={() => void loadMoreNotifications()}
                      className="text-[12px] text-brand-blue underline"
                    >
                      重试
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/** 会话行：订单号、商品名、最后一条消息、时间与未读状态。整行进聊天页。 */
function ConversationRow({ conversation }: { conversation: OrderConversation }) {
  // 最后一条是自己发的就显示「我」，否则显示角色名（客服 / 打手）
  const lastLabel =
    conversation.lastMessageRole === null
      ? ""
      : `${messageSenderLabel(conversation.lastMessageRole, conversation.lastMessageRole === "user")}：`;

  return (
    <Link
      href={`/service/chat/${conversation.orderId}`}
      className="block rounded-[10px] bg-surface p-3"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
          订单号 {conversation.orderNo}
        </span>
        {conversation.lastMessageAt ? (
          <span className="shrink-0 text-[12px] text-ink-3">
            {formatDateTime(conversation.lastMessageAt)}
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex gap-3">
        <img
          src={conversation.productCoverUrl}
          alt={conversation.productTitle}
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-[8px] border border-line object-cover"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="line-clamp-1 text-[14px] font-medium text-ink">
            {conversation.productTitle}
          </h3>
          <p className="mt-1 line-clamp-1 text-[12px] text-ink-3">
            {conversation.lastMessageBody
              ? `${lastLabel}${conversation.lastMessageBody}`
              : "还没有消息，点进去和客服沟通"}
          </p>
        </div>

        {conversation.unreadCount > 0 ? (
          <span className="mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-red px-1.5 text-[11px] leading-none text-white">
            {conversation.unreadCount}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/** 通知行：点一下展开正文并标记已读；有 `href` 时再给一个跳转入口。 */
function NotificationRow({
  notification,
  expanded,
  onToggle,
}: {
  notification: NotificationListItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const unread = notification.readAt === null;

  return (
    <div className="rounded-[10px] bg-surface p-3">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="block w-full text-left">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-[4px] bg-page px-1.5 py-0.5 text-[11px] text-ink-2">
            {NOTIFICATION_KIND_LABELS[notification.kind]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
            {notification.title}
          </span>
          {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-red" aria-hidden /> : null}
          <span className="shrink-0 text-[12px] text-ink-3">
            {formatDateTime(notification.createdAt)}
          </span>
        </div>

        {expanded ? (
          <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
            {notification.body}
          </p>
        ) : (
          <p className="mt-1.5 line-clamp-1 text-[13px] text-ink-3">{notification.summary}</p>
        )}
      </button>

      {expanded && notification.href ? (
        <Link href={notification.href} className="mt-2 inline-block text-[13px] text-brand-blue">
          查看详情 ›
        </Link>
      ) : null}
    </div>
  );
}
