-- PROD-1E · Wave A 2/7：商品目录 —— 游戏 / 类目 / 商品 / 规格
--
-- ## 规格为什么**独立成表**，而 Mock 里它内嵌在商品上
--
-- `CatalogProductRecord.specs` 在 Mock 里是商品对象上的一个数组
-- （`lib/types/product.ts:145`），整个商品的编辑是「整份替换 specs」。
-- 落库时有两条路：
--
-- | 做法 | 代价 |
-- |---|---|
-- | `products.specs jsonb` | 与 Mock 形状最接近，但「按 specId 查这一单买的是哪个规格」只能全表扫 jsonb |
-- | `product_specs` 独立表 | 多一处 join，但 `specId` 是**稳定身份**、被订单快照引用（`order.ts` 的 `specId`） |
--
-- 选独立表：`specId` 是会被**跨表引用**的身份，不是一段随商品整份重写的文本。
-- 每次编辑商品时规格的写法（整份替换）不变——仓储层在一次事务里 delete+insert，
-- 外部契约一个字不动（`03-delivery.md` 记录了这条映射）。
--
-- ## 金额
--
-- `product_specs.price` 是**唯一的商品价格真值**，单位整数「分」（§C9），必须 > 0。
-- `products` 上**没有 price 列**：展示价是「有效规格里的最低价」这个**派生**值
-- （`productDisplayPrice`），派生值不进库——否则改一个规格的价格就要同步改商品行，
-- 而两者一旦不同步，页面上的价与结算时的价会分叉。

CREATE TABLE games (
  id       text COLLATE "C" NOT NULL,
  name     text NOT NULL,
  -- 大区 / 平台列表。纯值数组，没有被按元素筛选的查询，拆表只会多一张没有独立生命周期的表。
  regions  jsonb NOT NULL,

  CONSTRAINT games_pkey PRIMARY KEY (id)
);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE categories (
  id          text COLLATE "C" NOT NULL,
  game_id     text NOT NULL,
  name        text NOT NULL,

  sort_order  integer NOT NULL,
  enabled     boolean NOT NULL,

  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz,

  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_game_fkey FOREIGN KEY (game_id) REFERENCES games (id)
);

-- ⚠️ 「同一游戏内未移除的类目不可重名」是**部分唯一索引**。
--    判据来自 `adminCatalogTransaction.ts:194 hasDuplicateCategoryName`：
--    只比未移除的记录、去首尾空格后完全相同（**不做**大小写或全半角折叠）。
--    移除掉的类目不再占名字，因此 `WHERE removed_at IS NULL`，
--    否则「移除旧类目、再用同名建一个」会被自己的历史挡住。
CREATE UNIQUE INDEX categories_game_active_name_key
  ON categories (game_id, btrim(name))
  WHERE removed_at IS NULL;

-- 类目列表：同游戏内按 `sortOrder` 升序、`id` 升序兜底（`compareCategoriesForList`）。
CREATE INDEX categories_listed_order_idx
  ON categories (game_id, sort_order, id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE products (
  id                 text COLLATE "C" NOT NULL,
  title              text NOT NULL,
  subtitle           text NOT NULL,
  cover_url          text NOT NULL,
  game_id            text NOT NULL,
  -- ⚠️ 可空：`null` = 不进任何类目列表（调试直链用的商品）。
  --    这不是缺数据，是 Mock 里明文允许的状态（`product.ts:145`）。
  category_id        text,

  tags               jsonb NOT NULL,
  detail_text        text NOT NULL,
  detail_images      jsonb NOT NULL,

  sort_order         integer NOT NULL,
  recommended        boolean NOT NULL,
  status             text NOT NULL,
  monthly_sales      integer NOT NULL,
  game_tag           text NOT NULL,
  -- 分账比例，整数**基点**（8000 = 80%）。不是金额，不参与金额计算。
  companion_rate_bp  integer NOT NULL,

  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  -- ⚠️ 软删除：移除不是物理删——历史订单/收藏/评价都存着 `productId` 快照。
  removed_at         timestamptz,

  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_status_check CHECK (status IN ('on', 'off')),
  CONSTRAINT products_game_fkey FOREIGN KEY (game_id) REFERENCES games (id),
  CONSTRAINT products_category_fkey FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT products_rate_bp_range CHECK (companion_rate_bp BETWEEN 0 AND 10000)
);

-- ⚠️ **没有「同一游戏内商品不可重名」**：Mock 里商品只有关键词搜索，没有任何
--    重名判定（与类目不同）。加一条代码不保证的 UNIQUE，就是凭空发明业务规则。

-- 用户端商品列表：只看上架、未移除，按 `sortOrder` 升序、`id` 升序兜底。
CREATE INDEX products_public_order_idx
  ON products (sort_order, id)
  WHERE status = 'on' AND removed_at IS NULL;

-- 后台列表：按游戏 / 类目过滤。
CREATE INDEX products_game_category_idx
  ON products (game_id, category_id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE product_specs (
  id          text COLLATE "C" NOT NULL,
  product_id  text NOT NULL,
  name        text NOT NULL,
  -- 单价，整数「分」（§C9），必须为正。
  price       integer NOT NULL,

  sort_order  integer NOT NULL,
  enabled     boolean NOT NULL,
  removed_at  timestamptz,

  CONSTRAINT product_specs_pkey PRIMARY KEY (id),
  CONSTRAINT product_specs_price_positive CHECK (price > 0),
  CONSTRAINT product_specs_product_fkey
    FOREIGN KEY (product_id) REFERENCES products (id)
);

-- 取某商品的规格：按 `sortOrder` 升序、`id` 升序兜底（`compareSpecsForList`）。
CREATE INDEX product_specs_product_order_idx
  ON product_specs (product_id, sort_order, id);
