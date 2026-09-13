import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminProductCreateForm from "@/components/admin/AdminProductCreateForm";
import { ADMIN_PRODUCT_LIST_TITLE, ADMIN_PRODUCT_NEW_TITLE } from "@/lib/constants/adminProducts";
import { getAdminProductFormOptions } from "@/lib/services/adminProducts";

/**
 * 新建商品（`/admin/products/new`）。
 *
 * 新建与编辑共用同一个表单组件，区别只有两处：保存时调的是新建接口，
 * 以及新建成功后会**跳到这件新商品的详情页**——新建之后最可能要做的事
 * 就是接着改它（加规格、调价），停在一个空白表单上等于让人再找一遍。
 *
 * ⚠️ 上架要求至少有一条有效规格，因此这里**默认建的是下架商品**；
 * 想直接上架，就在表单里先加一条规格、再把状态切到「上架」——
 * 那一步会走二次确认，不会因为一次手滑直接摆在用户面前。
 *
 * ⚠️ 本路由下**没有 `loading.tsx`**：它和详情页一样属于「可能 notFound / 可能跳转」
 * 的一类，加载边界会把 200 先发出去。
 */
export default async function AdminProductNewPage() {
  const options = await getAdminProductFormOptions();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_PRODUCT_NEW_TITLE}
        description="保存后这件商品与它的全部规格一起生效；上架前至少要有一条启用且未移除的规格。"
        backHref="/admin/products"
        backLabel={ADMIN_PRODUCT_LIST_TITLE}
      />

      <AdminProductCreateForm options={options} />
    </div>
  );
}
