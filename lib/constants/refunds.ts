import type { OrderStatus } from "@/lib/types/order";
import type { RefundDecision, RefundReasonKey, RefundStatus } from "@/lib/types/refund";
import { formatShareRatioBpForInput } from "./shareRatio";

/**
 * 退款状态机与表单规则（服务端与浏览器共用）。
 *
 * ⚠️ **P0-13 起本文件有一个运行时依赖**（`./shareRatio` 的基点↔百分比换算，
 * 用于把决策里的比例显示给人看）。它不改变本文件的定位：那一份是纯函数、
 * 无服务端依赖、本来就被客户端组件引用（商品表单），因此引用它不会把服务端模块
 * 打进浏览器产物，node 也仍然能直接加载本文件做纯逻辑测试。
 * 其余全部是 `import type`。
 *
 * 这里只描述**规则**，不读写数据。判断「能不能退」的权威仍然是服务端：
 * 页面用同一套函数渲染按钮，写接口时再校验一次。
 */

/** 五个退款状态，顺序与进度时间轴一致。 */
export const REFUND_STATUSES: readonly RefundStatus[] = [
  "pending",
  "reviewing",
  "approved",
  "rejected",
  "cancelled",
];

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  pending: "待审核",
  reviewing: "审核中",
  approved: "已通过",
  rejected: "已拒绝",
  cancelled: "已撤销",
};

/** 状态文字色：全部来自 `app/globals.css` 的 `--color-status-*` 令牌。 */
export const REFUND_STATUS_CLASS: Record<RefundStatus, string> = {
  pending: "text-status-pending",
  reviewing: "text-status-info",
  approved: "text-status-success",
  rejected: "text-status-danger",
  cancelled: "text-status-muted",
};

/** 状态的一句话说明。只描述退款这件事，不承诺任何审核结果。 */
export const REFUND_STATUS_HINTS: Record<RefundStatus, string> = {
  pending: "退款申请已提交，等待客服审核。审核期间订单按原进度继续。",
  reviewing: "客服正在审核这笔退款申请，请留意系统通知。",
  approved: "退款申请已通过，款项将按原支付渠道退回。",
  rejected: "退款申请未通过，如有疑问可联系客服进一步说明。",
  cancelled: "退款申请已由你撤销，订单按原进度继续。",
};

/** 退款原因选项。**必选**，取值由服务端校验，文案只此一份。 */
export const REFUND_REASONS: readonly { key: RefundReasonKey; label: string }[] = [
  { key: "service_not_delivered", label: "打手未按约定提供服务" },
  { key: "service_quality", label: "服务过程与描述不符" },
  { key: "schedule_conflict", label: "时间冲突，无法继续本次服务" },
  { key: "duplicate_payment", label: "重复支付 / 多付了金额" },
  { key: "other", label: "其他原因" },
];

export const REFUND_REASON_LABELS = REFUND_REASONS.reduce<Record<string, string>>(
  (labels, item) => {
    labels[item.key] = item.label;
    return labels;
  },
  {},
);

export const REFUND_DESCRIPTION_MAX_LENGTH = 200;

export const REFUND_REASON_REQUIRED_MESSAGE = "请选择退款原因";
export const REFUND_DESCRIPTION_EMPTY_MESSAGE = "请填写退款说明";
export const REFUND_DESCRIPTION_TOO_LONG_MESSAGE = `退款说明不能超过 ${REFUND_DESCRIPTION_MAX_LENGTH} 个字`;

/**
 * 退款金额不可编辑的说明。
 *
 * ⚠️ **P0-13 改口径**：原来写的是「整单实付金额」——那是「一笔订单一次全额退」
 * 时代的说法。现在用户申请时**不填金额、也看不到金额**（他本来就不该能决定退多少），
 * 退多少由管理员在最终决策时按比例核定，因此这里只能说清「谁定、依据是什么」。
 */
export const REFUND_AMOUNT_NOTE = "退款金额由平台按订单实付金额核定，无需你填写";

export const REFUND_STATUS_INVALID_MESSAGE = "退款状态筛选无效";
/**
 * 该订单**已经提交过**退款申请——不论那一条现在是什么状态（P0-15）。
 *
 * ⚠️ **P0-15 改口径，同时改了变量名**：原名 `REFUND_ALREADY_ACTIVE_MESSAGE`
 * （「该订单已有**进行中**的退款申请」）说的是「等一下、还在走流程」，
 * 新规则说的是「这一单的退款机会已经用掉了」。两句话对用户意味着完全不同的两件事
 * （前者可以等，后者不能），因此**不保留旧名字**——名字不改，
 * 调用方就会继续按旧语义去理解这个失败。
 *
 * ⚠️ **措辞里不写「不能再申请」的硬话，而是给出去路**：退款入口关闭不等于
 * 「平台不管了」，与 `REFUND_WINDOW_CLOSED_MESSAGE` 同一条纪律——
 * 规则再严，也要留一句人能找到的出口。
 */
export const REFUND_ALREADY_EXISTS_MESSAGE =
  "该订单已提交过退款申请，一个订单只能申请一次退款；如有其他问题请联系客服";
export const REFUND_NOT_CANCELLABLE_MESSAGE = "只有待审核的退款申请可以撤销";
export const REFUND_ORDER_NOT_ALLOWED_MESSAGE = "该订单当前不可申请退款";
export const REFUND_AMOUNT_INVALID_MESSAGE = "订单金额异常，暂时无法发起退款";

/**
 * 已完成订单的售后窗口已过时，接口给用户的一句话（P0-13）。
 *
 * ⚠️ **窗口的判据与投诉窗口是同一个**（`isComplaintWindowClosed(order, at)`，
 * 读的是订单冻结的 `complaintDeadlineAt`），但**文案必须分开写**：
 * `COMPLAINT_WINDOW_CLOSED_MESSAGE` 讲的是「无法再发起普通投诉」，
 * 这一句讲的是「无法再提交退款申请」。合并成一句会让用户以为
 * 「投诉窗口关了」等于「退款申请也提交不了」——那是两句各自成立、互不推导的话。
 *
 * ⚠️ 与那一句同样的两条纪律，一并沿用：
 * 1. **不带具体小时数**——窗口可配置，且每单用自己完成时的快照，
 *    文案里印一个数字必然对某些订单是错的；
 * 2. **必须留一句出路**（「请联系客服」）：窗口关闭只是**普通入口**关闭，
 *    写成「无法处理」会变成一句平台其实做不到的硬规则。
 */
