-- PROD-2 · Staging 首页演示数据（**仅限 staging**）
--
--     [执行角色] chaoge_staging_app（由身份守卫强制）
--     [目标数据库] chaoge_staging（由库名守卫强制）
--     [执行时机] 迁移 + 05 授权（通常还有 06 最小数据）之后，由运维显式触发
--     [性质] 只插入、不修改、不删除；可重复执行
--
-- ## 它为什么是独立的一份，而不是并进 06
--
-- `06-bootstrap-data.sql` 是**最小可运行集合**：登录身份 + 一条商品，用来证明
-- 迁移、授权、应用链路可用。它的体积和内容应当保持最小，任何一次正式部署都会
-- 重复执行它。
--
-- 本文件是**演示内容**：首页公告 / 活动 Banner / 快捷入口 / 类目 / 首页两组商品。
-- 它只在需要把 staging 首页对齐到本地 Mock 演示效果时显式执行：
--
--     sudo -n /usr/local/sbin/chaoge-deploy demo-data
--
-- 正式 `deploy` 不会调用它，因此演示数据不会被永久混进最小初始化流程。
--
-- ## 幂等与「不覆盖管理员修改」
--
--   · 全部写入都是 `INSERT ... ON CONFLICT DO NOTHING`；
--   · 没有任何 UPDATE / DELETE / TRUNCATE / DDL；
--   · 已存在的记录（包括管理员改过标题、价格、上下架状态的记录）原样保留；
--   · 重复执行不会产生重复行，也不会把管理员的操作改回去。
--
-- 因此，若某条演示记录已在后台被停用或改写，本脚本**不会**把它恢复；
-- 这是有意的：staging 上人工操作优先于演示种子。
--
-- ## 与 06 的关系
--
-- 06 已经写入的 `g-delta` / `c-loss` / `p-400w` / `s-400w` 在这里再次出现时
-- 会被 `ON CONFLICT DO NOTHING` 跳过。`p-400w` 因此保留 06 写入的 staging 专用
-- 说明与月售 0——首页卡片不展示这两个字段，展示内容（标题 / 副标题 / 封面 /
-- 规格价）与本地 Mock 一致。需要完全一致的 API 字段时，应由管理员在后台修改，
-- 而不是让脚本覆盖人工数据。

DO $guard$
DECLARE
  expected text := coalesce(nullif(current_setting('chaoge.expected_database', true), ''), 'chaoge_staging');
  actual   text := current_database();
BEGIN
  IF actual = 'chaoge_prod' OR expected = 'chaoge_prod' THEN
    RAISE EXCEPTION
      '拒绝执行：这是 staging 演示数据脚本，永远不会对 chaoge_prod 执行（当前库「%」，期望「%」）。',
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

  IF to_regclass('public.games') IS NULL
     OR to_regclass('public.categories') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.product_specs') IS NULL
     OR to_regclass('public.announcements') IS NULL
     OR to_regclass('public.banners') IS NULL
     OR to_regclass('public.quick_entries') IS NULL THEN
    RAISE EXCEPTION
      '业务表不完整 —— 迁移可能只跑了一部分。请先确认迁移完成、再执行本脚本。';
  END IF;
END
$preconditions$;

-- ── 1. 目录：首页两组商品所需的游戏与类目 ─────────────────────────────────────
--
-- 数据取自 `lib/mocks/fixtures/catalogSeed.ts` 的 `gameSeed` / `categorySeed`。
-- `sort_order` 保持与 Mock 一致（步长 10），同一游戏内先亏本单、后开业特惠。

