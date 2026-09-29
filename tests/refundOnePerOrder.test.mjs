import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError } from "../lib/api/ApiError.ts";
import { isOrderChatClosed } from "../lib/constants/conversations.ts";
import { resolveOrderMoneyDomain } from "../lib/constants/orderAmount.ts";
import {
  DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE,
  REFUND_ALREADY_EXISTS_MESSAGE,
  hasRefundBeenExecuted,
  isRefundExecutionClosed,
  platformNetIncome,
} from "../lib/constants/refunds.ts";
import { resolveCompanionDisplayStatus } from "../lib/constants/orders.ts";
import { MESSAGE_ORDER_REFUNDED_MESSAGE } from "../lib/constants/service.ts";
import { approveRefund } from "../lib/data/adminRefundTransaction.ts";
import { releaseOrderByStaff } from "../lib/data/companionOrderTransaction.ts";
import { sweepExpiredDispatches } from "../lib/data/companionDispatchTransaction.ts";
import { settleOrderCompletion } from "../lib/data/earningTransaction.ts";
import { getEarningRepository } from "../lib/data/earningRepository.ts";
import { createDispatchRecord, dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { notificationStore } from "../lib/data/mockNotificationRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { getCompanionOrderDetail, listCompanionOrders } from "../lib/services/companionOrders.ts";
import { sendMessageForUser } from "../lib/services/conversations.ts";
import {
  buildRefundActions,
  createRefundForOrder,
  directRefundOrderForUser,
} from "../lib/services/refunds.ts";

/**
 * P0-15「一个订单最多一次退款」的回归保护（产品裁定 2026-09-28）。
 *
 * ## 这个文件守什么
 *
 * 它守的不是「某个函数返回什么」，而是八条**业务不变量**（编号见下）。每一条都用
 * 真实的仓储 / 伪事务跑完整链路（下单 → 结算 → 申请 → 审批 → 读回），
 * 不测中间量、不断言内部调用次数。
 *
 * 1. 一个订单最多一次退款申请、最多一次实际退款执行——提交过就封死；
 * 2. `refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`；100% ⇒ 全额；
 * 3. 退款批准后该订单打手**净收益恒为 0**（10% / 50% / 100% 一样）：
 *    `Earning.incomeAmount` 是历史快照、永不改写，冲回走恰好一条 `EarningAdjustment`；
 * 4. 平台最终收入 = `actualPaidAmount − refundAmount`；
 * 5. 责任模型整体废止：新写入路径不得再依赖 `responsibility` /
 *    `companionLiabilityRateBp` / `platformBorneAmount` / `refundFullRemaining`；
 * 6. 订单状态与打手展示状态分离：部分退款不改 `Order.status`，只有 100% 才 `refunded`；
 * 7. 不设计 withdrawn 追偿（本文件不引入任何钱包 / 负余额断言）；
 * 8. 批准必须幂等：同一幂等键重复批准不得产生第二次真实退款、第二条 `EarningAdjustment`。
 *
 * ## 金额从哪来
 *
 * 所有期望金额都由**订单自己的冻结快照**独立算出（`resolveOrderMoneyDomain` 建单、
 * 测试里手算期望值），不从被测代码里抄中间量。商品单价刻意取非整数百分比能整除的
 * 数（如 3333 的 10% = 333.3），这样「取整方向」写错时断言会红。
 *
 * ## 一条前置说明
 *
 * 「退款申请」在 #1–#3 里走**服务层**（`createRefundForOrder`，连窗口与表单规则一起验），
 * 在 #4–#19 里走**仓储**（`createRefundRequest`）——那些用例的主体是审批与资金，
 * 申请只是它们的夹具。两条都是真实写入路径，不是替身。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 审批上下文里的管理员。`actorRole` 必须与 `ActorRole` 一致（admin / staff）。 */
const ADMIN_ID = "adm-p015";

/** 同一毫秒内并发调用时也要拿到互不相同的串，因此带上 pid 与自增序号。 */
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

/**
 * 幂等键必须满足 `/^[A-Za-z0-9_-]{8,64}$/`（`lib/constants/writes.ts`）。
 * `uniq("key")` 形如 `key-1234-1`，长度与字符集都合法。
 */
function uniqKey() {
  return uniq("p015key");
}

function writeContext(operationId, at = "2026-09-28T10:00:00.000Z") {
  return { actorId: ADMIN_ID, actorRole: "admin", actorName: null, operationId, at };
}

/**
 * 造一张 `serving` 订单并放进**真实**的支付/订单 store。
 *
 * 金额域走全站唯一的公式（`resolveOrderMoneyDomain`），不手写数字——
 * 手写的常量一旦与公式不一致，用例验的就只是种子里的一个巧合。
 */
function seedServingOrder({ unitPrice, quantity = 1, companionRateBp = 8000 }) {
  const orderId = uniq("ord-p015");
  const userId = uniq("u-p015");
  const companionId = uniq("cp-p015");
  const itemsAmount = unitPrice * quantity;

  const money = resolveOrderMoneyDomain({
    itemsAmount,
    addonsAmount: 0,
    companionRateBp,
    couponDiscountAmount: 0,
  });

  const paidAt = "2026-09-20T02:00:00.000Z";
  const order = {
    id: orderId,
    orderNo: `YM${orderId}`,
    userId,
    status: "serving",
    createdAt: paidAt,
    paidAt,
    acceptedAt: "2026-09-20T02:25:00.000Z",
    servingAt: "2026-09-20T03:00:00.000Z",
    completedAt: null,
    refundedAt: null,

    productId: "p-p015",
    productTitle: "P0-15 用例商品",
    productCoverUrl: "/mock/product-cover-1.svg",
    specId: "s-p015",
    specName: "P0-15 用例规格",
    unitPrice,
    quantity,

    gameName: "无畏契约",
    region: "端游",
    gameAccountId: "acct-p015",
    remark: "",
    addons: [],

    itemsAmount,
    addonsAmount: 0,
    totalAmount: itemsAmount,

    ...money,
    refundedAmount: 0,

    actualCompanionId: companionId,
    companion: { id: companionId, name: "P0-15 用例打手", avatarUrl: "" },

    complaintWindowMinutesSnapshot: null,
    complaintDeadlineAt: null,
  };

  paymentStore().orders.set(order.id, order);
  return order;
}

/**
 * 把订单结算成 `completed` 并生成真实的 `Earning`（走 `settleOrderCompletion`，
 * 与正式完成路径同一个入口）。
 *
 * ⚠️ `at` 取**此刻**：`complaintDeadlineAt = completedAt + 投诉窗口`，
 * 而投诉窗口默认 1440 分钟。用 2026-09 的固定时刻结算会让窗口在「今天」就已经关闭，
 * 于是服务层的申请入口（`createRefundForOrder`）会在窗口那一道闸上先失败——
 * 那与 P0-15 要验的规则无关，却会让用例红得莫名其妙。
 */
function settleIntoServingOrderCompleted(opts) {
  const order = seedServingOrder(opts);
  const settled = settleOrderCompletion({ orderId: order.id, at: new Date().toISOString() });
  assert.ok(settled, `结算应当返回订单与收益：${order.id}`);
  assert.ok(settled.earning, `completed 订单应当生成收益记录：${order.id}`);
  return { order: settled.order, earning: settled.earning };
}

function makePendingRefund(order) {
  const at = "2026-09-28T09:00:00.000Z";
  return {
    id: uniq("rf-p015"),
    refundNo: `RF${order.orderNo}`,
    userId: order.userId,
    orderId: order.id,
    status: "pending",
    amount: order.actualPaidAmount,
    decision: null,
    reasonKey: "other",
    reasonLabel: "其他原因",
    description: "P0-15 用例：退款申请夹具",
    evidence: [],
    createdAt: at,
    updatedAt: at,
    reviewingAt: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewedByRole: null,
    reviewedByName: null,
    reviewNote: "",
    cancelledAt: null,
  };
}

/** 用**仓储**写入一条待审核申请（夹具）。 */
async function openRefundRequest(order) {
  const outcome = await getRefundRepository().createRefundRequest(
    makePendingRefund(order),
    uniqKey(),
  );
  assert.equal(outcome.ok, true, `第一次创建退款申请应当成功，实际：${JSON.stringify(outcome)}`);
  return outcome.refund;
}

/** 用**服务层**写入一条待审核申请（连窗口 / 表单 / 状态闸一起验）。 */
async function openRefundRequestViaService(order) {
  return createRefundForOrder(
    order.id,
    order.userId,
    { idempotencyKey: uniqKey(), reasonKey: "other", description: "P0-15 用例：服务层申请" },
    undefined,
    "server",
  );
}

async function approveOnce(refundId, refundRateBp, operationId) {
  const outcome = await approveRefund(
    refundId,
    "",
    { refundRateBp },
    writeContext(operationId),
  );
  assert.equal(
    outcome.kind,
    "ok",
    `批准退款（${refundRateBp}bp）应当成功，实际：${JSON.stringify(outcome)}`,
  );
  return outcome;
}

function orderNow(orderId) {
  return paymentStore().orders.get(orderId);
}

/** 这一单名下的通知条数——用来验「没有退款就没有退款通知」。 */
function countNotificationsFor(orderId) {
  return [...notificationStore().notifications.values()].filter((n) => n.orderId === orderId).length;
}

/** 一个「已结算 + 已批准退款」的完整场景，供 #4–#19 复用。 */
async function refundedScenario({ unitPrice, refundRateBp, quantity = 1, deferApproval = false }) {
  const { order, earning } = settleIntoServingOrderCompleted({ unitPrice, quantity });
  const refund = await openRefundRequest(order);
  if (!deferApproval) await approveOnce(refund.id, refundRateBp, uniq("op-p015"));
  const refreshed = await getRefundRepository().findRefundById(refund.id);
  return {
    order,
    earning,
    refund,
    companionId: order.actualCompanionId,
    decision: refreshed.decision,
    orderAfter: orderNow(order.id),
    earningAfter: await getEarningRepository().findEarningByOrderId(order.id),
  };
}

beforeEach(() => {
  // 每条用例都从「预置数据 + 空运行时数据」出发，不依赖执行顺序。
  // 每个 store 各清一次：payment / refund 会重新灌种子，其余本就是空的。
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("earning");
  resetMockStore("adminAudit");
  resetMockStore("dispatch");
  resetMockStore("message");
  resetMockStore("notification");
  resetMockStore("companionRelease");
  resetMockStore("platformConfig");
});

// ═══════════════════════ 规则 1：一个订单最多一次申请 ═══════════════════════

test("规则1（1/3）：仓储层第二次创建退款申请被拒（order_already_has_refund）", async () => {
  const order = seedServingOrder({ unitPrice: 4590 });

  const first = await getRefundRepository().createRefundRequest(makePendingRefund(order), uniqKey());
  assert.equal(first.ok, true, "第一次创建应当成功");
  assert.equal(first.created, true, "第一次创建必须是真的新建（不是幂等命中）");

  const second = await getRefundRepository().createRefundRequest(
    makePendingRefund(order),
    uniqKey(),
  );

  assert.equal(
    second.ok,
    false,
    "规则1：同一订单的第二次申请必须被仓储拒绝，但实际写进去了",
  );
  assert.equal(second.reason, "order_already_has_refund", "失败原因必须能区分「已提交过」");
  assert.equal(
    second.existing.id,
    first.refund.id,
    "被拒时必须把已存在的那一条带回来，调用方才说得清「是哪一条挡住了」",
  );

  const records = await getRefundRepository().listRefundsByOrderId(order.id);
  assert.equal(records.length, 1, `规则1：存储里应当只有 1 条申请，实际 ${records.length} 条`);
});

test("规则1（2/3）：服务层第二次申请被拒，且存储里仍然只有一条记录", async () => {
  const order = settleIntoServingOrderCompleted({ unitPrice: 4590 }).order;

  const first = await openRefundRequestViaService(order);
  assert.equal(first.created, true, "服务层第一次申请应当真的新建");

  await assert.rejects(
    () => openRefundRequestViaService(order),
    (error) => {
      assert.ok(error instanceof ApiError, "服务层拒绝必须是 ApiError（→ HTTP 400）");
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(
        error.message,
        REFUND_ALREADY_EXISTS_MESSAGE,
        "规则1：文案必须是「已提交过退款申请」，不是「当前不可退款」——后者会让用户以为等等还能退",
      );
      return true;
    },
    "规则1：第二次申请必须被服务层拒绝",
  );

  const records = await getRefundRepository().listRefundsByOrderId(order.id);
  assert.equal(records.length, 1, `规则1：存储里应当只有 1 条申请，实际 ${records.length} 条`);
});

test("规则1（3/3）：退款已执行之后再申请同样被拒（部分退款，订单档位本身仍可退）", async () => {
  const { order, refund } = await refundedScenario({ unitPrice: 4590, refundRateBp: 1000 });

  const after = orderNow(order.id);
  // 前置条件：这张单在 P0-15 的旧口径下**仍然可以退**（serving/completed），
  // 因此下面那次拒绝只可能来自「已经提交过」这条规则，不可能来自「订单不可退」。
  assert.equal(after.status, "completed", "部分退款不得改订单状态（前置条件）");
  assert.ok(after.refundedAmount > 0, "前置条件：这次退款确实执行过");
  assert.equal(after.refundedAmount, 459, "前置条件：10% × 4590 = 459");

  await assert.rejects(
    () => openRefundRequestViaService(order),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(
        error.message,
        REFUND_ALREADY_EXISTS_MESSAGE,
        "规则1：退款执行过之后，再次申请必须报「已提交过」（而不是「当前不可退款」）",
      );
      return true;
    },
  );

  const records = await getRefundRepository().listRefundsByOrderId(order.id);
  assert.equal(
    records.length,
    1,
    `规则1：退款执行后仍然只能有一条记录，实际 ${records.length} 条（第 ${JSON.stringify(records.map((r) => r.id))}）`,
  );
  assert.equal(records[0].id, refund.id, "留在存储里的必须还是原来那一条");
});

