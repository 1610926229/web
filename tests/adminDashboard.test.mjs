import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";

import { ADMIN_APPLICATION_LIST_HREF, ADMIN_NAV_ITEMS } from "../lib/constants/admin.ts";
import {
  ADMIN_DASHBOARD_PENDING_HREFS,
  ADMIN_DASHBOARD_QUICK_ENTRIES,
  ADMIN_DASHBOARD_REFUNDS_HREF,
  ADMIN_DASHBOARD_TODAY_ORDERS_HREF,
  beijingDateKey,
  computeTodayOrderMetrics,
  computeTodayRefundAmount,
  isOnBusinessDate,
  listApprovedRefundEvents,
} from "../lib/constants/adminDashboard.ts";
import {
  ADMIN_APPLICATION_STATUS_FILTERS,
  OPEN_APPLICATION_STATUSES,
  applicationStatusesForFilter,
  buildAdminApplicationListQuery,
  readAdminApplicationStatusFilter,
} from "../lib/constants/adminApplications.ts";
import {
  ADMIN_COMPLAINT_STATUS_FILTERS,
  buildAdminComplaintListQuery,
  complaintStatusesForFilter,
  readAdminComplaintStatusFilter,
} from "../lib/constants/adminComplaints.ts";
import {
  DEFAULT_ADMIN_REFUND_STATUS_FILTER,
  buildAdminRefundListQuery,
  isAdminRefundStatusFilter,
  readAdminRefundStatusFilter,
  refundStatusesForFilter,
} from "../lib/constants/adminRefunds.ts";
import { COMPLAINT_STATUSES, OPEN_COMPLAINT_STATUSES } from "../lib/constants/complaints.ts";
import { COMPANION_APPLICATION_STATUSES } from "../lib/constants/companionApplications.ts";
import { isUnresolvedComplaintStatus } from "../lib/constants/completions.ts";
import { ACTIVE_REFUND_STATUSES, OPEN_REFUND_STATUSES, REFUND_STATUSES } from "../lib/constants/refunds.ts";
import { getCompanionApplicationRepository } from "../lib/data/companionApplicationRepository.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder } from "../lib/data/companionOrderTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { getAdminDashboard } from "../lib/services/adminDashboard.ts";
import { queryAdminApplicationList } from "../lib/services/adminCompanionApplications.ts";
import { queryAdminComplaintList } from "../lib/services/adminComplaints.ts";
import { queryAdminRefundList, startReviewAdminRefund } from "../lib/services/adminRefunds.ts";
import { createComplaintForUser } from "../lib/services/complaints.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { directRefundOrderForUser, createRefundForOrder } from "../lib/services/refunds.ts";
import { hasAppFile, resolveSource } from "./app-path.mjs";
import { readSource, stripComments, withoutImports } from "./source-text.mjs";

/**
 * P1-1「管理员首页经营概览 + 待办聚合」的持续测试。
 *
 * ## 这一组真正在守什么
 *
 * 经营首页上的六个数字是**管理决策的依据**，口径错一个都会误导人：
 * 把退款倒扣出 GMV、把昨天的退款算到今天、把累计 `refundedAmount` 当今日退款——
 * 这三种错**都不会让页面报错**，只会安静地显示一个错的数。因此本文件的大头是
 * `lib/constants/adminDashboard.ts` 里那几个**纯函数**的逐条口径验证。
 *
 * 分三层，各自的职责不重叠：
 *
 * 1. **纯口径**（绝大多数）：直接喂内存里的订单 / 退款记录，不启服务、不碰 Mock 延迟，
 *    因此业务日边界、跨日退款、多次部分退款这些容易被时区与实现细节掩盖的规则
 *    可以逐条钉住；
 * 2. **服务接线**：走真实仓储，验证「服务层确实读了这四个仓储、确实用了上面这套口径」。
 *    ⚠️ 这一层**一律用增量断言**（新支付一单 → 今日订单 +1），不写「今日订单 === 3」——
 *    预置排行榜数据是**相对进程启动时刻**构造的（`getMockSeedNow()`），
 *    昨天跑是 3、明天跑可能是 0，绝对值断言等于给自己埋一颗定时炸弹；
 * 3. **HTTP 与源码**：四格权限矩阵、DTO 精确键、页面的四段与三种状态。
 *
 * ⚠️ 本文件**不发明新的业务规则**。每一个断言都能追到 `01-prompt.md` 的 §三 / §五 /
 * §八 / §十 / §十一 或 `02-decisions.md` 的 D1–D8。
 */

// ————————————————————————— 固定时间 —————————————————————————

/**
 * 纯逻辑用例一律用**写死的绝对时刻**，不取 `new Date()`。
 *
 * 北京时间的边界必须能一眼看出来：`2026-09-27T16:00:00.000Z` 是 UTC 下午四点，
 * 而它在北京已经是**第二天**凌晨——这正是「浏览器算一天、服务端算另一天」的经典现场。
 */
const BUSINESS_DATE = "2026-09-27";
/** 北京时间 2026-09-27 12:00 */
const TODAY_NOON = "2026-09-27T04:00:00.000Z";
/** 北京时间 2026-09-26 12:00 */
const YESTERDAY_NOON = "2026-09-26T04:00:00.000Z";
/** 北京时间 2026-09-27 00:00（正是 UTC 前一天 16:00） */
const TODAY_START = "2026-09-26T16:00:00.000Z";
/** 北京时间 2026-09-27 23:59:59.999 */
const TODAY_END = "2026-09-27T15:59:59.999Z";
/** 北京时间 2026-09-28 00:00 */
const TOMORROW_START = "2026-09-27T16:00:00.000Z";

function orderFact(overrides = {}) {
  return {
    id: "ord-t",
    paidAt: TODAY_NOON,
    actualPaidAmount: 10_000,
    refundedAt: null,
    ...overrides,
  };
}

function refundRecord(overrides = {}) {
  return {
    id: "rf-t",
    orderId: "ord-t",
    status: "approved",
    decision: { decidedAt: TODAY_NOON, refundAmount: 3_000 },
    ...overrides,
  };
}

// ————————————————————————— 一、今日订单 —————————————————————————

test("经营 1：没有任何订单时今日订单为 0——空数据不是错误", () => {
  assert.deepEqual(computeTodayOrderMetrics([], BUSINESS_DATE), {
    todayOrderCount: 0,
    todayGmvAmount: 0,
  });
});

test("经营 2：今天支付成功的订单逐单计入", () => {
  const metrics = computeTodayOrderMetrics(
    [orderFact({ id: "a" }), orderFact({ id: "b" }), orderFact({ id: "c" })],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayOrderCount, 3);
});

test("经营 3：昨天支付的订单不计入今天", () => {
  const metrics = computeTodayOrderMetrics(
    [orderFact({ id: "a", paidAt: YESTERDAY_NOON })],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayOrderCount, 0, "昨天的单跑到今天来了");
});

