import type { MessageSenderRole } from "@/lib/types/message";
import type { NotificationKind } from "@/lib/types/notification";

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
  system: "系统",
};

export const NOTIFICATION_EMPTY_TITLE = "暂无通知";
export const NOTIFICATION_EMPTY_DESCRIPTION = "订单、退款与投诉的进展会在这里通知你";

/** 通知列表默认每页条数。 */
export const NOTIFICATION_PAGE_SIZE = 20;

export const NOTIFICATION_MAX_PAGE_SIZE = 50;
