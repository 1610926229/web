import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  COMPLAINT_WINDOW_CLOSED_MESSAGE,
  isComplaintWindowClosed,
} from "../lib/constants/complaints.ts";
import { plusMinutes } from "../lib/constants/dispatch.ts";
import { EARNING_STATUSES, EARNING_STATUS_LABELS } from "../lib/constants/earnings.ts";
import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLAINT_WINDOW_MAX_MINUTES,
  COMPLAINT_WINDOW_MIN_MINUTES,
  PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE,
  PLATFORM_CONFIG_INVALID_COMPLAINT_WINDOW_MESSAGE,
  isValidComplaintWindowMinutes,
} from "../lib/constants/platformConfig.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { updatePlatformConfig } from "../lib/data/adminPlatformConfigTransaction.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import {
  approveCompletion,
  submitCompletion,
  sweepCompletionAutoApprovals,
} from "../lib/data/completionTransaction.ts";
import { getEarningRepository } from "../lib/data/earningRepository.ts";
import { settleOrderCompletion, sweepMaturedEarnings } from "../lib/data/earningTransaction.ts";
import { complaintStore } from "../lib/data/mockComplaintRepository.ts";
import { earningStore } from "../lib/data/mockEarningRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { readPlatformConfig } from "../lib/data/mockPlatformConfigRepository.ts";
import { refundStore } from "../lib/data/mockRefundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { updateAdminPlatformConfig } from "../lib/services/adminPlatformConfig.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { listCompanionEarnings } from "../lib/services/companionEarnings.ts";
import { createComplaintForUser } from "../lib/services/complaints.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";
import { readSource, stripComments } from "./source-text.mjs";

/**
 * P0-9「打手收益 + 投诉窗口」的持续测试。
 *
 * 本文件钉的是**资金事实**这条线，而不是某个页面的显示：
 *
 * 1. **结算只有一个入口**：订单 → `completed` + 冻结投诉窗口 + 生成 `frozen` 收益
 *    三件事只发生在 `settleOrderCompletion` 一处，两个完成来源（客服人工通过、
 *    System 到期自动通过）都必须经过它——因此两条来源拿到的经济事实**逐字相同**；
 * 2. **金额一个字都不重算**：`incomeAmount` 直接搬 `Order.companionBaseIncome`
 *    快照（下单那一刻就定下来的承诺），不查商品现价、不查当前分账比例；
 * 3. **一个订单最多一条收益**：判据是状态本身（订单已 `completed` 就整段跳过），
 *    重复 approve / 重复 sweep 都不新建、不刷新 `frozenAt`；
 * 4. **窗口是每单自己的快照**：`complaintDeadlineAt === completedAt + snapshot`，
 *    改平台配置**不追溯**已完成的订单，新完成的订单用新值；
 * 5. **解冻是惰性物化**：到点即事实，与有没有人跑过 sweep 无关；有阻塞（进行中的退款 /
 *    未完结的投诉）就继续冻结；`availableAt` 是计划值，释放**不刷新**它；
 * 6. **收益只属于履约的打手**：归属取自订单的 `actualCompanionId`，
 *    DTO 显式挑字段，不带平台净收入 / 冲正 / 罚款 / 提现 / `companionId`。
 *
 * 所有用例都跑**真实实现**（真实 Mock 仓储 + 真实伪事务）。时间一律显式传入，
 * 不等真实时间、不改系统时钟——只在与 `new Date()` 有关的两处（投诉接口与订单详情的
 * `canSubmitComplaint`）把订单整体锚定在真实 now 的前后，构造「窗口已关 / 未关」两种单据。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

/** 预置数据里挂在 cp-1 名下、状态 completed 的一单：它**没有**投诉窗口快照（P0-9 之前的历史订单）。 */
const SEEDED_HISTORICAL_COMPLETED = "ord-seed-1001-05";
const SEEDED_HISTORICAL_USER = "u-1001";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

function uniqueUser() {
  return unique("u-p09");
}

function uniqueKey() {
  return unique("p09key");
}

/** 每个用例开始时的「真实 now」锚点：只有少数几处需要它。 */
function now() {
  return new Date().toISOString();
}

async function orderOf(orderId) {
  const order = await getPaymentRepository().findOrderById(orderId);
  assert.ok(order, `订单 ${orderId} 必须存在`);
  return order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

function allEarnings() {
  return [...earningStore().earnings.values()];
}

function earningsOfOrder(orderId) {
  return allEarnings().filter((earning) => earning.orderId === orderId);
}

/**
 * 计划解冻时刻（`availableAt`）。
 *
 * 本文件里它从不为 null（订单 completed 必有 deadline 快照），因此断言出来是安全的——
 * 用一个取值函数而不是 `earning.availableAt` 直接传进 `plusMinutes`，
 * 是为了让「拿不到计划值」这件事在测试里立刻炸掉，而不是静默传一个 `null` 进去。
 */
function availableAtOf(earning) {
  assert.equal(typeof earning.availableAt, "string", "本用例的收益必须有计划解冻时刻");
  return earning.availableAt;
}

/** 走完整下单链路，返回订单。 */
async function placeOrder(user, overrides = {}) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      ...overrides,
      idempotencyKey: uniqueKey(),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return confirmed.order;
}

