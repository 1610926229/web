import type { MessageSenderRole } from "@/lib/types/message";
import type { NotificationInput, NotificationKind } from "@/lib/types/notification";

/**
 * 客服专区（订单沟通 / 联系客服 / 系统通知）的文案与规则，服务端与浏览器共用。
 *
 * ⚠️ 本文件只有 `import type`，没有运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 */

/** 客服页的三个子 Tab。顺序与原型一致。 */
export type ServiceTabKey = "chat" | "contact" | "notice";

export const SERVICE_TABS: readonly { key: ServiceTabKey; label: string }[] = [
  { key: "chat", label: "订单沟通" },
  { key: "contact", label: "联系客服" },
  { key: "notice", label: "系统通知" },
];

export function isServiceTab(value: string): value is ServiceTabKey {
  return SERVICE_TABS.some((tab) => tab.key === value);
}

/**
 * 解析地址里的子 Tab：
 *
 * 与订单列表的状态筛选同一套行为——地址是用户随手可改的，非法值回退到第一个 Tab，
 * 而不是把整页变成错误页（接口收到非法值仍然报错）。
 */
export function parseServiceTab(raw: string | null): ServiceTabKey {
  const value = (raw ?? "").trim();
  return isServiceTab(value) ? value : "chat";
}

// —— 订单沟通 ——

/** 单条消息长度上限。 */
export const MESSAGE_MAX_LENGTH = 200;

export const MESSAGE_EMPTY_MESSAGE = "消息内容不能为空";
export const MESSAGE_TOO_LONG_MESSAGE = `单条消息不能超过 ${MESSAGE_MAX_LENGTH} 个字`;

/**
 * 发送者角色显示名（**用户端口径**）。
 *
 * ⚠️ 用户端把 `user` 显示成「我」。客服工作台里同一个角色显示成「用户」，
 * 那张表在 `lib/constants/staff.ts` 的 `STAFF_MESSAGE_ROLE_LABELS`——
 * 两边各写一份是有意的，不是重复。
 */
export const MESSAGE_ROLE_LABELS: Record<MessageSenderRole, string> = {
  user: "我",
  companion: "打手",
  customer_service: "客服",
};

/** 会话列表里「对方」的称呼：用户自己发的显示「我」。 */
export function messageSenderLabel(role: MessageSenderRole, isSelf: boolean): string {
  return isSelf ? "我" : MESSAGE_ROLE_LABELS[role];
}

/**
 * 发送消息的校验：去掉首尾空白后必须非空且不超长。
 * **返回去除空白后的内容**，避免「只发了几个空格」被当成有效消息。
 */
export function normalizeMessageBody(raw: string): { ok: true; body: string } | { ok: false; message: string } {
  const body = raw.trim();
  if (!body) return { ok: false, message: MESSAGE_EMPTY_MESSAGE };
  if (body.length > MESSAGE_MAX_LENGTH) return { ok: false, message: MESSAGE_TOO_LONG_MESSAGE };
  return { ok: true, body };
}

/** 客服页空态文案。 */
export const CONVERSATION_EMPTY_TITLE = "还没有订单沟通";
export const CONVERSATION_EMPTY_DESCRIPTION = `订单开始后，可以在这里和客服、${MESSAGE_ROLE_LABELS.companion}沟通`;

