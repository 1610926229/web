import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// 具名导入之外再要一份命名空间：用于「已废止的常量/函数不得回到模块表面上」这条结构断言
import * as refundRules from "../lib/constants/refunds.ts";
import {
  REFUND_ALREADY_EXISTS_MESSAGE,
  REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE,
  REFUND_DECISION_AMOUNT_ZERO_MESSAGE,
  REFUND_DECISION_EXCEEDS_PAID_MESSAGE,
  REFUND_DECISION_RATE_INVALID_MESSAGE,
  REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  REFUND_NOTIFICATION_COMPANION_REFUNDED,
  REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION,
  REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE,
  assertRefundAmountWithinPaid,
  computeRefundDecisionAmounts,
  formatRefundDecisionRate,
  isFullyRefunded,
  platformNetIncome,
  validateRefundDecisionInput,
} from "../lib/constants/refunds.ts";
import {
  adminRefundTransitionMessage,
  previewRefundDecisionAmounts,
} from "../lib/constants/adminRefunds.ts";
import { resolveCompanionDisplayStatus } from "../lib/constants/orders.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import { approveCompletion, submitCompletion } from "../lib/data/completionTransaction.ts";
import { settleOrderCompletion, sweepMaturedEarnings } from "../lib/data/earningTransaction.ts";
import {
  appendEarningAdjustment,
  applyEarningReversal,
  earningStore,
  findEarningAdjustmentIdByRefund,
  newEarningAdjustmentId,
} from "../lib/data/mockEarningRepository.ts";
import { adminAuditStore } from "../lib/data/mockAdminAuditRepository.ts";
import { notificationStore } from "../lib/data/mockNotificationRepository.ts";
import { refundStore } from "../lib/data/mockRefundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { applyOrderRefund, paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { approveAdminRefund, getAdminRefundDetail } from "../lib/services/adminRefunds.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { getStaffRefundDetail } from "../lib/services/staffRefunds.ts";
import { createRefundForOrder, getRefundDetailForUser } from "../lib/services/refunds.ts";

/**
 * P0-15「退款资金链」的持续测试。
 *
 * 本文件只钉**钱这条线**：一次退款决策之后，钱在「用户 / 平台 / 打手」三方之间
 * 到底动了多少、动在哪一条记录上、谁看得到谁看不到。
 * 退款状态机、幂等键的意图绑定与接口形状由 `tests/adminRefunds.test.mjs` 与
 * `tests/refunds.test.mjs` 覆盖；这里不重复，只在自己需要的边界上补一条。
 *
 * ## 当前冻结的规则（`docs/03-dev/rounds/P0-15/`，产品负责人 2026-09-28 覆盖）
 *
 * | # | 规则 | 本文件怎么钉 |
 * |---|---|---|
 * | §一 | 一个订单**最多一次**退款申请、最多一次实际退款执行 | 第二次 `createRefundRequest` 被拒；已批准后既不能再申请、也不能再批准 |
 * | §二 | `refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`；100% ⇒ 全额 | 纯函数公式用例 + 10% / 50% / 100% 三条真实链路用例 |
 * | §三 | 退款一旦批准，该单打手净收益**恒为 0**，与比例无关 | 「冲回额 === companionBaseIncome」的纯函数用例 + 三条链路用例 + 明细恰好一条 |
 * | §四 | 平台最终收入 = `actualPaidAmount − refundAmount` | `platformNetIncome()` 的闭合恒等式用例 |
 * | §五 | 责任模型（platform / companion / shared / `companionLiabilityRateBp`）**整体废止** | 「只输入比例」用例 + 决策/DTO 字段集合断言 + 模块导出表不得再有旧符号 |
 * | §六 | 订单状态与打手展示状态**分离**；部分退款不改 `Order.status` | 「部分退款不改状态」用例（同时看 `displayStatus` 的派生） |
 * | §六 | 在途退款阻塞收益释放（释放原子区段重读阻塞事实） | 「到点清扫不得越过在途退款」用例 |
 *
 * ## 三条派生事实（本文件的骨架）
 *
 * 1. 决策只有**两个**金额：`refundAmount` 与 `companionReversalAmount`。
 *    后者**恒等于**订单冻结的 `companionBaseIncome`（也就是 `Earning.incomeAmount`），
 *    **不乘退款比例**。`platformBorneAmount` / `remainingRefundableAmount` /
 *    `reversedSoFarAmount` 已随「多步退款 + 责任分担」一并删除。
 * 2. 一次退款**恰好一条** `EarningAdjustment`（幂等键 = `refundId`），
 *    且 `Earning.reversedAmount === Earning.incomeAmount === 明细的 amount`，状态进 `reversed`。
 *    「读用总数、审计用明细」这条关系必须同时对得上。
 * 3. `Earning.incomeAmount` 是**历史快照，永不修改**；平台净收入是**现算的**，
 *    不写进决策——写进去就是同一个数的第二份出处。
 *
 * ## 一条刻意的写法
 *
 * 链路用例里的期望金额一律由**订单自己的冻结快照**（`actualPaidAmount` /
 * `companionBaseIncome`）现算，不硬编码数字：商品价与分账比例改一次，硬编码的数字
 * 就会变成一句「以前是这样」的假话，而这条链路要钉的是**公式**。
 * 纯函数那一节另用手算字面量断言（见第一节），因此不依赖订单快照。
 *
 * ## 已删除的用例，以及它们当年证明的是什么
 *
 * **它们编码的不是「暂时不做」，而是被 P0-15 正式废止的规则。**
 * 删掉之后这里少了很多行，那是有意的——列出来是为了让后来的人知道
 * 那不是测试漏了，而是一整套模型没了。
 *
 * | 组 | 删掉的用例 | 当年证明什么 | 被 P0-15 的哪一条取代 |
 * |---|---|---|---|
 * | A 责任模型三分支 | `公式：平台承担 → 冲回 0`、`公式：打手承担 → 按同一退款比例冲回`、`公式：按比例分担 → 两级取整`、`按比例分担：冲回额 = 退款比例 × 打手责任比例`、`校验：责任比例只属于「按比例分担」`、`接口层：非「按比例分担」却带责任比例` | 冲回额取决于管理员选的**责任归属**；平台承担额 = 退款额 − 冲回额，允许为负 | §五：责任模型废止。**冲回额与比例无关、恒为整笔**（§三），因此三条公式退化成同一个常数；「谁承担」不再是输入，而是规则的结果 |
 * | B 累计冲回与多次退款 | `公式：钳制把累计冲回锁在剩余可冲回额以内（Q2-d）`、`同一笔收益可以被多次冲减`、`纯函数：已冲回额只认「已批准」的决策`、`退过一次之后：剩余可退与已冲回跟着变`、`打手承担：收益已 available 时部分冲回 → 状态仍是 available`（Q2-c） | 同一笔收益能被**多次**冲减，因此需要 `reversedSoFar` 钳制、「已冲回」汇总与「部分冲回不改状态」 | §一：一个订单只退一次。累计与钳制**没有可加的对象**（冲回额就是 `incomeAmount`，构造上不可能越界）；Q2-c 的前提被反转——打手这一单**确实**白干了，`reversed` 是必然结果（§三/§四） |
 * | C D17 已提现不冲回 | `D17：收益已提现 → 本轮不冲回，金额 0，多出来的由平台承担`、`纯函数：D17「已提现不冲回」`、`预览：收益已提现时冲回 0、平台承担全部（D17）` | `withdrawn` 是一档需要决定「谁承担」的分支：不追回，改由平台承担 | `02-decisions.md` Q1 **V2**：问题本身被取消。普通退款下收益**结构上到不了** `withdrawn`（completed 建收益即 `frozen`；`available` 的唯一出口带 `hasActiveRefund` 判据；批准后直接 `reversed`）。本轮**不引入**钱包/负余额/追偿 |
 * | D 「退满剩余」补尾差 | `特征化：整数百分比序列够不到满额`、`正面回归：同一张单子改用「退满剩余」`、`正面回归：退满剩余时打手冲回按「剩余 / 实付」算`、`退满剩余：界面预览与服务端写下去的三个数逐项相等`、`接口层形状：退满与比例二选一` | 多步部分退款会留下 1–99 分尾差，`floor(实付 × n/100)` 只有 101 个离散值够不着，因此需要一个一等的「退满剩余」意图 | §一 + D5：**一次退款没有尾差**，`floor(实付 × 10000/10000) === 实付` 恒成立，所以「全额退款」就是 **100%**；`refundFullRemaining` 这个维度整体不存在了 |
 * | E 组合路径（部分退款 + 客服回池） | `组合路径：部分退款 → 客服回池 → 用户直接退款`、`组合路径：部分退款 → 客服回池 → 公共池超时`、`写入器护栏：即使调用方把「实付全额」当增量传` | 部分退款不改状态 ⇒ 会出现「已退过一部分、状态却是 `paid`/`accepted`」的订单，而两条「未开始服务即退全额」的路径若仍传实付全额就会**超退** | §一：这条组合本身就是「多步退款」的产物——一个订单只退一次，**不存在「已退过一部分又回到未开始服务」**。`applyOrderRefund` 的增量语义与「累计不超过实付」的钳制**仍然存在且仍被别处用例覆盖**（`tests/directRefund.test.mjs` / `tests/dispatch.test.mjs`），本文件不再重复 |
 *
 * 计数：**删 22 条、按新规则重写 25 条、新增 12 条**（文件从 52 条变成 37 条）。
 * 新增的 12 条里，7 条是指令点名的必加项（一单一退 ×2、10% / 50% / 100% 三条真实链路、
 * 部分退款不改状态、恰好一条 `EarningAdjustment`），另 5 条是围绕同一批不变式补的
 * 正反例与并发对照：服务层第二次申请的 400、第二个幂等键的重复批准、
 * 「冲回额恒为整笔」这条新公式本身，以及并发阻塞释放的正反两条。
 * 另有**两条只是换了锚点、没有删**，容易与上表混起来，单列在此：
 * `D13：责任归属与平台承担额只给管理员` → 改写为「可见性：责任字段在整个系统里已经不存在」；
 * `预览的「超过剩余可退」与服务端金额闸是同一个判断` → 改写为「预览的「会被金额闸拦下」与服务端金额闸是同一个判断（判据是实付）」
 * ——两条守的边界（谁看得到、预览与服务端同口径）没变，变的是被比对的字段。
 */

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const ADMIN = "admin-1";
const STAFF = { id: "staff-1", name: "客服小雨" };
const COMPANION_A = "cp-1";

