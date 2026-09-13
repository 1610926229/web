/**
 * 数值展示格式化。页面组件必须复用此文件，不得各自实现。
 */

/** 小数位为 0 时省略 `.0`（1 → "1"，8.2 → "8.2"）。 */
function trimTrailingZero(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * 数值缩写。规则：**使用截断，不使用四舍五入**。
 *
 * - `< 1000`            → 原样整数，无后缀        823   → `823`
 * - `[1000, 10000)`     → 截断到 1 位小数 + `k+`  1000  → `1k+`    8231 → `8.2k+`
 * - `>= 10000`          → 截断到 1 位小数 + `w+`  11020 → `1.1w+`
 *
 * 边界参考：8199 → `8.1k+`；9999 → `9.9k+`；10000 → `1w+`。
 */
export function abbreviateNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";

  const v = Math.trunc(value);
  if (v < 0) return String(v);
  if (v < 1000) return String(v);

  if (v < 10000) {
    return `${trimTrailingZero(Math.floor(v / 100) / 10)}k+`;
  }

  return `${trimTrailingZero(Math.floor(v / 1000) / 10)}w+`;
}

/**
 * 金额展示：分 → 元，**统一保留两位小数**。
 * 2990 → `29.90`，2900 → `29.00`，1990 → `19.90`，5 → `0.05`。
 */
export function formatYuan(cents: number): string {
  if (!Number.isFinite(cents)) return "0.00";
  return (Math.trunc(cents) / 100).toFixed(2);
}
