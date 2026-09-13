import AdminCategoryCreateForm from "@/components/admin/AdminCategoryCreateForm";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_CATEGORY_LIST_TITLE,
  ADMIN_CATEGORY_NEW_TITLE,
} from "@/lib/constants/adminCategories";
import { getAdminCategoryFormOptions } from "@/lib/services/adminCategories";

/**
 * 新建类目（`/admin/categories/new`）。
 *
 * 新建与编辑共用同一个表单组件，区别只有两处：保存时调的是新建接口，
 * 以及新建成功后会**跳到这条新类目的详情页**——新建之后最可能要做的事
 * 就是接着改它，停在一个空白表单上等于让人再找一遍。
 *
 * ⚠️ 本路由下**没有 `loading.tsx`**：它和详情页一样属于「可能 notFound / 可能跳转」
 * 的一类，加载边界会把 200 先发出去。
 */
export default async function AdminCategoryNewPage() {
  const options = await getAdminCategoryFormOptions();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_CATEGORY_NEW_TITLE}
        description="新建的类目默认启用；保存后立即进入用户端分类导航。"
        backHref="/admin/categories"
        backLabel={ADMIN_CATEGORY_LIST_TITLE}
      />

      <AdminCategoryCreateForm games={options.games} />
    </div>
  );
}
