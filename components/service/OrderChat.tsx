"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SafeAreaContainer from "@/components/common/SafeAreaContainer";
import {
  CONVERSATION_SEGMENT_EMPTY_NOTICE,
  CONVERSATION_SEGMENT_HISTORY_NOTICE,
  CONVERSATION_SEGMENT_REFUNDED_NOTICE,
} from "@/lib/constants/conversations";
import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_ROLE_LABELS,
  normalizeMessageBody,
  type MessageTarget,
} from "@/lib/constants/service";
import { fetchConversation, markConversationRead, sendMessage } from "@/lib/services/serviceHttp";
import type { OrderConversationSegment, OrderMessageView } from "@/lib/types/message";
import { formatDateTime } from "@/lib/utils/format";

type RefreshStatus = "idle" | "loading";

/**
 * 可发送的目标：客服沟通恒可发；「当前打手」只在有当前履约段时出现。
 *
 * ⚠️ `label` **取自 `MESSAGE_ROLE_LABELS`**，不在这里另写一遍。用户端的角色称呼
 * 是「打手」（`lib/constants/service.ts` 的表，客服端与打手端才叫「护航」）；
 * 在组件里硬编码一个词，就会出现「分段标题写着『打手沟通』、上面的按钮写着『护航』」
 * ——两句话隔十几像素，说的却是同一个人。取同一张表，改一处两边一起改。
 */
type SendTarget = { value: MessageTarget; label: string };

/**
 * 分段标题栏：把「哪一段」在视觉上切开。
 *
 * ⚠️ 历史段落**必须自带只读说明**，而不是只在输入区禁用。用户滚动到一段旧聊天时
 * 看到的第一样东西就是它——只禁用输入框的话，用户会先打完一整段话、
 * 按下发送、再收到一个「发不出去」，然后以为是故障。
 *
 * ⚠️ 只读有**两种原因**，说错原因比不说更糟：`isCurrent` 为真意味着这一段
 * 仍是当前履约段，那它只可能是「这一单退掉了」，而不是「换人了」——
 * 在一张刚退款的订单上说「这段打手沟通已经结束」，用户会去问客服
 * 「谁把我换了」，而页面上既没有换人也没有历史段。
 *
 * ⚠️ 判据仍然是服务端给的 `isReadOnly` / `isCurrent`，这里用它们**选文案**，
 * 不重算写权限——重算就会出现「文案说不能发、输入框还在」。
 */
function SegmentHeader({ segment }: { segment: OrderConversationSegment }) {
  return (
    <li className="list-none">
      <div className="flex items-center gap-2 pt-2">
        <span className="h-px flex-1 bg-line" />
        <span className="shrink-0 text-[11px] font-medium text-ink-2">{segment.title}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {segment.isReadOnly ? (
        <p className="mt-1.5 text-center text-[11px] leading-4 text-ink-3">
          {segment.isCurrent
            ? CONVERSATION_SEGMENT_REFUNDED_NOTICE
            : CONVERSATION_SEGMENT_HISTORY_NOTICE}
        </p>
      ) : null}
    </li>
  );
}

/**
 * 订单沟通（用户侧，P0-14 起支持多段）。
 *
 * ⚠️ **不是实时聊天**：没有 WebSocket，也没有第三方客服系统。
 * 历史消息由 Server Component 取好传进来，之后只有两种情况会更新：
 * 用户发送成功后重新拉取，或者用户点「刷新」。
 *
 * ## 一张订单可以有好几段沟通
 *
 * 「客服沟通」永远存在且永远可写；其后是按履约序号排列的各段「护航沟通」。
 * **已结束的段落只读**——旧打手已经不在这一单上，发出去的话没有收件人。
 * 页面把它们照常显示（`cmd_p0-14.md` §七：用户仍能查看完整历史），
 * 但用标题与说明把「这段已经结束」讲清楚。
 *
 * ## 为什么用「发给谁」而不是「发给哪一段」
 *
 * 请求体里的 `target` 只有 `service` / `current` 两个取值，**都不是内部键**。
 * 用户表达的是意图（这句话给客服，还是给正在服务我的这位护航），
 * 由服务端决定它落到哪一段。这样客户端从结构上就无法寻址一段历史会话——
 * 越权通道不是被拦住的，而是根本不存在的。
 *
 * ⚠️ 目标选择器的**默认值跟随服务端的默认值**（`service`）：页面写一个
 * 与服务端不同的默认，会出现「页面上写着发给客服、实际发给了护航」。
 *
 * 三条约束在这里体现为「用户看得见的行为」：
 *
 * 1. **只能给自己的订单发消息**：订单归属由服务端校验（不属于当前用户就是 404），
 *    页面拿到的已经是校验过的数据。
 * 2. **发送者身份不由客户端决定**：请求体里只有正文、目标与幂等键，发送者与角色由服务端写入，
 *    页面因此也不可能伪造一条「客服」或「护航」消息。
 * 3. **发送失败保留输入框内容**：错误提示出现在输入区上方，内容不动，用户可以直接重试；
 *    重试沿用同一个幂等键，服务端因此不会因为重试多出一条消息。
 *
 * 输入区用 `sticky bottom-0` + 底部安全区：页面没有 TabBar，输入框不会被底部横条压住，
 * 也不会盖住消息列表（sticky 元素仍在文档流内）。
 */
