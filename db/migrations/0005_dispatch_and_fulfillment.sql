-- PROD-1B · W1 订单写闭包 3/6：派单 / 完成材料 / 接单事件 / 履约退出 / 服务事件
--
-- ## 这五张表为什么绑在一起
--
-- 它们全部挂在**同一张订单的同一段生命周期**上，而且**写它们的入口互相咬合**：
--
-- | 表 | 谁写 | 同一段原子区段里的邻居 |
-- |---|---|---|
-- | `dispatch_records`   | T2 `acceptDispatch` / T3 `releaseDispatch` / T4 `startServing` | 订单状态 + 通知 |
-- | `completion_submissions` | T5 提交 / T6 审核 / sweep | 订单 `completed` + **收益** |
-- | `companion_accept_events` | T2 | 派单 `accepted` + 订单 `accepted` + 通知 |
-- | `companion_release_records` | T3 / T8 | 派单回公共池 + 订单回池 |
-- | `companion_service_events` | T4 | 订单 `accepted → serving` |
--
-- `database-schema.md` 对每一张都写了「**必须与……同一个事务**」。分开迁＝半事务。
--
-- ## 两张事件表都是**只增不改**的
--
-- `companion_accept_events` 与 `companion_service_events` 记的是「**已经发生过的事**」：
-- 取消 / 换人 / 封禁释放 / 退款**都不回写、不删除**它们。
-- 因此这两张表**没有软删除列、没有 `updated_at`**——不是忘了加，
-- 是加了就会有人去更新它，而更新一段已经发生过的历史就是伪造历史。

CREATE TABLE dispatch_records (
  id                               text COLLATE "C" NOT NULL,
  order_id                         text NOT NULL,
  state                            text NOT NULL,

  -- ⚠️ 用户**指定**的人 ── 历史事实，永不被实际接单人覆盖，也永不清空
  exclusive_companion_id           text,
  exclusive_entered_at             timestamptz,
  exclusive_deadline_at            timestamptz,
  exclusive_timeout_minutes_snapshot integer,

  -- 公共池：**每次**进入都重写，并按那一刻的配置重新冻结快照
  public_pool_entered_at           timestamptz,
  public_deadline_at               timestamptz,
  public_timeout_minutes_snapshot  integer,

  -- 实际**接到**的人。⚠️ `state = 'timed_out'` 的记录上这三个字段**可能仍有旧值**
  --（P0-6 起的既有行为，本条刻意不改）——因此读者必须把 `state` 当第一道闸。
  accepted_by_companion_id         text,
  accepted_at                      timestamptz,
  accepted_via                     text,

  timed_out_at                     timestamptz,
  created_at                       timestamptz NOT NULL,
  updated_at                       timestamptz NOT NULL,

  CONSTRAINT dispatch_records_pkey PRIMARY KEY (id),
  -- 一张订单只有一条派单记录。换人**复用同一条**（因此 `accepted_by_companion_id`
  -- 会被改写，而事件表不会被改写）——两件事的差别正来自这条约束。
  CONSTRAINT dispatch_records_order_key UNIQUE (order_id),

  CONSTRAINT dispatch_records_state_check
    CHECK (state IN ('exclusive', 'public', 'accepted', 'timed_out')),
  -- ⚠️ **可空**：本列是 P1-5 才加上的，存量 `accepted` 记录上它是 null，
  --    与 `DispatchRecord.acceptedVia` 的 `| null` 一致。
  --    `database-schema.md` 的 TARGET 要求「NOT NULL + 存量回填 'unknown'」，
  --    但本轮**不得改业务数据**（Hard Rule 2），因此这里保留可空，
  --    并在 `03-delivery.md` 登记为「切换前必须完成的 TARGET 项」。
  CONSTRAINT dispatch_records_accepted_via_check
    CHECK (accepted_via IN ('companion', 'staff')),
  CONSTRAINT dispatch_records_timeouts_positive
    CHECK ((exclusive_timeout_minutes_snapshot IS NULL OR exclusive_timeout_minutes_snapshot > 0)
           AND (public_timeout_minutes_snapshot IS NULL OR public_timeout_minutes_snapshot > 0)),

  CONSTRAINT dispatch_records_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT dispatch_records_exclusive_companion_fkey
    FOREIGN KEY (exclusive_companion_id) REFERENCES companions (id),
  CONSTRAINT dispatch_records_accepted_by_fkey
    FOREIGN KEY (accepted_by_companion_id) REFERENCES companions (id)
);

