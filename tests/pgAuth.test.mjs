import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { hashPassword, verifyPassword } from "../lib/auth/password.ts";
import { createSessionToken } from "../lib/auth/sessionToken.ts";
import {
  createSession,
  deleteExpiredSessions,
  findAdminCredentialById,
  findAdminCredentialByUsername,
  findSessionByTokenHash,
  findStaffCredentialById,
  findStaffCredentialByUsername,
  findUserCredentialByEmail,
  hasAdminPassword,
  registerUser,
  revokeSessionByTokenHash,
  setAdminPasswordWithAudit,
  setStaffPasswordWithAudit,
} from "../lib/data/pg/authRepository.ts";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";

/**
 * PROD-4 · 真实账号的 **PostgreSQL** 行为（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * 「注册、会话、改密码这三件事的**数据层承诺**由数据库保证，而不是由应用层
 * 记得去保证。」因此断言都落在数据库自己回答的问题上：
 *
 * - 邮箱唯一性是不是**唯一索引**说了算（并发注册只成功一个）；
 * - 注册失败后是不是**一条孤儿都没留下**（两个 INSERT 同一个事务）；
 * - 会话过期/吊销是不是由 **SQL 过滤**，而不是调用方自己判断；
 * - 改密码之后旧会话是不是**同时**失效、审计是不是**同时**写入且不含哈希。
 *
 * 没有 `TEST_DATABASE_URL` 时整体 skip 并写明缺什么——不假装通过。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  // 本文件跑在独立子进程里，改环境变量不影响别的测试文件
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/** 固定时间：断言里的过期边界因此不随执行时刻漂移。 */
const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const AFTER_EXPIRY = "2026-01-09T00:00:00.000Z";

/** 每次注册用独立 id，避免用例之间互相占用。 */
let seq = 0;
function nextId(prefix = "u") {
  seq += 1;
  return `${prefix}_reg_${seq}`;
}

