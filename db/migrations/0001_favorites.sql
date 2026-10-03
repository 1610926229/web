-- PROD-1A · 竖切片 1/2：商品收藏
--
-- 这张表最终要让 `lib/data/favoriteRepository.ts` 的 PostgreSQL 实现落地，
-- 而它的对手是 `lib/data/mockFavoriteRepository.ts` 里的这段：
--
--     const existing = current.favorites.get(key);
--     if (existing) return { ok: true, favorite: existing, created: false };
--     current.favorites.set(key, favorite);
--
-- 「先查、没有再写」在单线程 + 无 await 的内存 Map 里是原子的，换成数据库后就不是了：
-- 两个并发请求可能都查到「没有」，然后都去写。**这条唯一约束就是为了取代那次查询**——
-- 判重的职责从「读一次再决定」搬到了索引上，写侧改成单条 INSERT ... ON CONFLICT。
--
-- ## 时间列一律 timestamptz（C8 裁定）
--
-- 内部存 UTC；驱动层（`lib/data/pg/pool.ts`）用 setTypeParser(1184) 把它统一还原成
-- ISO 字符串。因此**仓储边界上的类型与 Mock 完全一致，都是 string**，
-- `compareFavoritesNewestFirst` 那套字典序比较不需要改一个字就能继续成立。
--
-- 为什么不用 timestamp（不带时区）：服务器时区是 Asia/Shanghai，
-- 不带时区的列会把这个偏移悄悄吞掉，同一份数据在不同时区的机器上读出来差 8 小时。
--
-- ## 为什么 id 用 COLLATE "C"
--
-- 列表排序在时间相同时用 id 兜底（契约要求「排序必须完全确定」，否则分页会重复）。
-- 数据库的默认排序规则是**语言相关**的，同一个库在不同 collation 下可能给出不同顺序；
-- "C" 是稳定的字节序，不随 locale 变化。本项目的 id 全是 ASCII
-- （`fav-*` / `sug-*` / `crypto.randomUUID()`），字节序与 JS 的字符串比较一致。
--
-- ⚠️ 这里刻意**不写** `CREATE TABLE IF NOT EXISTS`：迁移的记账表已经保证了「跑过就不再跑」，
--    再叠一层 IF NOT EXISTS 只会让「历史上出过问题、表处于半成品状态」这种情况**静默通过**。
--    正式迁移要的是失败时大声报错，不是失败时假装没事。

CREATE TABLE favorites (
  id         text COLLATE "C" NOT NULL,
  user_id    text            NOT NULL,
  product_id text            NOT NULL,
  created_at timestamptz     NOT NULL,

  -- 「同一用户对同一商品只有一条收藏」——这条约束就是 `mockFavoriteRepository`
  -- 里那个 `${userId}:${productId}` Map 键在数据库上的等价物。
  CONSTRAINT favorites_pkey PRIMARY KEY (id),
  CONSTRAINT favorites_user_product_key UNIQUE (user_id, product_id)
);

-- 列表查询的排序键：先按用户筛，再按「收藏时间倒序 + id 倒序」。
-- 索引的列顺序与 ORDER BY 完全对齐，分页才不会退化成全表排序。
CREATE INDEX favorites_user_created_idx
  ON favorites (user_id, created_at DESC, id DESC);
