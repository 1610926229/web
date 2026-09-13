import type { ReactNode } from "react";
import TabBar from "@/components/common/TabBar";

/**
 * 一级 Tab 页面共用布局。
 *
 * 内容区为 flex 列，页面可通过 flex-1 撑满剩余高度。
 *
 * TabBar 的定位方式：
 * - `sticky bottom-0` 且**处于文档流内**，内容不会滚动到它下面，因此正文底部天然不需要
 *   额外留出遮挡补偿；内容不足一屏时它落在容器底部，内容超出一屏时它吸附在视口底部。
 * - 它是 `main` 的兄弟节点，祖先链上（MobileShell）没有 overflow，`sticky` 不会被滚动容器劫持。
 * - 它位于 MobileShell 的居中列内部，宽度上限为 CSS 变量 --shell-width，桌面端只占容器宽度、不横跨窗口。
 *
 * overflow-x-clip 放在 `main` 而非外壳上：main 是 TabBar 的兄弟节点，裁剪正文的横向溢出
 * 不会波及 TabBar；clip 不创建滚动容器，也不影响内部 sticky 的 NavBar。
 *
 * 需要隐藏底部导航的页面（如商品详情）不放在本路由组内。
 */
export default function TabsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <main className="flex flex-1 flex-col overflow-x-clip bg-page">{children}</main>
      <TabBar />
    </>
  );
}