/**
 * 订单详情页「订单沟通」入口的说明（未读为 0 时显示）。
 *
 * ⚠️ 角色词**取自 `MESSAGE_ROLE_LABELS`**，不另写一个「打手」字面量。
 * 这条说明原先写死在 `app/(mobile)/orders/[id]/page.tsx` 里——
 * 那个页面**不在**「页面里不许写死角色词」那道源码门禁的覆盖范围内，
 * 于是它成了角色的**第二份来源**而没人发现。**门禁的范围是一份名单，
 * 名单漏掉一个文件不等于那个文件里就没有第二份来源。**
 * 本次改为取本常量，并把「这一条说明必须来自常量」写进了那道门禁
 * （`tests/assignmentConversations.test.mjs` 的「称呼来源」第 4 条）。
 *
 * ⚠️ **全额退款之后这条说明仍然说「与……沟通」**，字面上比实际能做多了一项
 * （履约那一段已只读，只剩客服可写）。**本次刻意不改**，理由是：
 * 改它需要往订单详情 DTO 的 `allowedActions` 上加一个字段，而**页面不许
 * 自己拿 `order.status` 再判一次**（同一条不改的理由见
 * `tests/assignmentConversations.test.mjs` 的「只读 8」）。入口本身必须留着
 * ——进去才看得到被裁定要求「保留可查」的记录。登记为 NOTE-5，
 * 见 `docs/03-dev/rounds/P0-14/03-delivery.md` §六.4。
 */
export const CONVERSATION_ENTRY_HINT = `与客服 / ${MESSAGE_ROLE_LABELS.companion}沟通`;

// —— 发送对象（P0-14）——

/**
 * 用户发消息时的**发送对象**。
 *
 * ⚠️ 只有两个取值，而且**都不是内部键**：
 *
 * - `service` —— 发给客服（客服会话）；
 * - `current` —— 发给**当前正在服务的那位打手**（当前履约会话）。
 *
 * ⚠️ **没有「发给某一段历史履约」这个取值，而且是刻意的**：
 * 用户不给旧打手发消息（`cmd_p0-14.md` §2.1「历史 assignment 会话只读」），
 * 而接口**在结构上就写不出这个请求**——没有那个枚举值，就不存在
 * 「传了段号但忘了校验权限」这种漏洞。这比「先允许传、再判权限」更结实。
 *
 * ⚠️ 值为 `current` 而不是某个会话 id：会话 id 是内部键（见
 * `lib/constants/conversations.ts`），让它出现在请求体里等于把「调用方可以指定段」
 * 这个能力交给客户端。
 */
export const MESSAGE_TARGETS = ["service", "current"] as const;

export type MessageTarget = (typeof MESSAGE_TARGETS)[number];

/**
 * 省略发送对象时的默认值。
 *
 * ⚠️ **必须是 `service`**，理由有两条，都不是风格问题：
 *
 * 1. **零回归**：P0-14 之前用户发出的消息全部落在客服会话里。默认值改成
 *    `current` 会让「用户 → 客服」这条既有链路的落点悄悄换一个地方，
 *    而旧调用方（以及不知道有段这回事的页面）根本不会察觉；
 * 2. **安全方向**：默认值决定的是「调用方什么都没说时消息去哪」。
 *    默认投给客服，出错时消息落在**用户与服务人员之间**；默认投给打手，
 *    出错时消息可能落在一位**用户并不认识的人**那里。
 */
export const DEFAULT_MESSAGE_TARGET: MessageTarget = "service";

export const MESSAGE_TARGET_INVALID_MESSAGE = `消息发送对象只能是 ${MESSAGE_TARGETS.join(" / ")}`;

/**
 * 目标段是「当前履约」但订单此刻没有履约人时的文案。
 *
 * ⚠️ 用「打手」而不是「护航」：用户端的角色称呼以本文件的 `MESSAGE_ROLE_LABELS`
 * 为准（那里 companion 是「**打手**」），而这条提示会与消息气泡出现在同一屏。
 * 「护航」是**客服端与打手端**的叫法（`STAFF_MESSAGE_ROLE_LABELS` /
 * `COMPANION_ROLE_LABEL`）——同一个人在两处叫法不同是既有的、有明文的分工。
 */
export const MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE = "当前没有打手正在为你服务，无法给打手发消息";

/** 目标段是「当前履约」但已有履约人、只是这段会话取不到时的兜底文案（正常不该出现）。 */
export const MESSAGE_ASSIGNMENT_CONVERSATION_MISSING_MESSAGE = "当前打手会话不可用，请稍后再试";

