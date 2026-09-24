import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXCLUSIVE_WAIT_MINUTES, plusMinutes } from "../lib/constants/dispatch.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { cancelAcceptedOrder } from "../lib/data/companionOrderTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { updateAdminPlatformConfig } from "../lib/services/adminPlatformConfig.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import { listCompanionPools } from "../lib/services/companionDispatch.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-6.1 FIX-2「订单池：当前池等待最久优先」的持续测试。
 *
 * ## 这一批真正要钉住的是什么
 *
 * 一条规则：**列表顶部 = 在它当前所在的那个池子里等得最久的一单**。
 *
 * 排序真值只有两个字段，且都取决于「这一单现在在哪个池」：
 *
 * - 公共池 → `publicPoolEnteredAt` 升序（`lib/services/companionDispatch.ts` 的
 *   `currentPoolEnteredAt`）；
 * - 专属池 → `exclusiveEnteredAt` 升序；
 * - 并列（时刻逐字相同）→ `dispatchId` 升序，稳定、确定、可复现。
 *
 * ⚠️ **不是** `deadlineAt`：两者在「公共池时长没被后台改过」时恰好同序，那是巧合。
 * P0-1 起这个时长后台可配置，改小之后一张**更晚**进池的单会**更早**到点，
 * 按 deadline 排就会把它顶到最上面，「等待最久优先」在配置被改的那一天悄悄失效，
 * 而页面上看不出任何异常（用例 11.6 就是为这件事写的）。
 *
 * ⚠️ **不是** `Order.createdAt`：一张很早创建、被 A 接单、A 又主动取消的单（P0-6），
 * 它的等待时间从**这一次**重新进池算起。用创建时间会把它重新顶到那些真正等了很久的
 * 单前面（用例 11.3 就是为这件事写的）。
 *
 * ⚠️ **不是** Map / seed 数组顺序：池子列表由 `listOpenDispatches()` 给出，
 * 那个数组的顺序是存储实现的细节，不是业务结论。
 *
 * ## 进入池子的时刻怎么构造（本文件最关键的一条工程约束）
 *
 * 「下单即进池」这条路径上，`publicPoolEnteredAt` / `exclusiveEnteredAt` 取的是
 * **支付成功那一刻的真实 `new Date()`**（`lib/data/mockPaymentRepository.ts` 的
 * `confirmPaymentRequest` → `checkout.ts` 的 `createDispatchForOrder({ at })`），
 * 毫秒精度、测试控制不了。而内存里下一次单是微秒级的，因此**连续 `placeOrder()`
 * 得到的进入时刻大多数时候完全相同**（实测：连放 4 单、跑 5 轮，多数轮次 distinct = 1）。
 *
 * 这直接决定了两种构造方式，本文件各用其一：
 *
 * 1. **真实链路 + 显式 `at`**（11.3 / 11.5）：`cancelAcceptedOrder` 接受显式 `at`，
 *    并把 `publicPoolEnteredAt` **精确写成该 `cancelledAt`**——这是全仓唯一能注入
 *    这个时刻的真实业务入口；
 * 2. **夹具布置**（11.1 / 11.2 / 11.4 / 11.6 / 11.7）：下单拿到派单记录之后，直接把
 *    「进入当前池的时刻」与对应的截止时间写成确定值（`pinPublicPoolEntry` /
 *    `pinExclusiveEntry`）。
 *
 * ⚠️ 夹具布置**不是自欺**：`mockDispatchRepository.listOpenDispatches()` 返回的是
 * `[...store().dispatches.values()].filter(...)`，即 Map 里的**活对象引用、没有克隆**，
 * 所以写进去的值 `listCompanionPools` 真的会读到；而**清扫与排序仍然真实执行**，
 * 只有「进入时刻」这一个输入被固定。布置完必须断言这些值确实互不相同，
 * 否则用例会悄悄退化成一条 tie-break 用例。
 *
 * ⚠️ **不要用「依次下单 ⇒ 断言 [A,B,C]」**：进入时刻并列时顺序完全落到
 * `dispatchId` ASC 这个 tie-break 上，而 `dispatchId = dsp_${crypto.randomUUID()}`
 * 是随机的——那样的断言会随机变红变绿。数据模型里没有任何字段记录
 * 「同一毫秒内的到达先后」（`orderNo` 的 6 位尾号同样是随机的），
 * 因此「同一毫秒内的公平性」没有任何字段可以支撑，**不要试图去仓库里补一个**。
 *
 * ## 用例之间怎么隔离
 *
 * Mock 仓储在同一进程内共享，预置数据里本来就有 7 条在公共池里的派单，
 * 同一文件里前面的用例也会留下自己的单。因此本文件的纪律是：
 *
 * - **断言只落在「我这几单」上**：从返回的池子里按自己已知的 `orderId` 过滤出子序列，
 *   再断言这个子序列与期望**全等**（`deepEqual` 比长度，少一单同样会红）。
 *   **绝不断言池子的长度**；
 * - 每条用例用自己的 `uniqueUser()` / `uniqueKey()`；
 * - 关心公共池时长的用例先 `resetMockStore("platformConfig")`，再设成自己需要的值
 *   （平台参数是单例，前面的用例可能改过它）；
 * - 布置进去的时刻一律**相对当前时钟**（`plusMinutes(base, -30)` 这类），
 *   并且截止时间都落在「读池子的那一刻」之后，因此既不会被清扫掉，
 *   也不会把别的单一起扫掉——用例不依赖真实日期。
 */

