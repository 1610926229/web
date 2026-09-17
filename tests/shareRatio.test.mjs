import assert from "node:assert/strict";
import test from "node:test";
import { SHARE_RATIO_BP_MAX } from "../lib/constants/orderAmount.ts";
import {
  DEFAULT_COMPANION_RATE_BP,
  SHARE_RATIO_BP_MIN,
  SHARE_RATIO_INVALID_MESSAGE,
  formatShareRatioBpForInput,
  isValidShareRatioBp,
  parseShareRatioPercentToBp,
} from "../lib/constants/shareRatio.ts";

/**
 * P0-3「商品分账比例」的持续测试。
 *
 * 分账比例在**存储**上是一个整数基点（`8000` = 80%），在**界面**上是一个百分比
 * 字符串（`"80"`）。两个单位之间必须只有一套换算，且换算**全程不产生浮点中间值**——
 * 与价格那条规则同一个理由：`80.5` 这样的输入一旦走 `Number("80.5") * 100`，
 * 就会在某个角落变成 `8049.999999999999`。
 *
 * 这里因此锁四件事：
 *
 * 1. **区间与整数性**：0 ~ 10000 的整数基点，越界与小数一律非法；
 * 2. **解析方向**（百分比字符串 → 基点）与**格式化方向**（基点 → 百分比字符串）
 *    互为逆运算，且用字符串拼接实现，不经过浮点乘法；
 * 3. **非法输入返回 null，绝不静默取默认值**——一个「悄悄按 80% 算」的比例比报错更难查；
 * 4. 默认比例落在区间内（预置商品与历史订单用它）。
 */

// ——————————————————————— 一、边界与合法性 ———————————————————————

test("比例区间是 0 ~ 10000 基点，默认比例在区间内", () => {
  assert.equal(SHARE_RATIO_BP_MIN, 0);
  assert.equal(SHARE_RATIO_BP_MAX, 10000);
  assert.ok(Number.isInteger(DEFAULT_COMPANION_RATE_BP));
  assert.ok(DEFAULT_COMPANION_RATE_BP >= SHARE_RATIO_BP_MIN);
  assert.ok(DEFAULT_COMPANION_RATE_BP <= SHARE_RATIO_BP_MAX);
  assert.equal(isValidShareRatioBp(DEFAULT_COMPANION_RATE_BP), true);
});

test("合法性判定：只接受区间内的整数基点", () => {
  for (const value of [0, 1, 3333, 8000, 9999, 10000]) {
    assert.equal(isValidShareRatioBp(value), true, `${value} 应当是合法比例`);
  }

  // 小数、越界、非数字一律非法：比例不是「随便一个数」，它有一个定义域
  for (const value of [-1, 10001, 80.5, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isValidShareRatioBp(value), false, `${value} 不该是合法比例`);
  }

  // 字符串不隐式转换：界面上传上来的永远是字符串，转换发生在 parse 那一处
  for (const value of ["8000", "", null, undefined, {}]) {
    assert.equal(isValidShareRatioBp(value), false, `${String(value)} 不该是合法比例`);
  }
});

// ——————————————————————— 二、解析：百分比字符串 → 基点 ———————————————————————

test("百分比字符串按「整数部分 + 小数部分拼成字符串」换算成基点，不经过浮点乘法", () => {
  assert.equal(parseShareRatioPercentToBp("80"), 8000);
  assert.equal(parseShareRatioPercentToBp("80.5"), 8050);
  assert.equal(parseShareRatioPercentToBp("80.50"), 8050);
  assert.equal(parseShareRatioPercentToBp("33.33"), 3333);
  assert.equal(parseShareRatioPercentToBp("0"), 0);
  assert.equal(parseShareRatioPercentToBp("100"), 10000);
  assert.equal(parseShareRatioPercentToBp("0.01"), 1);
  // 首尾空格照常去掉；前导零保持原样（与价格解析同一个口径）
  assert.equal(parseShareRatioPercentToBp("  80  "), 8000);
  assert.equal(parseShareRatioPercentToBp("080"), 8000);
});

test("非法输入一律返回 null，不静默取默认比例", () => {
  for (const raw of [
    "",
    "   ",
    "abc",
    "-1",
    "-0.5",
    "100.01", // 超过 100%
    "10000", // 把基点当成百分比填进来了：不是合法百分比
    "80.001", // 超过两位小数：截断会让「填了多少」与「存了多少」不一致
    "80.", // 小数点后没有数字
    ".5",
    "80%", // 单位由字段本身表示，输入里不该出现
    "8 0",
    "1e2",
    "0x50",
  ]) {
    assert.equal(parseShareRatioPercentToBp(raw), null, `${JSON.stringify(raw)} 不该被解析`);
  }

  // 非字符串（表单之外的调用方）同样返回 null，而不是抛错
  for (const raw of [null, undefined, 80, 8000, {}]) {
    assert.equal(parseShareRatioPercentToBp(raw), null, `${String(raw)} 不该被解析`);
  }
});

// ——————————————————————— 三、格式化：基点 → 百分比字符串 ———————————————————————

test("基点格式化成表单初始值：去掉无意义的尾随零", () => {
  assert.equal(formatShareRatioBpForInput(8000), "80");
  assert.equal(formatShareRatioBpForInput(8050), "80.5");
  assert.equal(formatShareRatioBpForInput(8005), "80.05");
  assert.equal(formatShareRatioBpForInput(3333), "33.33");
  assert.equal(formatShareRatioBpForInput(0), "0");
  assert.equal(formatShareRatioBpForInput(10000), "100");
  assert.equal(formatShareRatioBpForInput(1), "0.01");
});

test("格式化与解析互为逆运算：存进去多少，改一次不改金额就还是多少", () => {
  for (const bp of [0, 1, 5, 50, 3333, 8000, 8005, 8050, 9999, 10000]) {
    const text = formatShareRatioBpForInput(bp);
    assert.equal(parseShareRatioPercentToBp(text), bp, `${bp} 基点经表单往返后变了`);
  }
});

// ——————————————————————— 四、提示文案 ———————————————————————

test("非法比例的提示文案非空，且说明合法区间", () => {
  assert.equal(typeof SHARE_RATIO_INVALID_MESSAGE, "string");
  assert.ok(SHARE_RATIO_INVALID_MESSAGE.trim().length > 0);
  // 文案要说清「填什么才对」，而不是只说「格式错误」
  assert.ok(SHARE_RATIO_INVALID_MESSAGE.includes("0"));
  assert.ok(SHARE_RATIO_INVALID_MESSAGE.includes("100"));
});
