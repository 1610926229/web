/**
 * 微信登录流程的错误分类（**仅服务端**）。
 *
 * 为什么不直接复用 `ApiError` 的 code：
 * 回调是**浏览器地址栏跳转**，错误最终落在 `/wechat-login?error=<reason>` 页面上。
 * 页面需要区分「没配置」「state 失效」「授权码失效」「网络失败」，
 * 而 `ApiError` 的 `BAD_REQUEST` 一类无法表达这些差别。
 *
 * ⚠️ `reason` 只包含固定的枚举值，不包含任何来自微信响应、URL 或环境的原文。
 * 把 `errcode` / `errmsg` / code / token 放进查询参数会顺着浏览器历史与日志泄漏。
 */

export type WechatLoginErrorReason =
  | "not-configured"
  | "state-invalid"
  | "state-expired"
  | "code-invalid"
  | "cancelled"
  | "network"
  | "failed";

export class WechatLoginFlowError extends Error {
  readonly reason: WechatLoginErrorReason;

  constructor(reason: WechatLoginErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "WechatLoginFlowError";
    this.reason = reason;
  }
}
