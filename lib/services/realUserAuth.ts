import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api/ApiError";
import {
  MOCK_AVATAR_OPTIONS,
  NICKNAME_MAX_LENGTH,
  normalizeNickname,
} from "@/lib/constants/profile";
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  consumePasswordCheckTime,
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  verifyPassword,
} from "@/lib/auth/password";
import { createRealSession, isRealAuthEnabled } from "@/lib/auth/realSession";
import {
  findUserCredentialByEmail,
  registerUser,
} from "@/lib/data/pg/authRepository";
import { getUserRepository, toSessionUser } from "@/lib/data/userRepository";
import type { User } from "@/lib/types/user";

/**
 * 用户真实注册 / 登录 / 退出（**仅服务端**）。
 *
 * ## 边界
 *
 * - 只在 `DATA_SOURCE=postgres` 时存在；Mock 数据源下按「接口不存在」返回 404，
 *   不给出一个看起来能用、实际只写进内存的注册入口。
 * - 密码只以 scrypt 哈希落库（`0017_real_auth.sql` + `lib/auth/password.ts`）。
 * - 会话令牌只以 SHA-256 落库，明文只出现在 HttpOnly Cookie 里一次。
 * - 登录失败对「邮箱不存在」与「密码错误」给**同一句话、同一个状态码**，
 *   并在账号不存在时也跑一次等成本的派生，避免用响应时间枚举邮箱。
 *
 * ## 为什么注册后直接建立会话
 *
 * 注册与登录是同一个意图的两半：让用户先注册再回登录页输一遍刚输入的密码，
 * 只会多一次失败机会。注册成功即登录，会话写入方式与登录完全相同。
 */

export const REAL_AUTH_DISABLED_MESSAGE = "账号注册与登录尚未开放";
export const INVALID_CREDENTIALS_MESSAGE = "邮箱或密码不正确";
export const INVALID_EMAIL_MESSAGE = "请输入有效的邮箱地址";
export const INVALID_PASSWORD_MESSAGE = `密码长度需为 ${PASSWORD_MIN_LENGTH}–128 个字符`;

/** 真实账号接口的总闸：未启用时抛 404（接口不存在）。 */
export function assertRealAuthEnabled(): void {
  if (!isRealAuthEnabled()) {
    throw new ApiError("NOT_FOUND", REAL_AUTH_DISABLED_MESSAGE, 404);
  }
}

/** 只接受字符串输入；其余类型一律按空串处理，由后续校验给出同一条错误。 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 注册时的昵称：用户没填就由邮箱本地部分派生。
 *
 * 派生值仍然走同一套长度规则（按 Unicode 码点截断，不切坏 Emoji），
 * 并在为空时回落到「玩家」。昵称不是身份，因此这里不做唯一性。
 */
function deriveNickname(rawNickname: string, emailNormalized: string): string {
  const explicit = rawNickname.trim();
  if (explicit) {
    const parsed = normalizeNickname(explicit);
    if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);
    return parsed.nickname;
  }

  const local = emailNormalized.split("@")[0] ?? "";
  const shortened = Array.from(local).slice(0, NICKNAME_MAX_LENGTH).join("");
  return shortened || "玩家";
}

export type RegisterUserAccountInput = {
  email: unknown;
  password: unknown;
  nickname?: unknown;
};

/**
 * 注册并登录。
 *
 * ⚠️ 「邮箱已注册」与「注册成功」是两种结果，但都**不告诉调用方这个邮箱是否存在于别处**：
 * 注册接口本身必须能给出「已注册」的提示（否则用户无法继续），
 * 登录接口则永远只说「邮箱或密码不正确」。两者的取舍不同，不应合并成一条规则。
 */
export async function registerUserAccount(input: RegisterUserAccountInput): Promise<User> {
  assertRealAuthEnabled();

  const email = asString(input.email);
  const normalized = normalizeEmail(email);
  const password = asString(input.password);

  if (!normalized || normalized.length > EMAIL_MAX_LENGTH || !isValidEmail(normalized)) {
    throw new ApiError("BAD_REQUEST", INVALID_EMAIL_MESSAGE);
  }
  if (!isValidPassword(password)) {
    throw new ApiError("BAD_REQUEST", INVALID_PASSWORD_MESSAGE);
  }

  const nickname = deriveNickname(asString(input.nickname), normalized);
  const now = new Date();
  const userId = `u_${randomUUID()}`;

  const outcome = await registerUser({
    id: userId,
    // displayId 与 Mock 种子保持同一形态：一个 UUID 形状的展示号，与任何真实身份无关
    displayId: randomUUID(),
    nickname,
    avatarUrl: MOCK_AVATAR_OPTIONS[0],
    email,
    emailNormalized: normalized,
    passwordHash: await hashPassword(password),
    at: now.toISOString(),
  });

  if (outcome.kind === "email-taken") {
    throw new ApiError("BAD_REQUEST", "该邮箱已注册，请直接登录");
  }

  const record = await getUserRepository().findUserById(userId);
  if (!record) {
    // 刚写进去就查不到只可能是服务端问题；不把内部细节透出去
    throw new ApiError("SERVER_ERROR", "注册失败，请稍后重试");
  }

  await createRealSession("user", userId, now);
  return toSessionUser(record);
}

/**
 * 邮箱密码登录。
 *
 * 所有失败分支（邮箱不存在 / 密码错误 / 账号被删）返回**同一个** `ApiError`。
 * 账号不存在时仍然跑一次同成本的密码派生，使两条路径的响应时间不可区分。
 */
export async function loginUserWithPassword(email: unknown, password: unknown): Promise<User> {
  assertRealAuthEnabled();

  const normalized = normalizeEmail(asString(email));
  const passwordText = asString(password);

  // ⚠️ 空邮箱 / 超长输入也走同一条失败路径，不额外给「格式不对」——
  // 登录接口的职责是「能不能进」，格式提示只会变成邮箱枚举的辅助信号。
  if (!normalized || normalized.length > EMAIL_MAX_LENGTH || !passwordText) {
    await consumePasswordCheckTime("invalid-login");
    throw new ApiError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE, 401);
  }

  const credential = await findUserCredentialByEmail(normalized);
  if (!credential) {
    await consumePasswordCheckTime(passwordText);
    throw new ApiError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE, 401);
  }

  const matches = await verifyPassword(passwordText, credential.passwordHash);
  if (!matches) {
    throw new ApiError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE, 401);
  }

  const record = await getUserRepository().findUserById(credential.subjectId);
  if (!record) {
    throw new ApiError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE, 401);
  }

  await createRealSession("user", record.id);
  return toSessionUser(record);
}
