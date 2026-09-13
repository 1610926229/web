"use client";

import ErrorState from "@/components/common/ErrorState";

/**
 * 一级 Tab 页面的错误边界。
 *
 * 取数失败时渲染在这里，而不是伪装成「暂无数据」——空数据与取数失败是两回事，
 * 用户看到的文案与可执行的动作都不同。
 *
 * 它替换的是布局的 children，因此底部导航在错误状态下依然显示。
 */
export default function TabsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
