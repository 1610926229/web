import type {
  ConversationKind,
  MessageSenderRole,
  OrderConversationRecord,
  OrderConversationSegment,
  OrderMessage,
  OrderMessageView,
} from "@/lib/types/message";
import type { OrderStatus } from "@/lib/types/order";

/**
 * 订单沟通的**会话归属规则**（P0-14）——服务端与浏览器共用，node 可直接加载做纯逻辑测试。
 *
 * ⚠️ 本文件**只有 `import type`**，没有任何运行时依赖：客户端组件引用它不会把
 * `lib/data` 与 Mock 存储打进浏览器产物。
 *
 * ## 它回答的唯一问题
 *
 * 「这段会话现在是**谁**的？这段会话**还是当前那一段**吗？」
 *
 * P0-14 之前，一张订单只有一个会话，这个问题不存在——会话的归属就是订单的归属。
 * 引入 assignment 维度之后，「会话属于谁」与「订单现在归谁」变成了**两件事**，
 * 而它们的差正是本轮要保证的隔离：
 *
 * - 旧打手：会话确实是他参与过的（②成立），但订单已经不归他了（①失败）
 *   ——或者订单又归他了、而那已经是**另一段**履约（③失败）。
 * - 新打手：订单归他（①成立），但那一段会话**不是他的**（②失败）。
 *
 * ## 为什么规则放在这里，而不是写在仓储或路由里
 *
 * 读取与写入**必须**用同一条判据。分两处写，第一次有人只改一处时就会出现
 * 「读得到、发不出去」或更糟的「发得出去、读不到」——而后者是**越权**。
 * 因此本文件是这条判据的**唯一**出处，服务层的每一个入口都调它。
 */

// ——————————————————————————— 会话种类 ———————————————————————————

/**
 * 会话种类。
 *
 * - `service`    —— 用户 ↔ 客服。**P0-14 之前就存在的那一种**，本轮原样保留。
 * - `assignment` —— 某一次履约的订单用户 ↔ 当前实际打手。本轮新增。
 *
 * ⚠️ 两者**不是二选一**：一张订单可以只有 `service`（还在等人接单，用户照样要能
 * 问客服「这一单还没人接吗」），也可以两者都有。P0-14 的规则只约束
 * `assignment` 那一种的**数量与归属**。
 */
export const CONVERSATION_KINDS: readonly ConversationKind[] = ["service", "assignment"];

export function isConversationKind(value: string): value is ConversationKind {
  return (CONVERSATION_KINDS as readonly string[]).includes(value);
}

// ——————————————————————————— 身份构造 ———————————————————————————

/**
 * 客服会话的 id：**直接沿用订单号**。
 *
 * 这不是偷懒，是刻意的：`service` 会话在 P0-14 之前就是「一单一个、键是订单号」的，
 * 让它继续用订单号做键，**现存数据、现存调试直觉与现存日志都不必迁移**。
 * 订单号本身已经全局唯一，再加前缀只会让排障时多剥一层。
 */
export function serviceConversationId(orderId: string): string {
  return orderId;
}

/**
 * 履约会话的 id：`${orderId}#s${seq}`。
 *
 * `seq` 是**履约序号**（见 `resolveAssignmentSeq`），从 0 起。
 * 加 `s` 是为了让 id 一眼可读——`ord-1#1` 会让人分不清哪一段是订单号的一部分。
 */
export function assignmentConversationId(orderId: string, seq: number): string {
  return `${orderId}#s${seq}`;
}

/** 会话 id 的构造总入口：两种 kind 各走各的规则，调用方不需要自己拼串。 */
export function buildConversationId(
  orderId: string,
  kind: ConversationKind,
  seq: number | null,
): string {
  return kind === "service" ? serviceConversationId(orderId) : assignmentConversationId(orderId, seq ?? 0);
}

/**
 * 某一段履约的 `assignmentKey`。
 *
 * ⚠️ **它必须同时被写进会话记录（冻结）与现算（判当前）**，两处都调这个函数，
 * 免得一边拼 `${orderId}#s${n}`、另一边拼 `${orderId}:${n}` 而没人发现。
 *
 * 见 `resolveAssignmentSeq` 说明「为什么用序号而不是打手 id」。
 */
export function assignmentKeyOf(orderId: string, seq: number): string {
  return `${orderId}#s${seq}`;
}

