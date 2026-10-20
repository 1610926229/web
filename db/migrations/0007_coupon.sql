-- PROD-1B · W1 订单写闭包 5/6：券模板 / 领取记录
--
-- ## 券模板为什么也是「事务内参与者」
--
-- 领券本身是**读多写少**的，但 `couponRedemptionTransaction.redeemCouponClaimForOrder`
-- 在**原子区段内**读了模板的当前启用状态：
--
-- ```ts
-- const enabled = current.coupons.get(claim.couponId)?.enabled ?? false;
-- ```
--
-- 这一句决定「这张券此刻还能不能用」。如果订单写进 PG、而模板状态留在 Mock，
-- 就成了一个真实的半事务窗口：管理员刚停用一张券，PG 这边仍按停用前的状态把它抵掉了。
-- 因此 `coupon_templates` 是**写事务里的读参与者**，必须与订单同库。
--
-- （该文件同时留了一句自认：券模板「此刻」是否启用这条规则**裁定里没有明文**，
--   Mock 按「停用后已领取的也不能再用」实现，并已在 P1 轮登记为**待产品追认项**。
--   本轮**照搬该口径，不改**——Hard Rule 2。）

CREATE TABLE coupon_templates (
  id                 text COLLATE "C" NOT NULL,

  -- —— 券面内容。其中两个金额也在这里，因此「券面文案」与「券的金额」
  --    是**同一份冻结**：结算时的门槛判定与抵扣取值都读领取时的快照，不读本表当前值。——
  name               text NOT NULL,
  form_key           text NOT NULL,
  form_label         text NOT NULL,
  value_label        text NOT NULL,
  condition_label    text NOT NULL,
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz NOT NULL,
  -- ⚠️ 非满减券为 **NULL**：`null` 表示「没有可计算的门槛」，
  --    而不是「门槛为 0」——后者会让一张折扣券意外通过满减判定。
  threshold_amount   integer,
  -- ⚠️ 这是**名义面额**，不是最终的 `couponDiscountAmount`：
  --    实付不得为负，真正抵扣的是 `min(discountAmount, originalAmount)`。
  discount_amount    integer,

  enabled            boolean NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,

  CONSTRAINT coupon_templates_pkey PRIMARY KEY (id),
  CONSTRAINT coupon_templates_form_key_check
    CHECK (form_key IN ('threshold', 'discount', 'gift')),
  CONSTRAINT coupon_templates_amounts_nonnegative
    CHECK ((threshold_amount IS NULL OR threshold_amount >= 0)
           AND (discount_amount IS NULL OR discount_amount >= 0)),
  CONSTRAINT coupon_templates_validity CHECK (valid_to > valid_from)
);

-- 领券中心：只看启用中的券，按建券时间倒序。
CREATE INDEX coupon_templates_enabled_created_idx
  ON coupon_templates (enabled, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE coupon_claims (
  id                  text COLLATE "C" NOT NULL,
  user_id             text NOT NULL,
  coupon_id           text NOT NULL,
  -- ⚠️ 只有两个**由平台写入**的状态。`expired` 是**按当前时间推导**的展示状态，
  --    刻意不落库——否则一张没用掉的券会永远停在「未使用」上，
  --    除非有人跑定时任务去改它。
  status              text NOT NULL,
  -- ⚠️ **必填**，不是可选：可选字段会被新增的写入路径静默漏掉，
  --    而漏掉之后没人能看出区别（与 `Dispatch.acceptedVia` 同一课）。
  source              text NOT NULL,

  -- 这张 Claim **产生**的时刻。self-claim 是领取时刻，admin_grant 是发放时刻。
  claimed_at          timestamptz NOT NULL,
  used_at             timestamptz,
  -- ⚠️ 最小审计信息。与 `source` **互为充要条件**：
  --    self_claim ⇒ 必须为 NULL；admin_grant ⇒ 必须有值。
  granted_by_admin_id text,

  -- ⚠️ 幂等键同样不是实体字段：Mock 里它只活在 `claimIdByKey` 上。
  --    **可空、预置数据写 NULL**：`createStore()` 只把种子放进 `claimIdByCoupon`，
  --    而 `claimIdByKey` 是空的。理由同 `refund_requests.idempotency_key`。
  idempotency_key     text,

  -- 领取 / 发放那一刻的券面快照（`CouponSnapshot`）。之后改模板**不追溯**。
  snapshot            jsonb NOT NULL,

  CONSTRAINT coupon_claims_pkey PRIMARY KEY (id),

  CONSTRAINT coupon_claims_status_check CHECK (status IN ('unused', 'used')),
  CONSTRAINT coupon_claims_source_check
    CHECK (source IN ('self_claim', 'admin_grant')),
  -- 来源与发放人互为充要条件
  CONSTRAINT coupon_claims_grant_requires_admin
    CHECK ((source = 'admin_grant') = (granted_by_admin_id IS NOT NULL)),

  CONSTRAINT coupon_claims_coupon_fkey
    FOREIGN KEY (coupon_id) REFERENCES coupon_templates (id)
);

-- ⚠️ 「一人一券」是**部分**唯一索引，不是表级 UNIQUE。
--    `mockCouponRepository.createClaim` 只写 `claimIdByCoupon`，
--    而管理员发放走另一条路（`:239` 那句「**不写** `claimIdByCoupon`
--    （发放不受『一人一券』约束）」）。写成表级 UNIQUE 会让
--    「管理员给已领过的用户再发一张」直接写不进去——那是明文允许的业务。
CREATE UNIQUE INDEX coupon_claims_self_claim_key
  ON coupon_claims (user_id, coupon_id)
  WHERE source = 'self_claim';

-- 「同一个用户 + 同一幂等键只产生一条领取记录」——两条来源共用同一支写入器
-- （mock 里 `claimIdByKey` 也是同一个 Map），因此这条**不带** WHERE。
CREATE UNIQUE INDEX coupon_claims_idempotency_key
  ON coupon_claims (user_id, idempotency_key);

-- 「我的优惠券」：按用户取、按领取时间倒序。
CREATE INDEX coupon_claims_user_claimed_idx
  ON coupon_claims (user_id, claimed_at DESC, id DESC);
