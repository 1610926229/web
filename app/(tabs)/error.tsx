"use client";

import { useEffect } from "react";
import EmptyState from "@/components/common/EmptyState";

/**
 * 一级 Tab 页面的错误边界。
 *
 * 取数失败时渲染在这里，而不是伪装成「暂无数据」——空数据与取数失败是两回事，
 * 用户看到的文案与可执行的动作都不同。
 *
 * 它替换的是布局的 children，因此底部导航在错误状态下依然显示。
 * 「重试」调用 Next 提供的 `reset()`，重新渲染该路由段并重新取数。
 */
export default function TabsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 目前没有错误上报服务，先留在控制台；接入监控后改由这里上报
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
      <EmptyState
        title="加载失败"
        description={error.message || "服务暂时不可用，请稍后重试。"}
      />

      <button
        type="button"
        onClick={reset}
        className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
      >
        重试
      </button>
    </div>
  );
}
