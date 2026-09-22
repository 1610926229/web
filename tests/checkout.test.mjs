import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_ACCOUNT_EMPTY_MESSAGE,
  GAME_ACCOUNT_INVALID_MESSAGE,
  validateGameAccount,
} from "../lib/constants/checkout.ts";
import { getCatalogRepository } from "../lib/data/catalogRepository.ts";
import { catalogStore } from "../lib/data/mockCatalogRepository.ts";
import { companionStore } from "../lib/data/mockCompanionRepository.ts";
import { getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { isCompanionAcceptingOrders } from "../lib/constants/companions.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  parseSelectionInput,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { queryOrdersForUser } from "../lib/services/orders.ts";
import { resolveSource } from "./app-path.mjs";
import { readSource, stripComments } from "./source-text.mjs";

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

// ————————————————— 结算页指定陪玩：复用中央接单资格判断（P0-5.5 R5）—————————————————
//
// 「这个人现在能不能被指定」与「这个人现在能不能接新单」是同一条规则，
// 因此它必须只有一个定义处（`lib/constants/companions.ts` 的 `isCompanionAcceptingOrders`）。
// 这一节从**两个方向**钉住它：
//
// ① **行为**：同一份资料喂给结算页与谓词本身，两者必须给出同一个答案（下面第 19 条）；
// ② **源码**：结算页不再自己写一份「名单 + available」的判断（下面第 20 条）。
//
// ⚠️ 第 19 条**不是**把 `!isCompanionListed(x) || !x.available` 抄进测试里再比一遍——
//    那只是把第三份拷贝搬到测试文件里，而真值源仍然有三份。

/** 在架、当前可接单。 */
const COMPANION_OK = "cp-1";
/** 在架但暂停接单（`available: false`），资料仍在公开名单里。 */
const COMPANION_PAUSED = "cp-4";
/** 已下架（`enabled: false`）。 */
const COMPANION_DISABLED = "cp-7";

/** 结算页拒绝一个不可选的陪玩时给出的原文案（R5：不得改变任何对外文案）。 */
const COMPANION_UNAVAILABLE_MESSAGE = "该陪玩当前不可选，请重新选择";

/**
 * 临时给一条陪玩资料打补丁，返回还原函数。
 *
 * 陪玩 store 的 `createStore` 会把种子里每条记录**复制**一层再放进 Map，
 * 因此就地改 Map 里那条不会污染模块级的种子；但还是要还原——
 * 同一份 store 在本文件内是共享的，不还原就会漏给后面的用例。
 */
function withCompanionPatch(id, patch) {
  const record = companionStore().companions.get(id);
  assert.ok(record, `预置陪玩 ${id} 必须存在`);
  const original = { ...record };
  Object.assign(record, patch);
  return () => {
    Object.assign(record, original);
  };
}

/** 结算页是否**接受**这个陪玩。只关心「过不过」，不关心失败的文案（那是上面几条的事）。 */
async function checkoutAccepts(companionId) {
  try {
    await preview({ companionId });
    return true;
  } catch {
    return false;
  }
}

test("指定已下架的陪玩：试算与正式下单都被挡成 BAD_REQUEST + 原文案", async () => {
  // 隔离 enabled 这一项：把在架且可接单的那位临时下架，available 与 removedAt 都不动，
  // 这样红的只可能是「不在名单里」这一半判定（cp-7 那位同时 available=false，分不清是谁挡的）
  const restore = withCompanionPatch(COMPANION_OK, { enabled: false });
  try {
    const record = companionStore().companions.get(COMPANION_OK);
    assert.equal(record.available, true, "这条用例要隔离 enabled：available 必须仍是 true");
    assert.equal(record.removedAt, null, "这条用例要隔离 enabled：removedAt 必须仍是 null");

    await assert.rejects(
      () => preview({ companionId: COMPANION_OK }),
      (error) =>
        error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
      "试算就该挡下：用户不该先看到一个能算出来的价",
    );

    const user = uniqueUser();
    const idempotencyKey = uniqueKey();
    await assert.rejects(
      () =>
        createPaymentRequest(
          { ...selection({ companionId: COMPANION_OK }), idempotencyKey },
          user,
        ),
      (error) =>
        error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
      "绕过页面直接下单同样挡得住",
    );

    // 被挡下的请求不留痕迹：既没有支付请求，也没有订单
    assert.equal(await getPaymentRepository().findPaymentRequestByKey(user, idempotencyKey), null);
    assert.equal((await queryOrdersForUser(user, new URLSearchParams(), "server")).total, 0);
  } finally {
    restore();
  }

  // 预置的「已下架」那位同样挡得住（enabled 与 available 都是 false 的真实数据）
  assert.equal(companionStore().companions.get(COMPANION_DISABLED).enabled, false);
  await assert.rejects(
    () => preview({ companionId: COMPANION_DISABLED }),
    (error) => error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
  );
});

test("指定已被移除的陪玩：同样被挡——移除与下架是两件事，对外是同一个结果", async () => {
  // 隔离 removedAt 这一项：enabled 与 available 都保持 true
  const restore = withCompanionPatch(COMPANION_OK, { removedAt: "2026-09-20T00:00:00.000Z" });
  try {
    const record = companionStore().companions.get(COMPANION_OK);
    assert.equal(record.enabled, true, "这条用例要隔离 removedAt：enabled 必须仍是 true");

    await assert.rejects(
      () => preview({ companionId: COMPANION_OK }),
      (error) =>
        error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
    );

    await assert.rejects(
      () =>
        createPaymentRequest(
          { ...selection({ companionId: COMPANION_OK }), idempotencyKey: uniqueKey() },
          uniqueUser(),
        ),
      (error) =>
        error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
    );
  } finally {
    restore();
  }
});

test("指定暂停接单的陪玩：被挡（人还在名单里、详情页正常可见，只是现在不接新单）", async () => {
  const record = companionStore().companions.get(COMPANION_PAUSED);
  // 起点自检：这位是在架的、没有被移除，红的只可能是 available
  assert.equal(record.enabled, true);
  assert.equal(record.removedAt, null);
  assert.equal(record.available, false);

  await assert.rejects(
    () => preview({ companionId: COMPANION_PAUSED }),
    (error) => error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
    "暂停接单不该只是列表上的一个字",
  );

  await assert.rejects(
    () =>
      createPaymentRequest(
        { ...selection({ companionId: COMPANION_PAUSED }), idempotencyKey: uniqueKey() },
        uniqueUser(),
      ),
    (error) => error.code === "BAD_REQUEST" && error.message === COMPANION_UNAVAILABLE_MESSAGE,
  );
});

test("指定正常陪玩：试算与下单一律照旧（金额、快照、返回结构都不变）", async () => {
  const draft = await preview({
    companionId: COMPANION_OK,
    quantity: 2,
    addonIds: [ADDON_RUSH.id],
  });

  assert.equal(draft.itemsAmount, PRODUCT.specPrice * 2, "指定陪玩不影响商品金额");
  assert.equal(draft.addonsAmount, ADDON_RUSH.price);
  assert.equal(draft.totalAmount, PRODUCT.specPrice * 2 + ADDON_RUSH.price);
  // 返回结构是契约：换了判定方式，DTO 一个字段都不该多、不该少
  assert.deepEqual(Object.keys(draft).sort(), [
    "addons",
    "addonsAmount",
    "itemsAmount",
    "product",
    "quantity",
    "spec",
    "totalAmount",
  ]);

  const user = uniqueUser();
  const created = await createPaymentRequest(
    { ...selection({ companionId: COMPANION_OK }), idempotencyKey: uniqueKey() },
    user,
  );
  assert.equal(created.created, true);
  assert.equal(created.request.companionId, COMPANION_OK);
  assert.equal(created.request.snapshot.companion?.id, COMPANION_OK);
  assert.equal(created.request.snapshot.companion?.name.length > 0, true, "快照仍带上昵称");

  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  // 下单只进池：订单上还没有「实际接单的人」
  assert.equal(confirmed.order.actualCompanionId, null);
  assert.equal(confirmed.order.companion, null);
});

/**
 * 「复用中央谓词」要证明的是**行为一致**：同一份资料，两条判断路径给出同一个答案。
 *
 * ⚠️ 这条用例**刻意不**在测试里重写 `isCompanionListed(x) && x.available`：
 *    把谓词抄进来再比对，只是把第三份拷贝搬了个地方——真值源仍然是两份，
 *    而两份里任何一份改了，测试都只会安静地跟着一起变。
 *    这里比对的是**结算页的行为**与**谓词本身**。
 */
test("行为一致：结算页的可选性与 isCompanionAcceptingOrders() 对同一份资料给出同一答案", async () => {
  const fixtures = [
    { id: COMPANION_OK, patch: {}, label: "在架 + 可接单" },
    { id: COMPANION_PAUSED, patch: {}, label: "在架 + 暂停接单" },
    { id: COMPANION_DISABLED, patch: {}, label: "已下架" },
    { id: COMPANION_OK, patch: { removedAt: "2026-09-20T00:00:00.000Z" }, label: "在架 + 已被移除" },
    {
      id: COMPANION_OK,
      patch: { available: false, removedAt: "2026-09-20T00:00:00.000Z" },
      label: "同时暂停接单与已被移除",
    },
  ];

  /** 每一格得到的答案。循环后要用它自检「两侧都覆盖到了」，见下面的断言。 */
  const answers = [];

  for (const fixture of fixtures) {
    const restore = withCompanionPatch(fixture.id, fixture.patch);
    try {
      const record = companionStore().companions.get(fixture.id);
      const expected = isCompanionAcceptingOrders({ ...record });
      const accepted = await checkoutAccepts(fixture.id);

      assert.equal(
        accepted,
        expected,
        `${fixture.id}（${fixture.label}）结算页与谓词给出了不同答案`,
      );
      answers.push(accepted);
    } finally {
      restore();
    }
  }

  // 自检：这张夹具表必须同时覆盖「可选」与「不可选」两侧。
  // 若哪天所有夹具都变成不可选，「两边一致」就退化成了「两边都拒绝」，什么也证明不了。
  assert.ok(answers.includes(true), "夹具里必须有一位是可选的，否则这条比对没有鉴别力");
  assert.ok(answers.includes(false), "夹具里必须有一位是不可选的");
});

test("源码防回流：checkout.ts 不再内联「名单 + available」判断，改由一个谓词回答", () => {
  const code = stripComments(readSource(resolveSource("lib/services/checkout.ts")));

  // 第四份拷贝的回流：把 `!isCompanionListed(c) || !c.available` 再写一遍
  assert.equal(
    code.includes("isCompanionListed"),
    false,
    "结算页不该再自己判断「在不在名单里」——那会与列表 / 详情的口径分叉",
  );
  assert.equal(
    code.includes(".available"),
    false,
    "结算页不该再直接读 available —— 那正是第四份拷贝的起点",
  );

  // 但判断必须还在（而不是被整段删掉）：由中央谓词回答
  assert.match(
    code,
    /if\s*\(\s*!isCompanionAcceptingOrders\(\s*companion\s*\)\s*\)/,
    "指定陪玩的资格判断必须由 isCompanionAcceptingOrders() 回答",
  );
  assert.match(
    code,
    /throw new ApiError\(\s*"BAD_REQUEST"\s*,\s*"该陪玩当前不可选，请重新选择"\s*\)/,
    "挡住之后的失败语义与文案不得改变",
  );
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
  // P0-5：下单**只是进了订单池**，还没有人接单——「实际接单的人」必须为空。
  // 用户当初有没有指定人，记在派单的 exclusiveCompanionId 上，不写进这个字段。
  assert.equal(confirmed.order.actualCompanionId, null);
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

  // 原价 = 商品金额 + 全部增值服务金额（R3 已确认：增值服务参与分账，
  // 但原价与分账基数是两个概念，这一点由 tests/orderAmountSplit.test.mjs 单独锁住）
  assert.equal(order.originalAmount, order.itemsAmount + order.addonsAmount);
  assert.ok(order.addonsAmount > 0, "这条用例必须带增值服务，否则区分不出原价含不含它");
  assert.equal(order.originalAmount, order.totalAmount, "无券时原价与渠道实收是同一个数");

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
