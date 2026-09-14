"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  STAFF_MESSAGE_SEND_HINT,
  STAFF_NOT_REALTIME_NOTICE,
  STAFF_SEND_LABEL,
  STAFF_REFRESH_LABEL,
  staffUnreadCount,
} from "@/lib/constants/staff";
import { MESSAGE_MAX_LENGTH, normalizeMessageBody } from "@/lib/constants/service";
import {
  fetchStaffConversation,
  markStaffConversationRead,
  sendStaffMessage,
} from "@/lib/services/staffHttp";
import type { StaffConversationDetail, StaffConversationMessage } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";

type RefreshStatus = "idle" | "loading";

/**
 * 订单沟通（客服工作台）。
 *
 * ⚠️ **不是实时聊天**：没有 WebSocket，对方的新消息只有重新取数才会出现。
 * 这一点写在页面上的 `STAFF_NOT_REALTIME_NOTICE` 里——不写，客服会以为「发了没反应」。
 *
 * 三条与用户侧一致、但方向不同的约束：
 *
 * 1. **只能访问有会话的订单**：`orderId` 由服务端校验过（没有会话就是 404），
 *    页面拿到的已经是校验过的数据。这一页**不认识**任何订单号猜测。
 * 2. **发送者身份不由客户端决定**：请求体里只有正文与幂等键，
 *    `senderId` 取自客服会话、`senderRole` 由服务端写成 `customer_service`。
 *    因此这里也不可能伪造一条「用户」或「管理员」消息。
 * 3. **发送失败保留输入框内容**：错误出现在输入区上方，内容不动，可以直接重试；
 *    重试沿用同一个幂等键，服务端因此不会因为重试多出一条消息。
 *    改动输入即视为新的一次发送意图，换一个键。
 *
 * ⚠️ **已读方向**：进入会话即标记**当前客服**的已读位置（与用户侧同一条做法）。
 * 它只移动 `staffReads` 里这位客服自己的位置，**不碰用户的未读**——
 * 客服读了不等于用户读了，反过来也一样。
 *
 * ⚠️ **超长消息明确报错，不静默截断**：输入框没有 `maxLength`，可以一直写，
 * 字数实时显示；提交时由 `normalizeMessageBody()`（与用户端同一个函数）给出明确错误。
 * 截断会让人以为「我已经发出去了」，而对方收到的是半句话。
 */
