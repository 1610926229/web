"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { STAFF_REFRESH_LABEL } from "@/lib/constants/staff";

/**
 * 刷新按钮（服务端重新取数）。
 *
 * ⚠️ 本阶段**没有 WebSocket**：对方发来的新消息不会自己出现，必须点这个按钮
 * （或重新打开页面）才会看到。这正是它存在的理由——页面上必须有一个人能按的东西，
 * 否则「发了没反应」会被当成故障。页面上的 `STAFF_NOT_REALTIME_NOTICE` 说明这一点。
 *
 * 用 `useTransition` 而不是自建 `busy` 状态：`router.refresh()` 触发的重渲染
 * 本来就该走 React 的过渡通道，自己维护一个布尔值只会在网络快时闪一下、
 * 在慢时和真实状态对不上。
 *
 * ⚠️ 它只**重新取数**，不写任何东西：不发消息、不改已读位置。
 * 「刷新」把未读清零会让人以为「看过一眼就算处理过了」。
 */
export default function StaffRefreshButton({ label = STAFF_REFRESH_LABEL }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
    >
      {pending ? `${label}中…` : label}
    </button>
  );
}
