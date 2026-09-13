"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";

/**
 * 确认订单取数失败的错误边界。
 *
 * 保留顶部返回导航与「重试」：结算页失败时用户最需要的是「回到上一页」或「再试一次」，
 * 而不是一个没有出口的错误页。本页面不在 `(tabs)` 内，因此没有 TabBar。
 */
export default function CheckoutError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title="确认订单" showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