test("经营 4：业务日边界按北京时间整点切——00:00 属于当天，前一天 23:59:59.999 不属于", () => {
  // 边界两侧各取一个极近的时刻，一天的头与尾各一个
  const metrics = computeTodayOrderMetrics(
    [
      orderFact({ id: "昨天的最末一刻", paidAt: "2026-09-26T15:59:59.999Z" }),
      orderFact({ id: "今天的第一刻", paidAt: TODAY_START }),
      orderFact({ id: "今天的最后一刻", paidAt: TODAY_END }),
      orderFact({ id: "明天的第一刻", paidAt: TOMORROW_START }),
    ],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayOrderCount, 2, "只有「今天的第一刻」与「今天的最后一刻」属于今天");

  // 逐条钉住边界（上面的计数断言在实现整体偏移一小时时也会是 2）
  assert.equal(isOnBusinessDate(TODAY_START, BUSINESS_DATE), true);
  assert.equal(isOnBusinessDate("2026-09-26T15:59:59.999Z", BUSINESS_DATE), false);
  assert.equal(isOnBusinessDate(TODAY_END, BUSINESS_DATE), true);
  assert.equal(isOnBusinessDate(TOMORROW_START, BUSINESS_DATE), false);

  // 业务日键就是**北京时间**的那一天，不是 UTC 的那一天
  assert.equal(beijingDateKey(TODAY_START), BUSINESS_DATE);
  assert.equal(beijingDateKey(TOMORROW_START), "2026-09-28");

  // 坏时间戳归属不到任何一天：它既不算进今天，也不会误判成今天
  assert.equal(beijingDateKey("不是时间"), "");
  assert.equal(isOnBusinessDate("不是时间", BUSINESS_DATE), false);
  assert.equal(isOnBusinessDate(TODAY_NOON, ""), false, "空业务日不得匹配任何时刻");
});

// ————————————————————————— 二、今日 GMV —————————————————————————

test("经营 5：今日 GMV 是今天这些订单实付金额的分值累加", () => {
  const metrics = computeTodayOrderMetrics(
    [
      orderFact({ id: "a", actualPaidAmount: 2_990 }),
      orderFact({ id: "b", actualPaidAmount: 12_800 }),
      orderFact({ id: "c", actualPaidAmount: 100 }),
    ],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayGmvAmount, 15_890);
  assert.equal(Number.isInteger(metrics.todayGmvAmount), true, "金额必须是整数分");
});

test("经营 6：口径是实付金额，不是原价，也不是平台收入或打手收益", () => {
  // 同一单同时带上这些字段：只要实现里去读了其中任何一个，下面的等号就会断
  const metrics = computeTodayOrderMetrics(
    [
      {
        ...orderFact({ actualPaidAmount: 2_990 }),
        totalAmount: 9_999,
        companionBaseIncome: 1_500,
        clubNetIncome: 700,
        platformNetIncome: 790,
        refundedAmount: 2_990,
      },
    ],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayGmvAmount, 2_990, "GMV 必须取实付，不能取原价 / 分账 / 累计退款");
});

test("经营 7：今天退款不倒扣 GMV——GMV 是成交规模，不是净收入", () => {
  const paidToday = orderFact({ id: "a", actualPaidAmount: 5_000, refundedAt: TODAY_END });
  const metrics = computeTodayOrderMetrics([paidToday], BUSINESS_DATE);

  assert.equal(metrics.todayOrderCount, 1, "今天成交、今天又退款的订单仍然是一次成交");
  assert.equal(metrics.todayGmvAmount, 5_000, "退款不得回滚 GMV");
});

test("经营 8：昨天支付的订单，实付金额不进今天的 GMV", () => {
  const metrics = computeTodayOrderMetrics(
    [orderFact({ id: "a", paidAt: YESTERDAY_NOON, actualPaidAmount: 8_800 })],
    BUSINESS_DATE,
  );

  assert.equal(metrics.todayGmvAmount, 0);
});

// ————————————————————————— 三、今日退款金额 —————————————————————————

test("经营 9：直接全额退款（不写退款申请）也能从订单侧被发现", () => {
  // `directRefundOrder` 只写订单的 `refundedAt` 与 `refundedAmount`，**不建 RefundRequest**。
  // 只从退款申请那一侧统计的实现，会把这一笔整单漏掉。
  const total = computeTodayRefundAmount(
    [],
    [orderFact({ id: "a", paidAt: YESTERDAY_NOON, actualPaidAmount: 2_990, refundedAt: TODAY_NOON })],
    BUSINESS_DATE,
  );

  assert.equal(total, 2_990);
});

test("经营 10：售后审核通过的部分退款按**这一次**的实际退款额计", () => {
  const total = computeTodayRefundAmount(
    [refundRecord({ decision: { decidedAt: TODAY_NOON, refundAmount: 1_200 } })],
    [orderFact({ id: "ord-t", refundedAt: null })],
    BUSINESS_DATE,
  );

  assert.equal(total, 1_200);
  assert.equal(
    refundRecord().amount,
    undefined,
    "申请时的实付快照不参与统计——它不回答「最后退了多少」",
  );
});

test("经营 11：售后审核退满整单只计一次，不因为订单也写了 refundedAt 而翻倍", () => {
  // 售后链路退满时**同样**会写 `order.refundedAt`（`applyOrderRefund` 在退满那一刻写它），
  // 因此「有 refundedAt 就是一次直接退款」是错的判据。正确判据是差额：
  // actualPaidAmount − Σ 已通过退款 = 0 ⇒ 整单都是售后退的，已由事件侧算过
  const refunds = [refundRecord({ decision: { decidedAt: TODAY_NOON, refundAmount: 5_000 } })];
  const orders = [
    orderFact({ id: "ord-t", actualPaidAmount: 5_000, paidAt: YESTERDAY_NOON, refundedAt: TODAY_NOON }),
  ];

  assert.equal(computeTodayRefundAmount(refunds, orders, BUSINESS_DATE), 5_000);
});

test("经营 12：同一订单今天发生两次部分退款，按事件逐笔累加", () => {
  const refunds = [
    refundRecord({ id: "rf-1", status: "approved", decision: { decidedAt: TODAY_NOON, refundAmount: 1_000 } }),
    refundRecord({ id: "rf-2", status: "approved", decision: { decidedAt: TODAY_END, refundAmount: 2_500 } }),
  ];

  assert.equal(computeTodayRefundAmount(refunds, [orderFact({ refundedAt: null })], BUSINESS_DATE), 3_500);
});

test("经营 13：昨天支付的订单今天退款，算今天的", () => {
  const total = computeTodayRefundAmount(
    [refundRecord({ decision: { decidedAt: TODAY_START, refundAmount: 4_000 } })],
    [orderFact({ paidAt: YESTERDAY_NOON, refundedAt: null })],
    BUSINESS_DATE,
  );

  assert.equal(total, 4_000, "退款按**退款发生的时刻**归属，与订单支付日期无关");
});

test("经营 14：昨天发生的退款不进今天", () => {
  const total = computeTodayRefundAmount(
    [refundRecord({ decision: { decidedAt: YESTERDAY_NOON, refundAmount: 4_000 } })],
    [orderFact({ paidAt: "2026-09-25T04:00:00.000Z", refundedAt: YESTERDAY_NOON })],
    BUSINESS_DATE,
  );

  assert.equal(total, 0);
});

test("经营 15：跨日部分退款后今天直接退余款——只算今天出去的钱，不重复计历史那笔", () => {
  // 这一条是「不许用累计 refundedAmount」的正面用例：
  // 订单 10000 分，昨天售后部分退了 3000，今天用户直接退了剩下的 7000。
  // 累计值是 10000（今天只出去 7000），差额判据必须得出 7000。
  const refunds = [
    refundRecord({ status: "approved", decision: { decidedAt: YESTERDAY_NOON, refundAmount: 3_000 } }),
  ];
  const orders = [
    {
      ...orderFact({ id: "ord-t", actualPaidAmount: 10_000, paidAt: "2026-09-25T04:00:00.000Z", refundedAt: TODAY_NOON }),
      refundedAmount: 10_000,
    },
  ];

  assert.equal(computeTodayRefundAmount(refunds, orders, BUSINESS_DATE), 7_000);
});

