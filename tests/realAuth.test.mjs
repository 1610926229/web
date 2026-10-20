import assert from "node:assert/strict";
import test from "node:test";
import {
  consumePasswordCheckTime,
  EMAIL_MAX_LENGTH,
  hashPassword,
  isValidEmail,
  isValidPassword,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "../lib/auth/password.ts";
import {
  createSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  SESSION_TTL_SECONDS,
} from "../lib/auth/sessionToken.ts";

/**
 * PROD-4 · 真实认证的**纯逻辑**用例——不需要数据库，因此在 `pnpm test` 里永远会跑。
 *
 * 这一组只证明两件事：
 *
 * 1. **密码永远不会以明文/可逆形式落地**：哈希串自带参数、盐每次不同、
 *    错误密码与损坏哈希都返回 `false` 而不是抛错（登录接口不能靠异常区分结局）。
 * 2. **会话令牌是随机的不透明串**：数据库只存 SHA-256，明文只在 Cookie 里出现一次；
 *    令牌形状校验挡在没有查询数据库之前。
 *
 * 数据库层的行为（唯一索引、事务回滚、会话吊销）不在这里——见 `pgAuth.test.mjs`。
 */

// ————————————————————————— 邮箱 —————————————————————————

test("邮箱规范化只做去空白 + 小写：注册、登录、唯一索引共用同一个结果", () => {
  assert.equal(normalizeEmail("  User@Example.COM \n"), "user@example.com");
  assert.equal(normalizeEmail("USER@EXAMPLE.COM"), "user@example.com");
  // 已经是规范形式的值必须是不动点——否则「规范化两次」与「规范化一次」会分叉
  assert.equal(normalizeEmail(normalizeEmail("  A@B.CO  ")), "a@b.co");
});

test("邮箱形状校验：接受常见形式，拒绝空串、空格、缺 @ 或缺域名后缀", () => {
  for (const email of ["a@b.co", "user.name+tag@example.com", "用户@例子.中国"]) {
    assert.equal(isValidEmail(email), true, `${email} 应当被接受`);
  }

  for (const email of ["", "a", "a@b", "a b@c.com", "a@b .com", "a@@b.com", "a@.com", "a@b."]) {
    assert.equal(isValidEmail(email), false, `${email} 不该被接受`);
  }
});

test("邮箱长度上限与常量一致：254 接受、255 拒绝", () => {
  const domain = "@example.com"; // 12 字符
  const atLimit = `${"a".repeat(EMAIL_MAX_LENGTH - domain.length)}${domain}`;
  const overLimit = `a${atLimit}`;

  assert.equal(atLimit.length, EMAIL_MAX_LENGTH);
  assert.equal(isValidEmail(atLimit), true);
  assert.equal(isValidEmail(overLimit), false);
});

// ————————————————————————— 密码长度 —————————————————————————

test("密码长度边界：7 拒绝、8 接受、128 接受、129 拒绝", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  assert.equal(PASSWORD_MAX_LENGTH, 128);

  assert.equal(isValidPassword("a".repeat(7)), false);
  assert.equal(isValidPassword("a".repeat(8)), true);
  assert.equal(isValidPassword("a".repeat(128)), true);
  assert.equal(isValidPassword("a".repeat(129)), false);
  assert.equal(isValidPassword(""), false);
});

// ————————————————————————— 密码哈希 —————————————————————————

test("哈希串格式固定且自带参数：scrypt$N$r$p$salt$hash", async () => {
  const stored = await hashPassword("correct horse battery staple");
  const parts = stored.split("$");

  assert.equal(parts.length, 6, "解析器按 6 段切分，多一段少一段都会被判为损坏");
  assert.equal(parts[0], "scrypt");
  assert.equal(parts[1], "16384", "N");
  assert.equal(parts[2], "8", "r");
  assert.equal(parts[3], "1", "p");

  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  assert.equal(salt.length, 16, "盐必须是 16 字节随机值");
  assert.equal(key.length, 64, "派生密钥必须是 64 字节");

  // 明文绝不能出现在哈希串里——这条比「验证能过」更直接
  assert.equal(stored.includes("correct horse"), false);
});

test("同一个密码两次哈希得到不同结果：盐每次随机", async () => {
  const first = await hashPassword("same-password");
  const second = await hashPassword("same-password");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same-password", first), true);
  assert.equal(await verifyPassword("same-password", second), true);
});

