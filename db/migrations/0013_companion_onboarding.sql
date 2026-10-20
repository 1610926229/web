-- PROD-1E · Wave A 4/7：入驻申请与用户资格
--
-- ## 这两张表为什么在一起
--
-- `approveCompanionApplication`（`lib/data/adminCompanionTransaction.ts:330`）是**全仓唯一**
-- 一段「一次写四个 store」的伪事务：申请状态 + 资格发放 + 建立护航资料 + 审计，
-- 全在同一个无 `await` 的区段里。落库之后它就是**一个 PostgreSQL 事务**。
-- 因此这两张表必须在同一个迁移里一起定义——它们的写入永远同生共死。
--
-- ## 「一个人最多一条申请」与「一个人最多一条有效资格」是两种不同的唯一性
--
-- | 约束 | 落点 |
-- |---|---|
-- | 一个用户最多一条申请（不分状态） | `companion_applications.user_id` **全局**唯一 |
-- | 一个用户最多一条某角色的资格 | `user_qualifications` 自然主键 `(user_id, role)` |
--
-- 申请那条是**全局**的：Mock 的 `applicationIdByUser` 是一个键为 `userId` 的 Map，
-- 撤销（`withdrawn`）**不删键**，因此「撤销后重新申请」走的是**同一条记录**的状态回迁，
-- 不是新建第二条。索引与它同口径，**不加** `WHERE status <> 'withdrawn'`。

CREATE TABLE companion_applications (
  id              text COLLATE "C" NOT NULL,
  application_no  text NOT NULL,
  user_id         text NOT NULL,

  display_name    text NOT NULL,
  game_ids        jsonb NOT NULL,
  regions         jsonb NOT NULL,
  service_tags    jsonb NOT NULL,
  experience      text NOT NULL,
  introduction    text NOT NULL,
  -- Mock 的纯文本联系说明，可为**空串**。
  contact_note    text NOT NULL,
  -- 凭证（`SupportEvidence[]`）。值对象数组，无独立生命周期 ⇒ jsonb。
  evidence        jsonb NOT NULL,

  status          text NOT NULL,
  submitted_at    timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  -- 有审核结果之前为 NULL。
  reviewed_at     timestamptz,
  -- 无结果时空串，**不是** NULL（与 Mock 一致）。
  review_note     text NOT NULL,

  -- 幂等键不是实体字段：Mock 里它只活在 `applicationIdByKey` 上，预置数据写 NULL。
  idempotency_key text,

  CONSTRAINT companion_applications_pkey PRIMARY KEY (id),
  CONSTRAINT companion_applications_status_check
    CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected', 'withdrawn')),
  -- 「已审」与「有审核时间」互为充要条件：终态 `approved`/`rejected` 必须有时间，
  -- 其余状态必须没有。写成双向等值，而不是「终态必须有时间」的单向蕴含——
  -- 单向的话，一条 `pending` 记录可以带着一个审核时间去到处传播。
  CONSTRAINT companion_applications_reviewed_at_iff_settled
    CHECK ((status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL))
);

-- 「一个人最多一条申请」——全局唯一，含已撤销的。
CREATE UNIQUE INDEX companion_applications_user_key
  ON companion_applications (user_id);

-- 「同一个用户 + 同一幂等键只产生一条申请」。
CREATE UNIQUE INDEX companion_applications_idempotency_key
  ON companion_applications (user_id, idempotency_key);

-- 后台申请队列：按提交时间倒序、`id` **升序**兜底（`compareApplicationsForAdmin`）。
CREATE INDEX companion_applications_admin_order_idx
  ON companion_applications (submitted_at DESC, id);

-- ─────────────────────────────────────────────────────────────────────────────

-- 用户资格。**没有单列 id**：自然键 `(user_id, role)` 就是主键。
-- 「老板」（consumer）是默认身份，**不在这张表里**——它是「没有记录」的含义。
CREATE TABLE user_qualifications (
  user_id             text COLLATE "C" NOT NULL,
  role                text NOT NULL,
  companion_id        text NOT NULL,
  application_id      text NOT NULL,
  granted_at          timestamptz NOT NULL,
  granted_by_admin_id text NOT NULL,

  CONSTRAINT user_qualifications_pkey PRIMARY KEY (user_id, role),
  CONSTRAINT user_qualifications_role_check CHECK (role IN ('companion'))
);

-- 追溯用：这一条资格由哪次申请批准产生。
CREATE INDEX user_qualifications_application_idx
  ON user_qualifications (application_id);
