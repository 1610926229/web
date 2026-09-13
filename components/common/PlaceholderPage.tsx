import EmptyState from "./EmptyState";
import NavBar from "./NavBar";
import { PLATFORM_NAME, PLACEHOLDER_NOTICE } from "@/lib/constants/site";

/**
 * 统一占位页。
 *
 * 用于所有「有入口但尚无原型 / 尚未开发」的页面，保证入口不产生 404。
 * 占位页不承载任何业务逻辑，也不自行设计正式 UI —— 待原型与需求确认后再实现。
 *
 * `showNav`：需登录的占位页（如「成为护航」）把导航栏放在鉴权**之外**，
 * 未登录时也要有返回入口，因此由页面自己渲染 `NavBar`，这里传 `false`。
 * 其余占位页保持默认，导航与占位内容一起出现。
 */
export default function PlaceholderPage({
  title,
  description,
  showNav = true,
}: {
  title: string;
  description?: string;
  showNav?: boolean;
}) {
  return (
    <>
      {showNav ? <NavBar title={title} showBack /> : null}
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <EmptyState
          title={`${title} · 页面待实现`}
          description={description ?? `${PLACEHOLDER_NOTICE}。该页面尚未开发，当前由 ${PLATFORM_NAME} 统一占位页承接。`}
        />
      </div>
    </>
  );
}
