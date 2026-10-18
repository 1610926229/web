import { randomUUID } from "node:crypto";
import { getPgExecutor, type PgQueryable } from "./executor";

/**
 * 微信外部身份与 OAuth state 的 PostgreSQL 读写（**仅服务端**）。
 *
 * ## 为什么没有 Mock 实现
 *
 * 身份绑定必须跨进程、跨重启稳定：Mock 内存实现会让「换一个进程就变成新用户」
 * 看起来像正常工作。本模块只在 `DATA_SOURCE=postgres` 时被调用，
 * Mock 数据源下微信登录接口整体不存在。
 *
 * ## 并发首登
 *
 * 同一 openid 的两个并发回调可能同时查不到身份、同时尝试建用户。数据库唯一索引
 * （openid / unionid 两套）是最终判据：输的那一方事务回滚，然后重新按唯一键
 * 查到赢家写入的用户并返回它。因此不会出现「一个微信身份对应两个平台用户」。
 */

export type ExternalIdentityProvider = "wechat" | "mock";

export type ResolveIdentityInput = {
  provider: ExternalIdentityProvider;
  appId: string;
  openId: string;
  unionId: string | null;
  nickname: string;
  avatarUrl: string;
  at: string;
};

export type ResolveIdentityResult = {
  userId: string;
  /** 本次调用是否创建了新的平台用户 */
  created: boolean;
};

type IdentityRow = {
  user_id: string;
};

type StateRow = {
  redirect_to: string;
};

type UserIdRow = {
  id: string;
};

/**
 * PostgreSQL 唯一冲突。只在确认是**身份键**冲突时重试；
 * 其他唯一冲突（例如 users 主键）说明是真正的异常，不能悄悄吞掉。
 */
function isIdentityUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return false;
  return (
    candidate.constraint === "external_identities_provider_app_open_key" ||
    candidate.constraint === "external_identities_provider_union_key"
  );
}

/**
 * 按 openid 找；找不到且有 unionid 时按 unionid 找。
 *
 * 先 openid 后 unionid 的顺序不能反：如果先按 unionid 命中，
 * 会走「链接已有账号」分支，多发一次写；而绝大多数回调都是老用户，
 * openid 命中是最短路径。
 */
async function findIdentityUserByOpenId(
  db: PgQueryable,
  input: Pick<ResolveIdentityInput, "provider" | "appId" | "openId">,
): Promise<string | null> {
  const byOpenId = await db.query<IdentityRow>(
    `SELECT user_id FROM external_identities
      WHERE provider = $1 AND app_id = $2 AND open_id = $3`,
    [input.provider, input.appId, input.openId],
  );
  return byOpenId[0]?.user_id ?? null;
}

async function findIdentityUser(
  db: PgQueryable,
  input: Pick<ResolveIdentityInput, "provider" | "appId" | "openId" | "unionId">,
): Promise<string | null> {
  const byOpenId = await findIdentityUserByOpenId(db, input);
  if (byOpenId) return byOpenId;

  if (input.unionId) {
    const byUnionId = await db.query<IdentityRow>(
      `SELECT user_id FROM external_identities
        WHERE provider = $1 AND union_id = $2
        LIMIT 1`,
      [input.provider, input.unionId],
    );
    if (byUnionId[0]) return byUnionId[0].user_id;
  }

  return null;
}

/**
 * 把一次微信授权解析成平台用户；不存在则创建。
 *
 * 三种情况：
 * 1. 这个应用里的 openid 已绑定 → 返回其用户；
 * 2. 同一开放平台主体（unionid）已绑定过别的应用 → 复用那个用户，
 *    为当前应用追加一条 openid 身份；
 * 3. 全新身份 → 新建 `users` + `external_identities`（同一事务）。
 */
