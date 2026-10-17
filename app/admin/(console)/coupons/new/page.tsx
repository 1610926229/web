import AdminCouponTemplateCreateForm from "@/components/admin/AdminCouponTemplateCreateForm";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_COUPONS_PAGE_TITLE } from "@/lib/constants/admin";
import { ADMIN_COUPON_NEW_TITLE } from "@/lib/constants/adminCoupons";

/**
 * 新建优惠券（`/admin/coupons/new`）。
 *
 * 新建与编辑共用同一个表单组件，区别只有两处：保存时调的是新建接口，
 * 以及新建成功后会**跳到这张新券的详情页**——新建之后最可能要做的事
 * 就是接着核对它，停在一个空白表单上等于让人再找一遍。
 *
 * ⚠️ 新建**只能是满减券**（§1）：这一页没有「优惠形式」这个选择，
 * 形态由服务端钉死，请求体里带 `formKey` 也不会被读到。
 *
 * ⚠️ 本路由下**没有 `loading.tsx`**：它和详情页一样属于「可能跳转」的一类，
 * 加载边界会把 200 先发出去（与类目新建页同一条理由）。
 */
export default function AdminCouponNewPage() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COUPON_NEW_TITLE}
        description="新建的券默认启用，保存后立即出现在用户端领券中心；停用后立刻不再出现。"
        backHref="/admin/coupons"
        backLabel={ADMIN_COUPONS_PAGE_TITLE}
      />

      <AdminCouponTemplateCreateForm />
    </div>
  );
}
