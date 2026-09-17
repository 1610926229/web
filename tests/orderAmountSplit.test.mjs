import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARE_RATIO_BP_MAX,
  resolveClubNetIncome,
  resolveCompanionBaseIncome,
  resolveCompanionRevenueBase,
} from "../lib/constants/orderAmount.ts";

/**
 * P0-3「金额域拆分」的持续测试。
 *
 * 这一批把订单金额从「一个 totalAmount」拆成一组**互相有恒等关系**的字段：
 *
 *   原价 originalAmount  ──× 分账比例──→  护航收益 companionBaseIncome
 *   实付 actualPaidAmount ────────────────→  平台净收入 clubNetIncome（差额）
 *
 * 恒等式 `护航收益 + 平台净收入 === 实付` 是整份分账规则的基石：任何一处取整、
 * 任何一次四舍五入、任何一个「顺手把负数夹到 0」，都会先在这里失败。
 *
 * 因此这里锁的不只是几个数字，而是三条**取整与符号纪律**：
 *
 * 1. **取整只发生在护航收益这一处**（且方向是 floor）。平台净收入是差额，不取整。
 * 2. **平台净收入允许为负**（券由平台承担、比例又高的时候必然为负），不抛错、不取绝对值。
 * 3. **参与分账的基数是一个可替换的决策点**（R3），当前口径为「不含增值服务」，
 *    用一条**独立的**用例把它锁住——将来产品确认口径变了，改的是一处函数体与这条用例。
 */

// ——————————————————————— 一、比例上限 ———————————————————————

test("分账比例以基点表示，上限是 10000（即 100%）", () => {
  assert.equal(SHARE_RATIO_BP_MAX, 10000);
  assert.ok(Number.isInteger(SHARE_RATIO_BP_MAX));

  // 上限就是「比例」这个单位的定义：8000 基点 = 80%
  assert.equal(resolveCompanionBaseIncome(100, SHARE_RATIO_BP_MAX), 100);
  assert.equal(resolveCompanionBaseIncome(100, SHARE_RATIO_BP_MAX / 2), 50);
});

// ——————————————————————— 二、恒等式 ———————————————————————

test("恒等式：护航收益 + 平台净收入 === 实付", () => {
  const amounts = [1, 50, 100, 9999, 2000];
  const rates = [0, 3333, 8000, 10000];

  for (const amount of amounts) {
    for (const rate of rates) {
      const companionBaseIncome = resolveCompanionBaseIncome(amount, rate);
      const clubNetIncome = resolveClubNetIncome(amount, companionBaseIncome);

      assert.equal(
        companionBaseIncome + clubNetIncome,
        amount,
        `原价/实付 ${amount}、比例 ${rate} 基点时不满足恒等式`,
      );
      assert.ok(Number.isInteger(companionBaseIncome), "护航收益必须是整数分");
      assert.ok(Number.isInteger(clubNetIncome), "平台净收入必须是整数分");
    }
  }
});

// ——————————————————————— 三、取整 ———————————————————————

test("取整只发生在护航收益这一处，且方向是向下取整（不是四舍五入）", () => {
  // 50 × 80% = 40，正好整除
  assert.equal(resolveCompanionBaseIncome(50, 8000), 40);
  // 1 × 33.33% = 0.3333 → 0（四舍五入会得到 0，这一条区分不了）
  assert.equal(resolveCompanionBaseIncome(1, 3333), 0);
  // 3 × 33.33% = 0.9999 → 0：**四舍五入会得到 1**，这一条专门用来钉住 floor
  assert.equal(resolveCompanionBaseIncome(3, 3333), 0);
  // 9999 × 33.33% = 3332.6667 → 3332
  assert.equal(resolveCompanionBaseIncome(9999, 3333), 3332);
  // 1 × 99.99% = 0.9999 → 0：向上取整或四舍五入都会得到 1
  assert.equal(resolveCompanionBaseIncome(1, 9999), 0);
});

test("平台净收入是差额，不取整：被扣掉的那部分就是平台上一次取整的余数", () => {
  // 原价 9999、80% → 护航 7999（7999.2 向下取整），平台拿的是剩下的 2000
  const companion = resolveCompanionBaseIncome(9999, 8000);
  assert.equal(companion, 7999);
  assert.equal(resolveClubNetIncome(9999, companion), 2000);
});

// ——————————————————————— 四、两个端点 ———————————————————————

test("比例为 0：护航收益为 0，平台净收入等于实付", () => {
  for (const amount of [0, 1, 50, 9999]) {
    const companion = resolveCompanionBaseIncome(amount, 0);
    assert.equal(companion, 0, `比例为 0 时护航收益必须是 0（原价 ${amount}）`);
    assert.equal(resolveClubNetIncome(amount, companion), amount);
  }
});

test("比例为 100%：护航收益等于原价；实付低于原价时平台净收入为负，且不抛错、不取绝对值、不夹到 0", () => {
  assert.equal(resolveCompanionBaseIncome(100, 10000), 100);

  // 券由平台承担：实付 2000、原价 4000、比例 80% → 护航仍按原价拿 3200，
  // 平台净收入 = 2000 - 3200 = -1200（这是**正确结果**，不是异常）
  const companion = resolveCompanionBaseIncome(4000, 8000);
  const club = resolveClubNetIncome(2000, companion);
  assert.equal(companion, 3200);
  assert.equal(club, -1200);
  assert.ok(club < 0, "平台净收入必须允许为负：券的成本由平台承担");

  // 差额恒等式在负数分支同样成立
  assert.equal(companion + club, 2000);

  // 极端：实付 0 而护航要按原价分成
  assert.equal(resolveClubNetIncome(0, resolveCompanionBaseIncome(4000, 10000)), -4000);
});

// ——————————————————————— 五、R3 决策点（独立用例） ———————————————————————

test("R3 决策点：当前「参与分账的基数」为商品金额，不含增值服务", () => {
  // ⚠️ 这一条是**唯一**允许在产品确认 R3 之后被改写的用例：
  // 需求文档只写了「商品原价」，增值服务是否参与分账尚未确认。
  // 当前口径：基数 = 商品金额（增值服务不计入分账基数）。
  assert.equal(resolveCompanionRevenueBase(4000, 1000), 4000);
  assert.equal(resolveCompanionRevenueBase(4000, 0), 4000);
  assert.equal(resolveCompanionRevenueBase(0, 1000), 0);
});
