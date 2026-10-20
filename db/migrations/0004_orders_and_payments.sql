-- PROD-1B · W1 订单写闭包 2/6：订单 / 支付请求 / 支付记录
--
-- ## 三者为什么在同一份迁移里
--
-- 需求 `database-schema.md:163` 就写着「PaymentRequest / Payment / Order —— ⚠️ 三者同属一个仓储」，
-- 而且 :292 记着「**`PaymentRequest` 与 `Order` 是两次写**……两者的创建必须保证一致性」。
-- 在本项目里它们由**同一个原子区段**产生：`mockPaymentRepository.confirmPaymentRequest`
-- （`lib/data/mockPaymentRepository.ts:114–160`）先把订单写进去，再把支付记录写进去，
-- 最后把支付请求置为终态——三段之间没有 `await`。
-- 因此这三张表的约束必须放在一起看，任何一张单独迁都没有意义。
--
-- ## `orders` 上那几条 CHECK 不是装饰
--
-- 金额规则在 `architecture-rules.md §三` 与 `database-schema.md` C6/C9 里是**已冻结**的：
-- 一律整数「分」，且 `clubNetIncome = actualPaidAmount − companionBaseIncome` 是**恒等式**而不是「通常成立」。
-- Mock 阶段这些恒等式没有任何东西在守——一段写错的代码可以把 `clubNetIncome` 写成任何值，
-- 订单列表照样渲染得出来。搬进数据库时把它们写成 CHECK，等于让「金额算错了」这件事
-- 在写入的那一刻就失败，而不是等到对账时才发现。
--
-- ⚠️ 取整用**整数除法**（`(a * b) / 10000`）而不是 `floor(a * b / 10000.0)`：
--    两个操作数都是非负整数时，PostgreSQL 的整数除法就是向下取整，
--    而浮点版本会在极端值上引入二进制表示误差——金额校验不该依赖浮点。
--
-- ## 时间列一律 timestamptz（C8）

