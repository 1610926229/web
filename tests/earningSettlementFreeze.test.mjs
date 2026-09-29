import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { isComplaintWindowClosed } from "../lib/constants/complaints.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  EARNING_FULLY_REVERSED_HINT,
  EARNING_STATUS_HINTS,
  EARNING_STATUS_LABELS,
  earningHintFor,
  earningNetAmount,
  isEarningFullyReversed,
} from "../lib/constants/earnings.ts";
import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLAINT_WINDOW_MAX_MINUTES,
  COMPLAINT_WINDOW_MIN_MINUTES,
} from "../lib/constants/platformConfig.ts";
import { REFUND_WINDOW_CLOSED_MESSAGE } from "../lib/constants/refunds.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import { approveCompletion, submitCompletion } from "../lib/data/completionTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { sweepMaturedEarnings } from "../lib/data/earningTransaction.ts";
import { earningStore } from "../lib/data/mockEarningRepository.ts";
import { updatePlatformConfig } from "../lib/data/adminPlatformConfigTransaction.ts";
import { readPlatformConfig } from "../lib/data/mockPlatformConfigRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { readOrderBlockingFacts } from "../lib/data/orderBlocking.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { approveAdminRefund } from "../lib/services/adminRefunds.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { createComplaintForUser } from "../lib/services/complaints.ts";
import { createRefundForOrder } from "../lib/services/refunds.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-15「收益冻结与结算释放」的**专属**回归（产品负责人 2026-09-28 补充并修正）。
 *
 * 本文件只钉一条线：**订单完成后打手这笔钱什么时候、在什么条件下才允许变成可提现**，
 * 以及退款一旦成立之后它**永远不能**变成可提现。规则来源：
 * `docs/03-dev/rounds/P0-15/02-decisions.md`（当前轮次的最终执行口径，优先于需求文档）。
 *
 * 覆盖的六条规则：
 * 1. 投诉 / 售后窗口可配置（`PlatformConfig.complaintWindowMinutes`，默认 1440、60~10080），
 *    **订单完成时**读一次并快照到订单上，之后改配置**不追溯**；
 * 2. 完成后到本单 `complaintDeadlineAt` 之前，`Earning.status === "frozen"`，不可提前释放；
 * 3. 只要还有**有效退款申请 / 未完结投诉**（`readOrderBlockingFacts`），
 *    即使截止已过也必须继续冻结；
 * 4. 退款批准后打手这一单收益**整笔取消**（净额 0，与退款比例无关，D8 → `reversed`）；
 * 5. 不存在「普通退款 → withdrawn 追偿」这条路（不引入钱包 / 负余额 / 追偿，Q1-V2）；
 * 6. 释放必须**在同一段原子区段里、写下去之前重新判定阻塞**，不得依赖之前读到的状态（D14）。
 *
 * 时间一律**显式传入**（`sweepMaturedEarnings(at)`），不引入 fake timer、不改系统时钟——
 * 与 `tests/earning.test.mjs` 同一条口径。「截止已过」既可用注入的未来 `at` 造，
 * 也可用「窗口 60 分钟 + 完成于 90 分钟前」的真过去造，两种都在这份文件里用到。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const COMPANION_A = "cp-1";
const ADMIN = "admin-1";
const STAFF = { id: "staff-1", name: "客服小雨" };

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function now() {
  return new Date().toISOString();
}

/**
 * 每个用例从**干净状态**开始，不依赖执行顺序。
 *
 * 九份 store 全部重置：这张单一路要跑通「下单 → 接单 → 服务中 → 完成 → 退款」，
 * 任何一份残留都会让前一个用例的写入漏进后一个（例如前一个用例的退款申请
 * 会让后一个用例的「无阻塞 → 释放」变成有阻塞 → 释放）。
 */
beforeEach(() => {
  for (const name of [
    "earning",
    "payment",
    "dispatch",
    "completion",
    "platformConfig",
    "complaint",
    "refund",
    "adminAudit",
    "notification",
    "companionRelease",
  ]) {
    resetMockStore(name);
  }
});

// ——————————————————————————— 读取与断言辅助 ———————————————————————————

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

function earningsOfOrder(orderId) {
  return [...earningStore().earnings.values()].filter((earning) => earning.orderId === orderId);
}

/** 该收益的全部调整明细（`reversedAmount` 的审计侧真值源）。 */
function adjustmentsOf(earningId) {
  return [...earningStore().adjustments.values()].filter(
    (adjustment) => adjustment.earningId === earningId,
  );
}

/**
 * 计划解冻时刻（`availableAt`）。
 *
 * 本文件里它从不为 null（订单 completed 必有 deadline 快照），因此断言出来是安全的——
 * 用一个取值函数而不是 `earning.availableAt` 直接传进 `plusMinutes`，
 * 是为了让「拿不到计划值」这件事在测试里立刻炸掉，而不是静默地把 `null` 传下去。
 */
function availableAtOf(earning) {
  assert.equal(typeof earning.availableAt, "string", "本用例的收益必须有计划解冻时刻");
  return earning.availableAt;
}