/**
 * 订单当前的**履约序号** = 该订单的履约退出历史条数。
 *
 * ## 为什么是它（本轮最关键的一条规则）
 *
 * 需求（`EX-SERVICE-04` / `cmd_p0-14.md` §4.3）要求
 * **`A 接单 → A 取消 → A 再次接到同一订单` 必须算作新的 assignment**，
 * 新建会话、**不得**复用旧会话。因此履约阶段的标识**不能**是打手 id——
 * 同一位打手的两段履约会被判成同一段，A 会重新看到自己上一段的聊天，
 * 而「旧会话只读」这条规则会被静默绕过。
 *
 * 退出历史恰好提供了这个序号，且它具备三个必需的性质：
 *
 * 1. **只增不改**（`lib/types/companionRelease.ts` 明文，`appendCompanionRelease`
 *    也不覆盖旧记录）⇒ 序号**单调递增**，两段履约不可能拿到同一个值；
 * 2. **每次释放恰好追加一条** ⇒ 序号 +1 与「换了一段履约」严格同步；
 * 3. **它已经存在**（P0-11 交付）⇒ 不需要为本轮新建任何追溯表
 *    （`cmd_p0-14.md` §三：禁止为聊天建立完整 Assignment 聚合）。
 *
 * ## 为什么这样能让「旧打手失权」不可能被漏写
 *
 * 释放动作**本来就会**追加一条退出记录（`releaseCurrentAssignment` 的第 2 件事）。
 * 也就是说：**换人或回池一发生，序号当场变化**，`旧会话的冻结键 ≠ 现算键`
 * 立刻成立。整件事**不需要在释放事务里多写任何一个字节**——
 * 没有「失效标记」这种东西，也就没有「忘了标记失效」这种缺陷。
 *
 * `seq` 在**会话创建那一刻冻结进记录**，之后永不重算；
 * 现算的那一份只用来回答「这段会话还是当前那一段吗」。
 */
export function resolveAssignmentSeq(releaseCount: number): number {
  return releaseCount < 0 ? 0 : releaseCount;
}

/**
 * 当前这段履约的 key；订单没有履约人时返回 `null`。
 *
 * ⚠️ 「没有履约人」与「有履约人」必须区分：公共池里的订单（`actualCompanionId === null`）
 * 不存在 assignment 会话（`cmd_p0-14.md` §4.1 明文），调用方据此跳过 assignment 分支。
 */
export function resolveCurrentAssignmentKey(input: {
  orderId: string;
  actualCompanionId: string | null;
  releaseCount: number;
}): string | null {
  if (!input.actualCompanionId) return null;
  return assignmentKeyOf(input.orderId, resolveAssignmentSeq(input.releaseCount));
}

// ——————————————————————————— 访问判据 ———————————————————————————

/**
 * 一段**履约会话**对某位打手是否可见 / 可写。
 *
 * 三条必须**同时**成立，缺一不可：
 *
 * | # | 条件 | 挡住的是谁 |
 * |---|---|---|
 * | ① | 订单当前的 `actualCompanionId` 就是这位打手 | 被换掉 / 回池 / 被禁用之后的旧打手 |
 * | ② | 这段会话本来就是这位打手的 | 新打手（会话是别人的） |
 * | ③ | 这段会话**仍然是当前那一段** | **同一位打手的上一次履约** |
 *
 * ⚠️ **③ 是 `A → B → A` 的胜负手**：A 的两段会话在 ①② 上都成立，
 * 只有 ③ 能把 A 的第一段会话挡在外面。去掉 ③，A 再次接单就能重新读到
 * 自己上一段的聊天，而需求（`cmd_p0-14.md` §4.3）要的恰恰是**另一段**。
 *
 * ⚠️ 客服会话**不走这个判据**：它不属于任何打手，打手对它一律不可见
 * （`用户权限表.md:113`「查看其他打手历史聊天」对 Companion 是 ❌；
 * 客服会话里还有客服与用户的对话，与打手无关）。
 */
export function canCompanionAccessConversation(
  conversation: Pick<OrderConversationRecord, "kind" | "assignmentKey" | "companionId">,
  input: { companionId: string; actualCompanionId: string | null; currentAssignmentKey: string | null },
): boolean {
  if (conversation.kind !== "assignment") return false;
  if (input.actualCompanionId !== input.companionId) return false; // ①
  if (conversation.companionId !== input.companionId) return false; // ②
  if (input.currentAssignmentKey === null) return false;
  return conversation.assignmentKey === input.currentAssignmentKey; // ③
}

