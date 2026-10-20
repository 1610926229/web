import { randomUUID } from "node:crypto";
import type { AdminAuditAction, AdminAuditSnapshot, AdminAuditTargetType } from "@/lib/types/adminAudit";
import { buildAuditEntry, type AdminWriteContext } from "../adminWriteSupport";
import { appendAuditEntryTx } from "./adminAuditRepository";
import { getPgExecutor } from "./executor";

/**
 * 真实账号的 PostgreSQL 读写（**仅服务端**）。
 *
 * ## 为什么没有 Mock 实现
 *
 * 真实认证只在 `DATA_SOURCE=postgres` 时启用（`lib/auth/realAuth.ts`）。Mock 数据源
 * 下沿用既有的三套 Mock 登录；把凭据与会话再实现一份内存版，只会让
 * 「真实会话到底有没有落库」这件事在本地看起来像真的，而它并不是。
 *
 * ## 为什么这里直接写 SQL，而不扩 `UserRepository`
 *
 * 账号实体（`UserRecord` / `StaffAccount` / `AdminAccount`）刻意**不携带**密码哈希，
 * 这是 `0017_real_auth.sql` 的设计目标。如果给用户仓储加
 * `findUserByEmailWithPassword()`，哈希就会顺着一个“用户仓储”的方法流进
 * 每一个能拿到仓储的地方。认证相关的读取因此收敛在本文件，调用方只有
 * `lib/services/*Auth.ts` 与 `lib/auth/*Session.ts`。
 */

export type AuthSubjectKind = "user" | "staff" | "admin";

export type AuthCredential = {
  subjectId: string;
  passwordHash: string;
};

export type AuthSessionRecord = {
  id: string;
  subjectKind: AuthSubjectKind;
  subjectId: string;
  createdAt: string;
  expiresAt: string;
};

export type RegisterUserInput = {
  id: string;
  displayId: string;
  nickname: string;
  avatarUrl: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  at: string;
};

export type RegisterUserOutcome =
  | { kind: "ok"; userId: string }
  | { kind: "email-taken" };

export type CreateSessionInput = {
  id: string;
  subjectKind: AuthSubjectKind;
  subjectId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
};

type CredentialRow = {
  subject_id: string;
  password_hash: string;
};

type SessionRow = {
  id: string;
  subject_kind: AuthSubjectKind;
  subject_id: string;
  created_at: string;
  expires_at: string;
};

type UpdatedAtRow = {
  updated_at: string | null;
};

/**
 * PostgreSQL 的唯一冲突。`constraint` 在唯一索引冲突时是索引名。
 *
 * ⚠️ 只看 `code` 不看 `constraint` 会把「用户 id 撞了」也翻译成「邮箱已注册」——
 * 那是一条会把真正的 bug 永久伪装成用户输入的翻译。
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === constraint;
}

function toCredential(row: CredentialRow): AuthCredential {
  return { subjectId: row.subject_id, passwordHash: row.password_hash };
}

function toSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * 注册：`users` 与 `user_credentials` **同一个事务**。
 *
 * 先建账号再写凭据；任一步失败整体回滚，因此不会留下「有账号但登录不了」的孤儿。
 * 邮箱唯一性由 `user_credentials_email_key` 兜底——即使两个并发注册同时通过了
 * 服务层的预检查，也只有一个能提交。
 */
export async function registerUser(input: RegisterUserInput): Promise<RegisterUserOutcome> {
  try {
    await getPgExecutor().withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, display_id, nickname, avatar_url, bio)
         VALUES ($1, $2, $3, $4, '')`,
        [input.id, input.displayId, input.nickname, input.avatarUrl],
      );

      await tx.query(
        `INSERT INTO user_credentials
           (user_id, email, email_normalized, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [input.id, input.email, input.emailNormalized, input.passwordHash, input.at],
      );
    });
  } catch (error) {
    if (isUniqueViolation(error, "user_credentials_email_key")) return { kind: "email-taken" };
    throw error;
  }

  return { kind: "ok", userId: input.id };
}

