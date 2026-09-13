import type { MessageSenderRole, OrderConversationRecord, OrderMessage } from "@/lib/types/message";
import { orderSeed } from "./orderSeed";
import { companionSeed, userSeed } from "./seed";

/**
 * 预置订单沟通种子（会话 + 消息）。
 *
 * 用途：让「订单沟通」在没有任何真实客服/打手在工作台回消息的当前阶段，也能看到
 * **三种发送者**（我 / 打手 / 客服）、未读角标、长消息与「刚发起还没聊过的会话」。
 *
 * 三条不变量在 `build` 里强制校验，写错会当场抛错：
 *
 * 1. **消息必须属于会话所属用户的订单**——这是「只能看自己的会话」在数据上的落点；
 * 2. **会话必须先于消息存在**——消息挂在会话上，否则会话列表与聊天页会对不上；
 * 3. **会话不能重复**（同一订单只能有一个会话），否则聊天记录会被拆成两份。
 *
 * ⚠️ 用户端只能发出 `user` 角色的消息：能不能发是**服务端写的**，不是预置数据决定的
 * （详见 `lib/types/message.ts`）。这里的打手 / 客服消息只是历史的展示数据。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

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

function companionName(id: string): string {
  const companion = companionSeed.find((item) => item.id === id);
  if (!companion) throw new Error(`Mock 种子缺失陪玩：${id}`);
  return companion.name;
}

/** 客服在预置历史里的显示名。 */
const SUPPORT_NAME = "平台客服";
const SUPPORT_ID = "support-01";

type PresetMessageInput = {
  id: string;
  role: MessageSenderRole;
  body: string;
  createdAt: string;
};

/** 会话输入：`userLastReadAt` 为 null 表示从未读过，对方消息全部算未读。 */
type PresetConversationInput = {
  orderId: string;
  createdAt: string;
  userLastReadAt: string | null;
  messages: PresetMessageInput[];
};

function buildConversation(input: PresetConversationInput): {
  conversation: OrderConversationRecord;
  messages: OrderMessage[];
} {
  const order = requireOrder(input.orderId);

  for (const message of input.messages) {
    if (message.createdAt < order.paidAt) {
      throw new Error(`预置消息 ${message.id} 的时间早于订单 ${order.id} 的支付时间`);
    }
  }
  if (input.userLastReadAt && input.userLastReadAt < input.createdAt) {
    throw new Error(`预置会话 ${input.orderId} 的已读时间早于会话创建时间`);
  }

  const conversation: OrderConversationRecord = {
    orderId: order.id,
    userId: order.userId,
    createdAt: input.createdAt,
    userLastReadAt: input.userLastReadAt,
  };

  const messages = input.messages.map((message): OrderMessage => {
    // 不变量 1：消息的角色决定发送者是谁，发送者取自订单与预置名单，不单独手写
    const sender =
      message.role === "user"
        ? { id: order.userId, name: userName(order.userId) }
        : message.role === "support"
          ? { id: SUPPORT_ID, name: SUPPORT_NAME }
          : order.companionId
            ? { id: order.companionId, name: companionName(order.companionId) }
            : null;

    if (!sender) {
      throw new Error(`预置消息 ${message.id} 是打手消息，但订单 ${order.id} 没有绑定打手`);
    }

    return {
      id: message.id,
      orderId: order.id,
      userId: order.userId,
      senderId: sender.id,
      senderRole: message.role,
      senderName: sender.name,
      body: message.body,
      createdAt: message.createdAt,
    };
  });

  // 不变量 3：会话内消息按时间升序，页面上直接顺序渲染
  messages.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1));
  return { conversation, messages };
}

