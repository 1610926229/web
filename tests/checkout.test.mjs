import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_ACCOUNT_EMPTY_MESSAGE,
  GAME_ACCOUNT_INVALID_MESSAGE,
  validateGameAccount,
} from "../lib/constants/checkout.ts";
import { getCatalogRepository } from "../lib/data/catalogRepository.ts";
import { catalogStore } from "../lib/data/mockCatalogRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  parseSelectionInput,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { queryOrdersForUser } from "../lib/services/orders.ts";

/**
 * 结算、金额与支付幂等的测试。
 *
 * 断言的是**真实实现**：`lib/services/checkout.ts` 与真实的 Mock 仓储，
 * 不是复制一份逻辑再测一遍复制品。
 *
 * 每个进程有一份独立的内存仓储（node 的测试运行器对每个文件起一个子进程），
 * 因此这里的写入不会影响 `orders.test.mjs` 的分页与筛选断言；
 * 但本文件内部共享仓储，所以下面用 `uniqueUser()` 给每个用例一个独立用户，
 * 用例之间不会互相看到对方创建的订单。
 */

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", specPrice: 2990, region: "手游" };
const ADDON_RUSH = { id: "ad-rush", price: 1500 };
const ADDON_VOICE = { id: "ad-voice", price: 1000 };

let userSeq = 0;
/** 每个用例一个全新用户 id，避免用例之间互相污染订单列表。 */
function uniqueUser() {
  userSeq += 1;
  return `u-test-${process.pid}-${userSeq}`;
}

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `test-key-${process.pid}-${keySeq}`;
}

function selection(overrides = {}) {
  return {
    ...PRODUCT,
    quantity: 1,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
    ...overrides,
  };
}

