import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/constants/credentials";

export { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/**
 * 密码哈希与邮箱规范化（**仅服务端**）。
 *
 * ## 为什么用 Node 内置 scrypt，而不是引入 bcrypt / argon2
 *
 * - scrypt 是 Node 标准库自带的、被密码学社区接受的 KDF，不新增原生依赖
 *   （本仓库对 `allowBuilds` 很谨慎，见 `pnpm-workspace.yaml`）；
 * - 参数（N / r / p）写进哈希串本身，将来调高成本可以在登录成功时按需重算，
 *   不会把旧哈希变成不可验证；
 * - `timingSafeEqual` 让比较时间与内容无关。
 *
 * ⚠️ 本文件**只能被服务端模块引用**：`node:crypto` 不能进浏览器产物。
 * 客户端登录表单只调用 HTTP 接口，不 import 这里。
 */

/** scrypt 参数。N 必须大于 1 且是 2 的幂。 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** 与 N/r/p 对应的内存上限。128 * N * r 是 scrypt 的近似内存需求，再留一倍余量。 */
const MAX_MEMORY = 128 * SCRYPT_N * SCRYPT_R * 2;

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * 邮箱规范化：**唯一**的一处规则。
 *
 * 注册、登录、唯一索引三处必须用同一个结果，否则会出现
 * 「注册时能通过、登录时找不到」这种只在特定大小写下复现的问题。
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 邮箱形状校验。只做最低限度的结构检查，不试图实现 RFC 5322 全集。 */
export function isValidEmail(normalized: string): boolean {
  if (normalized.length < 3 || normalized.length > EMAIL_MAX_LENGTH) return false;
  if (normalized.includes(" ")) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

/**
 * 密码长度校验。
 *
 * ⚠️ 只检查长度，**不**要求大小写/数字/符号组合：那类规则会把用户推向
 * 「Password1!」这种可预测密码，而且与服务端安全强度没有直接关系。
 * 真正提高强度的是 KDF 成本与登录限流（后者列为公网开放前条件）。
 */
export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

/** 生成哈希串：`scrypt$N$r$p$salt$hash`。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });

  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt,
    key.toString("base64url"),
  ].join("$");
}

type ParsedHash = {
  N: number;
  r: number;
  p: number;
  salt: string;
  hash: Buffer;
};

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;

  const hash = Buffer.from(parts[5], "base64url");
  if (hash.length === 0) return null;

  return { N, r, p, salt: parts[4], hash };
}

/**
 * 校验密码。哈希串损坏、参数越界、长度不一致都返回 `false`，
 * 不抛错——登录接口对它们应当给出与「密码错误」完全相同的回答。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;

  try {
    const key = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * parsed.N * parsed.r * 2,
    });
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * 账号不存在时也跑一次同样成本的派生。
 *
 * 否则「未知邮箱」会比「密码错误」快一个数量级，攻击者可以用响应时间枚举
 * 哪些邮箱注册过。返回的布尔值**永远不要使用**——调用方无论如何都返回同一条错误。
 */
export async function consumePasswordCheckTime(password: string): Promise<void> {
  await scrypt(password, "chaoge-timing-salt", KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
}