/**
 * 一位**有收信地址**的打手：`cp-10` → `u-1022`（DEV-1 预置的有效打手）。
 *
 * ⚠️ 验通知的用例**必须**用它，不能用 `cp-1`：预置 `cp-*` 大多 `userId` 为 null，
 * 那种打手在 `adminRefundTransaction` 里算不出 `recipientUserId`，
 * 通知**根本不会被构造**。用 `cp-1` 断言「有没有通知」，两边都是 0——
 * 断言永远成立，也就永远证明不了任何事。
 */
const NOTIFIABLE_COMPANION = "cp-10";
const NOTIFIABLE_COMPANION_USER = "u-1022";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * 通过退款的请求体。**P0-15 起只有一个字段**（`refundRatePercent`），
 * 责任归属与「退满剩余」两个维度都已删除（见 `readAdminRefundDecisionInput`）。
 */
function decisionBody(refundRatePercent = "100", extra = {}) {
  return { refundRatePercent, ...extra };
}

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("dispatch");
  resetMockStore("earning");
  resetMockStore("completion");
  resetMockStore("adminAudit");
  resetMockStore("notification");
  resetMockStore("complaint");
});

// ————————————————————————— 读取辅助 —————————————————————————

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function refundOf(refundId) {
  const refund = await getRefundRepository().findRefundById(refundId);
  assert.ok(refund, `退款 ${refundId} 必须存在`);
  return refund;
}

/** 这一单的收益（可能还没生成——`serving` 单退款时就是这种情况，见 D9）。 */
function earningOfOrder(orderId) {
  return [...earningStore().earnings.values()].find((earning) => earning.orderId === orderId) ?? null;
}

function adjustmentsOf(earningId) {
  return [...earningStore().adjustments.values()]
    .filter((adjustment) => adjustment.earningId === earningId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function allNotifications() {
  return [...notificationStore().notifications.values()];
}

/**
 * 只挑「退款」这一类通知。
 *
 * ⚠️ 不能拿 `allNotifications().length` 的增减来验退款通知：
 * 造一张 `completed` 订单本身就会产生一串通知（支付、接单、开始服务、完成……），
 * 于是「总数变多了」在**退款一条都没发**的情况下也成立。
 */
function refundNotifications() {
  return allNotifications().filter((item) => item.kind === "refund");
}

// ————————————————————————— 构造一张有收益的订单 —————————————————————————

/**
 * 走完整链路把一张新订单推到 `completed` 并拿到它的收益（`frozen`）。
 *
 * 与 `tests/earning.test.mjs` 的同类辅助保持同一套时刻关系（接单 −41 / 开始服务 −21 /
 * 提交材料 −11），因此这里不需要重新论证链路自身的先后关系。
 */
async function completedOrder({
  completedAt = plusMinutes(now(), 62),
  companionId = COMPANION_A,
} = {}) {
  const user = unique("u-p15");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      idempotencyKey: unique("p15key"),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  const orderId = confirmed.order.id;

  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(dispatch, "支付成功后必须有一条派单记录");
  const accepted = await acceptDispatch(dispatch.id, {
    companionId,
    at: plusMinutes(completedAt, -41),
  });
  assert.equal(accepted.kind, "ok");

  const started = await startCompanionOrderTransaction({
    companionId,
    orderId,
    at: plusMinutes(completedAt, -21),
  });
  assert.equal(started.kind, "ok");

  const submitted = await submitCompletion({
    companionId,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -11),
  });
  assert.equal(submitted.kind, "ok");

  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.name,
    at: completedAt,
  });
  assert.equal(approved.kind, "ok");

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed", "前置条件：订单必须走到 completed");
  const earning = earningOfOrder(orderId);
  assert.ok(earning, "completed 必须生成收益");
  assert.equal(earning.status, "frozen", "前置条件：收益刚生成时是冻结的");
  assert.equal(earning.reversedAmount, 0, "前置条件：还没有任何冲回");

  return { user, order, orderId, earning };
}

/**
 * 一张还在 `serving`（尚未结算、因此**还没有收益**）的订单。
 *
 * 它专门用来验 D9：退款时收益还不存在，冲回必须**记在退款决策上**，
 * 等这一单将来结算时再补记，而不是当场丢掉。
 */
async function servingOrder({
  at = plusMinutes(now(), 32),
  companionId = COMPANION_A,
} = {}) {
  const user = unique("u-p15s");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      idempotencyKey: unique("p15key"),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  const orderId = confirmed.order.id;

  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  const accepted = await acceptDispatch(dispatch.id, {
    companionId,
    at: plusMinutes(at, -21),
  });
  assert.equal(accepted.kind, "ok");
  const started = await startCompanionOrderTransaction({
    companionId,
    orderId,
    at,
  });
  assert.equal(started.kind, "ok");

  const order = await orderOf(orderId);
  assert.equal(order.status, "serving", "前置条件：订单必须在护航中");
  assert.equal(earningOfOrder(orderId), null, "前置条件：还在护航的单没有收益");
  return { user, order, orderId };
}

/** 用户发起退款申请（每次一个新幂等键），返回退款 id。 */
async function requestRefund(orderId, userId) {
  const { refundId } = await createRefundForOrder(
    orderId,
    userId,
    {
      reasonKey: "other",
      description: "临时有事，这一单打不了了，麻烦帮我退掉。",
      evidence: [],
      idempotencyKey: unique("p15key"),
    },
    undefined,
    "server",
  );
  return refundId;
}

/** 管理员批一笔退款（决策由调用方给全）。 */
async function approve(refundId, body) {
  return approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: unique("p15key"),
    ...body,
  });
}

/** 按订单冻结快照算「退 n% 应退多少钱」——与被测公式同义，但由输入现算。 */
function refundForPercent(order, percent) {
  return Math.floor((order.actualPaidAmount * (percent * 100)) / 10000);
}

// ————————————————— 一、公式与校验（纯函数，手算字面量） —————————————————
//
// 这一节**不碰订单**，因此期望值可以写成手算出来的字面量：
// `paid = 1500` / `base = 2000` / 比例 30%，都是整百，乘除之后不会出现
// 「读代码算一遍再断言」那种自证。

test("公式：冲回额恒为整笔，与退款比例无关 —— 10% 与 100% 都把打手收益零掉", () => {
  // 三种比例各算一次：退款额跟着比例走，冲回额**一动不动**
  for (const [percent, expectedRefund] of [
    [10, 150],
    [30, 450],
    [100, 1500],
  ]) {
    const amounts = computeRefundDecisionAmounts({
      actualPaidAmount: 1500,
      companionBaseIncome: 2000,
      input: { refundRateBp: percent * 100 },
    });

    assert.equal(amounts.refundAmount, expectedRefund, `退 ${percent}% 应退 ${expectedRefund}`);
    assert.equal(
      amounts.companionReversalAmount,
      2000,
      `退 ${percent}% 也必须把打手这 2000 分整笔零掉（P0-15 §三）`,
    );
  }

  // 反例才是这条用例的意义所在：写成「按比例冲减」时金额会变得「挺合理」，
  // 只是打手偷偷留下了钱，而页面上完全看不出来
  const tenPercent = computeRefundDecisionAmounts({
    actualPaidAmount: 1500,
    companionBaseIncome: 2000,
    input: { refundRateBp: 1000 },
  });
  assert.notEqual(
    tenPercent.companionReversalAmount,
    Math.floor((2000 * 1000) / 10000),
    "冲回额不得是「打手收益 × 退款比例」——那正是 P0-15 要消灭的公式",
  );

  // 决策上只有两个金额，`platformBorneAmount` 已随责任模型删除
  assert.deepEqual(Object.keys(tenPercent).sort(), ["companionReversalAmount", "refundAmount"]);
});

test("公式：取整一律向下 —— 除不尽时退款额不向上进一分；100% 精确等于实付", () => {
  // 实付 1001、比例 33%：1001 × 3300 / 10000 = 330.33 → 330
  const amounts = computeRefundDecisionAmounts({
    actualPaidAmount: 1001,
    companionBaseIncome: 777,
    input: { refundRateBp: 3300 },
  });

  assert.equal(amounts.refundAmount, 330, "除不尽时向下取整");
  assert.equal(amounts.companionReversalAmount, 777, "冲回额与比例无关，原样整笔");

  // 「全额退款」不需要特例，靠的就是这条取整恒等式
  for (const actualPaidAmount of [999, 1001, 2999]) {
    const full = computeRefundDecisionAmounts({
      actualPaidAmount,
      companionBaseIncome: 1777,
      input: { refundRateBp: 10000 },
    });
    assert.equal(
      full.refundAmount,
      actualPaidAmount,
      `100% 必须精确等于实付（实付 ${actualPaidAmount} 时不许差一分）`,
    );
  }
});

