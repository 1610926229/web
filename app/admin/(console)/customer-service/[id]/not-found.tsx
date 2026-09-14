import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_STAFF_LIST_TITLE } from "@/lib/constants/adminStaff";

/**
 * 客服账号不存在。
 *
 * ⚠️ 这里说的是「不存在」，不是「已移除」——**已移除的账号仍然能打开详情页**
 * （记录还在，页面显示的是「已移除」状态与历史信息）。
 * 把两者混成一句话，运营就无法区分「我记错 id 了」和「这个账号被谁删了」。
 */
export default function AdminCustomerServiceNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title="客服账号不存在"
        description="这个 id 没有对应的客服账号。可能是地址抄错了，也可能这条记录从未存在过。"
        backHref="/admin/customer-service"
        backLabel={ADMIN_STAFF_LIST_TITLE}
      />
    </div>
  );
}