// ═══════════ 规则 1（执行侧）：一单一退在三条出款路径上都成立 ═══════════

/**
 * 这一组用例针对的是交付前审查里的 **MAJOR-1**：
 *
 * > 规则 1 原先只在**申请侧**封死（「有记录就不许再申请」），
 * > 而 ①§一 要求的是「最多**一次实际退款执行**」、①§八 要求的是
 * > 「Repository / transaction 层必须有硬约束」。两者不是同一件事：
 * > 一张单完全可能**已经有申请记录、又出过一次款**，于是申请侧再没有入口，
 * > 但**执行侧**还开着两条（直接退款 / 公共池超时）。
 *
 * 可达路径（逐步核实过，不是假想）：
 *
 * ```
 * serving 单被批准部分退款（第 1 次出款；部分退款**不改状态**，订单仍是 serving）
 *   → 客服把它退回公共池（P0-11，`serving → paid`；回池不碰 refundedAmount）
 *   → 此时订单是 paid ⇒ `canDirectRefund("paid")` 为真、公共池到点也会命中它
 *   → 第 2 次出款
 * ```
 *
 * 判据是 `hasRefundBeenExecuted`（**出过款**，而不是**退满**）——「退满」在
 * 部分退款上不成立，挡不住这条路径。下面每条闸都配一个**正例**：
 * 「没出过款的同一场景必须照旧放行」，否则「被挡住」可能只是因为别的地方坏了。
 */

