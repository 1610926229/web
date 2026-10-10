import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveClubNetIncome,
  resolveCompanionBaseIncome,
  resolveCompanionRevenueBase,
  resolveOrderMoneyDomain,
} from "../lib/constants/orderAmount.ts";
import {
  assertRefundAmountWithinPaid,
  computeRefundDecisionAmounts,
  isFullyRefunded,
  platformNetIncome,
} from "../lib/constants/refunds.ts";

/**
 * 优惠券金额链（P1-4）——把**已冻结**的券公式在**非零券**输入下钉住。
 *
 * ## 为什么需要单独一个文件
 *
 * 全仓库此前**没有任何测试**用非零的 `couponDiscountAmount` 调用过
 * `resolveOrderMoneyDomain()`：现有 `tests/orderAmountSplit.test.mjs` 里
 * 「券由平台承担」那一条是**绕过合成点**、直接拿手写数字调
 * `resolveClubNetIncome(2000, 3200)` 的。也就是说公式的**每一块**都被测过，
 * 但「券走进合成点之后整条链还成立」从来没有被测过——而合成点恰恰是
 * 下单时唯一被调用的那个入口。
 *
 * ## 规则出处（全部已冻结，本文件不新增任何产品决定）
 *
 * - `超哥电竞_业务流程表.md` **§18 优惠券**：成本由平台承担；
 *   不改变 `originalAmount`；不改变 `companionRateSnapshot`；
 *   不降低 `companionBaseIncome` 的理论基础。原文算例：原价 50 / 分账 80% /
 *   券 10 / 实付 40 → 打手基础收益 40、平台基础净收入 0。
 * - **BF-04**：`actualPaidAmount = originalAmount - couponDiscountAmount`。
 * - **BF-05**：`clubNetIncome = actualPaidAmount - companionBaseIncome`，
 *   **允许为负**（`clubNetIncome < 0` 是正确结果，不得夹到 0）。
 * - 退款侧 `computeRefundDecisionAmounts` / `platformNetIncome` /
 *   `assertRefundAmountWithinPaid` / `isFullyRefunded` 的有券口径
 *   （P0-15 §三/§四：退款基数就是实付，冲回额整笔归零、与比例无关）。
 *
 * ## ⚠️ 刻意**不**测的东西
 *
 * 券还没接入 checkout（`lib/services/checkout.ts` 仍写死 `couponDiscountAmount: 0`），
 * 因此这里**没有**任何「券参与下单 / 核销 / 门槛 / 适用范围 / 折扣率语义 /
 * 叠加 / 使用次数 / 券快照」的断言——那些规则**尚未冻结**，
 * 写下来就等于替产品做了一个决定（`❓` 标记的行为不得写断言）。
 * 本文件只回答一个问题：**已冻结的公式喂进非零券之后还成不成立**。
 */

// ——————————————————— 一、需求 §18 的原始算例 ———————————————————

test("§18 原始算例：原价 5000 / 分账 80% / 券 1000 → 实付 4000、打手 4000、平台 0", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });

  assert.equal(domain.originalAmount, 5000, "原价不因券改变");
  assert.equal(domain.actualPaidAmount, 4000, "实付 = 原价 − 券");
  assert.equal(domain.companionBaseIncome, 4000, "打手基础收益按原价 5000 × 80% = 4000");
  assert.equal(domain.clubNetIncome, 0, "平台基础净收入 = 实付 4000 − 打手 4000 = 0");
});

// ——————————————————— 二、恒等式在有券时成立 ———————————————————

test("恒等式在有券时成立：打手收益 + 平台净收入 === 实付，且实付 === 原价 − 券", () => {
  const cases = [
    { itemsAmount: 5000, addonsAmount: 0, companionRateBp: 8000, couponDiscountAmount: 1000 },
    { itemsAmount: 3980, addonsAmount: 1000, companionRateBp: 8000, couponDiscountAmount: 500 },
    { itemsAmount: 10000, addonsAmount: 2000, companionRateBp: 3333, couponDiscountAmount: 1500 },
    { itemsAmount: 12345, addonsAmount: 678, companionRateBp: 5000, couponDiscountAmount: 3000 },
    { itemsAmount: 1, addonsAmount: 0, companionRateBp: 10000, couponDiscountAmount: 1 },
    { itemsAmount: 999, addonsAmount: 999, companionRateBp: 6666, couponDiscountAmount: 1234 },
  ];

  for (const input of cases) {
    const domain = resolveOrderMoneyDomain(input);
    const label = `商品 ${input.itemsAmount} / 增值 ${input.addonsAmount} / 比例 ${input.companionRateBp} / 券 ${input.couponDiscountAmount}`;

    assert.equal(domain.actualPaidAmount, domain.originalAmount - domain.couponDiscountAmount, `实付口径错误：${label}`);
    assert.equal(
      domain.companionBaseIncome + domain.clubNetIncome,
      domain.actualPaidAmount,
      `有券时恒等式必须成立：${label}`,
    );
  }
});