test("经营 16：没有结论的申请一分钱都没退——待审核 / 审核中 / 已驳回 / 已撤销一律不计", () => {
  const refunds = [
    refundRecord({ id: "待审核", status: "pending", decision: null }),
    refundRecord({ id: "审核中", status: "reviewing", decision: null }),
    refundRecord({ id: "已驳回", status: "rejected", decision: { decidedAt: TODAY_NOON, refundAmount: 9_999 } }),
    refundRecord({ id: "已撤销", status: "cancelled", decision: null }),
    // 防御：状态已是 approved 但没有结论记录（数据异常）——不计，不猜金额
    refundRecord({ id: "无结论", status: "approved", decision: null }),
  ];

  assert.equal(computeTodayRefundAmount(refunds, [orderFact({ refundedAt: null })], BUSINESS_DATE), 0);
  assert.equal(listApprovedRefundEvents(refunds).length, 0);
});

test("经营 17：坏时间戳的退款不进今天", () => {
  const refunds = [refundRecord({ decision: { decidedAt: "不是时间", refundAmount: 5_000 } })];
  const orders = [orderFact({ refundedAt: "不是时间" })];

  assert.equal(computeTodayRefundAmount(refunds, orders, BUSINESS_DATE), 0);
});

// ————————————————————————— 四、当前待办 —————————————————————————
//
// ⚠️ 这一节在 P1-1 的 R6 裁定（`docs/03-dev/rounds/cmd_p1-1.md` §六）之后**整体重写**。
//
// 裁定只有一句：**Dashboard 上的数必须与点进去的列表条数一致。**
//
// 上一版的做法是「首页在 `lib/constants/adminDashboard.ts` 里存一份
// `PENDING_*_STATUSES` 自己数、链接写单值 `?status=pending`」，于是卡上是 2/4/3、
// 点进去是 1/3/1。当时的处置是「在提示文案里说明对不上」——那只是把不一致**写出来**，
// 并没有消除它，因此被裁定推翻。
//
// 现在**每个领域各自只有一份「未终结」定义**，放在该领域自己的常量文件里：
//
// | 领域 | 集合 | 定义处 |
// |---|---|---|
// | 入驻申请 | `OPEN_APPLICATION_STATUSES` | `lib/constants/adminApplications.ts` |
// | 退款 | `OPEN_REFUND_STATUSES` | `lib/constants/refunds.ts` |
// | 投诉 | `OPEN_COMPLAINT_STATUSES` | `lib/constants/complaints.ts` |
//
// 首页与列表**共用**这一份：地址栏上的 `status=open` 只是个虚拟筛选值，
// 由各自的 `*StatusesForFilter()` 解析成上面那个集合，服务层再拿它去筛。
// 因此下面这一节测的不再是「首页数的对不对」，而是「**只有一份定义**」。

test("经营 18：入驻申请待办 = 待审核 + 审核中，终态一个都不算", () => {
  assert.deepEqual([...OPEN_APPLICATION_STATUSES], ["pending", "reviewing"]);
  assert.deepEqual([...applicationStatusesForFilter("open")], ["pending", "reviewing"]);

  // 终态一个都不许进「待处理」：已通过 / 已驳回 / 用户撤销都已经有人做完了决定
  for (const terminal of ["approved", "rejected", "withdrawn"]) {
    assert.equal(
      OPEN_APPLICATION_STATUSES.includes(terminal),
      false,
      `${terminal} 是终态，不该出现在待处理集合里`,
    );
    assert.deepEqual([...applicationStatusesForFilter(terminal)], [terminal]);
  }
});

test("经营 19：退款待办 = 待审核 + 审核中；已通过 / 已驳回 / 已撤销都不是待办", () => {
  // ⚠️ 退款**没有** analysis/processing 这一档（与投诉不同）：它的流程是
  // pending → reviewing → approved / rejected，审批通过即终态
  assert.deepEqual([...OPEN_REFUND_STATUSES], ["pending", "reviewing"]);
  assert.deepEqual([...refundStatusesForFilter("open")], ["pending", "reviewing"]);

  // ⚠️ 这里是**同一个数组对象**，不是两份内容相同的表：退款域在 P1-1 之前就已经有
  // `ACTIVE_REFUND_STATUSES`（8 处业务路径在用：订单阻断、退款重申拦截、评价、
  // 客服完工校验……）。若「待处理」另写一份，「列表里能重申退款但首页说没有待办」
  // 这类分叉会重新长出来——用 `equal`（引用相等）而不是 `deepEqual` 钉死。
  assert.equal(OPEN_REFUND_STATUSES, ACTIVE_REFUND_STATUSES);

  for (const terminal of ["approved", "rejected", "cancelled"]) {
    assert.equal(OPEN_REFUND_STATUSES.includes(terminal), false, `${terminal} 已经结束`);
  }
});

test("经营 20：投诉待办 = 待处理 + 处理中；已处理 / 已关闭都不是待办", () => {
  assert.deepEqual([...OPEN_COMPLAINT_STATUSES], ["pending", "processing"]);
  assert.deepEqual([...complaintStatusesForFilter("open")], ["pending", "processing"]);

  // 投诉域在 P1-1 之前也已经有一个「未解决」判据（`isUnresolvedComplaintStatus`，
  // 订单阻断与客服完工在用它）。它现在**读的就是这个集合**，因此两者不可能分叉。
  for (const status of [...COMPLAINT_STATUSES]) {
    assert.equal(
      isUnresolvedComplaintStatus(status),
      OPEN_COMPLAINT_STATUSES.includes(status),
      `isUnresolvedComplaintStatus(${status}) 与 OPEN_COMPLAINT_STATUSES 不一致`,
    );
  }
  assert.equal(isUnresolvedComplaintStatus("resolved"), false);
  assert.equal(isUnresolvedComplaintStatus("closed"), false);
});

test("经营 21：三个领域各解析各的——all 是「全部」，单状态原样透传，互不影响", () => {
  assert.equal(applicationStatusesForFilter("all"), null);
  assert.equal(refundStatusesForFilter("all"), null);
  assert.equal(complaintStatusesForFilter("all"), null);

  assert.deepEqual([...applicationStatusesForFilter("reviewing")], ["reviewing"]);
  assert.deepEqual([...refundStatusesForFilter("pending")], ["pending"]);
  assert.deepEqual([...complaintStatusesForFilter("closed")], ["closed"]);

  // 三个领域的「未终结」各自独立：退款的那两个状态跟投诉的两个不是一回事
  assert.notDeepEqual(
    [...refundStatusesForFilter("open")],
    [...complaintStatusesForFilter("open")],
    "退款与投诉的待处理状态恰好不同（refund 没有 processing 这一档）",
  );
});

test("经营 22：open / all 都只是查询层的虚拟筛选值，不是领域状态", () => {
  const DOMAIN_STATUSES = [
    ["入驻申请", COMPANION_APPLICATION_STATUSES],
    ["退款", REFUND_STATUSES],
    ["投诉", COMPLAINT_STATUSES],
  ];

  for (const [name, statuses] of DOMAIN_STATUSES) {
    for (const virtual of ["open", "all"]) {
      assert.equal(statuses.includes(virtual), false, `${name}的领域枚举里混进了 ${virtual}`);
    }
  }

  // 筛选联合里的虚拟值**恰好**是这两个，且各自都出现在筛选栏选项里
  for (const [name, filters, virtuals] of [
    ["入驻申请", ADMIN_APPLICATION_STATUS_FILTERS, ["all", "open"]],
    ["投诉", ADMIN_COMPLAINT_STATUS_FILTERS, ["all", "open"]],
  ]) {
    for (const virtual of virtuals) {
      assert.ok(filters.includes(virtual), `${name}的筛选栏缺少 ${virtual}`);
    }
  }

  // ⚠️ 数据层**见不到**这两个词：`open` 既不写进 store，也不进任何领域状态机。
  // 这是「虚拟值」这句话唯一可执行的形式——它若漏到仓储层，就说明有人把
  // 地址栏的值直接当状态用了。
  for (const file of [
    "lib/data/mockCompanionApplicationRepository.ts",
    "lib/data/mockRefundRepository.ts",
    "lib/data/mockComplaintRepository.ts",
    "lib/data/companionApplicationRepository.ts",
    "lib/data/refundRepository.ts",
    "lib/data/complaintRepository.ts",
  ]) {
    const code = stripComments(readSource(resolveSource(file)));
    assert.equal(code.includes('"open"'), false, `${file} 里出现了 open：虚拟筛选值不得进入数据层`);
    assert.equal(code.includes('"all"'), false, `${file} 里出现了 all：虚拟筛选值不得进入数据层`);
  }
});

