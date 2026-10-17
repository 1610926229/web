"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SafeAreaContainer from "@/components/common/SafeAreaContainer";
import {
  COMPANION_CHAT_EMPTY_MESSAGES,
  COMPANION_CHAT_INPUT_ARIA_LABEL,
  COMPANION_CHAT_INPUT_PLACEHOLDER,
  COMPANION_CHAT_MAX_LENGTH_HINT,
  COMPANION_CHAT_READONLY_FOOTER,
  COMPANION_CHAT_REFRESH_LABEL,
  COMPANION_CHAT_REFRESHING_LABEL,
  COMPANION_CHAT_SEND_LABEL,
  COMPANION_CHAT_SENDING_LABEL,
} from "@/lib/constants/companionConsole";
import { MESSAGE_MAX_LENGTH, normalizeMessageBody } from "@/lib/constants/service";
import {
  fetchCompanionChat,
  markCompanionChatRead,
  sendCompanionMessage,
} from "@/lib/services/companionHttp";
import type { CompanionChatMessage } from "@/lib/types/companionChat";
import { formatDateTime } from "@/lib/utils/format";

type RefreshStatus = "idle" | "loading";

/**
 * 打手端订单聊天（P0-14）—— 与用户端 `components/service/OrderChat.tsx` 对称，
 * 但视角相反：这里把 `companion` 显示成「我」。
 *
 * ## 不是实时聊天
 *
 * 没有 WebSocket / 实时推送。历史消息由 Server Component 取好传进来，之后只有两种
 * 情况更新：发送成功后重新拉取，或打手点「刷新」。
 *
 * ## 为什么消息身份由服务端算好（`isSelf` / `senderLabel`）
 *
 * 页面**不自己拼称呼**：自己拼就得在页面上判「哪个角色算我」，而同一批数据在
 * 用户端与打手端是两个视角，两端各判一次，迟早有一端判反。`senderLabel` 由服务端
 * （`companionMessageSenderLabel`）按 `senderId` 算好，页面原样显示。
 *
 * ## 三条交互约束
 *
 * 1. 发送失败**不清空输入框**：错误提示出现在输入区上方，内容不动，可直接重试；
 *    重试沿用同一个幂等键，服务端因此不会多出一条消息。
 * 2. 一次「发送意图」一个幂等键：内容变化即视为新意图（换键），失败重试沿用。
 * 3. 进入即标记已读，成功后 `router.refresh()`（理由与 OrderChat 完全一致：
 *    不刷新的话，返回列表时刚清掉的未读会从前进/后退缓存里原样回来）。
 *
 * ## 只读（产品裁定 `TBD-P0-14-1`）
 *
 * 订单已全额退款时 `isReadOnly` 为真，此时**整个输入区被替换成一行说明**：
 * 刷新按钮、消息列表、已读标记**都照旧**——裁定要求的是「历史保留可查」，
 * 只关掉写。
 *
 * ⚠️ 用**替换**而不是把输入框 `disabled`：一个灰掉的输入框会让人反复去点，
 * 而这里的情况是「这辈子都不能再发了」，不是「暂时不行」。同一条理由在
 * `OrderChat` 的发送对象选择器上也是这么处理的。
 *
 * ⚠️ 页面**不自己判** `orderStatus === "refunded"`：`isReadOnly` 由服务端按唯一判据算好
 * （见 `lib/types/companionChat.ts`），页面再判一次就等于多出一份会走样的副本。
 */