/** 造一条派单记录，直接放进真实 store（`createDispatchRecord` 是唯一入口）。 */
function seedDispatchRecord(order, overrides) {
  const at = "2026-09-20T02:00:00.000Z";
  return createDispatchRecord({
    id: uniq("dp-p015"),
    orderId: order.id,
    state: "accepted",
    exclusiveCompanionId: order.actualCompanionId,
    exclusiveEnteredAt: at,
    exclusiveDeadlineAt: "2026-09-20T02:10:00.000Z",
    exclusiveTimeoutMinutesSnapshot: 10,
    publicPoolEnteredAt: null,
    publicDeadlineAt: null,
    publicTimeoutMinutesSnapshot: null,
    acceptedByCompanionId: order.actualCompanionId,
    acceptedAt: at,
    // ⚠️ 必填字段，别省：`.mjs` 不进 `tsc`，漏了不会有编译错误，只会是 `undefined`。
    // 这里的场景是「客服直换」的后续（见本文件 §退款），按 §九-F 的口径**不是**打手自接。
    acceptedVia: null,
    timedOutAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

/**
 * 一张「已部分退款、状态却是 `paid`」的订单 —— MAJOR-1 的前置条件本身。
 *
 * ⚠️ **必须是 `serving`，不能是 `completed`**：`completed → paid` 不是合法迁移
 * （`canTransitionOrder` 里没有这条边），因此「回池」这一步只有 `serving` 走得到。
 * 这正是 MAJOR-1 只在 `serving` 上成立的原因——也正因为它不是随手能构造的状态，
 * 才值得有一条用例专门钉住。
 *
 * 这条路径每一步都走真实入口，不手工改字段：手工拼出来的状态组合
 * 可能压根不是一个真实路径能产生的状态，那样验的只是测试自己的想象力。
 * 唯一例外是退款申请：`serving` 单的售后申请要走客服调查，
 * 这里用仓储夹具把「已有一条申请」这个前提直接摆好。
 */
async function servingPartialRefundThenBackToPaid({ unitPrice, refundRateBp = 1000 }) {
  const order = seedServingOrder({ unitPrice });
  const refund = await openRefundRequest(order);
  await approveOnce(refund.id, refundRateBp, uniq("op-p015"));
  assert.equal(orderNow(order.id).status, "serving", "前置：部分退款不改订单状态");

  seedDispatchRecord(order, { state: "accepted" });
  const released = await releaseOrderByStaff({
    orderId: order.id,
    staffId: "staff-p015",
    reason: "P0-15 用例：退回公共池以复现 MAJOR-1 路径",
    at: "2026-09-28T11:00:00.000Z",
  });
  assert.equal(released.kind, "ok", `前置：退回公共池应当成功，实际：${JSON.stringify(released)}`);

  const after = orderNow(order.id);
  assert.equal(after.status, "paid", "前置：回池之后订单是 paid —— 直退的档位闸从此对它敞开");
  assert.ok(after.refundedAmount > 0, "前置：这一单确实已经出过一次款");
  assert.ok(
    after.refundedAmount < after.actualPaidAmount,
    "前置：是**部分**退款，「退满」这条判据在这里不成立",
  );
  return { order, refund, after };
}

test("规则1（执行侧 1/3）：部分退款 → 回池 → 直接退款被挡（正例：从未出过款的同档位照旧放行）", async () => {
  const { order, after } = await servingPartialRefundThenBackToPaid({ unitPrice: 5000 });
  const refundedAtBefore = after.refundedAt;

  // —— 反例：已经出过款，直退必须被挡，且**展示面先就不该给出按钮** ——
  const latest = await getRefundRepository().findRefundByOrderId(order.id);
  const actions = buildRefundActions(after, latest);
  assert.equal(
    actions.canDirectRefund,
    false,
    "规则1：出过款的单不得再出现「直接退款」——部分退款不改状态，档位闸挡不住它",
  );
  assert.equal(actions.directRefundAmountCents, null, "规则1：不得显示一个「再退 XXX 元」的数字");
  assert.equal(actions.alreadyRefundedAmountCents, null);

  await assert.rejects(
    () => directRefundOrderForUser(order.id, order.userId, undefined, "server"),
    (error) => {
      assert.ok(error instanceof ApiError, "必须由服务端拒绝（→ HTTP 400），不是靠界面藏按钮");
      assert.equal(error.message, DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE);
      return true;
    },
  );

  const blocked = orderNow(order.id);
  assert.equal(blocked.refundedAmount, after.refundedAmount, "规则1：第二次出款不得发生");
  assert.equal(blocked.refundedAt, refundedAtBefore, "规则1：退款时刻也不得被刷新");
  assert.equal(blocked.status, "paid", "规则1：被拒的写入不得留下任何痕迹");
  // `serving` 单从未结算过，因此它本来就不该有收益记录；
  // 这一条钉的是「被挡住的那次尝试也没有顺手写出一份 Earning / EarningAdjustment」
  assert.equal(
    await getEarningRepository().findEarningByOrderId(order.id),
    null,
    "规则1：被挡的第二次出款不得产生任何收益冲回记录（①§八 「不得产生第二份 Earning reversal」）",
  );

  // —— 正例：同一个场景、只是**没有**出过款，直退必须照旧成功 ——
  const clean = seedServingOrder({ unitPrice: 5000 });
  paymentStore().orders.set(clean.id, { ...clean, status: "paid" });
  seedDispatchRecord(clean, { state: "accepted" });
  const cleanBefore = paymentStore().orders.get(clean.id);
  const cleanActions = buildRefundActions(cleanBefore, null);
  assert.equal(cleanActions.canDirectRefund, true, "正例：没出过款的 paid 单必须照旧能直退");
  assert.equal(cleanActions.directRefundAmountCents, cleanBefore.actualPaidAmount);

  const done = await directRefundOrderForUser(clean.id, clean.userId, undefined, "server");
  assert.equal(done.refundedAmount, cleanBefore.actualPaidAmount, "正例：免审批直退仍然是全额");
  assert.equal(orderNow(clean.id).status, "refunded");
});

test("规则1（执行侧 2/3）：部分退款 → 回池 → 公共池到点不得再出第二笔（正例：未出过款的照旧自动全额退）", async () => {
  const { order, after } = await servingPartialRefundThenBackToPaid({ unitPrice: 5000 });
  const refundedAtBefore = after.refundedAt;
  const refundedAmountBefore = after.refundedAmount;

  // 回池之后派单已经重新进了公共池。到点时刻取记录自己冻结的那一个，
  // **不手写常量**：公共池超时是平台配置，默认值随时会变，
  // 写死的时刻要么早于它（扫不动）要么晚于它（扫到了别的轮次）
  const dispatchId = dispatchStore().dispatchIdByOrder.get(order.id);
  const dispatch = dispatchStore().dispatches.get(dispatchId);
  assert.equal(dispatch.state, "public", "前置：客服回池之后派单应当重新进入公共池");
  const deadline = dispatch.publicDeadlineAt;
  assert.ok(deadline, "前置：进过公共池的派单必须有截止时间");

  const swept = sweepExpiredDispatches(deadline);
  assert.equal(
    swept.refundedOrderIds.includes(order.id),
    false,
    "规则1：已经出过款的订单不得出现在「本次被退款」的清单里——计划层就要判掉，不能靠写入层静默拒绝",
  );

  const sweptOrder = orderNow(order.id);
  assert.equal(sweptOrder.refundedAmount, refundedAmountBefore, "规则1：不得出第二笔钱");
  assert.equal(sweptOrder.refundedAt, refundedAtBefore, "规则1：退款时刻不得被刷新");
  assert.equal(
    dispatchStore().dispatches.get(dispatchId).state,
    "timed_out",
    "规则1：**池子仍然必须关掉**——只是不再出款，否则它会一直挂在那里被反复扫到",
  );

  // —— 正例：同一套公共池设置，只是这一单没出过款，到点必须照旧自动全额退款 ——
  const clean = seedServingOrder({ unitPrice: 3700 });
  paymentStore().orders.set(clean.id, { ...clean, status: "paid" });
  const cleanPaidAmount = paymentStore().orders.get(clean.id).actualPaidAmount;
  seedDispatchRecord(clean, {
    state: "public",
    exclusiveCompanionId: null,
    exclusiveEnteredAt: null,
    exclusiveDeadlineAt: null,
    exclusiveTimeoutMinutesSnapshot: null,
    publicPoolEnteredAt: "2026-09-28T10:00:00.000Z",
    publicDeadlineAt: deadline,
    publicTimeoutMinutesSnapshot: 30,
    acceptedByCompanionId: null,
    acceptedAt: null,
    // 回池 ⇒ 来源也必须一起清（与 `applyDispatchToPublic()` 同一规矩）
    acceptedVia: null,
  });

  const sweptClean = sweepExpiredDispatches(deadline);
  assert.ok(sweptClean.refundedOrderIds.includes(clean.id), "正例：未出过款的单到点必须照旧被自动退款");
  assert.equal(orderNow(clean.id).refundedAmount, cleanPaidAmount, "正例：自动退款仍是全额");
  assert.equal(orderNow(clean.id).status, "refunded");
});

test("规则1（执行侧 3/3）：三个出款入口都走同一个判据，没有任何一处自己写 `> 0`", () => {
  const predicateCode = readCodeWithoutComments("lib/constants/refunds.ts");
  assert.ok(predicateCode.includes("hasRefundBeenExecuted"), "判据必须定义在常量层，不能散落在三个写入路径里");
  assert.ok(
    predicateCode.includes("isRefundExecutionClosed"),
    "并集判据也必须在常量层单点定义，否则每个调用点都要手写 `status === \"refunded\" || …`",
  );

  // 每个调用点引用**哪一个**判据是刻意的，所以逐条钉死，而不是「包含任一个即可」：
  // 写入路径与计划层问「退款还能不能再发生」（并集），
  // 净额与展示面问「出过款吗」（窄判据）。
  const CALL_POINTS = [
    ["lib/data/directRefundTransaction.ts", "hasRefundBeenExecuted"],
    ["lib/data/companionDispatchTransaction.ts", "isRefundExecutionClosed"],
    ["lib/data/mockPaymentRepository.ts", "isRefundExecutionClosed"],
    ["lib/services/refunds.ts", "hasRefundBeenExecuted"],
    ["lib/services/companionOrders.ts", "hasRefundBeenExecuted"],
  ];
  for (const [file, symbol] of CALL_POINTS) {
    assert.ok(
      readCodeWithoutComments(file).includes(symbol),
      `规则1：${file} 必须引用 ${symbol}`,
    );
  }

  // 真正的意图：**没有任何一处自己写 `refundedAmount > 0`**——判据只有一处实现。
  // `lib/constants/orders.ts` 是唯一豁免（无运行时 import 的硬约束，见该文件头部），
  // 它由下面那条矩阵用例钉住。
  for (const [file] of CALL_POINTS) {
    assert.ok(
      !readCodeWithoutComments(file).includes("refundedAmount > 0"),
      `规则1：${file} 不得自己写 \`refundedAmount > 0\`，必须走常量层的判据`,
    );
  }

  // 并集也只有一个实现：调用点不得再手写 `status === "refunded" ||`
  for (const [file] of CALL_POINTS) {
    assert.ok(
      !/status\s*===\s*"refunded"\s*\|\|/.test(readCodeWithoutComments(file)),
      `规则1：${file} 不得自己拼并集，必须走 isRefundExecutionClosed`,
    );
  }
});

/**
 * 实付为 0 的坏单子：计划层**也不出款、不通知**，而不是让它走到写入层
 * 被 `0 >= 0`（退满）静默拒掉。
 *
 * 为什么值得一条用例：`refundDue` 若只判「退款是否终结」，这张单会算出
 * `refundAmount = 0`、发出一句「已退款」、并把 id 报进 `refundedOrderIds`——
 * 而存储层的退满短路**不会动钱**。于是调用方拿到一份**没退成却报成退过**的账。
 * 这正是 D20 点名的「计划层放行、存储层静默拒绝」。
 *
 * ⚠️ 这张单子是**直接构造**出来的（`unitPrice: 0`），因为今天的下单链产生不了它
 * （券抵被强制为 0、种子单价为正）。要钉的恰恰是「计划层不把正确性押在
 * 一条上游不变式上」——所以用例自己造出那个状态，而不是等它自然出现。
 */
test("规则1（执行侧 4/4）：实付为 0 的单子不出款、不通知，但池子照样收掉", () => {
  const order = seedServingOrder({ unitPrice: 0 });
  assert.equal(order.actualPaidAmount, 0, "前置：这张单子没有钱可退");

  const deadline = "2026-09-28T12:00:00.000Z";
  const dispatchId = seedDispatchRecord(order, {
    state: "public",
    exclusiveCompanionId: null,
    exclusiveEnteredAt: null,
    exclusiveDeadlineAt: null,
    exclusiveTimeoutMinutesSnapshot: null,
    publicPoolEnteredAt: "2026-09-28T11:30:00.000Z",
    publicDeadlineAt: deadline,
    publicTimeoutMinutesSnapshot: 30,
    acceptedByCompanionId: null,
    acceptedAt: null,
  }).id;
  const notificationsBefore = countNotificationsFor(order.id);

  const swept = sweepExpiredDispatches(deadline);

  assert.equal(
    swept.refundedOrderIds.includes(order.id),
    false,
    "规则1：没退成就不许报成退过——假账的入口在这里，不在写入层",
  );
  assert.equal(orderNow(order.id).refundedAmount, 0, "规则1：不得凭空退满");
  assert.equal(orderNow(order.id).refundedAt, null, "规则1：不得写退款时刻");
  assert.equal(orderNow(order.id).status, "serving", "规则1：状态不得变成 refunded");
  assert.equal(
    countNotificationsFor(order.id),
    notificationsBefore,
    "规则1：没有退款就不该发「已退款」通知——通知也是业务事实",
  );
  assert.equal(
    dispatchStore().dispatches.get(dispatchId).state,
    "timed_out",
    "规则1：**池子仍然必须收掉**——不出款不等于可以不关池",
  );
});

/**
 * `resolveCompanionDisplayStatus` 是**唯一**被允许就地写 `refundedAmount > 0` 的地方
 * （`lib/constants/orders.ts` 不得有运行时 `import`）。既然是特例，
 * 就必须有东西钉住它和常量层的判据不静默分叉。
 *
 * ⚠️ **它与 `isRefundExecutionClosed` 是恒等的**（同一个并集，一个返回状态、
 * 一个返回布尔），断言就按恒等写。
 *
 * 这条用例本身留下了一段历史：它最早断言的是「与 `hasRefundBeenExecuted` 恒等」，
 * 于是**第一次运行就在 `status === "refunded"` 且 `refundedAmount === 0` 这一格上红了**
 * ——展示状态说 `refunded`、窄判据说「没出过款」。那不是 bug，是两者分工不同：
 * 窄判据只回答「出过款吗」，而展示面要的是「退款终结了吗」。
 * 修法不是放宽断言，而是**把那个并集提升成常量层的第二个单点定义**
 * （`isRefundExecutionClosed`），调用点不再各写一遍 `||`。
 * 那个组合在**可写路径上仍然不可达**（`applyOrderRefund` 只在退满时写 `refundedAt`，
 * 且实付为 0 的坏单子被 `isFullyRefunded` 的守卫挡掉），但两处口径**并不依赖**它不可达。
 */
test("规则1（判据一致性）：派生展示状态与并集判据恒等，逐格相同", () => {
  let sawBothArms = { byStatus: false, byAmount: false };
  for (const status of ["paid", "accepted", "serving", "completed", "refunded"]) {
    for (const refundedAmount of [0, 1, 459, 5000]) {
      const order = { status, refundedAmount };
      if (status === "refunded") sawBothArms.byStatus = true;
      if (status !== "refunded" && refundedAmount > 0) sawBothArms.byAmount = true;
      assert.equal(
        resolveCompanionDisplayStatus(order) === "refunded",
        isRefundExecutionClosed(order),
        `规则1：状态 ${status} / 已退 ${refundedAmount} 上展示口径与并集判据不一致`,
      );
    }
  }
  // 正对照：两条臂都真的被走到过。少任何一条，上面那组就可能只是
  // 「两边恒为同一个常量」而蒙对的
  assert.equal(sawBothArms.byStatus, true, "正对照：状态那一条臂必须被走到");
  assert.equal(sawBothArms.byAmount, true, "正对照：已退金额那一条臂必须被走到");
  assert.equal(
    hasRefundBeenExecuted({ refundedAmount: 0 }),
    false,
    "边界：0 元是「还没出过款」，不是「出过 0 元」",
  );
  // 窄判据是并集的**真子集**：状态那一格里两者刻意不同，这不是需要抹平的分歧
  assert.equal(
    isRefundExecutionClosed({ status: "refunded", refundedAmount: 0 }),
    true,
    "边界：状态已终结时，并集判据仍然说「终结」——它不依赖「出过款」",
  );
  assert.equal(resolveCompanionDisplayStatus({ status: "serving", refundedAmount: 1 }), "refunded");
  assert.equal(resolveCompanionDisplayStatus({ status: "serving", refundedAmount: 0 }), "serving");
});

// ═══════════════════════ 规则 2 / 3 / 4：金额 ═══════════════════════

test("规则2（1/2）：10% 退款——退给用户的金额 = floor(实付 × 10%)", async () => {
  const { order, decision, orderAfter } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
  });

  // 期望值独立算出：3333 × 10% = 333.3 → 向下取整 333。
  // 写成 333.3 或向上取整都会红——取整方向是规则的一部分。
  assert.equal(order.actualPaidAmount, 3333, "前置条件：订单实付快照");
  assert.equal(decision.refundRateBp, 1000, "规则2：比例原样存下（基点）");
  assert.equal(
    decision.refundAmount,
    333,
    `规则2：退款额必须是 floor(3333 × 1000 / 10000) = 333，实际 ${decision.refundAmount}`,
  );
  assert.equal(orderAfter.refundedAmount, 333, "规则2：订单上的累计已退 = 本次退款额");
  assert.equal(
    decision.refundAmount,
    Math.floor((order.actualPaidAmount * 1000) / 10000),
    "规则2：金额必须由订单冻结快照算出来，不得重查商品现价或当前分账比例",
  );
});

test("规则2（2/2）：100% 退款——退款额精确等于订单实付（不存在尾差）", async () => {
  const { order, decision, orderAfter } = await refundedScenario({
    unitPrice: 4590,
    refundRateBp: 10000,
  });

  assert.equal(
    decision.refundAmount,
    order.actualPaidAmount,
    "规则2：100% 必须精确等于实付——这正是「全额退款」不需要单独意图的原因",
  );
  assert.equal(decision.refundAmount, 4590, "规则2：4590 × 100% = 4590");
  assert.equal(orderAfter.refundedAmount, 4590, "规则2：累计已退 = 实付");
  assert.equal(
    decision.companionReversalAmount,
    order.companionBaseIncome,
    "规则3：冲回额恒为整笔，与比例无关（100% 也是整笔）",
  );
});

test("规则3（1/2）：10% 退款后打手净收益 = 0（冲回额不按比例打折）", async () => {
  const { order, earning, earningAfter, decision } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
  });

  // 前置：打手收益快照 = floor(3333 × 80%) = 2666
  assert.equal(order.companionBaseIncome, 2666, "前置条件：打手收益快照");
  assert.equal(earning.incomeAmount, 2666, "前置条件：收益记录的原始承诺额");
  assert.equal(
    decision.companionReversalAmount,
    2666,
    `规则3：退 10% 也要整笔冲回 2666；若写成 floor(2666 × 10%) = 266 说明按比例打折了（打手偷偷留下了钱）`,
  );
  assert.equal(
    earningAfter.incomeAmount - earningAfter.reversedAmount,
    0,
    `规则3：退款批准后打手净收益必须为 0，实际 ${earningAfter.incomeAmount - earningAfter.reversedAmount}`,
  );
});