INSERT INTO games (id, name, regions) VALUES
  ('g-delta', '三角洲行动', '["手游","端游"]'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO categories (id, game_id, name, sort_order, enabled, created_at, updated_at, removed_at) VALUES
  ('c-loss',    'g-delta', '亏本单',   10, true, now(), now(), NULL),
  ('c-opening', 'g-delta', '开业特惠', 20, true, now(), now(), NULL)
ON CONFLICT DO NOTHING;

-- ── 2. 首页运营内容：2 条公告 / 1 条 Banner / 4 个快捷入口 ────────────────────
--
-- 数据取自 `lib/mocks/fixtures/contentSeed.ts`；图片是 `public/mock` 下的本地
-- 占位图，随应用产物一起发布。时间戳使用种子里的固定值，便于后台一眼认出。

INSERT INTO announcements
  (id, title, image_url, alt, enabled, sort_order, created_at, updated_at, removed_at)
VALUES
  ('a1', '首页公告位 - 开工活动',     '/mock/announcement-1.svg', '公告图片占位 1', true, 10,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL),
  ('a2', '首页公告位 - 服务时间说明', '/mock/announcement-2.svg', '公告图片占位 2', true, 20,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO banners
  (id, title, image_url, alt, enabled, sort_order, created_at, updated_at, removed_at)
VALUES
  ('b1', '首页活动位 - 新客首单', '/mock/promo-activity.svg', '活动图片占位', true, 10,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO quick_entries
  (id, label, icon, path, enabled, sort_order, created_at, updated_at, removed_at)
VALUES
  ('service',   '联系客服',     'service',   '/service',                          true, 10,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL),
  ('benefits',  '点单权益',     'benefits',  '/placeholder?title=点单权益',       true, 20,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL),
  ('join',      '考核入驻',     'join',      '/join',                             true, 30,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL),
  ('complaint', '投诉客服专区', 'complaint', '/complaints',                       true, 40,
   '2026-01-06T09:00:00.000Z', '2026-01-06T09:00:00.000Z', NULL)
ON CONFLICT DO NOTHING;

-- ── 3. 首页 8 个商品 ──────────────────────────────────────────────────────────
--
-- 数据取自 `catalogSeed.ts` 的 `PRODUCT_SEEDS`，商品 id 与 `homeSectionSeed` 一致：
--
--   亏本单     p-400w / p-200w / p-jm200w / p-sh300w
--   开业特惠   p-600w / p-500w / p-800w / p-1000w
--
-- `sort_order` 沿用种子在整个商品数组里的下标 × 10（因此有间隔，但不影响首页
-- 分组顺序——首页分组顺序由 `homeSectionSeed` 的 id 列表决定）。
-- `companion_rate_bp` 为 8000（80%），与 `DEFAULT_COMPANION_RATE_BP` 一致。
-- `detail_images` 缺省为「封面 + 活动图」，与 `buildProducts()` 的默认值一致。

INSERT INTO products
  (id, title, subtitle, cover_url, game_id, category_id, tags, detail_text, detail_images,
   sort_order, recommended, status, monthly_sales, game_tag, companion_rate_bp,
   created_at, updated_at, removed_at)
VALUES
  ('p-400w', '机密400万', '机密400万', '/mock/product-cover-1.svg', 'g-delta', 'c-loss',
   '["热门","稳定交付"]'::jsonb,
   '机密行动打包完成，全程不换人；掉线重连的时间也算在服务里。下单后可在大区备注里写清时间段。',
   '["/mock/product-cover-1.svg","/mock/promo-activity.svg"]'::jsonb,
   10, true, 'on', 10029, '手游', 8000, now(), now(), NULL),

  ('p-200w', '机密200万', '机密200万！', '/mock/product-cover-2.svg', 'g-delta', 'c-loss',
   '["热门"]'::jsonb,
   '入门档机密单，适合先试一次节奏。单人档与双人档价格不同，按需选择。',
   '["/mock/product-cover-2.svg","/mock/promo-activity.svg"]'::jsonb,
   20, false, 'on', 8231, '手游', 8000, now(), now(), NULL),

  ('p-jm200w', '绝密200万（只打巴克）', '绝密200万 · 只打巴克', '/mock/product-cover-3.svg', 'g-delta', 'c-loss',
   '["只打巴克什"]'::jsonb,
   '只在巴克什地图完成，不接其它地图。绝密档位越高掉段风险越大，请自行评估。',
   '["/mock/product-cover-3.svg","/mock/promo-activity.svg"]'::jsonb,
   30, false, 'on', 5602, '手游', 8000, now(), now(), NULL),

  ('p-sh300w', '双护300万（只打巴克）', '双护300万 · 只打巴克', '/mock/product-cover-4.svg', 'g-delta', 'c-loss',
   '["双人护航"]'::jsonb,
   '双护航同时进场，适合需要稳定推进的老板。同样只接巴克什地图。',
   '["/mock/product-cover-4.svg","/mock/promo-activity.svg"]'::jsonb,
   40, false, 'on', 3418, '手游', 8000, now(), now(), NULL),

  ('p-600w', '机密600万', '机密600万', '/mock/product-cover-4.svg', 'g-delta', 'c-opening',
   '["开业特惠"]'::jsonb,
   '开业档位，档期集中在下午到凌晨；具体时间可以在下单后与护航确认。',
   '["/mock/product-cover-4.svg","/mock/promo-activity.svg"]'::jsonb,
   80, true, 'on', 2764, '手游', 8000, now(), now(), NULL),

  ('p-500w', '绝密500万', '绝密500万', '/mock/product-cover-1.svg', 'g-delta', 'c-opening',
   '[]'::jsonb,
   '绝密档位对局时间较长，建议预留完整的一个晚上。',
   '["/mock/product-cover-1.svg","/mock/promo-activity.svg"]'::jsonb,
   90, false, 'on', 1893, '手游', 8000, now(), now(), NULL),

  ('p-800w', '双护800万', '双护800万', '/mock/product-cover-2.svg', 'g-delta', 'c-opening',
   '["双人护航"]'::jsonb,
   '双护航档位，两位护航同时在线，适合需要快速推进的大额单。',
   '["/mock/product-cover-2.svg","/mock/promo-activity.svg"]'::jsonb,
   100, false, 'on', 1102, '手游', 8000, now(), now(), NULL),

  ('p-1000w', '带打1000万', '带打1000万', '/mock/product-cover-3.svg', 'g-delta', 'c-opening',
   '[]'::jsonb,
   '带打档位，护航全程带节奏，适合想同时学思路的老板。',
   '["/mock/product-cover-3.svg","/mock/promo-activity.svg"]'::jsonb,
   110, false, 'on', 866, '手游', 8000, now(), now(), NULL)
ON CONFLICT DO NOTHING;

-- ── 4. 商品规格 ────────────────────────────────────────────────────────────────
--
-- 与 `PRODUCT_SEEDS[].specs` 一一对应；`sort_order` 是组内下标 × 10。
-- 价格单位是「分」（2990 = ¥29.90）。

INSERT INTO product_specs (id, product_id, name, price, sort_order, enabled, removed_at) VALUES
  ('s-400w',    'p-400w',   '机密400万',                 2990, 10, true, NULL),
  ('s-400w-2',  'p-400w',   '机密400万 · 双人',          3990, 20, true, NULL),
  ('s-400w-3',  'p-400w',   '机密400万 · 三小时速通',    4590, 30, true, NULL),
  ('s-200w',    'p-200w',   '机密200万',                 1990, 10, true, NULL),
  ('s-200w-2',  'p-200w',   '机密200万 · 双人',          2590, 20, true, NULL),
  ('s-jm200w',  'p-jm200w', '绝密200万',                 1990, 10, true, NULL),
  ('s-jm300w',  'p-jm200w', '绝密300万',                 2990, 20, true, NULL),
  ('s-sh300w',  'p-sh300w', '双护300万',                 2990, 10, true, NULL),
  ('s-sh500w',  'p-sh300w', '双护500万',                 4590, 20, true, NULL),
  ('s-600w',    'p-600w',   '机密600万',                 3990, 10, true, NULL),
  ('s-600w-2',  'p-600w',   '机密600万 · 双人',          5190, 20, true, NULL),
  ('s-500w',    'p-500w',   '绝密500万',                 4990, 10, true, NULL),
  ('s-800w',    'p-800w',   '双护800万',                 5990, 10, true, NULL),
  ('s-1000w',   'p-1000w',  '带打1000万',                6990, 10, true, NULL)
ON CONFLICT DO NOTHING;

-- ── 5. 自检：演示集合确实存在（只看存在性，不看启停/移除状态） ────────────────
--
-- 管理员可能已把某条记录停用或移除；那不是本脚本的错误，也不应让它回滚。
-- 这里只确认「记录在库里」，避免把「表没迁移 / 权限没给」误当成「已被管理员改过」。

DO $assert$
DECLARE
  missing text[] := '{}';
  target  text;
BEGIN
  FOREACH target IN ARRAY ARRAY['a1', 'a2'] LOOP
    IF NOT EXISTS (SELECT 1 FROM announcements WHERE id = target) THEN
      missing := missing || ('announcements.' || target);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM banners WHERE id = 'b1') THEN
    missing := missing || 'banners.b1';
  END IF;
  FOREACH target IN ARRAY ARRAY['service', 'benefits', 'join', 'complaint'] LOOP
    IF NOT EXISTS (SELECT 1 FROM quick_entries WHERE id = target) THEN
      missing := missing || ('quick_entries.' || target);
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY['c-loss', 'c-opening'] LOOP
    IF NOT EXISTS (SELECT 1 FROM categories WHERE id = target) THEN
      missing := missing || ('categories.' || target);
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'p-400w', 'p-200w', 'p-jm200w', 'p-sh300w',
    'p-600w', 'p-500w', 'p-800w', 'p-1000w'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = target) THEN
      missing := missing || ('products.' || target);
    END IF;
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    's-400w', 's-400w-2', 's-400w-3', 's-200w', 's-200w-2',
    's-jm200w', 's-jm300w', 's-sh300w', 's-sh500w',
    's-600w', 's-600w-2', 's-500w', 's-800w', 's-1000w'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM product_specs WHERE id = target) THEN
      missing := missing || ('product_specs.' || target);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'staging 首页演示数据集不完整：%', array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE '[staging-07] 自检通过：2 条公告 / 1 条 Banner / 4 个快捷入口 / 2 个类目 / 8 个商品 / 14 个规格已就位';
END
$assert$;