// ——————————————————————————— 构造数据 ———————————————————————————

/** 走完整下单链路，返回订单。 */
async function placeOrder(user) {
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
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return confirmed.order;
}

/** 改投诉窗口——走真实的伪事务（`PATCHABLE_FIELDS` 的第四个字段）。 */
async function setComplaintWindow(minutes) {
  const result = await updatePlatformConfig(
    { complaintWindowMinutes: minutes },
    {
      actorId: ADMIN,
      actorRole: "admin",
      actorName: null,
      operationId: unique("op-p15"),
      at: now(),
    },
  );
  assert.equal(result.kind, "ok", "改投诉窗口必须成功");
  assert.equal(readPlatformConfig().complaintWindowMinutes, minutes, "配置必须真的写下去了");
}

/**
 * 把一张**新订单**走完整条链路推到 `completed`，并返回它的收益。
 *
 * 链路里三个时刻从 `completedAt` **倒推**（接单 −41 / 开始服务 −21 / 提交完成材料 −11），
 * 与 `tests/earning.test.mjs` / `tests/refundMoneyChain.test.mjs` 同一套关系，
 * 因此不需要重新论证链路自身的先后。完成来源取**客服人工通过**（自动通过那条路
 * 已在 `tests/earning.test.mjs` 覆盖，这里不重复）。
 */
async function completedOrder({
  companionId = COMPANION_A,
  completedAt,
  user = unique("u-p15"),
} = {}) {
  const at = completedAt ?? plusMinutes(now(), 62);
  const placed = await placeOrder(user);
  const orderId = placed.id;

  const dispatch = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(dispatch, "支付成功后必须有一条派单记录");

  const accepted = await acceptDispatch(dispatch.id, { companionId, at: plusMinutes(at, -41) });
  assert.equal(accepted.kind, "ok", "这条用例需要一次成功的接单");

  const started = await startCompanionOrderTransaction({
    companionId,
    orderId,
    at: plusMinutes(at, -21),
  });
  assert.equal(started.kind, "ok", "这条用例需要一次成功的开始服务");

  const submitted = await submitCompletion({
    companionId,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(at, -11),
  });
  assert.equal(submitted.kind, "ok", "这条用例需要一份在途完成材料");

  const approved = await approveCompletion({
    submissionId: submitted.submissionId,
    staffId: STAFF.id,
    staffName: STAFF.name,
    at,
  });
  assert.equal(approved.kind, "ok", "这条用例需要一次成功的客服通过");

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed", "前置条件：订单必须走到 completed");
  assert.equal(order.completedAt, at, "前置条件：完成时刻就是传入的那一刻");

  const earning = earningsOfOrder(orderId)[0];
  assert.ok(earning, "前置条件：completed 必须生成一条收益");
  assert.equal(earning.status, "frozen", "前置条件：收益刚生成时是冻结的");
  assert.equal(earning.reversedAmount, 0, "前置条件：还没有任何冲回");
  return { user, order, orderId, earning, completedAt: at };
}

function refundBody(overrides = {}) {
  return {
    reasonKey: "other",
    description: "临时有事，这一单打不了了，麻烦帮我退掉。",
    evidence: [],
    idempotencyKey: unique("p15key"),
    ...overrides,
  };
}

/** 用户提交退款申请（走真实服务层），返回退款 id。 */
async function requestRefund(orderId, userId) {
  const result = await createRefundForOrder(orderId, userId, refundBody(), undefined, "server");
  assert.equal(result.created, true, "这一单必须是第一次申请退款");
  return result.refundId;
}

/** 管理员按比例批准一笔退款（P0-15：请求体只有一个比例）。 */
async function approveRefund(refundId, ratePercent) {
  await approveAdminRefund(refundId, ADMIN, {
    idempotencyKey: unique("p15key"),
    refundRatePercent: ratePercent,
  });
}

// ═══════════════════ 一、窗口可配置 + 快照 + 不追溯 ═══════════════════

test("窗口 1：complaintWindowMinutes 可配置——改配置之后新完成的订单用新值", async () => {
  assert.equal(
    readPlatformConfig().complaintWindowMinutes,
    COMPLAINT_WINDOW_DEFAULT_MINUTES,
    "默认是 1440 分钟（产品裁定：24 小时）",
  );

  await setComplaintWindow(120);
  const first = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  assert.equal(first.order.complaintWindowMinutesSnapshot, 120, "第一次完成用的是 120");

  const threeDays = 3 * 24 * 60;
  await setComplaintWindow(threeDays);
  const second = await completedOrder({ completedAt: plusMinutes(now(), 62) });

  assert.equal(readPlatformConfig().complaintWindowMinutes, threeDays, "配置确实改掉了");
  assert.equal(
    second.order.complaintWindowMinutesSnapshot,
    threeDays,
    "改配置之后**新完成**的订单必须用新值",
  );
  assert.equal(
    second.order.complaintDeadlineAt,
    plusMinutes(second.order.completedAt, threeDays),
    "新窗口必须真的作用到 deadline 上，而不是只存了个快照",
  );
  // 「只影响此后」的另一半：老订单仍然是 120
  assert.equal((await orderOf(first.orderId)).complaintWindowMinutesSnapshot, 120);
});