export default function StaffConversationConsole({
  orderId,
  initialDetail,
}: {
  orderId: string;
  initialDetail: StaffConversationDetail;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState(initialDetail);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>("idle");
  const [refreshError, setRefreshError] = useState("");
  const [flash, setFlash] = useState("");

  const sendingRef = useRef(false);
  /** 一次「发送意图」一个键；改动输入即视为新意图，失败重试沿用 */
  const sendKeyRef = useRef<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  // 进入会话即标记已读。放在 effect 里而不是渲染时：渲染期写入会被链接预取提前触发，
  // 会话还没被打开就被标成已读了。标记失败不影响阅读与发送——下次进来会再标一次。
  //
  // 标记成功后跟一次 `router.refresh()`，与用户侧同一条做法：不刷新的话，
  // 客服按「返回」时 `/staff/conversations?unread=1` 会复用进入之前的服务端快照，
  // 刚读过的会话仍然留在未读列表里。`refreshReducer` 里的 `invalidateBfCache()`
  // 会把前进/后退缓存整体置为失效，正是为这个场景准备的。
  useEffect(() => {
    void markStaffConversationRead(orderId)
      .then(() => router.refresh())
      .catch(() => {});
  }, [orderId, router]);

  // 新消息进来后滚到底部
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [detail.messages.length]);

  async function refresh(): Promise<boolean> {
    setRefreshStatus("loading");
    setRefreshError("");
    try {
      const next = await fetchStaffConversation(orderId);
      setDetail(next);
      return true;
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "刷新失败，请稍后重试");
      return false;
    } finally {
      setRefreshStatus("idle");
    }
  }

  async function send() {
    if (sendingRef.current) return;

    const normalized = normalizeMessageBody(input);
    if (!normalized.ok) {
      setError(normalized.message);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setError("");
    setFlash("");
    sendKeyRef.current ??= crypto.randomUUID();

    try {
      const result = await sendStaffMessage(orderId, sendKeyRef.current, normalized.body);
      // 发送成功后重新拉取：页面上显示的是服务端确认过的历史，不是本地拼出来的
      sendKeyRef.current = null;
      setInput("");
      await refresh();
      setFlash(
        result.created
          ? "已发送。用户需要刷新才能看到（本阶段没有实时推送）"
          : "这条消息之前已经发出去了，没有重复发送",
      );
    } catch (cause) {
      // 失败时**不清空输入框**，可以直接再点一次发送
      setError(cause instanceof Error ? cause.message : "发送失败，请稍后重试");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const unread = staffUnreadCount(detail.messages, detail.staffLastReadAt);
  const length = countCharacters(input.trim());
  const overLength = length > MESSAGE_MAX_LENGTH;

  return (
    <section className="flex flex-col rounded-xl border border-admin-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-admin-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-medium text-ink">
            沟通记录
            <span className="ml-2 font-mono text-[12px] text-ink-3">{detail.order.orderNo}</span>
          </h2>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            {/* 已读状态按「当前客服」显示，不是用户侧的未读 */}
            {detail.staffLastReadAt
              ? `你上次读到 ${formatDateTime(detail.staffLastReadAt)}`
              : "你还没有读过这个会话"}
            {unread > 0 ? ` · 当前有 ${unread} 条未读` : " · 没有未读"}
          </p>
        </div>

        <button
          type="button"
          disabled={refreshStatus === "loading"}
          onClick={() => void refresh()}
          className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
        >
          {refreshStatus === "loading" ? `${STAFF_REFRESH_LABEL}中…` : STAFF_REFRESH_LABEL}
        </button>
      </div>

      <p className="border-b border-admin-line bg-page px-4 py-2 text-[12px] leading-4 text-ink-3">
        {STAFF_NOT_REALTIME_NOTICE}
      </p>

      {refreshError ? (
        <p role="alert" className="px-4 pt-2 text-[12px] leading-4 text-brand-red">
          {refreshError}
        </p>
      ) : null}

      {/* 消息列表：桌面优先，靠 max-height + overflow 在自己的区域内滚动，
          页面本身不出现第二个滚动条 */}
      <ol className="flex max-h-[520px] flex-col gap-4 overflow-y-auto px-4 py-4">
        {detail.messages.length === 0 ? (
          <li className="py-8 text-center text-[13px] leading-5 text-ink-3">
            这个会话还没有消息。用户还没有描述问题，你可以先等，也可以主动打个招呼。
          </li>
        ) : (
          detail.messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} />
            </li>
          ))
        )}
        <div ref={listEndRef} />
      </ol>

      {/* 发送区 */}
      <div className="border-t border-admin-line px-4 py-3">
        {error ? (
          <p role="alert" className="mb-1.5 text-[12px] leading-4 text-brand-red">
            {error}
          </p>
        ) : null}

        {flash ? (
          <p role="status" className="mb-1.5 text-[12px] leading-4 text-status-success">
            {flash}
          </p>
        ) : null}

        <div className="flex items-end gap-2">
          <input
            value={input}
            disabled={sending}
            onChange={(event) => {
              // 内容改了就是另一次发送意图：下次发送用新的幂等键
              sendKeyRef.current = null;
              setInput(event.target.value);
              setError("");
              setFlash("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void send();
            }}
            placeholder="输入回复…"
            aria-label="消息内容"
            aria-invalid={overLength ? true : undefined}
            aria-describedby={overLength ? "staff-message-length-error" : undefined}
            className={`h-10 min-w-0 flex-1 rounded-lg border px-3 text-[13px] text-ink outline-none ${
              overLength ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
            } disabled:opacity-60`}
          />

          <button
            type="button"
            disabled={sending}
            onClick={() => void send()}
            className="h-10 shrink-0 rounded-lg bg-ink px-5 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {sending ? "发送中…" : STAFF_SEND_LABEL}
          </button>
        </div>

        <p className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] leading-4 text-ink-3">
          <span>{STAFF_MESSAGE_SEND_HINT}</span>
          {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚 */}
          <span
            id="staff-message-length-error"
            {...(overLength ? { role: "alert" } : {})}
            className={`tabular-nums ${overLength ? "text-brand-red" : ""}`}
          >
            {length} / {MESSAGE_MAX_LENGTH}
          </span>
        </p>
      </div>
    </section>
  );
}

/**
 * 消息气泡。
 *
 * ⚠️ 名称与头像来自**消息自己的快照**（`senderName` / `senderAvatarUrl`），
 * 不是现查客服账号：客服被停用或软删除之后，历史消息仍然显示得出当时的名字与头像，
 * 不会变成空白。
 *
 * 自己的消息靠右（蓝色），别人的靠左（白底并标出发送者身份）。
 * 三方都在同一个列表里：用户、护航、客服——这一页要回答的是「这件事聊到哪了」，
 * 把护航的话藏起来会让人读不懂上下文。
 */
function MessageBubble({ message }: { message: StaffConversationMessage }) {
  return (
    <div className={`flex flex-col ${message.isSelf ? "items-end" : "items-start"}`}>
      <span className="mb-1 text-[11px] text-ink-3">
        {message.senderRoleLabel}
        {/* 自己的气泡上不重复写自己的名字：气泡位置已经说了这件事 */}
        {message.isSelf ? "" : ` · ${message.senderName}`}
        {message.senderAvatarUrl && !message.isSelf ? (
          <img
            src={message.senderAvatarUrl}
            alt=""
            className="ml-1 inline-block h-4 w-4 rounded-full border border-admin-line align-[-2px] object-cover"
          />
        ) : null}
      </span>

      <div
        className={`max-w-[70%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[13px] leading-5 ${
          message.isSelf ? "bg-brand-blue text-white" : "bg-page text-ink"
        }`}
      >
        {message.body}
      </div>

      <span className="mt-1 text-[11px] text-ink-3">{formatDateTime(message.createdAt)}</span>
    </div>
  );
}
