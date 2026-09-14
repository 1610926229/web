import { REFUND_REASON_LABELS, isOrderRefundable } from "@/lib/constants/refunds";
import type { EvidenceKind } from "@/lib/types/evidence";
import type { RefundReasonKey, RefundRequest, RefundStatus } from "@/lib/types/refund";
import { MOCK_ADMIN_LOGIN_ID } from "./adminSeed";
import { orderSeed } from "./orderSeed";

/**
 * 预置退款申请种子。
 *
 * 用途：把**用户自己提交不出来的那几种状态**补齐。用户端只能提交出 `pending`，
 * 而页面必须能正确展示 审核中 / 已通过 / 已拒绝 / 已撤销，所以这四种只能来自预置数据。
 *
 * 三条不变量在 `build` 里强制校验，写错数据会当场抛错而不是悄悄渲染出矛盾页面：
 *
 * 1. **已通过（approved）必须对应一笔已退款（refunded）的订单**——审核通过就是订单变
 *    已退款的原因，两者不能各说各话；
 * 2. **待审核 / 审核中（pending / reviewing）不得改变订单状态**——订单必须仍是可退款的
 *    业务状态（已付款 / 已接单 / 护航中 / 已完成），这正是「退款审核中」要证明的事；
 * 3. **已拒绝 / 已撤销（rejected / cancelled）同样不改变订单状态**，且订单绝不能是已退款。
 *
 * 金额一律取自**订单自己的实付金额**（`order.totalAmount`）并按分存储，
 * 不在这里手写数字——手写的金额迟早会和订单对不上。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

/** 预置凭证：只写类型与文件名，地址统一由 `EVIDENCE_PLACEHOLDER_URL` 占位。 */
type PresetEvidence = { kind: EvidenceKind; name: string };

type PresetRefundInput = {
  id: string;
  refundNo: string;
  orderId: string;
  status: RefundStatus;
  reasonKey: RefundReasonKey;
  description: string;
  createdAt: string;
  /** 客服开始审核的时间：reviewing 必填，其余不填 */
  reviewingAt?: string;
  /** 审核完成时间：approved / rejected 必填，其余不填 */
  reviewedAt?: string;
  reviewNote?: string;
  /** 撤销时间：cancelled 必填 */
  cancelledAt?: string;
  evidence?: PresetEvidence[];
};

function requireOrder(id: string) {
  const order = orderSeed.find((item) => item.id === id);
  if (!order) throw new Error(`Mock 种子缺失订单：${id}`);
  return order;
}

function build(input: PresetRefundInput): RefundRequest {
  const order = requireOrder(input.orderId);

  // 不变量 1/2/3：退款状态与订单状态必须自洽
  if (input.status === "approved" && order.status !== "refunded") {
    throw new Error(`预置退款 ${input.id} 已通过，对应订单 ${order.id} 必须是「已退款」`);
  }
  if (input.status !== "approved" && order.status === "refunded") {
    throw new Error(`预置退款 ${input.id} 是「${input.status}」，对应订单 ${order.id} 不能是「已退款」`);
  }
  if ((input.status === "pending" || input.status === "reviewing") && !isOrderRefundable(order.status)) {
    throw new Error(
      `预置退款 ${input.id} 处于审核中，对应订单 ${order.id} 必须是可退款的业务状态（已付款 / 已接单 / 护航中 / 已完成）`,
    );
  }
  if (input.createdAt < order.paidAt) {
    throw new Error(`预置退款 ${input.id} 的申请时间早于订单支付时间`);
  }
  if (input.status === "reviewing" && !input.reviewingAt) {
    throw new Error(`预置退款 ${input.id} 处于审核中，必须有开始审核的时间`);
  }
  if (!input.reviewingAt && (input.status === "approved" || input.status === "rejected")) {
    throw new Error(`预置退款 ${input.id} 已审核完成，必须有开始审核的时间`);
  }

  const settled = input.status === "approved" || input.status === "rejected";

  return {
    id: input.id,
    refundNo: input.refundNo,
    userId: order.userId,
    orderId: order.id,
    status: input.status,
    // 整单退款：金额就是订单实付金额，不手写
    amount: order.totalAmount,

    reasonKey: input.reasonKey,
    reasonLabel: REFUND_REASON_LABELS[input.reasonKey] ?? input.reasonKey,
    description: input.description,
    evidence: (input.evidence ?? []).map((item, index) => ({
      id: `${input.id}-ev-${index + 1}`,
      kind: item.kind,
      name: item.name,
      // 预置数据同样只写占位地址：Mock 阶段不存在真实上传
      url: "/mock/evidence-placeholder.svg",
    })),

    createdAt: input.createdAt,
    // 更新时间取最后一次状态变化的时间，没有变化就是申请时间
    updatedAt: input.cancelledAt ?? input.reviewedAt ?? input.reviewingAt ?? input.createdAt,
    reviewingAt: input.reviewingAt ?? null,
    reviewedAt: input.reviewedAt ?? null,
    // 预置数据里已出结果的记录，审核人一律记成模拟登录唯一的那个管理员账号——
    // 后台的审核人是从服务端会话里读出来的，预置数据里编一个不存在的 id
    // 会让详情页显示出一个谁也找不到的人。
    reviewedBy: settled ? MOCK_ADMIN_LOGIN_ID : null,
    // 预置数据里已出结果的是**管理员**批的，所以角色写 "admin"；
    // 客服驳回的记录由 P8D-2 之后的操作产生，不预置（预置一条「客服处理过」的历史，
    // 会让第一次打开工作台的人以为之前有人在这套系统里干过活）。
    reviewedByRole: settled ? "admin" : null,
    reviewedByName: null,
    reviewNote: input.reviewNote ?? "",
    cancelledAt: input.cancelledAt ?? null,
  };
}

