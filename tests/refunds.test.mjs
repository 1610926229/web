import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  DIRECT_REFUNDABLE_ORDER_STATUSES,
  REFUND_ALREADY_EXISTS_MESSAGE,
  REFUND_NOT_CANCELLABLE_MESSAGE,
  REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  REFUNDABLE_ORDER_STATUSES,
  canDirectRefund,
  canRequestRefund,
  hasRefundPath,
  isOrderRefundable,
} from "../lib/constants/refunds.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { rejectAdminRefund } from "../lib/services/adminRefunds.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { refundSeed } from "../lib/mocks/fixtures/refundSeed.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import {
  cancelRefundForUser,
  createRefundForOrder,
  getOrderRefundSummary,
  getRefundDetailForUser,
} from "../lib/services/refunds.ts";
import { getConsumptionLevelForUser } from "../lib/services/levels.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";

/**
 * 退款业务（**申请**路径）的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/refunds.ts`，
 * 因此「哪些订单能申请」「提交不改订单状态与累计消费」「**一个订单只有一次申请**」
 * 「只有待审核能撤销」「看不到别人的退款」这些规则每次提交都会被重新验证。
 *
 * ⚠️ **P0-12 起本文件只覆盖「申请」这一条路径**：`paid` / `accepted` 两档改为
 * **免审批直接全额退款**，不再产生待审核申请，它们的行为由
 * `tests/directRefund.test.mjs` 覆盖。本文件里**没有任何用例**应当拿这两档去调
 * `createRefundForOrder`——那正是 P0-12 要挡住的事（有一条用例专门断言它被挡住）。
 *
 * ⚠️ 剩下的两档里包含**已完成**：它才是唯一计入消费的状态，不能申请就等于
 * 那笔已计入的钱永远退不掉（口径见 `lib/constants/levels.ts`）。放开的是入口，
 * 不是流程——提交仍然只产生一条待审核记录，订单要等管理者审核通过才会变。
 *
 * ## ⚠️ P0-15（2026-09-28）把「能有几条申请」反转回了起点
 *
 * | 轮次 | 这一单还能不能再申请 | 依据 |
 * |---|---|---|
 * | P0-13 之前 | 有**任何**记录就不能 | 「一笔订单一次全额退」 |
 * | P0-13（D10） | 已拒绝 / 已撤销之后**可以**再申请 | 部分退款要能退第二次 |
 * | **P0-15**（当前） | 有**任何**记录就不能（**提交过即封死**） | 「一个订单最多一次退款申请、最多一次实际退款执行」 |
 *
 * 本文件里两条 D10 时期的用例（「已拒绝过之后可以再次申请」「已撤销过之后可以再次申请」）
 * 因此被**改成它们的反面**，而不是删掉——被推翻的判断必须留在原地可见：
 * 今天若有人把「已拒绝也能再申请」加回来，红的会是这两条。
 *
 * ⚠️ 被逆转的是「次数」，不是「状态先行」：判据**顺序**没变——
 * 「已提交过」比「订单状态不允许」更具体，两种都拒绝、文案不同。
 *
 * 每个用例开始前重建退款 store（拿到干净的预置数据）。订单 store 不重建：
 * **申请退款本来就不该改动订单**，任何用例把订单改了都应当在这里暴露出来。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/**
 * 没有预置退款记录、且**走申请路径**可退的订单（每个用例用不同的一单，互不干扰）。
 *
 * 只剩两档：护航中 / 已完成。其中 `FREE_COMPLETED_ORDER` 是**唯一会被计入消费**的那种：
 * 消费口径只认已完成（`CONSUMPTION_ORDER_STATUS`），所以「已完成能不能退」是
 * 「已计入的钱能不能退」这个问题的全部。
 */
const FREE_SERVING_ORDER = "ord-seed-1001-10";
const FREE_COMPLETED_ORDER = "ord-seed-1001-05";

