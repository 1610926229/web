import type { Metadata, Viewport } from "next";
import { PLATFORM_NAME } from "@/lib/constants/site";
import "./globals.css";

/**
 * 根布局：**只有文档骨架**（`html` / `body` / 全局样式 / metadata / viewport）。
 *
 * ⚠️ **壳层刻意不在这里。** 这里曾经直接包着 `MobileShell`（480px 居中列），
 * 于是 PC 管理后台也一并被套进移动端宽度——而宽度由祖先决定，子页面无法自救。
 * 现在按端分家，各自在自己的路由组布局里决定外壳：
 *
 * - 用户端（手机优先、桌面居中）→ `app/(mobile)/layout.tsx`
 * - PC 管理后台（桌面优先）→ `app/admin/layout.tsx`
 *
 * 放在这一层的东西必须是对两端都成立的：文档语言、缩放策略、安全区、全局样式。
 * 任何「某一端才要的容器」都应该下沉到那一端的布局里，而不是靠子页面去覆盖。
 */
export const metadata: Metadata = {
  title: PLATFORM_NAME,
  description: `${PLATFORM_NAME} 用户端`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 不设置 maximumScale / userScalable，保留用户双指缩放网页的能力
  // 微信 / iOS 内置浏览器底部安全区生效的前提，缺省时 env(safe-area-inset-*) 恒为 0
  viewportFit: "cover",
  themeColor: "#ffd400",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      {/* 外壳由各端自己的路由组布局提供，这里只出文档骨架 */}
      <body className="min-h-full">{children}</body>
    </html>
  );
}
