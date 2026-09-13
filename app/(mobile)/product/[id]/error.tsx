"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";

/**
 * 商品详情取数失败的错误边界。
 *
 * 与 Tab 页的错误边界分开：本页面不在 `(tabs)` 内，没有 TabBar，但要保留顶部返回导航，
 * 否则用户会卡在一个无法返回的错误页上。
 */
export default function ProductDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title="商品详情" showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