test("公式：三方闭合 —— 用户拿退款额、打手留 0、平台拿「实付 − 退款额」", () => {
  const actualPaidAmount = 2999;
  const companionBaseIncome = 1777;

  for (const refundRateBp of [1000, 3300, 5000, 10000]) {
    const amounts = computeRefundDecisionAmounts({
      actualPaidAmount,
      companionBaseIncome,
      input: { refundRateBp },
    });

    // 打手侧：原始承诺额 − 本次冲回额。P0-15 下它**恒为 0**（冲回额就是整笔）
    const companionNetIncome = companionBaseIncome - amounts.companionReversalAmount;
    const platform = platformNetIncome(actualPaidAmount, amounts.refundAmount);

    assert.equal(companionNetIncome, 0, `退 ${refundRateBp / 100}%：打手净额必须是 0`);
    assert.equal(
      amounts.refundAmount + companionNetIncome + platform,
      actualPaidAmount,
      "退款额 + 打手净额 + 平台净收入 必须恰好等于实付——一分不多、一分不少",
    );
    assert.equal(platform, actualPaidAmount - amounts.refundAmount);
  }

  // 100% 时平台一分不剩；这正是 §四 的边界
  assert.equal(platformNetIncome(actualPaidAmount, actualPaidAmount), 0);
});

test("校验：比例没填说「请填写」，填错说「必须是 0~100 的整数百分比」", () => {
  // NaN 落到「没填」那一档：对管理员来说两者都是「这个框没填对」，
  // 而「必须在 0~100 之间」这句对一个填了 NaN 的人毫无帮助
  assert.equal(
    validateRefundDecisionInput({ refundRateBp: Number.NaN }),
    REFUND_DECISION_RATE_REQUIRED_MESSAGE,
  );
  assert.equal(
    validateRefundDecisionInput({ refundRateBp: 10001 }),
    REFUND_DECISION_RATE_INVALID_MESSAGE,
  );
  assert.equal(
    validateRefundDecisionInput({ refundRateBp: -100 }),
    REFUND_DECISION_RATE_INVALID_MESSAGE,
  );

  // 0% 与 100% 在**形态上**都合法：0 算出来的金额是 0，由金额闸另行拦下——
  // 两道校验各答各的问题，不互相顶替
  assert.equal(validateRefundDecisionInput({ refundRateBp: 0 }), null);
  assert.equal(validateRefundDecisionInput({ refundRateBp: 10000 }), null);

  // 责任模型整体废止这件事，在**模块表面**也必须成立：
  // 只要有一个旧符号还导出着，这条模型就没删干净——后来的人会顺着它把逻辑加回来。
  // （断言写在模块的导出表上，而不是别处：这才是这一层唯一有意义的检查对象）
  for (const gone of [
    "REFUND_RESPONSIBILITIES",
    "REFUND_RESPONSIBILITY_LABELS",
    "REFUND_DECISION_RESPONSIBILITY_REQUIRED_MESSAGE",
    "REFUND_DECISION_RESPONSIBILITY_INVALID_MESSAGE",
    "REFUND_DECISION_LIABILITY_REQUIRED_MESSAGE",
    "REFUND_DECISION_LIABILITY_INVALID_MESSAGE",
    "REFUND_DECISION_RATE_UNEXPECTED_MESSAGE",
    "resolveFinalDecisionAmounts",
    "sumApprovedCompanionReversal",
    "REFUND_FULL_REMAINING_INVALID_MESSAGE",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(refundRules, gone),
      false,
      `已废止的符号 ${gone} 不得回到 lib/constants/refunds.ts 的导出表上`,
    );
  }

  // 反向把守：新模型要用的这一批必须还在（少了任何一个，上面的循环会一起变绿）
  for (const present of [
    "computeRefundDecisionAmounts",
    "platformNetIncome",
    "isFullyRefunded",
    "assertRefundAmountWithinPaid",
    "validateRefundDecisionInput",
  ]) {
    assert.equal(
      typeof refundRules[present],
      "function",
      `${present} 必须仍然导出——否则这条断言只会证明「模块空了」`,
    );
  }
});

test("金额闸：一单一退 ⇒ 判据是**这一次**退了多少；0 元与负额是两档", () => {
  // 正常路径上 `alreadyRefundedAmount` 恒为 0（一个订单只退一次，而这是那一次）
  assert.equal(
    assertRefundAmountWithinPaid({ refundAmount: 100, alreadyRefundedAmount: 0, actualPaidAmount: 100 }),
    null,
    "恰好退满实付是合法的（100% 全额退款）",
  );
  assert.equal(
    assertRefundAmountWithinPaid({ refundAmount: 101, alreadyRefundedAmount: 0, actualPaidAmount: 100 }),
    REFUND_DECISION_EXCEEDS_PAID_MESSAGE,
    "单笔超过实付必须被拒",
  );
  assert.equal(
    assertRefundAmountWithinPaid({ refundAmount: 0, alreadyRefundedAmount: 0, actualPaidAmount: 100 }),
    REFUND_DECISION_AMOUNT_ZERO_MESSAGE,
    "退 0 元不是一次退款",
  );

  // —— 负额是**另一档**，不是「退 0 元」——
  // 负额只可能来自 `refundedAmount > actualPaidAmount`，即数据已经坏了
  // （P0-15 之前退过多次的历史单，或任何被外部写坏的数据）。
  // 把它答成「退款金额为 0」会把排查方向从「为什么已退超过实付」引到
  // 「为什么算出来是 0」上去——这正是当初要修的那个缺陷。
  //
  // 两条断言各管一件事，缺一不可：
  //   · `equal(…, NEGATIVE_MESSAGE)` 钉「负额返回的是负数那一句」，
  //     顺带把「两行顺序对调」（先判 `<= 0`，于是 `< 0` 那行永远够不着）钉死；
  //   · `notEqual(…, ZERO_MESSAGE)` 钉「这两档不许共用一句话」——
  //     只留前面那条的话，把两个常量改成同一个字符串仍然全绿，
  //     而那等于又回到了「一律答 0 元」。
  assert.equal(
    assertRefundAmountWithinPaid({ refundAmount: -1, alreadyRefundedAmount: 101, actualPaidAmount: 100 }),
    REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE,
  );
  assert.notEqual(
    assertRefundAmountWithinPaid({ refundAmount: -1, alreadyRefundedAmount: 101, actualPaidAmount: 100 }),
    REFUND_DECISION_AMOUNT_ZERO_MESSAGE,
    "负数分支必须排在 0 前面：共用一句话就等于没有分档",
  );
});

test("退满判据：一次退到实付才算退满；实付为 0 的订单永不「退满」", () => {
  // P0-15 起「唯一那一次退款就是全额退款」是唯一的退满形态（D6）
  assert.equal(isFullyRefunded(0, 100), false);
  assert.equal(isFullyRefunded(99, 100), false);
  assert.equal(isFullyRefunded(100, 100), true);
  assert.equal(isFullyRefunded(101, 100), true, "超过也算退满（异常数据不该卡在中间态）");
  assert.equal(isFullyRefunded(0, 0), false, "0 元单不是「已退满」——否则坏单会凭空变成 refunded");

  // 比例 → 判据的落点：100% 才是退满，任何小于 100% 都不是
  const paid = 2999;
  for (const percent of [10, 30, 50, 99]) {
    const refundAmount = refundForPercent({ actualPaidAmount: paid }, percent);
    assert.equal(
      isFullyRefunded(refundAmount, paid),
      false,
      `退 ${percent}% 不得被判成退满——部分退款是**预期的终态**，不是「卡住了」`,
    );
  }
  assert.equal(isFullyRefunded(refundForPercent({ actualPaidAmount: paid }, 100), paid), true);
});

test("异常单防线：实付 ≤ 0 的订单按比例退款算出来是 0，且不得是 NaN", () => {
  for (const actualPaidAmount of [0, -100]) {
    const amounts = computeRefundDecisionAmounts({
      actualPaidAmount,
      companionBaseIncome: 2392,
      input: { refundRateBp: 10000 },
    });

    // 坏订单不该产生任何资金动作：不是「按比例算出来恰好是 0」，而是提前返回 0
    assert.deepEqual(
      amounts,
      { refundAmount: 0, companionReversalAmount: 0 },
      `实付 ${actualPaidAmount}：异常单必须退成 0、也不许冲打手的钱`,
    );
    for (const [name, value] of Object.entries(amounts)) {
      assert.equal(Number.isNaN(value), false, `${name} 不得是 NaN`);
    }
    assert.equal(
      assertRefundAmountWithinPaid({
        refundAmount: amounts.refundAmount,
        alreadyRefundedAmount: 0,
        actualPaidAmount,
      }),
      REFUND_DECISION_AMOUNT_ZERO_MESSAGE,
      "由金额闸按既有的「退款金额为 0」文案拒掉",
    );
  }

  // 金额闸**判不出** NaN：`NaN < 0`、`NaN === 0` 与 `NaN > 实付` 全是 false。
  // 因此「实付 ≤ 0 时返回 0」这道防线必须留在计算里，不能指望闸门兜住。
  // 没有下面这条断言，上面那段说明就成了「理论上可能」的一句话。
  assert.equal(
    assertRefundAmountWithinPaid({
      refundAmount: Number.NaN,
      alreadyRefundedAmount: 0,
      actualPaidAmount: 100,
    }),
    null,
    "闸门会放行一个 NaN 金额——所以计算里的防线是必需的",
  );
});