test("窗口 2：订单完成时把当时的窗口快照到订单上，并据此算出 complaintDeadlineAt", async () => {
  const minutes = 180;
  await setComplaintWindow(minutes);

  const completedAt = plusMinutes(now(), 62);
  const { order, earning } = await completedOrder({ completedAt });

  assert.equal(order.complaintWindowMinutesSnapshot, minutes, "快照取**完成那一刻**的配置值");
  assert.equal(order.completedAt, completedAt);
  assert.equal(
    order.complaintDeadlineAt,
    plusMinutes(order.completedAt, minutes),
    "deadline === completedAt + 快照（分钟加法只有 plusMinutes 一份实现）",
  );

  // 收益的两条时间事实：冻结时刻 = 完成时刻；计划解冻时刻 = 本单投诉截止（同一件事）
  assert.equal(earning.frozenAt, completedAt, "冻结时刻 = 订单进入 completed 的那一刻");
  assert.equal(
    earning.availableAt,
    order.complaintDeadlineAt,
    "收益的计划解冻时刻与本单投诉截止必须是同一个时刻，不能各算一遍",
  );

  // 未完成的订单没有窗口：null 表示「还没有窗口」，不是「立刻关闭」
  const paying = await placeOrder(unique("u-p15"));
  assert.equal(paying.complaintWindowMinutesSnapshot, null);
  assert.equal(paying.complaintDeadlineAt, null);
});

test("窗口 3：改配置不改老订单的 complaintDeadlineAt——先完成、再改配置、再读回，逐字节不变", async () => {
  await setComplaintWindow(120);
  const { orderId } = await completedOrder({ completedAt: plusMinutes(now(), 62) });

  const orderBefore = await orderOf(orderId);
  const earningBefore = earningsOfOrder(orderId)[0];

  // 调大：不得把老订单的截止时刻往后推
  await setComplaintWindow(COMPLAINT_WINDOW_MAX_MINUTES);
  assert.deepEqual(
    await orderOf(orderId),
    orderBefore,
    "调大窗口之后老订单必须**逐字节不变**（快照 / deadline / 其它字段一个都不许动）",
  );
  assert.deepEqual(
    earningsOfOrder(orderId)[0],
    earningBefore,
    "收益的冻结时长同样不追溯（否则一次改配置会同时给打手提前或延后放款）",
  );

  // 调小：同理，不得让老订单提前解冻
  await setComplaintWindow(COMPLAINT_WINDOW_MIN_MINUTES);
  assert.deepEqual(await orderOf(orderId), orderBefore, "调小窗口不得让历史订单提前解冻");
  assert.deepEqual(earningsOfOrder(orderId)[0], earningBefore, "收益记录仍然一个字节没变");
});

// ═══════════════════ 二、冻结期内不可释放 ═══════════════════

test("冻结 4：截止时刻之前 Earning 恒为 frozen——即使 sweep 被调用也不动", async () => {
  const completedAt = plusMinutes(now(), 62);
  const { orderId } = await completedOrder({ completedAt });
  const earning = earningsOfOrder(orderId)[0];
  const deadline = availableAtOf(earning);
  assert.equal(
    deadline,
    plusMinutes(completedAt, COMPLAINT_WINDOW_DEFAULT_MINUTES),
    "前置：默认窗口 1440 分钟",
  );

  for (const at of [completedAt, plusMinutes(deadline, -1)]) {
    const swept = sweepMaturedEarnings(at);
    assert.deepEqual(swept.releasedEarningIds, [], `at=${at} 还没到点：一条都不许释放`);
  }

  const after = earningsOfOrder(orderId)[0];
  assert.equal(after.status, "frozen", "冻结期内状态恒为 frozen，不得提前变成 available");
  assert.deepEqual(after, earning, "未到期的清扫必须一个字节都不写");
});

// ═══════════════════ 三、阻塞 → 即使截止已过也继续冻结 ═══════════════════

test("阻塞 5：截止已过、但存在有效退款申请 → 仍然 frozen", async () => {
  const { user, orderId } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  await requestRefund(orderId, user);
  const facts = readOrderBlockingFacts(orderId);
  assert.equal(
    facts.hasActiveRefund,
    true,
    "刚提交的申请是 pending——它本身就是「有效退款」，足以挡住结算",
  );

  const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
  assert.deepEqual(swept.releasedEarningIds, [], "有进行中的退款就必须挡住放款");
  assert.equal(
    earningsOfOrder(orderId)[0].status,
    "frozen",
    "截止时刻已过，但退款还没结束——收益必须继续冻结",
  );
});

