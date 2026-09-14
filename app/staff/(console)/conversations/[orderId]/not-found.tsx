import Link from "next/link";
import {
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_CONVERSATION_NOT_FOUND_MESSAGE,
} from "@/lib/constants/staff";

/**
 * 会话不存在（`/staff/conversations/[orderId]`）。
 *
 * ⚠️ 这里说的是「会话不存在」，而不是「订单不存在」——**三种情形刻意无法区分**：
 *
 * - 订单号根本不存在；
 * - 订单存在，但没有任何沟通记录；
 * - 订单属于别人（客服不该看到的那类）。
 *
 * 三者都给同一句话。理由：客服只能访问**存在会话**的相关订单（§五），
 * 只要能把「订单存在但没聊过」和「订单不存在」分开，客服就能用订单号
 * 一个一个试出平台上到底有哪些订单。
 *
 * ⚠️ 文案与接口 404 的 message 同源（`STAFF_CONVERSATION_NOT_FOUND_MESSAGE`）：
 * 页面上和接口里说两句话，会让人以为遇到了两种不同的问题。
 */
export default function StaffConversationNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[20px] font-semibold text-ink">{STAFF_CONVERSATION_NOT_FOUND_MESSAGE}</h1>
      <p className="max-w-2xl text-[13px] leading-5 text-ink-3">
        客服工作台只能打开已经有沟通记录的订单。订单号写错、这一单还没人聊过、
        或者它不属于你工作台上的会话，看到的都是这一页——这几种情况在这里不做区分。
      </p>
      <Link
        href="/staff/conversations"
        className="self-start rounded-lg border border-admin-line px-5 py-2 text-[13px] text-ink-2 hover:bg-page"
      >
        返回{STAFF_CONVERSATIONS_PAGE_TITLE}
      </Link>
    </div>
  );
}