/**
 * 一段履约会话**是否仍然有效**（与「谁在问」无关）。
 *
 * 用于用户端与客服端：它们要能看出哪一段是「当前服务会话」、哪一段已经只读。
 * ⚠️ 与 `canCompanionAccessConversation` 是**两个问题**：
 * 这里问「这段会话过期了吗」，那里问「这位打手能不能碰它」。
 * 用户看得到所有段（包括过期的），打手只看得到自己当前那一段。
 */
export function isCurrentAssignmentConversation(
  conversation: Pick<OrderConversationRecord, "kind" | "assignmentKey">,
  currentAssignmentKey: string | null,
): boolean {
  if (conversation.kind !== "assignment") return false;
  if (currentAssignmentKey === null) return false;
  return conversation.assignmentKey === currentAssignmentKey;
}

// ——————————————————————————— 履约结束（退款后只读） ———————————————————————————

/**
 * 这一单的**履约沟通是否已经结束**——唯一的触发器是**累计全额退款**。
 *
 * ## 产品裁定（`TBD-P0-14-1`，2026-09-27）
 *
 * 「订单全额退款后，当前 assignment 立即结束；对应聊天历史保留，但进入只读状态。」
 * 具体是：**读**继续（用户、原打手、客服/管理员各自按既有权限），**写**停止
 * （用户与打手都不能再往这一段发），**不删除**任何消息、**不改** retention 规则。
 *
 * ## 为什么是「订单状态」而不是「清掉 `actualCompanionId`」
 *
 * P0-12 有一条**硬约束**：`applyOrderRefund` **不清 `actualCompanionId`**——
 * 那是「这一单当时是谁接的」这个**历史事实**，不是「现在还能不能聊天」的授权。
 * 裁定第 2 条正是这么说的：可以继续保留，但**不得再作为「当前仍可聊天」的充分条件**。
 *
 * 因此本函数**只读订单状态**，不碰归属：归属那条腿（判据 ①）继续用它判断
 * 「这是不是你的单」，而「还能不能写」由这里叠加。两者分开的直接好处是——
 * 退款**不需要**在任何事务里补写一行「关闭聊天」，就像换人不需要补写失效标记一样。
 *
 * ## 为什么只看 `refunded` 这一个取值
 *
 * 判定值就是「累计退满」：`status === "refunded"` 的含义**恰好**是「这一单累计已退满」
 * （`lib/data/adminRefundTransaction.ts` 明文：部分退款**不改** `status`，
 * 只有累计退满才改成 `refunded`）。裁定第 5 条要求「partial refund 不结束 assignment」，
 * 于是这条规则**不需要额外判比例**——`refundedAmount > 0` 不是判据，
 * 用它会**错误地**把部分退款当成结束。
 *
 * ⚠️ `paid` / `accepted` / `serving` / `completed` **都不是**只读：
 * 已完结（`completed`）但没退款的订单，用户与打手**照样可以继续沟通**
 * （售后、评价、投诉都还要说话）。把「已完成」当成「沟通结束」是另一条规则，
 * 本轮**没有**这条规则。
 */
export function isOrderChatClosed(orderStatus: OrderStatus): boolean {
  return orderStatus === "refunded";
}

// ——————————————————————————— 稳定排序 ———————————————————————————

/**
 * 会话在**同一条订单内**的展示顺序：客服会话永远第一，其后按履约序号升序。
 *
 * ⚠️ 排序必须是**全序**（同一对输入永远给出同一个先后），否则用户端每次刷新
 * 可能看到两个不同的段落顺序，而「哪一段在前」在这里恰好是有意义的
 * ——它就是履约发生的时间序。`assignmentSeq` 在同一订单内唯一，
 * 因此 `kind` + `assignmentSeq` 已经构成全序，无需再用 id 兜底。
 */