test("阻塞 6：截止已过、但存在投诉 → 仍然 frozen", async () => {
  const { user, orderId } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  const created = await createComplaintForUser(
    user,
    {
      typeKey: "companion_service",
      description: "约好的时间打手迟到了四十分钟，也没有提前说明。",
      contact: "",
      evidence: [],
      orderId,
      idempotencyKey: unique("p15key"),
    },
    undefined,
    "server",
  );
  assert.equal(created.created, true, "窗口内提交投诉必须被接受");
  assert.equal(
    readOrderBlockingFacts(orderId).hasUnresolvedComplaint,
    true,
    "新投诉是 pending——未完结，算阻塞",
  );

  const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
  assert.deepEqual(swept.releasedEarningIds, [], "有未完结投诉就必须挡住放款");
  assert.equal(earningsOfOrder(orderId)[0].status, "frozen", "投诉未完结期间收益必须继续冻结");
});

test("释放 7：截止已过、且没有任何阻塞 → 变成 available", async () => {
  const { orderId } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  assert.deepEqual(
    readOrderBlockingFacts(orderId),
    { hasActiveRefund: false, hasUnresolvedComplaint: false },
    "这一条要有意义，前置必须是**真的**没有任何阻塞",
  );

  const swept = sweepMaturedEarnings(deadline);
  assert.equal(swept.releasedEarningIds.length, 1, "截止已到（含边界）且无阻塞：必须释放");
  assert.equal(swept.releasedEarningIds[0], earningsOfOrder(orderId)[0].id);

  const after = earningsOfOrder(orderId)[0];
  assert.equal(after.status, "available");
  assert.equal(after.availableAt, deadline, "availableAt 是**计划值**，释放不刷新它");
});

// ═══════════════════ 四、退款批准后的收益 ═══════════════════

test("退款 8：退款批准时收益被整笔冲销，但状态仍停在 frozen——绝不出现 available（P0-15 §二 Q5）", async () => {
  const { user, orderId, earning } = await completedOrder({ completedAt: plusMinutes(now(), 62) });

  // 前置：正常退款发生在**结算冻结阶段**——批准之前它确实是 frozen
  // （Q1-V2 的理由：退款只能发生在 serving / completed，即 frozen 期或更早，
  //  因此退款落地时收益必然还没到可提现）
  assert.equal(earning.status, "frozen");
  assert.equal(earning.reversedAmount, 0);

  await approveRefund(await requestRefund(orderId, user), "30");

  const after = earningsOfOrder(orderId)[0];
  // 「退款不能让收益变成可提现」是这条用例真正要守的东西
  assert.notEqual(after.status, "available", "退款绝不能让收益变成可提现");
  // P0-15 §二 Q5（产品裁定，推翻了本轮早先的 D8）：指令 ②§四 那句
  // 「处理对象应当仍是 Earning.status = frozen」是**结果**，不是前提——
  // 整笔冲销之后状态**就停在 frozen**。所以这里断言的是 frozen，不是 reversed。
  assert.equal(after.status, "frozen", "整笔冲销之后状态仍是 frozen（§二 Q5）");
  assert.equal(after.availableAt, earning.availableAt, "计划解冻时刻不因退款改写");
  assert.equal(after.reversedAmount, after.incomeAmount, "冲回额 = 原额，且不超过它");
  assert.equal(after.incomeAmount, earning.incomeAmount, "incomeAmount 保留历史快照，不因冲回变小");
  assert.equal(after.frozenAt, earning.frozenAt, "冻结时刻是历史事实，不因退款改写");
  assert.equal(EARNING_STATUS_LABELS.frozen, "冻结中");
});

test("退款 9：退款批准后打手净收益 === 0——10% / 30% / 50% / 100% 一律归零", async () => {
  for (const rate of ["10", "30", "50", "100"]) {
    const { user, orderId, earning } = await completedOrder({
      completedAt: plusMinutes(now(), 62),
    });
    await approveRefund(await requestRefund(orderId, user), rate);

    const after = earningsOfOrder(orderId)[0];
    assert.equal(
      after.reversedAmount,
      after.incomeAmount,
      `退 ${rate}%：冲回额必须等于**全额**，与退款比例无关`,
    );
    assert.equal(after.incomeAmount - after.reversedAmount, 0, `退 ${rate}%：净收益必须是 0`);

    // 用**恰好一条**调整把净额归零（既不能 0 条，也不能 2 条）
    const adjustments = adjustmentsOf(earning.id);
    assert.equal(adjustments.length, 1, `退 ${rate}%：必须恰好留下一条冲回明细`);
    assert.equal(adjustments[0].amount, after.incomeAmount, `退 ${rate}%：明细金额等于整笔收益`);

    // 打手端 DTO 的净额也必须是 0（服务端算好，页面不做减法）
    const dto = (await listCompanionEarnings(COMPANION_A)).items.find(
      (item) => item.orderId === orderId,
    );
    assert.ok(dto, `退 ${rate}%：打手必须能读到这一条收益`);
    assert.equal(dto.netAmount, 0, `退 ${rate}%：DTO 上的净额也必须是 0`);
    assert.equal(dto.status, "frozen", `退 ${rate}%：DTO 状态仍是 frozen（§二 Q5）`);
    // 打手端看到的那句话必须说「钱没了」，而不是查表得到的那句
    // 「到期自动转为可提现」——那对一笔永远不解冻的收益是假话
    assert.equal(
      dto.statusLabel,
      EARNING_STATUS_LABELS.frozen,
      `退 ${rate}%：状态名仍按状态给（冻结中），这不是错——它确实冻结着`,
    );
  }
});

