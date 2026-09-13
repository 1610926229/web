import type { ReactNode } from "react";

/**
 * 用户端外壳：手机优先，桌面居中。
 *
 * - 移动端占满宽度；桌面端限制最大宽度并在视口内水平居中（不单独制作多栏桌面布局）。
 * - 外壳之外的区域使用页面底色，使居中列在桌面端可辨识。
 * - 本组件**不设置 overflow**：底部 TabBar 是这一列的后代，任何 overflow 祖先都可能
 *   成为它的滚动容器而使 `sticky` 失效。横向溢出由各页面自身的容器裁剪。
 */
export default function MobileShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full justify-center bg-page">
      <div className="flex min-h-dvh w-full max-w-[var(--shell-width)] flex-col bg-surface">
        {children}
      </div>
    </div>
  );
}