// ——————————————————— 三、券不改变原价 ———————————————————

test("券不改变原价：同一组商品/增值，券 0 与券 >0 两次调用 originalAmount 相等", () => {
  const base = { itemsAmount: 3980, addonsAmount: 1000, companionRateBp: 8000 };
  const noCoupon = resolveOrderMoneyDomain({ ...base, couponDiscountAmount: 0 });
  const withCoupon = resolveOrderMoneyDomain({ ...base, couponDiscountAmount: 880 });

  assert.equal(withCoupon.originalAmount, noCoupon.originalAmount);
  assert.equal(withCoupon.originalAmount, 4980);
  // 原价不变，变的是实付——这正是「券由平台承担」而不是「降价」的意思
  assert.notEqual(withCoupon.actualPaidAmount, noCoupon.actualPaidAmount);
});

// ——————————————————— 四、券不改变分账比例快照 ———————————————————

test("券不改变 companionRateSnapshot：快照恒等于输入的比例，与券无关", () => {
  for (const rateBp of [0, 3333, 8000, 10000]) {
    for (const couponDiscountAmount of [0, 1, 1000, 5000]) {
      const domain = resolveOrderMoneyDomain({
        itemsAmount: 5000,
        addonsAmount: 0,
        companionRateBp: rateBp,
        couponDiscountAmount,
      });
      assert.equal(
        domain.companionRateSnapshot,
        rateBp,
        `券 ${couponDiscountAmount} 不得改变分账比例快照（输入比例 ${rateBp}）`,
      );
    }
  }
});

// —————————————— 五、券不降低分账基数 / 打手基础收益（核心） ——————————————

test("券不降低打手基础收益：券 0 / 1000 / 3000 三次调用 companionBaseIncome 完全相等", () => {
  const itemsAmount = 5000;
  const addonsAmount = 0;
  const companionRateBp = 8000;

  const withNoCoupon = resolveOrderMoneyDomain({
    itemsAmount,
    addonsAmount,
    companionRateBp,
    couponDiscountAmount: 0,
  });
  const withSmallCoupon = resolveOrderMoneyDomain({
    itemsAmount,
    addonsAmount,
    companionRateBp,
    couponDiscountAmount: 1000,
  });
  const withBigCoupon = resolveOrderMoneyDomain({
    itemsAmount,
    addonsAmount,
    companionRateBp,
    couponDiscountAmount: 3000,
  });

  // 这是「优惠不转嫁给打手」的核心断言。刻意写成显式相等（而不是只写 >=），
  // 否则「券越大打手拿得越少」这种转嫁会被一个 >= 静默放过。
  assert.equal(
    withBigCoupon.companionBaseIncome,
    withNoCoupon.companionBaseIncome,
    "券越大打手收益越少 = 把优惠转嫁给了打手",
  );
  assert.equal(
    withSmallCoupon.companionBaseIncome,
    withNoCoupon.companionBaseIncome,
    "券不得降低打手基础收益",
  );

  // 三次都等于「分账基数 × 比例」那个**理论值**——分账基数由决策点单独给出，
  // 与券无关（券只减实付，不减基数）。
  const theoretical = resolveCompanionBaseIncome(
    resolveCompanionRevenueBase(itemsAmount, addonsAmount),
    companionRateBp,
  );
  assert.equal(theoretical, 4000);
  assert.equal(withNoCoupon.companionBaseIncome, theoretical);
  assert.equal(withSmallCoupon.companionBaseIncome, theoretical);
  assert.equal(withBigCoupon.companionBaseIncome, theoretical);

  // 基数本身也不因券改变（券不参与分账基数的定义）
  assert.equal(resolveCompanionRevenueBase(itemsAmount, addonsAmount), itemsAmount + addonsAmount);
});

// ————————————— 六、券由平台承担：平台净收入可以为负，不被夹住 —————————————

test("券由平台承担：券 2000 时平台净收入 === -1200（为负且不被夹到 0）", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 4000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 2000,
  });

  assert.equal(domain.actualPaidAmount, 2000);
  assert.equal(domain.companionBaseIncome, 3200, "打手仍按原价 4000 × 80% = 3200");
  assert.equal(domain.clubNetIncome, -1200);
  assert.ok(domain.clubNetIncome < 0, "平台净收入必须允许为负：券的成本由平台承担");
  // 明确反证「被夹到 0」：夹住会让恒等式失效（凭空少一笔钱）
  assert.notEqual(domain.clubNetIncome, 0);
  assert.equal(domain.companionBaseIncome + domain.clubNetIncome, domain.actualPaidAmount);
});

