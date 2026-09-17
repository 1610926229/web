/**
 * 订单金额域的计算规则（P0-3）——**全站唯一的订单金额公式落点**。
 *
 * 在此之前，订单只有一个 `totalAmount`：「用户付了多少」与「打手拿多少」「平台剩多少」
 * 全都没有落点，任何一次分账都只能现算，而现算的地方迟早会有两处。
 * 本文件把这三者的关系固定下来，其余模块**只允许调用这里的函数**，
 * 不得自己写 `× 比例` 或自己取整。
 *
 * 四条纪律（`tests/orderAmountSplit.test.mjs` 逐条锁住）：
 *
 * 1. **「原价」与「分账基数」是两个概念**。原价是「这一单该收多少钱」，
 *    基数是「其中哪些钱按比例分给打手」。当前两者数值相同（R3 已确认：
 *    全部增值服务参与分账），但这个等式是 `resolveCompanionRevenueBase()`
 *    给出来的**结论**，不是原价的定义——将来出现平台自己履约的收费项时，
 *    它会进原价而不进基数。**禁止把两者合并成一个表达式。**
 * 2. **取整只发生在护航收益这一处**，方向是**向下取整**（`Math.floor`）。
 *    平台净收入是差额而不是「实付 × 剩余比例」——后者会在两处各取一次整，
 *    两个数加起来不等于实付，账面上凭空少一分钱。
 * 3. **平台净收入允许为负**。券的成本由平台承担（见需求 §2.6），
 *    所以「实付 < 护航收益」是**正确结果**，不是异常：不抛错、不取绝对值、不夹到 0。
 * 4. 金额全程是**整数分**，函数只做整数运算，不出现浮点中间值。
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
 * 护航收益 = **分账基数** × 分账比例（基点），**向下取整**。
 *
 * 取整方向是向下而不是四舍五入：平台不能因为「多出半厘」而按整分付给打手，
 * 少付的那一分留在平台净收入里，账面对得上（见本文件顶部的恒等式）。
 *
 * ⚠️ 第一个参数是**分账基数**（`companionRevenueBaseAmount`），不是订单原价——
 * 两者当前数值相同，但那是一个规则的结果，不是一个定义（见
 * `resolveCompanionRevenueBase()`）。参数名刻意写成基数，免得调用方
 * 顺手把「原价」传进来，将来出现不参与分账的收费项时无从察觉。
 *
 * ⚠️ 传进来的基数必须是**已经被冻结在订单上的那份钱**算出来的，
 * 而不是读取时用今天的商品价格现算——商品改价不能影响历史订单。
 */
export function resolveCompanionBaseIncome(
  companionRevenueBaseAmount: number,
  rateBp: number,
): number {
  return Math.floor((companionRevenueBaseAmount * rateBp) / SHARE_RATIO_BP_MAX);
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
 * **参与分账的基数**——与「订单原价」是两个概念。
 *
 * 原价回答「用户这一单优惠前该付多少钱」；本函数回答「其中哪些钱要按比例分给打手」。
 * 当前两者数值相同，但**方向是反的**：原价的定义里没有分账这回事，
 * 是这条规则决定了「全部原价都参与分账」。将来出现平台自己履约的收费项时，
 * 它会进原价而不进这里，等式自然分开。
 *
 * **R3 已确认（2026-09-18）**：V1 的全部增值服务**参与打手分账**。
 * 业务原则是「只要这项服务由当前打手实际履约提供，它就属于该订单的服务收入，
 * 与商品主体一起按订单冻结的比例分账」，因此基数 = 商品金额 + 全部增值服务金额。
 *
 * 这条规则**只写在这一处**：产品若再次调整，改的是这个函数体与
 * `tests/orderAmountSplit.test.mjs` 里那一条用例，而不是满仓库找
 * `itemsAmount + addonsAmount`。若有人绕过它直接改调用处，
 * 金额恒等式断言（护航收益 + 平台净收入 = 实付）会红。
 *
 * ⚠️ 它只在**下单那一刻**被调用一次，结果并入订单的 `originalAmount` 一并冻结。
 * 读取订单时不得用它现算——那等于用今天的规则重算历史账。
 */
export function resolveCompanionRevenueBase(itemsAmount: number, addonsAmount: number): number {
  return itemsAmount + addonsAmount;
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
  /** 增值服务合计（按单计费）。**参与分账**（R3 已确认） */
  addonsAmount: number;
  /** 商品此刻的分账比例（基点） */
  companionRateBp: number;
  /** 优惠券抵扣（P0 恒为 0） */
  couponDiscountAmount: number;
};

/**
 * 订单上的金额域字段（不含 `refundedAmount`：那是退款累计，不属于下单时的快照）。
 *
 * ⚠️ 刻意**没有** `companionRevenueBaseAmount`：当前规则下它恒等于 `originalAmount`，
 * 多存一个永远相同的数只会得到两个真值来源，改的时候先改哪一个都可能对不上。
 * 它是 `resolveOrderMoneyDomain()` 内部的一个局部量，概念留在那里。
 * 等到出现「进原价但不进基数」的收费项时，再把它提升为订单字段。
 */
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
 * 顺序不是随意的，四步各有各的输入：
 *
 * 1. **原价**：商品 + 增值服务。它的定义里没有分账这回事；
 * 2. **实付**：原价扣掉券。当前没有券，所以它与原价相等；
 * 3. **分账基数**：由 `resolveCompanionRevenueBase()` 决定，**独立于第 1 步**。
 *    当前规则下它与原价相等，但这是规则的结果，不是原价的定义；
 * 4. **护航收益**：基数 × 比例（唯一下取整处），然后**用实付减掉它**得到平台净收入
 *    （因此恒等式成立）。
 *
 * ⚠️ 第 1 步与第 3 步**不能合并成一个表达式**：合并之后「原价 = 分账基数」就从一个
 * 规则结论变成了代码事实，将来出现平台自己履约的收费项时，改一处会同时改掉原价。
 */
export function resolveOrderMoneyDomain(input: OrderMoneyDomainInput): OrderMoneyDomain {
  // 1. 原价：用户这一单优惠前的应付总额
  const originalAmount = input.itemsAmount + input.addonsAmount;
  const couponDiscountAmount = input.couponDiscountAmount;
  // 2. 实付：原价 − 券
  const actualPaidAmount = originalAmount - couponDiscountAmount;

  // 3. 分账基数：另一个概念，只由这一个决策点给出
  const companionRevenueBaseAmount = resolveCompanionRevenueBase(
    input.itemsAmount,
    input.addonsAmount,
  );
  // 4. 护航收益：基数 × 比例
  const companionBaseIncome = resolveCompanionBaseIncome(
    companionRevenueBaseAmount,
    input.companionRateBp,
  );

  return {
    originalAmount,
    couponDiscountAmount,
    actualPaidAmount,
    companionRateSnapshot: input.companionRateBp,
    companionBaseIncome,
    clubNetIncome: resolveClubNetIncome(actualPaidAmount, companionBaseIncome),
  };
}
