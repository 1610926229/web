-- PROD-4 · 真实账号：邮箱密码凭据、客服/管理员凭据、服务端会话
--
-- ## 为什么凭据单独建表，而不是给 users / staff_accounts / admin_accounts 加列
--
-- 1. **账号实体不携带秘密**：`UserRecord` / `StaffAccount` / `AdminAccount` 是会被
--    服务层、DTO 转换函数、测试夹具广泛读取的实体。把 `password_hash` 加进去，
--    就等于让每一个碰过实体的人都有机会把它带进响应或日志；单独一张表之后，
--    只有认证代码能读到哈希。
-- 2. **三种身份的密码策略可以各自演进**：用户走邮箱，客服/管理员走登录名，
--    将来客服接入统一身份源时只换 `staff_credentials`。
-- 3. **迁移是纯增量的**：既有 40 张表一列不改，旧代码在回滚后照常运行。
--
-- ## 会话为什么不是三张表
--
-- 三个身份共用一张 `auth_sessions`，靠 `subject_kind` 区分。会话令牌本身不携带
-- 任何身份信息（数据库里只有 SHA-256），读取时按 subject 去各自的账号仓储复核
-- `enabled` / 角色。**没有**「用 A 类会话换 B 类身份」的代码路径：
-- `subject_kind` 是读取时写死的期望值（用户端只接受 `user`，客服端只接受 `staff`）。
--
-- ⚠️ 不建外键：`subject_id` 指向三张不同的表。删除账号时不会级联删会话，
-- 但读取会话之后每一步都会重新查账号；账号不存在时身份当场消失。
--
-- ## 密码格式
--
-- `scrypt$N$r$p$salt(base64url)$hash(base64url)`，由 `lib/auth/password.ts` 生成。
-- 数据库层只做形状校验，不解析参数——参数属于应用层，改成本参数时不需要迁移。

CREATE TABLE user_credentials (
  user_id          text COLLATE "C" NOT NULL,
  email            text NOT NULL,
  email_normalized text COLLATE "C" NOT NULL,
  password_hash    text NOT NULL,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,

  CONSTRAINT user_credentials_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_credentials_user_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  -- 归一化值必须真的是「小写 + 去首尾空白」的结果：
  -- 两处规则不一致时，唯一索引保护的就不是同一个键
  CONSTRAINT user_credentials_email_normalized_check
    CHECK (email_normalized = lower(btrim(email_normalized))),
  CONSTRAINT user_credentials_email_normalized_length_check
    CHECK (char_length(email_normalized) BETWEEN 3 AND 254),
  CONSTRAINT user_credentials_password_hash_check
    CHECK (password_hash LIKE 'scrypt$%')
);

-- 一个邮箱只能注册一次。用归一化列而不是 lower(email) 表达式索引：
-- 表达式索引要求每个查询都写出同一个表达式，任何一处拼错都会静默绕过唯一性
CREATE UNIQUE INDEX user_credentials_email_key
  ON user_credentials (email_normalized);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE staff_credentials (
  staff_id      text COLLATE "C" NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,

  CONSTRAINT staff_credentials_pkey PRIMARY KEY (staff_id),
  CONSTRAINT staff_credentials_staff_fkey
    FOREIGN KEY (staff_id) REFERENCES staff_accounts (id) ON DELETE CASCADE,
  CONSTRAINT staff_credentials_password_hash_check
    CHECK (password_hash LIKE 'scrypt$%')
);

CREATE TABLE admin_credentials (
  admin_id      text COLLATE "C" NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,

  CONSTRAINT admin_credentials_pkey PRIMARY KEY (admin_id),
  CONSTRAINT admin_credentials_admin_fkey
    FOREIGN KEY (admin_id) REFERENCES admin_accounts (id) ON DELETE CASCADE,
  CONSTRAINT admin_credentials_password_hash_check
    CHECK (password_hash LIKE 'scrypt$%')
);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE auth_sessions (
  id           text COLLATE "C" NOT NULL,
  subject_kind text NOT NULL,
  subject_id   text COLLATE "C" NOT NULL,
  -- 只存令牌的 SHA-256；明文令牌只在 HttpOnly Cookie 里出现一次
  token_hash   text COLLATE "C" NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz,

  CONSTRAINT auth_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT auth_sessions_subject_kind_check
    CHECK (subject_kind IN ('user', 'staff', 'admin')),
  CONSTRAINT auth_sessions_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX auth_sessions_token_hash_key
  ON auth_sessions (token_hash);

-- 按账号吊销全部会话（改密码 / 停用账号）
CREATE INDEX auth_sessions_subject_idx
  ON auth_sessions (subject_kind, subject_id);

-- 清理过期会话时只扫仍然有效的行
CREATE INDEX auth_sessions_expiry_idx
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;
