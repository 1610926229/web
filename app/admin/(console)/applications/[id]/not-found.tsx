import Link from "next/link";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import { ADMIN_APPLICATIONS_PAGE_TITLE } from "@/lib/constants/admin";
import {
  ADMIN_APPLICATION_DETAIL_TITLE,
  ADMIN_APPLICATION_NOT_FOUND_MESSAGE,
} from "@/lib/constants/adminApplications";

/**
 * 申请不存在（单号取不到数据，链接失效或记录已被清理）。
 *
 * 与「已撤销 / 未通过」区分开：那两种状态**仍然能打开详情**——它们是有结论的申请，
 * 页面照常展示正文与时间轴，只是没有可执行的动作。这里是连记录都取不到。
 *
 * 退路指向申请列表而不是后台首页：管理者是从列表点进来的，回到列表更接近他原本在做的事。
 */
export default function AdminApplicationNotFound() {
  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_APPLICATION_DETAIL_TITLE}
        backHref="/admin/applications"
        backLabel={ADMIN_APPLICATIONS_PAGE_TITLE}
      />

      <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
        <p className="text-[14px] font-medium text-ink">{ADMIN_APPLICATION_NOT_FOUND_MESSAGE}</p>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          这条申请单号在本地 Mock 数据里不存在。开发服务器重启后数据会回到预置状态，
          期间提交的申请会消失。
        </p>
        <Link
          href="/admin/applications"
          className="mt-4 inline-block rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page"
        >
          返回申请列表
        </Link>
      </div>
    </div>
  );
}