test("verifyPassword：正确密码为真，错误密码为假，且不抛错", async () => {
  const stored = await hashPassword("right-password");

  assert.equal(await verifyPassword("right-password", stored), true);
  assert.equal(await verifyPassword("wrong-password", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  // 大小写不同也是不同的密码，不做任何“宽松”比较
  assert.equal(await verifyPassword("Right-Password", stored), false);
});

test("verifyPassword：损坏或越界的哈希一律返回 false，不把异常漏给登录接口", async () => {
  const valid = await hashPassword("whatever-password");
  const parts = valid.split("$");

  const corrupted = [
    "",
    "not-a-hash",
    "bcrypt$16384$8$1$c2FsdA$aGFzaA", // 算法不对
    parts.slice(0, 5).join("$"), // 少一段
    `${valid}$extra`, // 多一段
    `scrypt$1000$8$1$${parts[4]}$${parts[5]}`, // N 不是 2 的幂
    `scrypt$512$8$1$${parts[4]}$${parts[5]}`, // N 低于下限
    `scrypt$16384$0$1$${parts[4]}$${parts[5]}`, // r 越界
    `scrypt$16384$8$99$${parts[4]}$${parts[5]}`, // p 越界
    `scrypt$abc$8$1$${parts[4]}$${parts[5]}`, // N 不是整数
    `scrypt$16384$8$1$${parts[4]}$`, // 空哈希
  ];

  for (const stored of corrupted) {
    assert.equal(await verifyPassword("whatever-password", stored), false, `坏哈希不该通过：${stored}`);
  }
});

test("未知账号也跑一次同成本的派生：consumePasswordCheckTime 成功返回且不产生可用于登录的结果", async () => {
  // 这条用例不测时间差（在 CI 上必然抖动），只锁定「调用方可以安全地 await 它」：
  // 它不抛错、不返回真值，登录流程因此不会因为账号不存在而走进另一条分支。
  const result = await consumePasswordCheckTime("some-password");
  assert.equal(result, undefined);
});

// ————————————————————————— 会话令牌 —————————————————————————

test("令牌摘要固定为 64 位十六进制 SHA-256：同一输入同结果，不同输入不同结果", () => {
  const a = hashSessionToken("token-a");
  const b = hashSessionToken("token-b");

  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(hashSessionToken("token-a"), a, "摘要必须是确定性的，否则数据库查不到会话");
  assert.notEqual(a, b);
  // 摘要里不能有原文
  assert.equal(a.includes("token-a"), false);
});

test("createSessionToken：随机、不透明、带摘要，7 天后过期", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const session = createSessionToken(now);

  assert.equal(session.createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(
    Date.parse(session.expiresAt) - Date.parse(session.createdAt),
    SESSION_TTL_SECONDS * 1000,
  );
  assert.equal(Date.parse(session.expiresAt), Date.parse(session.createdAt) + 7 * 24 * 60 * 60 * 1000);

  // 32 字节 base64url = 43 个字符；令牌里不该有任何账号信息
  assert.equal(session.token.length, 43);
  assert.match(session.id, /^sess_[0-9a-f-]{36}$/);
  assert.equal(session.tokenHash, hashSessionToken(session.token));
  assert.match(session.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(isPlausibleSessionToken(session.token), true);

  // 两次生成必须不同：相同令牌会让两个账号共用一个会话
  assert.notEqual(createSessionToken(now).token, session.token);
  assert.notEqual(createSessionToken(now).id, session.id);
});

test("isPlausibleSessionToken：只放过 40–64 位的 base64url 形状", () => {
  assert.equal(isPlausibleSessionToken("a".repeat(40)), true);
  assert.equal(isPlausibleSessionToken("a".repeat(64)), true);
  assert.equal(isPlausibleSessionToken("a".repeat(39)), false);
  assert.equal(isPlausibleSessionToken("a".repeat(65)), false);
  assert.equal(isPlausibleSessionToken(""), false);
  assert.equal(isPlausibleSessionToken(`${"a".repeat(42)}.`), false, "点不是 base64url 字符");
  assert.equal(isPlausibleSessionToken(`${"a".repeat(42)} `), false);
  assert.equal(isPlausibleSessionToken(`${"a".repeat(42)}中文`), false);
});

// ————————————————————————— 服务端边界 —————————————————————————

test("密码模块不依赖 Next 请求上下文，也不被任何客户端组件引用", async () => {
  const { readFile } = await import("node:fs/promises");

  // `password.ts` 依赖 node:crypto。它一旦被 "use client" 组件 import，
  // 构建要么失败，要么把做不到的事留到运行时——这条静态门禁把问题提前。
  const source = await readFile("lib/auth/password.ts", "utf8");
  assert.doesNotMatch(source, /next\/headers|next\/server/, "密码模块不该依赖请求上下文");

  const { execFileSync } = await import("node:child_process");
  // 用 git ls-files 限定在受版本控制的文件里，避免扫到 node_modules / .next
  const listed = execFileSync("git", ["ls-files", "app", "components", "lib"], {
    encoding: "utf8",
  });

  for (const file of listed.split("\n")) {
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
    const content = await readFile(file, "utf8");
    if (!content.startsWith('"use client"') && !content.startsWith("'use client'")) continue;
    assert.equal(
      /lib\/auth\/(password|sessionToken)|@\/lib\/auth\/(password|sessionToken)/.test(content),
      false,
      `${file} 是客户端组件，不能引用仅服务端的密码/令牌模块`,
    );
  }
});