/** 仓库根目录：客户端源码扫描（「服务端是唯一排序真值源」那一条）要用绝对路径。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的一位，`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";

/** HTTP 段落里用到的打手账号：DEV-1 预置的 `u-1022`（名下是 `cp-10`，`userId` 非空）。 */
const HTTP_COMPANION_USER = "u-1022";

/**
 * HTTP 段落里下单用的老板账号：`lib/constants/mockUsers.ts` 里的「下单用户（老板 A）」。
 *
 * ⚠️ 它**必须不是** `cp-10` 名下的 `u-1022`，否则 `listCompanionPools` 的
 * 「自己下的单不进池子」（EX-DISPATCH-08）会把这一单滤掉，整条用例就空转了。
 * 这一条不需要额外断言守着：真要是空转了，下面「刚支付成功的单必须出现在公共池里」
 * 会当场红掉，而不是悄悄通过。
 */
const HTTP_ORDER_USER = "u-1001";

let seq = 0;
function unique(prefix) {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

/** 一个合法且唯一的幂等键（字母 + 数字 + 连字符，且每次都不一样）。 */
function uniqueKey() {
  return unique("p061key");
}

function uniqueUser() {
  return unique("u-p061");
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
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

/** 管理端改公共池超时。走真实服务，因此取值校验与幂等键都是真的。 */
async function setPublicTimeoutMinutes(minutes) {
  const result = await updateAdminPlatformConfig(unique("p061adm"), {
    publicPoolTimeoutMinutes: minutes,
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true, "这条用例需要配置真的被改动");
  assert.equal(result.config.publicPoolTimeoutMinutes, minutes);
}

/* ─────────────────── 夹具布置：把「进入池子的时刻」钉成确定值 ─────────────────── */

/**
 * 把一张**已经进公共池**的派单记录的进入时刻改成 `enteredAt`（**只给测试用**）。
 *
 * 三个字段一起写，保持它们之间的真实关系：
 * `publicDeadlineAt = enteredAt + 这一单冻结下来的公共池时长`。
 * 只改 `publicPoolEnteredAt` 而留着旧的截止时间，会让「进池时刻」与「剩余多久」
 * 互相矛盾——虽然排序只读前者，但没有理由在夹具里制造一份自相矛盾的数据。
 *
 * ⚠️ 调用方要保证 `enteredAt + timeoutMinutes` 落在**读池子的那一刻之后**，
 * 否则这一单在读之前就被 `sweepExpiredDispatches` 清掉了，用例会变成空转。
 */
function pinPublicPoolEntry(dispatchId, enteredAt, timeoutMinutes) {
  const record = dispatchStore().dispatches.get(dispatchId);
  assert.ok(record, `派单 ${dispatchId} 必须存在`);
  assert.equal(record.state, "public", "只有还在公共池里的单才谈得上「公共池进入时刻」");

  record.publicPoolEnteredAt = enteredAt;
  record.publicDeadlineAt = plusMinutes(enteredAt, timeoutMinutes);
  record.publicTimeoutMinutesSnapshot = timeoutMinutes;
  return record;
}

/** 同上，走专属池那两个字段。专属池时长固定为 `EXCLUSIVE_WAIT_MINUTES`，不可配置。 */
function pinExclusiveEntry(dispatchId, enteredAt) {
  const record = dispatchStore().dispatches.get(dispatchId);
  assert.ok(record, `派单 ${dispatchId} 必须存在`);
  assert.equal(record.state, "exclusive", "只有还在专属池里的单才谈得上「专属池进入时刻」");

  record.exclusiveEnteredAt = enteredAt;
  record.exclusiveDeadlineAt = plusMinutes(enteredAt, EXCLUSIVE_WAIT_MINUTES);
  return record;
}

/** 读取某位打手此刻的两张池子。`at` 缺省取真实当前时刻（用于「刚布置好的单就在池里」）。 */
async function readPools(companionId, at = new Date().toISOString()) {
  return listCompanionPools(companionId, at);
}

/**
 * 从池子列表里按 `orderId` 挑出**自己这几单**，并保留池子给出的先后。
 *
 * 这是本文件唯一允许的「看列表」的方式：池子里有预置数据与同一文件里前面用例留下的单，
 * 断言全局顺序或长度会随任何无关改动而红。
 */
function subsequence(items, orderIds) {
  const wanted = new Set(orderIds);
  return items.filter((item) => wanted.has(item.orderId)).map((item) => item.orderId);
}

/** 池子列表里的派单 id 序列（用于「连续读三次逐字相同」这类断言）。 */
function dispatchIds(items) {
  return items.map((item) => item.dispatchId);
}

/**
 * 断言一组时刻**严格递增且互不相同**。
 *
 * ISO 字符串的字典序就是时间序。第二条断言尤其重要：时刻并列时顺序会落到
 * `dispatchId` 上，用例就不再能证明「按进入时刻排」这件事了——它必须显式红掉，
 * 而不是悄悄变成一条 tie-break 用例。
 */
function assertStrictlyIncreasing(values, message) {
  assert.deepEqual(values, [...values].sort(), `${message}（实际的进入时刻：${values.join(" / ")}）`);
  assert.equal(
    new Set(values).size,
    values.length,
    `${message}——时刻逐字相同的话，顺序会退化成 dispatchId 字典序，用例就不再能证明任何事`,
  );
}

/* ─────────────────────────── 11.1 公共池按进入时刻升序 ─────────────────────────── */

test("11.1 公共池：按 publicPoolEnteredAt 升序（顶部 = 等得最久的那单）", async () => {
  resetMockStore("platformConfig");

  // 三单都走真实下单链路（未指定护航 → 直接进公共池），
  // 之后再各自把「进入公共池的时刻」钉成 30/20/10 分钟前
  const base = new Date().toISOString();
  const a = await placeOrder(uniqueUser());
  const b = await placeOrder(uniqueUser());
  const c = await placeOrder(uniqueUser());

  const entered = {
    a: plusMinutes(base, -30),
    b: plusMinutes(base, -20),
    c: plusMinutes(base, -10),
  };
  pinPublicPoolEntry((await dispatchOf(a.id)).id, entered.a, 60);
  pinPublicPoolEntry((await dispatchOf(b.id)).id, entered.b, 60);
  pinPublicPoolEntry((await dispatchOf(c.id)).id, entered.c, 60);

  const actual = [
    (await dispatchOf(a.id)).publicPoolEnteredAt,
    (await dispatchOf(b.id)).publicPoolEnteredAt,
    (await dispatchOf(c.id)).publicPoolEnteredAt,
  ];
  assert.deepEqual(actual, [entered.a, entered.b, entered.c], "夹具布置必须真的写进派单记录");
  // 用例素材本身先成立：三单的进入时刻确实是 A → B → C 且两两不同。
  // 少了这一条，下面那句顺序断言可能因为任何别的原因碰巧通过
  assertStrictlyIncreasing(actual, "三单的 publicPoolEnteredAt 必须严格递增");

  const pools = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(pools.public, [a.id, b.id, c.id]),
    [a.id, b.id, c.id],
    "顶部必须是先进池的 A，底部是最后进池的 C",
  );
});

/* ─────────────── 11.2 运行期新进池的单排在最后，不是被追加到最前 ─────────────── */

test("11.2 运行期新进池的单排在最后，不是排在（Map append / seed 数组的）开头", async () => {
  resetMockStore("platformConfig");

  // A、B 先用夹具把进入时刻钉成 20 / 10 分钟前，于是「谁先谁后」不再取决于
  // 两条记录被写进 Map 的顺序
  const base = new Date().toISOString();
  const a = await placeOrder(uniqueUser());
  const b = await placeOrder(uniqueUser());
  pinPublicPoolEntry((await dispatchOf(a.id)).id, plusMinutes(base, -20), 60);
  pinPublicPoolEntry((await dispatchOf(b.id)).id, plusMinutes(base, -10), 60);

  const before = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(before.public, [a.id, b.id]),
    [a.id, b.id],
    "先布置好的两单必须已经按进入时刻排好",
  );

  // C 是**运行期**新增的一单：它的进入时刻是真实当前时刻，必然晚于 A、B 被钉的时刻。
  // 这一句先把它确认下来，否则本用例可能因为「C 恰好也落在同一毫秒」而空转
  const c = await placeOrder(uniqueUser());
  const cEnteredAt = (await dispatchOf(c.id)).publicPoolEnteredAt;
  assert.ok(
    Date.parse(cEnteredAt) > Date.parse(plusMinutes(base, -10)),
    "运行期这一单的进入时刻必须晚于已布置的两单，否则本用例是空转的",
  );

  const after = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(after.public, [a.id, b.id, c.id]),
    [a.id, b.id, c.id],
    "新进池的单必须排在最后：顺序由进入时刻决定，不由记录被写进 Map 的位置决定",
  );
});