// ——————————————————— 七、极端：券 = 原价 ———————————————————

test("极端：券 = 原价 → 实付 0，平台净收入 === -打手基础收益，且不抛错", () => {
  let domain;
  assert.doesNotThrow(() => {
    domain = resolveOrderMoneyDomain({
      itemsAmount: 4000,
      addonsAmount: 1000,
      companionRateBp: 8000,
      couponDiscountAmount: 5000,
    });
  });

  assert.equal(domain.originalAmount, 5000);
  assert.equal(domain.actualPaidAmount, 0);
  assert.equal(domain.companionBaseIncome, 4000);
  assert.equal(domain.clubNetIncome, -domain.companionBaseIncome);
  assert.equal(domain.clubNetIncome, -4000);
  assert.equal(domain.companionBaseIncome + domain.clubNetIncome, domain.actualPaidAmount);
});

// ——————————————————— 八、整数分 ———————————————————

test("整数分：所有输出都是整数（无浮点残留）", () => {
  const cases = [
    { itemsAmount: 5000, addonsAmount: 0, companionRateBp: 8000, couponDiscountAmount: 1000 },
    { itemsAmount: 4000, addonsAmount: 0, companionRateBp: 8000, couponDiscountAmount: 2000 },
    { itemsAmount: 3333, addonsAmount: 1111, companionRateBp: 7777, couponDiscountAmount: 999 },
    { itemsAmount: 7, addonsAmount: 3, companionRateBp: 3333, couponDiscountAmount: 5 },
    { itemsAmount: 4000, addonsAmount: 1000, companionRateBp: 8000, couponDiscountAmount: 5000 },
  ];

  for (const input of cases) {
    const domain = resolveOrderMoneyDomain(input);
    for (const [key, value] of Object.entries(domain)) {
      assert.ok(Number.isInteger(value), `${key} 必须是整数分，实际是 ${value}`);
    }
  }
});

// ————————————— 九、退款基数就是实付（有券口径） —————————————
//
// 券把实付压到原价以下，退款只能退**实付**那么多——退得比实付多就是凭空出款。
// 同时，打手收益冲回额**整笔归零、与比例无关**（P0-15 §三）。

test("退款基数就是实付（有券口径）：按比例取整，100% 时精确等于实付", () => {
  const domains = [
    resolveOrderMoneyDomain({
      itemsAmount: 5000,
      addonsAmount: 0,
      companionRateBp: 8000,
      couponDiscountAmount: 1000,
    }),
    resolveOrderMoneyDomain({
      itemsAmount: 4000,
      addonsAmount: 0,
      companionRateBp: 8000,
      couponDiscountAmount: 2000,
    }),
  ];

  for (const domain of domains) {
    for (const refundRateBp of [1000, 5000, 10000]) {
      const amounts = computeRefundDecisionAmounts({
        actualPaidAmount: domain.actualPaidAmount,
        companionBaseIncome: domain.companionBaseIncome,
        input: { refundRateBp },
      });

      if (refundRateBp === 10000) {
        assert.equal(
          amounts.refundAmount,
          domain.actualPaidAmount,
          "100% 必须精确等于实付（floor(实付 × 10000 / 10000) === 实付）",
        );
      } else {
        assert.equal(
          amounts.refundAmount,
          Math.floor((domain.actualPaidAmount * refundRateBp) / 10000),
          `比例 ${refundRateBp} 的退款额口径错误`,
        );
      }

      // 无论退 10% 还是退 100%，退款额都不可能超过实付
      assert.ok(
        amounts.refundAmount <= domain.actualPaidAmount,
        `退款额 ${amounts.refundAmount} 超过实付 ${domain.actualPaidAmount}`,
      );

      // 冲回额整笔归零、与比例无关：10% 与 100% 都等于 companionBaseIncome
      assert.equal(
        amounts.companionReversalAmount,
        domain.companionBaseIncome,
        `比例 ${refundRateBp} 时冲回额必须仍是整笔（写成按比例算会让打手偷偷留下钱）`,
      );
    }
  }
});

