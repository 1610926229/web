import { SHARE_RATIO_BP_MAX } from "./orderAmount";

/**
 * 商品分账比例：**存储用基点，界面用百分比**，两个单位之间的换算只在这里。
 *
 * - 存储（`CatalogProductRecord.companionRateBp`）是**整数基点**：`8000` = 80%。
 *   用整数而不是 `0.8` 是金额域的一贯做法——浮点数进不了任何与钱有关的字段。
 * - 界面（商品管理表单）是**百分比文本**：`"80"`、`"80.5"`。
 *   管理员填的是「这个商品打手拿几成」，不是基点；让他在表单里填 `8000`
 *   只会让每个人都要先做一次心算。
 *
 * 换算与价格那条规则同源（见 `lib/constants/adminProducts.ts` 顶部的说明）：
 * **全程字符串拼接，不出现浮点中间值**。`Number("80.5") * 100` 在 IEEE754 下
 * 是 `8049.999999999999`，而 `Math.round` 只是碰巧救回来——`1.005 * 100` 就不是了。
 * 因此这里用的是「整数部分 + 补齐两位的小数部分拼成字符串」，与 `parsePriceYuanToFen`
 * 完全一致的做法。
 *
 * ⚠️ 非法输入一律返回 `null`（由调用方转成字段级错误），**绝不静默取默认比例**：
 * 一个「填错了却按 80% 算下去」的商品，发现它的时候已经结算过很多单了。
 *
 * ⚠️ 本文件只做「比例」这一个字段的校验与换算，不含金额公式（那在 `orderAmount.ts`），
 * 也不读仓储、不抛业务错误——客户端组件与表单共用它，因此不得引入服务端依赖。
 */

/** 比例下界：0 表示这个商品不参与分账，全额归平台。 */
export const SHARE_RATIO_BP_MIN = 0;

/**
 * **预置数据**使用的比例：80%。预置商品与预置订单都用它，
 * 从而「随便点开一单」看到的都是一组自洽的数字，而不是一堆 0。
 *
 * ⚠️ 它**不是「新商品的默认分账比例」**：需求文档没有给出这个默认值，
 * 因此商品管理表单新建商品时该项**留空**，由管理员显式填写
 * （填错一个比例，等发现的时候已经按它结算过很多单了）。
 * 这里带 `DEFAULT_` 前缀，指的是「Mock 数据的默认值」，不是业务默认值。
 */
export const DEFAULT_COMPANION_RATE_BP = 8000;

/** 分账比例的字段名，表单与服务端共用（避免两处写死同一个中文）。 */
export const SHARE_RATIO_LABEL = "分账比例";

/** 提示文案：说明**填什么才对**，而不是只说「格式错误」。 */
export const SHARE_RATIO_INVALID_MESSAGE =
  `分账比例请填 0 到 100 之间的百分比，最多两位小数（例如 80 或 80.5）`;

/** 比例是否是存储层的合法值：0 ~ 10000 的整数基点。 */
export function isValidShareRatioBp(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SHARE_RATIO_BP_MIN &&
    value <= SHARE_RATIO_BP_MAX
  );
}

/**
 * 百分比文本 → 整数基点。非法输入返回 `null`。
 *
 * `"80"` → 8000、`"80.5"` → 8050、`"33.33"` → 3333、`"100"` → 10000、`"0"` → 0。
 * 超过两位小数（`"80.001"`）直接拒绝，而不是四舍五入：截断会让
 * 「界面上填的数」与「账上存的比例」不是同一个数。
 */
export function parseShareRatioPercentToBp(raw: string): number | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;

  const [percentText, decimalsText = ""] = value.split(".");
  // 基点 = 整数部分与补齐到两位的小数部分**拼成字符串**再转一次整数：
  // `"80"` → `"8000"` → 8000，`"80.5"` → `"8050"` → 8050。
  // 前导零保持原样（`"080"` 仍是 8000）：这里只搬格式，不动既有口径。
  const bp = Number(`${percentText}${decimalsText.padEnd(2, "0")}`);

  return isValidShareRatioBp(bp) ? bp : null;
}

/** 基点 → 百分比文本，用于表单初始值（`8000` → `"80"`、`8050` → `"80.5"`）。 */
export function formatShareRatioBpForInput(bp: number): string {
  const percent = Math.floor(bp / 100);
  const decimals = String(bp % 100)
    .padStart(2, "0")
    // 尾随零没有信息量：`"80.50"` 显示成 `"80.5"`，管理员改的时候少删两个字符
    .replace(/0+$/, "");

  return decimals ? `${percent}.${decimals}` : String(percent);
}