/* ────────────────── 11.3 取消后重新回池用新的进入时刻（P0-6 场景） ────────────────── */

test("11.3 P0-6 回池：取消后按**新的** publicPoolEnteredAt 排（B、C 之后才是 A），不是按 createdAt", async () => {
  resetMockStore("platformConfig");

  const base = new Date().toISOString();

  // A：最早创建、最早进过公共池，之后被接单，很久以后才取消重新回池
  const a = await placeOrder(uniqueUser());
  const aOriginalEnteredAt = (await dispatchOf(a.id)).publicPoolEnteredAt;

  const b = await placeOrder(uniqueUser());
  const c = await placeOrder(uniqueUser());
  // B、C 的进入时刻用夹具钉开：真实时钟下连下两单常常落在同一毫秒，
  // 那样 B/C 的先后会落到随机的 dispatchId 上
  pinPublicPoolEntry((await dispatchOf(b.id)).id, plusMinutes(base, -20), 60);
  pinPublicPoolEntry((await dispatchOf(c.id)).id, plusMinutes(base, -10), 60);

  // A 被接单（公共池里谁都能接），接单时刻必须早于它当时的公共池截止时间
  const accepted = await acceptDispatch((await dispatchOf(a.id)).id, {
    companionId: COMPANION_A,
    at: plusMinutes(a.paidAt, 1),
  });
  assert.equal(accepted.kind, "ok");

  // A 在「现在之后 30 分钟」取消：回池时刻精确写成这个 `at`
  const cancelAt = plusMinutes(base, 30);
  const cancelled = await cancelAcceptedOrder({
    companionId: COMPANION_A,
    orderId: a.id,
    reason: "临时有事无法服务",
    idempotencyKey: uniqueKey(),
    at: cancelAt,
  });
  assert.equal(cancelled.kind, "ok");

  // A 的**当前**进入池子的时刻：是这一次重新进池的那一刻
  const aDispatch = await dispatchOf(a.id);
  const aAfter = await orderOf(a.id);
  assert.equal(aDispatch.state, "public");
  assert.equal(aDispatch.publicPoolEnteredAt, cancelAt, "回池时刻就是取消那一刻");
  assert.equal(cancelled.cancelledAt, cancelAt);
  assert.notEqual(aDispatch.publicPoolEnteredAt, aOriginalEnteredAt, "不能沿用上一次进池的时刻");
  assert.notEqual(aDispatch.publicPoolEnteredAt, aAfter.createdAt, "更不能用订单创建时刻");

  // 反例显式写出来：A 是三单里创建得最早（或并列最早）的那一单，
  // 按 `Order.createdAt` 升序排会把它放在**最前面**——这正是本条用例要挡住的实现
  assert.ok(aAfter.createdAt <= b.createdAt, "A 创建得不晚于 B");
  assert.ok(b.createdAt <= c.createdAt, "B 创建得不晚于 C");

  const pools = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(pools.public, [a.id, b.id, c.id]),
    [b.id, c.id, a.id],
    "A 是刚刚才重新进池的，必须排在 B、C 之后；按 createdAt 排会把它顶到最前面",
  );

});