-- 超时清扫（T7 `sweepDispatchTimeouts`）要扫「还没关、且已经到点」的派单。
-- `state` 在前是因为它把可扫集合缩到极小（绝大多数派单早已终结）。
CREATE INDEX dispatch_records_open_deadline_idx
  ON dispatch_records (state, public_deadline_at);

-- 管理员下架护航时扫他名下的单（T8 `releaseOrdersForCompanion`）。
CREATE INDEX dispatch_records_accepted_by_state_idx
  ON dispatch_records (accepted_by_companion_id, state);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE completion_submissions (
  id                            text COLLATE "C" NOT NULL,
  order_id                      text NOT NULL,
  companion_id                  text NOT NULL,
  summary                       text NOT NULL,
  evidence                      jsonb NOT NULL,
  status                        text NOT NULL,

  submitted_at                  timestamptz NOT NULL,
  auto_approval_minutes_snapshot integer NOT NULL,
  -- `submitted_at + 快照`。**冻结下来**，后台改配置不重算。
  auto_approval_deadline_at     timestamptz NOT NULL,

  review_source                 text,
  reviewed_by_staff_id          text,
  reviewed_by_name              text,
  reviewed_at                   timestamptz,
  reject_reason                 text,
  invalidated_at                timestamptz,

  CONSTRAINT completion_submissions_pkey PRIMARY KEY (id),

  CONSTRAINT completion_submissions_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated')),

  CONSTRAINT completion_submissions_review_source_check
    CHECK (review_source IN ('staff', 'system')),
  -- ⚠️ System 自动通过**没有审核人**（§T1 明文）。写成 CHECK 而不是靠调用方自觉：
  --    「系统自动通过却挂着一个审核员」会让审核责任指向一个没做决定的人。
  CONSTRAINT completion_submissions_system_has_no_reviewer
    CHECK (review_source IS DISTINCT FROM 'system' OR reviewed_by_staff_id IS NULL),
  -- 驳回必须说明原因。`btrim` 是为了把「一个空格」也算作没写。
  CONSTRAINT completion_submissions_reject_needs_reason
    CHECK (status <> 'rejected' OR (reject_reason IS NOT NULL AND btrim(reject_reason) <> '')),
  -- 完成说明 5～50 字（`countCharacters`）。`char_length` 按字符计，与之一致。
  CONSTRAINT completion_submissions_summary_length
    CHECK (char_length(summary) BETWEEN 5 AND 50),
  CONSTRAINT completion_submissions_auto_approval_positive
    CHECK (auto_approval_minutes_snapshot > 0),

  CONSTRAINT completion_submissions_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT completion_submissions_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id)
);

-- 「一单同时只有一份 pending 材料」——落点是**部分**唯一索引。
-- 写成表级 UNIQUE(order_id) 会连带禁止「被驳回后再交一份」以及全部历史记录，
-- 而那两件事都是正常业务（Mock 里它就是 `pendingSubmissionIdByOrder` 这个
-- **只在 pending 时存在**的键）。
CREATE UNIQUE INDEX completion_submissions_pending_order_key
  ON completion_submissions (order_id)
  WHERE status = 'pending';

-- 客服审核列表按「提交时间」排序，且只看 pending。
CREATE INDEX completion_submissions_pending_queue_idx
  ON completion_submissions (status, submitted_at, id);

-- 自动通过清扫扫描「还是 pending 且已经到点」的材料。
CREATE INDEX completion_submissions_auto_approval_idx
  ON completion_submissions (auto_approval_deadline_at)
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE companion_accept_events (
  id           text COLLATE "C" NOT NULL,
  dispatch_id  text NOT NULL,
  order_id     text NOT NULL,
  companion_id text NOT NULL,
  accepted_at  timestamptz NOT NULL,

  CONSTRAINT companion_accept_events_pkey PRIMARY KEY (id),

  CONSTRAINT companion_accept_events_dispatch_fkey
    FOREIGN KEY (dispatch_id) REFERENCES dispatch_records (id),
  CONSTRAINT companion_accept_events_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT companion_accept_events_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id)
);