/**
 * 把一张**新订单**走完整条链路推到 `completed`，完成时刻由调用方显式给出。
 *
 * 链路里三个时刻一律从 `completedAt` **倒推**（接单 -41 分钟 / 开始服务 -21 /
 * 提交完成材料 -11），因此「完成时刻落在真实 now 之前」这件事只需要把 `completedAt`
 * 往前挪，链路自身的先后关系仍然成立。
 *
 * ⚠️ 提交时刻取 **-11 分钟**而不是 -1：自动通过路径要求清扫时刻已经越过
 * `submittedAt + 自动审核时长（10 分钟）`，否则 `sweepCompletionAutoApprovals`
 * 什么都不会做，`via: "system"` 的那一半就没有覆盖到。
 *
 * ⚠️ `completedAt` 不能比真实 now 晚太多：接单时刻 (-41) 必须仍早于公共池截止时间
 * （订单支付时刻 + 60 分钟）。本文件用到的两个方向（-90 ~ +62 分钟）都在这个范围内。
 */
async function completedOrder({
  companionId = COMPANION_A,
  completedAt,
  via = "staff",
  user = uniqueUser(),
  overrides = {},
}) {
  const placed = await placeOrder(user, overrides);
  const orderId = placed.id;

  const acceptedAt = plusMinutes(completedAt, -41);
  const accepted = await acceptDispatch((await dispatchOf(orderId)).id, {
    companionId,
    at: acceptedAt,
  });
  assert.equal(accepted.kind, "ok", "这条用例需要一次成功的接单");

  const started = await startCompanionOrderTransaction({
    companionId,
    orderId,
    at: plusMinutes(completedAt, -21),
  });
  assert.equal(started.kind, "ok", "这条用例需要一次成功的开始服务");

  const submitted = await submitCompletion({
    companionId,
    orderId,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(completedAt, -11),
  });
  assert.equal(submitted.kind, "ok", "这条用例需要一份在途完成材料");

  if (via === "staff") {
    const approved = await approveCompletion({
      submissionId: submitted.submissionId,
      staffId: "staff-1",
      staffName: "客服小雨",
      at: completedAt,
    });
    assert.equal(approved.kind, "ok", "这条用例需要一次成功的客服通过");
  } else {
    const swept = sweepCompletionAutoApprovals(completedAt);
    assert.deepEqual(
      swept.autoApprovedSubmissionIds,
      [submitted.submissionId],
      "这条用例需要一次成功的到期自动通过",
    );
  }

  const order = await orderOf(orderId);
  assert.equal(order.status, "completed", "前置条件：订单必须走到 completed");
  assert.equal(order.completedAt, completedAt, "前置条件：完成时刻就是传入的那一刻");
  return { user, order, orderId, submissionId: submitted.submissionId };
}

/** 改投诉窗口配置——走真实的伪事务（`PATCHABLE_FIELDS` 的第三个字段）。 */
async function setComplaintWindow(minutes) {
  const result = await updatePlatformConfig(
    { complaintWindowMinutes: minutes },
    {
      actorId: "admin-1",
      actorRole: "admin",
      actorName: null,
      operationId: unique("op-p09"),
      at: now(),
    },
  );
  assert.equal(result.kind, "ok");
  assert.equal(readPlatformConfig().complaintWindowMinutes, minutes);
}

function complaintBody(overrides = {}) {
  return {
    typeKey: "companion_service",
    description: "约好的时间打手迟到了四十分钟，也没有提前说明。",
    contact: "",
    evidence: [],
    orderId: "",
    idempotencyKey: uniqueKey(),
    ...overrides,
  };
}

beforeEach(() => {
  resetMockStore("earning");
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("completion");
  resetMockStore("platformConfig");
  resetMockStore("complaint");
  resetMockStore("refund");
  resetMockStore("adminAudit");
});

// ——————————————————————————— 一、结算：唯一入口 ———————————————————————————

test("完成 1：客服人工通过后生成一条 frozen 收益——金额 / 归属 / 冻结时刻 / 计划解冻时刻各自对上", async () => {
  const completedAt = plusMinutes(now(), 62);
  const { order, orderId } = await completedOrder({ companionId: COMPANION_A, completedAt });

  const earnings = earningsOfOrder(orderId);
  assert.equal(earnings.length, 1, "订单进入 completed 必须带来恰好一条收益");
  const earning = earnings[0];

  assert.equal(earning.orderId, orderId);
  assert.equal(earning.status, "frozen", "刚完成时收益必然是冻结的");
  // 冻结时刻 = 订单进入 completed 的那一刻，不是「谁碰巧来读了一次」的时刻
  assert.equal(earning.frozenAt, completedAt);
  assert.equal(earning.frozenAt, order.completedAt);
  // 计划解冻时刻 = 本单的投诉截止时刻（同一件事，不自己再加一次分钟）
  assert.equal(earning.availableAt, order.complaintDeadlineAt);
  // 本阶段没有提现、没有冲正、没有罚款：三个字段恒为初始值
  assert.equal(earning.withdrawnAt, null);
  assert.equal(earning.reversedAmount, 0);
  assert.equal(earning.fineAmount, 0);

  // 仓储读回来的就是同一条（写入原语与读取契约指向同一份事实）
  const viaRepository = await getEarningRepository().findEarningByOrderId(orderId);
  assert.deepEqual(viaRepository, earning);
});

