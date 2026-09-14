import { COMPLAINT_TYPE_LABELS } from "@/lib/constants/complaints";
import type { EvidenceKind } from "@/lib/types/evidence";
import type { Complaint, ComplaintStatus, ComplaintTypeKey } from "@/lib/types/complaint";
import { MOCK_ADMIN_LOGIN_ID } from "./adminSeed";
import { orderSeed } from "./orderSeed";

/**
 * 预置投诉种子。
 *
 * 用途：把用户自己造不出来的状态（处理中 / 已处理 / 已关闭）与「不关联订单的投诉」补齐，
 * 让投诉列表的四个筛选 Tab、进度时间轴与详情页都能被完整验收。
 * 用户端新提交的投诉只会是 `pending`。
 *
 * 两条不变量在 `build` 里强制校验：
 *
 * 1. **关联的订单必须属于同一个用户**——这既是「不能投诉别人的订单」在预置数据上的落点，
 *    也保证详情页展示的订单号不会串号；
 * 2. **处理结果不得承诺平台没有承诺过的东西**：这里逐条检查 `result` 里不出现
 *    「免单 / 补偿 / 赔偿 / 退款」等字样，「已处理」只描述客服做了什么，不替平台许诺。
 *    投诉本身也不会修改订单状态，因此这里的订单状态与 `orderSeed` 完全一致。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

type PresetEvidence = { kind: EvidenceKind; name: string };

type PresetComplaintInput = {
  id: string;
  complaintNo: string;
  userId: string;
  /** 不关联订单时留空：这类投诉只能从「投诉客服专区」进入 */
  orderId?: string;
  status: ComplaintStatus;
  typeKey: ComplaintTypeKey;
  description: string;
  contact?: string;
  evidence?: PresetEvidence[];
  createdAt: string;
  processingAt?: string;
  /** 完结时间：resolved / closed 必填 */
  handledAt?: string;
  result?: string;
};

/** 处理结果里不允许出现的承诺性字眼。 */
const FORBIDDEN_RESULT_WORDS = ["免单", "补偿", "赔偿", "退款", "返现", "赔付"];

function requireOrder(id: string) {
  const order = orderSeed.find((item) => item.id === id);
  if (!order) throw new Error(`Mock 种子缺失订单：${id}`);
  return order;
}

function build(input: PresetComplaintInput): Complaint {
  const order = input.orderId ? requireOrder(input.orderId) : null;

  // 不变量 1：只能关联自己的订单。预置数据也必须守这条，否则「不能投诉别人的订单」在
  // 预置数据上就已经破了。
  if (order && order.userId !== input.userId) {
    throw new Error(`预置投诉 ${input.id} 关联的订单 ${order.id} 不属于同一用户`);
  }

  // 不变量 2：结果文案不承诺平台未承诺的结论
  const result = input.result ?? "";
  const forbidden = FORBIDDEN_RESULT_WORDS.find((word) => result.includes(word));
  if (forbidden) {
    throw new Error(`预置投诉 ${input.id} 的处理结果出现了承诺性字眼「${forbidden}」`);
  }
  if (input.status === "pending" && (input.processingAt || input.handledAt)) {
    throw new Error(`预置投诉 ${input.id} 还是待处理，不应有处理时间`);
  }
  if ((input.status === "resolved" || input.status === "closed") && !input.handledAt) {
    throw new Error(`预置投诉 ${input.id} 已完结，必须有完结时间`);
  }

  const settled = input.status === "resolved" || input.status === "closed";
  const userId = input.userId;

  return {
    id: input.id,
    complaintNo: input.complaintNo,
    userId,
    orderId: order ? order.id : null,
    // 订单号快照：不关联订单时为 null
    orderNo: order ? order.orderNo : null,

    status: input.status,
    typeKey: input.typeKey,
    typeLabel: COMPLAINT_TYPE_LABELS[input.typeKey] ?? input.typeKey,
    description: input.description,
    evidence: (input.evidence ?? []).map((item, index) => ({
      id: `${input.id}-ev-${index + 1}`,
      kind: item.kind,
      name: item.name,
      url: "/mock/evidence-placeholder.svg",
    })),
    contact: input.contact ?? "",

    createdAt: input.createdAt,
    updatedAt: input.handledAt ?? input.processingAt ?? input.createdAt,
    processingAt: input.processingAt ?? null,
    handledAt: input.handledAt ?? null,
    // 预置数据里已出结果的记录，处理人一律记成模拟登录唯一的那个管理员账号：
    // 平台侧的处理人是从服务端会话里读出来的，预置数据里编一个不存在的 id
    // 会让详情页显示出一个谁也找不到的人。
    handledById: settled ? MOCK_ADMIN_LOGIN_ID : null,
    // 预置数据里已出结果的是**管理员**处理的，所以角色写 "admin"；
    // 客服处理的记录由 P8D-2 之后的操作产生，不预置（理由同退款预置数据）。
    handledByRole: settled ? "admin" : null,
    handledByName: null,
    result,
  };
}

