/**
 * 文本长度计算 —— 全站只此一份。
 *
 * 「长度」按**用户眼里的字符**算，而不是 JavaScript 的 `String.length`（UTF-16 code unit）：
 *
 * - 一个汉字计 1，一个英文字母计 1，一个数字计 1；
 * - 普通 Emoji（如 😀，在 UTF-16 里是占两个 code unit 的代理对）计 **1**，
 *   不会因为 `"😀".length === 2` 就被算成两个字；
 * - 用零宽连接符拼起来的组合 Emoji（如 👨‍👩‍👧）由多个 code point 组成，按 code point 逐个计入。
 *   这里刻意**不引入 `Intl.Segmenter`**（字形簇切分）：它在微信内置浏览器的老版本里不可靠，
 *   一旦两端支持程度不一致，就会变成「前端说没超、服务端说超了」的两套口径。
 *   宁可对组合 Emoji 多算几个字符，也不能让前端与服务端的结果分叉。
 *
 * 前端实时计数、服务端校验与测试**必须都调用本函数**，否则会出现
 * 「输入框允许继续输入、提交却被服务端拒绝」这种用户无法理解的错配。
 */
export function countCharacters(value: string): number {
  // Array.from 按 code point 拆分，代理对（Emoji）自然算作 1 个
  return Array.from(value).length;
}