export async function resolveOrCreateUserFromIdentity(
  input: ResolveIdentityInput,
): Promise<ResolveIdentityResult> {
  const executor = getPgExecutor();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 快路径：这个应用的 openid 已经绑定过。绝大多数回调走这一条。
    const existing = await findIdentityUserByOpenId(executor, input);
    if (existing) return { userId: existing, created: false };

    const userId = `u_${randomUUID()}`;
    try {
      const resolved = await executor.withTransaction(async (tx) => {
        // 事务内重查：把「查询 → 写入」的窗口压到最小；真正兜底仍是唯一索引
        const raced = await findIdentityUserByOpenId(tx, input);
        if (raced) return { userId: raced, created: false };

        // unionid 已属于别的用户（同一开放平台主体的另一个应用）→ 复用该用户
        const linked = input.unionId
          ? await tx.query<IdentityRow>(
              `SELECT user_id FROM external_identities
                WHERE provider = $1 AND union_id = $2
                LIMIT 1`,
              [input.provider, input.unionId],
            )
          : [];
        const targetUserId = linked[0]?.user_id ?? userId;

        if (!linked[0]) {
          await tx.query(
            `INSERT INTO users (id, display_id, nickname, avatar_url, bio)
             VALUES ($1, $2, $3, $4, '')`,
            [targetUserId, randomUUID(), input.nickname, input.avatarUrl],
          );
        }

        // ⚠️ unionid 在表里只出现在**第一行**：唯一索引 `provider + union_id`
        // 保证一个开放平台主体只能指向一个平台用户。后续应用链接到同一用户时
        // 仍然写入自己的 openid 行，只是把 unionid 留空；unionid → 用户 的
        // 查找永远命中第一行。
        await tx.query(
          `INSERT INTO external_identities
             (id, provider, app_id, open_id, union_id, user_id,
              nickname_snapshot, avatar_url_snapshot, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            `ext_${randomUUID()}`,
            input.provider,
            input.appId,
            input.openId,
            linked[0] ? null : input.unionId,
            targetUserId,
            input.nickname,
            input.avatarUrl,
            input.at,
          ],
        );

        return { userId: targetUserId, created: !linked[0] };
      });

      return resolved;
    } catch (error) {
      if (isIdentityUniqueViolation(error)) continue;
      throw error;
    }
  }

  // 连续 3 次冲突：另一个事务已经写入，最后再查一次唯一键
  const final = await findIdentityUser(executor, input);
  if (final) return { userId: final, created: false };

  throw new Error("无法解析微信身份：唯一键冲突重试后仍未找到既有身份");
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth state
// ─────────────────────────────────────────────────────────────────────────────

export type CreateOAuthStateInput = {
  id: string;
  provider: ExternalIdentityProvider;
  stateHash: string;
  redirectTo: string;
  createdAt: string;
  expiresAt: string;
};

export async function createOAuthState(input: CreateOAuthStateInput): Promise<void> {
  await getPgExecutor().query(
    `INSERT INTO auth_oauth_states
       (id, provider, state_hash, redirect_to, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.provider,
      input.stateHash,
      input.redirectTo,
      input.createdAt,
      input.expiresAt,
    ],
  );
}

/**
 * 原子消费一个 state，返回发起登录时记录的回跳地址；无效/过期/已消费返回 null。
 *
 * ⚠️ 单条 `UPDATE … WHERE consumed_at IS NULL AND expires_at > now RETURNING`
 * 是这条流程唯一的「检查并消费」点。先 SELECT 再 UPDATE 会给两个并发回调
 * 同时放行的窗口。
 */
export async function consumeOAuthState(
  stateHash: string,
  now: string,
): Promise<{ redirectTo: string } | null> {
  const rows = await getPgExecutor().query<StateRow>(
    `UPDATE auth_oauth_states
        SET consumed_at = $2
      WHERE state_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2
      RETURNING redirect_to`,
    [stateHash, now],
  );
  return rows[0] ? { redirectTo: rows[0].redirect_to } : null;
}

/** 该 state 是否存在但已过期（用于区分「过期」与「伪造/已用」的提示）。 */
export async function wasOAuthStateExpired(
  stateHash: string,
  now: string,
): Promise<boolean> {
  const rows = await getPgExecutor().query<UserIdRow>(
    `SELECT id FROM auth_oauth_states
      WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at <= $2`,
    [stateHash, now],
  );
  return rows.length > 0;
}

/** 清理已过期且未消费的 state（运维入口，可选调用）。 */
export async function deleteExpiredOAuthStates(now: string): Promise<number> {
  const rows = await getPgExecutor().query<{ id: string }>(
    `DELETE FROM auth_oauth_states
      WHERE expires_at <= $1 AND consumed_at IS NULL
      RETURNING id`,
    [now],
  );
  return rows.length;
}
