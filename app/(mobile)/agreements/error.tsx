"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { AGREEMENT_PAGE_TITLE } from "@/lib/constants/agreements";

/**
 * 协议页取数失败的错误边界。游客也会看到这个页面，因此同样给出「返回」与「重试」。
 *
 * 与 `/rights` 一样，本文件依赖同段的 `loading.tsx`：没有那层 Suspense 边界，
 * 取数失败会发生在外壳阶段，React 无法恢复，响应直接变成 500。见 `/rights/error.tsx`。
 */
export default function AgreementsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={AGREEMENT_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
