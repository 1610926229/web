"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { COMPANION_LIST_PAGE_TITLE } from "@/lib/constants/companions";

/**
 * 陪玩列表取数失败的错误边界。
 *
 * 没有它的话 `/companions?mockError=1` 会落到**应用级**错误页（HTTP 500 + 白屏），
 * 与优惠券、评价、反馈等二级列表页的表现不一致。
 *
 * 顶部返回照常（不把人困在错误页上），正文给出错误说明与重试；二级页面因此仍然没有 TabBar。
 * 重试由 `ErrorState` 处理——它会先把 `?mockError` 从地址里去掉再导航，
 * 否则重试只是拿着同一个故障注入参数再取一次数，点了必然又回到这一屏。
 *
 * 与 `/rank`、`/suggestions` 一样，本文件依赖同段的 `loading.tsx`：没有那层 Suspense 边界，
 * 取数失败会发生在外壳阶段，React 无法恢复，响应直接变成 500，错误边界根本没机会渲染。
 *
 * 这一对（`loading.tsx` + `error.tsx`）连同页面一起待在路由组 `(list)` 里，
 * 因此**不会**把 `app/companions/[id]` 罩进来——否则那边的 `notFound()` 会退化成 200。
 * 详情路由另有自己的 `error.tsx`，两者是两套边界，不是同一层的复用。
 */
export default function CompanionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={COMPANION_LIST_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
