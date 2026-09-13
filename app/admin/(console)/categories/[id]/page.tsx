import { notFound } from "next/navigation";
import AdminCategoryConsole from "@/components/admin/AdminCategoryConsole";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_CATEGORY_DETAIL_TITLE,
  ADMIN_CATEGORY_LIST_TITLE,
} from "@/lib/constants/adminCategories";
import { getAdminCategoryDetail, getAdminCategoryFormOptions } from "@/lib/services/adminCategories";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 类目详情与编辑（`/admin/categories/[id]`）。
 *
 * ⚠️ **已移除的类目照样打开**：后台要能查到「这条类目被移除过」。返回 404 等于把
 * 软删除做成了记录消失，而那正是软删除要避免的事——商品归属与历史记录都还指着它。
 *
 * 页面本身只负责取数：详情 DTO 与游戏目录都从这里进客户端组件，
 * 写操作全在 `AdminCategoryConsole` 里——它是这一页唯一的写入口。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。
 */
export default async function AdminCategoryDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/categories/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const [category, options] = await Promise.all([
    getAdminCategoryDetail(id, query, "server"),
    getAdminCategoryFormOptions(),
  ]);
  if (!category) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_CATEGORY_DETAIL_TITLE}
        backHref="/admin/categories"
        backLabel={ADMIN_CATEGORY_LIST_TITLE}
      />

      <AdminCategoryConsole record={category} games={options.games} />
    </div>
  );
}
