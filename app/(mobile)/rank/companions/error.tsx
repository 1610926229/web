"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { COMPANION_RANKING_PAGE_TITLE } from "@/lib/constants/companionRankings";

/**
 * 打手排行榜取数失败的错误边界（P1-5）。
 *
 * 游客也会看到这个页面，因此错误态同样要给出「返回」与「重试」两个出口。
 *
 * 与消费榜的 `rank/error.tsx` 一样，本文件**依赖同段的 `loading.tsx`**：
 * 没有那层 Suspense 边界，取数失败会发生在外壳阶段，React 无法恢复，
 * 响应直接变成 500。
 */
export default function CompanionRankError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={COMPANION_RANKING_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
