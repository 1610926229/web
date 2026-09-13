import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminProductConsole from "@/components/admin/AdminProductConsole";
import { ADMIN_PRODUCT_DETAIL_TITLE, ADMIN_PRODUCT_LIST_TITLE } from "@/lib/constants/adminProducts";
import { getAdminProductDetail, getAdminProductFormOptions } from "@/lib/services/adminProducts";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 商品详情与编辑（`/admin/products/[id]`）。
 *
 * ⚠️ **已下架与已移除的商品照样打开**：下架不是错误状态（改价期间先下架是常态），
 * 已移除则是软删除——后台要能查到「这件商品被移除过」。两者都返回 404 的话，
 * 软删除就退化成了「记录消失」，而历史订单与收藏还指着它。
 *
 * 页面本身只负责取数：详情 DTO 与表单选项（游戏、类目、图片白名单）都从这里
 * 进客户端组件，写操作全在 `AdminProductConsole` 里——它是这一页唯一的写入口。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。
 */
export default async function AdminProductDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/products/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const [product, options] = await Promise.all([
    getAdminProductDetail(id, query, "server"),
    getAdminProductFormOptions(),
  ]);
  if (!product) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_PRODUCT_DETAIL_TITLE}
        backHref="/admin/products"
        backLabel={ADMIN_PRODUCT_LIST_TITLE}
      />

      <AdminProductConsole record={product} options={options} />
    </div>
  );
}
