import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import {
  consumeOAuthState,
  createOAuthState,
  deleteExpiredOAuthStates,
  resolveOrCreateUserFromIdentity,
  wasOAuthStateExpired,
} from "../lib/data/pg/wechatRepository.ts";

/**
 * PROD-5 · 微信外部身份与 OAuth state 的 **PostgreSQL** 行为（打真库）。
 *
 * ## 这个文件要证明的那句话
 *
 * 「一个微信身份只对应一个平台用户，一个 state 只能成功回调一次」——
 * 这两件事由**数据库的唯一索引与原子 UPDATE**保证，而不是由应用层记得去保证。
 *
 * - openid / unionid 两套唯一键：并发首登只会留下一个用户；
 * - OAuth state 的消费是单条 `UPDATE … RETURNING`：并发回调只有一个能成功；
 * - 过期、重放、伪造的 state 都拿不到回跳地址。
 *
 * 没有 `TEST_DATABASE_URL` 时整体 skip 并写明缺什么——不假装通过。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
  process.env.DATA_SOURCE = "postgres";
}

const executor = () => getPgExecutor();

/** 固定时间：过期边界不随执行时刻漂移。 */
const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";
const AFTER_EXPIRY = "2026-01-01T00:11:00.000Z";

const APP_A = "wx-app-a";
const APP_B = "wx-app-b";

function openId() {
  return `openid-${randomUUID()}`;
}

function identityInput(overrides = {}) {
  return {
    provider: "wechat",
    appId: APP_A,
    openId: openId(),
    unionId: null,
    nickname: "微信用户（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    at: AT,
    ...overrides,
  };
}

async function countRows(sql, params = []) {
  const rows = await executor().query(sql, params);
  return Number(rows[0].count);
}

async function insertUser(id) {
  await executor().query(
    `INSERT INTO users (id, display_id, nickname, avatar_url, bio)
     VALUES ($1, $2, '另一个用户', '/mock/avatar-2.svg', '')`,
    [id, randomUUID()],
  );
}

async function insertIdentity({ userId, provider = "wechat", appId = APP_A, openId: oid, unionId = null }) {
  await executor().query(
    `INSERT INTO external_identities
       (id, provider, app_id, open_id, union_id, user_id,
        nickname_snapshot, avatar_url_snapshot, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '快照', '', $7, $7)`,
    [`ext_${randomUUID()}`, provider, appId, oid, unionId, userId, AT],
  );
}

function stateMigrationNotice() {
  return "0018 未应用：请先执行 pnpm db:migrate --target=test";
}

/* ─────────────────────────── 生命周期 ─────────────────────────── */