/** 按规范化邮箱取凭据。账号必须仍然存在（`JOIN users`），否则视为没有凭据。 */
export async function findUserCredentialByEmail(emailNormalized: string): Promise<AuthCredential | null> {
  const rows = await getPgExecutor().query<CredentialRow>(
    `SELECT c.user_id AS subject_id, c.password_hash
       FROM user_credentials c
       JOIN users u ON u.id = c.user_id
      WHERE c.email_normalized = $1`,
    [emailNormalized],
  );
  return rows[0] ? toCredential(rows[0]) : null;
}

/** 按登录名取客服凭据。登录名的大小写规则与 `staff_accounts` 的唯一索引一致。 */
export async function findStaffCredentialByUsername(username: string): Promise<AuthCredential | null> {
  const rows = await getPgExecutor().query<CredentialRow>(
    `SELECT c.staff_id AS subject_id, c.password_hash
       FROM staff_credentials c
       JOIN staff_accounts s ON s.id = c.staff_id
      WHERE lower(btrim(s.username)) = lower(btrim($1))`,
    [username],
  );
  return rows[0] ? toCredential(rows[0]) : null;
}

/** 按登录名取管理员凭据。 */
export async function findAdminCredentialByUsername(username: string): Promise<AuthCredential | null> {
  const rows = await getPgExecutor().query<CredentialRow>(
    `SELECT c.admin_id AS subject_id, c.password_hash
       FROM admin_credentials c
       JOIN admin_accounts a ON a.id = c.admin_id
      WHERE lower(btrim(a.username)) = lower(btrim($1))`,
    [username],
  );
  return rows[0] ? toCredential(rows[0]) : null;
}

/**
 * 按 id 取**本人**的凭据（修改密码时校验旧密码用）。
 *
 * 返回 null 有两种含义：这个账号还没有设置过密码（首次设置），或账号不存在。
 * 调用方已经持有有效会话，账号存在性由会话层保证，因此这里不再额外 JOIN。
 */
export async function findStaffCredentialById(staffId: string): Promise<AuthCredential | null> {
  const rows = await getPgExecutor().query<CredentialRow>(
    `SELECT staff_id AS subject_id, password_hash
       FROM staff_credentials WHERE staff_id = $1`,
    [staffId],
  );
  return rows[0] ? toCredential(rows[0]) : null;
}

export async function findAdminCredentialById(adminId: string): Promise<AuthCredential | null> {
  const rows = await getPgExecutor().query<CredentialRow>(
    `SELECT admin_id AS subject_id, password_hash
       FROM admin_credentials WHERE admin_id = $1`,
    [adminId],
  );
  return rows[0] ? toCredential(rows[0]) : null;
}

function auditOf(input: {
  ctx: AdminWriteContext;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  targetId: string;
  before: AdminAuditSnapshot | null;
  after: AdminAuditSnapshot | null;
}) {
  return buildAuditEntry(input);
}

function selfAuditContext(input: {
  adminId: string;
  at: string;
}): AdminWriteContext {
  return {
    actorId: input.adminId,
    actorRole: "admin",
    // 管理端写操作的既有约定：管理员显示名称不进入审计（见 `AdminAuditEntry.actorName`）
    actorName: null,
    operationId: `op_${randomUUID()}`,
    at: input.at,
  };
}

/**
 * 管理员给客服设置/重置密码。
 *
 * 三件事在**同一个事务**里：写凭据、吊销该客服已有的真实会话、写审计。
 * 因此不会出现「密码改了但旧会话还能用」或「改了却没有审计」。
 *
 * ⚠️ 审计的 before/after **只含更新时间**，绝不含哈希或密码。
 */
export async function setStaffPasswordWithAudit(input: {
  staffId: string;
  passwordHash: string;
  adminId: string;
  at: string;
}): Promise<{ updatedAt: string }> {
  return getPgExecutor().withTransaction(async (tx) => {
    const beforeRows = await tx.query<UpdatedAtRow>(
      `SELECT updated_at FROM staff_credentials WHERE staff_id = $1`,
      [input.staffId],
    );
    const beforeUpdatedAt = beforeRows[0]?.updated_at ?? null;

    const rows = await tx.query<UpdatedAtRow>(
      `INSERT INTO staff_credentials (staff_id, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (staff_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at
       RETURNING updated_at`,
      [input.staffId, input.passwordHash, input.at],
    );
    const updatedAt = rows[0]?.updated_at ?? input.at;

    await tx.query(
      `UPDATE auth_sessions
          SET revoked_at = $2
        WHERE subject_kind = 'staff' AND subject_id = $1 AND revoked_at IS NULL`,
      [input.staffId, input.at],
    );

    await appendAuditEntryTx(
      tx,
      auditOf({
        ctx: selfAuditContext({ adminId: input.adminId, at: input.at }),
        action: "staff.reset-password",
        targetType: "staff",
        targetId: input.staffId,
        before: { passwordUpdatedAt: beforeUpdatedAt },
        after: { passwordUpdatedAt: updatedAt },
      }),
    );

    return { updatedAt };
  });
}

