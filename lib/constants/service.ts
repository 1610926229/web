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
export const CONVERSATION_EMPTY_DESCRIPTION = "订单开始后，可以在这里和客服、打手沟通";

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
