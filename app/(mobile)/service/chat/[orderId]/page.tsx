/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import OrderChat from "@/components/service/OrderChat";
import RequireAuth from "@/lib/auth/RequireAuth";
import { getMessagesForUser } from "@/lib/services/conversations";

/**
 * 订单沟通页（需登录）。
 *
 * 该路由位于 `(tabs)` 之外（与订单详情一致），是二级页面：用顶部返回而不是底部 TabBar，
 * 输入区因此不会被 TabBar 和虚拟键盘夹在中间。
 *
 * 归属由服务端判定：订单不存在**或不属于当前用户**时 `getMessagesForUser` 返回 null，
 * 页面展示同一个「订单不存在」——不能拿订单 id 去试别人有没有这一单。
 *
 * 订单是自己的但还没有会话时，服务端会**顺手建立会话**：这正是「发起沟通」这个动作，
 * 因此不需要额外的接口。之后从客服首页进来就能看到这条会话。
 */
export default async function OrderChatPage({ params }: PageProps<"/service/chat/[orderId]">) {
  const { orderId } = await params;

  return (
    <>
      <NavBar title="订单沟通" showBack />

      <RequireAuth>
        {(user) => <OrderChatBody orderId={orderId ?? ""} userId={user.id} />}
      </RequireAuth>
    </>
  );
}

async function OrderChatBody({ orderId, userId }: { orderId: string; userId: string }) {
  const payload = await getMessagesForUser(userId, orderId, undefined, "server");

  if (!payload) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
        <EmptyState
          title="订单不存在"
          description="该订单可能不属于当前登录账号，或开发服务器重启后内存数据被清空。"
        />
        <Link
          href="/service"
          className="flex h-11 items-center justify-center rounded-full border border-line px-8 text-[15px] text-ink-2"
        >
          返回客服首页
        </Link>
      </div>
    );
  }

  const { conversation, messages } = payload;

  return (
    <div className="flex flex-1 flex-col overflow-x-clip">
      {/* 订单摘要：时刻提醒用户正在沟通的是哪一单（会话不改动订单状态，这里如实显示当前状态） */}
      <section className="shrink-0 border-b border-line bg-surface px-3 py-2.5">
        <div className="flex gap-3">
          <img
            src={conversation.productCoverUrl}
            alt={conversation.productTitle}
            className="h-12 w-12 shrink-0 rounded-[8px] border border-line object-cover"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="line-clamp-1 text-[14px] font-medium text-ink">
              {conversation.productTitle}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-3">
              订单号 {conversation.orderNo} · {conversation.orderStatusLabel}
            </p>
          </div>
          <Link
            href={`/orders/${conversation.orderId}`}
            className="shrink-0 self-center text-[12px] text-brand-blue"
          >
            订单详情
          </Link>
        </div>
      </section>

      <OrderChat
        orderId={conversation.orderId}
        currentUserId={userId}
        initialMessages={messages}
      />
    </div>
  );
}