/* ─────────────────────────── 11.4 专属池按进入时刻升序 ─────────────────────────── */

test("11.4 专属池：三单都指定同一位护航，按 exclusiveEnteredAt 升序", async () => {
  resetMockStore("platformConfig");

  const base = new Date().toISOString();
  const a = await placeOrder(uniqueUser(), { companionId: COMPANION_A });
  const b = await placeOrder(uniqueUser(), { companionId: COMPANION_A });
  const c = await placeOrder(uniqueUser(), { companionId: COMPANION_A });

  // 专属池时长固定 10 分钟，因此这三个时刻必须落在「10 分钟以内」才不会被清扫掉
  const entered = {
    a: plusMinutes(base, -6),
    b: plusMinutes(base, -4),
    c: plusMinutes(base, -2),
  };
  pinExclusiveEntry((await dispatchOf(a.id)).id, entered.a);
  pinExclusiveEntry((await dispatchOf(b.id)).id, entered.b);
  pinExclusiveEntry((await dispatchOf(c.id)).id, entered.c);

  const actual = [
    (await dispatchOf(a.id)).exclusiveEnteredAt,
    (await dispatchOf(b.id)).exclusiveEnteredAt,
    (await dispatchOf(c.id)).exclusiveEnteredAt,
  ];
  assert.deepEqual(actual, [entered.a, entered.b, entered.c], "夹具布置必须真的写进派单记录");
  assertStrictlyIncreasing(actual, "三单的 exclusiveEnteredAt 必须严格递增");

  const pools = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(pools.exclusive, [a.id, b.id, c.id]),
    [a.id, b.id, c.id],
    "专属池顶部 = 最早进入这个专属池的一单",
  );
});

/* ───────────── 11.5 并列契约：进入时刻逐字相同时按 dispatchId 升序 ───────────── */

test("11.5 并列契约：进入时刻逐字相同的两单按 dispatchId 升序，且连续读三次顺序完全一致", async () => {
  resetMockStore("platformConfig");

  const base = new Date().toISOString();
  // 两单都走真实链路（下单 → 接单 → 取消回池），取消时刻显式传入。
  // `cancelAcceptedOrder` 把 `publicPoolEnteredAt` **逐字写成**这个 `at`，
  // 因此两单的进入时刻必然逐字相同——这是真实链路里能造出「并列」的唯一稳定办法。
  // ⚠️ **不能**用「连续下两单」来造并列：那两单的时刻由真实时钟决定，
  // 通常连同一毫秒都落不到（见文件头「进入池子的时刻怎么构造」）。
  const sameAt = plusMinutes(base, 20);

  const a = await placeOrder(uniqueUser());
  const aDispatchId = (await dispatchOf(a.id)).id;
  const b = await placeOrder(uniqueUser());
  const bDispatchId = (await dispatchOf(b.id)).id;

  for (const [orderId, dispatchId] of [
    [a.id, aDispatchId],
    [b.id, bDispatchId],
  ]) {
    const accepted = await acceptDispatch(dispatchId, {
      companionId: COMPANION_A,
      at: plusMinutes(base, 1),
    });
    assert.equal(accepted.kind, "ok", "进入回池场景之前，这一单必须先被接走");

    const cancelled = await cancelAcceptedOrder({
      companionId: COMPANION_A,
      orderId,
      reason: "临时有事无法服务",
      idempotencyKey: uniqueKey(),
      at: sameAt,
    });
    assert.equal(cancelled.kind, "ok", "取消必须成功，两单才会都回到公共池");
  }

  const enteredA = (await dispatchOf(a.id)).publicPoolEnteredAt;
  const enteredB = (await dispatchOf(b.id)).publicPoolEnteredAt;
  assert.equal(enteredA, sameAt);
  assert.equal(enteredB, sameAt);
  assert.equal(enteredA, enteredB, "用例素材本身要先成立：两单的进入时刻必须逐字相同");

  // 确定性：连读三次，顺序逐字相同（tie-break 不许随请求变化，也不许随机）
  const first = await readPools(COMPANION_A);
  const second = await readPools(COMPANION_A);
  const third = await readPools(COMPANION_A);
  assert.deepEqual(dispatchIds(second.public), dispatchIds(first.public), "第二次读到的顺序必须与第一次相同");
  assert.deepEqual(dispatchIds(third.public), dispatchIds(first.public), "第三次同理");

  // 并列时的契约是 **dispatchId 升序**（本文件原来那个 comparator 的 tie-break），
  // 不是「谁先被创建／被写进 Map 谁在前」——后者会随执行环境漂移
  const mine = subsequence(first.public, [a.id, b.id]);
  assert.equal(mine.length, 2, "两单都必须还在池子里");
  assert.deepEqual(
    mine,
    [aDispatchId, bDispatchId].sort().map((id) => (id === aDispatchId ? a.id : b.id)),
    "并列时必须按 dispatchId 升序：换成随机顺序或「谁先被写进 Map 谁在前」都会在这里红",
  );
});