test("经营 23：待办口径只有一份定义——`adminDashboard.ts` 里不再存第二套状态集合", () => {
  // ⚠️ 这条是 R6 的**结构性**保证。R6 的病根不是数字算错了，而是同一个规则
  // 在两个文件里各写了一遍。因此这里直接钉住：首页那个常量文件里
  // **不允许**再出现「状态字面量组成的数组」。
  const code = stripComments(readSource(resolveSource("lib/constants/adminDashboard.ts")));

  assert.equal(
    /\[\s*"pending"/.test(code),
    false,
    "经营首页又自己列了一份状态集合：待办口径必须来自各领域常量文件",
  );
  for (const name of ["PENDING_APPLICATION_STATUSES", "PENDING_REFUND_STATUSES", "PENDING_COMPLAINT_STATUSES"]) {
    assert.equal(code.includes(name), false, `${name} 是 R6 删掉的那份重复定义，不得复活`);
  }

  // 反过来也要钉：三份定义确实**分别**在自己的领域文件里（少一处就等于没有）
  const declared = [
    ["lib/constants/adminApplications.ts", "OPEN_APPLICATION_STATUSES"],
    ["lib/constants/refunds.ts", "OPEN_REFUND_STATUSES"],
    ["lib/constants/complaints.ts", "OPEN_COMPLAINT_STATUSES"],
  ];
  for (const [file, name] of declared) {
    assert.ok(
      stripComments(readSource(resolveSource(file))).includes(name),
      `${name} 必须在 ${file} 里`,
    );
  }
});

// ————————————————————————— 五、服务接线 —————————————————————————

const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("complaint");
  resetMockStore("companionApplication");
  resetMockStore("dispatch");
  resetMockStore("adminAudit");
  resetMockStore("notification");
});

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回**今天的**一张真实订单。 */
async function placeOrderToday(overrides = {}) {
  const userId = unique("u-p11");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      ...overrides,
      idempotencyKey: unique("p11key"),
    },
    userId,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", userId);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return { order: confirmed.order, userId };
}

/**
 * 一张**今天支付、且已在护航中**的真实订单。
 *
 * ⚠️ 需要它是因为两条退款路径的**状态闸是互斥的**：
 * `paid` / `accepted` 只能走免审批的直接全额退款（`DIRECT_REFUNDABLE_ORDER_STATUSES`），
 * 而**提交退款申请**要求订单是 `serving` / `completed`（`REFUNDABLE_ORDER_STATUSES`）。
 * 因此「新提交的申请进待办」这条用例必须先真的把订单推到护航中，
 * 而不是伪造一张 `serving` 的单——那样验的就不是真实链路了。
 */
async function placeServingOrderToday(companionId = "cp-1") {
  const placed = await placeOrderToday();

  const dispatch = await getDispatchRepository().findDispatchByOrderId(placed.order.id);
  assert.ok(dispatch, "支付成功后必须有一条派单记录");

  const at = new Date().toISOString();
  const accepted = await acceptDispatch(dispatch.id, { companionId, at });
  assert.equal(accepted.kind, "ok", `接单失败：${JSON.stringify(accepted)}`);

  const started = await startCompanionOrder({ companionId, orderId: placed.order.id, at });
  assert.equal(started.kind, "ok", `开始服务失败：${JSON.stringify(started)}`);

  return placed;
}

test("经营 24：Mock 空数据注入把六个数字全清零，业务日照旧下发", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  // ⚠️ 先**自己造一单今天的订单**，让「非空基线」与进程启动时刻无关。
  //
  // 不能拿预置的排行榜订单当基线：它们的 `paidAt = completedAt − 320min`
  // （`orderSeed.ts` 的 `COMPLETION_LEAD_MINUTES`，且 `completedAt` 被钳在当天
  // 10:00 之前），因此**在北京时间 05:20 之前启动进程时，今天的预置订单恰好为 0**
  // ——那会让这条用例每天有约 22% 的运行时间必然变红，与代码对不对无关。
  await placeOrderToday();

  const params = new URLSearchParams("mockEmpty=dashboard");
  const empty = await getAdminDashboard(params, "server");

  assert.deepEqual(empty.metrics, { todayOrderCount: 0, todayGmvAmount: 0, todayRefundAmount: 0 });
  assert.deepEqual(empty.pending, { applications: 0, refunds: 0, complaints: 0 });
  // ⚠️ `businessDate` 不是数据，是「这是哪一天的空」，因此照旧给出
  assert.equal(empty.businessDate, beijingDateKey(new Date().toISOString()));

  // 注入关闭时同一批数据不得全 0（否则上面那条断言可能在「本来就是 0」时也成立，
  // 于是它什么也没证明）。刚支付成功的那一单就是这一格的非空基线。
  const real = await getAdminDashboard(undefined, "server");
  assert.ok(
    real.metrics.todayOrderCount > 0,
    "刚支付成功的订单必须计入今天，否则空数据注入的用例证明不了任何事",
  );
});

test("经营 25：DTO 的键精确固定——多一个字段就是一次未经审查的契约变更", async () => {
  const dto = await getAdminDashboard(undefined, "server");

  assert.deepEqual(Object.keys(dto).sort(), ["businessDate", "metrics", "pending"]);
  assert.deepEqual(Object.keys(dto.metrics).sort(), [
    "todayGmvAmount",
    "todayOrderCount",
    "todayRefundAmount",
  ]);
  assert.deepEqual(Object.keys(dto.pending).sort(), ["applications", "complaints", "refunds"]);

  // 业务日是 `YYYY-MM-DD`，六个数字都是非负整数（金额单位为分）
  assert.match(dto.businessDate, /^\d{4}-\d{2}-\d{2}$/);
  for (const [key, value] of Object.entries({ ...dto.metrics, ...dto.pending })) {
    assert.equal(Number.isInteger(value), true, `${key} 不是整数`);
    assert.ok(value >= 0, `${key} 为负`);
  }
});

test("经营 26：DTO 里没有订单对象、没有用户与游戏账号、没有备注与分账快照", async () => {
  const dto = await getAdminDashboard(undefined, "server");
  const payload = JSON.stringify(dto);

  for (const forbidden of [
    "userId",
    "gameAccountId",
    "remark",
    "companionRateSnapshot",
    "companionBaseIncome",
    "clubNetIncome",
    "platformNetIncome",
    "refundedAmount",
    "actualPaidAmount",
    "totalAmount",
    "phone",
    "password",
  ]) {
    assert.equal(payload.includes(`"${forbidden}"`), false, `DTO 泄漏了内部字段 ${forbidden}`);
  }

  // 也不返回任何集合：经营首页只有数字，明细在各自的列表页里
  assert.equal(Array.isArray(dto.metrics), false);
  assert.equal(Array.isArray(dto.pending), false);
});

test("经营 27：今天新支付一单，今日订单 +1 且 GMV 增加该单的实付金额", async () => {
  const before = await getAdminDashboard(undefined, "server");
  const { order } = await placeOrderToday();
  const after = await getAdminDashboard(undefined, "server");

  assert.equal(after.metrics.todayOrderCount, before.metrics.todayOrderCount + 1);
  assert.equal(after.metrics.todayGmvAmount, before.metrics.todayGmvAmount + order.actualPaidAmount);

  // 这一单是今天支付的：它自己必须落在业务日里，否则上面的 +1 是别的东西造成的
  assert.equal(beijingDateKey(order.paidAt), after.businessDate);
});

