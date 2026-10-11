import { serviceConversationId } from "@/lib/constants/conversations";
import type {
  ConversationKind,
  MessageSenderRole,
  OrderConversationRecord,
  OrderMessage,
  StaffReadRecord,
} from "@/lib/types/message";
import type { MessageRepository } from "../messageRepository";
import { lazyPgExecutor, type PgQueryable } from "./executor";

/**
 * `MessageRepository` 的 PostgreSQL 实现。
 *
 * ⚠️ **契约与 Mock 实现完全相同**：`lib/data/messageRepository.ts` 里那 20 个方法
 * 一个字没改，服务层、路由、页面都不知道底下换了一个存储（PROD-1B 的
 * 「同一套契约、两个实现」在这里同样成立）。
 *
 * ## 冻结的会话规则在这里怎么落
 *
 * 规则本身**不在本文件里**，只在 `lib/constants/conversations.ts` 定义；本文件只把
 * 那张表的形状如实读出来、写进去。逐条对齐如下（编号见 `db/migrations/0016_conversations.sql`）：
 *
 * 1. **按履约段分会话**：`assignment_key` = `${orderId}#s${assignmentSeq}`。写入时
 *    `ensureAssignmentConversation` 把调用方传来的 `assignmentKey` 原样落库；
 *    会话 id 也取这个键（与 `mockMessageRepository` 一致，不另造前缀）——
 *    id 的构造规则归 `assignmentConversationId` / `serviceConversationId`，本文件不自己拼串。
 * 2. **客服会话 `kind='service'`，三个 assignment 字段恒 NULL**，id 沿用订单号
 *    （`serviceConversationId`）。`conversations_assignment_fields_iff_assignment`
 *    这条 CHECK 让「半个 assignment 会话」在数据库层就写不进去。
 * 3. **A→B→A 是不同会话**：靠 `assignment_seq` 区分，本文件只负责把 `seq` 存进
 *    `assignment_seq` 并原样读出，不做任何推断。
 * 4. **「旧打手失去访问」「历史分段只读」「全额退款只读」都是读时推导**，**没有**对应列。
 *    本文件**不判断权限**、不筛掉失效的段：记在打手名下的段（含已失效的）全部读得出来，
 *    该不该给他看由服务层调 `canCompanionAccessConversation` / `isOrderChatClosed` 决定。
 *    数据还在、权限没了——这两件事分属两层。
 *
 * ## 幂等：把 Mock 的「读—判断—写」换成唯一索引
 *
 * Mock 的原子性来自「Node 单线程 + 区段内没有 await」。换成数据库后那段代码里的每个
 * 查询都会让出执行权，区段不再原子。因此两个 `ensure*` 与 `createMessage` 都改成
 * **单条 `INSERT … ON CONFLICT DO NOTHING RETURNING` + 冲突后回读**：
 * 判重交给迁移里的部分唯一索引（`conversations_service_key` /
 * `conversations_assignment_key`）与 `messages_idempotency_key`，不再靠应用层先查后写。
 *
 * ## 排序必须完全确定
 *
 * Mock 的 `readMessagesOfConversation` / `readMessagesOfOrder` 是稳定排序的 JS `sort`，
 * SQL 的 `ORDER BY` 不是。每个 `ORDER BY` 都补了 `id` 兜底 tie-break，并与比较器逐字段对齐。
 * ⚠️ `listConversations` / `listConversationsForStaff` /
 * `listAssignmentConversationsForCompanion` 在 Mock 里是「遍历 Map 的插入顺序」——
 * **SQL 没有那层含义**，这里用 `created_at, id` 补一个确定序。这是**有意的取舍**：
 * 与 Mock 的「插入顺序」不同，请勿依赖具体先后，只依赖「同一份数据顺序稳定」。
 *
 * ## 时间与类型
 *
 * `created_at` / `*_last_read_at` 是 `timestamptz`，经 `pool.ts` 的解析器钩子统一还原成
 * ISO 字符串，因此领域对象上的时间字段仍是 `string`，与 Mock 完全一致（可直接字典序比较）。
 */