before(async () => {
  if (!TEST_URL) return;
  await migrate(executor());
  const rows = await executor().query(
    `SELECT version FROM schema_migrations WHERE version = '0018'`,
  );
  assert.equal(rows.length, 1, stateMigrationNotice());
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

/* ═══════════════════════ 身份解析 ═══════════════════════ */

test("首次登录：同一事务创建用户与外部身份；再次登录回到同一个用户", { skip: SKIP }, async () => {
  const input = identityInput({ nickname: "第一次昵称" });

  const first = await resolveOrCreateUserFromIdentity(input);
  assert.equal(first.created, true);

  const user = await executor().query(
    `SELECT id, nickname, avatar_url FROM users WHERE id = $1`,
    [first.userId],
  );
  assert.equal(user.length, 1);
  assert.equal(user[0].nickname, "第一次昵称");
  assert.equal(user[0].avatar_url, input.avatarUrl);

  // 第二次用同一个 openid、不同昵称：不建新用户、不覆盖快照
  const second = await resolveOrCreateUserFromIdentity({
    ...input,
    nickname: "改了昵称",
    at: LATER,
  });
  assert.deepEqual(second, { userId: first.userId, created: false });

  assert.equal(await countRows(`SELECT count(*) FROM users WHERE id = $1`, [first.userId]), 1);
  const identities = await executor().query(
    `SELECT provider, app_id, open_id, user_id, nickname_snapshot
       FROM external_identities WHERE user_id = $1`,
    [first.userId],
  );
  assert.equal(identities.length, 1);
  assert.equal(identities[0].provider, "wechat");
  assert.equal(identities[0].app_id, APP_A);
  assert.equal(identities[0].nickname_snapshot, "第一次昵称", "快照不随每次登录改写");
});

test("openid 按应用隔离：同一个 openid 字符串在不同 appid 下是两个用户", { skip: SKIP }, async () => {
  const oid = openId();
  const a = await resolveOrCreateUserFromIdentity(identityInput({ appId: APP_A, openId: oid }));
  const b = await resolveOrCreateUserFromIdentity(identityInput({ appId: APP_B, openId: oid }));

  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.userId, b.userId);
});

test("provider 隔离：Mock 与真实微信即使 appid/openid 相同也不会串成同一个人", { skip: SKIP }, async () => {
  const oid = openId();
  const real = await resolveOrCreateUserFromIdentity(
    identityInput({ provider: "wechat", appId: APP_A, openId: oid }),
  );
  const mock = await resolveOrCreateUserFromIdentity(
    identityInput({ provider: "mock", appId: APP_A, openId: oid }),
  );

  assert.equal(real.created, true);
  assert.equal(mock.created, true);
  assert.notEqual(real.userId, mock.userId);
});

test("openid 唯一索引是最终判据：手工写入重复 openid 被数据库拒绝", { skip: SKIP }, async () => {
  const input = identityInput();
  const resolved = await resolveOrCreateUserFromIdentity(input);

  await assert.rejects(
    () => insertIdentity({ userId: resolved.userId, openId: input.openId }),
    (error) => {
      assert.equal(error?.code, "23505");
      assert.equal(error?.constraint, "external_identities_provider_app_open_key");
      return true;
    },
  );
});

test("unionid 链接：第二个应用复用同一用户，并追加自己的 openid（unionid 只写在第一行）", { skip: SKIP }, async () => {
  const unionId = `unionid-${randomUUID()}`;
  const first = await resolveOrCreateUserFromIdentity(
    identityInput({ appId: APP_A, unionId, nickname: "第一应用" }),
  );
  assert.equal(first.created, true);

  const second = await resolveOrCreateUserFromIdentity(
    identityInput({
      appId: APP_B,
      unionId,
      openId: openId(),
      nickname: "第二应用",
      at: LATER,
    }),
  );
  assert.deepEqual(second, { userId: first.userId, created: false }, "不得为同一微信主体再建用户");

  const rows = await executor().query(
    `SELECT app_id, union_id FROM external_identities
      WHERE user_id = $1 ORDER BY app_id`,
    [first.userId],
  );
  assert.equal(rows.length, 2, "两个应用各自留下自己的 openid 行");
  assert.equal(rows[0].app_id, APP_A);
  assert.equal(rows[0].union_id, unionId);
  assert.equal(rows[1].app_id, APP_B);
  assert.equal(rows[1].union_id, null, "unionid 唯一索引要求后续行留空");

  // 以后再从两个应用登录，都回到同一个用户
  for (const appId of [APP_A, APP_B]) {
    const again = await resolveOrCreateUserFromIdentity(
      identityInput({ appId, unionId, at: AFTER_EXPIRY }),
    );
    assert.equal(again.userId, first.userId);
    assert.equal(again.created, false);
  }
});

test("unionid 唯一索引：同一 unionid 不能指向第二个平台用户", { skip: SKIP }, async () => {
  const unionId = `unionid-${randomUUID()}`;
  const first = await resolveOrCreateUserFromIdentity(
    identityInput({ unionId }),
  );

  const otherUserId = `u_other_${randomUUID()}`;
  await insertUser(otherUserId);

  await assert.rejects(
    () => insertIdentity({ userId: otherUserId, openId: openId(), unionId }),
    (error) => {
      assert.equal(error?.code, "23505");
      assert.equal(error?.constraint, "external_identities_provider_union_key");
      return true;
    },
  );

  assert.equal(await countRows(`SELECT count(*) FROM external_identities`), 1);
  assert.equal(first.created, true);
});

test("并发首登（同一 openid）：全部拿到同一个用户，库里只有一个用户与一条身份", { skip: SKIP }, async () => {
  // 预热连接池，让请求真的有机会重叠（唯一索引本身不依赖重叠）
  await Promise.all(Array.from({ length: 6 }, () => executor().query("SELECT 1")));

  const input = identityInput();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => resolveOrCreateUserFromIdentity(input)),
  );

  const userIds = new Set(results.map((result) => result.userId));
  assert.equal(userIds.size, 1, `并发首登必须收敛到一个用户，实际 ${userIds.size} 个`);
  assert.equal(results.filter((result) => result.created).length, 1, "只有一个事务真正创建了用户");

  const userId = results[0].userId;
  assert.equal(await countRows(`SELECT count(*) FROM users WHERE id = $1`, [userId]), 1, "预置用户之外只多出这一个账号");
  assert.equal(
    await countRows(
      `SELECT count(*) FROM external_identities WHERE provider = 'wechat' AND app_id = $1 AND open_id = $2`,
      [input.appId, input.openId],
    ),
    1,
  );
  assert.equal(
    await countRows(`SELECT count(*) FROM external_identities WHERE user_id = $1`, [userId]),
    1,
  );
});