/**
 * 管理员设置/修改**本人**密码。
 *
 * 修改成功后吊销该管理员的全部真实会话（包括当前这一个），调用方负责清 Cookie
 * 并要求重新登录。这样「改密码」与「旧会话失效」是同一个事实。
 */
export async function setAdminPasswordWithAudit(input: {
  adminId: string;
  passwordHash: string;
  at: string;
}): Promise<{ updatedAt: string }> {
  return getPgExecutor().withTransaction(async (tx) => {
    const beforeRows = await tx.query<UpdatedAtRow>(
      `SELECT updated_at FROM admin_credentials WHERE admin_id = $1`,
      [input.adminId],
    );
    const beforeUpdatedAt = beforeRows[0]?.updated_at ?? null;

    const rows = await tx.query<UpdatedAtRow>(
      `INSERT INTO admin_credentials (admin_id, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (admin_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at
       RETURNING updated_at`,
      [input.adminId, input.passwordHash, input.at],
    );
    const updatedAt = rows[0]?.updated_at ?? input.at;

    await tx.query(
      `UPDATE auth_sessions
          SET revoked_at = $2
        WHERE subject_kind = 'admin' AND subject_id = $1 AND revoked_at IS NULL`,
      [input.adminId, input.at],
    );

    await appendAuditEntryTx(
      tx,
      auditOf({
        ctx: selfAuditContext({ adminId: input.adminId, at: input.at }),
        action: "admin.password-change",
        targetType: "admin",
        targetId: input.adminId,
        before: { passwordUpdatedAt: beforeUpdatedAt },
        after: { passwordUpdatedAt: updatedAt },
      }),
    );

    return { updatedAt };
  });
}

/** 是否已经给这个管理员设置过密码（用于「首次设置免输旧密码」的判定）。 */
export async function hasAdminPassword(adminId: string): Promise<boolean> {
  const rows = await getPgExecutor().query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM admin_credentials WHERE admin_id = $1) AS "exists"`,
    [adminId],
  );
  return rows[0]?.exists === true;
}

export async function createSession(input: CreateSessionInput): Promise<void> {
  await getPgExecutor().query(
    `INSERT INTO auth_sessions
       (id, subject_kind, subject_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.id, input.subjectKind, input.subjectId, input.tokenHash, input.createdAt, input.expiresAt],
  );
}

/**
 * 按令牌哈希取**仍然有效**的会话。
 *
 * 过滤条件全部在 SQL 里：`revoked_at IS NULL`、`expires_at > now`。
 * 应用层不再判断——两处判断迟早会对同一行给出不同答案。
 */
export async function findSessionByTokenHash(
  tokenHash: string,
  now: string,
): Promise<AuthSessionRecord | null> {
  const rows = await getPgExecutor().query<SessionRow>(
    `SELECT id, subject_kind, subject_id, created_at, expires_at
       FROM auth_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, now],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

/** 退出登录：只影响这一条会话。找不到也算成功（幂等）。 */
export async function revokeSessionByTokenHash(tokenHash: string, at: string): Promise<void> {
  await getPgExecutor().query(
    `UPDATE auth_sessions SET revoked_at = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash, at],
  );
}

/** 清理过期/已吊销会话（运维入口，可选调用）。 */
export async function deleteExpiredSessions(now: string): Promise<number> {
  const rows = await getPgExecutor().query<{ id: string }>(
    `DELETE FROM auth_sessions
      WHERE expires_at <= $1 OR revoked_at IS NOT NULL
      RETURNING id`,
    [now],
  );
  return rows.length;
}
