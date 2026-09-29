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
 * 决策的金额同样**由公式算出来**，不手写：决策里的**退款比例**是「当时谁批的、
 * 按什么比例批的」这个历史事实，必须由种子作者显式写出，而金额是它的推论。
 *
 * ⚠️ **P0-15 起「一个订单最多一条退款申请」是硬规则**，因此本文件底部的跨记录校验
 * 从「累计金额不得超过实付」升级为「订单号不得重复」——预置数据里出现两条同订单申请，
 * 今天已经不是「一种历史形态」，而是一条**不可能被写出来的数据**
 * （`createRefundRequest` 会拒绝它）。让它在启动时就抛错，比等到某个页面渲染出
 * 一个两次退款的订单要好。
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
   * 资金决策的**输入**（只有退款比例）：`approved` 必填、其余状态**禁止填写**。
   *
   * ⚠️ 只给输入，不给金额：两个金额由 `computeRefundDecisionAmounts` 从订单快照算
   * （P0-15 指令 ①§二 / ①§三：退款额按比例取整，打手冲回额**与比例无关、恒为整笔**），
   * 与运行时那条路径**走的是同一个函数**。手写金额的话，预置数据里的
   * 「退款额 = 实付 × 比例、冲回额 = 订单收益」就会是一份没人验证过的算术。
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
    throw new Error(`预置退款 ${input.id} 已通过，必须给出资金决策（退款比例）`);
  }
  if (input.status !== "approved" && input.decide) {
    throw new Error(`预置退款 ${input.id} 不是「已通过」，不能带资金决策`);
  }

  const settled = input.status === "approved" || input.status === "rejected";
  const decidedAt = input.reviewedAt ?? input.createdAt;
  const amounts = input.decide
    ? computeRefundDecisionAmounts({
        actualPaidAmount: order.actualPaidAmount,
        // 预置数据里一个订单最多一条申请（文件底部的跨记录校验钉死），
        // 因此这里既没退过钱、也没冲回过收益，不存在需要减掉的前序金额
        companionBaseIncome: order.companionBaseIncome,
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
            // 与写入路径同一口径：比例**原样存下**，不再有 null 这个取值
            refundRateBp: input.decide.refundRateBp,
            refundAmount: amounts.refundAmount,
            // 整笔归零，与比例无关（P0-15 §三）
            companionReversalAmount: amounts.companionReversalAmount,
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
  // ⚠️ **负向预置（2026-09-27 产品裁定后）**：待审核，但订单是「已接单」。
  //
  // 这是 P0-12 之前的**历史留痕**：那时 `accepted` 还能开售后申请，这条就是当时开出来的。
  // P0-12 把 `paid` / `accepted` 改成免审批直接退款之后，这两档**开不出新申请**，
  // 但**存量**记录仍在——它的存在本身就是「规则变了，历史还在」的证据。
  //
  // ⚠️ **它现在是一条「审核必须被拒绝」的预置数据**（产品裁定 2026-09-27：
  // `paid` / `accepted` 不允许批准售后退款申请）。审核入口的状态闸会挡下它，
  // 而**驳回**仍然可以（那正是这类申请的应有处置）——见 `tests/adminRefunds.test.mjs`。
  // 需要「可以正常批准的待审核申请」请用下面的 `rf-seed-1003-01`。
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
    // 资金决策：服务未开始，全额退（100%）。
    // ⚠️ 预置数据里**没有 Earning**（收益只在运行时由订单完成产生），因此
    // `companionReversalAmount` 写下的那个数**今天没有可冲的对象**——这不矛盾：
    // 冲回的对象是「订单冻结的经济快照」而不是「一条已存在的 Earning」，
    // 金额在决策当时就已算好并留在退款记录上，将来由
    // `backfillRefundReversals` 在订单完成时物化。
    // ⚠️ P0-15 之前这里还要写 `responsibility: "platform"` 来表达「这笔钱不从打手身上出」，
    // **责任模型已废止**：全额退款下打手本来就没有收益可冲（订单未开始 ⇒ 不建 Earning）。
    decide: {
      refundRateBp: 10000,
    },
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

  // ——————————————————— 老板C（u-1003）：P0-13 之后**可被正常批准**的待审核申请 ———————
  //
  // ⚠️ 为什么要单独有一条：P0-12 之后 `paid` / `accepted` 开不出售后申请，
  // 而 `rf-seed-1001-01` / `rf-seed-1002-01` 这两条存量现在**必须被拒绝**
  // （见上面的说明）。于是「一条落在合法档位上、可以正常批准」的预置成了必需品——
  // 否则每个验「通过」的用例都得先自己造一条申请。
  //
  // ⚠️ **订单刻意选在 u-1001 / u-1002 之外、且不被任何用例当「干净订单」复用**：
  //    `ord-seed-1001-10` 是用户端「护航中且没有进行中申请」那条断言的样本，
  //    在它上面挂一条待审核申请会让那个入口按规则消失（同一条规则的另一面）。
  //    挂在这张 `completed` 单上，用户端的按用户过滤列表也不受影响。
  build({
    id: "rf-seed-1003-01",
    refundNo: "RF20260901000301",
    orderId: "ord-seed-1003-01",
    status: "pending",
    reasonKey: "service_not_delivered",
    description: "打手进图后一直掉线，全程只打了一局，希望按整单退款处理。",
    createdAt: "2026-09-01T09:30:00.000Z",
    evidence: [{ kind: "image", name: "掉线记录截图.png" }],
  }),

  // ——————————————————— 老板B（u-1002）：用于验证互相看不到对方的退款 ———————————————————
  // ⚠️ **同样是负向预置**：待审核，但订单是「已付款」——与 `rf-seed-1001-01` 同理，
  // P0-12 之前的存量，审核必须被拒绝。它同时承担「互相看不到对方的退款」那组用例。
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
 * 跨记录不变量（**P0-15 起是硬规则，不再是「账要平」**）：一个订单**最多一条**退款申请。
 *
 * ⚠️ 这条校验的**性质变了**，不是把阈值收紧：P0-13 时期同一订单多条已通过申请是
 * **合法形态**（部分退款可以退第二次），那时这里查的是「已通过金额之和 ≤ 累计已退」——
 * 一个**算术**约束。P0-15 之后同订单两条申请**根本写不出来**
 * （`createRefundRequest` 直接拒绝，见 `lib/data/refundRepository.ts`），
 * 于是这里查的是**结构**约束：预置数据里出现重复订单号，说明这份种子是在旧模型下写的、
 * 或者有人照着旧规则补了一条——两种情况都必须在启动时炸掉，而不是悄悄渲染出一个
 * 「这一单退了两次」的页面。
 *
 * ⚠️ 仍然保留金额一侧的核对，但降级为**兜底**：既然一单只有一条申请，
 * 「已通过金额之和」就退化成那一条自己的金额，`≤` 检查恒真，
 * 唯一的用途是万一将来有人给一个订单预置了 approved 却没同步
 * `order.refundedAmount`。留着它是因为删掉一条校验只会让数据少一层保护。
 *
 * ⚠️ 只能查「≤」不能查「=」：订单也可能由**免审批直接退款**那条路径退掉
 * （P0-12），那条路径不产生任何退款申请记录，因此 `refundedAmount` 有值而
 * 「已通过申请之和」为 0 是完全正常的。
 */
{
  const seenOrderIds = new Set<string>();
  for (const refund of refundSeed) {
    if (seenOrderIds.has(refund.orderId)) {
      throw new Error(
        `预置退款数据违反「一个订单最多一次退款」：订单 ${refund.orderId} 出现了第二条申请`,
      );
    }
    seenOrderIds.add(refund.orderId);
  }
}

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
