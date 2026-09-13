/**
 * 结算相关的输入约束与校验。
 *
 * 单独成文件，是因为这些内容**服务端与浏览器都要用**：
 * - 服务端（`lib/services/checkout.ts`）拿它们做权威校验；
 * - 浏览器（结算页表单）拿它们做即时提示与 `maxLength`。
 *
 * 客户端组件**不能**从 `lib/services/checkout.ts` 导入这些常量——那个模块依赖
 * `lib/data` 与 `lib/mocks`，会顺带把 Mock 层和内存存储打进浏览器产物。
 *
 * 客户端校验只是「提前告诉用户」，判定始终以服务端为准。两侧共用同一个
 * `validateGameAccount`，因此**提示文案不会两边不一致**；这个文件不依赖任何其他模块，
 * 也因此可以直接用 node 跑一次纯逻辑核对（见文件末尾说明）。
 */

/** 单个订单的数量上限。没有库存与限购，但仍设上限，避免异常请求把金额算到离谱。 */
export const MAX_QUANTITY = 99;

/** 游戏 ID 长度上限。 */
export const GAME_ACCOUNT_MAX_LENGTH = 32;

/** 游戏 ID 基础字符校验：中英文、数字、下划线、连字符。 */
export const GAME_ACCOUNT_PATTERN = /^[A-Za-z0-9_\-一-龥]{1,32}$/;

/** 订单备注长度上限。 */
export const REMARK_MAX_LENGTH = 100;

/** 未填写（含只填空格）时的提示。 */
export const GAME_ACCOUNT_EMPTY_MESSAGE = "请填写游戏 ID";

/** 已填写但格式不合法时的提示。 */
export const GAME_ACCOUNT_INVALID_MESSAGE = "请输入有效的游戏 ID";

export type GameAccountValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "invalid"; message: string };

/**
 * 游戏 ID 校验：先去掉首尾空格，再判空、判长度与字符。
 *
 * 只有两种失败提示：没填（含只填空格）与格式不合法。长度超限对用户来说同样是
 * 「这个 ID 不合法」，不必再细分一种文案；输入框本身有 `maxLength`，正常输入不会碰到。
 */
export function validateGameAccount(raw: string): GameAccountValidation {
  const value = raw.trim();

  if (!value) {
    return { ok: false, reason: "empty", message: GAME_ACCOUNT_EMPTY_MESSAGE };
  }
  if (value.length > GAME_ACCOUNT_MAX_LENGTH || !GAME_ACCOUNT_PATTERN.test(value)) {
    return { ok: false, reason: "invalid", message: GAME_ACCOUNT_INVALID_MESSAGE };
  }
  return { ok: true, value };
}
