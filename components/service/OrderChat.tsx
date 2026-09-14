"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SafeAreaContainer from "@/components/common/SafeAreaContainer";
import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_ROLE_LABELS,
  normalizeMessageBody,
} from "@/lib/constants/service";
import { fetchConversation, markConversationRead, sendMessage } from "@/lib/services/serviceHttp";
import type { OrderMessage } from "@/lib/types/message";
import { formatDateTime } from "@/lib/utils/format";

type RefreshStatus = "idle" | "loading";

/**
 * 订单沟通（用户侧）。
 *
 * ⚠️ **不是实时聊天**：没有 WebSocket，也没有第三方客服系统。
 * 历史消息由 Server Component 取好传进来，之后只有两种情况会更新：
 * 用户发送成功后重新拉取，或者用户点「刷新」。
 *
 * 三条约束在这里体现为「用户看得见的行为」：
 *
 * 1. **只能给自己的订单发消息**：订单归属由服务端校验（不属于当前用户就是 404），
 *    页面拿到的已经是校验过的数据。
 * 2. **发送者身份不由客户端决定**：请求体里只有正文与幂等键，发送者与角色由服务端写入，
 *    页面因此也不可能伪造一条「客服」消息。
 * 3. **发送失败保留输入框内容**：错误提示出现在输入区上方，内容不动，用户可以直接重试；
 *    重试沿用同一个幂等键，服务端因此不会因为重试多出一条消息。
 *
 * 输入区用 `sticky bottom-0` + 底部安全区：页面没有 TabBar，输入框不会被底部横条压住，
 * 也不会盖住消息列表（sticky 元素仍在文档流内）。
 */
export default function OrderChat({
  orderId,
  currentUserId,
  initialMessages,
}: {
  orderId: string;
  currentUserId: string;
  initialMessages: OrderMessage[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>("idle");
  const [refreshError, setRefreshError] = useState("");

  const sendingRef = useRef(false);
  /** 一次「发送意图」一个键；改动输入即视为新意图，失败重试沿用（与退款表单同一处理）。 */
  const sendKeyRef = useRef<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  // 进入会话即标记已读。放在 effect 里而不是渲染时：渲染期写入会被链接预取提前触发，
  // 会话还没被打开就被标成已读了。标记失败不影响阅读与发送——下次进来会再标一次。
  //
  // 标记成功后必须跟一次 `router.refresh()`。原因不在本页，而在**上一页**：
  // Next 的前进/后退导航会复用进入会话之前那份 `/service` 的服务端快照，
  // 而 `refreshReducer` 会调 `invalidateBfCache()` 递增全局版本号，
  // 把包括上一页在内的所有前进/后退缓存条目判为失效（`isValueExpired` 里
  // `value.version < currentCacheVersion`）。不刷新的话，用户按「返回」时
  // 刚清掉的未读红点会原样回来，只有 F5 才消失。
  //
  // 副作用是本页也会重新取一次数，但 `router.refresh()` 只合并 RSC 载荷，
  // 不丢 `useState`（输入框内容、已发消息都不受影响）。`useRouter()` 取自
  // context，身份稳定，不会让这个 effect 反复触发。
  useEffect(() => {
    void markConversationRead(orderId)
      .then(() => router.refresh())
      .catch(() => {});
  }, [orderId, router]);

  // 新消息进来后滚到底部。用 scrollIntoView 而不是给容器设 overflow，
  // 避免出现第二个滚动容器把 TabBar / 输入区的 sticky 弄失效。
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  async function refresh() {
    setRefreshStatus("loading");
    setRefreshError("");
    try {
      const next = await fetchConversation(orderId);
      setMessages(next.messages);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "刷新失败，请稍后重试");
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
    sendKeyRef.current ??= crypto.randomUUID();

    try {
      await sendMessage(orderId, normalized.body, sendKeyRef.current);
      // 发送成功后重新拉取：页面上显示的是服务端确认过的历史，不是本地拼出来的
      sendKeyRef.current = null;
      setInput("");
      await refresh();
    } catch (cause) {
      // 失败时**不清空输入框**，用户可以直接再点一次发送
      setError(cause instanceof Error ? cause.message : "发送失败，请稍后重试");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      <div className="flex items-center justify-end px-3 pt-2">
        <button
          type="button"
          disabled={refreshStatus === "loading"}
          onClick={() => void refresh()}
          className="rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 disabled:opacity-60"
        >
          {refreshStatus === "loading" ? "刷新中…" : "刷新"}
        </button>
      </div>

      {refreshError ? (
        <p role="alert" className="px-3 pt-1 text-[12px] leading-4 text-brand-red">
          {refreshError}
        </p>
      ) : null}

      <ol className="flex flex-1 flex-col gap-3 px-3 py-3">
        {messages.length === 0 ? (
          <li className="py-8 text-center text-[13px] leading-5 text-ink-3">
            还没有消息。可以在这里描述你遇到的问题，客服会跟进。
          </li>
        ) : (
          messages.map((message) => (
            <li key={message.id}>
              <MessageBubble message={message} isSelf={message.senderId === currentUserId} />
            </li>
          ))
        )}
        <div ref={listEndRef} />
      </ol>

      {/* 输入区：贴底并补安全区，虚拟键盘弹起时仍在可视区域内 */}
      <SafeAreaContainer className="sticky bottom-0 z-20 border-t border-line bg-surface px-3 py-2">
        {error ? (
          <p role="alert" className="mb-1.5 text-[12px] leading-4 text-brand-red">
            {error}
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
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") send();
            }}
            maxLength={MESSAGE_MAX_LENGTH}
            enterKeyHint="send"
            placeholder="输入消息…"
            aria-label="消息内容"
            className="h-10 min-w-0 flex-1 rounded-full bg-page px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />

          <button
            type="button"
            disabled={sending}
            onClick={() => void send()}
            className="h-10 shrink-0 rounded-full bg-brand-red px-5 text-[14px] font-medium text-white disabled:opacity-60"
          >
            {sending ? "发送中" : "发送"}
          </button>
        </div>

        <p className="mt-1 text-[11px] leading-4 text-ink-3">
          单条消息最多 {MESSAGE_MAX_LENGTH} 个字；发送后如需查看对方回复，点右上角「刷新」。
        </p>
      </SafeAreaContainer>
    </div>
  );
}

/** 消息气泡：自己发的靠右（品牌红），对方（客服 / 打手）靠左（白底并标出身份）。 */
function MessageBubble({ message, isSelf }: { message: OrderMessage; isSelf: boolean }) {
  // 自己发的一律显示「我」；对方的显示角色 + 名称（客服 · 平台客服 / 打手 · 阿泽）
  const label = isSelf
    ? MESSAGE_ROLE_LABELS.user
    : `${MESSAGE_ROLE_LABELS[message.senderRole]} · ${message.senderName}`;

  return (
    <div className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}>
      <span className="mb-1 text-[11px] text-ink-3">{label}</span>

      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-[10px] px-3 py-2 text-[14px] leading-5 ${
          isSelf ? "bg-brand-red text-white" : "bg-surface text-ink"
        }`}
      >
        {message.body}
      </div>

      <span className="mt-1 text-[11px] text-ink-3">{formatDateTime(message.createdAt)}</span>
    </div>
  );
}
