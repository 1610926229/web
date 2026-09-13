import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_PRODUCT_DETAIL_TITLE,
  ADMIN_PRODUCT_LIST_TITLE,
  ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminProducts";

/**
 * 商品不存在（id 取不到数据，链接失效）。
 *
 * 与「已下架 / 已移除」区分开：那两种状态**仍然能打开详情**——它们是有记录的
 * 状态，页面照常展示归属、统计与时间，只是没有可执行的动作。这里是连记录都取不到。
 */
export default function AdminProductNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_PRODUCT_DETAIL_TITLE}
        backHref="/admin/products"
        backLabel={ADMIN_PRODUCT_LIST_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_PRODUCT_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这个商品 id 在本地 Mock 数据里不存在。新建的商品在开发服务器重启后也会消失
          （内存存储不做持久化，重启恢复种子数据）。
        </p>
        <Link
          href="/admin/products"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回商品管理
        </Link>
      </div>
    </div>
  );
}