const built = [
  // 已接单的一单：全部已读，用于验证「没有未读角标」的样子
  buildConversation({
    orderId: "ord-seed-1001-03",
    createdAt: "2026-09-11T14:32:00.000Z",
    userLastReadAt: "2026-09-11T15:00:00.000Z",
    messages: [
      {
        id: "msg-seed-1001-03-1",
        role: "user",
        body: "你好，今天晚上八点之后可以开始吗？",
        createdAt: "2026-09-11T14:32:00.000Z",
      },
      {
        id: "msg-seed-1001-03-2",
        role: "companion",
        body: "可以的，八点半我上线，到时候游戏里拉我。",
        createdAt: "2026-09-11T14:35:00.000Z",
      },
      {
        id: "msg-seed-1001-03-3",
        role: "user",
        body: "好的，那八点半见。",
        createdAt: "2026-09-11T14:40:00.000Z",
      },
    ],
  }),
  // 护航中的一单：有退款申请在审核中，客服回了两条，用户还没读 → 未读角标 2
  buildConversation({
    orderId: "ord-seed-1001-04",
    createdAt: "2026-09-11T03:31:00.000Z",
    userLastReadAt: "2026-09-11T04:06:00.000Z",
    messages: [
      {
        id: "msg-seed-1001-04-1",
        role: "user",
        body: "开局前先说下，我这边只打机密，其他图不打。",
        createdAt: "2026-09-11T03:31:00.000Z",
      },
      {
        id: "msg-seed-1001-04-2",
        role: "companion",
        body: "收到，按你说的来。",
        createdAt: "2026-09-11T03:33:00.000Z",
      },
      {
        id: "msg-seed-1001-04-3",
        role: "user",
        body: "刚刚掉线了，等我两分钟，马上回来。",
        createdAt: "2026-09-11T03:50:00.000Z",
      },
      {
        id: "msg-seed-1001-04-4",
        role: "companion",
        body: "好，我在大厅等你，不急。",
        createdAt: "2026-09-11T04:05:00.000Z",
      },
      {
        id: "msg-seed-1001-04-5",
        role: "support",
        body: "已收到你提交的退款申请，客服正在核实这一单的服务记录，请留意系统通知。",
        createdAt: "2026-09-12T01:25:00.000Z",
      },
      {
        id: "msg-seed-1001-04-6",
        role: "companion",
        body: "我先打一把，你回来说一声就行。",
        createdAt: "2026-09-12T01:40:00.000Z",
      },
    ],
  }),
  // 还在等接单的一单：只有客服消息，全部已读
  buildConversation({
    orderId: "ord-seed-1001-01",
    createdAt: "2026-09-12T13:20:00.000Z",
    userLastReadAt: "2026-09-12T13:45:00.000Z",
    messages: [
      {
        id: "msg-seed-1001-01-1",
        role: "user",
        body: "这一单还没人接吗？",
        createdAt: "2026-09-12T13:20:00.000Z",
      },
      {
        id: "msg-seed-1001-01-2",
        role: "support",
        body: "这边帮你看一下，稍后给你回复。",
        createdAt: "2026-09-12T13:26:00.000Z",
      },
      {
        id: "msg-seed-1001-01-3",
        role: "support",
        body: "已经帮你催过了，有打手接单后会第一时间通知你。",
        createdAt: "2026-09-12T13:40:00.000Z",
      },
    ],
  }),
  // 刚发起、还没聊过的会话：列表上要能正常显示「还没有消息」
  buildConversation({
    orderId: "ord-seed-1001-07",
    createdAt: "2026-09-08T09:30:00.000Z",
    userLastReadAt: null,
    messages: [],
  }),
  // 老板B 的一单：验证互相看不到对方的会话
  buildConversation({
    orderId: "ord-seed-1002-01",
    createdAt: "2026-09-12T09:05:00.000Z",
    userLastReadAt: "2026-09-12T09:06:00.000Z",
    messages: [
      {
        id: "msg-seed-1002-01-1",
        role: "user",
        body: "这单大概什么时候能开始？",
        createdAt: "2026-09-12T09:05:00.000Z",
      },
      {
        id: "msg-seed-1002-01-2",
        role: "support",
        body: "正在为你匹配打手，接单后会通知你。",
        createdAt: "2026-09-12T09:20:00.000Z",
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
