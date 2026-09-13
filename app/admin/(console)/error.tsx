"use client";

import ErrorState from "@/components/common/ErrorState";

/**
 * 管理后台内容区的错误边界。
 *
 * 复用用户端的 `ErrorState`（错误说明 + 重试，`?mockError` 时会先把调试参数摘掉再重试），
 * 错误态的交互因此仍然只有一份实现，两端不会长成两套。
 *
 * 边界只罩住**内容区**：侧栏与顶部条由布局渲染，取数失败时导航还在，
 * 管理者仍然能切到别的模块或退出登录——错误页不该把人困住。
 *
 * 与同段的 `loading.tsx` 配套：没有那层 Suspense 边界，取数失败会发生在外壳阶段，
 * React 无法恢复，响应直接变成 500，这个错误边界根本没机会渲染。
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col justify-center">
      <ErrorState error={error} reset={reset} />
    </div>
  );
}