test("冲回额与退款比例无关：同一笔实付下，退 10% 与退 100% 的 companionReversalAmount 相等", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });

  const tenPercent = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 1000 },
  });
  const full = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 10000 },
  });

  assert.equal(tenPercent.companionReversalAmount, full.companionReversalAmount);
  assert.equal(tenPercent.companionReversalAmount, 4000);
  // 但退款额本身确实随比例不同——冲回额不随比例，两者不能混为一谈
  assert.equal(tenPercent.refundAmount, 400);
  assert.equal(full.refundAmount, 4000);
});

// ————————————— 十、平台最终净收入（有券口径） —————————————

test("平台最终净收入（有券口径）：等于实付 − 退款额，100% 退款时为 0", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });

  for (const refundRateBp of [1000, 5000, 10000]) {
    const { refundAmount } = computeRefundDecisionAmounts({
      actualPaidAmount: domain.actualPaidAmount,
      companionBaseIncome: domain.companionBaseIncome,
      input: { refundRateBp },
    });

    assert.equal(
      platformNetIncome(domain.actualPaidAmount, refundAmount),
      domain.actualPaidAmount - refundAmount,
      `比例 ${refundRateBp} 的平台净收入口径错误`,
    );
  }

  const full = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 10000 },
  });
  assert.equal(platformNetIncome(domain.actualPaidAmount, full.refundAmount), 0, "退满后平台最终净收入为 0");
});

// ——————————————————— 十一、不得超退 ———————————————————

test("不得超退：有券实付下退满通过，多退 1 分被拒", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });

  const { refundAmount } = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 10000 },
  });

  // 退满实付：通过（返回 null）
  assert.equal(
    assertRefundAmountWithinPaid({
      refundAmount,
      alreadyRefundedAmount: 0,
      actualPaidAmount: domain.actualPaidAmount,
    }),
    null,
  );

  // 再多 1 分：被拒（返回非 null 的文案）
  assert.notEqual(
    assertRefundAmountWithinPaid({
      refundAmount: refundAmount + 1,
      alreadyRefundedAmount: 0,
      actualPaidAmount: domain.actualPaidAmount,
    }),
    null,
  );
});

// ——————————————————— 十二、isFullyRefunded 的有券口径 ———————————————————

test("isFullyRefunded 的有券口径：退满实付为 true，退 10% 为 false", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });
  assert.equal(domain.actualPaidAmount, 4000);

  const full = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 10000 },
  });
  const part = computeRefundDecisionAmounts({
    actualPaidAmount: domain.actualPaidAmount,
    companionBaseIncome: domain.companionBaseIncome,
    input: { refundRateBp: 1000 },
  });

  assert.equal(isFullyRefunded(full.refundAmount, domain.actualPaidAmount), true);
  assert.equal(isFullyRefunded(part.refundAmount, domain.actualPaidAmount), false);
  // 部分退款也**不得**让订单被当成已退满（部分退款不改订单状态）
  assert.notEqual(isFullyRefunded(part.refundAmount, domain.actualPaidAmount), true);
});

// ——————————— 十三、OrderMoneyDomain 的键集合精确固定（DTO exact keys） ———————————
//
// 这条守的是「将来有人给金额域偷偷加/改字段」：
// 多一个字段就可能多一份真值来源，少一个字段调用方会在运行期读到 undefined。

test("OrderMoneyDomain 的键集合精确固定（多一个少一个都要红）", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 5000,
    addonsAmount: 0,
    companionRateBp: 8000,
    couponDiscountAmount: 1000,
  });

  assert.deepEqual(Object.keys(domain).sort(), [
    "actualPaidAmount",
    "clubNetIncome",
    "companionBaseIncome",
    "companionRateSnapshot",
    "couponDiscountAmount",
    "originalAmount",
  ]);
});

// ——————————————————— 十四、无券口径不回归 ———————————————————

test("无券口径不回归：券 0 时实付 === 原价，平台净收入 === 原价 − 打手收益", () => {
  const cases = [
    { itemsAmount: 3980, addonsAmount: 1000, companionRateBp: 8000 },
    { itemsAmount: 5000, addonsAmount: 0, companionRateBp: 3333 },
    { itemsAmount: 999, addonsAmount: 1, companionRateBp: 10000 },
  ];

  for (const input of cases) {
    const domain = resolveOrderMoneyDomain({ ...input, couponDiscountAmount: 0 });
    assert.equal(domain.actualPaidAmount, domain.originalAmount, "无券时实付必须等于原价");
    assert.equal(
      domain.clubNetIncome,
      domain.originalAmount - domain.companionBaseIncome,
      "无券时平台净收入仍是差额",
    );
    // 与底层的差额函数保持同一口径（防有人在这里手写第二套算式）
    assert.equal(domain.clubNetIncome, resolveClubNetIncome(domain.originalAmount, domain.companionBaseIncome));
  }
});