test("完成 2：System 到期自动通过同样生成一条 frozen 收益", async () => {
  const completedAt = plusMinutes(now(), 62);
  const { order, orderId, submissionId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt,
    via: "system",
  });

  const earnings = earningsOfOrder(orderId);
  assert.equal(earnings.length, 1, "自动通过与人工通过一样必须建收益");
  const earning = earnings[0];

  assert.equal(earning.status, "frozen");
  assert.equal(earning.frozenAt, completedAt, "完成事实来自订单的 completedAt，不是 sweep 自己的时钟");
  assert.equal(earning.availableAt, order.complaintDeadlineAt);
  assert.ok(submissionId, "自动通过路径同样要有一条完成材料");
  // 首尾一致：完成材料的审核来源是 system，而收益事实与人工通过那条路径形状相同
  assert.equal(earning.companionId, order.actualCompanionId);
});

test("完成 3：两条完成来源得到完全相同的经济事实——金额 / 归属 / 状态 / 相对 deadline 逐项一致", async () => {
  const base = now();
  const byStaff = await completedOrder({ companionId: COMPANION_A, completedAt: plusMinutes(base, 42) });
  const bySystem = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(base, 62),
    via: "system",
  });

  const a = earningsOfOrder(byStaff.orderId)[0];
  const b = earningsOfOrder(bySystem.orderId)[0];

  // 两条路径必须产生**同一个形状**的事实。任何一处「人工通过多算一次 / 自动通过少写一个
  // 字段」都会让下面某一条红——而这正是把结算收进一个函数要挡的东西
  assert.equal(a.incomeAmount, b.incomeAmount, "同一商品的收益金额与完成来源无关");
  assert.equal(a.companionId, b.companionId);
  assert.equal(a.status, b.status);
  assert.equal(a.frozenAt, byStaff.order.completedAt);
  assert.equal(b.frozenAt, bySystem.order.completedAt);
  assert.equal(
    Date.parse(a.availableAt) - Date.parse(byStaff.order.completedAt),
    Date.parse(b.availableAt) - Date.parse(bySystem.order.completedAt),
    "两条路径的冻结时长必须相同（都来自同一份投诉窗口快照）",
  );
  assert.equal(
    byStaff.order.complaintWindowMinutesSnapshot,
    bySystem.order.complaintWindowMinutesSnapshot,
  );
});