export const REFUND_WINDOW_CLOSED_MESSAGE =
  "该订单完成后的售后申请窗口已结束，无法再提交退款申请；如有其他问题请联系客服。";

/**
 * ## 「重复申请」这条规则的两次反转（**读这段再动唯一性**）
 *
 * | 轮次 | 规则 | 依据 |
 * |---|---|---|
 * | P0-13 之前 | 有**任何**记录就拒绝（`REFUND_RECORD_EXISTS_MESSAGE`） | 「一笔订单一次全额退」 |
 * | **P0-13** | 只挡**进行中**的；已拒绝 / 已撤销后可再申请 | 部分退款要能退第二次 |
 * | **P0-15**（当前） | 有**任何**记录就拒绝（`REFUND_ALREADY_EXISTS_MESSAGE`） | 「一个订单最多只允许一次退款」 |
 *
 * ⚠️ **P0-13 那段删除说明保留在这里，因为它记录了一个当时正确、现在被推翻的判断**：
 * 它写着「业务上必须能重复申请：部分退款而『第一次退了一部分、后来又发现还要再退』
 * 只能靠第二次申请表达」。产品负责人 2026-09-28 正式裁定**不存在多次退款**，
 * 因此那个理由整体失效——**不是它当年写错了，是产品规则变了**。
 *
 * ⚠️ **现在挡重复申请的是「有没有记录」，不再是「有没有进行中的」**，
 * 而且判据的两处落点（服务层提示 + 仓储原子区段）必须**同时**改，
 * 否则会出现「界面上按钮没了、接口还能提交」这种最糟的形态。
 * 真正生效的是**仓储那一处**（见 `lib/data/refundRepository.ts` 的约束 1）。
 *
 * ⚠️ **金额闸仍然保留**（`assertRefundAmountWithinPaid`）。唯一性让「累计」
 * 不再可能超过一笔，但那道闸守的是另一件事——**这一次退的钱不能超过实付**，
 * 它与「能退几次」无关，删掉它等于把「单笔超退」的门也一起打开。
 */

/**
 * 直接全额退款（P0-12，免审批）的失败文案。
 *
 * 三段分开写，因为对用户来说它们是**三件不同的事**：
 * 还能再试（走售后）、不必再试（已经退过了）、以及「这一单现在退不了」。
 */
export const DIRECT_REFUND_NOT_STARTED_MESSAGE = "护航已开始服务，退款需通过售后申请，请联系客服";
export const DIRECT_REFUND_ALREADY_REFUNDED_MESSAGE = "该订单已全额退款，无需重复操作";
export const DIRECT_REFUND_NOT_ALLOWED_MESSAGE = "该订单当前不可直接退款";

/**
 * 直接全额退款成功后**发给被退单护航**的通知（P0-12）。
 *
 * ⚠️ 这是仓库里**第一条收件人是打手、而不是下单用户**的通知。
 * 打手没有独立账号体系（身份建立在用户会话上，`requireCompanion()` 底层就是
 * `requireUser()`），因此收件人写的是**这位打手的 `userId`**——
 * 这是他今天唯一能被送达的地址，不是把打手当成了下单用户。
 *
 * ⚠️ 文案里**不写平台对他做了什么**（与 `DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED`
 * 同一纪律）：他被退单的原因是**客户在服务开始前取消了订单**，不是平台对他有任何处置。
 * 写「你被取消」会让他以为自己出了问题。
 */
export const REFUND_NOTIFICATION_COMPANION_REFUNDED = {
  title: "订单已退款",
  summary: "客户在服务开始前取消了订单，本单已全额退款",
  body: "客户在护航开始服务前取消了这一单，订单已全额退款。本单不产生收益，你无需再做任何操作。",
} as const;

/**
 * 售后审批退满、且**订单已完成护航**时发给打手的通知（P0-13 后续 fix，产品裁定）。
 *
 * ⚠️ **为什么不能复用 `REFUND_NOTIFICATION_COMPANION_REFUNDED`**：那条文案断言了两件事——
 * 「客户在**服务开始前**取消了订单」与「本单**不产生收益**」。而 `completed` 单
 * 这两件事**双双为假**：订单已经完成护航、`Earning` 也已经生成过并按本次核定结果冲回。
 * 打手拿到的是一条**可被引用的书面结论**，写着与账实相反的话。
 *
 * ⚠️ **P0-15 起「收益被冲回多少」不再有第二种答案**：退款一旦批准，
 * 打手本单收益**整笔**归零，与退款比例无关（§五）。原先这里要担心
 * 「已提现的收益被改写成不冲回、打手其实保住了钱」（`resolveFinalDecisionAmounts`），
 * 那条分支已随责任模型一并删除——普通退款下 `withdrawn` 结构上不可达。
 *
 * ⚠️ **别再假定「售后审批只会遇到 `serving` / `completed`」**：`REFUNDABLE_ORDER_STATUSES`
 * 约束的是**申请创建**（`canRequestRefund`），而存量申请可以挂在 `paid` / `accepted` 上
 * （`rf-seed-1001-01` 就是，见 `refundSeed` 的说明）。那两档的正确文案恰恰**是**这条
 * `..._REFUNDED`（服务确实没开始），所以选择器必须是三档，
 * 见 `adminRefundTransaction` 的 `resolveCompanionRefundCopy()`。
 *
 * ✅ **但这条分支自 2026-09-27 起不可达**：产品裁定 `paid` / `accepted` 不允许批准售后申请，
 * 审核入口已由 `assertRefundApprovalOrderStatus` 把守（本文件下方）。三档因此是
 * **防御性**的——不是「合法路径之一」。若将来它变得可达，那说明闸门被绕过了，
 * 该修的是闸门，而不是删掉这一档。
 *
 * ⚠️ 仍然遵守原纪律：**不写平台对他做了什么处置**。这里只陈述事实（已完成、已按本次
 * 售后结果结算），不写「你被扣了」「你被处罚了」。
 */
export const REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION = {
  title: "订单已退款",
  summary: "订单已完成售后退款，收益按核定结果结算",
  body: "这一单已完成护航，售后核定后全额退款。本单收益已按本次售后结果结算，请以收益记录为准。",
} as const;

/**
 * 售后审批退满、但订单**只到 `serving`**（尚未完成）时发给打手的通知。
 *
 * ⚠️ 与上一条的差别只有一处，但那一处必须说对：`serving` 全额退款时
 * **根本不会生成 completed `Earning`**（`cmd_p0-13.md`：全额退款终止履约、
 * 不产生正常 completed Earning）。所以这里说「本单不产生收益」是**真的**——
 * 这也正是它**不能**复用「服务开始前取消」那条文案的原因：服务明明已经开始过了。
 */