/* ─────────────────────────── 11.6 不按 deadline 排 ─────────────────────────── */

test("11.6 守卫：顺序服从 enteredAt 而不是 deadline——防止以后有人把 comparator 改回 deadline", async () => {
  resetMockStore("platformConfig");

  const base = new Date().toISOString();

  // A 先进池，但拿到一个**较长**的公共池时长（30 分钟）
  await setPublicTimeoutMinutes(30);
  const a = await placeOrder(uniqueUser());
  // B 后进池，但公共池时长已经被后台改短成 10 分钟
  await setPublicTimeoutMinutes(10);
  const b = await placeOrder(uniqueUser());

  // 两个字段一起布置：`deadline = enteredAt + 这一单冻结的时长快照` 仍然成立
  pinPublicPoolEntry((await dispatchOf(a.id)).id, plusMinutes(base, -20), 30);
  pinPublicPoolEntry((await dispatchOf(b.id)).id, plusMinutes(base, -5), 10);

  const aDispatch = await dispatchOf(a.id);
  const bDispatch = await dispatchOf(b.id);

  // (a) 反例先成立：B 更晚进池，却**更早**到点。没有这一条，本用例证明不了任何事
  assert.ok(
    Date.parse(aDispatch.publicPoolEnteredAt) < Date.parse(bDispatch.publicPoolEnteredAt),
    "A 必须比 B 先进池",
  );
  assert.ok(
    Date.parse(bDispatch.publicDeadlineAt) < Date.parse(aDispatch.publicDeadlineAt),
    "B 的截止时间必须早于 A（它拿到的是被改短过的 10 分钟）",
  );

  const pools = await readPools(COMPANION_A);
  assert.deepEqual(
    subsequence(pools.public, [a.id, b.id]),
    [a.id, b.id],
    "顶部必须是等得更久的 A：按 deadline 排会得到相反的顺序",
  );

  // (b) 列表顺序与卡片上的 deadline 顺序**相反**——这一句就是本用例的全部意义
  const mine = pools.public.filter((item) => item.orderId === a.id || item.orderId === b.id);
  assert.equal(mine[0].orderId, a.id);
  assert.ok(
    Date.parse(mine[0].deadlineAt) > Date.parse(mine[1].deadlineAt),
    "排在最上面的那一单，截止时间反而最晚",
  );

});

/* ─────────── 11.7 排序键按 state 取，不按「有没有指定过护航」取 ─────────── */

test("11.7 由专属池转过来的单按**转入公共池的时刻**排，不用当初进专属池的时刻", async () => {
  resetMockStore("platformConfig");

  const base = new Date().toISOString();

  // X：用户当初指定了护航（`exclusiveCompanionId` 非空、`exclusiveEnteredAt` 非空），
  // 没人接、专属池到点，于是转入公共池。这类记录**同时**带着两组时刻，
  // 而它的**当前池是 public**——排序必须取 public 那一组。
  const x = await placeOrder(uniqueUser(), { companionId: COMPANION_A });
  const xPinnedExclusive = plusMinutes(base, -40);
  pinExclusiveEntry((await dispatchOf(x.id)).id, xPinnedExclusive);

  // Y：普通的公共池单（从未进过专属池），进池时刻比 X **转入**公共池的时刻更早
  const y = await placeOrder(uniqueUser());
  const yPinnedPublic = plusMinutes(base, -35);
  pinPublicPoolEntry((await dispatchOf(y.id)).id, yPinnedPublic, 60);

  // 读池子会在内部先清扫：X 的专属池到点（钉在 -40 分钟，时长 10 分钟 → -30 分钟到点），
  // 于是它以「转入那一刻」作为新的进入公共池时刻，真实走 `applyDispatchToPublic`
  const pools = await readPools(COMPANION_A);

  const xAfter = await dispatchOf(x.id);
  assert.equal(xAfter.state, "public", "X 必须已经真的转入公共池，否则本用例的两个排序键不会分叉");
  assert.equal(xAfter.exclusiveEnteredAt, xPinnedExclusive, "当初进专属池的时刻是历史事实，不该被抹掉");
  // 转入公共池的时刻 = 专属池到点那一刻（`sweepExpiredDispatches` 的既有规则）
  assert.equal(xAfter.publicPoolEnteredAt, plusMinutes(xPinnedExclusive, EXCLUSIVE_WAIT_MINUTES));
  // 反例先成立：X 的**历史**时刻比 Y 的进池时刻更早，而它的**当前**时刻更晚。
  // 少了这一条，本用例证明不了任何事
  assert.ok(
    Date.parse(xAfter.exclusiveEnteredAt) < Date.parse(yPinnedPublic),
    "X 当初进专属池的时刻必须早于 Y 进公共池的时刻，否则两个键不会给出相反的顺序",
  );
  assert.ok(
    Date.parse(xAfter.publicPoolEnteredAt) > Date.parse(yPinnedPublic),
    "X 转入公共池的时刻必须晚于 Y 进公共池的时刻",
  );

  assert.deepEqual(
    subsequence(pools.public, [x.id, y.id]),
    [y.id, x.id],
    "Y 在公共池等得更久，必须排在 X 前面：拿「当初进专属池的时刻」当排序键会把 X 顶到最上面",
  );
});

