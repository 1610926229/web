-- PROD-1C · 管理端审计（AdminAudit）PostgreSQL 持久化
--
-- ## 这张表是 PROD-1B 延期的**那一根线**
--
-- PROD-1B 把订单写闭包交给了 PostgreSQL，唯独把 T8 / T14 / T15 三个事务留在了 Mock，
-- 登记的理由是 `Pg implementation deferred because full atomic write closure crosses
-- PROD-1B boundary`。那条边界就是这张表：三个事务在**写完业务数据之后**还要写一条
-- 管理审计，而审计当时还没有表，于是闭包跨过了「已建的 17 张表」这个范围。
--
-- 本轮把这张表建出来，三个事务的闭包随之闭合。**审计不是日志**——
-- 它是这三个事务的**参与者**，理由有三条，缺一条这张表都可以不做：
--
-- 1. **幂等账本**：`takeReplay` / `takeReplayForAction` / `takeCreateReplay`
--    （`lib/data/adminWriteSupport.ts`）全部经 `findAuditEntryByOperationId` 判定
--    「同一个幂等键是否已经做过这件事」。因此 `operation_id` 上的唯一约束不是索引优化，
--    它就是幂等本身——业务幂等键的落点在这张表里。
-- 2. **强一致写入**：业务改动与审计必须同生共死。审计没写进去，事后没有人知道
--    当时到底发生了什么；而「先改业务、再补审计」留下的正是「改了却没有记录」的状态。
--    因此两者必须在**同一个 BEGIN … COMMIT** 里。
-- 3. **读回来做判定**：重放判定读的就是这张表的既有行，所以它既写又读。
--
-- ## 为什么没有 `action` / `target_type` 的枚举 CHECK
--
-- `AdminAuditAction` 是一个长联合（30 余个取值），`AdminAuditTargetType` 有 14 个。
-- 把它们枚举进 CHECK 意味着**每加一个后台动作都要开一次迁移**，而 TypeScript 的类型
-- 联合已经是唯一真值源、Mock 侧从来没有这条校验。加了它，只会把「加一个动作」的成本
-- 从「改一行类型」变成「改类型 + 写迁移」，而收益为零——写错的取值在编译期就进不来。
--
-- ⚠️ 这与本仓其它表的做法**不矛盾**：`refund_requests.decision` 的 CHECK 挡的是
-- 「金额算错了」这类**数值不变式**，那才是类型系统管不住的（类型说 `number`，
-- 说不出 `floor(实付 × 比例 / 10000)`）。枚举取值的形状交给类型。
--
-- ## 为什么没有 `(actor_id, action, target_type, target_id)` 唯一约束
--
-- 因为那位管理员**可以**对同一个目标反复做同一个动作：停用 → 启用 → 再停用，
-- 三次都是 `actor_id` 同上、`target_type='companion'`、`target_id` 同上、
-- `action ∈ {companion.disable, companion.enable, companion.disable}`。
-- 加这条唯一约束等于**改业务规则**（Hard Rule 3 禁止），而不是加固持久化。
--
-- 真正该唯一的轴只有一条：**幂等键**。同一次操作意图重复到达时，靠它认出「做过了」。

