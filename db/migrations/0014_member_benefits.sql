-- PROD-1E · Wave A 5/7：消费等级与打赏记录
--
-- ## 两张**只读**表
--
-- `levelRepository` 与 `tipRepository` 是仅有的两个**没有任何写方法**的仓储
-- （`lib/data/levelRepository.ts` / `lib/data/tipRepository.ts` 各只有一个/两个查询方法）。
-- 写它们的是预置数据，不是业务路径。因此这两张表本轮只需要「能读、且读到的与 Mock 逐字段一致」，
-- 不需要 Pg 事务——但它们仍必须落库：「用户端读等级、管理端读订单」，
-- 只要还有一个读取路径停在 Mock，`DATA_SOURCE=postgres` 下的页面就会两副面孔。

CREATE TABLE consumption_levels (
  id                text COLLATE "C" NOT NULL,
  name              text NOT NULL,
  -- 达到该级所需的**累计有效消费额**，整数「分」（§C9）。预置里 ¥500 = 50000。
  threshold_amount  integer NOT NULL,
  -- 权益说明数组（`ConsumptionPrivilege[]`：`{id,label,description}`）。
  -- ⚠️ 纯说明性，**没有可执行字段**（无折扣率、无次数）——因此不参与任何金额计算，
  --    放 jsonb 不会让「权益」变成一份会被误当成规则的配置。
  privileges        jsonb NOT NULL,
  sort_order        integer NOT NULL,
  -- ⚠️ 停用（`false`）的等级**仍然被 listLevels 返回**（`mockLevelRepository.ts`）——
  --    「停用」是「不参与判定」，不是「查不到」。仓储与页面自己按 `enabled` 过滤。
  enabled           boolean NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,

  CONSTRAINT consumption_levels_pkey PRIMARY KEY (id),
  CONSTRAINT consumption_levels_threshold_nonnegative CHECK (threshold_amount >= 0)
);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE tip_records (
  id                text COLLATE "C" NOT NULL,
  user_id           text NOT NULL,
  -- ⚠️ `order_id` / `order_no` / 商品三字段都是**下单时快照**，不是实时引用：
  --    打赏列表要显示「哪一单、什么商品」，而订单与商品后来都可能变。
  order_id          text NOT NULL,
  order_no          text NOT NULL,
  product_title     text NOT NULL,
  product_cover_url text NOT NULL,
  -- 打手快照（`OrderCompanionSnapshot`：`{id,name,avatarUrl}`）；未绑定为 NULL。
  companion         jsonb,

  -- ⚠️ **鸡腿个数**，不是金额。这张表**刻意没有任何金额字段**
  --    （无单价、无兑换比例、无平台抽成）——「鸡腿」在本阶段是一个计数单位，
  --    把它解释成钱是另一件产品决策，代码里没有做，库里也不留位置暗示。
  quantity          integer NOT NULL,
  payment_status    text NOT NULL,
  created_at        timestamptz NOT NULL,

  CONSTRAINT tip_records_pkey PRIMARY KEY (id),
  CONSTRAINT tip_records_payment_status_check
    CHECK (payment_status IN ('paid', 'pending', 'failed')),
  CONSTRAINT tip_records_quantity_positive CHECK (quantity > 0)
);

-- 「我的鸡腿」：按用户取、按 `createdAt` 倒序、`id` 倒序兜底（`compareTipsNewestFirst`）。
CREATE INDEX tip_records_user_created_idx
  ON tip_records (user_id, created_at DESC, id DESC);

-- 状态计数（`countTipsByStatus`）：用户 + 状态。
CREATE INDEX tip_records_user_status_idx
  ON tip_records (user_id, payment_status);
