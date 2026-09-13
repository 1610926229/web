import PlaceholderPage from "@/components/common/PlaceholderPage";

/**
 * 商品详情。
 *
 * 该路由位于 `(tabs)` 路由组之外 —— 详情页不显示底部 TabBar。
 * 当前仅承接从首页商品卡片进入的跳转，正式详情 UI 待后续阶段实现。
 * Next.js 16 中 params 为 Promise，必须 await。
 */
export default async function ProductDetailPage({
  params,
}: PageProps<"/product/[id]">) {
  const { id } = await params;

  return (
    <PlaceholderPage
      title="商品详情"
      description={`对应商品 ID：${id}。商品详情页原型待确认，确认后再实现正式 UI。`}
    />
  );
}