// ———————————— 二、一单一退：申请唯一性与「不存在第二次退款」 ————————————

test("一单一退：第二次 createRefundRequest 返回 order_already_has_refund，存储里仍然只有一条", async () => {
  const { user, orderId } = await completedOrder();
  const firstRefundId = await requestRefund(orderId, user);

  const repository = getRefundRepository();
  const before = await repository.listRefundsByOrderId(orderId);
  assert.equal(before.length, 1, "前置：这一单刚提交过一条申请");
  assert.equal(before[0].id, firstRefundId);

  const countBefore = refundStore().refunds.size;
  const existing = await repository.findRefundById(firstRefundId);
  assert.ok(existing);

  // 换一个幂等键，直接打仓储——这正是「就算有人绕过服务层也写不进去」那条落点
  const outcome = await repository.createRefundRequest(
    { ...existing, id: `rf_${unique("dup")}`, refundNo: unique("RF") },
    unique("p15key"),
  );

  assert.equal(outcome.ok, false, "第二条申请必须被拒");
  assert.equal(outcome.reason, "order_already_has_refund");
  assert.equal(outcome.existing.id, firstRefundId, "被拒时要能告诉调用方是哪一条挡住的");
  assert.equal(
    (await repository.listRefundsByOrderId(orderId)).length,
    1,
    "被拒之后这一单仍然只有一条申请",
  );
  assert.equal(refundStore().refunds.size, countBefore, "存储里一个字节都没多");
});

test("一单一退：服务层对同一订单的第二次申请同样是 400，用的是「已经提交过」那句文案", async () => {
  const { user, orderId } = await completedOrder();
  await requestRefund(orderId, user);

  await assert.rejects(
    () =>
      createRefundForOrder(
        orderId,
        user,
        {
          reasonKey: "other",
          description: "再退一次试试。",
          evidence: [],
          idempotencyKey: unique("p15key"),
        },
        undefined,
        "server",
      ),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_ALREADY_EXISTS_MESSAGE);
      return true;
    },
    "服务层必须与仓储同口径：留一个只挡前端的入口，就会出现「按钮没了、接口还能提交」",
  );

  assert.equal((await getRefundRepository().listRefundsByOrderId(orderId)).length, 1);
});

test("一单一退：退款已执行之后不能再发起申请 —— 这一次连入口都不该有", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("100"));

  const after = await orderOf(orderId);
  assert.equal(after.status, "refunded", "前置：全额退款之后订单已终结");
  assert.equal(after.refundedAmount, after.actualPaidAmount);

  await assert.rejects(
    () => requestRefund(orderId, user),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      // 「已提交过」比「订单当前不可退款」更具体，因此排在前面
      assert.equal(error.message, REFUND_ALREADY_EXISTS_MESSAGE);
      return true;
    },
  );

  assert.equal(
    (await getRefundRepository().listRefundsByOrderId(orderId)).length,
    1,
    "退款流程终结之后也不会多出第二条申请",
  );
});

test("不存在第二次实际退款：换一个幂等键再 approve 一次 → 400，账上一动不动", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("25"));

  const afterFirst = await orderOf(orderId);
  const reversalAfterFirst = earningOfOrder(orderId).reversedAmount;
  assert.ok(reversalAfterFirst > 0, "前置：第一次批准真的动过钱");

  // 不同的幂等键 ⇒ 走的是状态机这一关（而不是重放短路）。
  // ⚠️ 文案要钉死到 `adminRefundTransitionMessage("approved")`：只判 400 的话，
  //    「决策入参非法」「订单状态不该批」等等别的 400 也会让这条断言变绿，
  //    而它们各自意味着完全不同的缺陷。
  await assert.rejects(
    () => approve(refundId, decisionBody("25")),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, adminRefundTransitionMessage("approved"));
      return true;
    },
    "`approved` 是终态，第二次批准必须被状态机拒绝",
  );

  assert.equal(
    (await orderOf(orderId)).refundedAmount,
    afterFirst.refundedAmount,
    "被拒的第二次批准不得再动订单的累计已退额",
  );
  assert.equal(
    earningOfOrder(orderId).reversedAmount,
    reversalAfterFirst,
    "也不得再冲一次打手收益",
  );
  assert.equal(adjustmentsOf(earning.id).length, 1, "更不得留下第二条冲回明细");
  assert.equal(
    (await refundOf(refundId)).decision.refundAmount,
    afterFirst.refundedAmount,
    "决策本身也不得被改写",
  );

  // ⚠️ 上面每条「不变」都要有「第一次真的变过」垫底，否则它们在一个
  //    第一次就什么都没做的实现上照样全绿（例如批准被 400 挡掉、或第二个幂等键
  //    被误判成重放而静默返回）。用订单冻结快照而不是返回值再确认一次。
  assert.ok(
    afterFirst.refundedAmount > 0 && afterFirst.refundedAmount < order.actualPaidAmount,
    "前置：第一次批准真的退过一笔**部分**款（25%）",
  );
});

// ———————————— 三、三条链路：10% / 50% / 100% 的真实数字 ————————————

test("10% 退款：用户退 10%、打手净额 0、平台净收入 = 实付 − 退款额", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("10"));

  const refund = await refundOf(refundId);
  const expectedRefund = refundForPercent(order, 10);
  assert.ok(expectedRefund > 0 && expectedRefund < order.actualPaidAmount, "这是一笔**部分**退款");

  // ① 用户拿到多少
  assert.equal(refund.decision.refundRateBp, 1000);
  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.decidedBy, ADMIN);
  assert.equal(typeof refund.decision.decidedAt, "string");
  assert.equal(formatRefundDecisionRate(refund.decision), "10%");
  assert.equal((await orderOf(orderId)).refundedAmount, expectedRefund);

  // ② 打手净额必须是 0 —— 与退款比例**无关**
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome);
  const afterEarning = earningOfOrder(orderId);
  assert.equal(afterEarning.reversedAmount, afterEarning.incomeAmount);
  assert.equal(afterEarning.incomeAmount, earning.incomeAmount, "原始承诺额一个字不改");
  assert.equal(
    afterEarning.status,
    "frozen",
    "P0-15 §二 Q5：整笔冲销不改状态，收益仍停在 frozen——它永远不会进入可提现阶段",
  );

  // 打手端 DTO 上的净额。⚠️ 走服务层而不是仓储：`netAmount` 是 DTO 字段，
  // 仓储给的是存储记录、上面没有它——在仓储上断言净额会得到一个 `undefined`。
  const mine = (await listCompanionEarnings(COMPANION_A)).items.find(
    (row) => row.orderId === orderId,
  );
  assert.ok(mine, "打手必须能读到自己的收益");
  assert.equal(mine.netAmount, 0);
  assert.equal(mine.reversedAmount, mine.incomeAmount);

  // ③ 平台最终收入
  assert.equal(
    platformNetIncome(order.actualPaidAmount, refund.decision.refundAmount),
    order.actualPaidAmount - expectedRefund,
  );

  // ④ 用户端只看得到结果金额，看不到决策依据
  const userDetail = await getRefundDetailForUser(refundId, user, undefined, "server");
  assert.ok(userDetail);
  assert.equal(userDetail.decidedAmount, expectedRefund);
  assert.equal("decision" in userDetail, false);
});

test("50% 退款：同样把打手收益整笔零掉，平台留下另一半", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("50"));

  const refund = await refundOf(refundId);
  const expectedRefund = refundForPercent(order, 50);
  assert.ok(expectedRefund > 0 && expectedRefund < order.actualPaidAmount);

  assert.equal(refund.decision.refundRateBp, 5000);
  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome);

  const after = earningOfOrder(orderId);
  assert.equal(after.reversedAmount, after.incomeAmount);
  assert.equal(
    after.status,
    "frozen",
    "P0-15 §二 Q5：50% 与 100% 对状态的影响相同——冲光归零，状态仍是 frozen",
  );
  assert.equal(
    platformNetIncome(order.actualPaidAmount, refund.decision.refundAmount),
    order.actualPaidAmount - expectedRefund,
  );

  // 冲回明细恰好一条，且金额就是整笔
  const adjustments = adjustmentsOf(earning.id);
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].amount, after.incomeAmount);
});

test("100% 退款：退款额精确等于实付，订单才转 refunded", async () => {
  const { user, order, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("100"));

  const refund = await refundOf(refundId);
  assert.equal(refund.decision.refundRateBp, 10000);
  assert.equal(refund.decision.refundAmount, order.actualPaidAmount, "100% 就是实付全额");
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome);

  const after = await orderOf(orderId);
  assert.equal(after.status, "refunded", "只有全额退款才把订单推成已退款（§六）");
  assert.equal(after.refundedAmount, after.actualPaidAmount);
  assert.equal(typeof after.refundedAt, "string", "退满时才写下退款时刻");
  assert.equal(
    isFullyRefunded(after.refundedAmount, after.actualPaidAmount),
    true,
    "状态与退满判据必须同时成立——不得出现「已退款但没退满」",
  );
  assert.equal(platformNetIncome(after.actualPaidAmount, refund.decision.refundAmount), 0);
});

