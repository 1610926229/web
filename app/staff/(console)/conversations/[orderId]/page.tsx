/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import StaffConversationConsole from "@/components/staff/StaffConversationConsole";
import StaffOrderSummaryPanel from "@/components/staff/StaffOrderSummaryPanel";
import {
  STAFF_CONVERSATIONS_PAGE_TITLE,
  STAFF_CONVERSATION_DETAIL_TITLE,
} from "@/lib/constants/staff";
import { getStaffSession } from "@/lib/services/staffAuth";
import { getStaffConversationDetail } from "@/lib/services/staffConversations";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 订单沟通页（`/staff/conversations/[orderId]`）。
 *
 * 一页三块：**用户摘要 + 三方历史消息（含发送角色与时间）+ 订单只读摘要**。
 *
 * ⚠️ **没有会话就是 404，而且与「订单不存在」是同一个 404**（§五）：
 * 客服只能访问存在会话的相关订单。只要能把「订单存在但没人聊过」与「订单不存在」
 * 分开，客服就能拿订单号一个一个试出平台上到底有哪些订单。
 * 判定在服务层（`getStaffConversationDetail` 返回 null），页面只负责 `notFound()`。
 *
 * ⚠️ 除了「发送消息」与「标记已读」两个动作，本页**没有任何写入口**：
 * 不改订单状态、不改金额、不改商品，也没有退款与投诉的入口（那是 P8D-2）。
 * 订单摘要那一块是服务端组件、只读。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function StaffConversationDetailPage({
  params,
  searchParams,
}: PageProps<"/staff/conversations/[orderId]">) {
  const staff = await getStaffSession();
  if (!staff) redirect("/staff/login");

  const { orderId } = await params;
  const query = toSearchParams(await searchParams);

  const detail = await getStaffConversationDetail(staff.id, orderId, query, "server");
  if (!detail) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <Link
          href="/staff/conversations"
          className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
        >
          ← {STAFF_CONVERSATIONS_PAGE_TITLE}
        </Link>
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{STAFF_CONVERSATION_DETAIL_TITLE}</h1>
      </div>

      {/* 桌面优先：宽屏时左侧沟通、右侧摘要；窄屏时上下堆叠 */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <StaffConversationConsole orderId={detail.order.orderId} initialDetail={detail} />

        <div className="flex flex-col gap-5">
          <section className="rounded-xl border border-admin-line bg-surface p-4">
            <h2 className="text-[15px] font-medium text-ink">用户</h2>
            <div className="mt-3 flex items-center gap-3">
              <img
                src={detail.user.avatarUrl}
                alt=""
                className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
              />
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-ink">{detail.user.nickname}</p>
                {/* 平台标识：客服要靠它跟用户对上话，但它不是任何可登录的凭据 */}
                <p className="font-mono text-[12px] text-ink-3">{detail.user.id}</p>
              </div>
            </div>
          </section>

          <StaffOrderSummaryPanel order={detail.order} />
        </div>
      </div>
    </div>
  );
}
