import type { Metadata, Viewport } from "next";
import MobileShell from "@/components/common/MobileShell";
import { PLATFORM_NAME } from "@/lib/constants/site";
import "./globals.css";

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
      <body className="min-h-full">
        {/* MobileShell 放在根布局，使商品详情等无 TabBar 的页面同样保持桌面端居中 */}
        <MobileShell>{children}</MobileShell>
      </body>
    </html>
  );
}