test("规则3（2/2）：50% 退款后打手净收益 = 0", async () => {
  const { order, earningAfter } = await refundedScenario({
    unitPrice: 4590,
    refundRateBp: 5000,
  });

  assert.equal(order.companionBaseIncome, 3672, "前置条件：floor(4590 × 80%) = 3672");
  assert.equal(
    earningAfter.incomeAmount - earningAfter.reversedAmount,
    0,
    `规则3：退 50% 与退 10%、100% 一样是整笔归零，实际净额 ${earningAfter.incomeAmount - earningAfter.reversedAmount}`,
  );
  assert.equal(earningAfter.reversedAmount, earningAfter.incomeAmount, "规则3：冲回额 = 原始收益额");
});

test("规则4（1/2）：10% 退款后平台净收入 = 实付 − 退款额", async () => {
  const { decision, orderAfter } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
  });

  const net = platformNetIncome(orderAfter.actualPaidAmount, decision.refundAmount);
  assert.equal(net, 3000, `规则4：3333 − 333 = 3000，实际 ${net}`);
  assert.equal(
    net,
    orderAfter.actualPaidAmount - decision.refundAmount,
    "规则4：平台净收入是「实付 − 退款额」，不是订单上那个下单时冻结的 clubNetIncome",
  );
  // 这条对照是刻意的：两个数不同，互相顶替会让平台收入看起来少一大截
  assert.notEqual(net, orderAfter.clubNetIncome, "规则4：平台净收入 ≠ clubNetIncome（两者答的是不同问题）");
});

