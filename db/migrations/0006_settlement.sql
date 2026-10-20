-- PROD-1B · W1 订单写闭包 4/6：退款申请 / 收益 / 收益调整明细 / 站内通知
--
-- ## 这一组是「钱」的那一半
--
-- 四张表在**同一次退款批准**里一起写（T11 `approveRefund`）：
--
-- ```
-- 退款决策 → 订单 refunded + refundedAmount ─┐
--                                          ├─ 同一段原子区段（无 await）
--   收益整笔冲回 + 调整明细 ─────────────────┘
--   通知
-- ```
--
-- 中间任何一步单独落库，留下的都是**对不上的账**：
-- 订单说退过了、收益却还挂着全额可提现；或者钱退回去了、却查不出是哪一笔退的。
--
-- ## P0-15 把「一单多次退款」整个删掉了
--
-- 因此本文件里有两条**来自 P0-15 的**硬约束，而不是历史遗留：
-- `refund_requests` 的 `UNIQUE (order_id)`（一个订单至多一次退款申请），
-- 以及 `earning_adjustments` 的 `UNIQUE (refund_id)`（一次退款决策至多一条冲减明细）。
-- P0-15 之前它们是「通常只有一条」；现在是**结构上不可能有第二条**。

CREATE TABLE refund_requests (
  id                  text COLLATE "C" NOT NULL,
  refund_no           text NOT NULL,
  user_id             text NOT NULL,
  order_id            text NOT NULL,
  status              text NOT NULL,

  -- ⚠️ 申请创建时这一单的**实付快照**：它回答「本来涉及多少钱」，
  --    不回答「最后退了多少」——后者在 `decision` 里。
  amount              integer NOT NULL,

  -- 资金决策（P0-13）。⚠️ 未决策时为 **NULL**，不是零值决策：
  -- 「还没人决定」与「决定退 0 元」是两件事，页面上必须分得开。
  decision            jsonb,

  reason_key          text NOT NULL,
  reason_label        text NOT NULL,
  description         text NOT NULL,
  evidence            jsonb NOT NULL,

  -- ⚠️ 幂等键不是实体字段：Mock 里它只活在 `refundIdByKey` 上
  --    （`mockRefundRepository.ts`，键为 `${userId}:${idempotencyKey}`）。
  --
  -- ⚠️ **可空，且预置数据一律写 NULL**：`createStore()` 里 `refundIdByKey` 是
  --    `new Map()`（空），种子只进 `refunds` 与 `refundIdsByOrder`。
  --    因此预置退款在 Mock 里**按任何幂等键都查不到**；写成 NOT NULL 会逼着种子
  --    编一个键出来，于是两个实现对同一份数据给出不同答案。
  --    这与 `0002_suggestions.sql` 里 `idempotency_key` 可空是同一条理由。
  idempotency_key     text,

  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  reviewing_at        timestamptz,
  reviewed_at         timestamptz,
  -- ⚠️ 「谁批的」可能是管理员也可能是客服（P8D-2 起），
  --    因此**必须连 `reviewed_by_role` 一起读**才知道去哪张表查。
  --    只记结果、不记「谁开始看的」——后者由审计回答。
  reviewed_by         text,
  reviewed_by_role    text,
  reviewed_by_name    text,
  review_note         text NOT NULL,
  cancelled_at        timestamptz,

  CONSTRAINT refund_requests_pkey PRIMARY KEY (id),
  CONSTRAINT refund_requests_refund_no_key UNIQUE (refund_no),

  -- ⚠️ **P0-15**：一个订单至多一次退款申请。这是本轮**最强**的一条唯一约束，
  --    它把「一单一退」从业务流程里的一句话，变成数据库拒绝写入的事实。
  CONSTRAINT refund_requests_order_key UNIQUE (order_id),
  -- 同一个用户连点「提交申请」只产生一条（C2 幂等键 → 唯一约束）。
  CONSTRAINT refund_requests_user_idempotency_key
    UNIQUE (user_id, idempotency_key),

  CONSTRAINT refund_requests_status_check
    CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT refund_requests_reviewer_role_check
    CHECK (reviewed_by_role IN ('admin', 'customer_service')),
  CONSTRAINT refund_requests_amount_nonnegative CHECK (amount >= 0),

  -- 资金决策的**形状与取值**。写成 CHECK 而不是只靠 `RefundDecision` 的类型：
  -- 类型在编译后就没了，而这一列会一直躺在库里被对账读。
  --
  -- ⚠️ `?` 判断不能省：`'{}'::jsonb->>'refundRateBp'` 是 NULL，
  --    而 `NULL::int BETWEEN 1 AND 10000` 求值为 NULL —— CHECK 只在
  --    结果为 **false** 时拒绝，于是「缺键」会**悄悄通过**。先断言键存在才拦得住。
  CONSTRAINT refund_requests_decision_shape
    CHECK (decision IS NULL OR (
      decision ? 'refundRateBp' AND decision ? 'refundAmount' AND decision ? 'companionReversalAmount'
      AND (decision ->> 'refundRateBp')::int BETWEEN 1 AND 10000
      AND (decision ->> 'refundAmount')::int >= 0
      AND (decision ->> 'companionReversalAmount')::int >= 0
      -- 这一次退给用户的钱 = floor(实付 × 比例 / 10000)。
      -- ⚠️ 整数除法在非负操作数上就是向下取整；用浮点写会在极端值上引入误差。
      AND (decision ->> 'refundAmount')::int = (amount * (decision ->> 'refundRateBp')::int) / 10000
      AND (decision ->> 'refundAmount')::int <= amount
    )),

  CONSTRAINT refund_requests_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- 用户端「我的退款」按时间倒序；管理端 / 客服端审核队列按状态筛。
CREATE INDEX refund_requests_user_created_idx
  ON refund_requests (user_id, created_at DESC, id DESC);
CREATE INDEX refund_requests_status_created_idx
  ON refund_requests (status, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE earnings (
  id               text COLLATE "C" NOT NULL,
  order_id         text NOT NULL,
  -- **实际履约**的打手（`orders.actual_companion_id`），不是用户当初指定的人
  companion_id     text NOT NULL,

  -- 收益金额（分），**直接搬** `orders.companion_base_income`，不重算。
  income_amount    integer NOT NULL,
  status           text NOT NULL,
  frozen_at        timestamptz NOT NULL,

  -- ⚠️ **计划**解冻时刻 = 本单的 `orders.complaint_deadline_at`。创建时写下，
  --    之后**永不刷新**（包括 `frozen → available` 那一次）：
  --    「什么时候到期」与「实际上什么时候变得可提现」是两个事实，各有出处。
  available_at     timestamptz,
  withdrawn_at     timestamptz,
  -- 已冲正金额（分）。P0-15 后恒等于 `income_amount`，但本列仍是**累加**语义。
  reversed_amount  integer NOT NULL,
  fine_amount      integer NOT NULL,

  CONSTRAINT earnings_pkey PRIMARY KEY (id),

  -- 一张订单只有一笔收益。
  CONSTRAINT earnings_order_key UNIQUE (order_id),

  CONSTRAINT earnings_status_check
    CHECK (status IN ('frozen', 'available', 'withdrawn', 'reversed')),
  -- ⚠️ 「打手 0 收益」的场景（未服务即退款）按规则**根本不建 Earning**
  --    （`database-schema.md` T3 状态机 `accepted → refunded` 一行）。
  --    因此 0 元记录是**错误数据**，不是一种业务形态——DB 直接拒绝。
  CONSTRAINT earnings_income_positive CHECK (income_amount > 0),
  -- ⚠️ 不变式 `0 <= reversedAmount <= incomeAmount`，类型注释里写着「由存储层
  --    `applyEarningReversal` 自带护栏维持」。搬进 DB 后**由约束维持**，
  --    写入器坏掉也越不了界。
  CONSTRAINT earnings_reversal_within_income
    CHECK (reversed_amount >= 0 AND reversed_amount <= income_amount),
  CONSTRAINT earnings_fine_nonnegative CHECK (fine_amount >= 0),

  CONSTRAINT earnings_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT earnings_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id)
);

-- 「我的收益」：按打手取，按冻结时间倒序。
CREATE INDEX earnings_companion_frozen_idx
  ON earnings (companion_id, frozen_at DESC, id DESC);

-- 解冻清扫（T10 `sweepMaturedEarnings`）扫描到点且仍冻结的收益。
CREATE INDEX earnings_matured_idx
  ON earnings (available_at)
  WHERE status = 'frozen';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE earning_adjustments (
  id          text COLLATE "C" NOT NULL,
  earning_id  text NOT NULL,
  -- 冗余带上订单 id：按订单追查时不必先查 Earning。
  order_id    text NOT NULL,
  -- 触发这次冲减的退款决策。**幂等键**：同一笔退款重复批准只可能有一条明细。
  refund_id   text NOT NULL,
  type        text NOT NULL,

  -- ⚠️ 恒为正整数，方向由 `type` 表达。存带符号的数会让「求和校验」
  --    与「绝对值校验」混在一起，而当前只有「冲减」一个方向。
  amount      integer NOT NULL,
  created_at  timestamptz NOT NULL,
  -- ⚠️ 少了他就答不出「这笔钱是谁决定从打手身上冲回来的」。
  --    与退款记录上的 `reviewed_by` 不是同一个问题，因此单独记。
  admin_id    text NOT NULL,

  CONSTRAINT earning_adjustments_pkey PRIMARY KEY (id),
  -- 一次退款决策至多一条冲减明细（P0-15 后「一个订单至多一次退款」，
  -- 因此一笔收益上至多一条明细）。
  CONSTRAINT earning_adjustments_refund_key UNIQUE (refund_id),
  -- 单一的调整类型，刻意不做成开放式字符串。
  CONSTRAINT earning_adjustments_type_check CHECK (type = 'refund_reversal'),
  CONSTRAINT earning_adjustments_amount_positive CHECK (amount > 0),

  CONSTRAINT earning_adjustments_earning_fkey
    FOREIGN KEY (earning_id) REFERENCES earnings (id),
  CONSTRAINT earning_adjustments_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT earning_adjustments_refund_fkey
    FOREIGN KEY (refund_id) REFERENCES refund_requests (id)
);

-- 对账读路径：`earnings.reversed_amount` 必须等于本表按 `earning_id` 求和
-- （「读用总数、审计用明细」，单一真值源）。
CREATE INDEX earning_adjustments_earning_idx
  ON earning_adjustments (earning_id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id         text COLLATE "C" NOT NULL,
  user_id    text NOT NULL,
  kind       text NOT NULL,
  title      text NOT NULL,
  -- 列表上一行的摘要
  summary    text NOT NULL,
  -- 展开后的正文
  body       text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at    timestamptz,
  href       text,

  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_kind_check
    CHECK (kind IN ('order', 'refund', 'complaint', 'dispatch', 'system'))
);

-- 通知列表：按收件人取、按时间倒序，id 兜底保证分页完全确定。
CREATE INDEX notifications_user_created_idx
  ON notifications (user_id, created_at DESC, id DESC);

-- ⚠️ **本表刻意没有幂等键列。**
--
-- `database-schema.md` §8 记着：本轮的幂等**不靠 id**，靠**业务状态机**
--（`tests/dispatch.test.mjs:648` 钉死「重复清扫不得重复产生同一业务事件的通知」），
-- 而 `NotificationInput` 上**根本没有** `orderId` / `eventType` 字段。
-- 文档同时要求「后续新增生命周期通知时，幂等键必须是可推导的（如 orderId + 事件类型），
-- **不得照抄随机 UUID 方案**」——但那是一条 **TARGET**，
-- 对应的字段与写入路径**至今不存在**。
--
-- 本轮若在这里加一个 `dedupe_key` 列，就是一个**没有任何写入方的死列**：
-- 它会让人以为通知已经按键去重了，而真正在保证不重复的仍然是状态机。
-- 因此本轮**不加**，只把这条 TARGET 登记进 `03-delivery.md` 的待办。
--
-- id 由写入方生成（`ntf_` + UUID），主键即「冲突就报错、拒绝覆盖」——
-- 这与 `mockNotificationRepository.appendNotification` 的既有行为一字不差。