CREATE TABLE orders (
  id                                text COLLATE "C" NOT NULL,
  order_no                          text NOT NULL,
  -- ⚠️ 闭包外引用：`users` 本轮不迁，按 Q1 规则 13c 以稳定 ID 文本存储、暂不建 FK（见 03-delivery）。
  user_id                           text NOT NULL,

  status                            text NOT NULL,

  created_at                        timestamptz NOT NULL,
  paid_at                           timestamptz NOT NULL,
  accepted_at                       timestamptz,
  serving_at                        timestamptz,
  completed_at                      timestamptz,
  refunded_at                       timestamptz,
  -- ⚠️ 「历史第一次被承接」，**只写一次，任何路径都不清空**（区别于 accepted_at）。
  --    它是退券的唯一判据（`restoreCouponClaimForOrder` 只读它），
  --    因为一张 `accepted → 客服取消回池 → paid` 的单在退款那一刻状态是 paid，
  --    但它已经被承接过了，**不还券**——只看 status 是错的。
  ever_accepted_at                  timestamptz,

  -- —— 下单内容快照（下单时冻结，之后目录改名改价不影响历史订单）——
  product_id                        text NOT NULL,
  product_title                     text NOT NULL,
  product_cover_url                 text NOT NULL,
  spec_id                           text NOT NULL,
  spec_name                         text NOT NULL,
  unit_price                        integer NOT NULL,
  quantity                          integer NOT NULL,
  game_name                         text NOT NULL,
  region                            text NOT NULL,
  game_account_id                   text NOT NULL,
  remark                            text NOT NULL,
  addons                            jsonb NOT NULL,

  -- —— 金额域：**全部整数分** ——
  items_amount                      integer NOT NULL,
  addons_amount                     integer NOT NULL,
  total_amount                      integer NOT NULL,
  original_amount                   integer NOT NULL,
  coupon_discount_amount            integer NOT NULL,
  actual_paid_amount                integer NOT NULL,
  -- ⚠️ 分账比例是**基点**（8000 = 80%），不是分，也不是小数。别把它算进金额 CHECK 里。
  companion_rate_snapshot           integer NOT NULL,
  companion_base_income             integer NOT NULL,
  -- ⚠️ 平台净收入**允许为负**（重折扣单上打手收益可能超过实付），因此没有非负 CHECK。
  club_net_income                   integer NOT NULL,
  refunded_amount                   integer NOT NULL,

  -- 冻结的券快照。退款**一个字都不改它**——订单历史仍要能说明「当时用过这张券」。
  coupon                            jsonb,

  -- —— 指派 / 履约身份 ——
  -- 还没人接时为 NULL，且只允许出现在 `paid`。`companion` 是下单时冻结的展示快照。
  actual_companion_id               text,
  companion                         jsonb,

  -- —— 投诉期 deadline 快照（completed 时冻结，永不重算）——
  complaint_window_minutes_snapshot integer,
  complaint_deadline_at             timestamptz,

  CONSTRAINT orders_pkey PRIMARY KEY (id),
  CONSTRAINT orders_order_no_key UNIQUE (order_no),

  -- 五态，别无其它。UI 上的展示阶段（等待接单 / 结算中等）**不是**订单状态，
  -- 禁止为了让页面好看就往这一列里塞新字符串。
  CONSTRAINT orders_status_check
    CHECK (status IN ('paid', 'accepted', 'serving', 'completed', 'refunded')),

  -- 金额恒等式一：实付 = 原始应付 − 券抵扣
  CONSTRAINT orders_actual_paid_identity
    CHECK (actual_paid_amount = original_amount - coupon_discount_amount),
  -- 金额恒等式二：实付 = 打手收益 + 平台净收入
  CONSTRAINT orders_income_split_identity
    CHECK (actual_paid_amount = companion_base_income + club_net_income),
  -- 金额恒等式三：打手收益 = floor(基数 × 基点 / 10000)，基数是**优惠前应付**
  --（优惠券成本由平台承担，不能通过券降低打手理论基础收益）
  CONSTRAINT orders_companion_income_formula
    CHECK (companion_base_income = (original_amount * companion_rate_snapshot) / 10000),
  -- 应付合计 = 商品 + 增值服务
  CONSTRAINT orders_total_identity
    CHECK (total_amount = items_amount + addons_amount),

  CONSTRAINT orders_amounts_nonnegative
    CHECK (unit_price >= 0 AND items_amount >= 0 AND addons_amount >= 0
           AND total_amount >= 0 AND original_amount >= 0 AND coupon_discount_amount >= 0
           AND actual_paid_amount >= 0 AND companion_base_income >= 0 AND refunded_amount >= 0),
  CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
  CONSTRAINT orders_rate_in_range
    CHECK (companion_rate_snapshot >= 0 AND companion_rate_snapshot <= 10000),
  -- P0-15「一单一退」：累计已退不可能超过实付
  CONSTRAINT orders_refund_within_paid CHECK (refunded_amount <= actual_paid_amount),

  CONSTRAINT orders_actual_companion_fkey
    FOREIGN KEY (actual_companion_id) REFERENCES companions (id)
);

-- 订单列表的排序键：先按用户筛，再按「创建时间倒序 + id 倒序」。
-- 与 `compareOrdersNewestFirst` 完全对齐；id 兜底保证排序**完全确定**，
-- 否则分页会在同一时刻的两单之间重复或漏掉。
CREATE INDEX orders_user_created_idx
  ON orders (user_id, created_at DESC, id DESC);

-- 管理端按状态 / 游戏名 / 创建日期范围筛选（`AdminOrderQueryFilter`）。
-- 没有「关键词」索引：关键词要跨到用户仓储去匹配昵称，那一段由服务层做，不在本表上。
CREATE INDEX orders_admin_filter_idx
  ON orders (status, game_name, created_at DESC, id DESC);