/**
 * 已付款 / 已接单两档：**P0-12 起不走申请**，因此它们在本文件里只用来验证
 * 「申请入口必须消失、申请接口必须拒绝，而且拒绝之后一笔记录都不留」。
 */
const DIRECT_ONLY_PAID_ORDER = "ord-seed-1001-02";
const DIRECT_ONLY_ACCEPTED_ORDER = "ord-seed-1001-11";
/** 已退款但**没有**退款记录的订单：用来验证「状态本身不可退」这条，而不是「已有记录」那条 */
const REFUNDED_ORDER = "ord-seed-1001-13";
/** 别人（u-1002）的已完成订单：验证「能退」没有把归属校验一起放开 */
const OTHER_USER_COMPLETED_ORDER = "ord-seed-1002-02";
/**
 * 预置了「已拒绝」退款的订单（**已付款**，P0-12 前留下的存量记录）。
 *
 * 它验的是「已有记录」这一条**先于**状态判定：这一单本来就已经不能申请了
 * （已付款走直接退款），但接口回答的是「已提交过一次退款申请」而不是「当前不可申请」——
 * 对用户来说前者才是他需要知道的事。两条都是拒绝，顺序决定了提示有没有用。
 *
 * ⚠️ P0-13（D10）时期这条记录的「已结束」不影响任何判断，于是这里答的是**状态**那一句；
 * **P0-15 把它翻回去了**：记录**是**挡板，不论它停在哪个状态。
 */
const REJECTED_PRESET_ORDER = "ord-seed-1001-01";
/** 预置了「待审核」退款的订单（**已接单**，同样是存量记录） */
const PENDING_PRESET_ORDER = "ord-seed-1001-03";

function key() {
  return crypto.randomUUID();
}

function refundBody(overrides = {}) {
  return {
    reasonKey: "other",
    description: "临时有事，这一单打不了了，麻烦帮我退掉。",
    evidence: [],
    idempotencyKey: key(),
    ...overrides,
  };
}

async function orderStatus(orderId, userId = USER_A) {
  const detail = await getOrderDetailForUser(orderId, userId, undefined, "server");
  return detail?.status ?? null;
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("refund");
});

test("可申请退款的状态：护航中 / 已完成——已付款与已接单必须被挡在申请之外", async () => {
  for (const orderId of [FREE_SERVING_ORDER, FREE_COMPLETED_ORDER]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.ok(isOrderRefundable(detail.status), `${orderId} 应当是可申请状态`);
    assert.equal(
      detail.allowedActions.canRequestRefund,
      true,
      `${orderId}（${detail.status}）的订单详情必须给出申请退款入口`,
    );

    const result = await createRefundForOrder(orderId, USER_A, refundBody(), undefined, "server");
    assert.ok(result.refundId);
    assert.equal(result.created, true);
  }

  // P0-12：这两档属「尚未开始服务」，走免审批直接退款，因此**申请入口不该存在**。
  // 断言到「接口也拒绝」而不只是「按钮不显示」——按钮只是提示，不是权限
  for (const orderId of [DIRECT_ONLY_PAID_ORDER, DIRECT_ONLY_ACCEPTED_ORDER]) {
    const detail = await getOrderDetailForUser(orderId, USER_A, undefined, "server");
    assert.equal(
      detail.allowedActions.canRequestRefund,
      false,
      `${orderId}（${detail.status}）不该再给出申请退款入口`,
    );
    assert.equal(detail.allowedActions.canDirectRefund, true, `${orderId} 应当改走直接全额退款`);

    await expectApiError(
      createRefundForOrder(orderId, USER_A, refundBody(), undefined, "server"),
      "BAD_REQUEST",
      REFUND_ORDER_NOT_ALLOWED_MESSAGE,
    );
    assert.equal(await getOrderRefundSummary(orderId), null, "被拒的申请不得留下任何记录");
  }
});

