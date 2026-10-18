import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * 服务端会话令牌（**仅服务端**）。
 *
 * ## 设计
 *
 * - Cookie 里放 32 字节随机值（base64url），**不携带任何账号信息**；
 * - 数据库只存它的 SHA-256。即使数据库被读，哈希也不能直接当 Cookie 用；
 * - 每次请求用令牌哈希查 `auth_sessions`，再按 `subject_kind` 回各自的账号仓储
 *   复核 `enabled` / 角色——会话存在**不等于**账号仍然有效。
 *
 * ⚠️ 为什么不用 JWT：本阶段的会话必须能被**立即吊销**（改密码、停用账号）。
 * 自包含令牌在过期前天然无法撤销，除非再建一张黑名单表——那不如直接查会话表。
 */

/** 会话有效期：7 天，与既有三套 Mock Cookie 保持同一数量级。 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type SessionToken = {
  /** 数据库主键 */
  id: string;
  /** 只写进 Cookie 的明文令牌 */
  token: string;
  /** 数据库里保存的摘要 */
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

/** 摘要在数据库里有固定长度（64 个十六进制字符），迁移层也按它约束。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(now: Date = new Date()): SessionToken {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();

  return {
    id: `sess_${randomUUID()}`,
    token,
    tokenHash: hashSessionToken(token),
    createdAt: now.toISOString(),
    expiresAt,
  };
}

/** 只接受 createSessionToken 产出的形状，避免把任意 Cookie 值当查询键。 */
export function isPlausibleSessionToken(value: string): boolean {
  return value.length >= 40 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}