-- 打手工作台按「我实际履约的单」查询。
CREATE INDEX orders_actual_companion_idx
  ON orders (actual_companion_id, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE payment_requests (
  id                      text COLLATE "C" NOT NULL,
  user_id                 text NOT NULL,
  -- ⚠️ 幂等键**不是**实体上的字段：它在 Mock 里只活在 `requestIdByKey` 这个 Map 上
  --    （`mockPaymentRepository.ts:34`）。搬进数据库时必须变成列，因为
  --    `(user_id, idempotency_key)` 就是「快速连点只产生一条支付请求」的落点（C2）。
  idempotency_key         text NOT NULL,

  status                  text NOT NULL,

  -- 用户的下单意图
  product_id              text NOT NULL,
  spec_id                 text NOT NULL,
  quantity                integer NOT NULL,
  region                  text NOT NULL,
  addon_ids               jsonb NOT NULL,
  game_account_id         text NOT NULL,
  remark                  text NOT NULL,
  companion_id            text,
  coupon_claim_id         text,

  created_at              timestamptz NOT NULL,
  confirmed_at            timestamptz,

  -- 金额域（整数分）
  items_amount            integer NOT NULL,
  addons_amount           integer NOT NULL,
  total_amount            integer NOT NULL,
  coupon_discount_amount  integer NOT NULL,
  actual_paid_amount      integer NOT NULL,
  companion_rate_snapshot integer NOT NULL,

  -- 建单时冻结的券快照与商品快照
  coupon                  jsonb,
  snapshot                jsonb NOT NULL,

  -- 支付成功生成的订单；未成功为 NULL
  order_id                text,

  CONSTRAINT payment_requests_pkey PRIMARY KEY (id),

  -- 「同一用户的同一幂等键只有一条支付请求」
  CONSTRAINT payment_requests_user_idempotency_key
    UNIQUE (user_id, idempotency_key),
  -- 「一条支付请求至多生成一个订单」。NULL 在 PostgreSQL 默认 NULLS DISTINCT，
  -- 因此大量「还没成功的请求」可以同时为 NULL，互不冲突。
  CONSTRAINT payment_requests_order_key UNIQUE (order_id),

  CONSTRAINT payment_requests_status_check
    CHECK (status IN ('pending', 'success', 'failed', 'cancelled')),
  CONSTRAINT payment_requests_actual_paid_identity
    CHECK (actual_paid_amount = total_amount - coupon_discount_amount),
  CONSTRAINT payment_requests_total_identity
    CHECK (total_amount = items_amount + addons_amount),
  CONSTRAINT payment_requests_amounts_nonnegative
    CHECK (items_amount >= 0 AND addons_amount >= 0 AND total_amount >= 0
           AND coupon_discount_amount >= 0 AND actual_paid_amount >= 0),
  CONSTRAINT payment_requests_quantity_positive CHECK (quantity > 0),
  CONSTRAINT payment_requests_rate_in_range
    CHECK (companion_rate_snapshot >= 0 AND companion_rate_snapshot <= 10000),

  CONSTRAINT payment_requests_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT payment_requests_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id)
);

CREATE INDEX payment_requests_user_created_idx
  ON payment_requests (user_id, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE payments (
  id                 text COLLATE "C" NOT NULL,
  payment_request_id text NOT NULL,
  order_id           text NOT NULL,
  user_id            text NOT NULL,
  -- ⚠️ 是**实付**，不是 `total_amount`（P1-4 修正）：拿优惠前总额当支付金额，
  --    等于「按原价扣款却给优惠」，支付记录会与订单的 actualPaidAmount 对不上。
  amount             integer NOT NULL,
  status             text NOT NULL,
  paid_at            timestamptz NOT NULL,

  CONSTRAINT payments_pkey PRIMARY KEY (id),
  -- 本阶段支付记录**只在成功时生成**，因此状态是字面量而不是枚举。
  -- 约束写成 CHECK 而不是省略，是为了将来真的接入渠道、出现 `refunded` 时
  -- 必须显式改这一行 —— 悄悄多出一个状态比改一次迁移危险得多。
  CONSTRAINT payments_status_check CHECK (status = 'success'),
  CONSTRAINT payments_amount_nonnegative CHECK (amount >= 0),

  -- 一次支付确认只产生一条支付记录（`confirmPaymentRequest` 的 `status !== 'pending'` 闸
  -- 保证了这一条），因此两个引用都各自唯一。
  CONSTRAINT payments_payment_request_key UNIQUE (payment_request_id),
  CONSTRAINT payments_order_key UNIQUE (order_id),

  CONSTRAINT payments_payment_request_fkey
    FOREIGN KEY (payment_request_id) REFERENCES payment_requests (id),
  CONSTRAINT payments_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id)
);