async function registerFixture(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `u_reg_${seq}`;
  const email = overrides.email ?? `${id}@example.com`;
  const input = {
    id,
    displayId: `9f8e7d6c-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    nickname: "测试用户（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    email,
    emailNormalized: email.trim().toLowerCase(),
    passwordHash: overrides.passwordHash ?? (await hashPassword("test-password-1")),
    at: AT,
    ...overrides,
  };
  const outcome = await registerUser(input);
  return { input, outcome };
}

async function countRows(sql, params = []) {
  const rows = await executor().query(sql, params);
  return Number(rows[0].count);
}

/** 造一条真实会话记录（令牌明文只在本函数里存在）。 */
async function createSessionFixture(subjectKind, subjectId) {
  const token = createSessionToken(new Date(AT));
  await createSession({
    id: token.id,
    subjectKind,
    subjectId,
    tokenHash: token.tokenHash,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  });
  return token;
}

/* ─────────────────────────── 生命周期 ─────────────────────────── */

before(async () => {
  if (!TEST_URL) return;
  await migrate(executor());
});

beforeEach(async () => {
  if (!TEST_URL) return;
  await resetDatabase(executor());
  await seedDatabase(executor());
});

after(async () => {
  if (!TEST_URL) return;
  await closePool();
});

/* ═══════════════════════ 注册 ═══════════════════════ */

test("注册成功：users 与 user_credentials 同时落库，且按规范化邮箱查得到", { skip: SKIP }, async () => {
  const { input, outcome } = await registerFixture({ email: "  New.User@Example.COM " });

  assert.deepEqual(outcome, { kind: "ok", userId: input.id });

  const users = await executor().query(
    `SELECT id, nickname FROM users WHERE id = $1`,
    [input.id],
  );
  assert.equal(users.length, 1);
  assert.equal(users[0].nickname, input.nickname);

  const credential = await findUserCredentialByEmail("new.user@example.com");
  assert.ok(credential, "规范化后的邮箱必须能查到凭据");
  assert.equal(credential.subjectId, input.id);
  assert.equal(await verifyPassword("test-password-1", credential.passwordHash), true);

  // 储的是哈希，不是明文
  assert.equal(credential.passwordHash.includes("test-password-1"), false);
});

test("邮箱唯一性大小写不敏感：同一个邮箱换大小写再注册返回 email-taken", { skip: SKIP }, async () => {
  const first = await registerFixture({ email: "Taken@Example.com" });
  assert.equal(first.outcome.kind, "ok");

  const secondId = nextId();
  const second = await registerFixture({ id: secondId, email: "TAKEN@example.COM" });

  assert.deepEqual(second.outcome, { kind: "email-taken" });

  // 失败的那次不能留下「有账号但登录不了」的孤儿
  assert.equal(
    await countRows(`SELECT count(*) FROM users WHERE id = $1`, [secondId]),
    0,
  );
  assert.equal(
    await countRows(`SELECT count(*) FROM user_credentials WHERE user_id = $1`, [secondId]),
    0,
  );
});

test("注册的原子性：凭据写入失败时 users 行一起回滚", { skip: SKIP }, async () => {
  // password_hash 有 CHECK (LIKE 'scrypt$%')。用一条故意不合规的哈希，
  // 让第二条 INSERT 必定失败，然后检查第一条 INSERT 也没有留下。
  const id = nextId();
  await assert.rejects(
    () => registerFixture({ id, passwordHash: "plain-text-is-not-allowed" }),
    (error) => error?.code === "23514", // check_violation
  );

  assert.equal(await countRows(`SELECT count(*) FROM users WHERE id = $1`, [id]), 0);
});

test("用户 id 撞车不会伪装成「邮箱已注册」：只翻译邮箱唯一索引的冲突", { skip: SKIP }, async () => {
  const first = await registerFixture();
  assert.equal(first.outcome.kind, "ok");

  // 同 id、不同邮箱 —— 撞的是 users 主键，必须原样抛出，而不是返回 email-taken
  await assert.rejects(
    () => registerFixture({ id: first.input.id, email: "another@example.com" }),
    (error) => {
      assert.equal(error?.code, "23505");
      assert.equal(error?.constraint, "users_pkey");
      return true;
    },
  );
});

test("并发注册同一邮箱：恰好一个成功，库里只有一条凭据", { skip: SKIP }, async () => {
  // 先把池子预热，让两个请求真的有机会重叠；唯一索引本身则不依赖重叠
  await Promise.all(Array.from({ length: 4 }, () => executor().query("SELECT 1")));

  const idA = nextId();
  const idB = nextId();
  const email = "race@example.com";
  const hash = await hashPassword("race-password-1");

  const outcomes = await Promise.all([
    registerFixture({ id: idA, email, passwordHash: hash }),
    registerFixture({ id: idB, email, passwordHash: hash }),
  ]);

  const kinds = outcomes.map((entry) => entry.outcome.kind).sort();
  assert.deepEqual(kinds, ["email-taken", "ok"]);
  assert.equal(
    await countRows(`SELECT count(*) FROM user_credentials WHERE email_normalized = $1`, [email]),
    1,
  );

  // 输家一条行都不该留下
  const loserId = outcomes[0].outcome.kind === "ok" ? idB : idA;
  assert.equal(await countRows(`SELECT count(*) FROM users WHERE id = $1`, [loserId]), 0);
});

test("未知邮箱查不到凭据，也不会抛错", { skip: SKIP }, async () => {
  assert.equal(await findUserCredentialByEmail("nobody@example.com"), null);
});

/* ═══════════════════════ 会话 ═══════════════════════ */

test("会话生命周期：未到期可查、到期不可查、吊销不可查、吊销幂等", { skip: SKIP }, async () => {
  const { input } = await registerFixture();
  const token = await createSessionFixture("user", input.id);

  const found = await findSessionByTokenHash(token.tokenHash, AT);
  assert.deepEqual(found, {
    id: token.id,
    subjectKind: "user",
    subjectId: input.id,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  });

  // 到期边界：SQL 是 expires_at > now，等于到期时刻即视为过期
  assert.equal(await findSessionByTokenHash(token.tokenHash, token.expiresAt), null);
  assert.equal(await findSessionByTokenHash(token.tokenHash, AFTER_EXPIRY), null);

  // 未到期但吊销
  await revokeSessionByTokenHash(token.tokenHash, LATER);
  assert.equal(await findSessionByTokenHash(token.tokenHash, LATER), null);

  // 第二次吊销不报错（退出登录是幂等的）
  await revokeSessionByTokenHash(token.tokenHash, LATER);
});

test("会话令牌摘要唯一：同一摘要写两次被数据库拒绝，而不是悄悄多一条会话", { skip: SKIP }, async () => {
  const { input } = await registerFixture();
  const token = await createSessionFixture("user", input.id);

  await assert.rejects(
    () =>
      createSession({
        id: "sess_duplicate",
        subjectKind: "user",
        subjectId: input.id,
        tokenHash: token.tokenHash,
        createdAt: AT,
        expiresAt: "2026-01-08T00:00:00.000Z",
      }),
    (error) => {
      assert.equal(error?.code, "23505");
      assert.equal(error?.constraint, "auth_sessions_token_hash_key");
      return true;
    },
  );
});

test("清理只删过期或已吊销的会话，仍然有效的会话不受影响", { skip: SKIP }, async () => {
  const { input } = await registerFixture();

  const activeToken = await createSessionFixture("user", input.id);
  const revokedToken = await createSessionFixture("user", input.id);

  // 过期用「过去的 createdAt / expiresAt」直接构造，不依赖真实时钟
  await createSession({
    id: "sess_expired",
    subjectKind: "user",
    subjectId: input.id,
    tokenHash: "e".repeat(64),
    createdAt: "2025-12-01T00:00:00.000Z",
    expiresAt: "2025-12-08T00:00:00.000Z",
  });
  await revokeSessionByTokenHash(revokedToken.tokenHash, LATER);
  assert.ok(await findSessionByTokenHash(activeToken.tokenHash, AT));

  const removed = await deleteExpiredSessions(LATER);
  assert.equal(removed, 2, "过期的那条 + 被吊销的那条");

  assert.ok(await findSessionByTokenHash(activeToken.tokenHash, LATER));
  assert.equal(await findSessionByTokenHash(revokedToken.tokenHash, LATER), null);
  assert.equal(await countRows(`SELECT count(*) FROM auth_sessions`), 1);
});

/* ═══════════════════════ 客服 / 管理员凭据与审计 ═══════════════════════ */

test("给客服设置密码：写凭据、吊销该客服全部真实会话、写审计，三件事同一个事务", { skip: SKIP }, async () => {
  const staffSession = await createSessionFixture("staff", "staff-1");
  const otherStaffSession = await createSessionFixture("staff", "staff-2");
  const adminSession = await createSessionFixture("admin", "admin-1");

  assert.equal(await findStaffCredentialById("staff-1"), null, "预置数据没有凭据");
  assert.equal(await findStaffCredentialByUsername("kefu-xiaoyu"), null);

  const hash = await hashPassword("staff-password-1");
  const result = await setStaffPasswordWithAudit({
    staffId: "staff-1",
    passwordHash: hash,
    adminId: "admin-1",
    at: AT,
  });
  assert.equal(Date.parse(result.updatedAt), Date.parse(AT));

  // 1）凭据可读，且验证得过
  const credential = await findStaffCredentialById("staff-1");
  assert.ok(credential);
  assert.equal(await verifyPassword("staff-password-1", credential.passwordHash), true);

  // 登录名大小写/空白不敏感
  const byName = await findStaffCredentialByUsername("  KEFU-XIAOYU ");
  assert.equal(byName?.subjectId, "staff-1");

  // 2）只有该客服的会话被吊销：另一个客服、管理员都不受影响
  assert.equal(await findSessionByTokenHash(staffSession.tokenHash, LATER), null);
  assert.ok(await findSessionByTokenHash(otherStaffSession.tokenHash, LATER));
  assert.ok(await findSessionByTokenHash(adminSession.tokenHash, LATER));

  // 3）审计：动作、目标、只含更新时间，不含哈希
  const audits = await executor().query(
    `SELECT actor_id, actor_role, actor_name, action, target_type, target_id,
            before, after
       FROM admin_audit_entries
      WHERE action = 'staff.reset-password'`,
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, "admin-1");
  assert.equal(audits[0].actor_role, "admin");
  assert.equal(audits[0].actor_name, null);
  assert.equal(audits[0].target_type, "staff");
  assert.equal(audits[0].target_id, "staff-1");
  assert.deepEqual(audits[0].before, { passwordUpdatedAt: null });
  assert.equal(typeof audits[0].after.passwordUpdatedAt, "string");
  assert.equal(JSON.stringify(audits[0]).includes(hash), false, "审计里绝不能出现哈希");
  assert.equal(JSON.stringify(audits[0]).includes("scrypt$"), false);
});

test("再次重置客服密码：before 记上一次更新时间，旧会话同样被吊销", { skip: SKIP }, async () => {
  const firstHash = await hashPassword("staff-password-1");
  const first = await setStaffPasswordWithAudit({
    staffId: "staff-1",
    passwordHash: firstHash,
    adminId: "admin-1",
    at: AT,
  });

  // 新密码生效之后再登录一次，产生一条新会话
  const secondSession = await createSessionFixture("staff", "staff-1");

  const secondHash = await hashPassword("staff-password-2");
  const second = await setStaffPasswordWithAudit({
    staffId: "staff-1",
    passwordHash: secondHash,
    adminId: "admin-2",
    at: LATER,
  });

  const audits = await executor().query(
    `SELECT before, after FROM admin_audit_entries
      WHERE action = 'staff.reset-password' ORDER BY created_at`,
  );
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[1].before, { passwordUpdatedAt: first.updatedAt });
  assert.ok(
    Date.parse(second.updatedAt) > Date.parse(first.updatedAt),
    "更新时间必须推进，否则「改过密码」在审计里看不出来",
  );

  assert.equal(await findSessionByTokenHash(secondSession.tokenHash, LATER), null);

  const credential = await findStaffCredentialById("staff-1");
  assert.equal(await verifyPassword("staff-password-2", credential.passwordHash), true);
  assert.equal(await verifyPassword("staff-password-1", credential.passwordHash), false);
});

test("管理员密码：首次设置前后 hasAdminPassword 翻转，改密码只吊销本人会话", { skip: SKIP }, async () => {
  assert.equal(await hasAdminPassword("admin-1"), false);

  const adminSession = await createSessionFixture("admin", "admin-1");
  const otherAdminSession = await createSessionFixture("admin", "admin-2");
  const staffSession = await createSessionFixture("staff", "staff-1");

  const result = await setAdminPasswordWithAudit({
    adminId: "admin-1",
    passwordHash: await hashPassword("admin-password-1"),
    at: AT,
  });
  assert.equal(Date.parse(result.updatedAt), Date.parse(AT));
  assert.equal(await hasAdminPassword("admin-1"), true);
  assert.equal(await hasAdminPassword("admin-2"), false);

  const credential = await findAdminCredentialById("admin-1");
  assert.equal(await verifyPassword("admin-password-1", credential.passwordHash), true);
  assert.equal(
    (await findAdminCredentialByUsername("  MOCK-ADMIN "))?.subjectId,
    "admin-1",
  );

  assert.equal(await findSessionByTokenHash(adminSession.tokenHash, LATER), null);
  assert.ok(await findSessionByTokenHash(otherAdminSession.tokenHash, LATER));
  assert.ok(await findSessionByTokenHash(staffSession.tokenHash, LATER));

  const audits = await executor().query(
    `SELECT actor_id, target_type, target_id, before, after
       FROM admin_audit_entries WHERE action = 'admin.password-change'`,
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, "admin-1");
  assert.equal(audits[0].target_type, "admin");
  assert.equal(audits[0].target_id, "admin-1");
  assert.deepEqual(audits[0].before, { passwordUpdatedAt: null });
  assert.equal(typeof audits[0].after.passwordUpdatedAt, "string");
});
