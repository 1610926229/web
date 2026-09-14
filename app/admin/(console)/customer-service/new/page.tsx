import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminStaffCreateForm from "@/components/admin/AdminStaffCreateForm";
import { ADMIN_STAFF_CREATE_PAGE_TITLE, ADMIN_STAFF_LIST_TITLE } from "@/lib/constants/adminStaff";

/**
 * 新增客服账号（`/admin/customer-service/new`）。
 *
 * 整页只有一个写入口（`AdminStaffCreateForm`），且**没有服务端取数**：
 * 表单需要的全部东西（三个字段的规则、头像白名单、文案）都在常量层，
 * 不依赖仓储，因此这一页不会因为数据未就绪而先渲染出一个空壳。
 *
 * ⚠️ 这一页**不是**「给用户开一个客服权限」的地方：客服账号是独立的一类身份，
 * 与用户名单、消费排行没有交集。这件事由页头的说明与表单里的 Mock 标注说清楚。
 */
export default function AdminCustomerServiceNewPage() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_STAFF_CREATE_PAGE_TITLE}
        backHref="/admin/customer-service"
        backLabel={ADMIN_STAFF_LIST_TITLE}
      />

      <AdminStaffCreateForm />
    </div>
  );
}
