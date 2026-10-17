-- PROD-1E · Wave A 7/7：会话、消息与客服已读
--
-- ## 会话是**第一等实体**，不是「按订单分组的消息」
--
-- ⚠️ `docs/02-tech-design/database-schema.md` §11（第 513–533 行）描述的是**旧模型**
-- （主键 `orderId`、单个已读状态）。P0-14 之后代码里的模型已经不同，**以代码为准**
-- （`lib/types/message.ts` + `mockMessageRepository.ts`）：
--
-- | 维度 | 旧模型 | 当前代码 |
-- |---|---|---|
-- | 会话主键 | `orderId` | `conversation.id` |
-- | 一段订单的会话数 | 1 | **多段**（一段履约一段，客服会话再一段） |
-- | 已读状态 | 1 份 | **3 份**（用户 / 打手 / 客服，见下） |
--
-- 这条不一致本轮只登记、不修文档之外的任何东西（Hard Rule 2：历史 bug 与文档漂移不顺手改）。
--
-- ## 冻结的会话规则（全部落进本表的形状里）
--
-- 1. **按履约段分会话**：`assignment_key` = `${orderId}#s${assignmentSeq}`，
--    `assignment_seq` 是该订单「履约退出历史」的条数。换打手 ⇒ seq +1 ⇒ 键当刻变化。
-- 2. **A→B→A 是不同会话**：同一位打手两次履约落在**不同 seq** 上，因此是两条记录。
-- 3. **旧打手失去未来访问**：不是靠删除或失效标记，而是访问判定要比对
--    `conversation.assignment_key === 现算的 currentAssignmentKey`——那条判定在服务层
--    （`canCompanionAccessConversation`），**不进这张表**：数据还在，权限没了。
-- 4. **历史分段只读**、**全额退款后只读**都是**读时推导**的（`isReadOnly`），
--    **没有**「只读」列——落一个这样的列，就得有人负责在退款那一刻把它翻过来，
--    而漏翻一次的表现是「全额退款后还能发言」。
-- 5. **客服会话独立**：kind = `service`，三个 assignment 字段恒 NULL，且**永远可写**。

CREATE TABLE conversations (
  id           text COLLATE "C" NOT NULL,
  order_id     text NOT NULL,
  user_id      text NOT NULL,
  kind         text NOT NULL,

  -- 三个 assignment 字段在 `service` 会话上**恒为 NULL**，在 `assignment` 上**恒非 NULL**。
  assignment_key   text,
  assignment_seq   integer,
  companion_id     text,

  created_at   timestamptz NOT NULL,
  -- 已读游标（各端各一份，只前进不后退）。NULL = 从未读过。
  user_last_read_at      timestamptz,
  -- 客服侧**没有**这一列：客服游标按「订单」记，不按段（见 `staff_reads`）。
  companion_last_read_at timestamptz,

  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_kind_check CHECK (kind IN ('service', 'assignment')),
  -- 会话种类与三个 assignment 字段**互为充要条件**：
  -- `service` ⇒ 三个全 NULL；`assignment` ⇒ 三个全非 NULL。
  -- 写成双向等值，是为了让「半个 assignment 会话」在数据库层就写不进去。
  CONSTRAINT conversations_assignment_fields_iff_assignment
    CHECK ((kind = 'assignment') =
           (assignment_key IS NOT NULL
            AND assignment_seq IS NOT NULL
            AND companion_id IS NOT NULL)),
  CONSTRAINT conversations_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- ⚠️ 「订单 + 种类 + 履约段」唯一——但**不能**写成表级 UNIQUE：
--    `service` 会话的三个 assignment 字段是 NULL，而 PostgreSQL 默认 NULLS DISTINCT
--    会让「同一订单的两条 service 会话」互不冲突，唯一性就形同虚设。
--    用两条**部分**唯一索引分别覆盖两种 kind，各自的判据都是逐字非空列。
CREATE UNIQUE INDEX conversations_service_key
  ON conversations (order_id)
  WHERE kind = 'service';

CREATE UNIQUE INDEX conversations_assignment_key
  ON conversations (order_id, assignment_key)
  WHERE kind = 'assignment';

-- 打手侧：按 `companionId` 取他参与过的会话。
CREATE INDEX conversations_companion_idx
  ON conversations (companion_id)
  WHERE kind = 'assignment';

-- 按订单取全部会话（用户端分组、客服端代表会话判定）。
CREATE INDEX conversations_order_idx
  ON conversations (order_id, id);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE messages (
  id                 text COLLATE "C" NOT NULL,
  conversation_id    text NOT NULL,
  -- ⚠️ 冗余存订单与用户：打手/客服发的消息也记**下单用户**，
  --    用户侧因此可以按 `userId` 直读，不必先 join 会话。
  order_id           text NOT NULL,
  user_id            text NOT NULL,

  sender_id          text NOT NULL,
  sender_role        text NOT NULL,
  -- 发送时名称 / 头像**快照**：发言人后来改名，历史消息仍是当时的名字。
  sender_name        text NOT NULL,
  sender_avatar_url  text NOT NULL,
  body               text NOT NULL,
  created_at         timestamptz NOT NULL,

  -- 幂等键不是实体字段：Mock 里它只活在 `messageIdByKey` 上。
  idempotency_key    text,

  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_sender_role_check
    CHECK (sender_role IN ('user', 'companion', 'customer_service')),
  CONSTRAINT messages_conversation_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

-- ⚠️ 幂等键的作用域是**会话**，不是订单（P0-14 从「订单」收窄到「会话」）：
--    同一个用户在客服会话与某一段履约会话里各发一条「在吗」，是两个不同的动作。
CREATE UNIQUE INDEX messages_idempotency_key
  ON messages (conversation_id, sender_id, idempotency_key);

-- 单段消息按时间**升序**、`id` 升序兜底（`readMessagesOfConversation`）。
CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at, id);

-- ─────────────────────────────────────────────────────────────────────────────

-- 客服已读游标：**按订单**记，不按履约段（`StaffReadRecord`）。
-- ⚠️ 客服看到的是「这个订单的整条对话」（跨段合并），因此游标锚在订单上；
--    与用户/打手的按段游标是**两套不同的语义**，不能合并成一张表。
CREATE TABLE staff_reads (
  order_id      text COLLATE "C" NOT NULL,
  staff_id      text NOT NULL,
  last_read_at  timestamptz NOT NULL,

  CONSTRAINT staff_reads_pkey PRIMARY KEY (order_id, staff_id),
  CONSTRAINT staff_reads_order_fkey FOREIGN KEY (order_id) REFERENCES orders (id)
);

-- 客服工作台：取某客服的全部已读游标（`listStaffReads`）。
CREATE INDEX staff_reads_staff_idx
  ON staff_reads (staff_id);