type ConversationRow = {
  id: string;
  order_id: string;
  user_id: string;
  kind: ConversationKind;
  assignment_key: string | null;
  assignment_seq: number | null;
  companion_id: string | null;
  created_at: string;
  user_last_read_at: string | null;
  companion_last_read_at: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  order_id: string;
  user_id: string;
  sender_id: string;
  sender_role: MessageSenderRole;
  sender_name: string;
  sender_avatar_url: string;
  body: string;
  created_at: string;
};

type StaffReadRow = {
  order_id: string;
  staff_id: string;
  last_read_at: string;
};

/**
 * 领域对象会读到的列。
 *
 * ⚠️ `messages` 的列清单**不含 `idempotency_key`**：它不是实体字段，
 * 在 Mock 里只活在 `messageIdByKey` 索引上（见 `mockMessageRepository.ts`）。
 * 只在筛选（`findMessageByKey`）与写入时用到它，读回领域对象时把它排除在外。
 */
const CONVERSATION_COLUMNS =
  "id, order_id, user_id, kind, assignment_key, assignment_seq, companion_id, " +
  "created_at, user_last_read_at, companion_last_read_at";

const MESSAGE_COLUMNS =
  "id, conversation_id, order_id, user_id, sender_id, sender_role, " +
  "sender_name, sender_avatar_url, body, created_at";

const STAFF_READ_COLUMNS = "order_id, staff_id, last_read_at";

function toConversation(row: ConversationRow): OrderConversationRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    userId: row.user_id,
    kind: row.kind,
    assignmentKey: row.assignment_key,
    assignmentSeq: row.assignment_seq,
    companionId: row.companion_id,
    createdAt: row.created_at,
    userLastReadAt: row.user_last_read_at,
    companionLastReadAt: row.companion_last_read_at,
  };
}

function toMessage(row: MessageRow): OrderMessage {
  return {
    id: row.id,
    orderId: row.order_id,
    userId: row.user_id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    senderName: row.sender_name,
    senderAvatarUrl: row.sender_avatar_url,
    body: row.body,
    createdAt: row.created_at,
    conversationId: row.conversation_id,
  };
}

function toStaffRead(row: StaffReadRow): StaffReadRecord {
  return { orderId: row.order_id, staffId: row.staff_id, lastReadAt: row.last_read_at };
}

/**
 * 用任意可执行 SQL 的对象造一个消息仓储。
 *
 * 与投诉 / 退款同构：**一个工厂同时产出普通仓储与事务内仓储**。传
 * `withTransaction` 给出的 `TxHandle` 进来，就能让「建会话 + 发消息」与同一事务里的
 * 其它写入共享同一条连接、同一个提交点。
 */
