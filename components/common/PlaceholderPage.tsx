import EmptyState from "./EmptyState";
import NavBar from "./NavBar";
import { PLATFORM_NAME, PLACEHOLDER_NOTICE } from "@/lib/constants/site";

/**
 * 统一占位页。
 *
 * 用于所有「有入口但尚无原型 / 尚未开发」的页面，保证入口不产生 404。
 * 占位页不承载任何业务逻辑，也不自行设计正式 UI —— 待原型与需求确认后再实现。
 */
export default function PlaceholderPage({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <>
      <NavBar title={title} showBack />
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <EmptyState
          title={`${title} · 页面待实现`}
          description={description ?? `${PLACEHOLDER_NOTICE}。该页面尚未开发，当前由 ${PLATFORM_NAME} 统一占位页承接。`}
        />
      </div>
    </>
  );
}