export const complaintSeed: Complaint[] = [
  // ——————————————————— 老板A（u-1001）：四种状态 + 一条不关联订单的 ———————————————————
  build({
    id: "cmp-seed-1001-01",
    complaintNo: "TS20260904000101",
    userId: "u-1001",
    orderId: "ord-seed-1001-10",
    status: "pending",
    typeKey: "companion_service",
    description: "打手开打之后一直没开麦，中间还掉线了两次，希望客服帮忙看一下这单的情况。",
    createdAt: "2026-09-04T13:00:00.000Z",
  }),
  build({
    id: "cmp-seed-1001-02",
    complaintNo: "TS20260905000102",
    userId: "u-1001",
    orderId: "ord-seed-1001-12",
    status: "processing",
    typeKey: "refund_dispute",
    description: "这一单之前申请过退款没有通过，我对结果有疑问，想请客服再核对一下当时的记录。",
    contact: "微信同手机号，工作日晚上方便联系",
    createdAt: "2026-09-05T06:20:00.000Z",
    processingAt: "2026-09-05T09:10:00.000Z",
    evidence: [{ kind: "image", name: "订单截图.png" }],
  }),
  build({
    id: "cmp-seed-1001-03",
    complaintNo: "TS20260910000103",
    userId: "u-1001",
    orderId: "ord-seed-1001-05",
    status: "resolved",
    typeKey: "companion_service",
    description: "约好八点开始，打手八点四十才上线，耽误了时间。",
    createdAt: "2026-09-10T08:00:00.000Z",
    processingAt: "2026-09-10T08:35:00.000Z",
    handledAt: "2026-09-10T11:30:00.000Z",
    // 只描述客服做了什么，不承诺任何赔付
    result:
      "客服已核对本次服务的开始时间记录，打手确实晚于约定时间上线，已对该打手做出提醒并记录在案。感谢你的反馈。",
  }),
  build({
    id: "cmp-seed-1001-04",
    complaintNo: "TS20260902000104",
    userId: "u-1001",
    status: "closed",
    typeKey: "platform_service",
    description: "反馈一下首页加载有点慢。",
    createdAt: "2026-09-02T03:00:00.000Z",
    processingAt: "2026-09-02T07:20:00.000Z",
    handledAt: "2026-09-03T02:15:00.000Z",
    result: "客服尝试进一步核实时未收到补充信息，本次投诉先关闭。如仍有问题可重新提交并补充凭证。",
  }),

  // ——————————————————— 老板B（u-1002）：用于验证互相看不到对方的投诉 ———————————————————
  build({
    id: "cmp-seed-1002-01",
    complaintNo: "TS20260907000201",
    userId: "u-1002",
    orderId: "ord-seed-1002-02",
    status: "processing",
    typeKey: "payment_issue",
    description: "这一单支付的时候好像卡了一下，想确认下有没有重复扣款。",
    createdAt: "2026-09-07T05:00:00.000Z",
    processingAt: "2026-09-07T06:40:00.000Z",
  }),
];