export default function OrderChat({
  orderId,
  currentUserId,
  initialSegments,
}: {
  orderId: string;
  currentUserId: string;
  initialSegments: OrderConversationSegment[];
}) {
  const router = useRouter();
  const [segments, setSegments] = useState(initialSegments);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>("idle");
  const [refreshError, setRefreshError] = useState("");
  const [target, setTarget] = useState<MessageTarget>("service");

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
  const messageCount = segments.reduce((total, segment) => total + segment.messages.length, 0);
  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messageCount]);

  async function refresh() {
    setRefreshStatus("loading");
    setRefreshError("");
    try {
      const next = await fetchConversation(orderId);
      setSegments(next.segments);
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : "刷新失败，请稍后重试");
    } finally {
      setRefreshStatus("idle");
    }
  }

  /**
   * 可发送的目标。**由段落现算，不从 props 传**：发起通信的资格（有没有人正在服务）
   * 会随对方接单 / 换人而变化，写死一份就会在页面停留期间变得不对。
   */
  const sendTargets: SendTarget[] = [
    { value: "service", label: MESSAGE_ROLE_LABELS.customer_service },
    ...(segments.some((segment) => segment.kind === "assignment" && !segment.isReadOnly)
      ? [{ value: "current" as const, label: MESSAGE_ROLE_LABELS.companion }]
      : []),
  ];

  // 目标失效时（页面停留期间护航被换下）回落到客服：**不静默地继续用 current**，
  // 那会让下一条消息发进一段已经结束的会话
  const effectiveTarget: MessageTarget = sendTargets.some((item) => item.value === target)
    ? target
    : "service";

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
      await sendMessage(orderId, normalized.body, sendKeyRef.current, effectiveTarget);
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
        {messageCount === 0 ? (
          <li className="py-8 text-center text-[13px] leading-5 text-ink-3">
            还没有消息。可以在这里描述你遇到的问题，客服会跟进。
          </li>
        ) : null}

        {segments.map((segment) => (
          <li key={segment.index} className="list-none">
            <SegmentHeader segment={segment} />

            {segment.messages.length === 0 ? (
              <p className="pt-2 text-center text-[12px] leading-4 text-ink-3">
                {CONVERSATION_SEGMENT_EMPTY_NOTICE}
              </p>
            ) : (
              <ol className="flex flex-col gap-3 pt-2">
                {segment.messages.map((message) => (
                  <li key={message.id}>
                    <MessageBubble
                      message={message}
                      isSelf={message.senderId === currentUserId}
                    />
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}

        <div ref={listEndRef} />
      </ol>

      {/* 输入区：贴底并补安全区，虚拟键盘弹起时仍在可视区域内 */}
      <SafeAreaContainer className="sticky bottom-0 z-20 border-t border-line bg-surface px-3 py-2">
        {error ? (
          <p role="alert" className="mb-1.5 text-[12px] leading-4 text-brand-red">
            {error}
          </p>
        ) : null}

        {/* 目标选择器只在**真的有两个去处**时出现：只有客服会话时多一个按钮
            只会让人以为还有别的收件人 */}
        {sendTargets.length > 1 ? (
          <div className="mb-1.5 flex items-center gap-1.5" role="radiogroup" aria-label="发送对象">
            <span className="text-[12px] text-ink-3">发给</span>
            {sendTargets.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={effectiveTarget === item.value}
                disabled={sending}
                onClick={() => {
                  // 换了收件人就是另一次发送意图：下次发送用新的幂等键
                  sendKeyRef.current = null;
                  setTarget(item.value);
                  setError("");
                }}
                className={`h-7 rounded-full px-3 text-[12px] disabled:opacity-60 ${
                  effectiveTarget === item.value
                    ? "bg-brand-red text-white"
                    : "border border-line text-ink-2"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
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

/**
 * 消息气泡：自己发的靠右（品牌红），对方（客服 / 打手）靠左（白底并标出身份）。
 *
 * ⚠️ 归属按 **`senderId`** 判，不按角色判：角色只说得出「这是哪一类人发的」。
 * 在换人之后这一点才显出重要性——旧段落里那些 `companion` 消息**不是现在这位打手**
 * 发的，而名字取自消息自己的快照（`senderName`），显示的正是**当时是谁**。
 */
function MessageBubble({ message, isSelf }: { message: OrderMessageView; isSelf: boolean }) {
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
