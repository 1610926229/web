/**
 * 订单金额域的计算规则（P0-3）——**全站唯一的订单金额公式落点**。
 *
 * 在此之前，订单只有一个 `totalAmount`：「用户付了多少」与「打手拿多少」「平台剩多少」
 * 全都没有落点，任何一次分账都只能现算，而现算的地方迟早会有两处。
 * 本文件把这三者的关系固定下来，其余模块**只允许调用这里的函数**，
 * 不得自己写 `× 比例` 或自己取整。
 *
 * 三条纪律（`tests/orderAmountSplit.test.mjs` 逐条锁住）：
 *
 * 1. **取整只发生在护航收益这一处**，方向是**向下取整**（`Math.floor`）。
 *    平台净收入是差额而不是「实付 × 剩余比例」——后者会在两处各取一次整，
 *    两个数加起来不等于实付，账面上凭空少一分钱。
 * 2. **平台净收入允许为负**。券的成本由平台承担（见需求 §2.6），
 *    所以「实付 < 护航收益」是**正确结果**，不是异常：不抛错、不取绝对值、不夹到 0。
 * 3. 金额全程是**整数分**，函数只做整数运算，不出现浮点中间值。
 *
 * ⚠️ 本文件只提供**纯函数**：不读仓储、不取时间、不抛业务错误。
 * 比例是否合法由 `lib/constants/shareRatio.ts` 判定，金额是否与订单一致由
 * 下单流程（`lib/services/checkout.ts`）保证。
 */

/**
 * 分账比例的**上限**，单位基点（1 基点 = 0.01%）。
 *
 * 放在本文件而不是比例校验文件里，是因为它同时是**公式的分母**：
 * 公式与「比例的定义域」必须是同一个数，分成两处定义迟早出现
 * 「校验放过了 10001，公式按 10000 换算」这种两处说了算的情况。
 * `lib/constants/shareRatio.ts` 从这里取它做输入校验（单向依赖）。
 */
export const SHARE_RATIO_BP_MAX = 10000;

/**
 * 护航收益 = 原价 × 分账比例（基点），**向下取整**。
 *
 * 取整方向是向下而不是四舍五入：平台不能因为「多出半厘」而按整分付给打手，
 * 少付的那一分留在平台净收入里，账面对得上（见本文件顶部的恒等式）。
 *
 * ⚠️ 调用方传进来的 `originalAmount` 必须是**已经被冻结在订单上的那个数**
 * （`Order.originalAmount`），而不是读取时用今天的商品价格现算——
 * 商品改价不能影响历史订单。
 */
export function resolveCompanionBaseIncome(originalAmount: number, rateBp: number): number {
  return Math.floor((originalAmount * rateBp) / SHARE_RATIO_BP_MAX);
}

/**
 * 平台净收入 = 实付 − 护航收益，**差额，不取整**。
 *
 * 它可以是负数：券由平台承担时，实付会低于「原价 × 比例」，
 * 但那部分钱仍然要按比例付给打手（见需求 §2.6 与 R3 的说明）。
 * 这里刻意不写 `Math.max(0, ...)`：把负数夹成 0 会让恒等式失效，
 * 而恒等式失效意味着**有一笔钱去向不明**，那才是真正查不出来的账。
 */
export function resolveClubNetIncome(
  actualPaidAmount: number,
  companionBaseIncome: number,
): number {
  return actualPaidAmount - companionBaseIncome;
}

/**
 * **参与分账的基数**——订单「原价」的构成。
 *
 * ⚠️ **R3 未确认**：需求文档只写了「商品原价」，而增值服务（加急、指定等）
 * 是否参与分账尚未得到产品确认。当前实现取**商品金额**（`itemsAmount`），
 * 即增值服务不进分账基数。
 *
 * 这个函数的存在意义就是让上面那句话**只写一次**：产品确认之后，
 * 改的是这一个函数体与 `tests/orderAmountSplit.test.mjs` 里唯一那条 R3 用例，
 * 而不是满仓库找 `itemsAmount + addonsAmount`。
 *
 * ⚠️ 它只在**下单那一刻**被调用一次，结果存进订单的 `originalAmount`。
 * 读取订单时不得用它现算——那等于用今天的规则重算历史账。
 */
export function resolveCompanionRevenueBase(itemsAmount: number, addonsAmount: number): number {
  // 当前口径：只有商品金额参与分账。addonsAmount 保留在签名里，
  // 是为了让「当时考虑过增值服务、并决定不计入」这件事留在代码里，
  // 而不是看起来压根没想过这个问题。
  void addonsAmount;
  return itemsAmount;
}

/**
 * 下单那一刻定下来的金额域输入。
 *
 * `companionRateBp` 是**商品此刻的比例**；写进订单后叫 `companionRateSnapshot`——
 * 名字不同是刻意的：输入是「现在的配置」，输出是「这一单冻住的那份」。
 */
export type OrderMoneyDomainInput = {
  /** 商品金额（单价 × 数量） */
  itemsAmount: number;
  /** 增值服务合计（按单计费） */
  addonsAmount: number;
  /** 商品此刻的分账比例（基点） */
  companionRateBp: number;
  /** 优惠券抵扣（P0 恒为 0） */
  couponDiscountAmount: number;
};

/** 订单上的金额域字段（不含 `refundedAmount`：那是退款累计，不属于下单时的快照）。 */
export type OrderMoneyDomain = {
  originalAmount: number;
  couponDiscountAmount: number;
  actualPaidAmount: number;
  companionRateSnapshot: number;
  companionBaseIncome: number;
  clubNetIncome: number;
};

/**
 * 由「这一单卖了什么、按什么比例分」算出订单上的整套金额域。
 *
 * ⚠️ **这是全套金额域唯一的合成点**：正式下单（`lib/services/checkout.ts`）与
 * 预置订单种子（`lib/mocks/fixtures/orderSeed.ts`）都调用它。种子不手写这几个数，
 * 是因为手写的常量与公式一旦不一致，验收时看到的「护航收益」就只是种子里的一个巧合，
 * 而不是规则算出来的结果——那种不一致只能靠人偶然比对发现。
 *
 * 顺序不是随意的：先由「参与分账的基数」得到原价，再扣券得到实付，
 * 然后按比例算出护航收益，最后**用实付减掉它**得到平台净收入（因此恒等式成立）。
 */
export function resolveOrderMoneyDomain(input: OrderMoneyDomainInput): OrderMoneyDomain {
  const originalAmount = resolveCompanionRevenueBase(input.itemsAmount, input.addonsAmount);
  const couponDiscountAmount = input.couponDiscountAmount;
  const actualPaidAmount = originalAmount - couponDiscountAmount;
  const companionBaseIncome = resolveCompanionBaseIncome(originalAmount, input.companionRateBp);

  return {
    originalAmount,
    couponDiscountAmount,
    actualPaidAmount,
    companionRateSnapshot: input.companionRateBp,
    companionBaseIncome,
    clubNetIncome: resolveClubNetIncome(actualPaidAmount, companionBaseIncome),
  };
}
