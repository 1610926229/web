import { buildAdminApplicationListQuery } from "@/lib/constants/adminApplications";
import { buildAdminComplaintListQuery } from "@/lib/constants/adminComplaints";
import { buildAdminRefundListQuery } from "@/lib/constants/adminRefunds";
import {
  beijingDateKey,
  computeTodayOrderMetrics,
  computeTodayRefundAmount,
} from "@/lib/constants/adminDashboard";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import { queryAdminApplicationList } from "@/lib/services/adminCompanionApplications";
import { queryAdminComplaintList } from "@/lib/services/adminComplaints";
import { queryAdminRefundList } from "@/lib/services/adminRefunds";
import type { AdminDashboardDTO } from "@/lib/types/admin";

/**
 * 管理后台**经营首页**的只读聚合服务（P1-1）。
 *
 * ⚠️ 本文件**只读**：不写任何状态、不创建任何记录、不审批、不退款、不换人。
 * 它的全部工作就是——把既有仓储与既有列表服务已经算好的数据取回来，
 * 交给页面与接口。
 *
 * 三条边界，与 `architecture-rules.md` 和本轮的指令 §七 一致：
 *
 * 1. **不建第二套仓储**：订单走 `getPaymentRepository()`、退款走 `getRefundRepository()`。
 *    这两个仓储就是这些数据的唯一真值源，Dashboard 只是它们的读者之一。
 * 2. **统计逻辑不在 Route Handler 里**：Route 只做 `requireAdmin()` + 转发，
 *    口径全部在 `lib/constants/adminDashboard.ts` 的纯函数里（可单测）。
 * 3. **权限不在这里判**：角色判断只有一处（`lib/api/adminRoute.ts` 的 `requireAdmin()`，
 *    页面侧是 `app/admin/(console)/layout.tsx` 的重定向）。在这里再写一遍角色判断，
 *    只会多出一个可能与那处不一致的规则。
 *
 * ⚠️ **业务日由服务端算**（`new Date()` → 北京时间日期键），随 DTO 一起下发；
 * 浏览器不参与任何时间计算。因此「页面按本地时区算今天、服务端按 UTC+8 算今天」
 * 这种不一致在本结构下不可能发生。
 *
 * ⚠️ 调试参数在这一层处理，**不在页面里**（与 `adminConsole.ts` 同一条规则）：
 * `?mockError=…` 抛错（由 `error.tsx` / 局部重试处理），`?mockEmpty=dashboard`
 * 把六个数字**全部清零并正常返回**——「今天还没有订单」是正常状态，不是错误。
 */

/** 六个数字全为 0 的一份快照。`businessDate` 照旧——它是「这是哪一天的空」，不是数据。 */
function emptyDashboard(businessDate: string): AdminDashboardDTO {
  return {
    businessDate,
    metrics: { todayOrderCount: 0, todayGmvAmount: 0, todayRefundAmount: 0 },
    pending: { applications: 0, refunds: 0, complaints: 0 },
  };
}

/**
 * 三个待办数**直接读列表服务的 `total`**，不自己再数一遍。
 *
 * ## 为什么是「调列表」而不是「按状态集合数一遍」
 *
 * 这是 P1-1 的 R6 裁定（`docs/03-dev/rounds/cmd_p1-1.md` §六）要求的：
 * **卡片上的数字必须与点进去的列表条数一致。**
 *
 * 上一版是「卡片按 `PENDING_*_STATUSES` 数、链接写单值 `?status=pending`」，
 * 于是卡上是 2/4/3、点进去是 1/3/1。当时的修法是「在提示文案里说明对不上」——
 * 而那只是把不一致**写出来**，并没有消除它。
 *
 * 现在改成：卡片与列表**是同一次调用**。`status=open` 是查询层的虚拟值
 * （见 `AdminRefundStatusFilter` 等），列表服务把它解析成真实状态集合去筛，
 * 而 Dashboard 拿的就是这次筛选之后的总数（`total` 是**分页前**的全量条数）。
 * 因此「卡上的数 == 列表条数」不是巧合、不是约定，而是**同一个函数返回的同一个字段**。
 *
 * ⚠️ 顺带解决了一处更隐蔽的分叉：退款列表在服务层会**丢掉订单查不到的退款**
 * （`row.order !== undefined`）。若 Dashboard 自己按状态数 `RefundRequest`，
 * 那一条会被算进卡片却不出现在列表里。走列表服务就不会。
 *
 * ⚠️ 代价：三个列表各自的**整页取数**（用户索引 / 订单索引）也要跑一遍。
 * 这在 Mock 阶段是可接受的；换成真实数据库时，这一步应当下推成
 * 仓储层的聚合计数（已登记为迁移项，见 `03-delivery.md` §4.2 登记区第 2 条）。
 */
function openListQuery() {
  // 三份查询都只要 `total`，因此都用「首页 + 默认页大小」的正常列表查询，
  // 不为了省一点开销把 pageSize 写成 1——那会让这段代码看起来像在偷数。
  return {
    applications: buildAdminApplicationListQuery({
      params: new URLSearchParams("status=open"),
      status: "open",
      gameId: "",
    }),
    refunds: buildAdminRefundListQuery({
      params: new URLSearchParams("status=open"),
      status: "open",
    }),
    complaints: buildAdminComplaintListQuery({
      params: new URLSearchParams("status=open"),
      status: "open",
      type: "all",
    }),
  };
}

/**
 * 管理后台经营首页的完整快照。
 *
 * 所有读**并发**发出（一次 `withMockDebug`、一次 `Promise.all`）：它们是彼此无关的
 * 独立查询，串行只会让页面白等几个模拟延迟。这也让「延迟 → 抛错 → 取数」这套顺序
 * 只执行一遍。
 */
export async function getAdminDashboard(
  params?: URLSearchParams,
  surface: MockSurface = "server",
): Promise<AdminDashboardDTO> {
  const businessDate = beijingDateKey(new Date().toISOString());
  const open = openListQuery();

  const [orders, refunds, applications, refundList, complaintList] = await withMockDebug(
    params,
    surface,
    async () => {
      const [orderList, refundRows, applicationData, refundData, complaintData] = await Promise.all([
        getPaymentRepository().listAllOrders(),
        // 今日退款要**全部**退款记录（三条路径、两个通道，见 computeTodayRefundAmount），
        // 因此这里是不限状态的那一份，与上面三个 `status=open` 的列表查询互不替代。
        getRefundRepository().queryRefundsForAdmin({ statuses: null }),
        queryAdminApplicationList(open.applications, undefined, surface),
        queryAdminRefundList(open.refunds, undefined, surface),
        queryAdminComplaintList(open.complaints, undefined, surface),
      ]);
      return [orderList, refundRows, applicationData, refundData, complaintData] as const;
    },
  );

  if (mockEmptyApplies(params, "dashboard")) return emptyDashboard(businessDate);

  const today = computeTodayOrderMetrics(orders, businessDate);

  return {
    businessDate,
    metrics: {
      todayOrderCount: today.todayOrderCount,
      todayGmvAmount: today.todayGmvAmount,
      todayRefundAmount: computeTodayRefundAmount(refunds, orders, businessDate),
    },
    pending: {
      applications: applications.total,
      refunds: refundList.total,
      complaints: complaintList.total,
    },
  };
}
