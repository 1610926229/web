import type {
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
 * 用途：让「订单沟通」与客服工作台在没有任何真实客服/打手在工作台回消息的当前阶段，
 * 也能看到**三种发送者**（用户 / 护航 / 客服）、未读角标、长消息与
 * 「刚发起还没聊过的会话」。
 *
 * 三条不变量在 `build` 里强制校验，写错会当场抛错：
 *
 * 1. **消息必须属于会话所属用户的订单**——这是「只能看自己的会话」在数据上的落点；
 * 2. **会话必须先于消息存在**——消息挂在会话上，否则会话列表与聊天页会对不上；
 * 3. **消息时间不能早于订单支付时间**——否则聊天记录会出现在下单之前。
 *
 * ⚠️ **时间一律相对「进程基准时间」**（`mockClock` 的 `getMockSeedNow()`），
 * 不写死绝对日期。理由与周期排行榜完全相同：写死日期之后，客服工作台的
 * 「今日消息数」过几天就永远是 0，验收时看到的是一个坏掉的数字。
 *
 * ⚠️ 代价是它与**订单种子的绝对日期**（2026-09-08 起）不在同一条时间线上：
 * 当真机上把系统时间调到那些日期之前时，不变量 3 会抛错——那是数据自相矛盾，
 * 不是「今天没消息」。真发生的话按报错信息改基准即可。
 *
 * ⚠️ 用户端只能发出 `user` 角色的消息，客服端只能发出 `customer_service` 角色的消息：
 * 能不能发是**服务端写的**，不是预置数据决定的（详见 `lib/types/message.ts`）。
 * 这里的护航 / 客服消息只是历史的展示数据。
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
  /** 一条消息都没有的会话用它记创建时间 */
  createdAtMinutesAgo: number;
  userLastReadMinutesAgo: number | null;
  messages: PresetMessageInput[];
};

function buildConversation(input: PresetConversationInput): {
  conversation: OrderConversationRecord;
  messages: OrderMessage[];
} {
  const order = requireOrder(input.orderId);
  const staff = presetStaff();

  const messages = input.messages.map((message): OrderMessage => {
    // 不变量 1：消息的角色决定发送者是谁，发送者与快照都取自预置名单，不单独手写
    const sender =
      message.role === "user"
        ? { id: order.userId, name: userName(order.userId), avatarUrl: userAvatar(order.userId) }
        : message.role === "customer_service"
          ? { id: staff.id, name: staff.displayName, avatarUrl: staff.avatarUrl }
          : order.companionId
            ? {
                id: order.companionId,
                name: companionOf(order.companionId).displayName,
                avatarUrl: companionOf(order.companionId).avatarUrl,
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
    orderId: order.id,
    userId: order.userId,
    createdAt,
    userLastReadAt,
  };

  // 不变量 2：会话内消息按时间升序，页面上直接顺序渲染
  messages.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
  return { conversation, messages };
}

const built = [
  // 还在等接单的一单：只有客服消息，全部已读
  buildConversation({
    orderId: "ord-seed-1001-01",
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
  // 护航中的一单：有退款申请在审核中，客服回了一条，用户还没读 → 用户侧未读角标 2
  buildConversation({
    orderId: "ord-seed-1001-04",
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
        id: "msg-seed-1001-04-5",
        role: "customer_service",
        body: "已收到你提交的退款申请，客服正在核实这一单的服务记录，请留意系统通知。",
        minutesAgo: 160,
      },
      {
        id: "msg-seed-1001-04-6",
        role: "companion",
        body: "我先打一把，你回来说一声就行。",
        minutesAgo: 150,
      },
    ],
  }),
  // 已接单的一单：全部已读，用于验证「没有未读角标」的样子
  buildConversation({
    orderId: "ord-seed-1001-03",
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
    createdAtMinutesAgo: 500,
    userLastReadMinutesAgo: null,
    messages: [],
  }),
  // 老板B 的一单：验证互相看不到对方的会话
  buildConversation({
    orderId: "ord-seed-1002-01",
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

/** 去重校验：同一订单只能有一个会话，否则聊天记录会被拆成两份。 */
function assertNoDuplicateConversation(items: OrderConversationRecord[]): void {
  const seen = new Set<string>();
  for (const conversation of items) {
    if (seen.has(conversation.orderId)) {
      throw new Error(`预置会话重复：${conversation.orderId}`);
    }
    seen.add(conversation.orderId);
  }
}

export const conversationSeed: OrderConversationRecord[] = built.map((item) => item.conversation);

export const messageSeed: OrderMessage[] = built.flatMap((item) => item.messages);

assertNoDuplicateConversation(conversationSeed);

/**
 * 预置的**客服侧**已读位置（`${orderId}:${staffId}` → 读到哪一刻）。
 *
 * 只给一个会话留记录，而且只有 `staff-1` 这一条：工作台上要能同时看到
 * 「已经处理完、没有未读」与「还有用户消息没读」两种样子。清一色未读的话，
 * 「客服读过的会话未读数归零」这条规则在验收时根本看不出来。
 *
 * ⚠️ 与用户侧的 `userLastReadAt` **无关**：这里的 315 分钟与
 * `ord-seed-1001-03` 的 `userLastReadMinutesAgo: 315` 数值相同纯属巧合
 * （两条都表示「读到那批消息的末尾」），不是同一份状态被写了两遍。
 *
 * ⚠️ 未列出的会话 = 这位客服从未读过，用户与打手发来的消息**全部算未读**。
 * 这正是新客服第一次打开工作台该看到的样子。
 */
const staffReadInputs: readonly { orderId: string; staffId: string; readMinutesAgo: number }[] = [
  { orderId: "ord-seed-1001-03", staffId: PRESET_STAFF_SENDER_ID, readMinutesAgo: 315 },
];

export const staffReadSeed: StaffReadRecord[] = staffReadInputs.map((input) => {
  const conversation = conversationSeed.find((item) => item.orderId === input.orderId);
  if (!conversation) {
    throw new Error(`预置客服已读位置指向不存在的会话：${input.orderId}`);
  }
  const lastReadAt = minutesAgo(input.readMinutesAgo);
  if (lastReadAt < conversation.createdAt) {
    throw new Error(`预置客服已读位置早于会话创建时间：${input.orderId}`);
  }
  return { orderId: input.orderId, staffId: input.staffId, lastReadAt };
});