/* ───────────────────────── 池子 DTO 契约不变 ───────────────────────── */

test("池子 DTO 契约不变：排序键（进入当前池的时刻）不上接口，字段集与 P0-5 逐字相同", async () => {
  resetMockStore("platformConfig");

  const a = await placeOrder(uniqueUser());
  const pools = await readPools(COMPANION_A);
  const item = pools.public.find((entry) => entry.orderId === a.id);
  assert.ok(item, "刚下的单必须出现在公共池里");

  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "deadlineAt",
      "dispatchId",
      "gameName",
      "orderId",
      "orderNo",
      "paidAt",
      "pool",
      "poolLabel",
      "productTitle",
      "quantity",
      "remainingSeconds",
      "specName",
    ],
    "池子卡片的字段集变了：多出来的可能是隐私、账目，或者排序用的内部时刻",
  );

  // 白名单已经覆盖了这一点，逐个点名是为了说明**为什么**它不该在：
  // 「这单是什么时候进的池子」是服务端的排序依据，打手不需要看到；
  // 一旦它上了接口，页面就有了自己再排一次的原料，两份排序逻辑迟早分叉
  for (const key of Object.keys(item)) {
    assert.equal(/enter/i.test(key), false, `池子 DTO 不该带 ${key}：排序键必须留在服务端`);
  }
});

/* ─────── 服务端是唯一排序真值源：客户端不许对池子再排一次 ─────── */

/**
 * 上面那一批用例证明的是**服务端**排出了什么顺序；这一条守的是**下游不会推翻它**。
 *
 * ## 为什么值得一条门禁
 *
 * 「顺序只在服务端算一次」是本轮的技术契约（`api-contract.md` §8.1），
 * 而它今天成立**只是因为它恰好成立**：`CompanionDispatchTable` 拿到什么就 `map` 什么，
 * 页面直接透传。下一页做「客户端筛选 / 排序」的人不会知道自己把这层契约拆了——
 * 等到两份排序逻辑分叉的那一天，接口测试与页面看到的是两个不同的池子，
 * 而两边都不会红。因此这里用结构断言把「不许再排一次」写死。
 *
 * 判据是**行为性质**而不是某一个函数名：`.sort(` / `.toSorted(` 都要挡
 * （后者是不改原数组的新 API，绕过 `.sort(` 的检查太容易了）。
 *
 * 范围只覆盖**打手端**三处：`components/companion/**`、`app/companion/**`、
 * 浏览器取数客户端 `lib/services/companionHttp.ts`——别的模块里有正当的排序，
 * 不在这里一刀切。将来若确有正当排序，应在下面的豁免清单里**显式列出文件名**
 * （连同理由），而不是放宽整条断言。
 */
test("服务端是唯一排序真值源：打手端页面 / 组件 / 浏览器客户端都不得对池子再排一次", () => {
  const files = [
    ...collectFiles(path.join(ROOT, "components", "companion")),
    ...collectFiles(path.join(ROOT, "app", "companion")),
    path.join(ROOT, "lib", "services", "companionHttp.ts"),
  ];

  // 扫空目录会让整条用例静默变绿——这正是「结构门禁」最常见的失效方式
  assert.ok(files.length > 5, `扫描范围太小（${files.length} 个文件），这条断言无从判定`);

  /** 将来确有正当排序时的豁免清单（文件名 + 理由），今天为空。 */
  const EXEMPT = [];

  for (const file of files) {
    // 注释里提到 `.sort(` 是允许的（本文件自己也这么写），因此先剥注释
    const code = stripComments(readSource(file));
    const name = path.relative(ROOT, file).replace(/\\/g, "/");
    if (EXEMPT.includes(name)) continue;

    for (const call of [".sort(", ".toSorted("]) {
      assert.equal(
        code.includes(call),
        false,
        `${name} 出现了 ${call}：池子的顺序是服务端的结论，客户端再排一次就等于有了第二份排序真值`,
      );
    }
  }
});

/* ─────────── HTTP：池子顺序是服务端的结论，且由「我这一单」自证 ─────────── */