export function createMessageRepository(db: PgQueryable): MessageRepository {
  /** 按幂等键读回既有消息。键的作用域是「会话 + 发送者」（`messages_idempotency_key`）。 */
  async function findMessageByKey(
    conversationId: string,
    senderId: string,
    idempotencyKey: string,
  ): Promise<OrderMessage | null> {
    // `idempotency_key = $3` 永远匹配不到 NULL，预置数据（写 NULL）因此与 Mock 一致
    const rows = await db.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
        WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
      [conversationId, senderId, idempotencyKey],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }

  return {
    // ————————————————————— 用户侧 —————————————————————

    async listConversations(userId) {
      // ⚠️ Mock 是「遍历 Map 的插入顺序」，SQL 无此含义。用 `created_at, id` 确定性化。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE user_id = $1
          ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return rows.map(toConversation);
    },

    async listConversationsByOrder(userId, orderId) {
      // 与 `compareConversationsWithinOrder` 对齐：客服会话恒第一，其后按 `assignment_seq` 升序。
      // `(kind = 'service') DESC` 让 service 在前（Postgres 里 true > false）；
      // `assignment_seq` 对 service 行是 NULL，但第一键已把它们区分开。`id ASC` 是兜底。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1 AND user_id = $2
          ORDER BY (kind = 'service') DESC, assignment_seq ASC, id ASC`,
        [orderId, userId],
      );
      return rows.map(toConversation);
    },

    async ensureConversation(userId, orderId, createdAt) {
      // 客服会话 id = 订单号（`serviceConversationId`，Mock 同源）。不自己拼前缀。
      const id = serviceConversationId(orderId);

      // 冲突目标指向部分唯一索引 `conversations_service_key`（`ORDER BY order_id WHERE kind='service'`）：
      // 已存在就什么都不做，回读既有记录，**不改创建时间、不抹已读位置**（Mock 语义）。
      const inserted = await db.query<ConversationRow>(
        `INSERT INTO conversations (id, order_id, user_id, kind, created_at)
         VALUES ($1, $2, $3, 'service', $4::timestamptz)
         ON CONFLICT (order_id) WHERE kind = 'service' DO NOTHING
         RETURNING ${CONVERSATION_COLUMNS}`,
        [id, orderId, userId, createdAt],
      );
      if (inserted[0]) return toConversation(inserted[0]);

      const existing = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1 AND kind = 'service'
          LIMIT 1`,
        [orderId],
      );
      if (existing[0]) return toConversation(existing[0]);

      throw new Error(
        `客服会话写入在并发下未能收敛（订单 ${orderId}）。`,
      );
    },

    async listMessages(userId, orderId) {
      // Mock：这一单没有任何属于该用户的会话时返回空数组（「别人的订单」＝「看不到」）。
      // 归属用 `EXISTS` 判，不把会话 join 进来复制消息行。
      const rows = await db.query<MessageRow>(
        `SELECT m.id, m.conversation_id, m.order_id, m.user_id, m.sender_id, m.sender_role,
                m.sender_name, m.sender_avatar_url, m.body, m.created_at
           FROM messages m
          WHERE m.order_id = $2
            AND EXISTS (
              SELECT 1 FROM conversations c
               WHERE c.order_id = $2 AND c.user_id = $1
            )
          ORDER BY m.created_at ASC, m.id ASC`,
        [userId, orderId],
      );
      return rows.map(toMessage);
    },

    async listMessagesGrouped(userId) {
      // ⚠️ 键集合必须来自**会话**，不能来自消息：一段「存在但还没有消息」的会话
      // （如 `ord-seed-1001-07`）在 Mock 里是 `orderId → []` 的键。只查消息会漏掉它。
      const conversations = await db.query<{ order_id: string }>(
        `SELECT order_id FROM conversations
          WHERE user_id = $1
          ORDER BY created_at ASC, id ASC`,
        [userId],
      );

      const grouped = new Map<string, OrderMessage[]>();
      for (const row of conversations) {
        if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
      }
      if (grouped.size === 0) return grouped;

      // 一次取完这几个订单的全部消息，按订单号分组，组内时间升序、id 升序（= `readMessagesOfOrder`）
      const messages = await db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          WHERE order_id IN (SELECT DISTINCT order_id FROM conversations WHERE user_id = $1)
          ORDER BY order_id ASC, created_at ASC, id ASC`,
        [userId],
      );
      for (const row of messages) {
        const list = grouped.get(row.order_id);
        if (list) list.push(toMessage(row));
      }
      return grouped;
    },

    async createMessage(message, idempotencyKey) {
      // ⚠️ 单条语句内完成「校验归属 + 幂等写入」：
      //   `WHERE EXISTS` 要求会话存在、且 `user_id` / `order_id` **逐项**与消息对得上
      //   （Mock 的三个判据），不成立时 SELECT 不产出任何行，等于什么都没插；
      //   `ON CONFLICT DO NOTHING` 把幂等交给唯一索引 `messages_idempotency_key`。
      // 合在一条语句里，是为了不重演 Mock「先查、再判、后写」那段一旦 await 就不再原子的区段。
      const inserted = await db.query<MessageRow>(
        `INSERT INTO messages
           (id, conversation_id, order_id, user_id, sender_id, sender_role,
            sender_name, sender_avatar_url, body, created_at, idempotency_key)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
                $7::text, $8::text, $9::text, $10::timestamptz, $11::text
          WHERE EXISTS (
            SELECT 1 FROM conversations c
             WHERE c.id = $2 AND c.user_id = $4 AND c.order_id = $3
          )
         ON CONFLICT DO NOTHING
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          message.id,
          message.conversationId,
          message.orderId,
          message.userId,
          message.senderId,
          message.senderRole,
          message.senderName,
          message.senderAvatarUrl,
          message.body,
          message.createdAt,
          idempotencyKey,
        ],
      );
      if (inserted[0]) return { message: toMessage(inserted[0]), created: true };

      // 空结果有两种成因：幂等键命中（返回既有消息，created=false）或会话缺失/不匹配（返回 null）。
      // 先按幂等键回读；回读不到再确认会话：不匹配 → null（业务结果，不抛错），
      // 匹配却没写进去 → 只可能是主键撞车之类的意外，抛错暴露（与 mock 同：幂等命中会回读既有）。
      const existing = await findMessageByKey(
        message.conversationId,
        message.senderId,
        idempotencyKey,
      );
      if (existing) return { message: existing, created: false };

      const conversation = await db.query<{ user_id: string; order_id: string }>(
        `SELECT user_id, order_id FROM conversations WHERE id = $1`,
        [message.conversationId],
      );
      const owner = conversation[0];
      if (!owner || owner.user_id !== message.userId || owner.order_id !== message.orderId) {
        return null;
      }

      throw new Error(
        `消息写入在并发下未能收敛（会话 ${message.conversationId} / 幂等键 ${idempotencyKey}）。`,
      );
    },

    async markConversationRead(userId, orderId, readAt) {
      // Mock：这一单**每一段**属于该用户的会话都标记（用户看到的是整条时间线）。
      // 游标只前进不后退（`forwardOnly(current, next)`）：`current > next` 保留 current，否则取 next。
      // 用 `CASE` 而不是 `GREATEST`，是为了不依赖 GREATEST 的 NULL 忽略语义，口径写死在这里。
      const updated = await db.query<{ id: string }>(
        `UPDATE conversations
            SET user_last_read_at = CASE
                  WHEN user_last_read_at IS NULL OR user_last_read_at < $3::timestamptz
                    THEN $3::timestamptz
                  ELSE user_last_read_at
                END
          WHERE order_id = $1 AND user_id = $2
          RETURNING id`,
        [orderId, userId, readAt],
      );
      // 命中 0 行 = 这一单没有任何属于他的会话 → false（Mock 同）
      return updated.length > 0;
    },

    // ————————————————————— 打手侧（P0-14）—————————————————————

    async listAssignmentConversationsForCompanion(companionId) {
      // 不筛「这一段是否还有效」：仓储只回答「哪些段记在这位打手名下」，含已失效的旧段。
      // ⚠️ Mock 是 Map 插入顺序，这里用 `created_at, id` 确定性化（有意的取舍）。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE kind = 'assignment' AND companion_id = $1
          ORDER BY created_at ASC, id ASC`,
        [companionId],
      );
      return rows.map(toConversation);
    },

    async findAssignmentConversationByKey(orderId, assignmentKey) {
      // `conversations_assignment_key` 部分唯一索引保证最多一行。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1 AND kind = 'assignment' AND assignment_key = $2
          LIMIT 1`,
        [orderId, assignmentKey],
      );
      return rows[0] ? toConversation(rows[0]) : null;
    },

    async ensureAssignmentConversation(input) {
      // id 取 `assignmentKey` 本身（Mock 同源）：两处各拼一次迟早会拼歪，规则归
      // `lib/constants/conversations.ts`，本文件不自造前缀。
      // 冲突目标指向部分唯一索引 `conversations_assignment_key`。
      // 已存在的段**原样返回**：`assignmentKey` 与 `companionId` 一旦写下就是历史事实。
      const inserted = await db.query<ConversationRow>(
        `INSERT INTO conversations
           (id, order_id, user_id, kind, assignment_key, assignment_seq, companion_id, created_at)
         VALUES ($1, $2, $3, 'assignment', $4, $5, $6, $7::timestamptz)
         ON CONFLICT (order_id, assignment_key) WHERE kind = 'assignment' DO NOTHING
         RETURNING ${CONVERSATION_COLUMNS}`,
        [
          input.assignmentKey,
          input.orderId,
          input.userId,
          input.assignmentKey,
          input.assignmentSeq,
          input.companionId,
          input.createdAt,
        ],
      );
      if (inserted[0]) return toConversation(inserted[0]);

      const existing = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1 AND assignment_key = $2 AND kind = 'assignment'
          LIMIT 1`,
        [input.orderId, input.assignmentKey],
      );
      if (existing[0]) return toConversation(existing[0]);

      throw new Error(
        `履约会话写入在并发下未能收敛（订单 ${input.orderId} / 履约段 ${input.assignmentKey}）。`,
      );
    },

    async listMessagesInConversation(conversationId) {
      // 不过滤所有者：`conversationId` 是内部键，调用方必须先从带所有者过滤的入口拿到它。
      // 会话不存在时本查询自然返回空数组（消息表有 FK，不存在指向缺失会话的孤儿消息），
      // 与 Mock 的「会话不存在 → []」结果一致。
      const rows = await db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at ASC, id ASC`,
        [conversationId],
      );
      return rows.map(toMessage);
    },

    async markAssignmentConversationRead(conversationId, companionId, readAt) {
      // 不是履约会话、或不是这位打手的那一段 → UPDATE 命中 0 行 → null（不写任何东西）。
      // 只动 `companion_last_read_at`，**绝不碰 `user_last_read_at`**：两个方向的游标互不影响。
      const rows = await db.query<ConversationRow>(
        `UPDATE conversations
            SET companion_last_read_at = CASE
                  WHEN companion_last_read_at IS NULL OR companion_last_read_at < $3::timestamptz
                    THEN $3::timestamptz
                  ELSE companion_last_read_at
                END
          WHERE id = $1 AND kind = 'assignment' AND companion_id = $2
          RETURNING ${CONVERSATION_COLUMNS}`,
        [conversationId, companionId, readAt],
      );
      return rows[0] ? toConversation(rows[0]) : null;
    },

    // ————————————————————— 客服侧（P8D-1）—————————————————————

    async listConversationsForStaff() {
      // 不过滤用户：工作台本就要跨用户看。⚠️ Mock 是 Map 插入顺序，这里确定性化。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          ORDER BY created_at ASC, id ASC`,
      );
      return rows.map(toConversation);
    },

    async findConversationForStaff(orderId) {
      // 代表会话 = `conversationsOfOrder[0]`：客服会话（若有）恒第一，否则订单内第一段。
      // 用途是「这一单有没有会话」的存在性判定；没有会话与订单不存在都是 null。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1
          ORDER BY (kind = 'service') DESC, assignment_seq ASC, id ASC
          LIMIT 1`,
        [orderId],
      );
      return rows[0] ? toConversation(rows[0]) : null;
    },

    async listConversationsByOrderForStaff(orderId) {
      // 客服调查视角：要看到每一段履约。顺序与 `compareConversationsWithinOrder` 对齐。
      const rows = await db.query<ConversationRow>(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
          WHERE order_id = $1
          ORDER BY (kind = 'service') DESC, assignment_seq ASC, id ASC`,
        [orderId],
      );
      return rows.map(toConversation);
    },

    async listMessagesForStaff(orderId) {
      // 会话不存在时消息表没有对应行，自然返回 []（Mock 同）。
      const rows = await db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          WHERE order_id = $1
          ORDER BY created_at ASC, id ASC`,
        [orderId],
      );
      return rows.map(toMessage);
    },

    async listMessagesGroupedForStaff() {
      // 与用户侧同理：键集合来自**会话**，一段「存在但没有消息」的会话也要有 `orderId → []` 的键。
      const conversations = await db.query<{ order_id: string }>(
        `SELECT order_id FROM conversations ORDER BY created_at ASC, id ASC`,
      );

      const grouped = new Map<string, OrderMessage[]>();
      for (const row of conversations) {
        if (!grouped.has(row.order_id)) grouped.set(row.order_id, []);
      }
      if (grouped.size === 0) return grouped;

      const messages = await db.query<MessageRow>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
          ORDER BY order_id ASC, created_at ASC, id ASC`,
      );
      for (const row of messages) {
        const list = grouped.get(row.order_id);
        if (list) list.push(toMessage(row));
      }
      return grouped;
    },

    async findStaffLastReadAt(orderId, staffId) {
      const rows = await db.query<StaffReadRow>(
        `SELECT ${STAFF_READ_COLUMNS} FROM staff_reads
          WHERE order_id = $1 AND staff_id = $2`,
        [orderId, staffId],
      );
      return rows[0]?.last_read_at ?? null;
    },

    async listStaffReads(staffId) {
      // 键 = 订单号，值 = 读到哪一刻（`StaffReadRecord`）。按订单号排序确定性化。
      const rows = await db.query<StaffReadRow>(
        `SELECT ${STAFF_READ_COLUMNS} FROM staff_reads
          WHERE staff_id = $1
          ORDER BY order_id ASC`,
        [staffId],
      );
      const result = new Map<string, string>();
      for (const row of rows) result.set(row.order_id, row.last_read_at);
      return result;
    },

    async markConversationReadForStaff(orderId, staffId, readAt) {
      // ⚠️ 客服游标**按订单一份**，不按 assignment 分段（`StaffReadRecord`）。
      // ⚠️ 这一单没有会话就返回 null，且**不建会话**：客服不能凭空给一笔订单造出会话。
      //    用 `WHERE EXISTS` 把「有会话」压进同一条 upsert 语句，不必先查后写。
      // ⚠️ 只动 `staff_reads`，**不碰 `user_last_read_at` / `companion_last_read_at`**：
      //    客服读完不清用户的未读，反之亦然。
      // 只前进不后退，写在 `DO UPDATE` 的 `CASE` 里（`forwardOnly` 的口径）。
      const rows = await db.query<StaffReadRow>(
        `INSERT INTO staff_reads (order_id, staff_id, last_read_at)
         SELECT $1::text, $2::text, $3::timestamptz
          WHERE EXISTS (SELECT 1 FROM conversations WHERE order_id = $1)
         ON CONFLICT (order_id, staff_id) DO UPDATE
           SET last_read_at = CASE
                 WHEN staff_reads.last_read_at < EXCLUDED.last_read_at
                   THEN EXCLUDED.last_read_at
                 ELSE staff_reads.last_read_at
               END
         RETURNING ${STAFF_READ_COLUMNS}`,
        [orderId, staffId, readAt],
      );
      return rows[0] ? toStaffRead(rows[0]) : null;
    },
  };
}

/**
 * 进程级 PostgreSQL 实现。执行器**延迟解析**——模块加载期不读 `DATABASE_URL`、不建池。
 */
export const pgMessageRepository: MessageRepository = createMessageRepository(lazyPgExecutor());
