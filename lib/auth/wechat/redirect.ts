/**
 * 微信登录路由的站内跳转地址（仅服务端）。
 *
 * ## 为什么不用 `new URL(path, request.url)`
 *
 * 私有 Staging 经 SSH 隧道访问：服务器监听 `127.0.0.1:3000`，浏览器地址是
 * `127.0.0.1:3100`。部分部署形态下 `request.url` 会反映服务端监听地址，
 * 直接拿它做重定向会把浏览器送到一个它连不上的端口。
 *
 * `Host` / `X-Forwarded-*` 头才是浏览器实际使用的地址；有它们时优先使用。
 */

export function requestUrl(request: Request, path: string): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return new URL(path, request.url).toString();

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : new URL(request.url).protocol.replace(":", "");

  return new URL(path, `${protocol}://${host}`).toString();
}

/** 微信登录失败页地址。`reason` 只能是固定枚举值，不含任何微信响应原文。 */
export function errorPageUrl(request: Request, reason: string): string {
  return requestUrl(request, `/wechat-login?error=${encodeURIComponent(reason)}`);
}
