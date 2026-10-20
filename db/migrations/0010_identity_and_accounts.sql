-- PROD-1E · Wave A 1/7：用户与两类后台账号
--
-- ## 为什么这三张表在一起
--
-- 它们是全库**被引用最多、却最后才落库**的三张表。`orders.user_id`、`companions.user_id`、
-- `refund_requests.user_id`、`complaints.user_id`、`coupon_claims.user_id`、
-- `notifications`、`favorites`、`suggestions` 里全都存着用户 id 的**文本**——
-- 那是 PROD-1B 定下的临时纪律（`0003_companions.sql:25` 原文：「闭包外引用：`users` 本轮不迁，
-- 以稳定 ID 文本存储、暂不建 FK」）。本轮把 `users` 迁过来之后，那条注释的前提就不成立了。
--
-- ## 本轮**不**回头给 0003–0009 补 FK
--
-- 「前提不成立」不等于「顺手补上」。给既有表加 FK 需要 `ALTER TABLE`，而它与
-- **已经写进去的预置数据**是否自洽完全无关——真正决定成败的是那些行的值。
-- 补 FK 是一次独立的、需要逐表验证的历史数据体检，与本轮「把剩余 Mock 迁到 Pg」是两件事。
-- 因此这里只把**新表自己的 FK** 建好（`0011`–`0016` 内部），
-- 旧表回补 FK 登记为**已登记、未执行**项，写进 `03-delivery.md`。
--
-- ## 时间列
--
-- `users` **没有时间列**——Mock 的 `UserRecord`（`lib/data/userRepository.ts:22`）就没有，
-- 本轮不加：凭空多一个「注册时间」列，等于在库里放一个**没有人写、也没有人读**的字段，
-- 它唯一的作用是让下一个人以为它有意义。账号两张表有 `created_at` / `updated_at`，
-- 因为 Mock 实体里就有。

CREATE TABLE users (
  id          text COLLATE "C" NOT NULL,
  -- 平台展示 ID（原型里的「ID: xxxx」），**不是**微信标识。
  -- ⚠️ 不建 UNIQUE：Mock 的 store 只以 `id` 为 Map 键（`mockUserRepository.ts`），
  --    `displayId` 的唯一性是**预置数据的事实**，不是代码强制的不变式。
  --    把一条代码不保证的约束写进库里，会让一次合法的写入在数据库层被拒——
  --    而那正是「从命名反推 schema」最典型的翻车方式。
  display_id  text NOT NULL,
  nickname    text NOT NULL,
  avatar_url  text NOT NULL,
  -- 可为**空串**，不是 NULL：Mock 里 `bio` 的「没有」就是空串。
  bio         text NOT NULL,

  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE admin_accounts (
  id            text COLLATE "C" NOT NULL,
  -- 登录名。大小写不敏感唯一由**部分唯一索引**保证（见下），不在列上写 UNIQUE。
  username      text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL,
  enabled       boolean NOT NULL,
  last_login_at timestamptz,

  CONSTRAINT admin_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT admin_accounts_role_check
    CHECK (role IN ('admin', 'customer_service', 'companion'))
);

-- ⚠️ 与 `staff_accounts` 的判重口径**一致**：都是 `lower(trim(username))`。
--    `btrim` 与 `lower` 都是 IMMUTABLE，因此可以进索引表达式。
CREATE UNIQUE INDEX admin_accounts_username_key
  ON admin_accounts (lower(btrim(username)));

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE staff_accounts (
  id            text COLLATE "C" NOT NULL,
  username      text NOT NULL,
  display_name  text NOT NULL,
  avatar_url    text NOT NULL,
  role          text NOT NULL,
  enabled       boolean NOT NULL,

  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  last_login_at timestamptz,
  -- ⚠️ 软删除。**移除不是删除记录**：既有审计（`admin_audit_entries.target_id`）
  --    与历史操作注释都要继续指得到它。
  removed_at    timestamptz,

  CONSTRAINT staff_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT staff_accounts_role_check
    CHECK (role IN ('customer_service', 'companion')),
  -- 「移除」必然同时停用：`adminStaffTransaction.removeStaffAccount` 就是这么写的。
  -- 反过来不成立——停用的账号不一定被移除，因此不写成等值。
  CONSTRAINT staff_accounts_removed_is_disabled
    CHECK (removed_at IS NULL OR enabled = false)
);

-- ⚠️ 登录名唯一性**不排除已移除的账号**。
--    Mock 的 `findStaffWithUsername`（`mockStaffRepository.ts:53`）遍历的是**整张 Map**，
--    没有 `removedAt IS NULL` 这一条——因此「移除掉 cs-3 之后再用同名建一个新账号」
--    在 Mock 里就会被判为 `username-taken`。索引必须与它逐字同口径，
--    否则两个存储在「这个登录名能不能用」上会给出不同的答案。
CREATE UNIQUE INDEX staff_accounts_username_key
  ON staff_accounts (lower(btrim(username)));