export default function CompanionChatConsole({
  orderId,
  initialMessages,
  isReadOnly = false,
}: {
  orderId: string;
  initialMessages: CompanionChatMessage[];
  isReadOnly?: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>("idle");
  const [refreshError, setRefreshError] = useState("");

  // 双击防重：state 更新是异步的，第二次点击可能赶在 disabled 生效之前到达
  const sendingRef = useRef(false);
  /** 一次「发送意图」一个键；改动输入即视为新意图，失败重试沿用。 */
  const sendKeyRef = useRef<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  // 进入会话即标记已读。放在 effect 里而不是渲染时：渲染期写入会被链接预取提前触发，
  // 会话还没被打开就被标成已读了。标记失败不影响阅读与发送——下次进来会再标一次。
  // 标记成功后必须跟一次 `router.refresh()`，理由与 OrderChat 相同：清掉上一页
  // 前进/后退缓存里的未读角标（`router.refresh()` 只合并 RSC 载荷，不丢 `useState`）。
  useEffect(() => {
    void markCompanionChatRead(orderId)
      .then(() => router.refresh())
      .catch(() => {});
  }, [orderId, router]);

  // 新消息进来后滚到底部。用 scrollIntoView 而不是给容器设 overflow，
  // 避免出现第二个滚动容器把输入区的 sticky 弄失效。
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  async function refresh() {
    setRefreshStatus("loading");
    setRefreshError("");
    try {
      const next = await fetchCompanionChat(orderId);
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
      // 与接口同一条规则、同一句话：本地这一下只是不白跑一趟网络
      setError(normalized.message);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setError("");
    sendKeyRef.current ??= crypto.randomUUID();

    try {
      await sendCompanionMessage(orderId, normalized.body, sendKeyRef.current);
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
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-end px-3 pt-2">
        <button
          type="button"
          disabled={refreshStatus === "loading"}
          onClick={() => void refresh()}
          className="rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-ink-2 disabled:opacity-60"
        >
          {refreshStatus === "loading"
            ? COMPANION_CHAT_REFRESHING_LABEL
            : COMPANION_CHAT_REFRESH_LABEL}
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
            {COMPANION_CHAT_EMPTY_MESSAGES}
          </li>
        ) : null}

        {messages.map((message) => (
          <li key={message.id}>
            <MessageBubble message={message} />
          </li>
        ))}

        <div ref={listEndRef} />
      </ol>

      {/* 输入区：贴底并补安全区，虚拟键盘弹起时仍在可视区域内 */}
      {isReadOnly ? (
        <SafeAreaContainer className="sticky bottom-0 z-20 border-t border-line bg-surface px-3 py-3">
          <p className="text-center text-[12px] leading-5 text-ink-3">
            {COMPANION_CHAT_READONLY_FOOTER}
          </p>
        </SafeAreaContainer>
      ) : (
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
              placeholder={COMPANION_CHAT_INPUT_PLACEHOLDER}
              aria-label={COMPANION_CHAT_INPUT_ARIA_LABEL}
              className="h-10 min-w-0 flex-1 rounded-full bg-page px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
            />

            <button
              type="button"
              disabled={sending}
              onClick={() => void send()}
              className="h-10 shrink-0 rounded-full bg-brand-red px-5 text-[14px] font-medium text-white disabled:opacity-60"
            >
              {sending ? COMPANION_CHAT_SENDING_LABEL : COMPANION_CHAT_SEND_LABEL}
            </button>
          </div>

          <p className="mt-1 text-[11px] leading-4 text-ink-3">{COMPANION_CHAT_MAX_LENGTH_HINT}</p>
        </SafeAreaContainer>
      )}
    </div>
  );
}

/**
 * 消息气泡：自己发的靠右（品牌红），用户发来的靠左（灰底）。
 *
 * ⚠️ `isSelf` 与 `senderLabel` 都由服务端算好（`toCompanionChatMessage`），
 * 页面**只按 `isSelf` 决定左右**、**原样显示 `senderLabel`**，不自己拼称呼——
 * 自己拼就得在页面上判「哪个角色算我」，两端各判一次迟早有一端判反。
 */
function MessageBubble({ message }: { message: CompanionChatMessage }) {
  return (
    <div className={`flex flex-col ${message.isSelf ? "items-end" : "items-start"}`}>
      <span className="mb-1 text-[11px] text-ink-3">{message.senderLabel}</span>

      <div
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-[10px] px-3 py-2 text-[14px] leading-5 ${
          message.isSelf ? "bg-brand-red text-white" : "bg-page text-ink"
        }`}
      >
        {message.body}
      </div>

      <span className="mt-1 text-[11px] text-ink-3">{formatDateTime(message.createdAt)}</span>
    </div>
  );
}
