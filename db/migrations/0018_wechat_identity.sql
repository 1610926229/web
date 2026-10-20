-- PROD-5 · 微信身份与 OAuth 一次性 state
--
-- ## 为什么外部身份单独建表
--
-- `users` 是**平台账号**，`external_identities` 是**这个账号如何被证明**。
-- 一个用户将来可以同时绑定微信网页登录与手机号；把 openid 塞进 `users` 列，
-- 会强迫账号表携带每一种登录渠道的标识，而且无法表达「同一个微信主体
-- （unionid）在多个应用（多个 appid）下有不同 openid」。
--
-- ## 两套唯一键，回答两个不同的问题
--
-- - `(provider, app_id, open_id)`：**这个应用里**微信返回的 openid 唯一。
--   openid 是按应用分配的，不同 appid 下同一个人的 openid 不同，因此 app_id
--   必须进键；少了它，两个应用的同名 openid 会被错误地当成同一个人。
-- - `(provider, union_id) WHERE union_id IS NOT NULL`：**同一开放平台主体**下
--   unionid 唯一。有 unionid 时，第二个应用首次登录可以链接到已有账号，
--   而不是再建一个新用户。unionid 可能缺省（部分账号/场景不返回），
--   因此用部分唯一索引，NULL 不参与唯一性。
--
-- `provider` 区分 `wechat`（真实开放平台）与 `mock`（私有 Staging 模拟）。
-- 两者共表但值不同、app_id 不同、openid 前缀不同；Mock 永远不会写进
-- 真实 `wechat` 的那一行。
--
-- ## 为什么不存 access_token / refresh_token
--
-- 本流程只在回调内用 code 换 userinfo，换取结果后立即丢弃 token。
-- 平台不需要调用微信的后续接口，因此不把可冒用的凭据落库。
--
-- ## OAuth state
--
-- state 原文只进 HttpOnly Cookie，数据库只存 SHA-256。一次消费由
-- `consumed_at` 标记；过期或已消费的 state 都不能再次使用。
-- 行保留而不是立刻删除，便于排查「回调重复 / 攻击重放」。
--
-- 纯增量迁移：不改既有表、不搬数据、不删数据。

CREATE TABLE external_identities (
  id              text COLLATE "C" NOT NULL,
  provider        text NOT NULL,
  -- 微信应用 appid；Mock provider 使用固定占位值
  app_id          text COLLATE "C" NOT NULL,
  open_id         text COLLATE "C" NOT NULL,
  -- 开放平台 unionid；微信不保证返回，因此可空
  union_id        text COLLATE "C",
  user_id         text COLLATE "C" NOT NULL,
  -- 首次授权时的昵称/头像快照。用户资料仍以 users 为准，这里只用于排查与重新绑定
  nickname_snapshot text,
  avatar_url_snapshot text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,

  CONSTRAINT external_identities_pkey PRIMARY KEY (id),
  CONSTRAINT external_identities_user_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT external_identities_provider_check
    CHECK (provider IN ('wechat', 'mock')),
  CONSTRAINT external_identities_app_id_length_check
    CHECK (char_length(app_id) BETWEEN 1 AND 128),
  CONSTRAINT external_identities_open_id_length_check
    CHECK (char_length(open_id) BETWEEN 8 AND 128),
  CONSTRAINT external_identities_union_id_length_check
    CHECK (union_id IS NULL OR char_length(union_id) BETWEEN 8 AND 128)
);

-- 同一应用内 openid 只能指向一个平台账号
CREATE UNIQUE INDEX external_identities_provider_app_open_key
  ON external_identities (provider, app_id, open_id);

-- 同一开放平台主体（unionid）只能指向一个平台账号；NULL 不参与。
-- 因此 unionid **只写在第一行**：后续应用链接到同一用户时仍写入自己的
-- openid 行，但 union_id 留空（见 lib/data/pg/wechatRepository.ts）。
CREATE UNIQUE INDEX external_identities_provider_union_key
  ON external_identities (provider, union_id)
  WHERE union_id IS NOT NULL;

-- 按平台账号查已绑定的外部身份
CREATE INDEX external_identities_user_idx
  ON external_identities (user_id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE auth_oauth_states (
  id           text COLLATE "C" NOT NULL,
  provider     text NOT NULL,
  -- 只存 state 的 SHA-256；原文只在 HttpOnly Cookie 里
  state_hash   text COLLATE "C" NOT NULL,
  -- 登录完成后回到哪里。只允许站内路径，由应用层校验
  redirect_to  text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- 非空即表示已消费；并发回调只有一个能把 NULL 改成时间
  consumed_at  timestamptz,

  CONSTRAINT auth_oauth_states_pkey PRIMARY KEY (id),
  CONSTRAINT auth_oauth_states_provider_check
    CHECK (provider IN ('wechat', 'mock')),
  CONSTRAINT auth_oauth_states_hash_check
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_oauth_states_redirect_check
    CHECK (redirect_to LIKE '/%' AND redirect_to NOT LIKE '//%'),
  CONSTRAINT auth_oauth_states_expiry_check
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX auth_oauth_states_hash_key
  ON auth_oauth_states (state_hash);

-- 清理过期未消费的 state 时只扫仍有效的行
CREATE INDEX auth_oauth_states_expiry_idx
  ON auth_oauth_states (expires_at)
  WHERE consumed_at IS NULL;
