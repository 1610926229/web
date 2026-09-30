import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_AFTERSALE_CASE_TYPE_INVALID_MESSAGE,
  ADMIN_AFTERSALE_CASE_TYPE_LABELS,
  ADMIN_AFTERSALE_DATE_INVALID_MESSAGE,
  ADMIN_AFTERSALE_LIST_NOTICE,
  ADMIN_AFTERSALE_VIEW_INVALID_MESSAGE,
  DEFAULT_ADMIN_AFTERSALE_CASE_TYPE,
  DEFAULT_ADMIN_AFTERSALE_VIEW,
  aftersaleComplaintViewOf,
  aftersaleInDateRange,
  aftersaleMatchesKeyword,
  aftersaleRefundViewOf,
  aftersaleRowInView,
  buildAdminAftersaleListQuery,
  compareAftersaleRowsNewestFirst,
  readAdminAftersaleCaseType,
  readAdminAftersaleView,
} from "@/lib/constants/adminAftersales";
import { COMPLAINT_STATUS_LABELS } from "@/lib/constants/complaints";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { readOrderFilterDate } from "@/lib/constants/orderFilters";
import { REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import { adminOrderIndex, adminUserIndex, missingUser } from "./adminIndex";
import { getAdminComplaintDetail } from "@/lib/services/adminComplaints";
import { getAdminOrderDetail } from "@/lib/services/adminOrders";
import { getAdminRefundDetail } from "@/lib/services/adminRefunds";
import type {
  AdminAftersaleCaseType,
  AdminAftersaleCounts,
  AdminAftersaleListData,
  AdminAftersaleListQuery,
  AdminAftersaleRow,
} from "@/lib/types/aftersale";
import type { AdminComplaintDetail, Complaint } from "@/lib/types/complaint";
import type { AdminOrderDetail, Order } from "@/lib/types/order";
import type { AdminRefundDetail, RefundRequest } from "@/lib/types/refund";
import type { AdminUserSummary } from "@/lib/types/user";

/**
 * 管理端「售后工作台」服务 —— 退款与投诉混合队列的**读取**入口（P1-3）。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`）。
 *
 * ⚠️ **本文件是只读的，而且刻意如此**：工作台把两类案件排进同一张队列，
 * 但处置动作一个都不在这里——退款仍然走 `adminRefunds.ts` 的三个审核动作，
 * 投诉仍然走 `adminComplaints.ts` 的三个处理动作。因此本文件
 * **没有事务、没有幂等键、没有审计写入、没有金额公式**，
 * 也**不 import 任何 `lib/data/*Transaction.ts`**。
 * 这不是「还没做」，是工作台的定位：它是**只读的分流队列**，
 * 点进去之后渲染的仍然是既有那两个专用控制台。
 *
 * ⚠️ 详情不走新的查询逻辑：它把两个既有详情服务的结果原样转交
 * （见 `getAdminAftersaleDetail`），订单侧的聚合也一样——
 * 本文件**不重写**订单 / 会话 / 退款 / 投诉的任何取数。
 */

// ——————————————————————————— 用户与订单索引 ———————————————————————————

/*
  `adminUserIndex` / `adminOrderIndex` / `missingUser` 见 `./adminIndex`（P1-3 抽出：
  订单 / 退款 / 投诉 / 售后四个管理列表此前各有一份逐字节相同的副本）。
  本文件只是使用者。
*/

// ——————————————————————————— 内部实体 → 一行案件 ———————————————————————————

/**
 * 退款申请 + 订单 + 用户摘要 → 工作台的一行。
 *
 * ⚠️ 订单侧的四个字段（订单号、订单状态、商品标题、打手快照）**取订单索引里的当前值**，
 * 而不是申请创建时的快照：一行案件要回答的是「这一单现在走到哪了」，
 * 退款挂在 `accepted` 上、后来订单走到 `completed` 时，列表应当如实跟着变。
 * 查不到订单时它们是 `null`（存储被写坏的不可能状态），
 * 而不是把这条退款丢掉——**这条退款本身是完整可读的**，
 * 「审核一笔金额」不需要先看订单摘要。
 *
 * ⚠️ `orderId` 仍然取申请自己的字段：即使订单记录缺失，这条退款也确实是挂在那个 id 上，
 * 「订单号为空的退款」与「订单记录缺失的退款」是两句话。
 */
function toRefundRow(
  refund: RefundRequest,
  order: Order | undefined,
  user: AdminUserSummary,
): AdminAftersaleRow {
  return {
    id: refund.id,
    caseType: "refund",
    caseTypeLabel: ADMIN_AFTERSALE_CASE_TYPE_LABELS.refund,
    caseNo: refund.refundNo,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    view: aftersaleRefundViewOf(refund.status),
    submittedAt: refund.createdAt,
    amount: refund.amount,
    // 与 `AdminRefundListItem.decidedAmount` 同源，都从这里派生，因此不会各自漂移
    decidedAmount: refund.decision?.refundAmount ?? null,
    user,
    orderId: refund.orderId,
    orderNo: order?.orderNo ?? null,
    orderStatus: order?.status ?? null,
    orderStatusLabel: order ? ORDER_STATUS_LABELS[order.status] : null,
    productTitle: order?.productTitle ?? null,
    companion: order?.companion ?? null,
  };
}

/**
 * 投诉 + 订单 + 用户摘要 → 工作台的一行。
 *
 * 与退款那一行的两处差别，都是**事实上的差别**，不是实现风格：
 *
 * 1. **没有金额**：投诉不产生任何一笔钱（见 `lib/types/complaint.ts` 开头），
 *    因此 `amount` / `decidedAmount` 恒为 `null`，而不是 `0`。
 *    ⚠️ `null` 与 `0` 必须分开：`0` 会被读成「这条投诉核定退 0 元」。
 * 2. **订单号优先取投诉自己的快照**（`complaint.orderNo`）：那是这条投诉记录里
 *    冻结的订单号，也是 `toAdminComplaintListItem` 用的那一份；订单索引只是兜底
 *    （订单记录缺失时）。订单索引在前的话，同一列在两个案件类型上就有了两个出处。
 */
function toComplaintRow(
  complaint: Complaint,
  order: Order | undefined,
  user: AdminUserSummary,
): AdminAftersaleRow {
  return {
    id: complaint.id,
    caseType: "complaint",
    caseTypeLabel: ADMIN_AFTERSALE_CASE_TYPE_LABELS.complaint,
    caseNo: complaint.complaintNo,
    status: complaint.status,
    statusLabel: COMPLAINT_STATUS_LABELS[complaint.status],
    view: aftersaleComplaintViewOf(complaint.status),
    submittedAt: complaint.createdAt,
    amount: null,
    decidedAmount: null,
    user,
    orderId: complaint.orderId,
    orderNo: complaint.orderNo ?? order?.orderNo ?? null,
    orderStatus: order?.status ?? null,
    orderStatusLabel: order ? ORDER_STATUS_LABELS[order.status] : null,
    productTitle: order?.productTitle ?? null,
    companion: order?.companion ?? null,
  };
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 *
 * 三个筛选都要解析：它们都会**改变查到的数据**，一个手改坏的值若静默按默认处理，
 * 页面会显示一批与筛选栏不符的案件，而那比报错更难排查。
 *
 * ⚠️ 日期用 `readOrderFilterDate`（`lib/constants/orderFilters.ts`）读，
 * **不在这里另写正则**：那份实现是仓库里唯一的地址栏日期参数校验，
 * 连「`2026-13-45` 这种形状对、日期不存在的值」都由它一并挡住
 * （完整的复用理由见 `lib/constants/adminAftersales.ts` 的「日期」一节）。
 *
 * ⚠️ `from > to` 按非法处理，与「格式不对」共用同一句文案：两者对使用者是同一件事
 * （「这个区间不成立」），分成两句只会让人去查一个不存在的格式问题。
 * 页面侧（`strict: false`）回落成**不限日期**——与另外几处「非法筛选值回落成不限」
 * 同一条纪律：坏掉的地址栏参数不该让整页报错，但也不能显示一批与筛选栏不符的案件。
 */
export async function resolveAdminAftersaleListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminAftersaleListQuery> {
  const view = readAdminAftersaleView(params.get("view"));
  const caseType = readAdminAftersaleCaseType(params.get("caseType"));
  const from = readOrderFilterDate(params.get("from"));
  const to = readOrderFilterDate(params.get("to"));

  // 空串是「该侧不限」，因此这里先把 null 归一成空串再比大小
  const resolvedFrom = from ?? "";
  const resolvedTo = to ?? "";
  const rangeReversed = Boolean(resolvedFrom && resolvedTo && resolvedFrom > resolvedTo);

  if (strict) {
    if (view === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_AFTERSALE_VIEW_INVALID_MESSAGE, 400);
    }
    if (caseType === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_AFTERSALE_CASE_TYPE_INVALID_MESSAGE, 400);
    }
    if (from === null || to === null || rangeReversed) {
      throw new ApiError("BAD_REQUEST", ADMIN_AFTERSALE_DATE_INVALID_MESSAGE, 400);
    }
  }

  return buildAdminAftersaleListQuery({
    params,
    view: view ?? DEFAULT_ADMIN_AFTERSALE_VIEW,
    caseType: caseType ?? DEFAULT_ADMIN_AFTERSALE_CASE_TYPE,
    // 区间倒过来时不保留它：一个必然查不到东西的区间，与「不限」在界面上无法区分
    from: rangeReversed ? "" : resolvedFrom,
    to: rangeReversed ? "" : resolvedTo,
  });
}

