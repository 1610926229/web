"use client";

/* eslint-disable @next/next/no-img-element -- Mock 头像为本地 SVG 占位图，不经 next/image 优化器。 */
import NavBar from "@/components/common/NavBar";
import { useAuth, useAuthUser } from "@/lib/auth/useAuth";

/**
 * 我的（需登录）。
 *
 * P2 只接入登录态：上方展示服务端会话中的当前用户，用于验证登录/登出与用户切换。
 * 功能入口宫格、优惠券、评价、鸡腿、收藏、设置等均为 P6 内容。
 *
 * 「退出登录」按钮是 P2 验证登录态用的临时控件，正式入口属于 P6 的设置页。
 */
export default function MinePage() {
  // 本页由 RequireAuth 保护，未登录时渲染不到，因此这里直接取必定存在的用户
  const user = useAuthUser();
  const { logout } = useAuth();

  return (
    <>
      <NavBar title="我的" />
      <div className="flex flex-1 flex-col gap-6 bg-surface px-4 py-6">
        <div className="flex items-center gap-3">
          <img
            src={user.avatarUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded-full border border-line bg-page object-cover"
          />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold text-ink">{user.nickname}</p>
            <p className="truncate text-[12px] text-ink-3">Mock 用户 ID：{user.id}</p>
          </div>
        </div>

        <p className="rounded-[12px] bg-page px-4 py-4 text-[13px] leading-5 text-ink-3">
          我的页 · 骨架。本阶段仅接入登录态与取数链路，
          优惠券、评价、鸡腿、收藏、设置等功能入口待 P6 实现。
        </p>

        <button
          type="button"
          onClick={() => {
            void logout();
          }}
          className="rounded-full border border-line px-6 py-2.5 text-[14px] text-ink-2"
        >
          退出登录（模拟）
        </button>
      </div>
    </>
  );
}