CREATE TABLE admin_audit_entries (
  id            text COLLATE "C" NOT NULL,

  -- 操作者三件套。⚠️ `actor_id` 可能是 `AdminAccount.id`，也可能是 `StaffAccount.id`
  -- （客服侧从 P8D-2 起也写这张表），因此**必须连 `actor_role` 一起读**才知道去哪张表查。
  -- 这个形状与 `refund_requests.reviewed_by` / `reviewed_by_role` 是同一条纪律。
  actor_id      text NOT NULL,
  actor_role    text NOT NULL,
  -- 操作者当时的显示名称快照。**可空**——管理员侧本阶段为 null（见 `lib/types/adminAudit.ts`）。
  actor_name    text,

  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text NOT NULL,

  -- 变更前后的精简快照。**可空**，因为不是每种动作都有「之前」：
  -- 新建类动作（`takeCreateReplay` 服务的那几个）在写入前没有对象。
  --
  -- ⚠️ 快照是**对象**，不是标量也不是数组——类型是
  -- `Record<string, string | number | boolean | null>`。形状写进约束的理由与
  -- `refund_requests.decision` 同：类型在编译后就没了，而这一列会一直躺在库里被对账读。
  before        jsonb,
  after         jsonb,

  -- ## 幂等键
  --
  -- ⚠️ 它**不是实体字段**：`AdminAuditEntry.operationId` 直接就是调用方给的幂等键
  --    （`writeAudit` 里 `operationId: input.ctx.operationId`），而
  --    `lib/types/adminAudit.ts` 的实体上也没有第二个「幂等」概念。
  --    Mock 里它只活在 `adminAuditStore().auditIdByOperationId` 这张索引上。
  operation_id  text NOT NULL,

  -- 事件发生的时刻（服务端传入的 `ctx.at`），不是「谁碰巧写了这一行」的时刻。
  created_at    timestamptz NOT NULL,

  CONSTRAINT admin_audit_entries_pkey PRIMARY KEY (id),

  -- ## 这条约束就是幂等账本本身
  --
  -- 「同一个幂等键第二次到达 ⇒ 认出已做过」这条规则的**唯一**存储层落点。
  -- 没有它，两个并发请求会双双插入、双双认为自己是第一次。
  --
  -- ⚠️ 写入侧**不得**写 `ON CONFLICT DO NOTHING`（与 `notifications` 同一条纪律）：
  --    Mock 的 `appendAuditEntry` 在同一个键第二次到达时会**覆盖**索引指向，
  --    而 PostgreSQL 这里必须**拒绝**——一次审计被另一条记录顶掉，
  --    等于把「当时发生了什么」改写成另一件事。冲突时整段事务回滚，把 bug 暴露出来。
  CONSTRAINT admin_audit_entries_operation_key UNIQUE (operation_id),

  -- `ActorRole` 是封闭二值域（`lib/types/actor.ts`），与
  -- `refund_requests_reviewer_role_check` 同构。
  CONSTRAINT admin_audit_entries_actor_role_check
    CHECK (actor_role IN ('admin', 'customer_service')),

  -- 快照的形状（`before` / `after` 各自）。`jsonb_typeof` 对 NULL 返回 NULL，
  -- 因此必须先判 `IS NULL` 再判类型——否则 NULL 会落进 NULL 分支而约束**不拦**。
  CONSTRAINT admin_audit_entries_before_shape
    CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  CONSTRAINT admin_audit_entries_after_shape
    CHECK (after IS NULL OR jsonb_typeof(after) = 'object'),

  -- ## 空串守卫
  --
  -- 四列都是**身份或键**，空串不是这些列的一个取值：
  -- `action` 来自动作联合、`target_type` 来自目标类型联合、
  -- `actor_id` 来自会话、`operation_id` 来自服务层校验过格式的幂等键
  -- （`IDEMPOTENCY_KEY_PATTERN`）。任何一处为空都说明调用方拼错了 `ctx` 或传错了动作名，
  -- 而一条「谁做的、做了什么、对应哪个键」都答不出来的审计记录，
  -- 比没有这条记录更糟——它会让 `countAudits()` 这类断言假绿。
  CONSTRAINT admin_audit_entries_action_nonempty    CHECK (action <> ''),
  CONSTRAINT admin_audit_entries_target_type_nonempty CHECK (target_type <> ''),
  CONSTRAINT admin_audit_entries_target_id_nonempty  CHECK (target_id <> ''),
  CONSTRAINT admin_audit_entries_actor_id_nonempty   CHECK (actor_id <> ''),
  CONSTRAINT admin_audit_entries_operation_nonempty  CHECK (operation_id <> '')
);

-- `listAudits({ targetType, targetId })` 是这张表**唯一**被真实使用的查询形状
-- （「这条护航 / 这份申请经历过什么」）。`created_at, id` 进索引是给排序用的：
-- Mock 的读出顺序是插入顺序，SQL 的 `ORDER BY` 没有稳定排序保证，
-- 同刻的两条必须由 `id` 兜底，否则同一个问题两次问出不同答案。
CREATE INDEX admin_audit_entries_target_idx
  ON admin_audit_entries (target_type, target_id, created_at, id);