/**
 * 管理端售后工作台列表。
 *
 * `?mockEmpty=aftersales` 演示空列表（空数据不是错误，不抛错，由页面渲染空态，
 * 连 `counts` 也一起清零）；`?mockError=…` 由 `withMockDebug` 统一处理。
 * 两者都只在 `ENABLE_MOCK_DEBUG=true` 时生效，且都在这一层处理——
 * `app/admin/**` 下的页面不引用 `lib/mocks`。
 *
 * ## 过滤顺序（这是本函数唯一需要读清楚的一段）
 *
 * **caseType → 日期 → 关键词**，排序 → **分桶计数** → **按视图收窄** → 分页。
 *
 * ⚠️ 视图**不在仓储层执行**：两个仓储一律以 `statuses: null` 取数，
 * 对数据层而言就是「没有状态限制」，数据层见到的永远只是 `null`——
 * 「`open` / `closed` 这类查询层写法不下沉到数据层」这条因此成立。
 * 视图的**翻译**（`aftersale*StatusesForView`）与**执行**（`aftersaleRowInView`，
 * 它按状态集合判断）都在 `lib/constants/adminAftersales.ts` 一处定义，
 * 服务层在本函数里执行：先分桶得到 `counts`，再收窄出当前视图的行。
 *
 * ⚠️ **为什么不能把视图交给仓储**（曾经这样做过，是个真实缺陷）：仓储会按状态集合
 * 收窄，取回来的只剩当前视图的行，于是 `counts` 另外两个桶恒为 0——
 * 「不含视图筛选」就成了空转，`counts` 的类型注释（`lib/types/aftersale.ts`）
 * 与 D-P1-3-8 想回答的「切过去还有多少条」也就落空了。
 *
 * ⚠️ 剩下三个筛选也只能在服务层做——`caseType` 是跨领域的，
 * 日期与关键词都要跨用户仓储匹配，三者在任何一个仓储里都做不了。
 *
 * ⚠️ **`counts` 与分页落在两个不同的集合上**：`counts` 在不含视图的 `matched` 上分桶，
 * `total` / `hasMore` / `items` 落在收窄之后的当前视图集合上
 * （角标回答的是「有哪些」，`total` 回答的是「这一屏能翻多少」）。
 * 把两个集合合成一个，正是上面那个缺陷的根。
 *
 * ⚠️ 但两者的口径必须**对得上**：`counts.open` 必须等于点开「未完结」看到的条数。
 * 两个集合由同一组常量导出（`aftersale*ViewOf` 与 `aftersale*StatusesForView`
 * 都指向 `OPEN_*`），因此不会分叉——见下面两段的注释。
 *
 * ⚠️ **分页必须在全部过滤与排序之后**：数据层只回答「什么状态、什么顺序」，
 * 先分页再过滤会让 `total` 与实际能翻到的条数分叉。
 */