test("金额 4：收益金额**搬**订单上的 companionBaseIncome 快照，不重新计算", async () => {
  const { order, orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const earning = earningsOfOrder(orderId)[0];

  // ⚠️ 断言的右边取**订单上那个快照值**，而不是测试自己按「商品现价 × 分账比例」算一遍：
  // 自己算等于把那条被明确禁止的规则（完成时重查商品价 / 重查比例）写进测试，
  // 于是「收益 = 下单时承诺的那个数」这条真正要守的规则反而没人守了
  assert.equal(earning.incomeAmount, order.companionBaseIncome);
  assert.ok(order.companionBaseIncome > 0, "这条用例需要一个正的快照金额");

  // 快照本身在下单那一刻就定下来了：再读一次订单，值不变（不是「每次读都算一次」）
  assert.equal((await orderOf(orderId)).companionBaseIncome, order.companionBaseIncome);
  assert.equal(earningsOfOrder(orderId)[0].incomeAmount, earning.incomeAmount);
});

test("归属 5：收益归属是实际履约的打手（Order.actualCompanionId），不是别人", async () => {
  // 无人指定 → 公共池；由 B 接下并完成
  const { order, orderId } = await completedOrder({
    companionId: COMPANION_B,
    completedAt: plusMinutes(now(), 62),
  });

  const earning = earningsOfOrder(orderId)[0];
  assert.equal(earning.companionId, order.actualCompanionId);
  assert.equal(earning.companionId, COMPANION_B);
  assert.notEqual(earning.companionId, COMPANION_A, "没接这张单的人不该拿到钱");

  // 另一侧：A 的收益里没有这一条
  const aItems = (await listCompanionEarnings(COMPANION_A)).items;
  assert.equal(
    aItems.some((item) => item.orderId === orderId),
    false,
    "收益只属于履约的那位打手",
  );
});

test("幂等 6：同一订单最多一条收益——重复 approve / 重复 sweep / 重复结算都不新建、不刷新 frozenAt", async () => {
  const completedAt = plusMinutes(now(), 62);
  const { orderId, submissionId } = await completedOrder({ companionId: COMPANION_A, completedAt });
  const first = earningsOfOrder(orderId)[0];
  assert.equal(earningsOfOrder(orderId).length, 1);

  // (a) 客服重复点击通过 → 重放，什么都不写
  const replayed = await approveCompletion({
    submissionId,
    staffId: "staff-1",
    staffName: "客服小雨",
    at: plusMinutes(completedAt, 5),
  });
  assert.equal(replayed.kind, "replayed");
  assert.equal(replayed.changed, false);

  // (b) 重复清扫（用户端 / 打手端读取路径都会跑它）
  const sweptAgain = sweepCompletionAutoApprovals(plusMinutes(completedAt, 60));
  assert.deepEqual(sweptAgain.autoApprovedSubmissionIds, []);

  // (c) 直接重复结算（幂等判据是订单状态本身，不是幂等键）
  const resettled = settleOrderCompletion({ orderId, at: plusMinutes(completedAt, 120) });
  assert.ok(resettled);
  assert.equal(resettled.changed, false);
  assert.equal(resettled.earning.id, first.id, "重复结算返回的是**已有的**那一条");

  // 三件事一起断言：条数没变、frozenAt 没被刷新、整个记录逐字没变
  const after = earningsOfOrder(orderId);
  assert.equal(after.length, 1, "同一订单不允许出现第二条收益");
  assert.equal(after[0].frozenAt, completedAt, "frozenAt 不得被后续调用刷新");
  assert.deepEqual(after[0], first);
  assert.equal(allEarnings().length, 1);
  assert.equal(earningStore().earningIdByOrder.get(orderId), first.id);
});

// ——————————————————————————— 二、投诉窗口：快照与不追溯 ———————————————————————————

test("快照 7：completed 时冻结 complaintWindowMinutesSnapshot，deadline === completedAt + snapshot", async () => {
  const snapshotMinutes = 120;
  await setComplaintWindow(snapshotMinutes);

  const completedAt = plusMinutes(now(), 62);
  const { order, orderId } = await completedOrder({ companionId: COMPANION_A, completedAt });

  assert.equal(order.complaintWindowMinutesSnapshot, snapshotMinutes, "快照取完成那一刻的配置值");
  // 等式两边逐字比对：分钟加法只有一份实现（plusMinutes），deadline 不允许由第二处算出来
  assert.equal(order.complaintDeadlineAt, plusMinutes(completedAt, snapshotMinutes));
  // 收益的计划解冻时刻与投诉截止是**同一个**时刻
  assert.equal(earningsOfOrder(orderId)[0].availableAt, order.complaintDeadlineAt);

  // 未完成的订单没有窗口（null 表示「还没有窗口」，不是「立刻关闭」）
  const paying = await placeOrder(uniqueUser());
  assert.equal(paying.complaintWindowMinutesSnapshot, null);
  assert.equal(paying.complaintDeadlineAt, null);
});

test("快照 8：改投诉窗口配置**不追溯**已经 completed 的订单——快照 / deadline / 收益 availableAt 都不变", async () => {
  const oldMinutes = 60;
  await setComplaintWindow(oldMinutes);

  const completedAt = plusMinutes(now(), 62);
  const { orderId } = await completedOrder({ companionId: COMPANION_A, completedAt });
  const before = await orderOf(orderId);
  const earningBefore = earningsOfOrder(orderId)[0];
  assert.equal(before.complaintWindowMinutesSnapshot, oldMinutes);

  // 管理员把窗口改成 7 天
  await setComplaintWindow(COMPLAINT_WINDOW_MAX_MINUTES);
  assert.equal(readPlatformConfig().complaintWindowMinutes, COMPLAINT_WINDOW_MAX_MINUTES);

  const after = await orderOf(orderId);
  assert.equal(after.complaintWindowMinutesSnapshot, oldMinutes, "历史订单沿用它自己完成时的快照");
  assert.equal(after.complaintDeadlineAt, before.complaintDeadlineAt, "截止时刻不得被一次改配置推后");
  assert.deepEqual(earningsOfOrder(orderId)[0], earningBefore, "收益的冻结时长同样不追溯");

  // 反向：把窗口改小也不会让历史订单提前解冻
  await setComplaintWindow(COMPLAINT_WINDOW_MIN_MINUTES);
  assert.equal((await orderOf(orderId)).complaintDeadlineAt, before.complaintDeadlineAt);
});

test("快照 9：改配置之后**新完成**的订单用新的窗口值", async () => {
  await setComplaintWindow(60);
  const firstCompletedAt = plusMinutes(now(), 62);
  const first = await completedOrder({ companionId: COMPANION_A, completedAt: firstCompletedAt });
  assert.equal(first.order.complaintWindowMinutesSnapshot, 60);

  const newMinutes = 3 * 24 * 60;
  await setComplaintWindow(newMinutes);
  const second = await completedOrder({ companionId: COMPANION_A, completedAt: plusMinutes(now(), 62) });

  assert.equal(second.order.complaintWindowMinutesSnapshot, newMinutes);
  assert.equal(second.order.complaintDeadlineAt, plusMinutes(second.order.completedAt, newMinutes));
  assert.equal(
    earningsOfOrder(second.orderId)[0].availableAt,
    second.order.complaintDeadlineAt,
    "新订单的收益按新窗口冻结",
  );
  // 旧订单仍然是旧值（「新值只影响此后」）
  assert.equal((await orderOf(first.orderId)).complaintWindowMinutesSnapshot, 60);
});

// ——————————————————————————— 三、投诉窗口：接口与入口 ———————————————————————————

test("窗口 10：deadline 之前的普通投诉允许——接口放行，canSubmitComplaint 为 true", async () => {
  const base = now();
  // 完成时刻在真实 now 之前一点：deadline = completedAt + 默认 1440 分钟，仍在未来
  const { order, orderId, user } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(base, -5),
  });
  assert.equal(order.complaintWindowMinutesSnapshot, COMPLAINT_WINDOW_DEFAULT_MINUTES);
  assert.equal(isComplaintWindowClosed(order, base), false);

  const detail = await getOrderDetailForUser(orderId, user, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.allowedActions.canSubmitComplaint, true, "窗口内页面必须还显示投诉入口");

  const created = await createComplaintForUser(
    user,
    complaintBody({ orderId }),
    undefined,
    "server",
  );
  assert.equal(created.created, true, "窗口内的普通投诉必须被接受");
});