export function compareConversationsWithinOrder(
  a: Pick<OrderConversationRecord, "kind" | "assignmentSeq">,
  b: Pick<OrderConversationRecord, "kind" | "assignmentSeq">,
): number {
  if (a.kind !== b.kind) return a.kind === "service" ? -1 : 1;
  const left = a.assignmentSeq ?? 0;
  const right = b.assignmentSeq ?? 0;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// ——————————————————————————— 分段文案 ———————————————————————————

/**
 * 会话分段标题。
 *
 * ⚠️ 用户端看到的是「客服沟通 / 打手沟通」，**不是「第 1 段履约」**：
 * 段号是内部实现（`assignmentSeq`），页面不该把它变成用户词汇。
 */
export const CONVERSATION_SEGMENT_SERVICE_TITLE = "客服沟通";
export const CONVERSATION_SEGMENT_HISTORY_SUFFIX = "（历史）";

/**
 * 履约段的标题**按端给两个词**，不是一个词两边用。
 *
 * ⚠️ 两端的角色称呼**本来就是分开的**，而且各有明文出处：
 * 用户端的角色表（`lib/constants/service.ts` 的 `MESSAGE_ROLE_LABELS`）把
 * companion 叫「**打手**」；客服端的角色表（`lib/constants/staff.ts` 的
 * `STAFF_MESSAGE_ROLE_LABELS`）叫「**护航**」。
 * 用同一个词，必然有一端出现「标题写着一种人、气泡标着另一种人」——
 * 而这两样东西在同一个屏幕上只隔几行。
 *
 * ⚠️ 打手端**不使用**这里的标题：它只看得到自己当前那一段，页面标题是
 * `COMPANION_CHAT_PAGE_TITLE`，没有「分段」这个概念。
 */
export const CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER = "打手沟通";
export const CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_STAFF = "护航沟通";

// ——————————————————————————— 对外形状 ———————————————————————————

/**
 * 内部消息记录 → **对外 DTO**：去掉 `conversationId`。
 *
 * ⚠️ **一个一个字段地挑，不是 `{ ...message }` 再 `delete`**。两者在今天的输出上
 * 完全一样，差别在下一次有人往 `OrderMessage` 上加字段时：展开式写法会**静默**
 * 把新字段一起交出去，而新字段里很可能正是像 `conversationId` 这样不该外泄的东西。
 * 显式挑选的写法会让人**必须**在这个函数里做一次决定。
 *
 * ⚠️ **这不是全仓唯一的转换点，只是用户端那一个。** 另外两端各有自己的：
 * 打手端 `toCompanionChatMessage()`（`lib/services/companionConversations.ts`，
 * 模块私有）、客服端 `toStaffConversationMessage()`（`lib/constants/staff.ts`）。
 * 三端 DTO 形状本来就不同（用户端 9 字段 / 打手端 7 字段 / 客服端另带
 * `companionId`·`companionName`），所以它们**故意不共用一个函数**，
 * 改这里**不会**连带改另外两端。
 *
 * 真正的不变量是**每一条出站路径都自己显式挑字段**，而不是「只有一个函数」：
 * 新增一条出站路径时，必须在新位置**再挑一次**，没有人替你兜底。
 */
export function toMessageView(message: OrderMessage): OrderMessageView {
  return {
    id: message.id,
    orderId: message.orderId,
    userId: message.userId,
    senderId: message.senderId,
    senderRole: message.senderRole,
    senderName: message.senderName,
    senderAvatarUrl: message.senderAvatarUrl,
    body: message.body,
    createdAt: message.createdAt,
  };
}

/**
 * 段标题：客服会话固定；履约会话看它**还是不是当前那一段**。
 *
 * 导出是给**客服端**用的：工作台要按订单展示全部段落（`cmd_p0-14.md` §八），
 * 而「哪一段该叫什么」只有这一处定义。让客服端另写一遍的话，
 * 用户端把「（历史）」改成别的说法时，客服端会静默地留着旧措辞。
 *
 * ⚠️ `assignmentTitle` 由调用方按**自己那一端的角色称呼**传入
 * （用户端 `..._TITLE_USER`、客服端 `..._TITLE_STAFF`）——见上面两个常量的说明。
 */
export function segmentTitle(
  conversation: Pick<OrderConversationRecord, "kind">,
  isCurrent: boolean,
  assignmentTitle: string,
): string {
  if (conversation.kind === "service") return CONVERSATION_SEGMENT_SERVICE_TITLE;
  return isCurrent ? assignmentTitle : `${assignmentTitle}${CONVERSATION_SEGMENT_HISTORY_SUFFIX}`;
}

/**
 * 一段订单的全部会话 → **分段视图**（用户端聊天页与打手端聊天页共用）。
 *
 * 三条约定：
 *
 * 1. **空段落照样出现**。一段会话存在但还没有消息，是「这里可以开始说话」，
 *    不是「什么都没有」——把它藏掉，用户就找不到给客服或打手发消息的入口了。
 *    （`ord-seed-1001-03` 的客服会话就是空的，而且它是该订单的默认发送目标。）
 * 2. **`isReadOnly` 对履约会话有两种来源，客服会话永远可写**：
 *    - 这一段**已经不是当前段**（换人 / 回池）；
 *    - 这一单**已全额退款**（`isOrderChatClosed`，产品裁定 `TBD-P0-14-1`）——
 *      此时连当前段也一起只读。
 *
 *    ⚠️ **客服会话两条都不适用**：「旧打手失权」与「打手那段结束」都不该顺带把
 *    用户与客服的沟通冻住——退款之后恰恰是用户最需要问客服的时候。
 *    产品裁定的原文也只说到 assignment（「不可继续向该 **assignment** 发送消息」）。
 * 3. **段落顺序固定**（客服会话在前，其后按履约序号），由
 *    `compareConversationsWithinOrder` 保证。顺序在这里就排好，
 *    调用方直接渲染。
 *
 * ⚠️ **不保证调用方有权限**：本函数只回答「订单里有哪些段、长什么样」。
 * 谁能看到哪一段由调用方在**取数之前**判掉（用户取自己的订单、打手只取当前那一段）。
 *
 * ⚠️ `orderStatus` 是**订单此刻**的状态，不是会话上的历史字段：
 * 「还能不能发」会随退款而变，因此每次请求都要现传，不能冻进会话记录。
 */
export function buildConversationSegments(
  conversations: readonly OrderConversationRecord[],
  messages: readonly OrderMessage[],
  currentAssignmentKey: string | null,
  orderStatus: OrderStatus,
): OrderConversationSegment[] {
  const chatClosed = isOrderChatClosed(orderStatus);

  // 消息按会话分组：分段渲染只需要「这一段的消息」，跨段合并是另一个问题
  const byConversation = new Map<string, OrderMessage[]>();
  for (const message of messages) {
    const list = byConversation.get(message.conversationId);
    if (list) list.push(message);
    else byConversation.set(message.conversationId, [message]);
  }

  return [...conversations]
    .sort(compareConversationsWithinOrder)
    .map((conversation, index) => {
      const isCurrent = isCurrentAssignmentConversation(conversation, currentAssignmentKey);
      return {
        index,
        kind: conversation.kind,
        // 用户端的角色称呼是「打手」（见 `..._TITLE_USER` 的说明）
        title: segmentTitle(conversation, isCurrent, CONVERSATION_SEGMENT_ASSIGNMENT_TITLE_USER),
        isCurrent,
        // 客服会话永远可写；履约会话在「不是当前段」或「已全额退款」时只读
        isReadOnly: conversation.kind === "assignment" && (!isCurrent || chatClosed),
        messages: (byConversation.get(conversation.id) ?? []).map(toMessageView),
      };
    });
}

// ——————————————————————————— 文案 ———————————————————————————

/**
 * 历史段落的只读说明。
 *
 * ⚠️ 措辞的目标是**不让人误以为还能发出去**（`cmd_p0-14.md` §七 的最后一条要求）。
 * 因此这里说的是「已结束」与「可以查看」，而不是「暂不可发送」——
 * 后者听起来像暂时的故障，用户会反复点。
 */
export const CONVERSATION_SEGMENT_HISTORY_NOTICE = "这段打手沟通已经结束，可以查看，不能再发送新消息。";

/**
 * 订单**已全额退款**时，当前那一段履约沟通的只读说明（产品裁定 `TBD-P0-14-1`）。
 *
 * ⚠️ **必须与历史段那一句分开**：两句都导致只读，但原因是两件不同的事
 * ——「换人了」与「这一单退掉了」。用同一句话，用户在一张刚退款的订单上会看到
 * 「这段打手沟通已经结束」，而页面上既没有换人也没有历史段，他会去问客服
 * 「谁把我换了」。说清原因才能让人不追问。
 */
export const CONVERSATION_SEGMENT_REFUNDED_NOTICE =
  "这一单已全额退款，沟通记录保留可查，不能再发送新消息。";

/**
 * 空段落的占位句：一段会话存在但还没有消息。
 *
 * ⚠️ 与 `CONVERSATION_SEGMENT_HISTORY_NOTICE` 一样**放在这里而不是各端各写一份**：
 * 用户端与客服端都要显示它，而「一段存在但没有消息本身就是一条信息」
 * （这一段被撮合过但没聊）是同一个判断。两处各写一遍的那一天，
 * 一端改了措辞另一端不会跟着动，而这两句话说的是同一件事。
 *
 * ⚠️ 句子里**不提任何角色**：空段落既可能是客服沟通也可能是护航沟通。
 * 提了角色就会出现「客服沟通 —— 这一段还没有打手」这种自相矛盾的话。
 */
export const CONVERSATION_SEGMENT_EMPTY_NOTICE = "这一段还没有消息。";

/** 打手端聊天入口与空态。 */
export const COMPANION_CHAT_PAGE_TITLE = "订单聊天";
export const COMPANION_CHAT_EMPTY_TITLE = "还没有订单聊天";
export const COMPANION_CHAT_EMPTY_DESCRIPTION = "接到订单后，可以在这里和下单用户沟通";
export const COMPANION_CHAT_ENTRY_LABEL = "订单聊天";
export const COMPANION_CHAT_HISTORY_NOTICE =
  "你与用户只能看到本次护航的沟通记录。换人之后，接手的护航看不到这里的消息。";

/**
 * 订单**已全额退款**时，打手端聊天页顶部的说明（产品裁定 `TBD-P0-14-1`）。
 *
 * ⚠️ 与 `COMPANION_CHAT_HISTORY_NOTICE` **两条是替换关系，不是叠加**：
 * 那一条讲的是「你看不到别人的段」（范围），这一条讲的是「这一单退掉了、
 * 记录还留着」（归属与留存）。退款之后护航最需要确认的是「我的记录还在不在」，
 * 把范围说明换成它才答到了点上。
 *
 * ⚠️ **与 `COMPANION_CHAT_READONLY_FOOTER` 分工，不许合并成同一句话**：
 * 这一条在**页顶**，回答**「发生了什么、我的记录怎么样了」**；
 * 那一条在**输入框原来的位置**，回答**「我为什么打不了字」**。
 * 两句写成一模一样，同一屏上会出现同一句话两遍。
 *
 * ⚠️ 用「护航」自称：这是打手端（工作台）的口径，与 `COMPANION_ROLE_LABEL` 一致；
 * 用户端那一条 `MESSAGE_ORDER_REFUNDED_MESSAGE` 才是说「打手」。
 */
export const COMPANION_CHAT_REFUNDED_NOTICE =
  "这一单已全额退款，本次护航已结束。这里的沟通记录保留，可供查看。";

/**
 * 打手端消息的称呼表（**打手视角**）。
 *
 * ⚠️ 与用户端那张表（`lib/constants/service.ts` 的 `MESSAGE_ROLE_LABELS`）
 * **必须分开写**，而且是同一个角色在两处的含义不同：
 * 用户端把 `user` 叫「我」，打手端把 `companion` 叫「我」。
 * 复用一张表就会让打手在自己的聊天页里看到自己发的消息标着「打手」——
 * 视角反了，而且反得很安静。
 *
 * ⚠️ `companion` 这一项写的是「护航」而不是「打手」：这一格只在
 * **不是自己发的时候**才会用到（异常数据），而产品对外一律说「护航」，
 * 代码里才叫 companion。写「打手」会让一个兜底分支突然冒出一个只在内部用的词。
 */
export const COMPANION_MESSAGE_ROLE_LABELS: Record<MessageSenderRole, string> = {
  user: "用户",
  companion: "护航",
  customer_service: "客服",
};

/**
 * 打手端消息的称呼：自己发的显示「我」。
 *
 * ⚠️ `isSelf` 由**发送者 id** 判定，不是由角色判定：角色回答「这是哪一类人发的」，
 * 而「是不是我发的」只有 id 能回答。用 `role === "companion"` 近似等于自己，
 * 在出现一条不属于自己的打手消息时会把对方标成「我」——那是把别人的话
 * 显示成自己说的，比标错称呼严重得多。
 */
export function companionMessageSenderLabel(role: MessageSenderRole, isSelf: boolean): string {
  return isSelf ? "我" : COMPANION_MESSAGE_ROLE_LABELS[role];
}