/**
 * 目标段是「当前履约」但这一单**已全额退款**时的文案。
 *
 * ⚠️ 这是**写**的拒绝，不是**读**的拒绝：裁定 `TBD-P0-14-1`（2026-09-27）规定全额退款后
 * 履约段的聊天历史**保留可查**，只是不能再发送。因此这条文案必须让人明白
 * 「记录还在、只是不能发了」，而不是让人以为记录被清掉了。
 *
 * ⚠️ 与 `MESSAGE_NO_ACTIVE_ASSIGNMENT_MESSAGE` 是**两回事**，不能合并：
 * 那条说的是「现在没有人给你服务」（换人之后、回池之后），
 * 这条说的是「人还在记录里，但这一单退掉了」。同一条提示应付两种原因，
 * 用户会拿着「没有打手服务」去问客服「那我之前聊的那些呢」。
 */
export const MESSAGE_ORDER_REFUNDED_MESSAGE = "这一单已全额退款，沟通记录仍可查看，但无法继续给打手发消息";

/**
 * 解析发送对象。
 *
 * ⚠️ 与 `readStaffOrderStatusFilter` 同一套路：**返回 null 表示「解析不了」，
 * 与「解析成默认值」是两回事**。调用方据此决定是报 400 还是回退默认值——
 * 把「非法值」也悄悄当成默认值，客户端写错字段时不会收到任何提示，
 * 消息却安静地飞到了另一个地方。
 *
 * `undefined` / `null` / 空串都算「没给」，走默认值。
 */
export function readMessageTarget(raw: unknown): MessageTarget | null {
  if (raw === undefined || raw === null) return DEFAULT_MESSAGE_TARGET;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return DEFAULT_MESSAGE_TARGET;
  return (MESSAGE_TARGETS as readonly string[]).includes(value) ? (value as MessageTarget) : null;
}

// —— 打手端订单聊天（P0-14）——

export const COMPANION_MESSAGE_EMPTY_MESSAGE = MESSAGE_EMPTY_MESSAGE;
/** 打手在这条订单上没有可用的履约聊天（不是当前的履约人 / 已被换下）。 */
export const COMPANION_CONVERSATION_FORBIDDEN_MESSAGE = "这条订单当前不在你的服务中，无法查看聊天";

/**
 * 打手仍能看到这段履约会话、但这一单已全额退款时的发消息拒绝文案。
 *
 * ⚠️ **刻意不含任何角色词**（既不说「护航」也不说「打手」），**不要「统一措辞」
 * 往里加一个**：这是拒绝文案，读它的人就是**本人**，句子里的主语天然是「你」。
 * 加角色词只会多出一个可能选错的词——
 * 用户端那一条 `MESSAGE_ORDER_REFUNDED_MESSAGE` 才需要说「打手」，
 * 因为它是对**下单用户**说的，用户端一律叫「打手」。
 * （两套词表的分工见 `COMPANION_ROLE_LABEL` 与 `MESSAGE_ROLE_LABELS`。）
 *
 * ⚠️ 与 `COMPANION_CONVERSATION_FORBIDDEN_MESSAGE` 是**两回事**：那条是 404
 * （这段聊天根本不属于你），这条是 400（属于你、但已经不能写了）。
 * 把退款也做成 404 会让护航以为「我被换下了」，而其实记录仍然对他可见。
 */
export const COMPANION_ORDER_REFUNDED_MESSAGE = "这一单已全额退款，沟通记录仍可查看，但无法继续发送消息";

// —— 联系客服 ——

/**
 * 平台客服说明。
 *
 * ⚠️ 这里**不出现任何 QQ / 微信 / 电话**：这些联系方式尚未确认，
 * 编造出来的号码会让用户真的去加。未定项一律用占位说明代替。
 */
export const SUPPORT_INTRO_TITLE = "平台客服";
export const SUPPORT_INTRO_DESCRIPTION =
  "订单沟通、退款与投诉都会汇总到平台客服。你可以在下方选择订单发起沟通，或提交投诉由客服跟进。";