export async function queryAdminAftersaleList(
  query: AdminAftersaleListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminAftersaleListData> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "aftersales")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        counts: { all: 0, open: 0, processing: 0, closed: 0 },
        notice: ADMIN_AFTERSALE_LIST_NOTICE,
      };
    }

    /*
      ⚠️ `statuses: null` 是刻意的，两个仓储都**不按视图收窄**：
      一次取回全部命中记录（两个仓储本来就不分页），
      视图的分桶与收窄都放在本函数里，见上面注释与下面的两段。
    */
    const [refunds, complaints, orders, users] = await Promise.all([
      getRefundRepository().queryRefundsForAdmin({ statuses: null }),
      getComplaintRepository().queryComplaintsForAdmin({ statuses: null, type: null }),
      adminOrderIndex(),
      adminUserIndex(),
    ]);

    // 两类记录各自映射成同一种行，之后的所有筛选都只面对这一种形状：
    // 「视图」与「状态」的对应关系因此只有 `lib/constants/adminAftersales.ts` 一处定义
    const rows = [
      ...refunds.map((refund) =>
        toRefundRow(
          refund,
          orders.get(refund.orderId),
          users.get(refund.userId) ?? missingUser(refund.userId),
        ),
      ),
      ...complaints.map((complaint) =>
        toComplaintRow(
          complaint,
          complaint.orderId ? orders.get(complaint.orderId) : undefined,
          users.get(complaint.userId) ?? missingUser(complaint.userId),
        ),
      ),
    ];

    const matched = rows
      .filter((row) => query.caseType === "all" || row.caseType === query.caseType)
      .filter((row) => aftersaleInDateRange(row, query.from, query.to))
      .filter((row) =>
        aftersaleMatchesKeyword(
          {
            caseNo: row.caseNo,
            orderNo: row.orderNo ?? "",
            nickname: row.user.nickname,
            displayId: row.user.displayId,
            companionName: row.companion?.name ?? "",
          },
          query.keyword,
        ),
      )
      .sort(compareAftersaleRowsNewestFirst);

    /*
      计数在**日期与关键词过滤之后**统计，但**不按视图再筛**：
      `matched` 里每一行按它自己的**精确桶** `row.view` 归类，再把 `processing`
      那一桶计入 `open`——因为 `open` 是**未完结的全集**，`processing` 是它的
      **子集**（D-P1-3-2）。于是构造性地有

        all === open + closed                ← closed 就是未完结的补集
        processing ⊆ open                    ← open 额外收下 processing 这一桶
        open + processing + closed === all   ← ⛔ 不成立，两桶**刻意重叠**

      这三个数是给筛选栏当角标的，因此 `counts.open` 必须等于点开「未完结」看到的
      条数：一条 `reviewing` 的退款**属于未完结**，虽然它的精确桶是 `processing`。
      **不要**为了让三数相加等于 `all` 而把 `open` 收窄回「待接手」——
      那正是第一版的缺陷（默认视图把等着批准的退款漏掉了，见 D-P1-3-8）。

      ⚠️ 这一步必须在下面「按视图收窄」**之前**：matched 一旦被收窄，
      另外两个桶就恒为 0，角标也就答不出「切过去还有多少条」。
    */
    const counts: AdminAftersaleCounts = { all: 0, open: 0, processing: 0, closed: 0 };
    for (const row of matched) {
      counts.all += 1;
      // `closed` 是唯一与其它两桶互斥的那一桶，其余（open 与 processing）都是未完结
      if (row.view === "closed") counts.closed += 1;
      else counts.open += 1;
      if (row.view === "processing") counts.processing += 1;
    }

    /*
      现在才把 matched 收窄成当前视图的行——**按状态集合**判断
      （`aftersaleRowInView`：`open` 用该领域的 `OPEN_*` 全集，因此含 `processing` 那一桶），
      **不能拿 `row.view === query.view` 来筛**：`reviewing` 的行精确桶是
      `processing`，按精确桶比就会从「未完结」里漏掉——那正是 BLOCKER-1。
      `view === "all"` 时不过滤，此时 total 与 counts.all 自然一致。
    */
    const inView =
      query.view === "all" ? matched : matched.filter((row) => aftersaleRowInView(row, query.view));

    const start = (query.page - 1) * query.pageSize;
    const items = inView.slice(start, start + query.pageSize);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: inView.length,
      hasMore: start + items.length < inView.length,
      counts,
      notice: ADMIN_AFTERSALE_LIST_NOTICE,
    };
  });
}

