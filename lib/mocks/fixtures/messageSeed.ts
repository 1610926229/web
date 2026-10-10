import {
  assignmentKeyOf,
  resolveAssignmentSeq,
  serviceConversationId,
} from "@/lib/constants/conversations";
import type {
  ConversationKind,
  MessageSenderRole,
  OrderConversationRecord,
  OrderMessage,
  StaffReadRecord,
} from "@/lib/types/message";
import { getMockSeedNow } from "./mockClock";
import { orderSeed } from "./orderSeed";
import { companionSeed, userSeed } from "./seed";
import { PRESET_STAFF_SENDER_ID, staffSeed } from "./staffSeed";

/**
 * 预置订单沟通种子（会话 + 消息）。
 *
 * 用途：让「订单沟通」、客服工作台与打手订单聊天在没有任何真实客服/打手在线的当前阶段，
 * 也能看到**三种发送者**（用户 / 护航 / 客服）、多段履约会话、未读角标、长消息与
 * 「刚发起还没聊过的会话」。
 *
 * ## P0-14：一段会话是一个 `{ orderId, kind }`
 *
 * 种子的每一项现在显式声明 `kind`。这不是为了「让数据更全」，而是因为本轮的核心规则
 * 必须在数据上就成立，否则页面看起来对、规则其实没被执行：
 *
 * | kind | 参与者 | 种子里能出现的角色 |
 * |---|---|---|
 * | `service` | 用户 ↔ 客服 | `user` / `customer_service` |
 * | `assignment` | 用户 ↔ 那一段履约的打手 | `user` / `companion` |
 *
 * ⚠️ **两条角色约束是硬校验，写错当场抛错**：客服不能出现在履约会话里，
 * 打手也不能出现在客服会话里。放行的话，种子里就会存在「新打手读得到的会话里
 * 有客服与用户的对话」这种样本，而本轮要证明的正是**新打手绝看不到不属于他的内容**——
 * 样本本身是反例，测试再怎么写也证明不了什么。
 *
 * ## 四条不变量在 `buildConversation` 里强制校验，写错会当场抛错
 *
 * 1. **消息必须属于会话所属用户的订单**——这是「只能看自己的会话」在数据上的落点；
 * 2. **会话必须先于消息存在**——消息挂在会话上，否则会话列表与聊天页会对不上；
 * 3. **消息时间不能早于订单支付时间**——否则聊天记录会出现在下单之前；
 * 4. **履约会话的打手必须是订单当前的履约人**——否则「这一段是我的」这条判据
 *    在预置数据上就已经自相矛盾。
 *
 * ⚠️ **时间一律相对「进程基准时间」**（`mockClock` 的 `getMockSeedNow()`），
 * 不写死绝对日期。理由与周期排行榜完全相同：写死日期之后，客服工作台的
 * 「今日消息数」过几天就永远是 0，验收时看到的是一个坏掉的数字。
 *
 * ⚠️ 代价是它与**订单种子的绝对日期**（2026-09-08 起）不在同一条时间线上：
 * 当真机上把系统时间调到那些日期之前时，不变量 3 会抛错——那是数据自相矛盾，
 * 不是「今天没消息」。真发生的话按报错信息改基准即可。
 *
 * ⚠️ 用户端只能发出 `user` 角色的消息，客服端只能发出 `customer_service`，
 * 打手端只能发出 `companion`：能不能发是**服务端写的**，不是预置数据决定的
 * （详见 `lib/types/message.ts`）。这里的护航 / 客服消息只是历史的展示数据。
 *
 * ⚠️ 客服消息的发送者指向**预置客服账号**（`staff-1`），不是凭空写的一个 id：
 * 这样「停用或移除这位客服之后，他发过的消息仍然显示当时的名字与头像」
 * 才有真实数据可以验收。名称与头像在下面**写进消息快照**，不是渲染时反查账号。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

const now = getMockSeedNow();

/** 基准时间往前 n 分钟。会话、消息与已读时间全用它，保证三者时间先后自洽。 */
function minutesAgo(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

/**
 * 预置数据里所有履约会话的**履约序号**。
 *
 * ⚠️ 写死 `0` 是对的，而且必须是 0：履约序号 = 该订单的退出历史条数
 * （`resolveAssignmentSeq`），而退出历史仓储**建仓时是空的**——
 * 预置数据里没有任何一位打手退出过。因此每一单当前那一段就是**第一段**。
 *
 * 将来若有人给退出历史加预置数据，这里必须跟着改：那时订单的当前段就不再是 0，
 * 而这一串常量是「预置会话属于哪一段」的唯一声明处。
 */
const SEEDED_ASSIGNMENT_SEQ = resolveAssignmentSeq(0);

function requireOrder(id: string) {
  const order = orderSeed.find((item) => item.id === id);
  if (!order) throw new Error(`Mock 种子缺失订单：${id}`);
  return order;
}

function userName(userId: string): string {
  const user = userSeed.find((item) => item.id === userId);
  if (!user) throw new Error(`Mock 种子缺失用户：${userId}`);
  return user.nickname;
}

function userAvatar(userId: string): string {
  const user = userSeed.find((item) => item.id === userId);
  if (!user) throw new Error(`Mock 种子缺失用户：${userId}`);
  return user.avatarUrl;
}

function companionOf(id: string) {
  const companion = companionSeed.find((item) => item.id === id);
  if (!companion) throw new Error(`Mock 种子缺失陪玩：${id}`);
  return companion;
}

/** 预置客服消息的发送者：名称与头像都取自那份客服账号，写进消息快照。 */
function presetStaff() {
  const staff = staffSeed.find((item) => item.id === PRESET_STAFF_SENDER_ID);
  if (!staff) throw new Error(`Mock 种子缺失客服：${PRESET_STAFF_SENDER_ID}`);
  return staff;
}

type PresetMessageInput = {
  id: string;
  role: MessageSenderRole;
  body: string;
  /** 相对基准时间往前多少分钟 */
  minutesAgo: number;
};

/** 会话输入：`userLastReadMinutesAgo` 为 null 表示从未读过，对方消息全部算未读。 */
type PresetConversationInput = {
  orderId: string;
  kind: ConversationKind;
  /** 一条消息都没有的会话用它记创建时间 */
  createdAtMinutesAgo: number;
  userLastReadMinutesAgo: number | null;
  /**
   * 这段履约的打手（**仅 `kind === "assignment"`**，且必须等于订单当前的
   * `actualCompanionId`）。`service` 会话传了会抛错——客服会话不属于任何打手。
   */
  companionId?: string;
  messages: PresetMessageInput[];
};

function buildConversation(input: PresetConversationInput): {
  conversation: OrderConversationRecord;
  messages: OrderMessage[];
} {
  const order = requireOrder(input.orderId);
  const staff = presetStaff();

  // —— 段与打手的一致性（不变量 4）——
  // 客服会话不属于任何打手；履约会话必须属于**订单当前那一位**履约人。
  // 这两种错法都会让「这一段是不是我的」在数据层面就是假的
  if (input.kind === "service" && input.companionId !== undefined) {
    throw new Error(`预置客服会话 ${order.id} 不该指定打手：客服会话不属于任何一段履约`);
  }
  if (input.kind === "assignment") {
    if (!order.actualCompanionId) {
      throw new Error(`预置履约会话 ${order.id} 的订单没有绑定打手`);
    }
    if (input.companionId !== order.actualCompanionId) {
      throw new Error(
        `预置履约会话 ${order.id} 的打手 ${input.companionId ?? "(未指定)"} 不是订单当前的履约人 ${order.actualCompanionId}`,
      );
    }
  }

  const messages = input.messages.map((message): OrderMessage => {
    // —— 角色与 kind 的匹配（本轮的核心隔离，见文件头）——
    if (input.kind === "service" && message.role === "companion") {
      throw new Error(`预置消息 ${message.id} 是打手消息，但它挂在客服会话 ${order.id} 上`);
    }
    if (input.kind === "assignment" && message.role === "customer_service") {
      throw new Error(`预置消息 ${message.id} 是客服消息，但它挂在履约会话 ${order.id} 上`);
    }

    // 不变量 1：消息的角色决定发送者是谁，发送者与快照都取自预置名单，不单独手写
    const sender =
      message.role === "user"
        ? { id: order.userId, name: userName(order.userId), avatarUrl: userAvatar(order.userId) }
        : message.role === "customer_service"
          ? { id: staff.id, name: staff.displayName, avatarUrl: staff.avatarUrl }
          : order.actualCompanionId
            ? {
                id: order.actualCompanionId,
                name: companionOf(order.actualCompanionId).displayName,
                avatarUrl: companionOf(order.actualCompanionId).avatarUrl,
              }
            : null;

    if (!sender) {
      throw new Error(`预置消息 ${message.id} 是打手消息，但订单 ${order.id} 没有绑定打手`);
    }

    const createdAt = minutesAgo(message.minutesAgo);

    // 不变量 3：聊天记录不能出现在下单之前
    if (createdAt < order.paidAt) {
      throw new Error(
        `预置消息 ${message.id} 的时间早于订单 ${order.id} 的支付时间（相对时间与订单绝对日期不在同一条时间线上？）`,
      );
    }

    return {
      id: message.id,
      orderId: order.id,
      userId: order.userId,
      senderId: sender.id,
      senderRole: message.role,
      senderName: sender.name,
      senderAvatarUrl: sender.avatarUrl,
      body: message.body,
      createdAt,
      conversationId:
        input.kind === "service"
          ? serviceConversationId(order.id)
          : assignmentKeyOf(order.id, SEEDED_ASSIGNMENT_SEQ),
    };
  });

  // 不变量 3（另一半）：会话先于消息存在，已读时间也不早于会话创建时间。
  // 给定的创建时间应当**略早于第一条消息**；万一写反了，这里取更早的那个兜住。
  const createdAt = messages.reduce(
    (earliest, message) => (message.createdAt < earliest ? message.createdAt : earliest),
    minutesAgo(input.createdAtMinutesAgo),
  );
  const userLastReadAt =
    input.userLastReadMinutesAgo === null ? null : minutesAgo(input.userLastReadMinutesAgo);
  if (userLastReadAt && userLastReadAt < createdAt) {
    throw new Error(`预置会话 ${input.orderId} 的已读时间早于会话创建时间`);
  }

  const conversation: OrderConversationRecord = {
    // 会话 id 与消息上的 `conversationId` 同源：两处各拼一次迟早会拼歪
    id:
      input.kind === "service"
        ? serviceConversationId(order.id)
        : assignmentKeyOf(order.id, SEEDED_ASSIGNMENT_SEQ),
    orderId: order.id,
    userId: order.userId,
    kind: input.kind,
    assignmentKey:
      input.kind === "assignment" ? assignmentKeyOf(order.id, SEEDED_ASSIGNMENT_SEQ) : null,
    assignmentSeq: input.kind === "assignment" ? SEEDED_ASSIGNMENT_SEQ : null,
    companionId: input.kind === "assignment" ? (input.companionId ?? null) : null,
    createdAt,
    userLastReadAt,
    // 预置数据不造「打手读到哪」：那需要一条真实发生过的打手读动作，
    // 而本阶段打手端聊天刚上线。null = 未读过，界面上表现为未读角标
    companionLastReadAt: null,
  };

  // 不变量 2：会话内消息按时间升序，页面上直接顺序渲染
  messages.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
  return { conversation, messages };
}

const built = [
  // ——— ord-seed-1001-01：还在等接单的一单，**没有履约人** ———
  // 用户照样能问客服「这一单还没人接吗」，因此客服会话必须独立于履约存在
  buildConversation({
    orderId: "ord-seed-1001-01",
    kind: "service",
    createdAtMinutesAgo: 200,
    userLastReadMinutesAgo: 95,
    messages: [
      {
        id: "msg-seed-1001-01-1",
        role: "user",
        body: "这一单还没人接吗？",
        minutesAgo: 160,
      },
      {
        id: "msg-seed-1001-01-2",
        role: "customer_service",
        body: "这边帮你看一下，稍后给你回复。",
        minutesAgo: 154,
      },
      {
        id: "msg-seed-1001-01-3",
        role: "customer_service",
        body: "已经帮你催过了，有打手接单后会第一时间通知你。",
        minutesAgo: 100,
      },
    ],
  }),

  // ——— ord-seed-1001-04：护航中（cp-3），**一单两段** ———
  // 这是本轮的核心样本：同一张订单上同时存在客服会话与履约会话。
  // 两段共用同一个「用户上次已读」时刻，但**各记各的**：
  //   service 段：客服那条（160）比已读时刻（230）新 → 1 条未读
  //   assignment 段：打手两条（228 / 150）比已读时刻新 → 2 条未读
  // 合计 3 条，与拆分之前单会话的口径完全一致（拆分不改用户看到的角标）
  buildConversation({
    orderId: "ord-seed-1001-04",
    kind: "service",
    createdAtMinutesAgo: 262,
    userLastReadMinutesAgo: 230,
    messages: [
      {
        id: "msg-seed-1001-04-5",
        role: "customer_service",
        body: "已收到你提交的退款申请，客服正在核实这一单的服务记录，请留意系统通知。",
        minutesAgo: 160,
      },
    ],
  }),
  buildConversation({
    orderId: "ord-seed-1001-04",
    kind: "assignment",
    companionId: "cp-3",
    createdAtMinutesAgo: 262,
    userLastReadMinutesAgo: 230,
    messages: [
      {
        id: "msg-seed-1001-04-1",
        role: "user",
        body: "开局前先说下，我这边只打机密，其他图不打。",
        minutesAgo: 260,
      },
      {
        id: "msg-seed-1001-04-2",
        role: "companion",
        body: "收到，按你说的来。",
        minutesAgo: 258,
      },
      {
        id: "msg-seed-1001-04-3",
        role: "user",
        body: "刚刚掉线了，等我两分钟，马上回来。",
        minutesAgo: 240,
      },
      {
        id: "msg-seed-1001-04-4",
        role: "companion",
        body: "好，我在大厅等你，不急。",
        minutesAgo: 228,
      },
      {
        id: "msg-seed-1001-04-6",
        role: "companion",
        body: "我先打一把，你回来说一声就行。",
        minutesAgo: 150,
      },
    ],
  }),

  // ——— ord-seed-1001-03：已接单（cp-2），全部消息都在履约会话里 ———
  // 「客服会话一条消息都没有」是**故意**的样本：它证明客服会话的存在不以
  // 「有消息」为条件，而且被打手会话挤不掉（同一订单两段会话都活着）
  buildConversation({
    orderId: "ord-seed-1001-03",
    kind: "service",
    createdAtMinutesAgo: 332,
    userLastReadMinutesAgo: 315,
    messages: [],
  }),
  buildConversation({
    orderId: "ord-seed-1001-03",
    kind: "assignment",
    companionId: "cp-2",
    createdAtMinutesAgo: 332,
    userLastReadMinutesAgo: 315,
    messages: [
      {
        id: "msg-seed-1001-03-1",
        role: "user",
        body: "你好，今天晚上八点之后可以开始吗？",
        minutesAgo: 330,
      },
      {
        id: "msg-seed-1001-03-2",
        role: "companion",
        body: "可以的，八点半我上线，到时候游戏里拉我。",
        minutesAgo: 327,
      },
      {
        id: "msg-seed-1001-03-3",
        role: "user",
        body: "好的，那八点半见。",
        minutesAgo: 320,
      },
    ],
  }),

  // 刚发起、还没聊过的会话：列表上要能正常显示「还没有消息」
  buildConversation({
    orderId: "ord-seed-1001-07",
    kind: "service",
    createdAtMinutesAgo: 500,
    userLastReadMinutesAgo: null,
    messages: [],
  }),

  // 老板B 的一单：验证互相看不到对方的会话
  buildConversation({
    orderId: "ord-seed-1002-01",
    kind: "service",
    createdAtMinutesAgo: 262,
    userLastReadMinutesAgo: 195,
    messages: [
      {
        id: "msg-seed-1002-01-1",
        role: "user",
        body: "这单大概什么时候能开始？",
        minutesAgo: 260,
      },
      {
        id: "msg-seed-1002-01-2",
        role: "customer_service",
        body: "正在为你匹配打手，接单后会通知你。",
        minutesAgo: 200,
      },
    ],
  }),
];

/**
 * 去重校验。
 *
 * ⚠️ 校验的是**会话 id 重复**，不再是「订单号重复」：P0-14 起同一张订单
 * 本来就可以有多段会话。仍然要挡的是「两段会话共用一个 id」——
 * 那会让后一段把前一段**顶掉**，而这里正是本轮唯一要守住的东西。
 */
function assertUniqueConversationIds(items: OrderConversationRecord[]): void {
  const seen = new Set<string>();
  for (const conversation of items) {
    if (seen.has(conversation.id)) {
      throw new Error(`预置会话 id 重复：${conversation.id}（同一订单的多段会话必须各有各的 id）`);
    }
    seen.add(conversation.id);
  }
}

export const conversationSeed: OrderConversationRecord[] = built.map((item) => item.conversation);

export const messageSeed: OrderMessage[] = built.flatMap((item) => item.messages);

assertUniqueConversationIds(conversationSeed);

/**
 * 预置的**客服侧**已读位置（`${orderId}:${staffId}` → 读到哪一刻）。
 *
 * 只给一个订单留记录，而且只有 `staff-1` 这一条：工作台上要能同时看到
 * 「已经处理完、没有未读」与「还有用户消息没读」两种样子。清一色未读的话，
 * 「客服读过的会话未读数归零」这条规则在验收时根本看不出来。
 *
 * ⚠️ 与用户侧的 `userLastReadAt` **无关**：这里的 315 分钟与
 * `ord-seed-1001-03` 的 `userLastReadMinutesAgo: 315` 数值相同纯属巧合
 * （两条都表示「读到那批消息的末尾」），不是同一份状态被写了两遍。
 *
 * ⚠️ **键是订单，不是会话**（`StaffReadRecord` 的理由）：客服读的是「这一单」，
 * 换人之后他不需要重新读一遍。因此这里的校验是「这一单**有**会话」，
 * 而不是「存在一个 id 等于订单号的会话」——后者在 P0-14 之后不再成立。
 *
 * ⚠️ 未列出的订单 = 这位客服从未读过，用户与打手发来的消息**全部算未读**。
 * 这正是新客服第一次打开工作台该看到的样子。
 */
const staffReadInputs: readonly { orderId: string; staffId: string; readMinutesAgo: number }[] = [
  { orderId: "ord-seed-1001-03", staffId: PRESET_STAFF_SENDER_ID, readMinutesAgo: 315 },
];

export const staffReadSeed: StaffReadRecord[] = staffReadInputs.map((input) => {
  const conversation = conversationSeed.find((item) => item.orderId === input.orderId);
  if (!conversation) {
    throw new Error(`预置客服已读位置指向没有会话的订单：${input.orderId}`);
  }
  const lastReadAt = minutesAgo(input.readMinutesAgo);
  // 与**最早**那一段比：客服的游标是订单级的，它必须晚于这一单第一段会话的创建时间
  const earliest = conversationSeed
    .filter((item) => item.orderId === input.orderId)
    .reduce((min, item) => (item.createdAt < min ? item.createdAt : min), conversation.createdAt);
  if (lastReadAt < earliest) {
    throw new Error(`预置客服已读位置早于会话创建时间：${input.orderId}`);
  }
  return { orderId: input.orderId, staffId: input.staffId, lastReadAt };
});