test("部分退款：Order.status 不被改成 refunded，但打手端展示状态是「已退款」", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("10"));

  const after = await orderOf(orderId);
  assert.equal(after.status, "completed", "部分退款不得把订单推成已退款——这一单按真实生命周期继续");
  assert.equal(after.refundedAt, null, "没退满就不该有退款时刻");
  assert.ok(after.refundedAmount > 0 && after.refundedAmount < after.actualPaidAmount);
  assert.equal(isFullyRefunded(after.refundedAmount, after.actualPaidAmount), false);
  assert.equal(after.actualCompanionId, COMPANION_A, "派单归属不动");

  // §六：**展示状态是派生的**，不写回 `Order.status`。
  // Q3 裁定它一旦为「已退款」就永久如此，因此这里看的正是那个派生字段。
  assert.equal(
    resolveCompanionDisplayStatus(after),
    "refunded",
    "打手端展示「已退款」，而订单状态仍是 completed——两条线各自成立",
  );
});

test("恰好一条 EarningAdjustment：amount === incomeAmount，且 revenue 上的累计冲回额等于明细之和", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("30"));

  const after = earningOfOrder(orderId);
  const adjustments = adjustmentsOf(earning.id);

  assert.equal(adjustments.length, 1, "一次退款决策只许留**一条**冲回明细");
  assert.equal(adjustments[0].refundId, refundId, "明细的幂等键就是这次退款");
  assert.equal(adjustments[0].type, "refund_reversal");
  assert.equal(adjustments[0].amount, after.incomeAmount, "明细金额 = 整笔收益");
  assert.equal(adjustments[0].orderId, orderId);
  assert.equal(adjustments[0].adminId, ADMIN, "明细要能回答「是谁批的这笔冲回」");

  // D12：`EarningAdjustment.responsibility` 这个字段为**历史行**保留，但**新写入不得再带**。
  // 断言新行上没有它，是为了挡住「字段留着 → 顺手又写回去 → 责任模型复活」这条路；
  // 同时反向确认新写入的字段集合恰好是类型上那一组，一个不多。
  assert.equal("responsibility" in adjustments[0], false, "新写入的冲回明细不得再带责任归属");
  assert.deepEqual(
    Object.keys(adjustments[0]).sort(),
    ["adminId", "amount", "createdAt", "earningId", "id", "orderId", "refundId", "type"],
    "新写入的明细字段集合必须与类型定义一致——多一个字段通常意味着旧模型的一角回来了",
  );

  assert.equal(after.reversedAmount, after.incomeAmount, "累计冲回额也是整笔");
  assert.equal(after.status, "frozen", "P0-15 §二 Q5：整笔冲销不改状态");
  assert.equal(after.incomeAmount, order.companionBaseIncome, "原额来自订单冻结快照，不重算");
  assert.equal(
    after.reversedAmount,
    adjustments.reduce((total, item) => total + item.amount, 0),
    "读用总数、审计用明细：两者必须永远是同一个数",
  );
});

test("不变式：一次退款跑完，冲回额等于明细之和、落在 [0, incomeAmount] 内，订单状态与退满判据一致", async () => {
  const { user, order, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("35"));

  const after = earningOfOrder(orderId);
  const adjustments = adjustmentsOf(earning.id);

  assert.equal(after.reversedAmount, adjustments.reduce((total, item) => total + item.amount, 0));
  assert.ok(after.reversedAmount >= 0);
  assert.ok(after.reversedAmount <= after.incomeAmount, "冲回不得超过原额（存储层护栏，P0-15 后构造上不可能越界）");
  assert.equal(adjustments.length, 1);

  const paid = (await orderOf(orderId)).refundedAmount;
  assert.ok(paid <= order.actualPaidAmount, "退出去的不能比实付多");
  assert.equal(
    (await orderOf(orderId)).status,
    isFullyRefunded(paid, order.actualPaidAmount) ? "refunded" : "completed",
    "订单状态只能由退满判据决定，调用方不许自己写 >= 判断",
  );
});

// ————————————— 四、护航中退款：收益还没生成（D9） —————————————

test("D9：护航中退款时还没有收益 → 决策照记下整笔冲回，结算时补记", async () => {
  const { user, orderId, order } = await servingOrder();
  const refundId = await requestRefund(orderId, user);

  // 30% 部分退款：订单必须继续护航（退满会转「已退款」，那样就结算不了了）
  await approve(refundId, decisionBody("30"));

  const refund = await refundOf(refundId);
  assert.equal(refund.status, "approved");
  assert.equal(
    refund.decision.companionReversalAmount,
    order.companionBaseIncome,
    "退款当场就把「该冲多少」算好并记在决策上——它来自订单快照，不依赖 Earning 存在",
  );
  assert.ok(refund.decision.companionReversalAmount > 0, "这一条要有意义，冲回额必须为正");
  assert.equal(earningOfOrder(orderId), null, "此时收益确实还不存在");
  assert.equal(
    (await orderOf(orderId)).status,
    "serving",
    "部分退款不改订单状态：这一单还要继续履约",
  );

  // 履约完成 → 结算
  const completedAt = plusMinutes(now(), 62);
  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -5),
  });
  assert.equal(submitted.kind, "ok");
  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.name,
    at: completedAt,
  });
  assert.equal(approved.kind, "ok");

  const earning = earningOfOrder(orderId);
  assert.ok(earning, "结算必须生成收益");
  assert.equal(
    earning.reversedAmount,
    refund.decision.companionReversalAmount,
    "退款时算好的冲回额必须在结算时补记，不能丢",
  );
  assert.equal(earning.reversedAmount, earning.incomeAmount, "P0-15：补记的也是整笔，因此必然冲满");
  assert.equal(
    earning.status,
    "frozen",
    "P0-15 §二 Q5：补记也是整笔冲销，但状态仍停在 frozen——「整笔」只体现在金额上",
  );
  assert.equal(earning.incomeAmount, (await orderOf(orderId)).companionBaseIncome);

  const adjustments = adjustmentsOf(earning.id);
  assert.equal(adjustments.length, 1, "补记也要留下明细，而且恰好一条");
  assert.equal(adjustments[0].refundId, refundId);
  assert.equal(adjustments[0].amount, refund.decision.companionReversalAmount);
  assert.equal(adjustments[0].type, "refund_reversal");
});

// ————————————— 五、存储层护栏与明细唯一性（独立于伪事务） —————————————

test("存储层护栏：即使调用方算错，收益也不会被冲得比挣的还多，也不会被冲成半截状态", () => {
  // 独立于伪事务，直接打在存储原语上——它是最后一道
  const created = {
    id: unique("earn"),
    companionId: COMPANION_A,
    orderId: unique("ord"),
    orderNo: "P15",
    incomeAmount: 100,
    reversedAmount: 0,
    status: "frozen",
    frozenAt: now(),
    availableAt: null,
    withdrawnAt: null,
    fineAmount: 0,
  };
  const store = earningStore();
  store.earnings.set(created.id, created);
  store.earningIdByOrder.set(created.orderId, created.id);

  applyEarningReversal(created.id, 60);
  assert.equal(store.earnings.get(created.id).reversedAmount, 60);
  /*
    ⚠️ 下面这条不是「产品规则」，是**写原语的契约**（`apply*` 系列只负责写，
    合法性与「这意味着什么」一律由伪事务判定）。P0-15 之后业务路径**不可能**冲到
    只冲一半，因此这个中间态不可达——正因为它不可达，才必须在这里说清楚
    「存储层不在这一步替调用方改状态」，否则后来的人会从这段代码反推出
    「半冲是一个被支持的终态」。
  */
  assert.equal(
    store.earnings.get(created.id).status,
    "frozen",
    "未冲满时留在原状态：存储层不该替调用方决定「这一单算不算白干」",
  );

  // 调用方传到 999：钳制在 incomeAmount 上
  applyEarningReversal(created.id, 999);
  const after = store.earnings.get(created.id);
  assert.equal(after.reversedAmount, 100);
  assert.equal(
    after.status,
    "frozen",
    "P0-15 §二 Q5：冲满之后状态仍是 frozen——净额闸（而不是状态）保证它不再被释放",
  );

  /*
    ⚠️ P0-15 之后**业务路径永远传 `incomeAmount`**（整笔），因此这段钳制
    只在「调用方算错」或「数据被写坏」时才改变结果——它不是死代码，
    而是把 `0 <= reversedAmount <= incomeAmount` 这条不变式钉在存储层，
    而不是交给每个调用方自觉（与 `appendEarningAdjustment` 的重复抛错同理）。
  */
  const exact = {
    ...created,
    id: unique("earn"),
    orderId: unique("ord"),
    reversedAmount: 0,
  };
  store.earnings.set(exact.id, exact);
  store.earningIdByOrder.set(exact.orderId, exact.id);
  applyEarningReversal(exact.id, exact.incomeAmount);
  assert.deepEqual(
    {
      reversedAmount: store.earnings.get(exact.id).reversedAmount,
      status: store.earnings.get(exact.id).status,
    },
    { reversedAmount: 100, status: "frozen" },
    "恰好整笔时一次到位：P0-15 的每一次退款都走这条路，终点状态是 frozen",
  );

  // 负数与 0 不是一次写入
  const before = { ...after };
  assert.equal(applyEarningReversal(created.id, 0).changed, false);
  assert.equal(applyEarningReversal(created.id, -5).changed, false);
  assert.deepEqual(store.earnings.get(created.id), before);
});

