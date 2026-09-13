import type { ReactNode } from "react";

/**
 * 微信内置浏览器安全区适配容器。
 *
 * 为贴底元素（底部导航等）补上 iOS 底部安全区间距，避免被系统横条遮挡。
 * 依赖根布局 viewport 的 `viewportFit: "cover"`，否则 env() 恒为 0。
 */
export default function SafeAreaContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`pb-[env(safe-area-inset-bottom)] ${className}`}>{children}</div>;
}
