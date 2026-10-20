import { cookies } from "next/headers";

/**
 * OAuth state 的**Cookie 绑定**（**仅服务端**，依赖请求上下文）。
 *
 * ## 为什么 state 要同时进数据库和 Cookie
 *
 * 只校验 query 里的 state 挡不住「登录 CSRF」：攻击者可以自己发起一次授权、
 * 拿到一个合法 state，再诱导受害者完成回调，把受害者登录进攻击者的账号。
 * 因此 state 还要出现在**发起登录的那个浏览器**的 HttpOnly Cookie 里；
 * 回调必须两者相同，攻击者无法把自己的 Cookie 写到受害者浏览器上。
 *
 * 数据库里的 `consumed_at` 再挡一层重放：同一个 state 只能成功回调一次。
 *
 * 生成、哈希与回跳地址校验在 `stateToken.ts`（纯逻辑，有单元测试）。
 */

import { WECHAT_STATE_TTL_SECONDS } from "./stateToken";

export * from "./stateToken";

export const WECHAT_STATE_COOKIE = "chaoge_wechat_state";

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env["NODE_ENV"] === "production",
    maxAge,
  };
}

/** 把 state 原文写进发起登录的浏览器（仅 Route Handler 调用）。 */
export async function setWechatStateCookie(raw: string): Promise<void> {
  const jar = await cookies();
  jar.set(WECHAT_STATE_COOKIE, raw, cookieOptions(WECHAT_STATE_TTL_SECONDS));
}

export async function readWechatStateCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(WECHAT_STATE_COOKIE)?.value ?? null;
}

/** 清除 state Cookie。**无论回调成功失败都要调用**，避免旧 state 留在浏览器里。 */
export async function clearWechatStateCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(WECHAT_STATE_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
}
