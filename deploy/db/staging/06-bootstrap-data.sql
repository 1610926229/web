-- PROD-2 / Step 5.8.2 · Staging 最小测试数据（**仅限 staging**）
--
--     [执行角色] chaoge_staging_app（由身份守卫强制）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--     [执行时机] **迁移完成 + 05 授权之后**
--     [性质] 只插入、不修改、不删除；可重复执行
--
-- ## 这不是 `pnpm db:seed`，也不是它的替代品
--
-- `db:seed` 属于开发/测试工具，`assertSeedAllowed()` 在 `NODE_ENV=production`
-- 下一律拒绝。staging 的运行时是 `NODE_ENV=production`，因此**不能也不应该**
-- 用 `db:seed` 准备数据。这个文件是另一条独立路径：
--
--   · 由 psql 直接执行，不经过应用代码，不读取 `NODE_ENV`；
--   · 不是「关掉守卫」，而是本来就与守卫无关的一份 staging 专用 SQL；
--   · 只有 INSERT ... ON CONFLICT DO NOTHING，没有 UPDATE / DELETE / TRUNCATE；
--   · 数据库名守卫无条件拒绝 chaoge_prod，把 GUC 改成 chaoge_prod 也一样拒绝。
--
-- ## 为什么需要这些数据
--
-- 迁移只建结构、不插数据（`db/migrations` 全文没有 INSERT）。空库的后果很具体：
--
--   · `POST /api/auth/mock-login` 查 `users`，查不到 → 404「Mock 用户不存在」；
--   · 管理端 mock 登录查 `admin_accounts` 的 `admin-1`，查不到 → 500；
--   · 客服端 mock 登录查 `staff_accounts`，查不到 → 403；
--   · 打手工作台走用户登录 + `companions.user_id`，没有护航记录 → 无权限提示。
--
-- 这里放的是**能走通登录与一条写入往返的最小集合**，不是完整业务数据。
-- 订单、结算、优惠券等业务数据应当在 staging 上通过真实界面流程产生。
--
-- ## 为什么用 chaoge_staging_app 执行
--
-- 让这份 SQL 顺便验证 04/05 的授权确实生效：如果应用角色没有 DML 权限，
-- 第一条 INSERT 就会 42501 失败，而不是等到应用上线后才暴露。

DO $guard$
DECLARE
  expected text := coalesce(nullif(current_setting('chaoge.expected_database', true), ''), 'chaoge_staging');
  actual   text := current_database();
BEGIN
  IF actual = 'chaoge_prod' OR expected = 'chaoge_prod' THEN
    RAISE EXCEPTION
      '拒绝执行：这是 staging 数据初始化脚本，永远不会对 chaoge_prod 执行（当前库「%」，期望「%」）。',
      actual, expected
      USING ERRCODE = '42501';
  END IF;
  IF expected !~ '^chaoge_staging' THEN
    RAISE EXCEPTION
      '拒绝执行：staging 脚本只允许作用在 chaoge_staging* 库上（当前期望「%」）。',
      expected
      USING ERRCODE = '42501';
  END IF;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      '拒绝执行：当前连接的是数据库「%」，而脚本期望「%」。',
      actual, expected
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

-- ── 0. 身份与前置守卫 ──────────────────────────────────────────────────────────

DO $preconditions$
BEGIN
  IF current_user IS DISTINCT FROM 'chaoge_staging_app' THEN
    RAISE EXCEPTION
      '拒绝执行：本脚本必须以 chaoge_staging_app 身份运行（当前为「%」）。',
      current_user
      USING ERRCODE = '42501',
            HINT = '超级用户请先执行 SET ROLE chaoge_staging_app; 再运行本脚本。';
  END IF;

  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION
      'schema_migrations 不存在 —— 还没有执行迁移。请先 `pnpm db:migrate` 指向 chaoge_staging。';
  END IF;

  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.admin_accounts') IS NULL
     OR to_regclass('public.staff_accounts') IS NULL
     OR to_regclass('public.companions') IS NULL
     OR to_regclass('public.games') IS NULL
     OR to_regclass('public.categories') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.product_specs') IS NULL THEN
    RAISE EXCEPTION
      '业务表不完整 —— 迁移可能只跑了一部分。请先确认迁移完成、再执行本脚本。';
  END IF;
END
$preconditions$;

-- ── 1. 用户 ────────────────────────────────────────────────────────────────────
--
-- u-1001 是 mock 登录不带 userId 时的默认身份（`userSeed[0]`）；
-- u-1002 是验收脚本 `healthcheck.sh --persistence` 使用的身份。
-- 其余用户按需通过界面/接口产生，不在这里堆预置数据。

INSERT INTO users (id, display_id, nickname, avatar_url, bio) VALUES
  ('u-1001', '3f2a9c14-6b7d-4e58-9c21-8d4f0b7a5e63', '老板A（staging）', '/mock/avatar-1.svg', ''),
  ('u-1002', '9c4e1d78-2a53-47f6-b0c8-5e7d3a91f204', '老板B（staging）', '/mock/avatar-2.svg', 'staging 验收账号')
