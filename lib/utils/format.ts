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

/**
 * 北京时间偏移（分钟）。订单时间统一按北京时间展示，见下方说明。
 *
 * 导出是为了让**按天/按月划分的规则**（例如评价的「近一月 / 今年」）与展示口径一致：
 * 那些规则必须和用户看到的日期算在同一个时区里，否则会出现「显示 2026-01-01，
 * 却被「今年」筛掉」这种自相矛盾的结果。
 */
export const BEIJING_OFFSET_MINUTES = 8 * 60;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 时间展示：ISO 字符串 → `2026-09-12 21:18`（**北京时间，固定 UTC+8**）。
 *
 * 刻意不用 `toLocaleString` / `Intl`：
 * 1. 订单列表与详情同时被服务端与浏览器渲染，`toLocaleString` 的结果取决于运行环境的
 *    时区与语言设置，两侧不一致会直接触发 React 水合不一致告警；
 * 2. 本项目的用户与订单都在国内，展示口径固定为北京时间，比「跟随访问者时区」更符合预期。
 *
 * 因此这里只做一次固定偏移的 UTC 格式化，任何环境下结果都相同。
 */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";

  const shifted = new Date(time + BEIJING_OFFSET_MINUTES * 60_000);
  return (
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    ` ${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
  );
}