test("规则4（2/2）：50% 退款后平台净收入正确", async () => {
  const { decision, orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 5000 });

  const net = platformNetIncome(orderAfter.actualPaidAmount, decision.refundAmount);
  assert.equal(decision.refundAmount, 2295, `规则2：4590 的 50% = 2295，实际 ${decision.refundAmount}`);
  assert.equal(net, 2295, `规则4：4590 − 2295 = 2295，实际 ${net}`);
});

// ═══════════════════════ 规则 6 / 11 / 12：状态与展示分离 ═══════════════════════

test('规则6（1/2）：100% 退款后 Order.status 变成 "refunded"', async () => {
  const { orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 10000 });

  assert.equal(
    orderAfter.status,
    "refunded",
    `规则6：只有累计退满才把订单改成 refunded，实际 ${orderAfter.status}`,
  );
  assert.equal(orderAfter.refundedAmount, orderAfter.actualPaidAmount, "规则6：refunded 的含义就是「累计已退满」");
});

test("规则6（2/2）：部分退款不得把 Order.status 改成 refunded", async () => {
  const { order, orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 5000 });

  assert.notEqual(orderAfter.status, "refunded", "规则6：部分退款改了订单状态（订单还要继续履约）");
  assert.equal(
    orderAfter.status,
    order.status,
    `规则6：部分退款后订单状态必须原样保持 completed，实际 ${orderAfter.status}`,
  );
  assert.ok(orderAfter.refundedAmount > 0, "前置条件：这一次确实是「退了一半还在服务中」");
  assert.equal(orderAfter.refundedAt, null, "规则6：没退满就不该写下 refundedAt");
});

