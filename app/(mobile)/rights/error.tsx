"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { LEVEL_PAGE_TITLE } from "@/lib/constants/levels";

/**
 * 消费等级页取数失败的错误边界。
 *
 * 保留顶部返回与「重试」：失败时用户最需要的是「回去」或「再试一次」，
 * 而不是一个没有出口的错误页。本页面不在 `(tabs)` 内，因此没有 TabBar。
 *
 * **它依赖同段的 `loading.tsx` 才能生效**：页面在渲染前先 `await` 取数，会先挂起；
 * 没有 Suspense 边界时，取数失败落在外壳阶段，React 无法恢复，整个响应会退化成
 * 500 的应用级错误页（实测）。有了边界，响应保持 200，错误交给本文件在客户端接管，
 * 用户看到的是下面的「加载失败 + 重试 + 返回」。所以 `loading.tsx` 在这里不是可选项。
 */
export default function RightsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={LEVEL_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
