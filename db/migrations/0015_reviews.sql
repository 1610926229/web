-- PROD-1E · Wave A 6/7：订单评价
--
-- ## 一张表承载两套「身份」
--
-- | 用途 | 键 |
-- |---|---|
-- | 「一单一评」 | `(user_id, order_id)` |
-- | 幂等 | `(user_id, idempotency_key)` |
-- | **公共聚合**（R4） | `product_id` —— 「这条评价计入哪件商品的平均分」 |
--
-- ⚠️ 聚合身份是 `product_id`，**不是** `spec_id`、也不是订单。这三个字段都是**下单时快照**，
--    规格 id 只是聚合身份的稳定组成之一，不单独作为聚合键（见 `docs/02-tech-design/database-schema.md` §13.2）。
--
-- ## 双维度：`product_review` 与 `companion_review`
--
-- 两个维度各自可为 `null`（未评 / 无履约打手），各自是 `{rating, content}`。
-- 放 jsonb 而不是拆成四个列：这两个字段**永远整体读、整体写**，
-- 从没有「只查 rating 不查 content」的路径，拆列只会让可空性规则（`rating` 与之 `content` 同生共死）
-- 分散到四个 CHECK 里。
--
-- ## 金额
--
-- 评价**不影响任何金额**（`reviews.ts` 明文）。因此本表没有金额列。

CREATE TABLE order_reviews (
  id                  text COLLATE "C" NOT NULL,
  user_id             text NOT NULL,
  order_id            text NOT NULL,
  order_no            text NOT NULL,

  -- 聚合身份（R4）。
  product_id          text NOT NULL,
  spec_id             text NOT NULL,

  product_review      jsonb,
  companion_review    jsonb,
  evidence            jsonb NOT NULL,

  status              text NOT NULL,
  -- 只有 `rejected` 非空，≤200 字符。
  reject_reason       text,
  -- 只有 `hidden` 非空，作者可见。
  hide_reason         text,
  reviewed_by         text,
  reviewed_by_name    text,
  reviewed_at         timestamptz,

  -- ⚠️ `created_at` 是**首次**提交时间，重提（resubmit）**不重置**它；
  --    `updated_at` 是最近一次内容变更时间，**审核动作不动它**（D12）。
  --    两个字段语义不同，不能合并。
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,

  -- 下单时快照，用于展示（改名/改价不追溯）。
  product_title       text NOT NULL,
  product_cover_url   text NOT NULL,
  spec_name           text NOT NULL,
  quantity            integer NOT NULL,
  completed_at        timestamptz NOT NULL,
  -- 实际履约打手快照；未绑定为 NULL。
  companion           jsonb,

  idempotency_key     text,

  CONSTRAINT order_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT order_reviews_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  -- 「驳回原因」与「状态=rejected」互为充要条件；隐藏原因同理。
  CONSTRAINT order_reviews_reject_reason_iff_rejected
    CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CONSTRAINT order_reviews_hide_reason_iff_hidden
    CHECK ((status = 'hidden') = (hide_reason IS NOT NULL)),
  CONSTRAINT order_reviews_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- 「一单一评」（R1）。
CREATE UNIQUE INDEX order_reviews_user_order_key
  ON order_reviews (user_id, order_id);

-- 幂等键。
CREATE UNIQUE INDEX order_reviews_idempotency_key
  ON order_reviews (user_id, idempotency_key);

-- ⚠️ 公共聚合的**唯一**取数路径：按 `product_id` 取。
--    聚合口径（哪些状态计入）在服务层（`buildReviewAggregate`），不在索引里——
--    索引只负责「把这些行捞出来」，不预先筛状态，否则将来口径一变就要改索引。
CREATE INDEX order_reviews_product_idx
  ON order_reviews (product_id);

-- 打手维度聚合：按 `companion ->> 'id'` 取。
CREATE INDEX order_reviews_companion_idx
  ON order_reviews ((companion ->> 'id'));

-- 「我的评价」：按用户取、按 `createdAt` 倒序、`id` 倒序兜底（`compareReviewsNewestFirst`）。
CREATE INDEX order_reviews_user_created_idx
  ON order_reviews (user_id, created_at DESC, id DESC);