test("fix M2：同一 refundId 再追加一条冲回明细 → 存储层抛错，且一个字节都不写", () => {
  const first = {
    id: newEarningAdjustmentId(),
    earningId: "earn-guard",
    orderId: "ord-guard",
    refundId: "ref-guard",
    type: "refund_reversal",
    amount: 100,
    createdAt: now(),
    adminId: "admin-guard",
  };

  appendEarningAdjustment(first);
  assert.equal(
    findEarningAdjustmentIdByRefund("ref-guard"),
    first.id,
    "写完第一条之后，索引必须能读出来（在这之前它只写不读）",
  );

  const countBefore = earningStore().adjustments.size;
  assert.throws(
    () => appendEarningAdjustment({ ...first, id: newEarningAdjustmentId() }),
    /拒绝重复冲回/,
    "同一笔退款决策只能有一条冲回明细——这就是「不存在第二次实际退款」在明细层的落点",
  );

  // 抛错发生在两次写入**之前**，因此存储必须原样不动：既没有多出来的明细，
  // 索引也没有被改指向新的那条
  assert.equal(earningStore().adjustments.size, countBefore, "抛错时不得留下任何写入");
  assert.equal(findEarningAdjustmentIdByRefund("ref-guard"), first.id, "索引不得被改写");
});

test("fix M2：没有明细的 refundId 读出来是 null，不是空串或 undefined", () => {
  assert.equal(findEarningAdjustmentIdByRefund("ref-never-written"), null);
});

// ————————————— 六、退满的副作用、通知与并发 —————————————

test("退满才关派单并通知打手；部分退款两件事都不做", async () => {
  // ⚠️ 用 `cp-10`（有 `userId`）而不是 `cp-1`：`cp-1` 的 `userId` 为 null，
  //    通知**根本不会被构造**，于是「有没有通知」这件事在它身上无法证伪。
  //    这里只看退款类通知，不看通知总数——两次 `completedOrder()` 自身就会
  //    产生一串支付/接单/完成通知，用总数增量断言在退款一条都没发时也成立。
  const partial = await completedOrder({ companionId: NOTIFIABLE_COMPANION });
  const partialRefund = await requestRefund(partial.orderId, partial.user);
  const refundsBefore = refundNotifications().length;
  await approve(partialRefund, decisionBody("50"));

  const dispatchAfterPartial = await getDispatchRepository().findDispatchByOrderId(partial.orderId);
  assert.notEqual(dispatchAfterPartial.state, "timed_out", "部分退款不得关闭派单");
  assert.equal(refundNotifications().length, refundsBefore, "部分退款不通知打手");

  const full = await completedOrder({ companionId: NOTIFIABLE_COMPANION });
  const fullRefund = await requestRefund(full.orderId, full.user);
  await approve(fullRefund, decisionBody("100"));

  const dispatchAfterFull = await getDispatchRepository().findDispatchByOrderId(full.orderId);
  assert.equal(dispatchAfterFull.state, "timed_out", "退满必须关闭派单");
  assert.equal(
    dispatchAfterFull.acceptedByCompanionId,
    NOTIFIABLE_COMPANION,
    "关闭派单不得抹掉「谁接的」这段历史",
  );
  assert.equal(
    (await orderOf(full.orderId)).actualCompanionId,
    NOTIFIABLE_COMPANION,
    "订单也必须留着 actualCompanionId",
  );

  const delivered = refundNotifications();
  assert.equal(delivered.length, refundsBefore + 1, "退满必须给打手留**恰好一条**退款通知");
  assert.equal(delivered.at(-1).userId, NOTIFIABLE_COMPANION_USER, "通知要送到打手的账号上");
});

test("并发防线：退款申请在途时，到点清扫不得把该订单的收益解冻", async () => {
  const { user, orderId, earning } = await completedOrder();
  assert.equal(earning.status, "frozen");

  // 用户提交退款申请 → 这是一条**进行中**的退款，按 §六 必须阻塞结算
  const refundId = await requestRefund(orderId, user);
  assert.equal((await refundOf(refundId)).status, "pending");

  // 越过计划解冻时刻清扫一次：判据里有 `hasActiveRefund`，因此它不该被释放
  const swept = sweepMaturedEarnings(plusMinutes(earning.availableAt, 1));
  assert.equal(
    swept.releasedEarningIds.includes(earning.id),
    false,
    "只要退款流程已经成立，该订单收益就不可能同时被释放",
  );
  assert.equal(earningOfOrder(orderId).status, "frozen", "它必须继续冻结");

  /*
    §十(10)：**refund approved 之后不得再释放该 earning**。

    ⚠️ 这一段的证明力全部来自「退款此刻已经不是 active refund 了」——
    申请已经 `approved`，`hasActiveRefund` 因此**不再挡得住**这次清扫。
    旧口径（整笔冲销进 `reversed`）靠状态挡住了它；P0-15 §二 Q5 把状态改成
    仍然停在 `frozen`，于是**挡住它的只剩净额闸**（`isEarningFullyReversed`）。
    所以下面三个断言必须一起看：时刻已经越过、阻塞判据已经不成立、
    它照样没被释放——少任何一个，这条测试都可能是被别的原因蒙对的。
  */
  await approve(refundId, decisionBody("100"));
  const reversedEarning = earningOfOrder(orderId);
  assert.equal(reversedEarning.status, "frozen", "冲销之后状态仍是 frozen（P0-15 §二 Q5）");
  assert.equal(
    reversedEarning.reversedAmount,
    reversedEarning.incomeAmount,
    "前置：净额确实已经归零——否则下面「没被释放」的原因就说不清了",
  );

  const sweptAgain = sweepMaturedEarnings(plusMinutes(earning.availableAt, 1));
  assert.equal(
    sweptAgain.releasedEarningIds.includes(earning.id),
    false,
    "到点之后也不得释放：此刻挡着它的不再是「在途退款」（申请已批准），而是净额闸",
  );
  assert.equal(earningOfOrder(orderId).status, "frozen", "冲销之后也不会被解冻回来");
});

test("并发防线（正向对照）：没有在途退款时，同一时刻的清扫**必须**把收益解冻", async () => {
  // 这一条是上一条的正向对照。没有它，上一条的「没被释放」可能只是因为这个
  // 构造本身就释放不了（时刻算错、状态不对、订单不是 completed……），
  // 那样断言就永远成立，也就永远证明不了「退款挡住了释放」这件事。
  const { orderId, earning } = await completedOrder();
  const swept = sweepMaturedEarnings(plusMinutes(earning.availableAt, 1));

  assert.ok(
    swept.releasedEarningIds.includes(earning.id),
    "同一时刻、同一张单，只是没有退款申请——它必须是可释放的",
  );
  assert.equal(earningOfOrder(orderId).status, "available");
});

// ——————————— 七、通知文案按场景分档（P0-13 后续 fix M1，仍然有效） ———————————
//
// 独立复核发现（M1）：售后审批退满的打手通知**复用了直接退款那条文案**，
// 而那条文案断言了「客户在**服务开始前**取消」与「本单**不产生收益**」。
// 走售后审批的只有 `serving` / `completed` 两档，这两句话**双双为假**：
// 服务已经开始过；`completed` 的收益也已经生成过并按本次核定结果冲回。
// 产品裁定「按场景拆文案」，下面是钉住这个裁定的用例。

test("fix M1：completed 整单退款 → 通知说「已完成」，不再说「服务开始前取消 / 不产生收益」", async () => {
  const { user, orderId, earning } = await completedOrder({ companionId: NOTIFIABLE_COMPANION });
  const refundId = await requestRefund(orderId, user);
  // ⚠️ 预置数据里本来就有退款类通知，所以只能看**这一次新增的那条**
  const idsBefore = refundNotifications().map((item) => item.id);
  await approve(refundId, decisionBody("100"));

  const mine = refundNotifications().filter((item) => !idsBefore.includes(item.id));
  assert.equal(mine.length, 1, "退满必须留**恰好一条**新的退款通知");
  assert.equal(mine[0].userId, NOTIFIABLE_COMPANION_USER, "通知要送到这位打手的账号上");
  assert.equal(mine[0].title, REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION.title);
  assert.equal(mine[0].summary, REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION.summary);
  assert.equal(mine[0].body, REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION.body);

  // 反例才是这条用例的意义所在：把那条为「还没开始服务」写的文案接回售后路径，
  // 打手会收到一句与账实相反的书面结论（他的收益**已经生成过**，就在下面）
  assert.notEqual(
    mine[0].body,
    REFUND_NOTIFICATION_COMPANION_REFUNDED.body,
    "completed 单不得复用「服务开始前取消」那条文案",
  );
  // ⚠️ 判别串取「开始服务前」——那是**直接退款那条 body 里真实存在的措辞**；
  //    写成「服务开始前」就成了一条恒真的断言（三条 body 里谁都没有那五个字）
  assert.ok(
    !mine[0].body.includes("开始服务前"),
    "completed 单的服务明明已经开始过，不能说「服务开始前」",
  );
  assert.ok(
    !mine[0].body.includes("不产生收益"),
    "completed 单的收益已经生成过，不能说「不产生收益」",
  );
  assert.ok(earning, "前置：completed 单一定有收益");
});

