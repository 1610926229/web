import { notFound } from "next/navigation";
import NavBar from "@/components/common/NavBar";
import ComplianceNotice from "@/components/product/ComplianceNotice";
import ProductMainImage from "@/components/product/ProductMainImage";
import ProductPurchasePanel from "@/components/product/ProductPurchasePanel";
import { getSessionUser } from "@/lib/auth/session";
import { isMockAuthEnabled } from "@/lib/config/env";
import { getProductDetail } from "@/lib/services/catalog";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 商品详情（免登录可浏览）。
 *
 * 该路由位于 `(tabs)` 路由组**之外**，因此不显示底部 TabBar；底部操作栏由页面自己提供。
 *
 * 整页由服务端渲染：商品数据经 service 直接取，登录态经服务端会话读取，
 * 两者都不经过 HTTP 自请求。需要浏览器状态的只有主图加载失败占位、规格选择与登录浮层，
 * 它们各自是小型客户端组件，页面本身仍是 Server Component——首屏 HTML 里就有商品标题与价格。
 *
 * 游客可浏览、可切规格；收藏 / 客服 / 立即购买交给 `ProductPurchasePanel` 里统一的登录流程。
 * Next.js 16 中 params 与 searchParams 均为 Promise，必须 await。
 */
export default async function ProductDetailPage({
  params,
  searchParams,
}: PageProps<"/product/[id]">) {
  const { id } = await params;
  // 查询参数原样交给 service（Mock 调试参数由此生效），页面不判断开关
  const query = toSearchParams(await searchParams);

  const [product, user] = await Promise.all([
    getProductDetail(id, query, "server"),
    getSessionUser(),
  ]);

  // 商品不存在（或已从数据源删除）→ 明确的「不存在」状态，而不是空页面
  if (!product) notFound();

  return (
    <>
      <NavBar title="商品详情" showBack />

      <div className="flex flex-1 flex-col overflow-x-clip bg-page">
        <ComplianceNotice />
        <ProductMainImage src={product.coverUrl} alt={product.title} />
        <ProductPurchasePanel
          product={product}
          loggedIn={user !== null}
          mockAuthEnabled={isMockAuthEnabled()}
        />
      </div>
    </>
  );
}
