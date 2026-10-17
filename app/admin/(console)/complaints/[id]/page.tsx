import { notFound } from "next/navigation";
import AdminComplaintConsole from "@/components/admin/AdminComplaintConsole";
import AdminComplaintSections from "@/components/admin/AdminComplaintSections";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import {
  ADMIN_COMPLAINT_DETAIL_TITLE,
  ADMIN_COMPLAINT_LIST_TITLE,
} from "@/lib/constants/adminComplaints";
import { getAdminComplaintDetail } from "@/lib/services/adminComplaints";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 投诉处理详情（`/admin/complaints/[id]`）。
 *
 * 处理需要的全部内容都在这一页：正文、凭证、联系方式、关联订单摘要、处理信息与时间轴。
 * 列表页刻意不带正文与联系方式（§投诉处理），因此「要写处理结果就必须先读完投诉」。
 *
 * ⚠️ **用户提交的材料只读**：正文、凭证、联系方式由服务端原样读出，本页不提供任何编辑入口，
 * 后端也没有能改它们的接口。处理结果写在另一个字段里，两者永不互相覆盖
 * （说明写在页面上：`ADMIN_COMPLAINT_IMMUTABLE_NOTICE`）。
 *
 * ⚠️ **只读的那六块在 `AdminComplaintSections` 里**（P1-3 抽出）：售后工作台的
 * `/admin/aftersales/complaint/[id]` 要展示同一份案件内容，抽出来之后两处**同源**，
 * 不会再出现「一处改了另一处没改」。本页的渲染输出与抽出之前完全一致。
 *
 * ⚠️ **本页只有一处写入口**（`AdminComplaintConsole`），按钮完全由服务端的 `allowedActions`
 * 决定；终态下显示的是「没有可执行的动作」而不是灰按钮。它不写订单、不写退款。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function AdminComplaintDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/complaints/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const complaint = await getAdminComplaintDetail(id, query, "server");
  if (!complaint) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_COMPLAINT_DETAIL_TITLE}
        backHref="/admin/complaints"
        backLabel={ADMIN_COMPLAINT_LIST_TITLE}
      />

      <AdminComplaintSections complaint={complaint} />

      <AdminComplaintConsole complaint={complaint} />
    </div>
  );
}