test("退款 10：退款批准之后收益不得再被释放——时间推过截止点再 sweep 仍是 frozen", async () => {
  const { user, orderId, earning } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  const deadline = availableAtOf(earning);
  await approveRefund(await requestRefund(orderId, user), "30");

  const before = earningsOfOrder(orderId)[0];
  assert.equal(before.status, "frozen", "前置：批准之后状态停在 frozen（§二 Q5）");
  assert.equal(before.reversedAmount, before.incomeAmount, "前置：净额已经归零");

  /*
    ⚠️ **正向控制：必须是净额闸挡住的，而不是别的原因。**

    这条用例的全部意义在于「已经批准、不再有在途退款，可它到点还是没被释放」。
    若不作下面这两个前置断言，同样一个「没被释放」的结果也可能是被
    「时间没到」或「(早已批准的)退款仍被算作 active refund」蒙对的——
    那样这条用例会永远变绿，却什么都证明不了。
  */
  assert.equal(before.availableAt, deadline, "前置：这一笔的计划解冻时刻就是下面的 deadline");
  assert.equal(
    readOrderBlockingFacts(orderId).hasActiveRefund,
    false,
    "前置：申请已批准 → 不再是在途退款，§三 的阻塞判据此刻已经不成立",
  );

  for (const at of [deadline, plusMinutes(deadline, 600)]) {
    const swept = sweepMaturedEarnings(at);
    assert.deepEqual(swept.releasedEarningIds, [], `at=${at}：已冲光的收益永远不得被释放`);
  }

  const after = earningsOfOrder(orderId)[0];
  // ⚠️ 这里**不能**只断言「不是 available」：状态本来就停在 frozen，
  // 「没被释放」必须由「它还在 frozen 且净额为 0」共同表达。
  assert.equal(after.status, "frozen", "时间推过截止点也不会改变它");
  assert.equal(after.reversedAmount, after.incomeAmount, "净额仍然是 0——这就是它没被释放的原因");
  assert.deepEqual(after, before, "重复的释放尝试一个字节都不许改");
});