test("经营 28：直接全额退款后，今日退款金额增加该单实际退出去的钱", async () => {
  const { order, userId } = await placeOrderToday();
  const before = await getAdminDashboard(undefined, "server");

  const refunded = await directRefundOrderForUser(order.id, userId, undefined, "server");
  assert.equal(refunded.refundedAmount, order.actualPaidAmount);

  const after = await getAdminDashboard(undefined, "server");

  assert.equal(after.metrics.todayRefundAmount, before.metrics.todayRefundAmount + order.actualPaidAmount);

  // 直接退款**不写退款申请**（这正是它必须从订单侧被发现的原因），因此待处理退款不动
  assert.equal(after.pending.refunds, before.pending.refunds);
  // 而 GMV 不倒扣
  assert.equal(after.metrics.todayGmvAmount, before.metrics.todayGmvAmount);
});

test("经营 29：新提交的退款申请进「待处理退款」，新提交的投诉进「待处理投诉」", async () => {
  const before = await getAdminDashboard(undefined, "server");
  const { order, userId } = await placeServingOrderToday();

  await createRefundForOrder(
    order.id,
    userId,
    {
      reasonKey: "other",
      description: "临时有事，这一单打不了了，麻烦帮我退掉。",
      evidence: [],
      idempotencyKey: unique("p11key"),
    },
    undefined,
    "server",
  );

  const afterRefund = await getAdminDashboard(undefined, "server");
  assert.equal(afterRefund.pending.refunds, before.pending.refunds + 1);
  assert.equal(
    afterRefund.metrics.todayRefundAmount,
    before.metrics.todayRefundAmount,
    "只是提交申请，一分钱都还没退出去",
  );

  await createComplaintForUser(
    userId,
    {
      typeKey: "companion_service",
      description: "约好的时间打手迟到了四十分钟，也没有提前说明。",
      contact: "",
      evidence: [],
      orderId: order.id,
      idempotencyKey: unique("p11key"),
    },
    undefined,
    "server",
  );

  const afterComplaint = await getAdminDashboard(undefined, "server");
  assert.equal(afterComplaint.pending.complaints, before.pending.complaints + 1);
  assert.equal(afterComplaint.pending.refunds, afterRefund.pending.refunds, "两块互不干扰");
});

test("经营 30：待处理申请来自仓储的计数表，且口径是「仍未审完」", async () => {
  const dto = await getAdminDashboard(undefined, "server");
  const counts = await getCompanionApplicationRepository().countApplicationsByStatus();

  // 用预置 fixture 自己数一遍作为**独立口径**：不是拿实现的输出对实现的输出
  const expected = companionApplicationSeed.filter(
    (item) => item.status === "pending" || item.status === "reviewing",
  ).length;

  assert.equal(dto.pending.applications, expected);
  assert.equal(
    dto.pending.applications,
    counts.pending + counts.reviewing,
    "申请待办就是待审核 + 审核中",
  );
});

test("经营 31：Mock 故障注入让取数抛错——页面据此走错误态与重试", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  await assert.rejects(
    () => getAdminDashboard(new URLSearchParams("mockError=1"), "server"),
    (error) => {
      assert.equal(error.status, 500);
      return true;
    },
  );

  // `?mockError=api` 只让**浏览器端**的请求失败：服务端首屏照常渲染
  const serverSide = await getAdminDashboard(new URLSearchParams("mockError=api"), "server");
  assert.ok(serverSide.businessDate);
  await assert.rejects(
    () => getAdminDashboard(new URLSearchParams("mockError=api"), "http"),
    (error) => {
      assert.equal(error.status, 500);
      return true;
    },
  );
});

test("经营 32：待办数的口径是各领域的 OPEN_* 集合——用仓储全量独立数一遍对得上", async () => {
  const dto = await getAdminDashboard(undefined, "server");

  const refunds = await getRefundRepository().queryRefundsForAdmin({ statuses: null });
  const complaints = await getComplaintRepository().queryComplaintsForAdmin({
    statuses: null,
    type: null,
  });

  const openRefunds = refunds.filter((item) => refundStatusesForFilter("open").includes(item.status));
  const openComplaints = complaints.filter((item) => complaintStatusesForFilter("open").includes(item.status));

  // ⚠️ 退款这一条刻意是 `<=` 而不是 `===`：列表服务会**丢掉订单查不到的退款**
  // （`row.order !== undefined`），而首页取的就是列表的 `total`。数据被写坏时，
  // 卡片跟着列表一起少数几条才是对的——卡片该对的是「点进去能看到什么」，
  // 不是「仓储里躺着什么」。严格的相等断言在下面「卡片 == 列表」那一条（经营 43）。
  assert.ok(
    dto.pending.refunds <= openRefunds.length,
    `首页待办退款 ${dto.pending.refunds} 超过仓储里真实存在的 ${openRefunds.length} 条`,
  );
  assert.equal(dto.pending.complaints, openComplaints.length);

  // 反过来钉住「没有按状态预筛」：仓储返回的是全量，否则上面的数会退化成恒等式
  assert.ok(refunds.length >= dto.pending.refunds);
  assert.ok(complaints.length >= dto.pending.complaints);

  // 终态一条都不在待办里（这里是**仓储全量**上的一次独立复核）
  assert.equal(
    openRefunds.some((item) => ["approved", "rejected", "cancelled"].includes(item.status)),
    false,
  );
  assert.equal(
    openComplaints.some((item) => ["resolved", "closed"].includes(item.status)),
    false,
  );
});

// ————————————————————————— 六、页面与跳转（源码级） —————————————————————————

const PAGE = resolveSource("app/admin/page.tsx");
const BOARD = resolveSource("components/admin/AdminDashboardBoard.tsx");
const QUICK = resolveSource("components/admin/AdminQuickEntries.tsx");

test("经营 33：首页按「今日经营 → 当前待办 → 快捷入口 → 全量累计」四段渲染", () => {
  // 必须去掉 import：`ADMIN_OVERVIEW_CUMULATIVE_TITLE` 在文件顶部的 import 列表里也会出现，
  // 直接 indexOf 会把「引用了它」当成「渲染了它」，于是顺序断言变成一条恒真式
  const source = withoutImports(stripComments(readSource(PAGE)));

  const blocks = [
    source.indexOf("<AdminDashboardBoard"),
    source.indexOf("<AdminQuickEntries"),
    source.indexOf("ADMIN_OVERVIEW_CUMULATIVE_TITLE"),
  ];

  assert.ok(blocks.every((index) => index >= 0), "四段里有一段没渲染出来");
  assert.deepEqual(
    [...blocks].sort((a, b) => a - b),
    blocks,
    "四段的顺序变了：今日经营必须在最上面，全量累计在最后",
  );

  // 页面**不做计算**：金额与文案都来自常量与服务层
  assert.equal(source.includes("formatYuan"), false, "页面不得自己格式化金额");
  assert.equal(source.includes("今日 GMV"), false, "页面不得写死指标文案");
});

test("经营 34：首屏由服务端取数，不在浏览器里再取一次", () => {
  const page = stripComments(readSource(PAGE));

  assert.ok(page.includes("getAdminDashboard"), "首屏必须由 Server Component 直接取数");
  assert.ok(page.includes("initialDashboard"), "取好的快照必须传给客户端组件");
  assert.equal(page.includes("useEffect"), false, "首屏不得在挂载后再请求一次");

  const board = stripComments(readSource(BOARD));
  assert.equal(board.includes("useEffect"), false, "组件挂载时不得自动重新取数");
  assert.ok(board.includes("fetchAdminDashboard"), "局部重试要能重新取数");
});