test("规则6（3/3 打手端投影）：部分退款后打手端展示「已退款」，订单真实状态不变", async () => {
  const { order, companionId, orderAfter } = await refundedScenario({
    unitPrice: 4590,
    refundRateBp: 1000,
  });

  const detail = await getCompanionOrderDetail(companionId, order.id);
  assert.ok(detail, "打手应当看得到自己履约过的这一单");

  assert.equal(orderAfter.status, "completed", "前置条件：订单真实状态仍是已完成");
  assert.equal(detail.status, "completed", "规则6：DTO 上的真实状态如实是 completed");
  assert.equal(detail.statusLabel, "已完成", "规则6：真实状态的文案照实");
  assert.equal(
    detail.displayStatus,
    "refunded",
    "规则6：打手端展示状态必须是 refunded（他这一单的钱已经全部取消）",
  );
  assert.equal(detail.displayStatusLabel, "已退款", "规则6：展示状态文案必须是「已退款」");

  // 列表投影走同一条规则——只验详情等于只验了一半链路
  const list = await listCompanionOrders(companionId);
  const item = list.items.find((row) => row.id === order.id);
  assert.ok(item, "这一单必须出现在打手的订单列表里");
  assert.equal(item.displayStatus, "refunded", "规则6：列表项的展示状态同样必须是 refunded");
  assert.equal(item.displayStatusLabel, "已退款", "规则6：列表项的展示文案同样是「已退款」");
  assert.equal(item.status, "completed", "规则6：列表项的真实状态仍然是 completed");
});