test("窗口 11：deadline 之后普通投诉被拒——接口 400 + 冻结文案，canSubmitComplaint 为 false", async () => {
  const base = now();
  // 窗口 60 分钟，而完成时刻在 90 分钟前 → deadline 已经过去 30 分钟
  await setComplaintWindow(COMPLAINT_WINDOW_MIN_MINUTES);
  const { order, orderId, user } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(base, -90),
  });
  assert.equal(order.complaintWindowMinutesSnapshot, COMPLAINT_WINDOW_MIN_MINUTES);
  assert.equal(order.complaintDeadlineAt, plusMinutes(order.completedAt, COMPLAINT_WINDOW_MIN_MINUTES));
  assert.equal(isComplaintWindowClosed(order, base), true, "到点即关闭（含边界）");

  await assert.rejects(
    () => createComplaintForUser(user, complaintBody({ orderId }), undefined, "server"),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      // 对外文案必须是那一句冻结的常量：窗口长度可配置，文案里印一个数字必然对某些订单是错的
      assert.equal(error.message, COMPLAINT_WINDOW_CLOSED_MESSAGE);
      return true;
    },
  );

  // 页面与接口用的是**同一个**纯函数，因此不存在「按钮还在、接口已经拒绝」的窗口期
  const detail = await getOrderDetailForUser(orderId, user, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.allowedActions.canSubmitComplaint, false, "关闭后页面必须收起投诉入口");

  // 被拒的那一次没有留下任何记录
  const stored = [...complaintStore().complaints.values()].filter((c) => c.orderId === orderId);
  assert.equal(stored.length, 0);
});

test("窗口 11b：没有快照的订单（在途订单 / P0-9 之前的历史订单）不算窗口关闭", async () => {
  // 纯函数侧：null 表示「没有窗口」，不是「立刻关闭」
  assert.equal(isComplaintWindowClosed({ complaintDeadlineAt: null }, now()), false);

  // 端到端：预置数据里那一单 completed 的历史订单没有快照，它的普通投诉入口**仍然开着**
  // （本轮不顺手收紧它——那是任何人没有要求过的行为变化）
  const historical = await orderOf(SEEDED_HISTORICAL_COMPLETED);
  assert.equal(historical.status, "completed");
  assert.equal(historical.complaintDeadlineAt, null);

  const created = await createComplaintForUser(
    SEEDED_HISTORICAL_USER,
    complaintBody({ orderId: SEEDED_HISTORICAL_COMPLETED }),
    undefined,
    "server",
  );
  assert.equal(created.created, true, "没有快照的历史订单不该被新规则挡下");
});

// ——————————————————————————— 四、到期解冻：惰性、幂等、不刷新 ———————————————————————————

