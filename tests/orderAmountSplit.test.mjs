import assert from "node:assert/strict";
import test from "node:test";
import {
  SHARE_RATIO_BP_MAX,
  resolveClubNetIncome,
  resolveCompanionBaseIncome,
  resolveCompanionRevenueBase,
  resolveOrderMoneyDomain,
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
 * 因此这里锁的不只是几个数字，而是四条**取整、符号与口径纪律**：
 *
 * 1. **取整只发生在护航收益这一处**（且方向是 floor）。平台净收入是差额，不取整。
 * 2. **平台净收入允许为负**（券由平台承担、比例又高的时候必然为负），不抛错、不取绝对值。
 * 3. **参与分账的基数是一个独立的决策点**（R3）：它由
 *    `resolveCompanionRevenueBase()` 单独给出，**不是**原价的构成。
 * 4. **「原价」与「分账基数」不得合并成一个表达式**——两者当前数值相同，
 *    但那是规则的结果；合并之后这个等式就变成了代码事实。
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

test("R3 决策点：V1 的全部增值服务参与分账，基数是商品金额 + 增值服务金额", () => {
  // ⚠️ 这一条是**唯一**允许在产品再次调整口径时被改写的用例。
  //
  // R3 已于 2026-09-18 确认：V1 的全部增值服务**参与**打手分账。
  // 业务原则——只要这项服务由当前打手实际履约提供，它就属于该订单的服务收入，
  // 与商品主体一起按订单冻结的比例分账。
  // 未来若出现平台自己履约的收费项，再单独扩展（那时它进原价、不进基数）。
  assert.equal(resolveCompanionRevenueBase(4000, 1000), 5000);
  assert.equal(resolveCompanionRevenueBase(4000, 0), 4000);
  assert.equal(resolveCompanionRevenueBase(0, 1000), 1000);
  assert.equal(resolveCompanionRevenueBase(0, 0), 0);
});

// ————————————————— 六、全套金额域的合成（锁定 R3 的业务后果） —————————————————

/**
 * 这一组用**用户给出的那个例子**把 R3 的业务后果钉死：
 *
 *   商品金额 3980 分（¥39.80）+ 增值服务 1000 分（¥10.00），比例 8000 bp（80%）
 *   → 原价 4980、实付 4980、护航收益 3984、平台净收入 996
 *
 * 它防的是一个具体的、曾经真实存在过的错误结论：
 * **「增值服务那 10 元 100% 归俱乐部」**——那样会得到护航收益 3184、平台净收入 1796。
 * 只要有人把 `resolveCompanionRevenueBase()` 改回「只算商品金额」，
 * 或者绕过决策点在调用处直接写 `itemsAmount`，下面第一条就会红。
 */
test("R3 的业务后果：商品 3980 + 增值服务 1000、比例 80% → 护航 3984 / 平台 996", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 3980,
    addonsAmount: 1000,
    companionRateBp: 8000,
    couponDiscountAmount: 0,
  });

  assert.equal(domain.originalAmount, 4980, "原价 = 商品 + 增值服务（优惠前应付总额）");
  assert.equal(domain.actualPaidAmount, 4980, "无券时实付等于原价");
  assert.equal(domain.companionBaseIncome, 3984, "护航收益按 4980 分成，不是按 3980");
  assert.equal(domain.clubNetIncome, 996, "俱乐部净收益 = 4980 − 3984");
  assert.equal(domain.companionRateSnapshot, 8000);

  // 曾经实现过的那条错误结论：增值服务不进分账基数
  assert.notEqual(
    domain.companionBaseIncome,
    Math.floor((3980 * 8000) / 10000),
    "增值服务必须参与分账，不能被整段留在俱乐部",
  );

  // 恒等式在真实数字上同样成立
  assert.equal(domain.companionBaseIncome + domain.clubNetIncome, domain.actualPaidAmount);
  assert.equal(domain.actualPaidAmount, domain.originalAmount - domain.couponDiscountAmount);
});

test("原价与分账基数当前数值相同，但它们是两条路径算出来的", () => {
  // 原价 = 商品 + 增值服务（定义里没有分账这回事）
  // 基数 = resolveCompanionRevenueBase(商品, 增值服务)（规则说「全部参与」）
  // 当前碰巧相等。这条用例的价值在于：它把「相等」写成了一个**可被打破的观察**，
  // 而不是一个恒等式——将来出现平台自己履约的收费项时，改这里的期望值即可。
  for (const [items, addons] of [
    [3980, 1000],
    [2990, 0],
    [0, 500],
    [100, 250],
  ]) {
    const domain = resolveOrderMoneyDomain({
      itemsAmount: items,
      addonsAmount: addons,
      companionRateBp: 8000,
      couponDiscountAmount: 0,
    });
    assert.equal(domain.originalAmount, items + addons);
    assert.equal(resolveCompanionRevenueBase(items, addons), domain.originalAmount);
  }
});