test("退款 10b：净额闸与那句说明——两个纯函数的边界（P0-15 §二 Q5）", () => {
  /* ── A. `isEarningFullyReversed`：判据就是「净额还在不在」 ── */
  assert.equal(
    isEarningFullyReversed({ incomeAmount: 3672, reversedAmount: 0 }),
    false,
    "没冲过：净额还在，可释放",
  );
  assert.equal(
    isEarningFullyReversed({ incomeAmount: 3672, reversedAmount: 3671 }),
    false,
    "还差 1 分：净额仍为正，闸不放行的是「归零」，不是「冲过」",
  );
  assert.equal(
    isEarningFullyReversed({ incomeAmount: 3672, reversedAmount: 3672 }),
    true,
    "恰好整笔：这就是 P0-15 每一次退款的情形",
  );
  assert.equal(
    isEarningFullyReversed({ incomeAmount: 3672, reversedAmount: 9999 }),
    true,
    "越过（只可能来自被写坏的数据）：同样不放行——多冲不可能换来一次释放",
  );

  /*
   * ── A2. `earningNetAmount`：净额的**唯一**算式 ──
   *
   * 它有三个下游、都会把金额显示给打手看：「我的收益」列表（`companionEarnings.ts`）、
   * P1-5 的收入榜（`companionRankings.ts`）、打手订单列表的「本单收益」（`companionOrders.ts`）。
   * 这几个数对不上时没人能判断哪一边是错的，所以这里同时钉住
   * 「算式本身」与「三处真的是同一个函数」。
   *
   * ⚠️ 第一版只列了两个下游，**恰好漏掉 `companionOrders.ts`**（它自己抄了一遍算式），
   * 而手写清单漏一个文件时测试仍然是绿的。见下面那条**扫整棵源码树**的门禁。
   */
  assert.equal(earningNetAmount({ incomeAmount: 3672, reversedAmount: 0 }), 3672, "没冲过就是原额");
  assert.equal(earningNetAmount({ incomeAmount: 3672, reversedAmount: 500 }), 3172, "部分冲回");
  assert.equal(earningNetAmount({ incomeAmount: 3672, reversedAmount: 3672 }), 0, "整笔冲光即 0");
  assert.equal(
    earningNetAmount({ incomeAmount: 3672, reversedAmount: 9999 }),
    -6327,
    "**不钳制**：被写坏的数据要暴露成负数，不能在算式里被静默抹平成 0",
  );

  // 与闸同源：净额为 0 与「整笔已冲回」必须是同一个判据的两个说法
  assert.equal(
    isEarningFullyReversed({ incomeAmount: 3672, reversedAmount: 3672 }),
    earningNetAmount({ incomeAmount: 3672, reversedAmount: 3672 }) === 0,
  );

  // 三处下游真的共用这一个函数（源码级断言：算式不得在别处重写第二遍）
  for (const [name, source] of [
    ["lib/constants/companionRankings.ts", readSource(path.join(ROOT, "lib", "constants", "companionRankings.ts"))],
    ["lib/services/companionEarnings.ts", readSource(path.join(ROOT, "lib", "services", "companionEarnings.ts"))],
    ["lib/services/companionOrders.ts", readSource(path.join(ROOT, "lib", "services", "companionOrders.ts"))],
  ]) {
    assert.match(source, /earningNetAmount\(/, `${name} 必须用共用算式`);
  }

  /*
   * 而「不得在别处再写一遍」这句话**必须扫整棵源码树**，不能手写一份下游清单。
   *
   * ⚠️ 第一版正是手写清单：它列了收入榜与收益页两个文件，**恰好漏掉**
   * `lib/services/companionOrders.ts`（打手订单列表的 `netIncomeAmount` 自己抄了一遍）。
   * 手写清单漏一个文件时测试仍然是绿的——它给出的「别处没有重写」是**假安全感**。
   * 所以这里改成「穷举 `lib` / `components` / `app` 下所有 `.ts` / `.tsx`」，
   * 只豁免算式自己的定义处：将来多出第四个副本时会**自动**变红，不需要有人记得加清单。
   */
  const NET_AMOUNT_DEFINITION = path.join("lib", "constants", "earnings.ts");
  const netAmountFormula = /incomeAmount\s*-\s*\w+\.?reversedAmount|reversedAmount\s*-\s*\w*\.?incomeAmount/;
  const scanned = ["lib", "components", "app"]
    .flatMap((dir) => collectFiles(path.join(ROOT, dir)))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts"));
  // 至少要扫到下面这几个已知文件，否则「扫描为空」也会让这条断言空洞地通过
  for (const must of [
    path.join("lib", "constants", "earnings.ts"),
    path.join("lib", "constants", "companionRankings.ts"),
    path.join("lib", "services", "companionEarnings.ts"),
    path.join("lib", "services", "companionOrders.ts"),
  ]) {
    assert.ok(
      scanned.some((file) => file.endsWith(must)),
      `扫描清单里必须有 ${must}（否则这条门禁可能扫了个空）`,
    );
  }
  const rewritten = scanned.filter(
    (file) =>
      !file.endsWith(NET_AMOUNT_DEFINITION) && netAmountFormula.test(stripComments(readSource(file))),
  );
  assert.deepEqual(
    rewritten.map((file) => path.relative(ROOT, file).replace(/\\/g, "/")),
    [],
    "净额算式只允许出现在 lib/constants/earnings.ts：其它文件一律用 earningNetAmount()",
  );

  /* ── B. `earningHintFor`：净额归零的那笔不能说「到期自动转为可提现」 ── */
  const frozenHint = EARNING_STATUS_HINTS.frozen;
  assert.equal(
    earningHintFor({ status: "frozen", netAmount: 0 }),
    EARNING_FULLY_REVERSED_HINT,
    "净额为 0 的 frozen：必须说「已被全部冲回」，而不是那句永远不会发生的话",
  );
  assert.notEqual(
    earningHintFor({ status: "frozen", netAmount: 0 }),
    frozenHint,
    "⚠️ 与上一句同义，但单独钉一次：这两句一旦相等，打手端就会看到一句假话",
  );

  // 正向对照：净额还在时，它必须**照旧**给出原来那句——否则上面两条可能只是
  // 「这个函数永远返回同一句话」而蒙对的
  assert.equal(
    earningHintFor({ status: "frozen", netAmount: 3672 }),
    frozenHint,
    "正向对照：正常冻结中的收益仍然说「到期自动转为可提现」",
  );
  assert.equal(
    earningHintFor({ status: "available", netAmount: 3672 }),
    EARNING_STATUS_HINTS.available,
    "正向对照：可提现的收益不受这条规则影响",
  );
});

// ═══════════════════ 五、并发保护 ═══════════════════

test("并发 11：退款与到期释放争同一张单——收益不会与进行中的退款同时被放出去", async () => {
  /* ── A. 退款申请先成立 → 同一个 tick 内立刻请求释放：必须被重新判定挡住 ── */
  {
    const { user, orderId } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
    const deadline = availableAtOf(earningsOfOrder(orderId)[0]);
    await requestRefund(orderId, user);
    assert.equal(
      readOrderBlockingFacts(orderId).hasActiveRefund,
      true,
      "前置：退款申请此刻确实处于进行中",
    );

    // 同一个 tick、连续多次释放尝试（含**截止之后**的时刻）：一次都不许放。
    // 这就是「退款流程一旦成立，收益就永不可能同时被释放」的落点——
    // 释放事务在写下去之前重新读了一次阻塞事实，因此它读到的必然是这个 pending 申请。
    for (const at of [deadline, plusMinutes(deadline, 1), plusMinutes(deadline, 600)]) {
      const swept = sweepMaturedEarnings(at);
      assert.deepEqual(
        swept.releasedEarningIds,
        [],
        `at=${at}：存在进行中的退款时必须重新判定并挡住释放`,
      );
    }

    const blocked = earningsOfOrder(orderId)[0];
    assert.equal(blocked.status, "frozen", "有进行中的退款时，收益永远停留在 frozen");
    assert.equal(blocked.availableAt, deadline, "被挡住不改变计划解冻时刻");
  }

  /* ── B. 反方向：截止之后**不可能**再提交退款申请 → 「先释放、退款后到」这条路不存在 ── */
  {
    await setComplaintWindow(COMPLAINT_WINDOW_MIN_MINUTES); // 60 分钟
    const { user, orderId } = await completedOrder({ completedAt: plusMinutes(now(), -90) });

    const order = await orderOf(orderId);
    assert.equal(
      isComplaintWindowClosed(order, now()),
      true,
      "前置：这一单的售后 / 投诉窗口已经关闭（deadline = 完成时刻 + 60，落在 30 分钟前）",
    );

    await assert.rejects(
      () => createRefundForOrder(orderId, user, refundBody(), undefined, "server"),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(
          error.message,
          REFUND_WINDOW_CLOSED_MESSAGE,
          "窗口关闭之后必须明确拒绝，而不是静默受理",
        );
        return true;
      },
    );
    assert.equal(
      await getRefundRepository().findRefundByOrderId(orderId),
      null,
      "被拒的申请不得留下任何记录",
    );

    // 此刻不存在任何退款，释放可以发生——但它成立的那一刻，退款已经**不可能**再成立。
    // 这正是「释放与退款不可能同时发生」的另一半：两者的时间窗是同一条边界。
    const swept = sweepMaturedEarnings(now());
    assert.equal(swept.releasedEarningIds.length, 1, "无阻塞且已到期：释放成立");
    assert.equal(earningsOfOrder(orderId)[0].status, "available");
    assert.equal(
      await getRefundRepository().findRefundByOrderId(orderId),
      null,
      "释放之后依然没有退款申请——两条路径在时间上不可能同时成立",
    );
  }

  /* ── C. 结构：释放的「重读阻塞」与「写入」在同一个无 await 的原子区段，且释放只有一个出口 ── */
  {
    const tx = stripComments(readSource(path.join(ROOT, "lib", "data", "earningTransaction.ts")));
    assert.equal(/\bawait\b/.test(tx), false, "收益伪事务里出现 await，原子性立刻消失");
    assert.equal(
      /export\s+async\s+function/.test(tx),
      false,
      "sweepMaturedEarnings 必须是同步函数（要能在原子区段里被调用）",
    );

    const sweepBody = tx.slice(tx.indexOf("export function sweepMaturedEarnings"));
    const readAt = sweepBody.indexOf("readOrderBlockingFacts(");
    const writeAt = sweepBody.indexOf("applyEarningRelease(");
    assert.ok(readAt !== -1, "释放事务必须在写下去之前**重新读一次**阻塞事实");
    assert.ok(writeAt !== -1, "释放的写入点必须在同一个函数体内");
    assert.ok(
      readAt < writeAt,
      "阻塞事实的读取必须排在释放写入之前——这就是「不依赖页面/服务层之前读到的状态」的落点",
    );

    // 「释放」只有一个出口：`applyEarningRelease` 全仓只有一个调用点（多一个就多一条绕过判定的路）
    const callSites = [];
    for (const file of collectFiles(path.join(ROOT, "lib"))) {
      const count = (stripComments(readSource(file)).match(/applyEarningRelease\(/g) ?? []).length;
      if (count > 0) callSites.push({ file: path.relative(ROOT, file), count });
    }
    assert.deepEqual(
      callSites.sort((a, b) => a.file.localeCompare(b.file)),
      [
        { file: path.join("lib", "data", "earningTransaction.ts"), count: 1 },
        { file: path.join("lib", "data", "mockEarningRepository.ts"), count: 1 },
      ],
      "释放原语只能有一个调用点（sweep 的提交阶段），多一个就多一条绕过阻塞判定的路",
    );
  }
});

// ═══════════════════ 六、订单状态仍按真实退款程度处理 ═══════════════════

test("订单状态 12：部分退款不得改动全局 Order.status", async () => {
  const { user, orderId, order } = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  await approveRefund(await requestRefund(orderId, user), "30");

  const expectedRefund = Math.floor((order.actualPaidAmount * 3000) / 10000);
  assert.ok(
    expectedRefund > 0 && expectedRefund < order.actualPaidAmount,
    `前置：这一笔必须是真正的部分退款（算出 ${expectedRefund} / 实付 ${order.actualPaidAmount}）`,
  );

  const after = await orderOf(orderId);
  assert.equal(after.refundedAmount, expectedRefund, "只累计已退额");
  assert.equal(after.status, order.status, "部分退款不得把订单推成 refunded");
  assert.equal(after.status, "completed", "这一单仍然停在 completed（按原进度继续）");
  assert.equal(after.refundedAt, null, "没退满就不该有退款时间");
  assert.equal(after.actualCompanionId, order.actualCompanionId, "派单归属不因退款变化");
});

test("订单状态 13：只有全额退款才进入 Order.status === refunded", async () => {
  // 99% 仍是部分退款：订单不得转 refunded
  const partial = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  await approveRefund(await requestRefund(partial.orderId, partial.user), "99");

  const still = await orderOf(partial.orderId);
  assert.ok(
    still.refundedAmount < still.actualPaidAmount,
    "前置：99% 没有退满（取整向下，必然差一点）",
  );
  assert.equal(still.status, "completed", "没退满就不是「已退款」");
  assert.equal(still.refundedAt, null, "没退满不该写退款时刻");

  // 100%：订单转 refunded，且**同时**满足累计已退 = 实付
  const full = await completedOrder({ completedAt: plusMinutes(now(), 62) });
  await approveRefund(await requestRefund(full.orderId, full.user), "100");

  const refunded = await orderOf(full.orderId);
  assert.equal(refunded.status, "refunded", "全额退款必须把订单推进 refunded");
  assert.equal(
    refunded.refundedAmount,
    refunded.actualPaidAmount,
    "「已退款」必须同时是「累计已退 = 实付」——不得出现「已退款但没退满」",
  );
  assert.equal(typeof refunded.refundedAt, "string", "退满必须写下退款时刻");
});

// ═══════════════════ 七、源码层门禁：不做 withdrawn 追偿 ═══════════════════

test("门禁 14：lib/** 里不存在「普通退款 → withdrawn 追偿」的实现（钱包 / 负余额 / 追偿 / 未来收益抵扣）", () => {
  const files = collectFiles(path.join(ROOT, "lib"));
  // 正例之一：门禁必须真的扫到了文件——路径写错时它必须炸，而不是静默通过
  assert.ok(files.length > 0, "门禁必须扫到文件；扫到 0 个文件说明路径写错了");

  /**
   * 禁用词表（P0-15 Q1-V2）：本轮明确**不引入**钱包、负余额、追偿系统、未来收益抵扣。
   *
   * ⚠️ 刻意**不**把「抵扣」两个字单独列为禁用：仓库里存在一条**合法且无关**的用法
   * ——优惠券抵扣（`lib/constants/adminRefunds.ts` 的 `couponDiscountAmount: "优惠券抵扣"`）。
   * 禁掉这两个字会误伤商品金额域，而那份误伤会让人把这条门禁直接删掉。
   * 这里只禁「收益抵扣 / 未来收益抵扣」这类**真的是追偿**的措辞。
   *
   * ⚠️ 注释先被剥掉：注释里写「本模块没有钱包」不算出现钱包——
   * 而 `lib/types/earning.ts` / `lib/services/companionEarnings.ts` 里恰好都有那样的说明文字。
   */
  const FORBIDDEN = [
    ["钱包", "钱包"],
    ["负余额", "负余额"],
    ["追偿", "追偿"],
    ["平台垫付", "垫付"],
    ["应收台账", "应收"],
    ["追回已提现", "追回"],
    ["未来收益抵扣", "收益抵扣"],
    // ⚠️ 这里刻意**不加** `\b`：加了之后 `WalletLedger` / `WalletStore` / `mockWalletRepository`
    // 这类真正要拦的复合标识符会**恰好漏掉**（"wallet" 后面紧跟字母，没有词边界）。
    // 用 `wallet` 全词形匹配，代价是将来若有人写 `wallet` 作为无关缩写会被误伤——那正是
    // 应该停下来重新裁定这条门禁的时刻，而不是让它静默放行的时刻。
    ["钱包实体 / 钱包相关标识符（英文）", /wallet/i],
    ["账本 / 台账（英文）", /ledger/i],
    ["负余额（英文）", /negative[_ ]?balance/i],
    ["应收 / 待收台账", /receivable/i],
    ["追偿原语", /clawback|recoverFrom|recoveryLedger/i],
    ["未来收益抵扣（英文）", /offsetFuture|futureEarningOffset|earningOffset/i],
  ];

  let scannedBytes = 0;
  const hits = [];
  for (const file of files) {
    const code = stripComments(readSource(file));
    // 正例之二：每个文件都必须读得出内容（读成空串会让下面的扫描变成一句空话）
    assert.ok(code.length > 0, `${file} 剥注释之后是空的——扫描会变成假绿`);
    scannedBytes += code.length;
    for (const [label, pattern] of FORBIDDEN) {
      const matched = typeof pattern === "string" ? code.includes(pattern) : pattern.test(code);
      if (matched) hits.push(`${path.relative(ROOT, file)} → ${label}`);
    }
  }
  assert.ok(scannedBytes > 0, "扫描总字节数必须大于 0（正例之三）");

  // 正例之四：确认扫描真的读到了收益伪事务的源码（不然「0 命中」毫无意义）
  const earningTx = stripComments(
    readSource(path.join(ROOT, "lib", "data", "earningTransaction.ts")),
  );
  assert.ok(
    earningTx.includes("sweepMaturedEarnings"),
    "正例：门禁确实读到了收益伪事务的源码",
  );

  assert.deepEqual(
    hits,
    [],
    `lib/** 里不得出现钱包 / 负余额 / 追偿 / 未来收益抵扣的实现：\n${hits.join("\n")}`,
  );
});