test("解冻 12：deadline 未到 → 不释放，收益仍 frozen", async () => {
  const { orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const earning = earningsOfOrder(orderId)[0];
  const deadline = availableAtOf(earning);

  const swept = sweepMaturedEarnings(plusMinutes(deadline, -1));
  assert.deepEqual(swept.releasedEarningIds, [], "还差一分钟就不是到期");
  assert.equal(earningsOfOrder(orderId)[0].status, "frozen");
});

test("解冻 13：deadline 到且无阻塞 → 释放为 available", async () => {
  const { orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  const swept = sweepMaturedEarnings(deadline);
  assert.equal(swept.releasedEarningIds.length, 1, "到点即事实（含边界）");
  assert.equal(earningsOfOrder(orderId)[0].status, "available");
  // 仓储读回来的是同一份事实
  assert.equal((await getEarningRepository().findEarningByOrderId(orderId)).status, "available");
});

test("解冻 14：有进行中的退款 / 未完结的投诉 → 仍 frozen（阻塞判据与自动通过同一份）", async () => {
  // (a) pending 退款阻塞
  {
    const { orderId } = await completedOrder({
      companionId: COMPANION_A,
      completedAt: plusMinutes(now(), 62),
    });
    const deadline = availableAtOf(earningsOfOrder(orderId)[0]);
    const rs = refundStore();
    const refundId = unique("refund");
    rs.refunds.set(refundId, { id: refundId, orderId, status: "pending" });
    rs.refundIdByOrder.set(orderId, refundId);

    const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
    assert.deepEqual(swept.releasedEarningIds, [], "进行中的退款必须挡住放款");
    assert.equal(earningsOfOrder(orderId)[0].status, "frozen");
  }

  // (b) pending / processing 投诉阻塞
  for (const complaintStatus of ["pending", "processing"]) {
    const { orderId } = await completedOrder({
      companionId: COMPANION_A,
      completedAt: plusMinutes(now(), 62),
    });
    const deadline = availableAtOf(earningsOfOrder(orderId)[0]);
    const cs = complaintStore();
    const complaintId = unique("cmp");
    cs.complaints.set(complaintId, { id: complaintId, orderId, status: complaintStatus });

    const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
    assert.deepEqual(swept.releasedEarningIds, [], `${complaintStatus} 投诉必须挡住放款`);
    assert.equal(earningsOfOrder(orderId)[0].status, "frozen");
  }

  // (c) 已终结的投诉 / 退款**不**阻塞（D4 取舍：不永久冻结）
  for (const complaintStatus of ["resolved", "closed"]) {
    const { orderId } = await completedOrder({
      companionId: COMPANION_A,
      completedAt: plusMinutes(now(), 62),
    });
    const deadline = availableAtOf(earningsOfOrder(orderId)[0]);
    const cs = complaintStore();
    const complaintId = unique("cmp");
    cs.complaints.set(complaintId, { id: complaintId, orderId, status: complaintStatus });

    const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
    assert.equal(swept.releasedEarningIds.length, 1, `${complaintStatus} 投诉不阻塞`);
  }
});

test("解冻 15：阻塞解除后，下一次 sweep 把它释放（冻结不是「永不释放」）", async () => {
  const { orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  // 未完结的投诉挡住第一次
  const cs = complaintStore();
  const complaintId = unique("cmp");
  cs.complaints.set(complaintId, { id: complaintId, orderId, status: "processing" });
  assert.deepEqual(sweepMaturedEarnings(plusMinutes(deadline, 1)).releasedEarningIds, []);

  // 客服把它处理完 → 阻塞解除，同一个时刻重扫即可释放
  cs.complaints.set(complaintId, { ...cs.complaints.get(complaintId), status: "resolved" });
  const swept = sweepMaturedEarnings(plusMinutes(deadline, 1));
  assert.equal(swept.releasedEarningIds.length, 1);
  assert.equal(earningsOfOrder(orderId)[0].status, "available");
});

test("解冻 16：重复 sweep 幂等——只有第一次返回非空，状态与 availableAt 都不变", async () => {
  const { orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const deadline = availableAtOf(earningsOfOrder(orderId)[0]);

  const first = sweepMaturedEarnings(deadline);
  assert.equal(first.releasedEarningIds.length, 1);
  const afterFirst = earningsOfOrder(orderId)[0];

  const second = sweepMaturedEarnings(plusMinutes(deadline, 600));
  assert.deepEqual(second.releasedEarningIds, [], "第二次清扫不得再释放同一条");
  assert.deepEqual(earningsOfOrder(orderId)[0], afterFirst, "重复清扫一个字节都不许改");
});

test("解冻 17：availableAt 是**计划**解冻时刻——释放前后完全相同，不刷新", async () => {
  const { order, orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const before = earningsOfOrder(orderId)[0];
  assert.equal(before.availableAt, order.complaintDeadlineAt);

  // 到点很久之后才有人来读（惰性物化）：写入的时刻是 deadline+600，但计划值不变
  sweepMaturedEarnings(plusMinutes(before.availableAt, 600));
  const after = earningsOfOrder(orderId)[0];

  assert.equal(after.status, "available");
  assert.equal(after.availableAt, before.availableAt, "availableAt 是计划值，释放不刷新它");
  assert.equal(after.frozenAt, before.frozenAt);
});

// ——————————————————————————— 五、打手端收益读取 ———————————————————————————

test("收益读取 18：打手只能看到自己的收益，合计数只统计自己那几条", async () => {
  const a = await completedOrder({ companionId: COMPANION_A, completedAt: plusMinutes(now(), 62) });
  const b = await completedOrder({ companionId: COMPANION_B, completedAt: plusMinutes(now(), 62) });

  const forA = await listCompanionEarnings(COMPANION_A);
  assert.deepEqual(
    forA.items.map((item) => item.orderId),
    [a.orderId],
    "A 的收益列表里不该出现 B 的收益",
  );
  assert.equal(forA.summary.count, forA.items.length);
  assert.equal(
    forA.summary.frozenAmount,
    forA.items.filter((item) => item.status === "frozen").reduce((total, item) => total + item.incomeAmount, 0),
  );
  assert.equal(forA.summary.availableAmount, 0, "还在冻结中的钱不该被算进「可提现」");

  const forB = await listCompanionEarnings(COMPANION_B);
  assert.deepEqual(forB.items.map((item) => item.orderId), [b.orderId]);

  // 订单号取自订单，不是自己编一个
  assert.equal(forA.items[0].orderNo, a.order.orderNo);
  assert.equal(forA.items[0].statusLabel, EARNING_STATUS_LABELS.frozen);
});

test("收益读取 19：DTO 恰好八个键——不泄露平台净收入 / 冲正 / 罚款 / 提现 / companionId", async () => {
  const { orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });
  const raw = earningsOfOrder(orderId)[0];

  // 存储层记录形状（对照用）：它**有** companionId / withdrawnAt / reversedAmount / fineAmount
  assert.deepEqual(Object.keys(raw).sort(), [
    "availableAt",
    "companionId",
    "fineAmount",
    "frozenAt",
    "id",
    "incomeAmount",
    "orderId",
    "reversedAmount",
    "status",
    "withdrawnAt",
  ]);

  const item = (await listCompanionEarnings(COMPANION_A)).items[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    ["availableAt", "frozenAt", "id", "incomeAmount", "orderId", "orderNo", "status", "statusLabel"],
    "DTO 是显式挑字段拼出来的：给 Earning 新增字段不该自动出现在响应里",
  );

  // 逐项点名（键列表断言之外再钉一次，改键名时两条一起红）。
  //
  // ⚠️ 其中 `clubNetIncome` / `totalAmount` / `actualPaidAmount` / `companionRateSnapshot`
  // 四个住在**订单**上、`Earning` 里根本没有——点名它们不是「今天漏了」，而是钉住
  // 「这一份响应不许开始捎带订单的金额域」：一个把订单 join 进来、或直接展开订单对象
  // 拼出来的 DTO 会让它们悄悄出现，而打手端本来就不该看到平台抽成与用户实付
  for (const forbidden of [
    "companionId",
    "clubNetIncome",
    "reversedAmount",
    "fineAmount",
    "withdrawnAt",
    "totalAmount",
    "actualPaidAmount",
    "companionRateSnapshot",
    "refundedAmount",
  ]) {
    assert.equal(forbidden in item, false, `打手端收益 DTO 不得带 ${forbidden}`);
  }
});

test("收益读取 20：金额一律是整数分", async () => {
  const { order, orderId } = await completedOrder({
    companionId: COMPANION_A,
    completedAt: plusMinutes(now(), 62),
  });

  const raw = earningsOfOrder(orderId)[0];
  assert.equal(Number.isInteger(raw.incomeAmount), true);
  assert.ok(raw.incomeAmount > 0);
  assert.equal(raw.incomeAmount, order.companionBaseIncome);

  const { items, summary } = await listCompanionEarnings(COMPANION_A);
  assert.equal(Number.isInteger(items[0].incomeAmount), true, "DTO 里的金额同样是整数分");
  // 合计是「分」的整数加法，不是浮点求和：浮点求和会让 0.1+0.2 那类误差出现在打手端数字上
  assert.equal(Number.isInteger(summary.frozenAmount), true);
  assert.equal(Number.isInteger(summary.availableAmount), true);
  assert.equal(summary.frozenAmount, items[0].incomeAmount);
});

test("结算 21：订单不存在时 settleOrderCompletion 返回 null，且一条记录都不写", async () => {
  const at = plusMinutes(now(), 62);
  const outcome = settleOrderCompletion({ orderId: "ord-根本不存在", at });

  assert.equal(outcome, null, "订单不存在时返回 null，调用方据此走 500 分支");
  assert.equal(allEarnings().length, 0, "失败路径不得留下收益记录");
  assert.equal(earningStore().earningIdByOrder.size, 0, "索引也不得被写");
});

test("结算 21b：serving 但没有实际履约打手的订单不建收益——如实不建，而不是建一条金额 0 的假记录", async () => {
  const at = plusMinutes(now(), 1);
  const placed = await placeOrder(uniqueUser());

  // `database-schema.md` T2：「没有 actualCompanionId 就没有收益可发，如实不建，
  // 而不是建一条 companionId: "" / 金额 0 的记录」——那种记录会在打手端变成
  // 一条没人认领的收益。
  //
  // ⚠️ 「serving 却没有 actualCompanionId」在正常链路上到不了（开始服务的前置就是它），
  // 因此这里直接写 store 造出这种数据异常——D23 的防御分支要的正是这个场景。
  // ⚠️ **不能**改回「拿一张 paid 订单来试」：那是在走一次**非法迁移**，
  // 而现在非法迁移会被 settleOrderCompletion 的起始状态守卫挡在门外（见 21d），
  // 于是这条用例会变成「在测守卫」，D23 那个分支反而没人覆盖了。
  paymentStore().orders.set(placed.id, {
    ...placed,
    status: "serving",
    servingAt: at,
    actualCompanionId: null,
  });

  const outcome = settleOrderCompletion({ orderId: placed.id, at });

  assert.ok(outcome, "订单存在，结算函数必须给出结果");
  assert.equal(outcome.changed, true, "起始状态合法（serving），所以这次确实完成了一次迁移");
  assert.equal(outcome.earning, null, "没有履约打手就不产生收益");
  assert.equal(allEarnings().length, 0, "一条记录都不许写");
  assert.equal(earningStore().earningIdByOrder.has(placed.id), false, "索引也不得指向一条不存在的记录");

  // 缺的是**收益**，不是「完成」这件事本身：订单该完成还是完成，窗口该冻结还是冻结
  const settled = await orderOf(placed.id);
  assert.equal(settled.status, "completed");
  assert.equal(settled.complaintDeadlineAt, plusMinutes(at, COMPLAINT_WINDOW_DEFAULT_MINUTES));
});

test("结算 21d：起始状态不是 serving 时一个字都不写——未开始服务的订单不可能被结算函数变成已完成", async () => {
  const at = plusMinutes(now(), 1);

  // 三种起始状态都试，而且**每一种都带一个有值的 actualCompanionId**——
  // 那是最危险的情形：没有守卫时，结算会把它写成 completed
  // （顺手写下 completedAt / 快照 / deadline）并**当场铸出一条 frozen 收益**，
  // 也就是「一笔从未服务过的钱」，而整条链路上不会有任何一处报错。
  // `refunded` 在内：已退款的订单更不该再产生收益
  for (const status of ["paid", "accepted", "refunded"]) {
    const placed = await placeOrder(uniqueUser());
    paymentStore().orders.set(placed.id, {
      ...placed,
      status,
      actualCompanionId: COMPANION_A,
    });

    const outcome = settleOrderCompletion({ orderId: placed.id, at });

    assert.ok(outcome, `[${status}] 订单存在，结算函数必须给出结果`);
    assert.equal(outcome.changed, false, `[${status}] 这不是一次合法迁移，不允许有写入`);
    assert.equal(outcome.earning, null, `[${status}] 未开始服务的订单不产生收益`);
    assert.equal(earningsOfOrder(placed.id).length, 0, `[${status}] 一条收益都不许写`);
    assert.equal(
      earningStore().earningIdByOrder.has(placed.id),
      false,
      `[${status}] 索引也不得指向一条不存在的记录`,
    );

    const untouched = await orderOf(placed.id);
    assert.equal(untouched.status, status, `[${status}] 订单状态不得被改写成 completed`);
    assert.equal(untouched.completedAt, null, `[${status}] 不得凭空写下完成时刻`);
    assert.equal(
      untouched.complaintWindowMinutesSnapshot,
      null,
      `[${status}] 不得凭空冻结一个窗口快照`,
    );
    assert.equal(untouched.complaintDeadlineAt, null, `[${status}] 不得凭空产生投诉截止时刻`);
  }
});

test("不追溯 21c：P0-9 之前就 completed 的历史订单不回填收益，也不补一个历史窗口", async () => {
  assert.equal(allEarnings().length, 0, "收益没有预置数据：全部由「订单完成」这件事产生");

  const historical = await orderOf(SEEDED_HISTORICAL_COMPLETED);
  assert.equal(historical.status, "completed");
  assert.equal(historical.actualCompanionId, COMPANION_A, "这一单确实有实际履约的打手");
  assert.equal(historical.complaintDeadlineAt, null, "它是 P0-9 之前完成的，没有窗口快照");
  assert.equal(await getEarningRepository().findEarningByOrderId(historical.id), null);

  // 拿今天的配置去补一张旧订单，会产生一笔「按历史 completedAt 早该解冻」的钱：
  // 因此结算只发生在 serving → completed 那一次迁移上，绝不「补齐历史」
  const outcome = settleOrderCompletion({ orderId: historical.id, at: plusMinutes(now(), 62) });
  assert.ok(outcome);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.earning, null);
  assert.equal(allEarnings().length, 0);
  assert.equal((await orderOf(historical.id)).complaintDeadlineAt, null, "不得补写一个历史上不存在的窗口");
});

// ——————————————————————————— 六、平台参数：第三个字段 ———————————————————————————

test("平台参数 22：投诉窗口默认 1440、边界 60~10080，0 / 小数 / 字符串 / NaN 一律拒绝", () => {
  assert.equal(COMPLAINT_WINDOW_DEFAULT_MINUTES, 1440, "产品裁定：24 小时");
  assert.equal(COMPLAINT_WINDOW_MIN_MINUTES, 60);
  assert.equal(COMPLAINT_WINDOW_MAX_MINUTES, 10080);
  assert.equal(readPlatformConfig().complaintWindowMinutes, COMPLAINT_WINDOW_DEFAULT_MINUTES);

  for (const bad of [59, 0, -1, 10081, 60.5, "60", Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, []]) {
    assert.equal(isValidComplaintWindowMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [60, 61, 1440, 10079, 10080]) {
    assert.equal(isValidComplaintWindowMinutes(good), true, `${good} 应当通过`);
  }

  // 上下限**独立**于另外两项（1~1440）：7 天的窗口必须能配，且不共用常量
  assert.notEqual(COMPLAINT_WINDOW_MAX_MINUTES, 1440);
});

test("平台参数 22b：空 PATCH 仍被拒；只改投诉窗口能成功且审计 before/after 都带 complaintWindowMinutes", async () => {
  const ADMIN_ID = "admin-1";

  // 空 PATCH：三个字段一个都没带
  await assert.rejects(
    () => updateAdminPlatformConfig(ADMIN_ID, { idempotencyKey: "op-p09-empty" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE);
      return true;
    },
  );
  assert.equal(await getAdminAuditRepository().countAudits(), 0);

  // 取值非法：绝不静默取默认值
  for (const value of [59, 10081, 60.5, "60", null, undefined, Number.NaN]) {
    await assert.rejects(
      () => updateAdminPlatformConfig(ADMIN_ID, {
        complaintWindowMinutes: value,
        idempotencyKey: "op-p09-bad",
      }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, PLATFORM_CONFIG_INVALID_COMPLAINT_WINDOW_MESSAGE);
        return true;
      },
      `${String(value)} 不该被接受`,
    );
  }
  assert.equal(readPlatformConfig().complaintWindowMinutes, COMPLAINT_WINDOW_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);

  // 只改投诉窗口：另外两项保持原值，审计两侧都带这个字段
  const result = await updateAdminPlatformConfig(ADMIN_ID, {
    complaintWindowMinutes: 2880,
    idempotencyKey: "op-p09-window",
  });
  assert.equal(result.changed, true);
  assert.equal(result.config.complaintWindowMinutes, 2880);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 60);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 10);

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].before.complaintWindowMinutes, COMPLAINT_WINDOW_DEFAULT_MINUTES);
  assert.equal(audits[0].after.complaintWindowMinutes, 2880);
  assert.equal(audits[0].after.publicPoolTimeoutMinutes, 60, "没带的字段在审计里保持原值");
});

// ——————————————————————————— 七、结构门禁 ———————————————————————————

test("门禁：收益伪事务整段同步——没有 await，也没有任何 async 函数", () => {
  const code = stripComments(readSource(path.join(ROOT, "lib", "data", "earningTransaction.ts")));

  // 本文件的两个入口都是同步函数（没有 async 外壳），因此「读—判断—写」之间
  // **不可能**让出执行权——这不是靠注释约束，是类型上的事实。
  // 一旦有人加上 await / async，上面的幂等与「认到点即事实」会静默失去保护力
  assert.equal(/\bawait\b/.test(code), false, "收益伪事务里出现 await 就是 bug");
  assert.equal(
    /export\s+async\s+function/.test(code),
    false,
    "settleOrderCompletion / sweepMaturedEarnings 必须是同步函数（要能在原子区段里被调用）",
  );

  // 状态取值只此一份：不另造平行模型
  assert.deepEqual([...EARNING_STATUSES], ["frozen", "available", "withdrawn", "reversed"]);
});