test("规则3（打手端投影）：部分退款后打手端 DTO 的本单收益 = 0", async () => {
  const { order, companionId, earningAfter } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
  });

  // 这一条前置断言是这个用例有没有牙齿的关键：若收益记录根本不存在，
  // DTO 会走「退过款 ⇒ 0」那条旁路也给出 0——那样就证明不了「整笔冲回」这件事。
  assert.ok(earningAfter, "前置条件：这一单有真实的收益记录");
  assert.equal(earningAfter.incomeAmount, 2666, "前置条件：收益原始承诺额非 0");

  const detail = await getCompanionOrderDetail(companionId, order.id);
  assert.ok(detail);
  assert.equal(
    detail.netIncomeAmount,
    0,
    `规则3：打手端「本单收益」必须是 0（不是 null、不是 266 的残值），实际 ${detail.netIncomeAmount}`,
  );

  const list = await listCompanionOrders(companionId);
  const item = list.items.find((row) => row.id === order.id);
  assert.ok(item, "这一单必须出现在打手的订单列表里");
  assert.equal(item.netIncomeAmount, 0, `规则3：列表项的本单收益同样是 0，实际 ${item.netIncomeAmount}`);
});

// ═══════════════════════ 规则 6：沟通可写性 ═══════════════════════

test("规则6（沟通）：部分退款后派单沟通没有被锁死，仍然可写", async () => {
  const { order, orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 1000 });

  assert.equal(
    isOrderChatClosed(orderAfter.status),
    false,
    `规则6：只有全额退款才关沟通；部分退款（status=${orderAfter.status}）不得关闭`,
  );

  const sent = await sendMessageForUser(
    order.userId,
    order.id,
    { idempotencyKey: uniqKey(), target: "current", body: "退了一半，剩下的还继续打吗？" },
    undefined,
    "server",
  );
  assert.equal(
    sent.created,
    true,
    "规则6：部分退款后用户必须还能给打手发消息（售后沟通正是在这种时候最需要）",
  );
});

test("规则6（沟通）：全额退款后派单沟通只读（写入被拒）", async () => {
  const { order, orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 10000 });

  assert.equal(orderAfter.status, "refunded", "前置条件：这一单已全额退款");
  assert.equal(
    isOrderChatClosed(orderAfter.status),
    true,
    "规则6：全额退款后履约沟通必须关闭写入",
  );

  await assert.rejects(
    () =>
      sendMessageForUser(
        order.userId,
        order.id,
        { idempotencyKey: uniqKey(), target: "current", body: "还能聊吗？" },
        undefined,
        "server",
      ),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "BAD_REQUEST", "必须是 400（不是 404：会话存在、历史可查）");
      assert.equal(
        error.message,
        MESSAGE_ORDER_REFUNDED_MESSAGE,
        "规则6：拒绝文案必须是「已全额退款、可查看但不能发」",
      );
      return true;
    },
    "规则6：全额退款后不允许再往履约段发消息",
  );
});

test("规则6（沟通）：全额退款后用户↔客服会话仍然可写", async () => {
  const { order, orderAfter } = await refundedScenario({ unitPrice: 4590, refundRateBp: 10000 });

  assert.equal(orderAfter.status, "refunded", "前置条件：这一单已全额退款");

  const sent = await sendMessageForUser(
    order.userId,
    order.id,
    { idempotencyKey: uniqKey(), target: "service", body: "客服您好，退款到账了吗？" },
    undefined,
    "server",
  );
  assert.equal(
    sent.created,
    true,
    "规则6：全额退款不该顺带冻住客服会话——那正是用户最需要问的时候",
  );
});

// ═══════════════════════ 规则 3：收益历史快照与冲回 ═══════════════════════

test("规则3（历史快照）：Earning.incomeAmount 退款前后逐字节不变", async () => {
  const { order, earning, earningAfter } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 5000,
  });

  assert.equal(earning.incomeAmount, 2666, "前置条件：原始承诺额");
  assert.equal(
    earningAfter.incomeAmount,
    earning.incomeAmount,
    "规则3：incomeAmount 是历史承诺快照，冲回只能另记一笔调整，不得把它改小",
  );
  assert.equal(
    JSON.stringify(earningAfter.incomeAmount),
    JSON.stringify(earning.incomeAmount),
    "规则3：incomeAmount 必须逐字节不变",
  );
  assert.equal(
    earningAfter.incomeAmount,
    order.companionBaseIncome,
    "规则3：它始终等于订单冻结的 companionBaseIncome",
  );
});

test("规则3（冲回明细）：恰好一条 EarningAdjustment，金额与状态都正确", async () => {
  const { order, refund, earning, earningAfter } = await refundedScenario({
    unitPrice: 4590,
    refundRateBp: 1000,
  });

  const adjustments = await getEarningRepository().listAdjustmentsForEarning(earning.id);
  assert.equal(
    adjustments.length,
    1,
    `规则3：一次退款决策只允许恰好一条冲回明细，实际 ${adjustments.length} 条`,
  );
  const [adjustment] = adjustments;
  assert.equal(adjustment.type, "refund_reversal", "明细类型必须是退款冲回");
  assert.equal(adjustment.refundId, refund.id, "明细的幂等键就是这次退款决策的 id");
  assert.equal(
    adjustment.amount,
    earning.incomeAmount,
    `规则3：明细金额必须等于 incomeAmount（整笔），实际 ${adjustment.amount}`,
  );
  assert.equal(
    earningAfter.reversedAmount,
    earningAfter.incomeAmount,
    `规则3：reversedAmount 必须写满 incomeAmount，实际 ${earningAfter.reversedAmount} / ${earningAfter.incomeAmount}`,
  );
  assert.equal(
    earningAfter.status,
    "frozen",
    `规则3：整笔冲销不改状态，收益仍停在 frozen（P0-15 §二 Q5），实际 ${earningAfter.status}`,
  );
  assert.equal(orderNow(order.id).refundedAmount, 459, "前置条件：退款确实只执行了一次");
});

// ═══════════════════════ 规则 8：幂等 ═══════════════════════

