import { notFound } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminRefundConsole from "@/components/admin/AdminRefundConsole";
import AdminRefundSections from "@/components/admin/AdminRefundSections";
import {
  ADMIN_REFUND_DETAIL_TITLE,
  ADMIN_REFUND_LIST_TITLE,
} from "@/lib/constants/adminRefunds";
import { getAdminRefundDetail } from "@/lib/services/adminRefunds";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 退款审核详情（`/admin/refunds/[id]`）。
 *
 * 审核需要的全部内容都在这一页：原因、说明、凭证、订单摘要、审核信息与进度时间轴。
 * 列表页刻意不带原因与说明（§退款审核），因此「要批一笔款就必须先看到它为什么被申请」。
 *
 * ⚠️ **本页只有一处写入口**（`AdminRefundConsole`），而且按钮完全由服务端的
 * `allowedActions` 决定；终态下那一块显示的是「没有可执行的动作」而不是三个灰按钮。
 *
 * ⚠️ **只读的那七块在 `AdminRefundSections` 里**（P1-3 抽出）：售后工作台的
 * `/admin/aftersales/refund/[id]` 要展示同一份案件内容，抽出来之后两处**同源**，
 * 不会再出现「一处改了另一处没改」。本页的渲染输出与抽出之前完全一致。
 *
 * ⚠️ **金额本身仍然是只读的**（P0-13 起口径微调，P0-15 收敛）：申请金额取申请创建时的
 * 订单实付快照，页面上没有任何输入框能改它；`AdminRefundConsole` 里管理员能填的
 * **只剩一个退款比例**——「按比例 / 退满剩余」的方式选择与「责任归属」都已随 P0-15 删除，
 * 退款金额与冲回额由服务端按订单冻结快照算出来（§16.B）。
 *
 * ⚠️ **P0-13 验收整改（D19）**：确认框里现在**会实时显示预计金额**了。
 * 原先 D15 的「不做预览」被显式取代——它答不出管理员真正要问的问题（见
 * `02-decisions.md` §十一）。取代的只是「不显示」：预计金额由
 * `previewRefundDecisionAmounts()` 调用**服务端同一个公式函数**算出，
 * 界面上没有任何第二份金额公式。「订单金额」一段给出基准与口径
 * （它在 `AdminRefundSections` 里）。
 *
 * ⚠️ **本路由上下都没有 `loading.tsx`**：加载边界一旦罩住它，外壳会先以 200 发出，
 * 迟到的 `notFound()` 只能改内容、改不了状态码。兄弟目录 `(list)` 存在的理由正是这个。
 */
export default async function AdminRefundDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/refunds/[id]">) {
  const { id } = await params;
  const query = toSearchParams(await searchParams);

  const refund = await getAdminRefundDetail(id, query, "server");
  if (!refund) notFound();

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading
        title={ADMIN_REFUND_DETAIL_TITLE}
        backHref="/admin/refunds"
        backLabel={ADMIN_REFUND_LIST_TITLE}
      />

      <AdminRefundSections refund={refund} />

      <AdminRefundConsole refund={refund} />
    </div>
  );
}