function preview(input = {}) {
  return previewCheckout(selection(input), undefined, "server");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ——————————————————————————— 游戏 ID 校验 ———————————————————————————

test("游戏 ID 校验：未填写与只填空格都提示「请填写游戏 ID」", () => {
  for (const raw of ["", " ", "   ", "\t\n"]) {
    const result = validateGameAccount(raw);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty");
    assert.equal(result.message, GAME_ACCOUNT_EMPTY_MESSAGE);
  }
});

test("游戏 ID 校验：格式不合法提示「请输入有效的游戏 ID」", () => {
  for (const raw of ["bad id!", "moyu#1001", "中文 ID", "a".repeat(33), "@@@@"]) {
    const result = validateGameAccount(raw);
    assert.equal(result.ok, false, `${JSON.stringify(raw)} 不应通过校验`);
    assert.equal(result.message, GAME_ACCOUNT_INVALID_MESSAGE);
  }
});

test("游戏 ID 校验：首尾空格被裁掉，合法 ID 通过", () => {
  for (const raw of ["moyu_1001", "  moyu_1001  ", "moyu-1001", "阿泽123", "a1"]) {
    const result = validateGameAccount(raw);
    assert.equal(result.ok, true, `${JSON.stringify(raw)} 应当通过校验`);
    assert.equal(result.value, raw.trim());
  }
});

test("试算不要求填游戏 ID，正式下单要求", async () => {
  // 用户还没填完表单时就该看到金额，试算因此不校验游戏 ID
  const draft = await preview({ gameAccountId: "" });
  assert.equal(draft.totalAmount, PRODUCT.specPrice);

  const user = uniqueUser();
  await assert.rejects(
    () =>
      createPaymentRequest(
        { ...selection({ gameAccountId: "   " }), idempotencyKey: uniqueKey() },
        user,
      ),
    (error) => error.code === "BAD_REQUEST" && error.message === GAME_ACCOUNT_EMPTY_MESSAGE,
  );
});

test("校验失败不留下任何支付请求", async () => {
  const user = uniqueUser();
  const key = uniqueKey();

  await assert.rejects(() =>
    createPaymentRequest(
      { ...selection({ gameAccountId: "bad id!" }), idempotencyKey: key },
      user,
    ),
  );

  assert.equal(await getPaymentRepository().findPaymentRequestByKey(user, key), null);
  assert.equal((await queryOrdersForUser(user, new URLSearchParams(), "server")).total, 0);
});

// ——————————————————————————— 金额 ———————————————————————————

test("金额以「分」为单位，全部是整数且等于单价 × 数量 + 增值服务", async () => {
  const result = await preview({ quantity: 3, addonIds: [ADDON_RUSH.id, ADDON_VOICE.id] });

  assert.equal(result.spec.price, PRODUCT.specPrice);
  assert.equal(result.itemsAmount, PRODUCT.specPrice * 3);
  assert.equal(result.addonsAmount, ADDON_RUSH.price + ADDON_VOICE.price);
  assert.equal(result.totalAmount, result.itemsAmount + result.addonsAmount);

  for (const amount of [result.spec.price, result.itemsAmount, result.addonsAmount, result.totalAmount]) {
    assert.ok(Number.isInteger(amount), "金额必须是整数分，不能出现浮点数");
  }
});

test("增值服务按单计费，不随数量翻倍；重复选择同一项只算一次", async () => {
  const one = await preview({ quantity: 1, addonIds: [ADDON_RUSH.id] });
  const five = await preview({ quantity: 5, addonIds: [ADDON_RUSH.id] });
  const duplicated = await preview({ quantity: 1, addonIds: [ADDON_RUSH.id, ADDON_RUSH.id] });

  assert.equal(one.addonsAmount, five.addonsAmount);
  assert.equal(duplicated.addonsAmount, ADDON_RUSH.price);
  assert.equal(duplicated.addons.length, 1);
});

test("客户端提交的金额字段被忽略：解析时按白名单取字段，下单金额由服务端重算", async () => {
  const parsed = parseSelectionInput({
    ...selection(),
    price: 1,
    unitPrice: 1,
    totalAmount: 1,
    itemsAmount: 1,
    addonsAmount: 1,
  });
  for (const field of ["price", "unitPrice", "totalAmount", "itemsAmount", "addonsAmount"]) {
    assert.ok(!(field in parsed), `解析结果不应包含客户端提交的 ${field}`);
  }

  const user = uniqueUser();
  const { request } = await createPaymentRequest(
    {
      ...selection({ quantity: 2, addonIds: [ADDON_RUSH.id] }),
      idempotencyKey: uniqueKey(),
      totalAmount: 1,
      unitPrice: 1,
    },
    user,
  );

  assert.equal(request.itemsAmount, PRODUCT.specPrice * 2);
  assert.equal(request.addonsAmount, ADDON_RUSH.price);
  assert.equal(request.totalAmount, PRODUCT.specPrice * 2 + ADDON_RUSH.price);
});

test("商品、规格、大区、数量非法一律拒绝", async () => {
  const cases = [
    { productId: "p-not-exist" },
    { specId: "s-not-exist" },
    { region: "火星" },
    { quantity: 0 },
    { quantity: 1.5 },
    { quantity: 100 },
  ];

  for (const override of cases) {
    await assert.rejects(
      () =>
        createPaymentRequest(
          { ...selection(override), idempotencyKey: uniqueKey() },
          uniqueUser(),
        ),
      (error) => error.code === "BAD_REQUEST" || error.code === "NOT_FOUND",
      `${JSON.stringify(override)} 应当被拒绝`,
    );
  }
});

// ——————————————————————————— 幂等 ———————————————————————————

test("相同幂等键只创建一条支付请求，并发提交也不例外", async () => {
  const user = uniqueUser();
  const key = uniqueKey();
  const input = { ...selection({ quantity: 2 }), idempotencyKey: key };

  const results = await Promise.all(Array.from({ length: 6 }, () => createPaymentRequest(input, user)));

  const created = results.filter((item) => item.created);
  assert.equal(created.length, 1, "并发提交只能有一次真正创建");
  assert.equal(new Set(results.map((item) => item.request.id)).size, 1, "六次提交必须是同一条请求");

  const stored = await getPaymentRepository().findPaymentRequestByKey(user, key);
  assert.equal(stored.id, results[0].request.id);
});

test("重复提交不是「重新算一遍」：第一次的结果被原样返回", async () => {
  const user = uniqueUser();
  const key = uniqueKey();

  const first = await createPaymentRequest(
    { ...selection({ quantity: 3, addonIds: [ADDON_VOICE.id] }), idempotencyKey: key },
    user,
  );
  // 第二次即使换了数量，也应当返回第一次那条请求
  const second = await createPaymentRequest(
    { ...selection({ quantity: 9 }), idempotencyKey: key },
    user,
  );

  assert.equal(second.created, false);
  assert.equal(second.request.id, first.request.id);
  assert.equal(second.request.quantity, 3);
  assert.equal(second.request.totalAmount, first.request.totalAmount);
});

test("缺少或非法幂等键直接拒绝，不写入任何记录", async () => {
  const user = uniqueUser();

  for (const idempotencyKey of ["", "short", "带中文的键", "a".repeat(65)]) {
    await assert.rejects(
      () => createPaymentRequest({ ...selection(), idempotencyKey }, user),
      (error) => error.code === "BAD_REQUEST",
    );
  }
  assert.equal((await queryOrdersForUser(user, new URLSearchParams(), "server")).total, 0);
});

// ——————————————————————————— 支付结果与订单 ———————————————————————————

/** 走完「下单 → 支付」整条链路，返回订单。 */
async function payAndOrder(user, result) {
  const key = uniqueKey();
  const created = await createPaymentRequest({ ...selection(), idempotencyKey: key }, user);
  const confirmed = await confirmPaymentRequest(created.request.id, result, user);

  assert.equal(confirmed.ok, true);
  return confirmed;
}

test("支付成功生成订单，金额与请求一致且状态为「已付款」", async () => {
  const user = uniqueUser();
  const confirmed = await payAndOrder(user, "success");

  assert.equal(confirmed.orderCreated, true);
  assert.ok(confirmed.order);
  assert.equal(confirmed.order.userId, user);
  assert.equal(confirmed.order.status, "paid");
  assert.equal(confirmed.order.totalAmount, confirmed.request.totalAmount);
  assert.equal(confirmed.order.itemsAmount, PRODUCT.specPrice);
  // 新订单只有「已付款」这一个时间节点
  assert.equal(confirmed.order.acceptedAt, null);
  assert.equal(confirmed.order.servingAt, null);
  assert.equal(confirmed.order.completedAt, null);
  assert.equal(confirmed.order.refundedAt, null);
  // 未选择陪玩时如实为 null，页面据此显示「等待接单」
  assert.equal(confirmed.order.companion, null);
  assert.equal(confirmed.order.companionId, null);
});

// ——————————————————————————— 金额域（P0-3）———————————————————————————

/** 预置商品的分账比例：不写死 8000，从目录里读——比例改了这条测试就该跟着变。 */
async function productRateBp() {
  const record = await getCatalogRepository().findProductById(PRODUCT.productId);
  assert.ok(record, `预置商品 ${PRODUCT.productId} 应当存在`);
  return record.companionRateBp;
}

/**
 * 金额域是**下单那一刻冻结在订单上**的一组数，不是一个可以随时现算的视图。
 *
 * 这里逐条锁住 `lib/constants/orderAmount.ts` 的公式在真实下单路径上的落点：
 * 比例来自商品快照、取整方向是向下、恒等式成立、累计已退从 0 起。
 */
test("支付成功时冻结金额域：原价 / 券 / 实付 / 比例快照 / 护航收益 / 平台净收入 / 累计已退", async () => {
  const user = uniqueUser();
  const rateBp = await productRateBp();
  const key = uniqueKey();

  // 带一个增值服务下单：这样「原价」与「实付」是否含增值服务才有区分度
  const created = await createPaymentRequest(
    { ...selection({ addonIds: [ADDON_RUSH.id] }), idempotencyKey: key },
    user,
  );
  assert.equal(created.request.companionRateSnapshot, rateBp, "比例在下单这一刻冻结进支付请求");

  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  const order = confirmed.order;
  assert.ok(order);

  // R3 未确认：参与分账的基数当前是「商品金额」，**不含增值服务**（见 orderAmount.ts）
  assert.equal(order.originalAmount, order.itemsAmount);
  assert.notEqual(order.originalAmount, order.totalAmount, "含增值服务时原价与订单合计不是同一个数");

  // P0 没有优惠券：抵扣恒为 0，所以实付 = 原价
  assert.equal(order.couponDiscountAmount, 0);
  assert.equal(order.actualPaidAmount, order.originalAmount - order.couponDiscountAmount);

  assert.equal(order.companionRateSnapshot, rateBp);
  assert.equal(
    order.companionBaseIncome,
    Math.floor((order.originalAmount * rateBp) / 10000),
    "护航收益 = 原价 × 比例，向下取整",
  );
  // 平台净收入是**差额**而不是「实付 × 剩余比例」：两处各取一次整会让恒等式失效
  assert.equal(order.clubNetIncome, order.actualPaidAmount - order.companionBaseIncome);
  assert.equal(
    order.companionBaseIncome + order.clubNetIncome,
    order.actualPaidAmount,
    "分掉的钱必须恰好等于实付：账面上不能凭空多一分或少一分",
  );

  // 刚创建的订单一笔都没退过
  assert.equal(order.refundedAmount, 0);

  // 全部是整数分
  for (const amount of [
    order.originalAmount,
    order.couponDiscountAmount,
    order.actualPaidAmount,
    order.companionBaseIncome,
    order.clubNetIncome,
    order.refundedAmount,
  ]) {
    assert.ok(Number.isInteger(amount), "金额域也必须全是整数分");
  }
});

test("下单后改商品比例：已经冻结的那一单一分不变", async () => {
  const user = uniqueUser();
  const rateBp = await productRateBp();
  const key = uniqueKey();

  // 先建支付请求（比例在此刻冻结），**确认之前**去改商品比例
  const created = await createPaymentRequest({ ...selection(), idempotencyKey: key }, user);

  // 直接改目录里那条记录：这是「管理员在后台改了比例」在数据层的样子
  const record = catalogStore().products.get(PRODUCT.productId);
  assert.ok(record, "预置商品应当在目录里");
  const original = record.companionRateBp;
  // 改成一个一定看得出差别的比例（70%）
  record.companionRateBp = 7000;

  try {
    const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
    assert.ok(confirmed.order);
    assert.equal(
      confirmed.order.companionRateSnapshot,
      rateBp,
      "订单用的是下单那一刻冻住的比例，不是商品今天的比例",
    );
    assert.equal(
      confirmed.order.companionBaseIncome,
      Math.floor((confirmed.order.originalAmount * rateBp) / 10000),
      "改商品比例不能改写已经发生的那一单的钱",
    );

    // 而**之后**的新订单才用新比例：这正是「历史订单读快照」该有的样子
    const later = await createPaymentRequest(
      { ...selection(), idempotencyKey: uniqueKey() },
      uniqueUser(),
    );
    assert.equal(later.request.companionRateSnapshot, 7000);
  } finally {
    // 目录是全文件共享的：还原，免得后面的用例读到 70%
    record.companionRateBp = original;
  }
});

test("重复确认成功只生成一个订单", async () => {
  const user = uniqueUser();
  const key = uniqueKey();
  const created = await createPaymentRequest({ ...selection(), idempotencyKey: key }, user);

  const first = await confirmPaymentRequest(created.request.id, "success", user);
  const second = await confirmPaymentRequest(created.request.id, "success", user);
  const third = await confirmPaymentRequest(created.request.id, "success", user);

  assert.equal(first.orderCreated, true);
  assert.equal(second.orderCreated, false);
  assert.equal(third.orderCreated, false);
  assert.equal(second.order.id, first.order.id);
  assert.equal(third.order.id, first.order.id);

  const page = await queryOrdersForUser(user, new URLSearchParams(), "server");
  assert.equal(page.total, 1, "重复确认不能多出订单");
});

test("并发确认成功也只生成一个订单", async () => {
  const user = uniqueUser();
  const created = await createPaymentRequest({ ...selection(), idempotencyKey: uniqueKey() }, user);

  const results = await Promise.all(
    Array.from({ length: 6 }, () => confirmPaymentRequest(created.request.id, "success", user)),
  );

  assert.equal(results.filter((item) => item.orderCreated).length, 1);
  assert.equal(new Set(results.map((item) => item.order.id)).size, 1);
  assert.equal((await queryOrdersForUser(user, new URLSearchParams(), "server")).total, 1);
});

test("支付失败与取消都不生成订单，也不出现在订单列表里", async () => {
  for (const result of ["failure", "cancel"]) {
    const user = uniqueUser();
    const confirmed = await payAndOrder(user, result);

    assert.equal(confirmed.orderCreated, false);
    assert.equal(confirmed.order, null);
    assert.equal(confirmed.request.orderId, null);
    assert.notEqual(confirmed.request.status, "success");

    const page = await queryOrdersForUser(user, new URLSearchParams(), "server");
    assert.equal(page.total, 0, "失败 / 取消的支付请求不应进入订单列表");
  }
});

test("支付成功后订单出现在同一仓储的列表里，且按支付时间排在最新", async () => {
  const user = uniqueUser();

  const first = await payAndOrder(user, "success");
  await sleep(10); // 拉开支付时间，避免同一毫秒内无法比较先后
  const second = await payAndOrder(user, "success");

  const page = await queryOrdersForUser(user, new URLSearchParams(), "server");
  assert.equal(page.total, 2);
  // 同一条查询路径：动态订单与预置订单走的是同一个仓储、同一个 queryOrders
  assert.equal(page.items[0].id, second.order.id);
  assert.equal(page.items[1].id, first.order.id);
});

test("新支付的订单立即出现在预置数据之前（P4 动态订单与 P5A 预置订单同源）", async () => {
  const user = "u-1001";
  const before = await queryOrdersForUser(user, new URLSearchParams(), "server");

  const paid = await payAndOrder(user, "success");
  const after = await queryOrdersForUser(user, new URLSearchParams(), "server");

  assert.equal(after.total, before.total + 1);

  const at = after.items.findIndex((item) => item.id === paid.order.id);
  assert.ok(at >= 0, "刚支付成功的订单必须出现在列表里");

  // 排在它前面的订单支付时间不早于它——不依赖「当前时间一定晚于预置数据」这个假设
  for (const item of after.items.slice(0, at)) {
    assert.ok(Date.parse(item.paidAt) >= Date.parse(paid.order.paidAt));
  }

  // 付完款以后按状态筛选也能查到它
  const paidOnly = await queryOrdersForUser(user, new URLSearchParams({ status: "paid" }), "server");
  assert.ok(paidOnly.items.some((item) => item.id === paid.order.id));
});

test("结果页 / 详情页取订单时只认订单所有者", async () => {
  const user = uniqueUser();
  const confirmed = await payAndOrder(user, "success");

  const { getOrderForUser } = await import("../lib/services/checkout.ts");
  assert.equal((await getOrderForUser(confirmed.order.id, user)).id, confirmed.order.id);
  assert.equal(await getOrderForUser(confirmed.order.id, "u-1002"), null);
  assert.equal(await getOrderForUser("ord-not-exist", user), null);
});