test("fix M1：serving 整单退款 → 通知说「服务已开始」，且「不产生收益」在这里是真的", async () => {
  const { user, orderId } = await servingOrder({ companionId: NOTIFIABLE_COMPANION });
  const refundId = await requestRefund(orderId, user);
  const idsBefore = refundNotifications().map((item) => item.id);
  await approve(refundId, decisionBody("100"));

  const mine = refundNotifications().filter((item) => !idsBefore.includes(item.id));
  assert.equal(mine.length, 1, "退满必须留**恰好一条**新的退款通知");
  assert.equal(mine[0].userId, NOTIFIABLE_COMPANION_USER, "通知要送到这位打手的账号上");
  assert.equal(mine[0].summary, REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE.summary);
  assert.equal(mine[0].body, REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE.body);

  // 同样不能说「开始服务前」——这一单已经 start 过了
  assert.ok(
    !mine[0].body.includes("开始服务前"),
    "serving 单的服务已经开始过，不能说「服务开始前」",
  );
  // 但「不产生收益」在这一档**是成立的**：serving 全额退款不生成 completed Earning
  assert.equal(
    earningOfOrder(orderId),
    null,
    "前置：serving 全额退款不产生 completed 收益——所以那句话在这里是真的",
  );
  assert.ok(mine[0].body.includes("不产生收益"));

  // ⚠️ 但那句话是**面向将来**的结论，「此刻没有收益」还不足以支撑它——
  //    真正会否证它的是「这张单后来又被结算了一次」。这里把结算入口再驱动一遍：
  //    已退款的单不得补建收益，那句话才真的成立（也顺手钉住 `settleOrderCompletion`
  //    对非 serving 单的早返回，这条链路上原本没有用例覆盖）。
  const resettled = settleOrderCompletion({ orderId, at: plusMinutes(now(), 5) });
  assert.equal(resettled?.changed, false, "已退款的单不得再被结算");
  assert.equal(earningOfOrder(orderId), null, "退款之后也不会补建收益——所以那句话为真");
});

test("fix M1：三段文案互不相同——挡住「把直接退款那条接回售后路径」的回归", () => {
  const bodies = [
    REFUND_NOTIFICATION_COMPANION_REFUNDED.body,
    REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION.body,
    REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE.body,
  ];
  assert.equal(new Set(bodies).size, 3, "三段文案必须彼此不同，否则拆文案等于没拆");
});

test("裁定后：paid / accepted 的存量申请**批准被拒**，整条资金链一个字都不动", async () => {
  // 2026-09-27 产品裁定：`paid` / `accepted` 不允许批准售后退款申请
  // （退款路径唯一：这两档走用户直接全额退款）。审核入口因此有了状态闸。
  //
  // 这条用例在**金额链**这一侧再钉一次：被拒的批准必须连**收益与冲回明细**都不碰。
  // 拒的是「存量」——`rf-seed-1001-01` 挂在 `accepted` 的 `ord-seed-1001-03` 上，
  // 是 P0-12 之前的真实历史留痕，不是构造出来的边界。
  const order = paymentStore().orders.get("ord-seed-1001-03");
  assert.ok(order, "前置：这张存量订单还在");
  assert.equal(order.status, "accepted", "前置：它是 accepted——服务确实没开始过");

  const refundBefore = await refundOf("rf-seed-1001-01");
  const idsBefore = refundNotifications().map((item) => item.id);
  const adjustmentsBefore = earningStore().adjustments.size;
  const earningsBefore = earningStore().earnings.size;

  await assert.rejects(
    () => approve("rf-seed-1001-01", decisionBody("100")),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    },
  );

  // 退款申请、订单、通知、收益、冲回明细：一处都没动
  assert.deepEqual(await refundOf("rf-seed-1001-01"), refundBefore, "退款记录不得被改动");
  assert.equal(
    paymentStore().orders.get("ord-seed-1001-03").status,
    "accepted",
    "订单不得被改动",
  );
  assert.equal(
    refundNotifications().filter((item) => !idsBefore.includes(item.id)).length,
    0,
    "被拒的批准不得发出任何通知",
  );
  assert.equal(earningStore().adjustments.size, adjustmentsBefore, "不得写 EarningAdjustment");
  assert.equal(earningStore().earnings.size, earningsBefore, "不得改动收益");
});

// ————————— 八、接口层：只输入比例、幂等、D19 的金额一致 —————————

test("接口层：管理员只输入比例，金额由服务端按订单快照算 —— 请求体里没有金额的位置", async () => {
  const { user, order, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  // 请求体里塞满金额字段、旧责任字段：一律被忽略，算出来的必须是公式值
  const written = await approve(refundId, {
    ...decisionBody("100"),
    refundAmount: 1,
    decidedAmount: 1,
    companionReversalAmount: 99999999,
    platformBorneAmount: -99999999,
    refundedAmount: 1,
    // ⚠️ 责任模型已废止，新写路径**不读**它们。传进来既不是通过条件、也不是报错条件——
    //    它只是两个不被读取的键。旧用例钉的是「非分担制带了责任比例就 400」，
    //    那条规则随责任模型一起消失了（见文件头「已删除的用例」A 组）。
    responsibility: "companion",
    companionLiabilityRatePercent: "50",
  });

  const refund = await refundOf(refundId);
  const expectedRefund = refundForPercent(order, 100);
  const expectedReversal = order.companionBaseIncome;

  assert.equal(refund.decision.refundAmount, expectedRefund);
  assert.equal(refund.decision.refundAmount, order.actualPaidAmount, "100% 就是实付全额");
  assert.equal(refund.decision.companionReversalAmount, expectedReversal);
  assert.equal(refund.decision.companionReversalAmount, order.companionBaseIncome, "100% 冲满");
  assert.equal(written.decidedAmount, expectedRefund, "响应里报的必须是服务端真正写下去的那个数");

  // 决策上没有责任字段的任何痕迹
  assert.deepEqual(
    Object.keys(refund.decision).sort(),
    ["companionReversalAmount", "decidedAt", "decidedBy", "refundAmount", "refundRateBp"],
  );
});

test("接口层：「比例没填」与「比例填错」是两条不同的提示，且都不写一个字节", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  // 「没填」：空字符串是「这个框空着」，不是「0%」
  await assert.rejects(
    () => approve(refundId, { refundRatePercent: "" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    () => approve(refundId, {}),
    (error) => {
      assert.equal(error.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);
      return true;
    },
  );

  // 「填错」：不是 1~3 位数字，或超出 0~100
  await assert.rejects(
    () => approve(refundId, { refundRatePercent: "abc" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_RATE_INVALID_MESSAGE);
      return true;
    },
  );
  await assert.rejects(
    () => approve(refundId, { refundRatePercent: "101" }),
    (error) => {
      assert.equal(error.message, REFUND_DECISION_RATE_INVALID_MESSAGE);
      return true;
    },
  );

  // 四种情况都是「一个字节都没写」
  const refund = await refundOf(refundId);
  assert.equal(refund.status, "pending");
  assert.equal(refund.decision, null);
  assert.equal((await orderOf(orderId)).refundedAmount, 0);
});

test("幂等：同一次退款决策重放不会冲回两次（明细与累计额都不动）", async () => {
  const { user, orderId, earning } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  const operationId = unique("p15key");

  const first = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    ...decisionBody("25"),
  });
  assert.equal(first.changed, true);
  const afterFirst = earningOfOrder(orderId).reversedAmount;
  assert.ok(afterFirst > 0);

  const replay = await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: operationId,
    ...decisionBody("25"),
  });
  assert.equal(replay.changed, false, "同键重放不算改动");
  assert.equal(replay.decidedAmount, first.decidedAmount, "重放报回的仍然是当时写下的那个金额");

  const after = earningOfOrder(orderId);
  assert.equal(after.reversedAmount, afterFirst, "重放不得再冲一次");
  assert.equal(adjustmentsOf(earning.id).length, 1, "重放不得多写一条明细");
  assert.equal(
    [...adminAuditStore().audits.values()].filter((entry) => entry.targetId === refundId).length,
    1,
  );
});

test("详情 DTO：订单六个冻结字段直接搬运，已删除的「剩余 / 累计 / 收益状态」确实不在 DTO 上", async () => {
  const { user, order, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  const detail = await getAdminRefundDetail(refundId, undefined, "server");
  assert.ok(detail);
  const money = detail.orderMoney;

  // ① 六个字段逐项等于订单自己的冻结快照——一个都不重算
  assert.equal(money.originalAmount, order.originalAmount);
  assert.equal(money.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(money.actualPaidAmount, order.actualPaidAmount, "比例的基数就是订单实付");
  assert.equal(money.refundedAmount, order.refundedAmount);
  assert.equal(money.companionBaseIncome, order.companionBaseIncome, "退款批准后整笔冲回的就是它");
  assert.equal(money.clubNetIncome, order.clubNetIncome);

  // ② 字段集合**恰好**是这六个：多一个少一个都算规则变了
  assert.deepEqual(
    Object.keys(money).sort(),
    [
      "actualPaidAmount",
      "clubNetIncome",
      "companionBaseIncome",
      "couponDiscountAmount",
      "originalAmount",
      "refundedAmount",
    ],
  );

  // ③ 三个被 P0-15 删掉的字段必须真的不在（它们各自都曾是一个「新规则下没有对应事实」的数字）：
  //    `remainingRefundableAmount`（一单一退，没有「还能退多少」这个上限概念）、
  //    `reversedSoFarAmount`（冲回额恒为整笔，没有可累计的对象）、
  //    `companionEarningStatus`（D17 的问题被取消，没有需要解释的例外）
  for (const gone of [
    "remainingRefundableAmount",
    "reversedSoFarAmount",
    "companionEarningStatus",
  ]) {
    assert.equal(gone in money, false, `已删除的字段 ${gone} 不得回到订单金额快照上`);
  }

  // ④ 用户端与客服端同样看不到这些（可见性边界：金额结果给，决策依据不给）
  const userDetail = await getRefundDetailForUser(refundId, user, undefined, "server");
  assert.ok(userDetail);
  assert.equal("orderMoney" in userDetail, false);
});

test("预览与服务端写下去的金额逐项相等（只有比例一种形态）", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);

  const detail = await getAdminRefundDetail(refundId, undefined, "server");
  const preview = previewRefundDecisionAmounts({
    orderMoney: detail.orderMoney,
    refundRatePercent: "30",
  });
  assert.equal(preview.ok, true, "预览必须算得出来");
  assert.equal(preview.gateMessage, null, "这组比例不该被金额闸拦下");
  assert.deepEqual(
    Object.keys(preview.amounts).sort(),
    ["companionReversalAmount", "refundAmount"],
    "预览的金额形状与服务端决策同形——只有两个数",
  );

  const written = await approve(refundId, decisionBody("30"));
  const stored = (await refundOf(refundId)).decision;
  assert.ok(stored);

  assert.equal(
    preview.amounts.refundAmount,
    written.decidedAmount,
    "退款金额：界面上的预计值与响应里的一致",
  );
  assert.equal(
    preview.amounts.refundAmount,
    stored.refundAmount,
    "退款金额：与真正写进退款记录的决策一致",
  );
  assert.equal(
    preview.amounts.companionReversalAmount,
    stored.companionReversalAmount,
    "打手冲回额：与写下去的一致",
  );
  assert.equal(
    stored.companionReversalAmount,
    detail.orderMoney.companionBaseIncome,
    "而它就是订单快照上的那份打手收益——两处不是各算一遍",
  );
});