test("并发首登（同一 unionid、两个应用）：收敛到同一个用户，两行身份都不丢", { skip: SKIP }, async () => {
  await Promise.all(Array.from({ length: 6 }, () => executor().query("SELECT 1")));

  const unionId = `unionid-${randomUUID()}`;
  const results = await Promise.all([
    resolveOrCreateUserFromIdentity(identityInput({ appId: APP_A, unionId })),
    resolveOrCreateUserFromIdentity(identityInput({ appId: APP_B, unionId })),
  ]);

  const userIds = new Set(results.map((result) => result.userId));
  assert.equal(userIds.size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);

  const userId = results[0].userId;
  assert.equal(await countRows(`SELECT count(*) FROM users WHERE id = $1`, [userId]), 1);
  assert.equal(
    await countRows(`SELECT count(*) FROM external_identities WHERE user_id = $1`, [userId]),
    2,
  );
  assert.equal(
    await countRows(
      `SELECT count(*) FROM external_identities WHERE user_id = $1 AND union_id IS NOT NULL`,
      [userId],
    ),
    1,
    "unionid 只出现在一行上",
  );
  assert.equal(
    await countRows(
      `SELECT count(*) FROM external_identities WHERE user_id = $1 AND app_id IN ($2, $3)`,
      [userId, APP_A, APP_B],
    ),
    2,
    "输掉竞争的那个应用也必须补上自己的 openid 行",
  );
});

test("身份表与用户表的约束：provider 只能是 wechat/mock，openid 长度有下限", { skip: SKIP }, async () => {
  const userId = `u_bad_${randomUUID()}`;
  await insertUser(userId);

  await assert.rejects(
    () => insertIdentity({ userId, provider: "weibo", openId: openId() }),
    (error) => error?.code === "23514",
  );

  await assert.rejects(
    () => insertIdentity({ userId, openId: "short" }),
    (error) => error?.code === "23514",
  );
});

/* ═══════════════════════ OAuth state ═══════════════════════ */

function stateInput(overrides = {}) {
  return {
    id: `st_${randomUUID()}`,
    provider: "wechat",
    stateHash: randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64),
    redirectTo: "/orders",
    createdAt: AT,
    expiresAt: LATER,
    ...overrides,
  };
}

test("state 一次性：第一次消费拿到回跳地址，第二次（重放）拿不到", { skip: SKIP }, async () => {
  const input = stateInput({ redirectTo: "/orders?tab=paid" });
  await createOAuthState(input);

  assert.deepEqual(await consumeOAuthState(input.stateHash, AT), {
    redirectTo: "/orders?tab=paid",
  });
  assert.equal(await consumeOAuthState(input.stateHash, AT), null);
  assert.equal(await consumeOAuthState(input.stateHash, LATER), null);
  assert.equal(await wasOAuthStateExpired(input.stateHash, LATER), false, "已消费不等于过期");
});

test("state 过期：过期后不能消费，并且能区分「过期」与「伪造/已用」", { skip: SKIP }, async () => {
  const input = stateInput();
  await createOAuthState(input);

  assert.equal(await consumeOAuthState(input.stateHash, AFTER_EXPIRY), null);
  assert.equal(await wasOAuthStateExpired(input.stateHash, AFTER_EXPIRY), true);
  assert.equal(await wasOAuthStateExpired(input.stateHash, AT), false);

  // 伪造的 hash 既不能消费，也不会被说成「过期」
  const forged = "f".repeat(64);
  assert.equal(await consumeOAuthState(forged, AT), null);
  assert.equal(await wasOAuthStateExpired(forged, AT), false);
});

test("state 并发回调：只有一个请求能把 consumed_at 从 NULL 改掉", { skip: SKIP }, async () => {
  await Promise.all(Array.from({ length: 6 }, () => executor().query("SELECT 1")));

  const input = stateInput();
  await createOAuthState(input);

  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => consumeOAuthState(input.stateHash, AT)),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome !== null).length,
    1,
    "同一 state 的重放/并发回调只能成功一次",
  );
});

test("state 唯一索引与回跳地址 CHECK：重复 hash 与协议相对地址都被数据库拒绝", { skip: SKIP }, async () => {
  const input = stateInput();
  await createOAuthState(input);

  await assert.rejects(
    () => createOAuthState({ ...input, id: `st_${randomUUID()}` }),
    (error) => {
      assert.equal(error?.code, "23505");
      assert.equal(error?.constraint, "auth_oauth_states_hash_key");
      return true;
    },
  );

  await assert.rejects(
    () => createOAuthState(stateInput({ redirectTo: "//evil.example.com" })),
    (error) => {
      assert.equal(error?.code, "23514");
      assert.equal(error?.constraint, "auth_oauth_states_redirect_check");
      return true;
    },
  );
});

test("清理只删过期且未消费的 state：有效与已消费的都保留", { skip: SKIP }, async () => {
  const expired = stateInput({ expiresAt: LATER });
  const active = stateInput({ expiresAt: "2026-01-01T00:30:00.000Z" });
  const consumed = stateInput();

  await createOAuthState(expired);
  await createOAuthState(active);
  await createOAuthState(consumed);
  await consumeOAuthState(consumed.stateHash, AT);

  const removed = await deleteExpiredOAuthStates(AFTER_EXPIRY);
  assert.equal(removed, 1, "只有过期且未消费的那一条");

  const remaining = await executor().query(
    `SELECT state_hash FROM auth_oauth_states ORDER BY created_at`,
  );
  assert.deepEqual(
    remaining.map((row) => row.state_hash).sort(),
    [active.stateHash, consumed.stateHash].sort(),
  );
});