test("提交退款后订单状态不变，退款自身是「待审核」且金额等于订单实付", async () => {
  const before = await getOrderDetailForUser(FREE_SERVING_ORDER, USER_A, undefined, "server");

  const { refundId } = await createRefundForOrder(
    FREE_SERVING_ORDER,
    USER_A,
    refundBody({ reasonKey: "schedule_conflict" }),
    undefined,
    "server",
  );

  // 1. 订单状态一个字段都没变
  const after = await getOrderDetailForUser(FREE_SERVING_ORDER, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.notEqual(after.status, "refunded");

  // 2. 订单详情里多出的是「退款摘要」，不是订单状态的变化
  assert.equal(after.refundSummary.id, refundId);
  assert.equal(after.refundSummary.status, "pending");
  // 已经有退款记录了，入口随之消失（能不能退由服务端给，前端不推断）
  assert.equal(after.allowedActions.canRequestRefund, false);

  // 3. 退款金额取订单实付金额，退款状态是用户唯一能提交出来的「待审核」
  // ⚠️ 读 `actualPaidAmount`（P1-4）：退款以**实付**为基数（裁定 §10），
  // 优惠前的原价不是退款上限
  const refund = await getRefundDetailForUser(refundId, USER_A, undefined, "server");
  assert.equal(refund.status, "pending");
  assert.equal(refund.amount, before.actualPaidAmount);
  assert.equal(refund.reasonKey, "schedule_conflict");
  assert.equal(refund.orderStatus, before.status);
});

test("金额由服务端决定：请求体里塞 amount 也不会被采纳", async () => {
  const detail = await getOrderDetailForUser(FREE_SERVING_ORDER, USER_A, undefined, "server");
  const { refundId } = await createRefundForOrder(
    FREE_SERVING_ORDER,
    USER_A,
    refundBody({ amount: 1, totalAmount: 1 }),
    undefined,
    "server",
  );

  const refund = await getRefundDetailForUser(refundId, USER_A, undefined, "server");
  assert.equal(refund.amount, detail.actualPaidAmount);
  assert.notEqual(refund.amount, 1);
});

test("已完成能提交；已退款是真不能申请的那一种", async () => {
  // 已完成是**唯一计入消费**的状态，因此它必须能退：不能退就等于那笔已计入的钱退不掉
  const submitted = await createRefundForOrder(
    FREE_COMPLETED_ORDER,
    USER_A,
    refundBody(),
    undefined,
    "server",
  );
  assert.equal(submitted.created, true);
  assert.equal((await getOrderRefundSummary(FREE_COMPLETED_ORDER)).status, "pending");

  // 已退款：钱已经退过了，状态本身就不该再有入口
  await expectApiError(
    createRefundForOrder(REFUNDED_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ORDER_NOT_ALLOWED_MESSAGE,
  );
  // 失败的提交不能留下任何记录
  assert.equal(await getOrderRefundSummary(REFUNDED_ORDER), null);
});

test("提交已完成订单的退款：订单仍是已完成，消费等级与排行榜一点都不变", async () => {
  const before = await getOrderDetailForUser(FREE_COMPLETED_ORDER, USER_A, undefined, "server");
  assert.equal(before.status, "completed");

  // 等级摘要（含累计有效消费金额）与累计榜的「我的排名」都先记下来
  const levelBefore = await getConsumptionLevelForUser(USER_A, undefined, "server");
  const rankingBefore = await getConsumptionRanking(
    USER_A,
    new URLSearchParams({ period: "all" }),
    "server",
    getMockSeedNow(),
  );
  assert.ok(levelBefore.effectiveSpendAmount > 0, "这一单必须真的被计入过消费，否则这条断言没有说服力");

  await createRefundForOrder(FREE_COMPLETED_ORDER, USER_A, refundBody(), undefined, "server");

  // 1. 订单状态一个字段都没变，多出来的只是一条待审核的退款摘要
  const after = await getOrderDetailForUser(FREE_COMPLETED_ORDER, USER_A, undefined, "server");
  assert.equal(after.status, before.status);
  assert.notEqual(after.status, "refunded");
  assert.deepEqual(Object.keys(after.refundSummary).sort(), ["amount", "createdAt", "id", "status"]);
  assert.equal(after.refundSummary.status, "pending");
  assert.equal(after.refundSummary.amount, before.actualPaidAmount);

  // 2. 消费等级：金额一分不少（提交退款不立即修改累计消费）
  const levelAfter = await getConsumptionLevelForUser(USER_A, undefined, "server");
  assert.deepEqual(levelAfter, levelBefore, "提交退款不该动累计消费与等级");

  // 3. 排行榜：整张榜一字不变（名次、金额、上榜的人都不能因为「有人提交了退款」而变）
  const rankingAfter = await getConsumptionRanking(
    USER_A,
    new URLSearchParams({ period: "all" }),
    "server",
    getMockSeedNow(),
  );
  assert.deepEqual(rankingAfter.rows, rankingBefore.rows, "提交退款不该影响任何一期的排行榜");
  assert.deepEqual(rankingAfter.me, rankingBefore.me);
});

test("一个订单只允许一次退款申请：第二次提交被拒，且只有那一条记录", async () => {
  // 先提交一条，再用另一个幂等键提交第二条：应当被挡住，且只有一条记录
  const first = await createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server");
  await expectApiError(
    createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ALREADY_EXISTS_MESSAGE,
  );

  const summary = await getOrderRefundSummary(FREE_SERVING_ORDER);
  assert.equal(summary.id, first.refundId);
  assert.equal(summary.status, "pending");
  assert.equal(await orderStatus(FREE_SERVING_ORDER), "serving", "被拒的第二次提交不得动订单");
});

test("已有记录这件事先于状态判定：两种存量记录都答「已提交过一次退款申请」", async () => {
  /*
    ⚠️ **P0-15 起「记录」本身就是挡板，与它停在哪个状态无关**：
    - `PENDING_PRESET_ORDER`（待审核，挂在**已接单**单上）——P0-13 与今天都挡住，
      但文案换了：从「有一笔正在处理」（可以等）改成「已提交过一次退款申请」（等不到了）；
    - `REJECTED_PRESET_ORDER`（已拒绝，挂在**已付款**单上）——P0-13（D10）时期这一条
      **不挡**，提示回落到「当前不可申请」；P0-15 把它翻回去了。

    两条都必须是同一个答案、同一句话：用户要知道的是「这一单的退款机会用掉了」，
    而不是「现在是哪一档订单」——后者会让他以为换个状态或者等一等就还能再申请一次。
    顺序（记录 → 状态）没有变，这是刻意保留的：两种都拒绝，但前者才是他该知道的。
  */
  for (const orderId of [PENDING_PRESET_ORDER, REJECTED_PRESET_ORDER]) {
    await expectApiError(
      createRefundForOrder(orderId, USER_A, refundBody(), undefined, "server"),
      "BAD_REQUEST",
      REFUND_ALREADY_EXISTS_MESSAGE,
    );
    // 被拒的提交不产生第二条记录：那一条存量记录原样留着
    const summary = await getOrderRefundSummary(orderId);
    assert.equal(summary.status, orderId === PENDING_PRESET_ORDER ? "pending" : "rejected");
  }
});

/**
 * P0-15 的**行为后果**：已拒绝过的订单**不能**再次申请。
 *
 * ⚠️ 这条用例是 D10（P0-13）那条「已拒绝过之后可以再次申请」的**反面**。
 * 「管理员拒一次，用户此单再无退款渠道」这个后果是产品 2026-09-28 **看见并接受**的
 * （`P0-15/02-decisions.md` Q2），因此它必须是一条被钉住的规则而不是一句注释：
 * 拒绝**消耗掉**这一单唯一的机会。若有人把它改回「被拒后可再申请」，
 * 红的会是这一条与下面那条「已撤销」——那会是一次**新的产品规则**，
 * 而不是顺手放宽。
 */
test("已拒绝过之后不能再申请：拒绝就消耗掉这一单的退款机会", async () => {
  const first = await createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server");
  await rejectAdminRefund(first.refundId, "admin-1", {
    idempotencyKey: key(),
    reviewNote: "本次不予退款，请补充说明后重新申请。",
  });

  await expectApiError(
    createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ALREADY_EXISTS_MESSAGE,
  );

  // 留下的仍然是那一条被拒绝的记录，而不是一条新的待审核
  const summary = await getOrderRefundSummary(FREE_SERVING_ORDER);
  assert.equal(summary.id, first.refundId);
  assert.equal(summary.status, "rejected");

  // 拒绝与（被拒的）再次申请都不动订单：它按原进度继续
  assert.equal(await orderStatus(FREE_SERVING_ORDER), "serving");
});

/** 已撤销同样消耗掉机会（P0-15 的另一半）：用户撤销之后这一单也再不能申请。 */
test("已撤销过之后不能再申请：撤销同样消耗掉这一单的退款机会", async () => {
  const first = await createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server");
  await cancelRefundForUser(first.refundId, USER_A);

  await expectApiError(
    createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server"),
    "BAD_REQUEST",
    REFUND_ALREADY_EXISTS_MESSAGE,
  );

  const summary = await getOrderRefundSummary(FREE_SERVING_ORDER);
  assert.equal(summary.id, first.refundId);
  assert.equal(summary.status, "cancelled");
});

test("同一个幂等键重复提交只产生一条记录", async () => {
  const body = refundBody();
  const first = await createRefundForOrder(FREE_COMPLETED_ORDER, USER_A, body, undefined, "server");
  const second = await createRefundForOrder(FREE_COMPLETED_ORDER, USER_A, body, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.refundId, first.refundId);
});

test("只有待审核的退款可以撤销；撤销不改动订单状态", async () => {
  const before = await orderStatus(FREE_SERVING_ORDER);
  const { refundId } = await createRefundForOrder(FREE_SERVING_ORDER, USER_A, refundBody(), undefined, "server");

  const cancelled = await cancelRefundForUser(refundId, USER_A);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await orderStatus(FREE_SERVING_ORDER), before);

  // 撤销后再次撤销：状态已经不是待审核
  await expectApiError(cancelRefundForUser(refundId, USER_A), "BAD_REQUEST", REFUND_NOT_CANCELLABLE_MESSAGE);
});

test("审核中 / 已通过 / 已拒绝的退款都不能由用户撤销", async () => {
  const reviewing = refundSeed.find((refund) => refund.status === "reviewing");
  const approved = refundSeed.find((refund) => refund.status === "approved");
  const rejected = refundSeed.find((refund) => refund.status === "rejected");

  for (const refund of [reviewing, approved, rejected]) {
    await expectApiError(
      cancelRefundForUser(refund.id, USER_A),
      "BAD_REQUEST",
      REFUND_NOT_CANCELLABLE_MESSAGE,
    );
  }

  // 撤销失败不能留下任何状态变化
  const stillReviewing = await getRefundDetailForUser(reviewing.id, USER_A, undefined, "server");
  assert.equal(stillReviewing.status, "reviewing");
});

test("用户隔离：看不到、也撤销不了别人的退款申请", async () => {
  const otherPending = refundSeed.find((refund) => refund.userId === USER_B && refund.status === "pending");

  // 对方看 u-1001 的退款：不存在与不属于自己表现完全一致
  assert.equal(await getRefundDetailForUser(refundSeed[0].id, USER_B, undefined, "server"), null);
  // u-1001 看 u-1002 的退款同样拿不到
  assert.equal(await getRefundDetailForUser(otherPending.id, USER_A, undefined, "server"), null);

  // 撤销别人的申请：NOT_FOUND，而不是「不是你的」
  await expectApiError(cancelRefundForUser(otherPending.id, USER_A), "NOT_FOUND");

  // 撤销失败后对方的数据完好
  const intact = await getRefundDetailForUser(otherPending.id, USER_B, undefined, "server");
  assert.equal(intact.status, "pending");
});

test("给别人订单提交退款：404，且不产生记录", async () => {
  // 一笔是干净订单（没有退款记录），一笔本来就有记录：两种都不该被改动
  const clean = OTHER_USER_COMPLETED_ORDER;
  const withRecord = "ord-seed-1002-01";

  // 归属校验在「能不能退」之前：放开了已完成可退，也**没有**放开「能退别人的已完成订单」
  assert.equal(
    (await getOrderDetailForUser(clean, USER_B, undefined, "server")).status,
    "completed",
    "这一单必须是已完成，才谈得上「放开已完成可退没把归属一起放开」",
  );
  await expectApiError(
    createRefundForOrder(clean, USER_A, refundBody(), undefined, "server"),
    "NOT_FOUND",
  );
  await expectApiError(
    createRefundForOrder(withRecord, USER_A, refundBody(), undefined, "server"),
    "NOT_FOUND",
  );

  assert.equal(await getOrderRefundSummary(clean), null);
  const untouched = await getOrderRefundSummary(withRecord);
  assert.equal(untouched.id, "rf-seed-1002-01");
  assert.equal(untouched.status, "pending");
});

test("预置数据自洽：已通过的退款对应已退款的订单，进行中的退款不改变订单状态", () => {
  for (const refund of refundSeed) {
    const order = orderSeed.find((item) => item.id === refund.orderId);
    assert.ok(order, `预置退款 ${refund.id} 关联的订单不存在`);
    assert.equal(order.userId, refund.userId, `预置退款 ${refund.id} 与订单归属不一致`);
    // 退款额 = 订单**实付**（P1-4）：种子订单没有券，两个数相等，
    // 但这里写 `actualPaidAmount` 才是那条规则本身
    assert.equal(refund.amount, order.actualPaidAmount);

    if (refund.status === "approved") {
      assert.equal(order.status, "refunded", `已通过的退款 ${refund.id} 对应订单必须是已退款`);
    } else {
      assert.notEqual(order.status, "refunded", `未通过的退款 ${refund.id} 对应订单不能是已退款`);
    }
    if (refund.status === "pending" || refund.status === "reviewing") {
      // ⚠️ 判的是 `hasRefundPath`（还有没有路可走），**不是** `isOrderRefundable`
      // （能不能再提交一次申请）。预置数据里有两条进行中的申请挂在已付款 / 已接单的
      // 订单上——那是 P0-12 之前留下的存量，有意保留；用后者去判等于让预置数据
      // 否认一段真实的业务历史。见 `refundSeed.ts` 不变量 2 的说明。
      //
      // ⚠️ 这两条**过得了本用例，也过不了审核**（产品裁定 2026-09-27）：它们可以被
      // 驳回，但不能被批准。本用例管的是「预置数据自不自洽」，那条闸管的是
      // 「审核入口准不准写」，两者不冲突——见 `tests/adminRefunds.test.mjs`
      assert.ok(hasRefundPath(order.status), `进行中的退款 ${refund.id} 对应订单必须仍可退款`);
    }
  }

  // 五种状态在预置数据里都能看到（页面才能被完整验收）
  const statuses = new Set(refundSeed.map((refund) => refund.status));
  for (const status of ["pending", "reviewing", "approved", "rejected", "cancelled"]) {
    assert.ok(statuses.has(status), `预置数据缺少 ${status} 状态的退款`);
  }
});

test("DTO 边界：退款摘要不含原因、说明与凭证", async () => {
  const summary = await getOrderRefundSummary(PENDING_PRESET_ORDER);
  assert.deepEqual(Object.keys(summary).sort(), ["amount", "createdAt", "id", "status"]);
});

test("纯规则函数：canRequestRefund 同时看订单状态与有无**任何**退款记录", () => {
  // 只有「已开始服务」之后的两档能申请——包含**已完成**：它是唯一计入消费的状态，
  // 不能申请就等于那笔已计入的钱退不掉
  assert.equal(canRequestRefund("serving", false), true);
  assert.equal(canRequestRefund("completed", false), true);
  // P0-12：这两档属「尚未开始服务」，走免审批直接全额退款，因此申请入口必须为假
  assert.equal(canRequestRefund("paid", false), false);
  assert.equal(canRequestRefund("accepted", false), false);
  // 已退款是真不可退：钱已经退过了
  assert.equal(canRequestRefund("refunded", false), false);

  /*
    ⚠️ **第二个入参的含义在 P0-13 与 P0-15 之间来回改了一次**（形参名也跟着改了，
    见 `lib/constants/refunds.ts` 的那张表）：

    | 轮次 | 形参名 | 语义 |
    |---|---|---|
    | P0-13 之前 | `hasRefundRecord` | 有**任何**记录就挡 |
    | P0-13 | `hasActiveRefund` | 只挡**进行中**的 |
    | **P0-15**（当前） | `hasRefundRecord` | 有**任何**记录就挡 |

    因此这里两种取值都要钉住：
    - **传 `true`（有任何记录）**：不论订单停在哪一档，一律没有入口——
      这一半挡的是「一个订单只能申请一次」；
    - **传 `false`（还没有任何记录）**：入口**照状态给**——
      这一半挡的是「能退的订单必须显示得出来」。

    两半缺一不可：只留前者，规则会退化成「谁都申请不了」也能通过；
    只留后者，重复申请就完全失去约束。删注释的时候尤其要注意
    **第二半不是**在替 P0-13 的 D10 说话（「已结束的记录不挡」），那句话已被推翻。
  */
  for (const status of ["paid", "accepted", "serving", "completed"]) {
    assert.equal(
      canRequestRefund(status, true),
      false,
      `${status} 只要已经有退款记录就不该再出现入口（不论那条记录停在哪个状态）`,
    );
  }
  assert.equal(canRequestRefund("serving", false), true, "没有记录时，护航中的入口照给");
  assert.equal(canRequestRefund("completed", false), true, "没有记录时，已完成的入口照给");
  assert.equal(canRequestRefund("paid", false), false, "没有记录也不会让 paid 变得可申请");
});

test("纯规则函数：两条退款路径的状态集合不相交，且合起来正好是「还有路可走」的四档", () => {
  for (const status of ["paid", "accepted", "serving", "completed", "refunded", "cancelled"]) {
    assert.equal(
      canRequestRefund(status, false) && canDirectRefund(status),
      false,
      `${status} 同时落在两条退款路径上——同一档订单会出现两种互斥的业务结果`,
    );
    assert.equal(
      hasRefundPath(status),
      canRequestRefund(status, false) || canDirectRefund(status),
      `${status} 的 hasRefundPath 必须恰好等于两条路径的并集`,
    );
  }

  // 「还有路可走」恰好是原来那四档：P0-12 没有缩减哪些订单能退，只是把一条路拆成两条
  const open = ["paid", "accepted", "serving", "completed"];
  for (const status of open) assert.equal(hasRefundPath(status), true, `${status} 应当还有路可走`);
  for (const status of ["refunded", "cancelled", "pending_payment"]) {
    assert.equal(hasRefundPath(status), false, `${status} 不该还有退款路径`);
  }
  // 两条路合起来覆盖了那四档，一档也不少——少一档就意味着某种订单的钱退不出来
  assert.deepEqual(
    [...DIRECT_REFUNDABLE_ORDER_STATUSES, ...REFUNDABLE_ORDER_STATUSES].sort(),
    [...open].sort(),
  );
});