export const REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE = {
  title: "订单已退款",
  summary: "服务已开始，本单经售后退款后关闭",
  body: "这一单在护航开始服务后经售后处理全额退款，订单已关闭。本单不产生收益，你无需再做任何操作。",
} as const;

/**
 * 按**退款发生前的订单档位**挑一条**每一句都为真**的打手退款文案。
 *
 * ⚠️ PROD-1C 从 `lib/data/adminRefundTransaction.ts` 搬到这里，**一个字没改**
 * （那次搬家只是把 `resolveCompanionRefundCopy` 换成这个导出名。
 * 搬家的理由：退款批准现在有两个实现（Mock 伪事务与 PostgreSQL 的 T14 事务），
 * 而 PostgreSQL 侧**不能**从 `adminRefundTransaction.ts` 导入——
 * 那个模块的依赖里有整片 `globalThis` Mock 存储，导进来就等于让 Pg 事务
 * 在运行时依赖进程内状态）。文案的选择规则属于**常量层**，本来也不该住在事务里。
 *
 * ⚠️ 三档缺一不可，见 `REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION`
 * 的长注释（那里记着为什么不能写成 `completed ? A : B`）。
 *
 * ⚠️ **未列入三档的档位直接抛错**（而不是给个默认文案）：`refunded` 不可能
 * 还存在可批准的申请，真出现说明不变式已经破了。调用方都把它排在**写入之前**，
 * 因此抛错等于整个审核**零副作用**地失败——比退完钱再发一句错话好。
 */
export function resolveCompanionRefundCopy(orderStatus: OrderStatus): {
  title: string;
  summary: string;
  body: string;
} {
  switch (orderStatus) {
    case "paid":
    case "accepted":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED;
    case "serving":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED_IN_SERVICE;
    case "completed":
      return REFUND_NOTIFICATION_COMPANION_REFUNDED_AFTER_COMPLETION;
    default:
      throw new Error(`退款通知无对应文案：订单档位 ${orderStatus}`);
  }
}

/**
 * 退款通知指向的页面：**打手端**的订单页。
 *
 * ⚠️ 不是 `/orders/[id]`——那个页面会重新校验订单归属，发给打手等于点进去 404。
 *
 * ⚠️ 与 `resolveCompanionRefundCopy` 同批搬到常量层，同样是给两个存储共用。
 * 只把文案共用、把 href 各写一份的话，「收件人点进去看到什么」会重新变成两处规则。
 */
export function companionRefundNotificationHref(orderId: string): string {
  return `/companion/orders/${orderId}`;
}

export function isRefundStatus(value: string): value is RefundStatus {
  return (REFUND_STATUSES as readonly string[]).includes(value);
}

export function isRefundReason(value: string): value is RefundReasonKey {
  return REFUND_REASONS.some((item) => item.key === value);
}

/** 「进行中」的退款：待审核与审核中。只有这两种会挡住新的申请。 */
export const ACTIVE_REFUND_STATUSES: readonly RefundStatus[] = ["pending", "reviewing"];

export function isActiveRefundStatus(status: RefundStatus): boolean {
  return (ACTIVE_REFUND_STATUSES as readonly string[]).includes(status);
}

/**
 * **未终态**的退款状态——管理端 `status=open` 的口径，也是首页待办卡的计数口径。
 *
 * ⚠️ **刻意与 `ACTIVE_REFUND_STATUSES` 是同一个数组，不另写一份
 * `["pending", "reviewing"]`。** 两个概念不同（一个是「会挡住新申请」，
 * 一个是「管理员还没处理完」），但今天取值相同；写成两个字面量数组意味着
 * 其中一处将来被改动时，另一处**不会报错、只会静默分叉**——
 * 「待办卡说有 4 条、列表只筛出 3 条」这类问题就是这样长出来的。
 *
 * ⚠️ 做成**别名**而不是新数组，是让「两者必须一致」这件事在类型层面成立：
 * 若将来产品要求它们分开，必须显式把这里改成一个独立数组，那一步是可见的。
 */
export const OPEN_REFUND_STATUSES: readonly RefundStatus[] = ACTIVE_REFUND_STATUSES;

/**
 * 允许**申请**退款（走人工审核）的订单状态：护航中 / **已完成**。
 *
 * 已完成也在这个集合里，是因为它才是**唯一计入消费**的状态（见
 * `lib/constants/levels.ts` 的 `CONSUMPTION_ORDER_STATUS`）：消费口径只认已完成，
 * 如果已完成不能退，那笔已计入累计消费的钱就永远退不掉。
 *
 * 「已完成可退」不代表「完成后退款很容易」——退款仍然是一笔独立的状态机，
 * 提交只产生一条待审核记录，订单状态和累计消费都**要到审核通过才变**。
 *
 * ⚠️ **P0-12 起 `paid` / `accepted` 从这个集合里移出。** 这两档属「尚未开始服务」，
 * 按 2026-09-23 的规则走**免审批直接全额退款**（`DIRECT_REFUNDABLE_ORDER_STATUSES`），
 * 不再产生一条待审核申请：
 *
 * - `业务流程表.md` **BF-26 A**：「`paid` / `accepted` → 直接全额退款，不需要客服审批」；
 * - `用户权限表.md` **PR-02**（✅ 已确认）：「直接全额退款，不需要客服/管理员审批」；
 * - `特殊情况表.md` **EX-REFUND-07**（✅ 已确认）：六项细则；
 * - `用户权限表.md:448` 更明文写死：「**客服不得把「未开始服务直接退款」强行转成人工审批**」——
 *   也就是说，让这两档走人工审核**本身**就是违规的。
 *
 * 因此两档留在同一个集合里不是「多一条路」，而是**同一种订单出现两种互斥的业务结果**
 * （一条当场退钱、一条等审核），用户点哪个按钮就退成什么样。
 */
export const REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ["serving", "completed"];

/**
 * 允许**直接全额退款**（免审批，P0-12）的订单状态：已付款 / 已接单。
 *
 * 「尚未开始服务」只有这两档（BF-26 A 原文）。`serving` 起必须走售后：
 * 客服调查、管理员决定退款比例——那条路径属 P0-13，**本轮不碰**。
 *
 * ⚠️ 这个集合与 `REFUNDABLE_ORDER_STATUSES` **不相交**，而且**必须**不相交：
 * 交集非空就意味着某一档同时存在两条退款路径。`tests/refunds.test.mjs` 里有断言钉住这一点。
 */