// ——————————————————————————— 详情 ———————————————————————————

/**
 * 工作台的一行点开之后要渲染的东西：**既有那两个详情**，外加订单侧聚合。
 *
 * ⚠️ 三个字段里**只有一个非空**，另一个类型的那个是 `null`——这不是「可空字段偷懒」，
 * 而是调用方（页面）已经知道用户点的是哪一类，它需要的是**同一个返回值形状**
 * 来决定渲染哪套控制台。用联合类型会让页面的三个分支各自去收窄一次，
 * 而三份收窄逻辑迟早会漂移。
 *
 * ⚠️ `order` 是**既有 `AdminOrderDetail`**（已含 `actualCompanion` / `releaseHistory` /
 * `conversationSummary` / `refundSummary` / `complaintSummary`），
 * 不是这里新拼的一份订单摘要：工作台不重写订单、会话、退款、投诉的任何取数。
 */
export async function getAdminAftersaleDetail(
  caseType: AdminAftersaleCaseType,
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{
  caseType: AdminAftersaleCaseType;
  refund: AdminRefundDetail | null;
  complaint: AdminComplaintDetail | null;
  order: AdminOrderDetail | null;
} | null> {
  if (!id) return null;

  /*
    两条分支各自只调**既有的**详情服务：退款那条走 `getAdminRefundDetail`，
    投诉那条走 `getAdminComplaintDetail`。两者都已经带着
    「不存在 → null」「服务端判定的 allowedActions」「订单状态闸」这些结论，
    工作台再判一遍等于把同一套规则写第二份。
  */
  if (caseType === "refund") {
    const refund = await getAdminRefundDetail(id, params, surface);
    if (!refund) return null;

    // 退款的订单号取自退款自己（`AdminRefundDetail.orderId`）
    const order = await getAdminOrderDetail(refund.orderId, params, surface);
    return { caseType, refund, complaint: null, order };
  }

  const complaint = await getAdminComplaintDetail(id, params, surface);
  if (!complaint) return null;

  /* ⚠️ 投诉的 `orderId` **允许为 null**（用户可以不关联订单提交投诉），
     那时订单侧就是 null——**不是 404**：投诉本身完整可读，正文、凭证、处理结果
     都在它自己身上，为了一条不存在的订单把整条投诉变成 404 会让客服连用户写了什么都看不到
     （同 `lib/services/adminComplaints.ts` 的 `orderSummaryInput`）。 */
  const order = complaint.orderId
    ? await getAdminOrderDetail(complaint.orderId, params, surface)
    : null;
  return { caseType, refund: null, complaint, order };
}