ON CONFLICT DO NOTHING;

-- ── 2. 管理端账号 ──────────────────────────────────────────────────────────────
--
-- `admin-1` 是 `MOCK_ADMIN_LOGIN_ID`，角色必须是 admin 且 enabled=true。

INSERT INTO admin_accounts (id, username, display_name, role, enabled) VALUES
  ('admin-1', 'mock-admin', '模拟管理员（staging）', 'admin', true)
ON CONFLICT DO NOTHING;

-- ── 3. 客服账号 ────────────────────────────────────────────────────────────────
--
-- `staff-1` 是启用中的客服，用于客服工作台登录与登录选项列表。

INSERT INTO staff_accounts
  (id, username, display_name, avatar_url, role, enabled, created_at, updated_at, last_login_at, removed_at)
VALUES
  ('staff-1', 'kefu-xiaoyu', '客服小雨（staging）', '/mock/avatar-3.svg',
   'customer_service', true, now(), now(), NULL, NULL)
ON CONFLICT DO NOTHING;

-- ── 4. 护航资料 ────────────────────────────────────────────────────────────────
--
-- 打手工作台用的是**用户账号 + 一条有效护航资料**（`companions.user_id`），
-- 不是独立登录体系。把 cp-demo 挂在 u-1001 名下，登录默认用户即可进入工作台。

INSERT INTO companions
  (id, user_id, application_id, removed_at, display_name, avatar_url, rank_label, intro,
   game_ids, regions, service_tags, available, unavailable_reason, enabled,
   completed_order_count, tips_count, sort_order)
VALUES
  ('cp-demo', 'u-1001', NULL, NULL, '护航阿泽（staging）', '/mock/avatar-2.svg',
   '荣耀（staging）', 'staging 专用护航资料，不参与真实业务。',
   '["g-delta"]'::jsonb, '["手游"]'::jsonb, '[]'::jsonb,
   true, '', true, 0, 0, 10)
ON CONFLICT DO NOTHING;

-- ── 5. 目录：一个游戏 / 一个类目 / 一个商品 / 一个规格 ─────────────────────────
--
-- `p-400w` 是验收脚本收藏的商品 id；它的存在让商品详情页也能打开。
-- 价格单位是「分」（2990 = ¥29.90），分账比例是基点（8000 = 80%）。

INSERT INTO games (id, name, regions) VALUES
  ('g-delta', '三角洲行动', '["手游","端游"]'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO categories (id, game_id, name, sort_order, enabled, created_at, updated_at, removed_at) VALUES
  ('c-loss', 'g-delta', '亏本单', 10, true, now(), now(), NULL)
ON CONFLICT DO NOTHING;

INSERT INTO products
  (id, title, subtitle, cover_url, game_id, category_id, tags, detail_text, detail_images,
   sort_order, recommended, status, monthly_sales, game_tag, companion_rate_bp,
   created_at, updated_at, removed_at)
VALUES
  ('p-400w', '机密400万', '机密400万', '/mock/product-cover-1.svg', 'g-delta', 'c-loss',
   '["热门","稳定交付"]'::jsonb, 'staging 专用商品，仅用于打通页面与收藏链路。',
   '["/mock/product-cover-1.svg"]'::jsonb,
   10, true, 'on', 0, '手游', 8000, now(), now(), NULL)
ON CONFLICT DO NOTHING;

INSERT INTO product_specs (id, product_id, name, price, sort_order, enabled, removed_at) VALUES
  ('s-400w', 'p-400w', '机密400万', 2990, 10, true, NULL)
ON CONFLICT DO NOTHING;

-- ── 6. 自检：最小集合确实存在 ──────────────────────────────────────────────────

DO $assert$
DECLARE
  missing text[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'u-1001') THEN
    missing := missing || 'users.u-1001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = 'u-1002') THEN
    missing := missing || 'users.u-1002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM admin_accounts WHERE id = 'admin-1' AND role = 'admin' AND enabled) THEN
    missing := missing || 'admin_accounts.admin-1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_accounts
                  WHERE id = 'staff-1' AND role = 'customer_service' AND enabled AND removed_at IS NULL) THEN
    missing := missing || 'staff_accounts.staff-1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM companions
                  WHERE id = 'cp-demo' AND user_id = 'u-1001' AND enabled AND removed_at IS NULL) THEN
    missing := missing || 'companions.cp-demo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = 'p-400w' AND status = 'on' AND removed_at IS NULL) THEN
    missing := missing || 'products.p-400w';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM product_specs WHERE id = 's-400w' AND product_id = 'p-400w') THEN
    missing := missing || 'product_specs.s-400w';
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'staging 最小数据集不完整：%', array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE '[staging-06] 自检通过：登录所需的用户 / 管理员 / 客服 / 护航资料与最小目录已就位';
END
$assert$;