export const refundSeed: RefundRequest[] = [
  // ——————————————————— 老板A（u-1001）：五种状态各一条 ———————————————————
  // 待审核：订单仍是「已接单」，客服还没开始看
  build({
    id: "rf-seed-1001-01",
    refundNo: "RF20260911000101",
    orderId: "ord-seed-1001-03",
    status: "pending",
    reasonKey: "schedule_conflict",
    description: "临时出差，这周都没时间打了，麻烦帮我退掉这一单，谢谢。",
    createdAt: "2026-09-11T15:10:00.000Z",
  }),
  // 审核中：订单仍是「护航中」，退款审核不影响订单继续进行
  build({
    id: "rf-seed-1001-02",
    refundNo: "RF20260912000102",
    orderId: "ord-seed-1001-04",
    status: "reviewing",
    reasonKey: "service_not_delivered",
    description: "约好的时间打手一直没上线，中间只打了一半就下线了，希望按整单退款处理。",
    createdAt: "2026-09-12T01:20:00.000Z",
    reviewingAt: "2026-09-12T02:10:00.000Z",
    evidence: [
      { kind: "image", name: "聊天记录截图.png" },
      { kind: "image", name: "战绩截图.png" },
    ],
  }),
  // 已通过：这一单订单状态就是「已退款」
  build({
    id: "rf-seed-1001-03",
    refundNo: "RF20260909000103",
    orderId: "ord-seed-1001-06",
    status: "approved",
    reasonKey: "other",
    description: "打手临时有事来不了，和客服确认过可以退。",
    createdAt: "2026-09-09T11:40:00.000Z",
    reviewingAt: "2026-09-09T12:00:00.000Z",
    reviewedAt: "2026-09-09T13:30:00.000Z",
    reviewNote: "已核实本次服务未开始，退款申请通过，款项按原支付渠道退回。",
  }),
  // 已拒绝：订单保持「已付款」，不会因为被拒绝而变动
  build({
    id: "rf-seed-1001-04",
    refundNo: "RF20260912000104",
    orderId: "ord-seed-1001-01",
    status: "rejected",
    reasonKey: "service_quality",
    description: "觉得打得不太好，想退款。",
    createdAt: "2026-09-12T14:00:00.000Z",
    reviewingAt: "2026-09-12T15:10:00.000Z",
    reviewedAt: "2026-09-12T18:20:00.000Z",
    reviewNote: "已与打手核对全程记录，服务过程与订单约定一致，本次退款申请未通过。如有疑问可联系客服进一步说明。",
  }),
  // 已撤销：用户自己撤回，订单保持「已付款」
  build({
    id: "rf-seed-1001-05",
    refundNo: "RF20260908000105",
    orderId: "ord-seed-1001-07",
    status: "cancelled",
    reasonKey: "other",
    description: "下错单了，先撤销，晚点重新拍。",
    createdAt: "2026-09-08T10:00:00.000Z",
    cancelledAt: "2026-09-08T10:25:00.000Z",
  }),

  // ——————————————————— 老板B（u-1002）：用于验证互相看不到对方的退款 ———————————————————
  build({
    id: "rf-seed-1002-01",
    refundNo: "RF20260912000201",
    orderId: "ord-seed-1002-01",
    status: "pending",
    reasonKey: "duplicate_payment",
    description: "这一单不小心付了两次，麻烦帮我退掉多付的那笔。",
    createdAt: "2026-09-12T09:40:00.000Z",
  }),
];