test("预览的「会被金额闸拦下」与服务端金额闸是同一个判断（判据是实付，不是「剩余可退」）", async () => {
  const { user, orderId } = await servingOrder();

  // 造出「订单身上已经带了一笔历史已退额、却没有任何退款申请」这一种现实形态。
  // 它在当前业务里只有两个来源：`directRefundTransaction` 的免审批直接退款、
  // `companionDispatchTransaction` 的派单超时自动退款——这两条**都不写
  // `RefundRequest`**（全仓三个 `applyOrderRefund` 调用方，只有
  // `adminRefundTransaction` 会写申请记录）。走写入原语把它写上去，订单保持 serving。
  const base = await orderOf(orderId);
  const historical = Math.floor(base.actualPaidAmount / 2);
  const written = applyOrderRefund(orderId, now(), historical);
  assert.ok(written);
  assert.equal(written.updated.refundedAmount, historical);
  assert.equal(written.updated.status, "serving", "前置：这一笔是部分的，订单没被推成已退款");

  const refundId = await requestRefund(orderId, user);
  const detail = await getAdminRefundDetail(refundId, undefined, "server");

  // 100% 算出来的退款额 = 实付，而订单已经退过一半 ⇒ 累计必然超过实付
  const preview = previewRefundDecisionAmounts({
    orderMoney: detail.orderMoney,
    refundRatePercent: "100",
  });
  assert.equal(preview.ok, true);
  assert.equal(
    preview.gateMessage,
    REFUND_DECISION_EXCEEDS_PAID_MESSAGE,
    "判据是「实付 − 已退」剩下的那部分，界面必须在提交之前就说出**同一句话**",
  );

  // 服务端给出的是**同一个判断**的另一种表达：它拒绝，并说明原因
  await assert.rejects(
    () => approve(refundId, decisionBody("100")),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, REFUND_DECISION_EXCEEDS_PAID_MESSAGE);
      return true;
    },
  );

  // 被拒之后账上一动不动
  assert.equal((await orderOf(orderId)).refundedAmount, historical);
  assert.equal((await refundOf(refundId)).decision, null);
});

test("预览：比例没填时说「还没算出来」，填错时说规则层那句话", () => {
  const orderMoney = {
    originalAmount: 5000,
    couponDiscountAmount: 0,
    actualPaidAmount: 5000,
    refundedAmount: 0,
    companionBaseIncome: 2000,
    clubNetIncome: 3000,
  };

  // 什么都没填：这一位是「还没填」，不是「填了 0%」
  const empty = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: "" });
  assert.equal(empty.ok, false);
  assert.equal(empty.message, REFUND_DECISION_RATE_REQUIRED_MESSAGE);

  // 填错：非数字、越界，都走规则层那句
  for (const bad of ["abc", "101", "1.5"]) {
    const invalid = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: bad });
    assert.equal(invalid.ok, false, `${bad} 必须算不出来`);
    assert.equal(invalid.message, REFUND_DECISION_RATE_INVALID_MESSAGE, `${bad} 的提示必须来自规则层`);
  }

  // 算得出来的一组：界面上的数与服务端同源（同一个公式函数）
  const ok = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: "50" });
  assert.equal(ok.ok, true);
  assert.equal(ok.amounts.refundAmount, 2500);
  assert.equal(ok.amounts.companionReversalAmount, 2000, "冲回额是整笔，不是 2000 × 50%");
  assert.equal(ok.gateMessage, null);

  // 0%：形态合法、金额为 0。预览说出的必须是**金额闸自己那句话**，
  // 而不是「超过实付」——账实不符的警告比不警告更坏（P0-15 删掉了
  // 那个把两者混为一谈的 `exceedsPaid` 布尔）。
  const zero = previewRefundDecisionAmounts({ orderMoney, refundRatePercent: "0" });
  assert.equal(zero.ok, true);
  assert.equal(zero.amounts.refundAmount, 0);
  assert.equal(
    zero.gateMessage,
    REFUND_DECISION_AMOUNT_ZERO_MESSAGE,
    "0 元的真实原因是「退款金额为 0」，不得答成「超过实付」",
  );
});

// ————————————— 九、可见性与审计：谁看得到钱、留了什么痕 —————————————

test("可见性：责任字段在整个系统里已经不存在；决策金额只给管理员，客服与用户只看得到结果", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("40"));

  const decided = (await refundOf(refundId)).decision;
  assert.ok(decided);
  assert.ok(decided.refundAmount > 0);

  // 管理员：完整决策（五项俱全，且**只有**这五项）
  const admin = await getAdminRefundDetail(refundId, undefined, "server");
  assert.deepEqual(admin.decision, decided);
  assert.equal(admin.decidedAmount, decided.refundAmount);

  // 责任模型在**任何** DTO 上都不该有痕迹——连管理员也拿不到
  for (const [label, dto] of [
    ["管理员", admin],
    ["客服", await getStaffRefundDetail(refundId, undefined, "server")],
    ["用户", await getRefundDetailForUser(refundId, user, undefined, "server")],
  ]) {
    const json = JSON.stringify(dto);
    for (const forbidden of [
      "responsibility",
      "companionLiabilityRate",
      "platformBorneAmount",
      "refundFullRemaining",
    ]) {
      assert.equal(json.includes(forbidden), false, `${label} DTO 出现了已废止的字段 ${forbidden}`);
    }
  }

  // 客服：只看得到结果金额，看不到比例与打手冲回额（那是管理员的决策依据）
  const staff = await getStaffRefundDetail(refundId, undefined, "server");
  assert.ok(staff);
  assert.equal(staff.decidedAmount, decided.refundAmount);
  assert.equal("decision" in staff, false, "客服不得拿到完整的资金决策");
  const staffJson = JSON.stringify(staff);
  for (const forbidden of ["refundRateBp", "companionReversalAmount"]) {
    assert.equal(staffJson.includes(forbidden), false, `客服 DTO 出现了 ${forbidden}`);
  }

  // 用户：同样只看得到结果
  const userDetail = await getRefundDetailForUser(refundId, user, undefined, "server");
  assert.ok(userDetail);
  assert.equal(userDetail.decidedAmount, decided.refundAmount);
  assert.equal("decision" in userDetail, false, "用户不得拿到完整的资金决策");
  const userJson = JSON.stringify(userDetail);
  for (const forbidden of ["refundRateBp", "companionReversalAmount"]) {
    assert.equal(userJson.includes(forbidden), false, `用户 DTO 出现了 ${forbidden}`);
  }
});

test("D14：审计快照留下**三项**决策字段，事后能回答「这一次退了多少、从打手冲回多少」", async () => {
  const { user, orderId } = await completedOrder();
  const refundId = await requestRefund(orderId, user);
  await approve(refundId, decisionBody("40"));

  const decision = (await refundOf(refundId)).decision;
  const entries = [...adminAuditStore().audits.values()].filter(
    (entry) => entry.targetId === refundId && entry.action === "refund.approve",
  );
  assert.equal(entries.length, 1);
  const after = entries[0].after;

  assert.equal(after.refundRateBp, decision.refundRateBp);
  assert.equal(after.refundAmount, decision.refundAmount);
  assert.equal(after.companionReversalAmount, decision.companionReversalAmount);

  /*
    ⚠️ P0-15 删掉了四项，**不是漏记**：

    | 删掉的字段 | 为什么 |
    |---|---|
    | `responsibility` / `companionLiabilityRateBp` | 属于已废止的责任模型，审计不该继续追问一件新业务里不存在的事 |
    | `refundFullRemaining` | 属于已废止的「多步退款补尾差」模型；今天全额退款就是比例 100 |
    | `platformBorneAmount` | **尤其不能留**：它的定义在新规则下**恒等于 `refundAmount`**（打手全额归零、平台承担全部退款额），记一个永远等于另一个字段的数只是多一份可能对不上的副本 |

    剩下三项仍然守着「一个不少、一个不多」：它们与 `RefundDecision` 一一对应。
  */
  for (const gone of [
    "responsibility",
    "companionLiabilityRateBp",
    "refundFullRemaining",
    "platformBorneAmount",
  ]) {
    assert.equal(gone in after, false, `审计快照不得留下已废止的字段 ${gone}`);
  }
});
