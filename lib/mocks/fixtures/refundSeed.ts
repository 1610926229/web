import {
  REFUND_REASON_LABELS,
  computeRefundDecisionAmounts,
  hasRefundPath,
  type RefundDecisionInput,
} from "@/lib/constants/refunds";
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
 * 2. **待审核 / 审核中（pending / reviewing）不得改变订单状态**——订单必须仍**有退款路径可走**
 *    （`hasRefundPath`：已付款 / 已接单 / 护航中 / 已完成），这正是「退款审核中」要证明的事；
 * 3. **已拒绝 / 已撤销（rejected / cancelled）同样不改变订单状态**，且订单绝不能是已退款。
 *
 * ⚠️ 不变量 2 判的是「订单没有变成终态」，**不是**「这条申请此刻还能再提交一次」：
 * P0-12 起已付款 / 已接单改为免审批直接退款，那两档**开不出新的申请**，但
 * **存量**的申请可以存在（`rf-seed-1001-01` 挂在一张已接单的订单上、
 * `rf-seed-1002-01` 挂在一张已付款的订单上，两条都是有意留着的）。
 * 用 `isOrderRefundable` 去判会在这两条上抛错，那等于让预置数据去否认一段真实的
 * 业务历史——`tests/directRefund.test.mjs` 专门有用例钉住这两条存量的处置方式。
 *
 * 金额一律取自**订单自己的实付金额**（`order.actualPaidAmount`，即 §17 的退款基数）
 * 并按分存储，不在这里手写数字——手写的金额迟早会和订单对不上。
 *
 * ⚠️ **P0-13 起多一条自洽要求：`approved` 必须有资金决策**（见 `build` 的不变量 4）。
 * 决策的三个金额同样**由公式算出来**，不手写：决策里的比例与责任归属是「当时谁批的、
 * 按什么比例批的」这个历史事实，必须由种子作者显式写出，而金额是它的推论。
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
  /**
   * 资金决策的**输入**（比例与责任归属）：`approved` 必填、其余状态**禁止填写**。
   *
   * ⚠️ 只给输入，不给金额：三个金额由 `computeRefundDecisionAmounts` 按 §17 算，
   * 与运行时那条路径**走的是同一个函数**。手写金额的话，预置数据里的
   * 「退款 = 打手冲回 + 平台承担」就会是一份没人验证过的算术。
   */
  decide?: RefundDecisionInput;
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
  if ((input.status === "pending" || input.status === "reviewing") && !hasRefundPath(order.status)) {
    throw new Error(
      `预置退款 ${input.id} 处于审核中，对应订单 ${order.id} 必须是仍可退款的业务状态（已付款 / 已接单 / 护航中 / 已完成）`,
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
  // 不变量 4（P0-13）：决策与状态必须成对出现——已通过**必须**有决策，
  // 其余状态**必须没有**。少了一半，页面上就会出现「已通过但退了多少不知道」
  // 或「还没批却写着退了多少」这两种互相矛盾的展示。
  if (input.status === "approved" && !input.decide) {
    throw new Error(`预置退款 ${input.id} 已通过，必须给出资金决策（比例与责任归属）`);
  }
  if (input.status !== "approved" && input.decide) {
    throw new Error(`预置退款 ${input.id} 不是「已通过」，不能带资金决策`);
  }

  const settled = input.status === "approved" || input.status === "rejected";
  const decidedAt = input.reviewedAt ?? input.createdAt;
  const amounts = input.decide
    ? computeRefundDecisionAmounts({
        actualPaidAmount: order.actualPaidAmount,
        companionBaseIncome: order.companionBaseIncome,
        // 预置数据里一个订单最多一条已通过申请，因此没有既往冲回
        reversedSoFar: 0,
        input: input.decide,
      })
    : null;

  return {
    id: input.id,
    refundNo: input.refundNo,
    userId: order.userId,
    orderId: order.id,
    status: input.status,
    // 申请时的实付快照，不手写
    amount: order.actualPaidAmount,
    decision:
      input.decide && amounts
        ? {
            refundRateBp: input.decide.refundRateBp,
            refundAmount: amounts.refundAmount,
            responsibility: input.decide.responsibility,
            companionLiabilityRateBp: input.decide.companionLiabilityRateBp,
            companionReversalAmount: amounts.companionReversalAmount,
            platformBorneAmount: amounts.platformBorneAmount,
            decidedBy: MOCK_ADMIN_LOGIN_ID,
            decidedAt,
          }
        : null,

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
    // 资金决策：服务未开始，全额退、平台承担。
    // ⚠️ 预置数据里**没有 Earning**（收益只在运行时由订单完成产生），因此这里也不能写
    // 「已从打手收益冲回多少」的责任归属——那会造出一条有冲回金额、却没有对应
    // 冲回明细的历史决策，而 P0-13 要求平台承担与打手承担都必须可审计（Q1-c）。
    decide: { refundRateBp: 10000, responsibility: "platform", companionLiabilityRateBp: null },
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

/**
 * 跨记录不变量（P0-13）：任一订单上**已通过**申请的退款金额之和，
 * 不得超过该订单的 `refundedAmount`。
 *
 * 为什么必须在这里再查一遍：「一条申请自洽」不代表「一单的账自洽」。
 * 部分退款上线后，同一订单可以有多条已通过申请，而每条各自都算对的情况下，
 * 它们的**和**仍然可能超过订单实付——那正是「累计退款不得超过实付」这条规则
 * （`cmd_p0-13.md`）被破坏的样子。这条校验让预置数据一旦越界就在启动时抛错，
 * 而不是等到某个页面显示出一个退不完的账。
 *
 * ⚠️ 只能查「≤」不能查「=」：订单也可能由**免审批直接退款**那条路径退掉
 * （P0-12），那条路径不产生任何退款申请记录，因此 `refundedAmount` 有值而
 * 「已通过申请之和」为 0 是完全正常的。
 */
for (const order of orderSeed) {
  const approvedTotal = refundSeed
    .filter((refund) => refund.orderId === order.id && refund.status === "approved")
    .reduce((total, refund) => total + (refund.decision?.refundAmount ?? 0), 0);

  if (approvedTotal > order.refundedAmount) {
    throw new Error(
      `预置退款数据不自洽：订单 ${order.id} 的已通过申请合计 ${approvedTotal} 分，` +
        `超过该订单累计已退 ${order.refundedAmount} 分`,
    );
  }
}