/**
 * 「服务端真的排过序、并且接口原样透出这个顺序」这件事，只有真跑服务才验得到。
 * 因此这一节与 `http-smoke.test.mjs` 同一取舍：没设 `APP_BASE_URL` 时自动跳过，
 * 而不是伪装成通过。
 *
 * ## ⚠️ 这一节会**真的在服务端创建一张订单**（与 `tests/adminProducts.test.mjs` 同一做法）
 *
 * 它**不是只读**的：用例用 `POST /api/orders/pay` + `POST /api/payments/mock-confirm`
 * 给 `HTTP_ORDER_USER` 造一张新单，让它从无到有地进公共池。这是**刻意**的，不是图省事：
 *
 * - 服务端的排序结论只能靠「一单从无到有地进池」来观察。不自己造一张，就只剩
 *   「连读两次、看看一不一样」这一种断言，而它对「服务端到底排没排、新单排在哪」
 *   一个字都没说——**不自己造一张单，服务端那份池子的顺序就无法被自证**；
 * - 造出来的这一单是**我自己的素材**，于是「它排在谁之后」是相对结论，
 *   不需要知道服务端的池子里到底还有些什么。
 *
 * 它跑在一台被整轮 HTTP 用例共享的服务器上，因此与 `adminProducts.test.mjs` 一样：
 * 只造属于自己这一单的数据，不删不改别人的；下面每一条断言都只关于「我这一单」与
 * 「我下单前就已经在池里的那个子集」，**绝不断言池子的长度**。
 *
 * ## ⚠️ 为什么不拿服务端返回的池子与**本进程**的 store 对账（曾经就是这么写的，已删）
 *
 * 这里原来写的是：本进程 `readPools(HTTP_COMPANION_ID)` 读一遍，再
 * `deepEqual(服务端顺序, 进程内顺序)`，说「接口原样透出了服务端的排序结论」。**那是错的**：
 *
 * - HTTP 服务器是**另一个进程、另一份 store**，而 `tests/adminProducts.test.mjs`
 *   等其它 HTTP 用例文件会在**同一台服务器上真的下单并支付**。于是服务端的池子里会出现
 *   本进程从来没见过的运行时派单。`filter(id => serverIds.has(id))` 挡不住这件事：
 *   它只保证不比对**服务端多出来的那些**，而 `deepEqual` 比的是**整个数组**——
 *   服务端那份多一条就红。第一次跑能过，只是那时服务端还没多出那一单。
 * - 症状是「第二次跑才红」，而且红得看起来像排序坏了。两个 store 从构造上就是两份
 *   不同的数据，跨进程对账在原理上不成立。**不要再把它加回来。**
 *
 * ## ⚠️ 也不要比「整张列表」（`deepEqual` 全部 id）——`node --test` 默认**并行跑文件**
 *
 * 同一件事的另一面：我在「连读三次」之间，别的用例文件随时可能在服务端新建一单，
 * 那一单会以「最新进池」的身份出现在列表**末尾**；某一张单也可能正好在这一刻被清扫掉。
 * 整表长度一变，逐字比对就红。因此稳定性断言只比**「下单前就在池里的那个子集」**
 * 在三次读之间是否逐字相同——并发新增/移除都动不到它，而「顺序是服务端的数据结论、
 * 不是随请求变化的随机值」照样被证明。
 *
 * 排序规则本身（进入当前池的时刻升序 + dispatchId 并列）由进程内 11.1~11.7 钉住；
 * 本节的职责只有两件：服务端**原样透出**这个顺序，且**新进池的单排在更下面**。
 */
const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过订单池顺序的 HTTP 用例";