test("经营 35：全 0 是正常首页，不整页空态；数字照常显示 0", () => {
  const board = stripComments(readSource(BOARD));

  assert.equal(board.includes("EmptyState"), false, "经营首页不得用整页空态");
  // 0 必须有话说明，否则看到一排 0 的人第一反应是「页面坏了」
  assert.ok(board.includes("今天还没有成交记录"), "缺少全 0 的说明");
  // 待办为 0 时卡片不许被隐藏：消失的卡片会被读成「这个模块没有」
  assert.equal(/pending\.applications\s*&&/.test(board), false, "待办卡不得按是否为 0 条件渲染");
});

test("经营 36：加载 / 错误 / 重试三态齐全", () => {
  const board = stripComments(readSource(BOARD));

  assert.ok(board.includes("加载中"), "缺少加载态");
  assert.ok(board.includes("role=\"alert\"") || board.includes("role='alert'"), "错误必须被读屏软件播报");
  assert.ok(board.includes("重试"), "失败后必须能重试");
  assert.ok(board.includes("disabled"), "请求进行中不得重复提交");
});

test("经营 37：每一个快捷入口都指向**真实存在**的管理模块与页面", () => {
  assert.ok(ADMIN_DASHBOARD_QUICK_ENTRIES.length > 0);

  const navHrefs = new Map(ADMIN_NAV_ITEMS.map((item) => [item.href, item]));

  for (const entry of ADMIN_DASHBOARD_QUICK_ENTRIES) {
    const navItem = navHrefs.get(entry.href);
    assert.ok(navItem, `快捷入口 ${entry.key} 的地址 ${entry.href} 不在侧栏导航里`);
    // 文案也来自导航：两份清单分叉的表现是「首页上的入口指向一个改名后的旧地址」
    assert.equal(entry.label, navItem.label, `${entry.key} 的标题与侧栏不一致`);
    assert.equal(entry.description, navItem.description, `${entry.key} 的说明与侧栏不一致`);

    // 真的有一个页面在：只有 href 而没有页面等于一个 404 入口
    const route = entry.href === "/admin" ? "admin/page.tsx" : `${entry.href.replace(/^\//, "")}/page.tsx`;
    assert.equal(hasAppFile(route), true, `${entry.href} 指向的页面不存在（${route}）`);
  }
});

test("经营 38：待办卡的筛选地址与列表页真实支持的查询参数一致", () => {
  // 拼错的参数不会报错，只会安静地给出一张空列表——那是「今天没有待办」的假象。
  //
  // ⚠️ 三个地址在 R6 之后**一律是 `status=open`**（不是 `pending`）：卡片上的数
  // 就是列表在 `open` 下的条数。写 `pending` 会让卡片 2 条、点进去 1 条，
  // 而 `open` 与 `all` 一样是列表**真实支持**的筛选值（它们在各领域常量文件的
  // 筛选联合里），因此这不是「拼了一个列表不认识的值」。
  for (const [key, href] of Object.entries(ADMIN_DASHBOARD_PENDING_HREFS)) {
    const url = new URL(href, "https://example.invalid");
    assert.equal(
      url.searchParams.get("status"),
      "open",
      `${key} 卡的跳转不是 open：卡片与列表立刻又会不等`,
    );
  }

  // ⚠️ 入驻申请那条还额外要求**地址由该模块自己的构造函数生成**：本文件里不手写
  // `/admin/applications?...`，避免「改了模块的地址规则、首页不知道」。
  assert.equal(
    ADMIN_DASHBOARD_PENDING_HREFS.applications,
    ADMIN_APPLICATION_LIST_HREF("open"),
    "入驻申请卡的地址必须来自 adminApplications 模块自己的构造函数",
  );

  for (const href of Object.values(ADMIN_DASHBOARD_PENDING_HREFS)) {
    const route = `${href.split("?")[0].replace(/^\//, "")}/page.tsx`;
    assert.equal(hasAppFile(route), true, `${href} 指向的页面不存在（${route}）`);
  }

  // 今日订单卡按同一天的 from / to 筛选：列表的日期就是北京时间自然日，
  // 与 DTO 下发的 businessDate 同一个口径，因此卡上的数与列表条数对得上
  assert.equal(ADMIN_DASHBOARD_TODAY_ORDERS_HREF("2026-09-27"), "/admin/orders?from=2026-09-27&to=2026-09-27");
  assert.equal(hasAppFile("admin/orders/page.tsx"), true);

  // 今日退款卡：退款列表**没有日期维度**，只能链到模块本身，但必须显式落到 `all`——
  // 该页默认筛选是 `pending`（待审核的申请），而这张卡说的是「今天已经退出去多少钱」，
  // 落到「待审核」上毫无意义。
  //
  // ⚠️ 这里不比对字符串常量，而是**从地址里把 status 解出来，喂给列表页自己的解析函数**：
  // 常量表与地址栏各写一遍 `"all"` 是两份实现，改了一处另一处不会报错，
  // 只会让这张卡悄悄跳到一个 400 上。
  const refundsUrl = new URL(ADMIN_DASHBOARD_REFUNDS_HREF, "https://example.invalid");
  assert.equal(refundsUrl.pathname, "/admin/refunds");
  assert.equal(
    isAdminRefundStatusFilter(refundsUrl.searchParams.get("status") ?? ""),
    true,
    "今日退款卡必须带一个退款列表真实支持的 status",
  );
  assert.notEqual(
    readAdminRefundStatusFilter(refundsUrl.searchParams.get("status")),
    DEFAULT_ADMIN_REFUND_STATUS_FILTER,
    "退款列表默认筛的是「待审核申请」，一张「今天已退出去多少钱」的卡不能落到它上面",
  );
  assert.equal(hasAppFile("admin/refunds/page.tsx"), true);
});

