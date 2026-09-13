import type { Notification, NotificationKind } from "@/lib/types/notification";
import { complaintSeed } from "./complaintSeed";
import { orderSeed } from "./orderSeed";
import { refundSeed } from "./refundSeed";

/**
 * 预置系统通知种子。
 *
 * 用途：让「系统通知」在没有后台推送的当前阶段也能看到订单 / 退款 / 投诉 / 系统四类通知、
 * 已读与未读两种状态，以及「只能在本页展开、不能跳转」的通知（`href` 为 null）。
 *
 * ⚠️ 内容边界（两条都在 `build` 里强制校验）：
 *
 * 1. **`href` 只允许出现资源 id**，不得带上退款说明、投诉描述、消息正文或游戏 ID。
 *    需要看细节时点进去，由目标页面重新校验归属——通知本身不是获取数据的旁路。
 * 2. **`href` 指向的资源必须真实存在**：这里通过查找 `refundSeed` / `complaintSeed` /
 *    `orderSeed` 来生成地址，预置数据因此不可能链到一条不存在的退款或投诉上（那会变成
 *    用户点进去就 404 的死链）。同理，正文里也不出现游戏 ID 这类订单细节。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

function requireRefund(id: string) {
  const refund = refundSeed.find((item) => item.id === id);
  if (!refund) throw new Error(`Mock 种子缺失退款申请：${id}`);
  return refund;
}

function requireComplaint(id: string) {
  const complaint = complaintSeed.find((item) => item.id === id);
  if (!complaint) throw new Error(`Mock 种子缺失投诉：${id}`);
  return complaint;
}

function requireOrder(id: string) {
  const order = orderSeed.find((item) => item.id === id);
  if (!order) throw new Error(`Mock 种子缺失订单：${id}`);
  return order;
}

type PresetNotificationInput = {
  id: string;
  kind: NotificationKind;
  title: string;
  summary: string;
  body: string;
  createdAt: string;
  /** 已读时间；不填表示未读 */
  readAt?: string;
  /** 跳转地址；不填表示只能在本页展开阅读 */
  href?: string;
};

/** 通知正文里不允许出现的订单敏感信息。 */
const FORBIDDEN_BODY_WORDS = ["游戏ID", "游戏 ID", "备注："];

function build(userId: string, input: PresetNotificationInput): Notification {
  const href = input.href ?? null;
  // 不变量：地址里只允许资源 id，不允许 query 串（那是最容易把说明塞进去的地方）
  if (href && href.includes("?")) {
    throw new Error(`预置通知 ${input.id} 的跳转地址不允许携带查询参数：${href}`);
  }

  const text = `${input.title}${input.summary}${input.body}`;
  const forbidden = FORBIDDEN_BODY_WORDS.find((word) => text.includes(word));
  if (forbidden) {
    throw new Error(`预置通知 ${input.id} 的正文出现了订单敏感信息「${forbidden}」`);
  }

  return {
    id: input.id,
    userId,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    body: input.body,
    createdAt: input.createdAt,
    readAt: input.readAt ?? null,
    href,
  };
}

export const notificationSeed: Notification[] = [
  // ——————————————————— 老板A（u-1001）———————————————————
  build("u-1001", {
    id: "nt-seed-1001-01",
    kind: "refund",
    title: "退款申请未通过",
    summary: "客服已核对本次服务记录，退款申请未通过。",
    body: "你的退款申请经客服核对后未通过。查看退款详情可以了解完整的处理说明；如仍有疑问，可以在投诉客服专区提交投诉，客服会进一步跟进。",
    createdAt: "2026-09-12T18:20:00.000Z",
    readAt: "2026-09-12T19:05:00.000Z",
    href: `/refunds/${requireRefund("rf-seed-1001-04").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-02",
    kind: "order",
    title: "打手已接单",
    summary: "你的订单已有打手接单，可以开始护航了。",
    body: "你的订单已被打手接单。可以在订单详情查看订单进度，也可以直接进入订单沟通联系打手。",
    createdAt: "2026-09-11T14:30:00.000Z",
    readAt: "2026-09-11T14:31:00.000Z",
    href: `/orders/${requireOrder("ord-seed-1001-03").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-03",
    kind: "refund",
    title: "退款申请已提交",
    summary: "客服正在审核你的退款申请，订单按原进度继续。",
    body: "你的退款申请已提交，客服会在核实后同步结果。审核期间订单不会改变状态，你可以随时查看退款进度。",
    createdAt: "2026-09-11T15:10:00.000Z",
    readAt: "2026-09-11T15:30:00.000Z",
    href: `/refunds/${requireRefund("rf-seed-1001-01").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-04",
    kind: "refund",
    title: "退款审核中",
    summary: "客服正在核实这笔退款申请。",
    body: "客服已开始核实你的退款申请，核实过程中可能会通过订单沟通与你联系，请留意。",
    createdAt: "2026-09-12T01:20:00.000Z",
    href: `/refunds/${requireRefund("rf-seed-1001-02").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-05",
    kind: "complaint",
    title: "投诉已处理",
    summary: "客服已处理你提交的投诉，处理结果可在投诉详情查看。",
    body: "你提交的投诉已处理完成，完整处理说明可以在投诉详情查看。如对结果仍有疑问，可以继续通过订单沟通联系客服。",
    createdAt: "2026-09-10T11:30:00.000Z",
    href: `/complaints/${requireComplaint("cmp-seed-1001-03").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-06",
    kind: "refund",
    title: "退款申请已通过",
    summary: "退款申请已通过，款项按原支付渠道退回。",
    body: "你的退款申请已通过，款项将按原支付渠道退回，到账时间以支付渠道为准。订单已变更为已退款。",
    createdAt: "2026-09-09T13:30:00.000Z",
    readAt: "2026-09-09T18:00:00.000Z",
    href: `/refunds/${requireRefund("rf-seed-1001-03").id}`,
  }),
  build("u-1001", {
    id: "nt-seed-1001-07",
    kind: "system",
    title: "平台公告",
    summary: "平台服务时间与常见问题说明。",
    body: "平台客服每天 10:00 - 24:00 在线处理订单沟通、退款与投诉。遇到订单问题可以先在订单详情里发起订单沟通，我们会尽快回复。",
    createdAt: "2026-09-02T03:20:00.000Z",
    // 公告类通知没有对应页面，只能在本页展开阅读
  }),

  // ——————————————————— 老板B（u-1002）：验证互相看不到对方的通知 ———————————————————
  build("u-1002", {
    id: "nt-seed-1002-01",
    kind: "refund",
    title: "退款申请已提交",
    summary: "客服正在审核你的退款申请。",
    body: "你的退款申请已提交，客服会在核实后同步结果，你可以随时查看退款进度。",
    createdAt: "2026-09-12T09:40:00.000Z",
    href: `/refunds/${requireRefund("rf-seed-1002-01").id}`,
  }),
];