export const SUPPORT_CONTACT_PLACEHOLDER_TITLE = "在线客服方式";
export const SUPPORT_CONTACT_PLACEHOLDER =
  "在线客服入口尚未开通，暂不提供 QQ / 微信 / 电话等联系方式。当前可通过订单沟通或提交投诉联系客服。";

export const SUPPORT_HELP_ITEMS: readonly { title: string; description: string }[] = [
  { title: "订单沟通", description: "选择一笔订单，与客服沟通该订单的问题" },
  { title: "提交投诉", description: "反馈打手服务、支付或平台服务问题，客服会跟进处理" },
  { title: "退款进度", description: "在订单详情查看退款审核状态" },
];

// —— 系统通知 ——

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  order: "订单",
  refund: "退款",
  complaint: "投诉",
  dispatch: "派单",
  system: "系统",
};

export const NOTIFICATION_EMPTY_TITLE = "暂无通知";
export const NOTIFICATION_EMPTY_DESCRIPTION = "订单、退款与投诉的进展会在这里通知你";

/** 通知列表默认每页条数。 */
export const NOTIFICATION_PAGE_SIZE = 20;

export const NOTIFICATION_MAX_PAGE_SIZE = 50;

/**
 * 写入一条通知的校验文案（P0-2）。
 *
 * 通知在本阶段**没有用户入口**：它由平台侧的业务事件产生（订单退回公共池、
 * 超时自动退款……）。因此这几条文案面向的是**调用方写错了**，不是用户填错了——
 * 用户看到的只有通知本身。
 */
export const NOTIFICATION_USER_REQUIRED_MESSAGE = "通知必须指定接收人";
export const NOTIFICATION_TITLE_REQUIRED_MESSAGE = "通知标题不能为空";
export const NOTIFICATION_SUMMARY_REQUIRED_MESSAGE = "通知摘要不能为空";
export const NOTIFICATION_BODY_REQUIRED_MESSAGE = "通知正文不能为空";
export const NOTIFICATION_HREF_INVALID_MESSAGE = "通知跳转地址只能是站内路径，且不能带查询串";

/**
 * 校验一份通知输入。
 *
 * ⚠️ 这里守的是 `lib/types/notification.ts` 里**早就写下的内容边界**，不是新规则：
 * 通知是只读的展示内容，需要看细节时通过 `href` 进到对应页面（那里会重新校验归属）。
 * 因此在**唯一的写入口**上把两条边界落成断言：
 *
 * 1. 收件人与正文缺一不可——一条没有标题或没有正文的通知，用户在列表里看到的
 *    是一个空白条目，比不通知更糟；
 * 2. `href` 只允许站内路径且不带查询串。带上查询串就等于可以把说明、理由或消息正文
 *    塞进地址里，通知会变成绕过订单页校验的旁路。
 *
 * 返回结果而不是抛错：抛什么错误码是**服务层**的事，这一层只管规则（与
 * `parseComplaintStatus` 等解析函数同一套路）。
 */
export function parseNotificationInput(
  input: NotificationInput,
): { ok: true; value: NotificationInput } | { ok: false; message: string } {
  const userId = input.userId?.trim() ?? "";
  if (!userId) return { ok: false, message: NOTIFICATION_USER_REQUIRED_MESSAGE };

  const title = input.title?.trim() ?? "";
  if (!title) return { ok: false, message: NOTIFICATION_TITLE_REQUIRED_MESSAGE };

  const summary = input.summary?.trim() ?? "";
  if (!summary) return { ok: false, message: NOTIFICATION_SUMMARY_REQUIRED_MESSAGE };

  const body = input.body?.trim() ?? "";
  if (!body) return { ok: false, message: NOTIFICATION_BODY_REQUIRED_MESSAGE };

  const href = input.href ?? null;
  if (href !== null && (!href.startsWith("/") || href.includes("?"))) {
    return { ok: false, message: NOTIFICATION_HREF_INVALID_MESSAGE };
  }

  return { ok: true, value: { userId, kind: input.kind, title, summary, body, href } };
}
