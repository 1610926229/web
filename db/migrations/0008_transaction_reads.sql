-- PROD-1B · W1 订单写闭包 6/6：两张**只被读**的表——投诉 / 平台参数
--
-- ## 为什么两张「本轮不写」的表也要建
--
-- 因为在**真实的写事务里**它们被读，而读出来的结果会改变写什么：
--
-- | 表 | 谁在原子区段里读 | 读了决定什么 |
-- |---|---|---|
-- | `complaints` | `readOrderBlockingFacts`（被 T9 `sweepCompletionAutoApprovals` 与 T10 `sweepMaturedEarnings` 调用） | 这一单**有没有未完结的投诉**——有就**不能**自动通过完成材料、**不能**解冻收益 |
-- | `platform_config` | 派单进专属池 / 公共池、完成材料提交、订单完成时**冻结快照** | 这一次的超时时长是多少 |
--
-- ⚠️ 这两处**正是**「读 Mock、写 PG」会真实出错的地方：
-- 管理员改完平台参数、Mock 读到新值，而 PG 侧那一单已经按旧值冻结了 deadline；
-- 或者用户刚提交投诉，Mock 看得见、PG 看不见，于是收益被提前解冻。
-- 所以它们是**事务内读参与者**，不是「顺手牵进来的业务域」。
--
-- 本轮**不迁移**它们的写者（投诉处理、平台参数修改都属管理端事务），
-- 因此这两张表在本轮只保证「能被读、且读到的与 Mock 一致」。

CREATE TABLE complaints (
  id               text COLLATE "C" NOT NULL,
  complaint_no     text NOT NULL,
  user_id          text NOT NULL,
  -- ⚠️ **可为 null**：平台服务类投诉不关联订单。`order_no` 是订单号快照，
  --    与 `order_id` 一起可以为空——它不是外键的替代品，是给展示用的历史值。
  order_id         text,
  order_no         text,

  status           text NOT NULL,
  type_key         text NOT NULL,
  type_label       text NOT NULL,
  description      text NOT NULL,
  evidence         jsonb NOT NULL,
  contact          text NOT NULL,

  -- ⚠️ 幂等键不是实体字段：Mock 里它只活在 `complaintIdByKey` 上
  --    （键为 `${userId}:${idempotencyKey}`）。
  --    **可空、预置数据写 NULL**——`createStore()` 里那张索引是空的，
  --    理由与 `refund_requests.idempotency_key` 完全一致。
  idempotency_key  text,

  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  processing_at    timestamptz,
  -- 完结时间：`resolved` 与 `closed` **都记在这里**，未完结时为空。
  handled_at       timestamptz,
  -- ⚠️ P8C 时这个字段叫 `handledByAdminId`，那时只有管理员会写它。
  --    P8D-2 起客服也能处理投诉，于是改成了中性的名字——
  --    一个名叫「AdminId」的字段里装着 `cs-2`，是那种会让下一个人写错查询的谎。
  handled_by_id    text,
  handled_by_role  text,
  handled_by_name  text,
  -- 「解决」时是处理结果，「关闭」时是关闭说明。用户提交的说明在 `description` 里，
  -- **两者永不互相覆盖**。
  result           text NOT NULL,

  CONSTRAINT complaints_pkey PRIMARY KEY (id),
  CONSTRAINT complaints_complaint_no_key UNIQUE (complaint_no),
  CONSTRAINT complaints_user_idempotency_key
    UNIQUE (user_id, idempotency_key),

  CONSTRAINT complaints_status_check
    CHECK (status IN ('pending', 'processing', 'resolved', 'closed')),
  CONSTRAINT complaints_handler_role_check
    CHECK (handled_by_role IN ('admin', 'customer_service')),

  -- ⚠️ `order_id` 可空，因此 NULL 在默认 NULLS DISTINCT 语义下互不冲突，
  --    平台服务类投诉可以有很多条。
  CONSTRAINT complaints_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- ⚠️ 本条索引不是给页面用的，是给**事务内的阻塞判定**用的：
-- `readOrderBlockingFacts` 问的是「这一单**现在**有没有未完结的投诉」，
-- 因此筛选条件是 order_id + 一个**很小的状态集合**。
-- 列顺序按选择度排：先 order_id（等值、最窄），再 status。
CREATE INDEX complaints_order_status_idx
  ON complaints (order_id, status);

-- 管理端 / 客服端投诉队列按时间倒序。
CREATE INDEX complaints_status_created_idx
  ON complaints (status, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE platform_config (
  -- 单行表。用 `id` + CHECK 而不是「约定只有一行」：
  -- 多插一行会让「读配置」变成一次**未定义**的查询（读到哪个取决于计划），
  -- 而这种故障在页面上表现为「参数偶尔自己变回去」，几乎不可能定位。
  id                              smallint NOT NULL,

  exclusive_pool_timeout_minutes  integer NOT NULL,
  public_pool_timeout_minutes     integer NOT NULL,
  completion_auto_approval_minutes integer NOT NULL,
  complaint_window_minutes        integer NOT NULL,

  updated_at                      timestamptz NOT NULL,
  -- ⚠️ 闭包外引用：`admin_accounts` 本轮不迁。预置数据为 null。
  --    这里只记「最近一次是谁改的」，**每一次**由审计回答——两者不重复。
  updated_by_admin_id             text,

  CONSTRAINT platform_config_pkey PRIMARY KEY (id),
  CONSTRAINT platform_config_singleton CHECK (id = 1),

  -- 四项的取值范围来自 `lib/constants/platformConfig.ts`：
  -- 前三项共用 1~1440，投诉窗口是 60~10080。
  -- 搬进 DB 之后，绕过服务层的写入（迁移脚本、运维手改）同样越不了界。
  CONSTRAINT platform_config_exclusive_range
    CHECK (exclusive_pool_timeout_minutes BETWEEN 1 AND 1440),
  CONSTRAINT platform_config_public_range
    CHECK (public_pool_timeout_minutes BETWEEN 1 AND 1440),
  CONSTRAINT platform_config_auto_approval_range
    CHECK (completion_auto_approval_minutes BETWEEN 1 AND 1440),
  CONSTRAINT platform_config_complaint_window_range
    CHECK (complaint_window_minutes BETWEEN 60 AND 10080)
);