export const DIRECT_REFUNDABLE_ORDER_STATUSES: readonly OrderStatus[] = ["paid", "accepted"];

/** 这一档订单此刻能否直接全额退款（只看状态，不看归属与已退金额）。 */
export function canDirectRefund(status: OrderStatus): boolean {
  return (DIRECT_REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isOrderRefundable(status: OrderStatus): boolean {
  return (REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * 售后**审批**入口的状态闸：只有 `serving` / `completed` 的订单能进入售后资金链。
 *
 * ## 产品裁定（2026-09-27）
 *
 * > **`paid` / `accepted` 状态下，不允许批准售后退款申请。**
 * > 退款路径正式保持唯一：`paid` / `accepted` → 用户 direct full refund；
 * > `serving` → 售后；`completed` → 投诉 / 售后。
 *
 * ## 为什么必须由服务端把守
 *
 * `canRequestRefund`（本文件另一处）只挡**申请创建**，它管不了**存量**记录：
 * P0-12 把 `paid` / `accepted` 改成免审批直接退款之后，那两档**开不出新申请**，
 * 但历史遗留的申请仍在（`refundSeed` 里的 `rf-seed-1001-01` 挂在 `accepted` 单上、
 * `rf-seed-1002-01` 挂在 `paid` 单上，两条都是这段历史的真实留痕）。
 * 审核入口原本对订单档位**没有任何守卫**，于是那两条存量申请会被批准成
 * 「一次绕过直接退款路径的人工退款」——同一档订单出现两条互斥的退款结果。
 *
 * ⚠️ **不依赖前端隐藏按钮**：按钮该不该显示是 `adminRefundAllowedActions` 的事，
 * 而「允不允许真的写下去」必须在服务端判——存量申请的历史数据在客户端看来毫无异常。
 *
 * ⚠️ 两者**共用这一个函数**，不是两份判断：`adminRefundAllowedActions` 的 `canApprove`
 * 会调用本函数来决定按钮灰不灰，写侧（`adminRefundTransaction`）调用它来决定写不写。
 * 「读侧说能批、写侧却 400」因此**在结构上不可能**——它们问的是同一个问题。
 *
 * ⚠️ **只管审批（会动钱的那一步）**：开始审核与拒绝**不**受本闸约束，
 * 它们不碰订单、不碰收益、不产生任何金额。对被历史遗留的申请，
 * 「驳回」正是应有的处置方式，把驳回也一并挡掉会让那些申请永远悬着。
 *
 * 返回 `null` 表示通过；否则返回一句可直接展示的文案（与 `assertRefundAmountWithinPaid` 同形）。
 */
export const REFUND_APPROVAL_ORDER_STATUS_MESSAGE =
  "该订单当前不在售后审批范围内：只有「护航中」「已完成」的订单可以走售后退款审批";

export function assertRefundApprovalOrderStatus(status: OrderStatus): string | null {
  return isOrderRefundable(status) ? null : REFUND_APPROVAL_ORDER_STATUS_MESSAGE;
}

/**
 * 这一档订单**在状态层面**还有退款路径可走——申请（人工审核）或直接全额退款，二者必居其一。
 *
 * 它存在的理由是：上面两个集合各自只描述**一条**路，而有些判断问的是**问题本身**
 * （「这一单还能不能退」），与走哪条路无关。预置数据的自洽校验就是这种判断：
 * `refundSeed.ts` 的不变量 2 要保证「一条进行中的退款申请，对应的订单没有变成终态」，
 * 而不是「这条申请此刻还能再提交一次」——后者在 `paid` / `accepted` 上已经是**假**的
 * （那两档走免审批直接退款，开不出申请），可它跟「预置数据自不自洽」毫无关系。
 *
 * ⚠️ 这**不是** P0-12 之前那个 `isOrderRefundable` 的别名：那个词现在只指申请那条路。
 * P0-12 没有缩减「哪些订单能退」，它把原来的一条路拆成了两条**互斥**的路——
 * 本函数是「拆之前那个问题」的现名，因此它今天恰好仍等于原来那四档。
 *
 * ⚠️ **入参只有状态，没有 `hasRefundRecord`**，因此它**不回答**「这一刻能不能真的提交/点到」：
 * 对一张 `serving` / `completed` 且**已提交过退款申请**的订单它返回 `true`，而同文件的
 * `canRequestRefund(status, hasRefundRecord)` 对同一张订单返回 `false`。服务端拒绝时用的是
 * `REFUND_ALREADY_EXISTS_MESSAGE`（见 `lib/services/refunds.ts` 的判定）。
 * **「入口该不该显示」必须用 `canRequestRefund` /
 * `canDirectRefund` / 服务端的 `allowedActions` 判定，不要用本函数**——
 * 用它去把守按钮，`serving` 单上会显示一个点进去必然报错的「申请退款」。
 *
 * ⚠️ 它与 `canRequestRefund` 的差距在 P0-15 之后**又变宽了**（这是第二轮变化）：
 * P0-13 把差距缩到「只有进行中的那一条挡住」，P0-15 把**所有记录**重新变成挡板，
 * 于是两张表的差值回到「有没有任何申请记录」。差距变宽**不需要改本函数**——
 * 本函数从来只回答状态那一半，它没有跟着任何一版规则变过。
 */
export function hasRefundPath(status: OrderStatus): boolean {
  return isOrderRefundable(status) || canDirectRefund(status);
}

/**
 * 能否申请退款 = 订单状态可退，**且**这一单**从来没提交过**退款申请。
 *
 * 反过来读，就是不能申请的两种情况：
 *
 * 1. 订单状态本身不可退（已退款；以及未支付等根本不存在的状态）；
 * 2. 已有**任何**退款申请记录——不论它是待审核、审核中、已通过、已拒绝还是已撤销。
 *
 * ⚠️ **形参名在 P0-13 与 P0-15 之间来回改了一次，这不是笔误**：
 *
 * | 轮次 | 形参名 | 语义 |
 * |---|---|---|
 * | P0-13 之前 | `hasRefundRecord` | 有**任何**记录就挡 |
 * | P0-13 | `hasActiveRefund` | 只挡**进行中**的 |
 * | **P0-15**（当前） | `hasRefundRecord` | 有**任何**记录就挡 |
 *
 * 名字必须跟着语义走：叫 `hasActiveRefund` 而让调用方传「有没有任何记录」，
 * 下一个人会照着名字去传 `isActiveRefundStatus(...)`，于是
 * **被拒绝的申请又能再申请一次**——一个只在名字上错的分叉。
 *
 * ⚠️ **「已拒绝 / 已撤销也挡」是产品裁定，不是漏挡的反面**：
 * 产品负责人 2026-09-28 明确裁定「提交过即封死，一次机会」。
 * 已知后果是「管理员拒一次，用户此单再无退款渠道」——
 * 这个后果是**被看见并被接受的**（见 `P0-15/02-decisions.md` Q2），
 * 不是没想清楚。若将来要改成「被拒后可再申请」，那是一条新的产品规则。
 *
 * ⚠️ 两道外闸仍然在，且都不在本函数里：
 *
 * - **金额闸**（`assertRefundAmountWithinPaid`）：退款额不得超过订单实付。
 *   本函数看不到金额，因此它答不了「这一笔能退多少」；
 * - **仓储原子区段**（`lib/data/refundRepository.ts` 约束 1）：真正生效的那一处。
 *   本函数只是**提前**给出好一点的界面提示。
 */
export function canRequestRefund(status: OrderStatus, hasRefundRecord: boolean): boolean {
  return isOrderRefundable(status) && !hasRefundRecord;
}

/** 能否撤销：只有待审核（pending）。审核中（reviewing）本阶段不允许撤销。 */
export function canCancelRefund(status: RefundStatus): boolean {
  return status === "pending";
}

/* ═════════════════ 退款资金决策（P0-13 建立 · P0-15 收敛） ═════════════════ */

/**
 * 退款决策的**金额规则**（服务端与浏览器共用，纯函数，不读写数据）。
 *
 * ## 规则出处：**P0-15 覆盖了 §17**
 *
 * 原先这里抄的是 `docs/01-requirements/超哥电竞_业务流程表.md` **§17**
 * 「部分退款资金公式（规则已冻结）」——那是一条**按责任比例**冲减打手的公式。
 * 产品负责人 2026-09-28 正式覆盖了它（`P0-15/01-prompt.md` 指令 ① §三/§四/§五）。
 * **§17 的按比例冲减部分标 `SUPERSEDED`，`platformBorneAmount` 整项作废。**
 *
 * 当前公式（这里没有一条是自创的，全部来自指令 ①）：
 *
 * ```text
 * refundRate ∈ [0, 10000] bp                     // 管理员一次性核定，只看一次
 * refundAmount      = floor(actualPaidAmount × refundRate / 10000)
 * companionReversal = companionBaseIncome        // ⚠️ 整笔，**不乘比例**
 * platformNetIncome = actualPaidAmount − refundAmount
 * ```
 *
 * ## 三条与 §17 时代**根本不同**的性质
 *
 * 1. **冲回额与退款比例无关**。退 10% 与退 100% 都把打手这一单收益整笔取消。
 *    这是本轮最容易被写错的一行——写成 `floor(收益 × 比例)` 之后金额看起来
 *    「挺合理」，只是打手偷偷留下了钱，页面上完全看不出来。
 * 2. **不再需要钳制，因为不变式变成了构造性的**。§17 时代要钳制，是因为
 *    按比例 × 责任比例的公式**可能算出超过收益的数**（券场景下
 *    `companionBaseIncome` 甚至可能大于实付）。现在冲回额**就是**
 *    `companionBaseIncome` 本身，`0 <= reversedAmount <= incomeAmount`
 *    在定义上成立，没有可以越界的表达式。⚠️ 删掉钳制**不是**放弃这条不变式，
 *    而是让它不再需要一段专门的代码来维持——原先那段 `Math.max/min`
 *    现在会是一段永远不改变结果的死代码。
 * 3. **「平台承担额」这个概念本身没有了**。它回答「本次退款里平台担了多少」，
 *    与打手收益无关；而今天要回答的是「平台最终剩多少」——见 `platformNetIncome()`。
 *    两者数值上也不相等（打手收益 ≠ 退款额），**不能互相顶替**。
 *
 * ⚠️ **每次退款必带一个比例，没有例外**：`refundFullRemaining`（「退满剩余」）
 * 那个一等意图已删。它当年存在的唯一理由是「多步部分退款会留下 1–99 分尾差，
 * 而 `floor(实付 × n/100)` 只有 101 个离散值，够不着」——**现在一个订单只退一次，
 * 没有尾差可追**。它想表达的另一件事（把剩下的全退掉）现在就是 **100%**，
 * 且 `floor(实付 × 10000 / 10000) === 实付` 恒成立，因此连特例都不需要。
 */

/**
 * 退款比例的输入范围（整数百分比）。100% 即全额退款。
 *
 * ⚠️ 下限是 **0** 而不是 1，与 §16.B 的「0% ～ 100%」和 D2 的「`0 <= bp <= 10000`」一致：
 * 「0%」在**形态上**合法，只是算出来的退款金额是 0，会被下面那条
 * 「单次金额必须 > 0」挡掉——两道校验各答各的问题，不互相顶替。
 */
export const REFUND_RATE_PERCENT_MIN = 0;
export const REFUND_RATE_PERCENT_MAX = 100;

/**
 * 决策表单的全部失败文案。
 *
 * ⚠️ 用**百分比**措辞而不是「基点」：管理员输入的就是百分比，
 * 报错时对他说「基点必须在 0..10000 之间」是把他输入的东西又翻译了一遍。
 * 服务端内部一律用基点（`bp`），只在**这一层**做换算。
 */
export const REFUND_DECISION_RATE_REQUIRED_MESSAGE = "请填写退款比例";
export const REFUND_DECISION_RATE_INVALID_MESSAGE = `退款比例必须是 ${REFUND_RATE_PERCENT_MIN}~${REFUND_RATE_PERCENT_MAX} 之间的整数百分比`;
export const REFUND_DECISION_AMOUNT_ZERO_MESSAGE = "退款金额为 0，无法提交退款决策";
/**
 * 金额闸遇到的**负**退款额——这不是「退 0 元」，是数据已经坏了。
 *
 * ⚠️ 与上一句分开写（P0-14 验收整改补正）：负额只可能来自
 * `refundedAmount > actualPaidAmount`（已退超过实付）。原先它与 0 共用
 * 「退款金额为 0」那句，运维看到「为 0」会去查「为什么算出来是 0」，
 * 而真正该查的是「为什么已退超过实付」——把信号指错了方向。
 * 依据：`lib/types/refund.ts` 里「负数是数据出问题的信号，藏起来更糟」那条纪律。
 *
 * ⚠️ **P0-15 后它仍然可能被触发**，尽管累计已不可能：唯一性让「本次退款额」
 * 至多等于实付，而 `refundedAmount` 是订单上的历史字段——一张在 P0-15 之前
 * 就已被多退过的单子（或任何被外部写坏的数据）依然会走到这里。
 * 保留它，是因为**删掉一道数据异常检测不会让异常消失，只会让它静默通过**。
 */
export const REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE =
  "该订单已退金额已超过实付金额，订单数据异常，请先核对金额再提交退款决策";
/**
 * 金额闸的「超过实付」一档。
 *
 * ⚠️ **P0-15 补上了补救方向**（原先只有「请调整退款比例」）：多步退款模型废止后
 * 不再有尾差，`100%` 就是退满全部，因此「填 100」对管理员是一个**真正的出路**，
 * 而不只是一句「你自己再想想」。
 *
 * 这句话同时是**管理端预览**与**提交被拒**两处的文案（P0-15 起预览不再持有
 * 一份自己的副本，见 `lib/constants/adminRefunds.ts` 的 `previewRefundDecisionAmounts`）：
 * 两处必须一字不差，否则会出现「预览说 A、提交说 B」。
 */
export const REFUND_DECISION_EXCEEDS_PAID_MESSAGE =
  "退款金额超过订单实付金额，请调整退款比例（填 100 表示全额退款）";

/**
 * 一次退款决策的**输入**（服务端内部口径）。
 *
 * ⚠️ 比例全部是**基点**整数。表单给的百分比字符串在接口层就换算掉
 * （`lib/constants/adminRefunds.ts`），因此规则层永远只面对整数基点，
 * 不面对 `"33.5"` 这种字符串，也不会在规则里做二次解析。
 *
 * ## P0-15：输入只剩一个字段
 *
 * 原来这里有两个维度（`refundFullRemaining` 二选一 × `responsibility` 三选一），
 * 合成四个成员。P0-15 之后两者都不存在了：
 *
 * - **「退满剩余」删掉了**。它当年存在是因为**多步**部分退款会留下 1–99 分尾差，
 *   而 `floor(实付 × n/100)` 只有 101 个离散值，够不着那个余数。
 *   现在**一个订单只退一次**，`floor(实付 × n/100)` 一步到位，**没有余数可追**。
 *   而它当年想表达的另一件事（「把剩下的全退掉」）现在就是 **100%**：
 *   `floor(实付 × 10000 / 10000) === 实付` 恒成立。
 *   ⚠️ 注意这不是「换了个名字」——旧字段在**被部分退过的单子**上有不可替代的语义
 *   （那时它是 `实付 − 已退`，不等于实付的 100%），而那个场景本身没了。
 * - **`responsibility` / `companionLiabilityRateBp` 删掉了**：管理员不再选责任归属，
 *   打手一律整笔归零（P0-15 §五）。
 */
export type RefundDecisionInput = {
  refundRateBp: number;
};

/**
 * 一次退款决策算出来的**两个**金额（单位：分）。
 *
 * ⚠️ **P0-15 删掉了 `platformBorneAmount`**，而不是让它恒为某个值。
 * 它回答的是「本次退款里平台担了多少」，而新口径要回答的是
 * 「**平台最终净收入** = 实付 − 退款额」——这两个问题**不同**：
 * 前者与打手收益无关，后者与打手收益也无关，但前者在「打手整笔归零」之后
 * 已经没有任何一处需要它了。需要平台净收入的地方请用 `platformNetIncome()`
 * 现算，不要把它塞回决策里——决策记的是**动作**，不是**结算结果**。
 */
export type RefundDecisionAmounts = {
  refundAmount: number;
  /**
   * 这一次从打手收益冲回的金额（分）。
   *
   * ⚠️ **恒等于 `companionBaseIncome`**，与 `refundRateBp` **无关**：
   * 退 10% 与退 100% 都把这笔收益整笔取消（P0-15 §三 / §五）。
   * 传入 `companionBaseIncome` 而不是在这里写 0 或按比例算，
   * 是为了让「整笔」这件事由**调用点的入参**表达——
   * 将来若真有部分冲减的需求，改的是这里的一句话，而不是去找散落的公式。
   */
  companionReversalAmount: number;
};

/**
 * 决策输入的**形状校验**（不涉及订单金额，因此可以独立测试与独立复用）。
 *
 * 返回 `null` 表示通过，否则返回给管理员看的中文原因。
 * ⚠️ 它**不检查**「退款额是否超过实付」——那要看订单，属于
 * `assertRefundAmountWithinPaid`。
 *
 * ⚠️ **P0-15 后它只剩比例一道校验**：责任归属与责任比例两个字段被删除，
 * 因此它们的三句失败文案也一并删除（`REFUND_DECISION_RESPONSIBILITY_*` /
 * `REFUND_DECISION_LIABILITY_*`）。留着一句永远不会被返回的文案，
 * 会让人以为那条校验还在。
 */
export function validateRefundDecisionInput(input: RefundDecisionInput): string | null {
  if (!Number.isInteger(input.refundRateBp)) return REFUND_DECISION_RATE_REQUIRED_MESSAGE;
  const ratePercent = input.refundRateBp / 100;
  if (ratePercent < REFUND_RATE_PERCENT_MIN || ratePercent > REFUND_RATE_PERCENT_MAX) {
    return REFUND_DECISION_RATE_INVALID_MESSAGE;
  }
  return null;
}

/**
 * 算这一次退款的两个金额（单位：分）。
 *
 * ⚠️ **入参必须是订单的冻结经济快照**（`Order.actualPaidAmount` /
 * `Order.companionBaseIncome`），**不得**传当前商品价或当前分账比例——
 * P0-13 §一原文：「不得重新按当前商品/分账比例计算，必须基于订单冻结经济快照」。
 *
 * ## P0-15：从「三个金额」缩成「两个」
 *
 * 退款额只按比例一条路算；冲回额**恒为整笔**，与比例无关。
 * `alreadyRefundedAmount` 与 `reversedSoFar` 两个入参随之删除——
 * 前者只服务「退满剩余」（已删），后者只服务累计钳制（已无累计）。
 *
 * ⚠️ **删除钳制不会让 `0 <= reversedAmount <= incomeAmount` 失效**，
 * 而是把它变成了**构造上成立**：冲回额就是 `companionBaseIncome`，
 * 既不可能是负的，也不可能超过自己。原先需要钳制，是因为公式
 * （按比例 × 责任比例）可能算出超过收益的数；现在没有那个公式了。
 */
export function computeRefundDecisionAmounts(params: {
  actualPaidAmount: number;
  companionBaseIncome: number;
  input: RefundDecisionInput;
}): RefundDecisionAmounts {
  const { actualPaidAmount, companionBaseIncome, input } = params;

  // 实付 ≤ 0 的异常单：没有可退的钱，也没有可冲回的收益。
  // ⚠️ 仍然必须先拦。P0-15 之后它拦的不再是「分母为 0 导致 NaN」
  //    （那个分母已随「退满剩余」一起删除），而是**一个坏订单不该产生任何资金动作**：
  //    放它过去的话，下面会算出 `refundAmount = 0`，而金额闸对 0 的判据是
  //    「退款金额为 0」——那句话对管理员说的是「你填的比例太小」，
  //    真正的问题却是「这一单的实付金额是坏的」。返回 0 让闸门挡下来，
  //    与改动前的行为一致。
  if (actualPaidAmount <= 0) {
    return { refundAmount: 0, companionReversalAmount: 0 };
  }

  return {
    refundAmount: Math.floor((actualPaidAmount * input.refundRateBp) / 10000),
    // ⚠️ **不乘比例**。这是 P0-15 §三 / §五 的核心：
    //    退 10% 与退 100% 都把打手这一单的收益**整笔**取消。
    //    写成 `Math.floor(companionBaseIncome * refundRateBp / 10000)` 是
    //    本条规则下最容易犯、也最难在页面上看出来的错——金额会变"合理"，
    //    只是打手偷偷留下了钱。
    companionReversalAmount: companionBaseIncome,
  };
}

/**
 * **平台最终净收入**（分）= `实付 − 退款额`（P0-15 §四）。
 *
 * ⚠️ **它是现算的，不是存下来的**：平台净收入是订单与退款两个事实的**推论**，
 * 不是一次退款动作的属性。把它写进决策记录等于给同一个数留两份出处。
 *
 * ⚠️ **它与被删除的 `platformBorneAmount` 不是同一个量**，别拿这个去补那个：
 * 后者问「本次退款里平台担了多少」，与打手收益无关；这个问「平台最后剩多少」，
 * 同样与打手收益无关，但**只在打手整笔归零的新口径下**才等于「实付 − 退款额」。
 *
 * ⚠️ 打手的份额**不在这条式子里出现**，这是对的：打手归零之后，
 * 未被退走的钱全部留在平台侧。
 */
export function platformNetIncome(actualPaidAmount: number, refundAmount: number): number {
  return actualPaidAmount - refundAmount;
}

/**
 * 金额闸：退款额不得超出订单实付金额（P0-13 §一原文
 * 「`refundedAmount <= actualPaidAmount`」）。
 *
 * ⚠️ **P0-15 后它的第三个判据已经基本不可能触发**，但**不删**：
 * 唯一性让「本次退款额」至多等于实付，可 `alreadyRefundedAmount` 是**订单上的
 * 历史字段**——一张在 P0-15 之前被多次退过的单子、或任何被外部写坏的数据，
 * 依然会走到这里。删掉一道数据异常检测**不会让异常消失，只会让它静默通过**。
 *
 * ⚠️ 保留「累计」口径而不是改成「这一次」：判据问的是「退完之后总共退了多少」，
 * 而那是订单上的 `refundedAmount` 加上本次——只看本次的话，
 * 一张已经退满的单子再退一次会**通过**这道闸。
 * 返回 `null` 表示通过。
 */
export function assertRefundAmountWithinPaid(params: {
  refundAmount: number;
  alreadyRefundedAmount: number;
  actualPaidAmount: number;
}): string | null {
  // ⚠️ 负数必须排在 0 前面：先判 `<= 0` 会把「数据已经坏了」答成「退款金额为 0」，
  // 把排查方向指错（见 `REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE`）。
  if (params.refundAmount < 0) return REFUND_DECISION_AMOUNT_NEGATIVE_MESSAGE;
  if (params.refundAmount === 0) return REFUND_DECISION_AMOUNT_ZERO_MESSAGE;
  if (params.alreadyRefundedAmount + params.refundAmount > params.actualPaidAmount) {
    return REFUND_DECISION_EXCEEDS_PAID_MESSAGE;
  }
  return null;
}

/**
 * 退款是否已经退满 = 订单该转 `refunded`（P0-13 §一：「full refund 才 refunded」）。
 *
 * ⚠️ **只有退满才转**：部分退款**不得**设 `refunded`——订单还要继续履约
 * （P0-15 指令 ②§八 原话：「`Order.status` 不因为打手收益归零而强制变成 `refunded`」）。
 * 这一条由本函数单点回答，调用方不再自己写 `>=`。
 *
 * ⚠️ **P0-15 后「部分退款」变成了一个可以长期停留的终态**，而不是 §17 时代
 * 那个「迟早会被第二次退款补上」的中间态：一个订单只退一次，所以
 * 「退了 33%、剩下的 2004 永远留在平台」是**正常结局**（指令 ①§四：
 * 「未退款部分归平台」），不是「订单卡住了」。
 *
 * ⚠️ `actualPaidAmount > 0` 这个守卫必须留着：实付为 0 的坏单子
 * 在 `0 >= 0` 下会被判成「已退满」，从而**凭空变成 `refunded`**。
 */
export function isFullyRefunded(alreadyRefundedAmount: number, actualPaidAmount: number): boolean {
  return actualPaidAmount > 0 && alreadyRefundedAmount >= actualPaidAmount;
}

/**
 * 这一单**已经出过一次款**了吗？= 退款流程是否已经终结（指令 ①§一 / §八）。
 *
 * 判据是 `refundedAmount > 0`——**不看比例、不看状态**。这是「一单一退」在
 * 「执行侧」的唯一定义，与申请侧的「有没有记录」（`canRequestRefund` 的第二个参数）
 * 是同一件事的两面：
 *
 * | 侧 | 事实 | 谁回答 |
 * |---|---|---|
 * | 申请侧 | 这一单**提交过**退款申请吗 | `listRefundsForOrderSync(id).length > 0`（仓储原子区段） |
 * | **执行侧** | 这一单**出过款**吗 | **本函数** |
 *
 * ⚠️ **为什么必须单独有这一条，而不是靠「退满」**：指令 ①§一 写的是
 * 「最多**一次**实际退款执行」，①§八 写的是「**已经执行退款后,不允许再次退款**」——
 * 两句都没有说「退满」。而 `refundedAmount >= actualPaidAmount`（退满）
 * 在**部分退款**上不成立：一张退了 10% 的订单，`refundedAmount` 是实付的一成。
 * 只判「退满」会放过这条路径：
 *
 * ```
 * serving 单被批准部分退款（第 1 次出款，状态仍是 serving——部分退款不改状态）
 *   → 客服把它退回公共池（P0-11，`serving → paid`，回池不碰 `refundedAmount`）
 *   → 订单此刻是 paid ⇒ `canDirectRefund("paid")` 为真
 *   → 用户点「直接退款」⇒ **第 2 次出款**（退的是「剩余可退额」）
 * ```
 *
 * 这条路径在 2026-09-28 的交付前审查中被独立发现并逐步骤核实过。
 * 它单看「累计不超过实付」不会多退钱，但它**是第二次实际退款执行**，
 * 与 ①§一 / §八 直接冲突，也与 ①§九（清理「第二次退款」与 cumulative refund 逻辑）冲突。
 *
 * ⚠️ **「剩下的留在平台」是预期终态，不是「订单卡住了」**（①§四 / `isFullyRefunded` 的注释）：
 * 部分退款后那笔未退的钱**本来就归平台**，因此挡住第二次出款**不是**让用户损失，
 * 而是让订单落到它应有的终态。
 *
 * ⚠️ **调用方不要各写一遍 `> 0`**：本函数是这一条规则的唯一定义，
 * 三个退款写入路径（直接退款 / 售后台审 / 公共池超时）与展示面
 * （`buildRefundActions`、`resolveOrderNetIncome`）都走它。
 *
 * ⚠️ **有一处是刻意的例外**：`lib/constants/orders.ts` 的
 * `resolveCompanionDisplayStatus` 仍然写 `order.refundedAmount > 0`。
 * 不是漏改——`orders.ts` 头部有一条硬约束：**本文件不得出现任何运行时的 `import`**
 * （它被客户端组件引用，加一个运行时依赖就会把服务端模块拖进浏览器产物）。
 * 于是那里只能就地写同一个表达式。
 *
 * ⚠️ **写路径要的通常不是本函数，而是 `isRefundExecutionClosed`**：本函数只回答窄问题
 * （「出过款吗」），而「这一单的退款还能不能再发生」是**并集**（还要算上状态判据）。
 * 并集有它自己的单点定义，见下一个函数——**不要在调用点手写 `||`**。
 */
export function hasRefundBeenExecuted(order: { refundedAmount: number }): boolean {
  return order.refundedAmount > 0;
}

/**
 * 这一单的退款**还能不能再发生**？= 状态判据 ∨ `hasRefundBeenExecuted`。
 *
 * 这是「一单一退」在**写入侧**的完整判据，也是退款写入路径与计划层应该问的问题。
 * 拆成两个函数不是重复，是**分工**：
 *
 * | 问题 | 谁回答 |
 * |---|---|
 * | 这一单**出过款**吗（哪怕只出了一部分） | `hasRefundBeenExecuted`——窄，回答净额与展示面 |
 * | 这一单的退款**是否已终结** | **本函数**——宽，回答写入路径与计划层 |
 *
 * ⚠️ **为什么窄答案不够**：计划层若只问窄问题，`status === "refunded"` 而
 * `refundedAmount === 0` 的订单会被判成「还欠一次退款」，于是**放行**——通知发出去、
 * id 落进 `refundedOrderIds`，而存储层的短路会**静默拒绝**这次出款。那正是
 * 「**账面上说退了、钱没动**」的假账（P0-15 决策 D20 点名的反模式）。并集让计划层
 * 与存储层问同一个问题，缝就没了。
 *
 * ⚠️ **本函数与 `lib/constants/orders.ts` 的 `resolveCompanionDisplayStatus` 恒相等**
 * （同一个并集，一个返回布尔、一个返回状态）。那一处仍然内联写
 * `order.refundedAmount > 0` 并**不是**漏改——`orders.ts` 头部有一条硬约束：
 * **本文件不得出现任何运行时的 `import`**（它被客户端组件引用，加一个运行时依赖
 * 就会把服务端模块拖进浏览器产物）。恒等关系由
 * `tests/refundOnePerOrder.test.mjs` 的矩阵用例逐格钉住，不靠注释提醒。
 */
export function isRefundExecutionClosed(order: {
  status: OrderStatus;
  refundedAmount: number;
}): boolean {
  return order.status === "refunded" || hasRefundBeenExecuted(order);
}

/**
 * 基点 → 百分比文本（`8000` → `"80"`、`3350` → `"33.5"`），用于把决策里的比例**显示给人看**。
 *
 * ⚠️ **转发而不是另写一份换算**：「基点 ↔ 百分比」这个换算在仓库里只应该有一个落点
 * （`lib/constants/shareRatio.ts`），哪怕两个字段的业务含义完全不同
 * ——商品分账比例与本次退款比例是两个业务概念，但它们的单位换算是同一件事。
 * 这里保留一个退款域的名字，是为了让调用处读起来是「退款比例」而不是
 * 「分账比例」；将来若退款比例真的需要不同的显示口径，改这里就够了。
 */
export function formatRefundRatePercent(bp: number): string {
  return formatShareRatioBpForInput(bp);
}

/**
 * 一条**已写入**的退款决策，比例那一栏该怎么写。
 *
 * ⚠️ **P0-15 起它不再判断「是哪条路」**：唯一的另一种意图（「退满剩余」）
 * 已被删除，`refundRateBp` 也从 `number | null` 收窄成 `number`。
 * 于是它从「两条分支 + 一个占位」退化成**纯换算**——
 * 保留这个函数而不是让调用方自己拼 `formatRefundRatePercent(x) + "%"`，
 * 理由与原先一致：百分比在退款域里显示成什么样，只应该有一处定义。
 *
 * ⚠️ 连带的删除：`REFUND_RATE_UNAVAILABLE_TEXT`（「比例读不出来」的占位 `"—"`）
 * 一并删掉。它当年存在是因为 `refundRateBp` 可能是 `null`，
 * 而那个可能是「退满剩余」带来的；意图没了，`null` 就不再可能出现，
 * 一个永远不会被返回的占位常量只会让人以为还有一条分支要处理。
 */
export function formatRefundDecisionRate(decision: Pick<RefundDecision, "refundRateBp">): string {
  return `${formatRefundRatePercent(decision.refundRateBp)}%`;
}
