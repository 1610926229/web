import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth state 的**纯逻辑**部分：生成、哈希、形状校验、回跳地址白名单。
 *
 * ## 为什么与 `state.ts` 分开
 *
 * `state.ts` 负责写 HttpOnly Cookie，因此依赖 `next/headers`——那在 Node 的
 * 测试运行器里加载不了（与 `lib/auth/sessionToken.ts` / `session.ts` 同一分法）。
 * 纯逻辑拆出来之后，state 的生成规则、哈希格式、回跳地址校验都能被单元测试
 * 直接覆盖，而不是只能靠浏览器验收。
 *
 * ## 数据库只存哈希
 *
 * 与 `auth_sessions` 同一原则：state 原文也是凭据，泄露后可在有效期内被使用。
 * 数据库只存 SHA-256，原文只进 HttpOnly Cookie。
 */

/** state 有效期：10 分钟。扫码 + 手机确认通常远小于这个时间。 */
export const WECHAT_STATE_TTL_SECONDS = 10 * 60;

/** 32 字节 base64url = 43 个字符。 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type WechatStateToken = {
  /** 放进授权 URL 与 Cookie 的原文 */
  raw: string;
  /** 落库的唯一值 */
  hash: string;
};

export function createWechatStateToken(): WechatStateToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashWechatState(raw) };
}

export function hashWechatState(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function isPlausibleWechatState(raw: unknown): raw is string {
  return typeof raw === "string" && STATE_PATTERN.test(raw);
}

/**
 * 回跳地址白名单：只允许**站内路径**。
 *
 * 拒绝 `//evil.com`（协议相对 URL）、反斜杠（浏览器会当斜杠）、
 * 以及 `/api` 开头（登录完成后不该落在接口 JSON 上）。
 */
export function sanitizeRedirectPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";

  const value = raw.trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (value.includes("\\")) return "/";
  if (value === "/api" || value.startsWith("/api/")) return "/";

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "/";
  }

  return value.slice(0, 500);
}

/**
 * 常量时间比较两个 state。
 *
 * state 本身足够随机，普通 `===` 的时序泄漏在实践中不可利用；但这里成本几乎为零，
 * 且能让「不要用普通比较校验凭据」这条规则在代码里有一处统一落点。
 */
export function statesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
