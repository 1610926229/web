import PlaceholderPage from "@/components/common/PlaceholderPage";

/**
 * 统一占位路由。
 *
 * 首页等入口在目标页面尚未开发时跳转到这里，通过 `?title=` 传入入口名称，
 * 以保证所有入口都能到达、不产生 404。
 * Next.js 16 中 searchParams 为 Promise，必须 await。
 */
export default async function PlaceholderRoute({
  searchParams,
}: PageProps<"/placeholder">) {
  const params = await searchParams;
  const raw = params.title;
  const title = typeof raw === "string" && raw.trim() ? raw.trim() : "功能";

  return <PlaceholderPage title={title} />;
}