test("经营 39：首页只读——没有任何会改数据的动作", () => {
  for (const [name, source] of [
    ["经营首页", readSource(PAGE)],
    ["今日经营与当前待办", readSource(BOARD)],
    ["快捷入口", readSource(QUICK)],
  ]) {
    const code = stripComments(source);
    for (const forbidden of ["method: \"POST\"", "method: \"PATCH\"", "method: \"DELETE\"", "fetch(", "/api/admin/"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${name}出现了 ${forbidden}：经营首页不做审批、退款、换人、改状态`,
      );
    }
  }

  // 页面组件不碰 Mock 层（调试参数在服务层处理）——与 `app/admin/**` 的既有分层规则一致
  assert.equal(stripComments(readSource(PAGE)).includes("lib/mocks"), false);
});

// ————————————————————————— 七、HTTP 权限 —————————————————————————

const BASE = process.env.APP_BASE_URL;

// ⚠️ 必须在**发起任何请求之前**执行——这一行加上 --test-concurrency=1，才是「本文件的断言读到的是预置状态」的保证。
await resetServerStores();
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过经营首页 HTTP 用例";

/** 四种非管理端身份的 Cookie：用户 / 打手（也是用户身份的一个人）/ 客服。 */
const NON_ADMIN_COOKIES = [
  ["匿名", ""],
  ["普通用户", "mock_user_id=u-1001"],
  ["打手", "mock_user_id=u-1022"],
  ["客服", "mock_staff_id=staff-1"],
];

async function requestJson(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应（页面重定向等）留给断言去判
  }
  return { status: response.status, text, json };
}

test("经营 40：经营首页接口对匿名 / 用户 / 打手 / 客服一律 401，只有管理员能取数", { skip: SKIP_HTTP }, async () => {
  // ⚠️ 这四条与模拟登录开关无关：用户 / 客服的 Cookie 在任何开关下都换不来管理端身份
  for (const [label, cookie] of NON_ADMIN_COOKIES) {
    const { status, json } = await requestJson("/api/admin/dashboard", cookie);
    assert.equal(status, 401, `${label}拿到了经营数据`);
    assert.equal(json?.error?.code, "UNAUTHORIZED");
  }

  // 管理端账号存在但角色不是 admin（客服 / 护航 / 已停用）→ 403，而不是 401。
  // ⚠️ 这一段要求服务端开着 `ENABLE_MOCK_ADMIN`（管理端身份体系不存在时，
  // 伪造的管理端 Cookie 只会被当成匿名，那是 401 而不是 403）
  const login = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  if (login.status !== 200) return;

  for (const adminId of ["admin-2", "admin-3", "admin-4"]) {
    const { status, json } = await requestJson("/api/admin/dashboard", `mock_admin_id=${adminId}`);
    assert.equal(status, 403, `${adminId} 不该进得来`);
    assert.equal(json?.error?.code, "FORBIDDEN");
  }

  // 正例放在最后：上面全是拒绝，没有这一条就无法排除「所有身份都被拒」这种平凡通过
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
  const accepted = await requestJson("/api/admin/dashboard", cookie);
  assert.equal(accepted.status, 200, "管理员必须取得到经营数据");
});

test("经营 41：管理员登录后接口与页面都给出同一份数字", { skip: SKIP_HTTP }, async () => {
  const login = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  if (login.status !== 200) return; // 未开启 ENABLE_MOCK_ADMIN，跳过
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
  assert.ok(cookie, "模拟登录必须下发 Cookie");

  const { status, json } = await requestJson("/api/admin/dashboard", cookie);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json.data).sort(), ["businessDate", "metrics", "pending"]);

  // 接口给出的业务日必须是**今天**（服务端按北京时间算，浏览器不参与）
  assert.equal(json.data.businessDate, beijingDateKey(new Date().toISOString()));

  // 页面与接口共用同一个服务，因此页面 HTML 里必须出现同一个业务日
  const page = await fetch(new URL("/admin", BASE), { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(json.data.businessDate), "页面上的业务日与接口不一致");
  assert.ok(html.includes("今日经营"));
  assert.ok(html.includes("当前待办"));
  assert.ok(html.includes("申请与护航规模（全量累计）"), "全量累计那一段必须有「全量累计」限定词");
});

test("经营 42：经营首页接口是只读的，其它动词不存在", { skip: SKIP_HTTP }, async () => {
  const login = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  if (login.status !== 200) return;
  const cookie = login.headers.getSetCookie()[0]?.split(";")[0];

  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const response = await fetch(new URL("/api/admin/dashboard", BASE), {
      method,
      headers: { cookie },
    });
    assert.ok(
      response.status === 405 || response.status === 404,
      `${method} 不该被接受（得到 ${response.status}）`,
    );
  }
});

// ————————————————————— 八、R6：卡片与列表同源（P1-1 §六） —————————————————————
//
// 这一节是 R6 裁定的**主断言**。前面那一节（四）钉的是「口径只有一份定义」，
// 属于**结构**上的保证；这里钉的是**行为**上的结果：拿卡片上的地址真的走一遍
// 列表服务，看它给出的 `total` 是不是卡片上那个数。
//
// ⚠️ 为什么两条都要有：只钉结构（「集合只有一份」）挡不住「列表服务在解析出
// 状态集合之后又按别的条件丢了一批」；只钉行为（「数对得上」）挡不住有人为了
// 让数对上而在两处各写一份定义、恰好当下相等。结构 + 行为，缺一不可。

/** 把卡片地址还原成查询参数——**从链接出发**，不是照抄服务层的查询构造。 */
function pendingHrefParams(key) {
  return new URL(ADMIN_DASHBOARD_PENDING_HREFS[key], "https://example.invalid").searchParams;
}

/**
 * 点了那张卡之后，列表页自己会算出多少条。
 *
 * 这条链子有四环：地址 → 该领域的状态解析器 → 查询构造 → 列表服务。
 * 中间任何一环把 `open` 丢掉（例如解析器不认识它而回落到默认值 `pending`），
 * 结果就不再等于卡片上的数，本函数随之返回一个较小的数。
 *
 * ⚠️ 用的都是**页面侧**走的那几个函数（`read*` / `build*` / `query*`），
 * 因此它测的就是「点进去」这件事本身，不是对服务层实现的复述。
 */
async function listTotalForPendingCard(key) {
  const params = pendingHrefParams(key);

  if (key === "applications") {
    const status = readAdminApplicationStatusFilter(params.get("status"));
    assert.ok(status, "入驻申请列表不认识卡片地址上的 status");
    const data = await queryAdminApplicationList(
      buildAdminApplicationListQuery({ params, status, gameId: "" }),
      undefined,
      "server",
    );
    return data.total;
  }

  if (key === "refunds") {
    const status = readAdminRefundStatusFilter(params.get("status"));
    assert.ok(status, "退款列表不认识卡片地址上的 status");
    const data = await queryAdminRefundList(
      buildAdminRefundListQuery({ params, status }),
      undefined,
      "server",
    );
    return data.total;
  }

  const status = readAdminComplaintStatusFilter(params.get("status"));
  assert.ok(status, "投诉列表不认识卡片地址上的 status");
  const data = await queryAdminComplaintList(
    buildAdminComplaintListQuery({ params, status, type: "all" }),
    undefined,
    "server",
  );
  return data.total;
}

test("经营 43：卡片上的待办数 == 点进去的列表条数", async () => {
  const dto = await getAdminDashboard(undefined, "server");

  for (const key of ["applications", "refunds", "complaints"]) {
    const total = await listTotalForPendingCard(key);

    assert.equal(
      dto.pending[key],
      total,
      `${key}：卡片上写着 ${dto.pending[key]}，点进去却只有 ${total} 条`,
    );
  }

  // ⚠️ 光有相等还不够：「open 恰好就是 pending」在只有 pending 的数据上同样相等。
  // 预置数据里入驻申请与投诉**都**同时有「待审核」和「审核中 / 处理中」的记录
  // （申请 1 pending + 1 reviewing，投诉 1 pending + 2 processing），
  // 因此在这里要求 `open` 严格多于单状态 `pending`：这条一旦不成立，
  // 就说明 open 没有被解析成集合，而是被当成了某一个状态。
  for (const key of ["applications", "complaints"]) {
    const openTotal = await listTotalForPendingCard(key);
    const pendingTotal = await singleStatusTotal(key, "pending");

    assert.ok(
      openTotal > pendingTotal,
      `${key}：open(${openTotal}) 与 pending(${pendingTotal}) 一样多，open 没被解析成「未终结」集合`,
    );
  }
});

/**
 * 某一个**单状态**下的列表条数（走单状态那条路，不经过 `open`）。
 *
 * 用来当对照组：`open` 必须比它宽。若两者相等，说明 `open` 被当成了某一个状态。
 */
async function singleStatusTotal(key, status) {
  const params = new URLSearchParams(`status=${status}`);

  if (key === "applications") {
    return (
      await queryAdminApplicationList(
        buildAdminApplicationListQuery({ params, status, gameId: "" }),
        undefined,
        "server",
      )
    ).total;
  }

  if (key === "refunds") {
    return (
      await queryAdminRefundList(buildAdminRefundListQuery({ params, status }), undefined, "server")
    ).total;
  }

  return (
    await queryAdminComplaintList(
      buildAdminComplaintListQuery({ params, status, type: "all" }),
      undefined,
      "server",
    )
  ).total;
}

test("经营 44：新来一条待办时卡片与列表同时 +1；**审核中**的那条两边都必须算上", async () => {
  // ⚠️ 经营 43 若两边恰好都是 0 或都只有 pending，它也是通过的。这一条用**增量**
  // 并且**跨过 pending 那一档**来排除平凡通过：把一条退款从「待审核」推进到
  // 「审核中」——它仍在待办里，但不再属于单状态 `pending`。
  const before = await getAdminDashboard(undefined, "server");
  const beforePending = await singleStatusTotal("refunds", "pending");

  const { order, userId } = await placeServingOrderToday();
  const created = await createRefundForOrder(
    order.id,
    userId,
    {
      reasonKey: "other",
      description: "临时有事，这一单打不了了，麻烦帮我退掉。",
      evidence: [],
      idempotencyKey: unique("p11key"),
    },
    undefined,
    "server",
  );

  const afterCreate = await getAdminDashboard(undefined, "server");
  assert.equal(afterCreate.pending.refunds, before.pending.refunds + 1, "卡片没有跟着 +1");
  assert.equal(
    await singleStatusTotal("refunds", "pending"),
    beforePending + 1,
    "列表没有跟着 +1",
  );

  // 推进到「审核中」：仍是未终结，但已经不在 pending 那一档里
  await startReviewAdminRefund(created.refundId, "admin-1", { idempotencyKey: unique("p11key") });

  const afterReview = await getAdminDashboard(undefined, "server");
  const openTotal = await listTotalForPendingCard("refunds");
  const pendingTotal = await singleStatusTotal("refunds", "pending");

  assert.equal(afterReview.pending.refunds, afterCreate.pending.refunds, "审核中仍然是待办，卡片不该掉");
  assert.equal(openTotal, afterReview.pending.refunds, "卡片与 open 列表对不上");
  assert.equal(pendingTotal, beforePending, "「待审核」那一档不该多出这条审核中的");

  // ⚠️ 决定性的一条：`open` 与 `pending` 必须是**两个不同的数**。
  // 若有人把 `open` 实现成「就是 pending」（漏了 reviewing，或解析时回落到默认值），
  // 上面每一条断言仍然全部通过，只有这一条会失败。
  assert.ok(
    openTotal > pendingTotal,
    `open 与 pending 数出来一样多（都是 ${openTotal}）：open 没有被解析成「未终结」集合`,
  );
});

test("经营 45：单状态筛选继续兼容，且与 open 不等价", async () => {
  // R6 加的是**多一个值**，不是把原来的值换掉：`status=pending` 只能筛出待审核，
  // 不能偷偷变成「待审核 + 审核中」——那会让运维手里的每一条历史链接都改了含义。
  for (const [key, single, open] of [
    ["refunds", "pending", "open"],
    ["complaints", "pending", "open"],
  ]) {
    const params = (status) =>
      key === "refunds"
        ? buildAdminRefundListQuery({
            params: new URLSearchParams(`status=${status}`),
            status: readAdminRefundStatusFilter(status),
          })
        : buildAdminComplaintListQuery({
            params: new URLSearchParams(`status=${status}`),
            status: readAdminComplaintStatusFilter(status),
            type: "all",
          });

    // ⚠️ 按 `key` 选**本域**的解析函数：这一行曾经固定调 `refundStatusesForFilter`，
    // 于是 `complaints` 那一轮也在断言退款域的解析结果——不是恒真断言，但把「投诉单
    // 状态解析」这个事实挂在了退款域函数上：退款域一旦被改坏，报错会以「投诉测试失败」
    // 的名义出现，而读测试的人会以为投诉域的解析由本条覆盖（实际覆盖它的是经营 20）。
    const statusesForFilter = key === "refunds" ? refundStatusesForFilter : complaintStatusesForFilter;
    assert.deepEqual(
      [...statusesForFilter(single)],
      ["pending"],
      `${key} 的单状态筛选退化成了别的集合`,
    );

    const singleData =
      key === "refunds"
        ? await queryAdminRefundList(params(single), undefined, "server")
        : await queryAdminComplaintList(params(single), undefined, "server");
    const openData =
      key === "refunds"
        ? await queryAdminRefundList(params(open), undefined, "server")
        : await queryAdminComplaintList(params(open), undefined, "server");

    // 每一条都真的落在单状态上——不是「碰巧这个 fixture 里没有别的状态」
    for (const item of singleData.items) {
      assert.equal(item.status, "pending", `${key} 的 status=pending 里混进了 ${item.status}`);
    }
    // 每一条都落在该领域的未终结集合里
    const openSet = key === "refunds" ? OPEN_REFUND_STATUSES : OPEN_COMPLAINT_STATUSES;
    for (const item of openData.items) {
      assert.ok(openSet.includes(item.status), `${key} 的 status=open 里混进了终态 ${item.status}`);
    }
    // open 是**更宽**的一条：它至少能装下 pending 筛出来的那些
    assert.ok(openData.total >= singleData.total, `${key} 的 open 比 pending 还窄，说明解析错了`);
  }
});

test("经营 46：open 与关键词、分页可以叠加，且不改变「未终结」这个前提", async () => {
  // 分页：`total` 是**分页前**的全量条数（列表服务的既有语义），翻页不该改变它
  const page1 = await queryAdminComplaintList(
    buildAdminComplaintListQuery({
      params: new URLSearchParams("status=open&page=1"),
      status: readAdminComplaintStatusFilter("open"),
      type: "all",
    }),
    undefined,
    "server",
  );
  const page2 = await queryAdminComplaintList(
    buildAdminComplaintListQuery({
      params: new URLSearchParams("status=open&page=2"),
      status: readAdminComplaintStatusFilter("open"),
      type: "all",
    }),
    undefined,
    "server",
  );

  assert.equal(page1.page, 1);
  assert.equal(page2.page, 2);
  assert.equal(page2.total, page1.total, "total 必须是分页前的全量条数，翻页不该改变它");
  assert.equal(page2.total, await listTotalForPendingCard("complaints"), "翻页把卡片对不上了");

  // 关键词：叠加之后**只可能更窄**，而且筛出来的每一条仍然是未终结的
  const keyword = page1.items[0]?.complaintNo ?? "";
  if (!keyword) return; // 预置数据里一条待处理投诉都没有，关键词这一半无从谈起

  const searched = await queryAdminComplaintList(
    buildAdminComplaintListQuery({
      params: new URLSearchParams(`status=open&keyword=${encodeURIComponent(keyword)}`),
      status: readAdminComplaintStatusFilter("open"),
      type: "all",
    }),
    undefined,
    "server",
  );

  assert.ok(searched.total >= 1, "按列表里第一条自己的编号搜，至少得搜到它自己");
  assert.ok(searched.total <= page1.total, "叠了关键词反而变多，说明 open 被丢掉了");
  for (const item of searched.items) {
    assert.ok(
      OPEN_COMPLAINT_STATUSES.includes(item.status),
      `关键词 + open 的返回里混进了终态 ${item.status}`,
    );
  }
});

test("经营 47：all 与 open 的区别就是「要不要终态」", async () => {
  const open = await queryAdminRefundList(
    buildAdminRefundListQuery({
      params: new URLSearchParams("status=open&pageSize=100"),
      status: readAdminRefundStatusFilter("open"),
    }),
    undefined,
    "server",
  );
  const all = await queryAdminRefundList(
    buildAdminRefundListQuery({
      params: new URLSearchParams("status=all&pageSize=100"),
      status: readAdminRefundStatusFilter("all"),
    }),
    undefined,
    "server",
  );

  assert.ok(all.total >= open.total, "all 是不过滤状态的那一份，不可能比 open 少");
  assert.equal(
    open.items.some((item) => OPEN_REFUND_STATUSES.includes(item.status)),
    open.total > 0,
    "open 那一份里出现终态（或该有却没有未终结的记录）",
  );

  // `all` 确实能捞出 open 捞不到的终态——否则「区别是终态」这句话无从验证
  const terminal = all.items.filter((item) => item.status === "approved" || item.status === "rejected");
  if (terminal.length > 0) {
    assert.equal(
      open.items.some((item) => item.id === terminal[0].id),
      false,
      "终态的退款出现在 open 里了",
    );
  }
});