test("规则8（1/2）：同一幂等键重复批准 = 幂等重放，不再动钱也不多写明细", async () => {
  const { order, refund, earning } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
    deferApproval: true,
  });

  const operationId = uniq("op-p015-replay");
  await approveOnce(refund.id, 1000, operationId);

  const orderAfterFirst = orderNow(order.id);
  const adjustmentsAfterFirst = await getEarningRepository().listAdjustmentsForEarning(earning.id);
  const earningAfterFirst = await getEarningRepository().findEarningByOrderId(order.id);
  assert.equal(adjustmentsAfterFirst.length, 1, "前置条件：第一次批准写下一条明细");

  // 同一个幂等键、同一个目标、同一个意图 → 必须认出来是重放
  const second = await approveRefund(
    refund.id,
    "",
    { refundRateBp: 1000 },
    writeContext(operationId),
  );

  assert.equal(
    second.kind,
    "ok",
    `规则8：同一幂等键的第二次批准必须当作重放成功返回，实际 ${JSON.stringify(second)}`,
  );
  assert.equal(second.replayed, true, "规则8：必须被识别为重放");
  assert.equal(second.changed, false, "规则8：重放不得改动退款申请");
  assert.equal(second.value.orderChanged, false, "规则8：重放不得改动订单");

  const orderAfterSecond = orderNow(order.id);
  assert.equal(
    orderAfterSecond.refundedAmount,
    orderAfterFirst.refundedAmount,
    `规则8：重复批准不得产生第二次真实退款，实际 ${orderAfterFirst.refundedAmount} → ${orderAfterSecond.refundedAmount}`,
  );
  assert.equal(orderAfterSecond.refundedAt, orderAfterFirst.refundedAt, "规则8：不得刷新 refundedAt");

  const adjustmentsAfterSecond = await getEarningRepository().listAdjustmentsForEarning(earning.id);
  assert.equal(
    adjustmentsAfterSecond.length,
    1,
    `规则8：不得产生第二条冲回明细，实际 ${adjustmentsAfterSecond.length} 条`,
  );

  const earningAfterSecond = await getEarningRepository().findEarningByOrderId(order.id);
  assert.equal(
    earningAfterSecond.reversedAmount,
    earningAfterFirst.reversedAmount,
    "规则8：重放不得再次冲减收益",
  );
  assert.equal(earningAfterSecond.reversedAmount, earningAfterSecond.incomeAmount, "前置条件：这一次是整笔冲回");
});

test("规则8（2/2）：换一个幂等键再批准一次也必须被拒（退款已是终态）", async () => {
  const { order, refund, earning } = await refundedScenario({
    unitPrice: 3333,
    refundRateBp: 1000,
    deferApproval: true,
  });

  await approveOnce(refund.id, 1000, uniq("op-p015-first"));
  const orderAfterFirst = orderNow(order.id);

  const second = await approveRefund(
    refund.id,
    "",
    { refundRateBp: 1000 },
    writeContext(uniq("op-p015-second")),
  );

  assert.equal(
    second.kind,
    "invalid-transition",
    `规则8：approved 是终态，第二个幂等键也必须被状态机挡下，实际 ${JSON.stringify(second)}`,
  );
  assert.equal(second.status, "approved", "被拒时必须回报当前状态，管理员才知道发生了什么");

  const orderAfterSecond = orderNow(order.id);
  assert.equal(
    orderAfterSecond.refundedAmount,
    orderAfterFirst.refundedAmount,
    "规则8：不得出现第二次真实退款",
  );
  const adjustments = await getEarningRepository().listAdjustmentsForEarning(earning.id);
  assert.equal(adjustments.length, 1, `规则8：不得出现第二条冲回明细，实际 ${adjustments.length} 条`);

  const earningAfter = await getEarningRepository().findEarningByOrderId(order.id);
  assert.equal(earningAfter.reversedAmount, earningAfter.incomeAmount, "规则8：冲回额不得被再次累加");
});

// ═══════════════════════ 规则 5：责任模型废止（源码门禁） ═══════════════════════

/**
 * 新写入路径上**不得再出现**的责任模型标识符。
 *
 * 它们今天仍然出现在若干文件的**注释**里——那些注释记录的是「这些字段已随 P0-15 删除」
 * 这个事实，是有价值的历史说明，不是违规。因此门禁只扫**去注释之后的代码**。
 *
 * ⚠️ 不引入新的 `stripComments` 拷贝（仓库里已有 18 份逐字节相同的实现）：
 * 这里只是两条就地正则，够用且范围仅限本文件。
 */
const FORBIDDEN_RESPONSIBILITY_TOKENS = [
  "responsibility",
  "companionLiabilityRateBp",
  "platformBorneAmount",
  "refundFullRemaining",
];

/** 每个文件必须先在去注释代码里找到的**已知存在**符号 —— 正例，防止扫了个空文件。 */
const REFUND_WRITE_PATH_FILES = [
  { file: "lib/constants/refunds.ts", markers: ["computeRefundDecisionAmounts", "platformNetIncome"] },
  { file: "lib/types/refund.ts", markers: ["RefundDecision", "companionReversalAmount"] },
  { file: "lib/data/adminRefundTransaction.ts", markers: ["approveRefund", "refundRateBp"] },
  { file: "lib/constants/adminRefunds.ts", markers: ["canTransitionRefund", "adminRefundAllowedActions"] },
  { file: "lib/services/adminRefunds.ts", markers: ["approveAdminRefund"] },
  { file: "lib/data/refundRepository.ts", markers: ["listRefundsByOrderId", "createRefundRequest"] },
  { file: "lib/data/mockRefundRepository.ts", markers: ["applyRefundReview"] },
  { file: "lib/data/earningTransaction.ts", markers: ["settleOrderCompletion", "backfillRefundReversals"] },
  { file: "lib/data/mockEarningRepository.ts", markers: ["appendEarningAdjustment", "applyEarningReversal"] },
];

function readCodeWithoutComments(relative) {
  const raw = readFileSync(path.join(ROOT, relative), "utf8");
  assert.ok(raw.length > 0, `${relative} 读出来是空的——路径写错了吗？`);
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/\/\/[^\n]*/g, ""); // 行注释
  assert.ok(
    code.trim().length > 500,
    `${relative} 去注释之后只剩 ${code.trim().length} 个字符——正则把代码也删掉了，这条门禁会静默变成空断言`,
  );
  return code;
}

test("规则5（1/2）正例：门禁确实扫到了这 9 个文件，且能在其中找到真实代码符号", () => {
  for (const { file, markers } of REFUND_WRITE_PATH_FILES) {
    const code = readCodeWithoutComments(file);
    for (const marker of markers) {
      assert.ok(
        code.includes(marker),
        `正例失败：${file} 的去注释代码里找不到 ${marker}，说明文件没被真正读到（或注释剥离过度）`,
      );
    }
  }
});

test("规则5（2/2）反例：退款写入路径上不存在责任模型与「退满剩余」的标识符", () => {
  for (const { file } of REFUND_WRITE_PATH_FILES) {
    const code = readCodeWithoutComments(file);
    for (const token of FORBIDDEN_RESPONSIBILITY_TOKENS) {
      assert.equal(
        code.includes(token),
        false,
        `规则5：${file} 的新写入路径仍在引用已废止的 ${token}（P0-15 已整体删除责任模型）`,
      );
    }
  }
});
