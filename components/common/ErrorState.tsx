"use client";

import { useEffect } from "react";
import EmptyState from "./EmptyState";

/**
 * 统一的错误状态：错误说明 + 重试。
 *
 * 取数失败时用它，而不是伪装成「暂无数据」——空数据与取数失败是两回事，
 * 用户看到的文案与可执行的动作都不同。
 *
 * 各路由的 error.tsx 都复用本组件，保证错误态的视觉与交互只有一份实现。
 */
export default function ErrorState({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  /** Next 提供的重试：重新渲染该路由段并重新取数 */
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