-- 接单榜：按打手聚合、按周期切时间。列顺序与聚合方式对齐。
CREATE INDEX companion_accept_events_companion_time_idx
  ON companion_accept_events (companion_id, accepted_at);

-- ⚠️ **刻意不在 `dispatch_id` 上建唯一索引。**
-- `database-schema.md` T4 的唯一约束那一行写得很直接：
-- 「**不得**在 `dispatch_id` 上建唯一索引：一张单先后有多位接单人是**正常业务**。」
-- 换人（A 走 → B 接）复用的是**同一条**派单记录，两次接单都要留下。
-- 把唯一性建在这里，换人时第二次接单会直接写不进去。

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE companion_release_records (
  id              text COLLATE "C" NOT NULL,
  order_id        text NOT NULL,
  companion_id    text NOT NULL,
  source          text NOT NULL,
  reason          text,
  actor_id        text,
  created_at      timestamptz NOT NULL,
  -- ⚠️ 幂等键同样**不是实体字段**：Mock 里它只活在 `releaseIdByKey` 上
  --    （`mockCompanionReleaseRepository.ts`）。可空是因为 `releaseOrdersForCompanion`
  --    批量扫单那一次调用**没有**请求级幂等键。
  idempotency_key text,

  CONSTRAINT companion_release_records_pkey PRIMARY KEY (id),

  CONSTRAINT companion_release_records_source_check
    CHECK (source IN ('companion_cancel', 'companion_disabled', 'staff_reassign')),
  -- ⚠️ 主动取消**必须**说明原因（`01-prompt.md` §2.2）。
  --    另外两个 source 由系统 / 客服触发，那时没有「他自己写的一句话」，允许为空。
  CONSTRAINT companion_release_records_cancel_needs_reason
    CHECK (source <> 'companion_cancel' OR (reason IS NOT NULL AND btrim(reason) <> '')),

  CONSTRAINT companion_release_records_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT companion_release_records_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id)
);

-- 「同一打手 + 同一幂等键只产生一条退出记录」。`idempotency_key` 为 NULL 的行
-- 因默认 NULLS DISTINCT 而互不冲突，正是批量扫单那一支需要的。
CREATE UNIQUE INDEX companion_release_records_idempotency_key
  ON companion_release_records (companion_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 管理端订单详情的 `releaseHistory` 按订单读。
CREATE INDEX companion_release_records_order_idx
  ON companion_release_records (order_id, created_at, id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE companion_service_events (
  id                   text COLLATE "C" NOT NULL,
  order_id             text NOT NULL,
  companion_id         text NOT NULL,
  -- ⚠️ **不是唯一键**：换人复用同一条派单，因此同一单先后服务的两位打手
  --    会共享同一个 `dispatchId`。读不出来时**为 null，不编一个 id**。
  dispatch_id          text,
  serving_at           timestamptz NOT NULL,
  -- ⚠️ 这两个是**服务开始那一刻**的公开快照，不是当前值：
  --    A 被换成 B 之后，订单上的 `companion` 快照已经是 B 的了，
  --    A 的名字只能从这里读出来（「最近一次真实服务对应的那份历史公开快照」）。
  companion_name       text NOT NULL,
  companion_avatar_url text NOT NULL,

  CONSTRAINT companion_service_events_pkey PRIMARY KEY (id),

  -- ✅ 与接单事件相反：**这一张可以也应该建唯一约束**。
  -- `database-schema.md` T4c：「`(order_id, companion_id, serving_at)` 可建唯一约束——
  -- 它正是『同一服务段只记一次』这条规则，在 DB 层应当由约束保证而不是靠应用层查重。」
  CONSTRAINT companion_service_events_segment_key
    UNIQUE (order_id, companion_id, serving_at),

  CONSTRAINT companion_service_events_order_fkey
    FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT companion_service_events_companion_fkey
    FOREIGN KEY (companion_id) REFERENCES companions (id),
  CONSTRAINT companion_service_events_dispatch_fkey
    FOREIGN KEY (dispatch_id) REFERENCES dispatch_records (id)
);

-- 「常用打手」按打手聚合、取最近一次。
CREATE INDEX companion_service_events_companion_time_idx
  ON companion_service_events (companion_id, serving_at);