/** 用 Mock 身份登录，返回可直接放进 `cookie` 头的会话；服务端没开 Mock 登录时返回 null。 */
async function loginAs(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

const SESSION_COMPANION = BASE ? await loginAs(HTTP_COMPANION_USER) : null;
const SESSION_ORDER_USER = BASE ? await loginAs(HTTP_ORDER_USER) : null;
const SKIP_SESSION =
  SKIP ||
  (SESSION_COMPANION && SESSION_ORDER_USER
    ? false
    : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要打手会话与老板会话的用例");

test(
  "HTTP：新进池的一单排在「我下单前就在池里」的那些单之后，且服务端的顺序不随请求变化",
  { skip: SKIP_SESSION },
  async (t) => {
    const readPool = async () => {
      const response = await fetch(new URL("/api/companion/dispatches", BASE), {
        headers: { cookie: SESSION_COMPANION },
      });
      assert.equal(response.status, 200, "打手会话必须能读到订单池");
      return (await response.json()).data;
    };

    const postJson = async (pathname, body) => {
      const response = await fetch(new URL(pathname, BASE), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", cookie: SESSION_ORDER_USER },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.text() };
    };

    // ① 先读一次：这就是「我下单之前就已经在池子里」的那个子集。
    //    ⚠️ 它只当**集合**用（后面拿它与后续读到的列表求交），永远不要把它当成
    //    「整张表应该长什么样」——别的用例文件随时会在服务端加单、清扫也会减单
    const before = await readPool();
    assert.equal(before.canAccept, true, "这位打手此刻必须能接单，否则公共池一条都不会返回");
    const preExisting = new Set(dispatchIds(before.public));
    const preExistingExclusive = new Set(dispatchIds(before.exclusive));

    // 池子空着的时候这条用例无法自证（没有任何「更早进池」的单作参照）。
    // 那是**环境状态**而不是业务回归：如实跳过并说明，而不是让一条空转的用例冒充通过
    if (preExisting.size === 0) {
      t.skip("服务端公共池此刻一单都没有：本条用例需要「我下单前就在池里」的单作参照");
      return;
    }

    // ② 真的在服务端造一张单：创建支付请求 → 模拟渠道确认成功。
    //    订单只在支付成功后生成，因此拿到 orderId 时它已经进池了；没指定护航 → 公共池
    const pay = await postJson("/api/orders/pay", {
      idempotencyKey: uniqueKey(),
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
    });
    assert.equal(pay.status, 200, `HTTP 下单必须成功：${pay.body}`);
    const paymentRequestId = JSON.parse(pay.body).data.id;

    const confirm = await postJson("/api/payments/mock-confirm", {
      paymentRequestId,
      result: "success",
    });
    assert.equal(confirm.status, 200, `HTTP 支付确认必须成功：${confirm.body}`);
    const orderId = JSON.parse(confirm.body).data.orderId;
    assert.ok(orderId, "支付成功后必须拿到 orderId");

    // ③ 再读一次：服务端现在应该把我这一单也返回了
    const after = await readPool();
    const afterIds = dispatchIds(after.public);

    const mine = after.public.find((item) => item.orderId === orderId);
    assert.ok(
      mine,
      "刚支付成功的单必须出现在服务端返回的公共池里——这一句同时是「接口真的在从服务端取数」的证据",
    );
    assert.equal(mine.pool, "public", "没指定护航的单必须落在公共池");
    assert.equal(
      after.exclusive.some((item) => item.orderId === orderId),
      false,
      "没指定护航的单不该出现在专属池里",
    );

    // 「最新进池的排在更下面」用**相对**结论表达，因此对并发新增免疫：
    // 只断言我这一单排在「下单前就在池里」的那些单之后。
    // ⚠️ **不是**断言它是最后一名：别的用例文件可能在我读之前又插进来一单
    const myIndex = afterIds.indexOf(mine.dispatchId);
    const earlier = afterIds
      .map((dispatchId, index) => ({ dispatchId, index }))
      .filter((entry) => preExisting.has(entry.dispatchId));
    const lastEarlier = earlier.length > 0 ? Math.max(...earlier.map((entry) => entry.index)) : -1;
    for (const entry of earlier) {
      assert.ok(
        myIndex > entry.index,
        `刚进池的这一单（${mine.dispatchId}）在第 ${myIndex} 位，却排在了「我下单前就在池里」的 ${entry.dispatchId}（第 ${entry.index} 位）之前：最新进池的必须排在更下面`,
      );
    }

    // ④ 顺序稳定性：只比**子集**，不比整表。
    //    子集取「① 就在池里」与「三次读都还在池里」的交——中途正好被清扫掉的那一单
    //    属于并发「移除」，与并发新增一样是别的用例造成的，不该由这条用例承担
    //    （长度变化与顺序变化是两件事，混在一起断言只会让用例变脆）
    const second = await readPool();
    const third = await readPool();
    const reads = [after, second, third];
    const readIds = reads.map((data) => dispatchIds(data.public));
    const stable = readIds[0].filter(
      (dispatchId) =>
        preExisting.has(dispatchId) &&
        readIds[1].includes(dispatchId) &&
        readIds[2].includes(dispatchId),
    );
    /** 把一张 id 序列收窄到 `subset` 上，保留它给出的先后。 */
    const restrict = (ids, subset) => ids.filter((dispatchId) => subset.includes(dispatchId));

    assert.deepEqual(
      restrict(readIds[1], stable),
      restrict(readIds[0], stable),
      "第二次读到的顺序必须与第一次逐字相同：顺序是服务端的结论，不是随请求变化的随机值",
    );
    assert.deepEqual(
      restrict(readIds[2], stable),
      restrict(readIds[0], stable),
      "第三次读到的顺序必须与第一次逐字相同",
    );

    // 专属池用同一口径（这位打手此刻没有专属单就是空集，空集同样必须逐字相同）
    const exclusiveIds = reads.map((data) => dispatchIds(data.exclusive));
    const stableExclusive = exclusiveIds[0].filter(
      (dispatchId) =>
        preExistingExclusive.has(dispatchId) &&
        exclusiveIds[1].includes(dispatchId) &&
        exclusiveIds[2].includes(dispatchId),
    );
    assert.deepEqual(
      restrict(exclusiveIds[1], stableExclusive),
      restrict(exclusiveIds[0], stableExclusive),
      "专属池的顺序同样必须逐字稳定",
    );
    assert.deepEqual(
      restrict(exclusiveIds[2], stableExclusive),
      restrict(exclusiveIds[0], stableExclusive),
      "专属池的顺序同样必须逐字稳定",
    );

    t.diagnostic(
      `公共池：下单前 ${preExisting.size} 条 → 读完 ${afterIds.length} 条；` +
        `我这一单在第 ${myIndex} 位；参照单里最靠后的是第 ${lastEarlier} 位（共 ${earlier.length} 条）；` +
        `三次读的稳定子集 ${stable.length} 条`,
    );
  },
);
