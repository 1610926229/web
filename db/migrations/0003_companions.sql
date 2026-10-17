-- PROD-1B · W1 订单写闭包 1/6：护航（Companion）
--
-- ## 为什么这张表在本轮范围内
--
-- 严格说 `companions` 的**写者**中，属于 W1 的只有 T8（`setCompanionFlags` → `releaseOrdersForCompanion`），
-- 而 T8 的原子段里含 `writeAudit`，按本轮裁定（02-decisions Q1 规则 10）**不产出 Pg 事务**。
-- 那这张表为什么还要建？
--
-- 因为 `acceptDispatch`（T2，`lib/data/companionDispatchTransaction.ts:266`）在**原子区段内**
-- 调用 `readCompanionRecord(ctx.companionId)`，用 `isCompanionAcceptingOrders()` 决定这一单能不能被接走，
-- 并在同段内比对 `companion.userId !== null && order.userId === companion.userId` 拒绝自接单
-- （EX-DISPATCH-08）。**写事务里的这一读，必须与写同库**——否则「读 Mock 的资格、写 PG 的派单」
-- 就是一个真实的半事务窗口：管理员在下架他的同时，PG 这边刚把他写成接单人。
--
-- 它是本轮的**事务内读参与者**，不是「为了 FK 完整性顺手牵进来的业务域」。
-- 本表的关键约束（一人一条有效护航、软删除不物理删）来自需求，不是本轮的发明。
--
-- ## 时间列一律 timestamptz（C8）
-- 与 `0001_favorites.sql` 同理：内部 UTC，驱动层 setTypeParser(1184) 统一还原成 ISO 字符串，
-- 仓储边界上的类型与 Mock 完全一致（都是 string），上层比较逻辑一个字不用改。

CREATE TABLE companions (
  id                     text COLLATE "C" NOT NULL,

  -- ⚠️ 闭包外引用：`users` 本轮不迁。按 02-decisions Q1 规则 13c 以**稳定 ID 文本**存储、暂不建 FK。
  --    预置数据里大量为 NULL（`companionSeed` 的 `cp-*`），这是既有的真实事实，不是缺数据。
  user_id                text,
  -- 同上：`companion_applications` 本轮不迁。
  application_id         text,

  -- 软移除时刻。**移除不是删除记录**：历史订单、评价、鸡腿记录都要继续指得到它。
  removed_at             timestamptz,

  display_name           text NOT NULL,
  avatar_url             text NOT NULL,
  rank_label             text NOT NULL,
  intro                  text NOT NULL,

  -- 三个字符串数组。本轮用 jsonb：没有查询按元素筛选的需求，拆表只会多两张没有任何
  -- 独立生命周期的表。将来若出现「按游戏筛护航」这类查询，再迁成 join 表。
  game_ids               jsonb NOT NULL,
  regions                jsonb NOT NULL,
  service_tags           jsonb NOT NULL,

  -- ⚠️ `available` 与 `enabled` 是**两个不同的权限**，不可合并：
  --    enabled   = 是否仍具有效打手资格（在不在架）
  --    available = 是否当前允许接受**新**订单
  --    「已停用但可接单」的记录在结算页会解释不清，因此 disable 会强制把两者一起置 false。
  available              boolean NOT NULL,
  unavailable_reason     text    NOT NULL,
  enabled                boolean NOT NULL,

  completed_order_count  integer NOT NULL,
  tips_count             integer NOT NULL,
  sort_order             integer NOT NULL,

  CONSTRAINT companions_pkey PRIMARY KEY (id)
);

-- ⚠️ 「一名用户最多关联一条**有效**护航」——必须是**部分**唯一索引。
--
-- `mockCompanionRepository` 里它是 `companionIdByUser` 这个 Map，而且**移除时会把键删掉**
-- （`database-schema.md:105`）：不删的话「移除后重新入驻」会被自己的历史记录挡住。
-- 部分唯一索引表达的正是同一件事，而且不需要任何应用侧记得去删键。
--
-- WHERE 里只需要写 removed_at IS NULL：PostgreSQL 的默认语义是 **NULLS DISTINCT**，
-- 因此 user_id 为 NULL 的行彼此不冲突——这正是预置数据（大量 null）需要的。
CREATE UNIQUE INDEX companions_user_active_key
  ON companions (user_id)
  WHERE removed_at IS NULL;

-- 护航列表的排序键：`sortOrder` 升序，相等时按 id 兜底（`compareCompanions` 的契约）。
-- 列顺序与 ORDER BY 对齐，列表查询才不会退化成全表排序。
CREATE INDEX companions_listed_order_idx
  ON companions (sort_order, id);
