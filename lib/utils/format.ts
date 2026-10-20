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

/** `<input type="datetime-local">` 的取值形状（**精确到秒**，因此输入框必须带 `step="1"`）。 */
const DATE_TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/**
 * ISO 字符串 → `datetime-local` 输入框的取值（P1-6，`formatDateTime` 的**逆运算**）。
 *
 * `"2026-12-31T15:59:59.000Z"` → `"2026-12-31T23:59:59"`。
 *
 * ⚠️ **与 `formatDateTime` 用同一个 `BEIJING_OFFSET_MINUTES`，且同样不用 `Intl`**：
 * 后台的编辑表单既被服务端渲染、也被浏览器渲染，两边必须算出**逐字相同**的字符串，
 * 否则 React 会报水合不一致；而让输入框跟随访问者时区，还会出现
 * 「北京时间的运营看到的时间与列表页显示的不是同一个」这种没法解释的现象。
 *
 * ⚠️ **精确到秒，不截断到分**：种子券的 `validTo` 是 `15:59:59.000Z`
 * （即北京时间 `23:59:59`）。截断到分会让「打开编辑表单、一个字没改、直接保存」
 * 变成一次真实的改动，而且改动的是**用户手里那张券的截止秒数**。
 *
 * 解析不出来返回空串（输入框显示为空，由调用方的校验给出文案）。
 */
export function toDateTimeLocalValue(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";

  const shifted = new Date(time + BEIJING_OFFSET_MINUTES * 60_000);
  return (
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`
  );
}

/**
 * `datetime-local` 输入框的取值 → ISO 字符串（P1-6，与 `toDateTimeLocalValue` 互为逆运算）。
 *
 * 输入框里的墙钟时间按**北京时间**解释：`"2026-12-31T23:59:59"` → `"2026-12-31T15:59:59.000Z"`。
 *
 * ⚠️ **不用 `new Date(local)`**：那一句按**运行环境的本地时区**解释裸日期时间，
 * 服务端与浏览器时区不同就会存进两个不同的时刻——而这是一句写到界面上的时间。
 * 这里显式按固定偏移换算，任何环境下结果都相同。
 *
 * 形状不对、或日期在日历上不存在（`2026-02-30`，`Date` 会把它悄悄归一到 3 月 2 日）
 * 一律返回空串：**宁可让调用方报「请选择有效期」，也不替操作者改一个日期**。
 */
export function fromDateTimeLocalValue(local: string): string {
  const match = DATE_TIME_LOCAL_PATTERN.exec(local.trim());
  if (!match) return "";

  const [, year, month, day, hour, minute, second] = match;
  const shifted = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(shifted)) return "";

  const iso = new Date(shifted - BEIJING_OFFSET_MINUTES * 60_000).toISOString();
  // 回读校验：日历上不存在的日期会被 `Date.UTC` 归一化，只有往返一致才收下
  return toDateTimeLocalValue(iso) === `${year}-${month}-${day}T${hour}:${minute}:${second}`
    ? iso
    : "";
}
