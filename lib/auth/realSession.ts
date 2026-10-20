import { cookies } from "next/headers";
import {
  createSession,
  findSessionByTokenHash,
  revokeSessionByTokenHash,
  type AuthSubjectKind,
} from "@/lib/data/pg/authRepository";
import { isPostgresDataSourceEnabled } from "@/lib/data/pg/config";
import {
  MOCK_ADMIN_SESSION_COOKIE,
  MOCK_STAFF_SESSION_COOKIE,
  MOCK_USER_SESSION_COOKIE,
  REAL_ADMIN_SESSION_COOKIE,
  REAL_STAFF_SESSION_COOKIE,
  REAL_USER_SESSION_COOKIE,
} from "./cookieNames";
import {
  SESSION_TTL_SECONDS,
  createSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
} from "./sessionToken";

/**
 * 真实服务端会话（**仅服务端**）。
 *
 * ## 生效条件
 *
 * `DATA_SOURCE=postgres`。Mock 数据源下不读也不写这张表——本地开发与既有 1700+
 * 条 Mock 测试因此完全不受影响。这同时意味着「真实登录」不是一个可以单独打开的开关：
 * 会话校验要查账号表，而账号表在 Mock 下并不存在。
 *
 * ## 与 Mock 会话的关系
 *
 * 同一个身份可能同时带着两个 Cookie（staging 里 Mock 开关是开着的）。
 * 解析顺序是**真实会话优先**：
 *
 * 1. 有真实 Cookie 且有效 → 以它为准；
 * 2. 有真实 Cookie 但无效（过期 / 已退出 / 令牌形状不对）→ **匿名**，不回退 Mock；
 * 3. 没有真实 Cookie → 才看 Mock Cookie（既有开发便利）。
 *
 * 第 2 条是刻意的：如果失效的真实会话回退到 Mock，那么「退出登录」之后
 * 一个陈旧的 Mock Cookie 会把另一个身份重新变出来——那是身份混淆，不是便利。
 * 为此登录成功时会顺手删掉同一身份的 Mock Cookie，退出时两个一起删。
 *
 * ⚠️ 本文件不判断账号是否启用、角色对不对。它只回答「这个令牌指向哪条会话」，
 * 账号状态由调用方按各自的仓储重新查（见 `lib/services/staffAuth.ts` / `adminAuth.ts`）。
 */

const REAL_COOKIE: Record<AuthSubjectKind, string> = {
  user: REAL_USER_SESSION_COOKIE,
  staff: REAL_STAFF_SESSION_COOKIE,
  admin: REAL_ADMIN_SESSION_COOKIE,
};

const MOCK_COOKIE: Record<AuthSubjectKind, string> = {
  user: MOCK_USER_SESSION_COOKIE,
  staff: MOCK_STAFF_SESSION_COOKIE,
  admin: MOCK_ADMIN_SESSION_COOKIE,
};

/** 真实认证是否生效：数据源切到 PostgreSQL 时自动生效，不需要额外的环境变量。 */
export function isRealAuthEnabled(): boolean {
  return isPostgresDataSourceEnabled();
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // 本地开发是 http，生产（含 staging 的 127.0.0.1:3000 直连）需要按部署方式判断。
    // 公网正式开放时必须是 HTTPS，否则 secure Cookie 根本发不出去——这是
    // 「公网开放前条件」里 HTTPS 那一条的技术原因之一。
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * 一次会话查询的结果。
 *
 * `invalid` 与 `absent` 分开，是因为解析顺序需要它们：前者明确表示
 * 「带着一个真实会话，但它已经不作数了」，此时**不能**回退 Mock。
 */
export type RealSessionLookup =
  | { kind: "disabled" }
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "active"; sessionId: string; subjectId: string; expiresAt: string };

/** 读当前请求里某个身份的真实会话。 */
export async function lookupRealSession(
  subjectKind: AuthSubjectKind,
  now: Date = new Date(),
): Promise<RealSessionLookup> {
  const jar = await cookies();
  const raw = jar.get(REAL_COOKIE[subjectKind])?.value ?? null;

  if (!isRealAuthEnabled()) return { kind: "disabled" };
  if (!raw) return { kind: "absent" };
  if (!isPlausibleSessionToken(raw)) return { kind: "invalid" };

  const session = await findSessionByTokenHash(hashSessionToken(raw), now.toISOString());
  // subjectKind 不匹配说明令牌被放到了另一个身份的 Cookie 里（或数据库数据异常）。
  // 按无效处理，绝不「按会话里的 kind 换个身份」。
  if (!session || session.subjectKind !== subjectKind) return { kind: "invalid" };

  return {
    kind: "active",
    sessionId: session.id,
    subjectId: session.subjectId,
    expiresAt: session.expiresAt,
  };
}

/**
 * 建立真实会话并把令牌写进对应身份的 Cookie。
 *
 * ⚠️ 必须在 Route Handler 里调用：`cookies().set()` 在 Server Component 的
 * 渲染阶段会抛错。登录 / 注册接口天然满足这一点。
 */
export async function createRealSession(
  subjectKind: AuthSubjectKind,
  subjectId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!isRealAuthEnabled()) {
    throw new Error("真实认证未启用（DATA_SOURCE 不是 postgres）");
  }

  const token = createSessionToken(now);
  await createSession({
    id: token.id,
    subjectKind,
    subjectId,
    tokenHash: token.tokenHash,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  });

  const jar = await cookies();
  jar.set(REAL_COOKIE[subjectKind], token.token, cookieOptions());
  // 真实登录覆盖同一身份的 Mock 登录：不删的话，真实会话过期后会「变回」另一个人
  jar.delete(MOCK_COOKIE[subjectKind]);
}

/** 退出登录：吊销这一条会话（若存在）并清掉两个 Cookie。幂等。 */
export async function destroyRealSession(
  subjectKind: AuthSubjectKind,
  now: Date = new Date(),
): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(REAL_COOKIE[subjectKind])?.value ?? null;

  if (isRealAuthEnabled() && raw && isPlausibleSessionToken(raw)) {
    await revokeSessionByTokenHash(hashSessionToken(raw), now.toISOString());
  }

  // path / secure 必须与写入时一致，否则删不掉
  jar.set(REAL_COOKIE[subjectKind], "", { ...cookieOptions(), maxAge: 0 });
  jar.set(MOCK_COOKIE[subjectKind], "", { ...cookieOptions(), maxAge: 0 });
}
