import type { RefundResponsibility } from "./refund";

/**
 * 打手收益（Earning）与结算（Settlement）——P0-9，退款联动 P0-13。
 *
 * ## 为什么它是**独立领域**而不是 `OrderStatus` 的一个取值
 *
 * 「打手这一单挣了多少、这笔钱现在能不能提」与「这一单进行到哪一步」是两件事，
 * 而且它们的**生命周期长度不同**：订单在 `completed` 就结束了，收益还要再往后走
 * 一段（冻结 → 可提现 → 已提现）。把 `settling` / `settled` 塞进 `OrderStatus`
 * 会让每一处订单状态判断都要额外回答「那这个状态算不算完成」，
 * 而答案在用户端、打手端、管理端各不相同。
 *
 * 因此收益状态的推进**不改订单状态**，订单在 completed 之后一直停在 completed。
 *
 * ## 金额只来自订单快照
 *
 * `incomeAmount` 在下单那一刻就已经确定（`Order.companionBaseIncome`），
 * 创建 Earning 时**只做搬运，不做计算**：不重查商品价格、不重查分账比例、
 * 不因优惠券重新下调。理由与 `Order.companionBaseIncome` 的注释同一条——
 * 那是一个已经承诺给打手的数，事后用今天的规则重算等于改承诺。
 *
 * ⚠️ **退款冲回也遵守这一条**（P0-13）：冲回额按**订单冻结的经济快照**
 * （`Order.companionBaseIncome` × 本次退款比例）算，**不重查今天的商品价、
 * 分账比例**。`incomeAmount` 本身**永不修改**（产品裁定 Q2-a）——
 * 冲回是另记一笔调整，不是把原始承诺改小。
 *
 * ## 仍然刻意**没有**的东西
 *
 * `withdrawnAt` / `fineAmount` 两个字段按 `database-schema.md` T2 保留在类型上，
 * 但**没有任何写入路径**：提现与自动罚款都不在本批次范围内（P0-9 §十三、P0-13 §三）。
 * 它们不是「预留字段」——它们是同一张表在完整设计里的字段，写入者是后续批次。
 * 当前它们恒为初始值，且**任何 DTO 都不带它们**。
 *
 * ⚠️ `reversedAmount` **已经离开这一组**（P0-13）：退款冲回会写它。
 * 它与 `EarningAdjustment` 明细的关系是「读用总数、审计用明细」，
 * 二者在同一次原子写入里落库，见下面 `EarningAdjustment` 的注释。
 */

/**
 * 收益状态。
 *
 * - `frozen`    冻结中（订单刚完成，投诉窗口还没走完）
 * - `available` 可提现（窗口到期且无阻塞）
 * - `withdrawn` 已提现（**仍不可达**：本批次不做提现）
 * - `reversed`  已冲正（**P0-13 起可达**：退款把这一笔**整笔**冲完）
 *
 * ⚠️ 取值与 `database-schema.md` T2 完全一致，**不另造平行模型**。
 * `withdrawn` 仍然没有写入路径，但留在类型上：它是同一张表的设计字段，
 * 删除它等于宣称这张表没有这个状态，而后续批次会立刻推翻这个宣称
 * （见本文件头部「刻意没有的东西」）。
 *
 * ⚠️ **`reversed` 只表示「整笔冲销」**（产品裁定 Q2-c）：累计冲回额达到
 * `incomeAmount` 才进入它。部分冲回**不改变状态**——一笔 `available` 的收益
 * 被冲回 3000/10000 之后仍然是 `available`，因为剩下的 7000 依然可以提。
 * 把部分冲回也写成 `reversed` 会让打手以为自己这一单白干了。
 *
 * ⚠️ 与 `OrderStatus` 是**两套**状态：订单在 `completed` 就结束了，
 * 收益还要再往后走一段。绝不把 `settling` / `settled` 塞进 `OrderStatus`。
 */
export type EarningStatus = "frozen" | "available" | "withdrawn" | "reversed";

/**
 * 一条打手收益记录（仓储内部类型）。
 *
 * 一个订单**最多一条有效 Earning**：`orderId` 是逻辑唯一键
 * （Mock 存储用 `earningIdByOrder` 单值索引保证，未来数据库用唯一索引）。
 */
export type Earning = {
  id: string;
  /** 产生这笔收益的订单 */
  orderId: string;
  /** **实际履约**的打手（`Order.actualCompanionId`），不是用户当初指定的人 */
  companionId: string;
  /**
   * 收益金额（分）。**直接搬 `Order.companionBaseIncome`**，不重新计算。
   *
   * 恒为正整数：`companionBaseIncome = floor(分账基数 × 比例 / 10000)`，
   * 而「打手 0 收益」的场景（未服务即退款）按规则**根本不建 Earning**
   * （见 `database-schema.md` T3 状态机表 `accepted → refunded` 一行），
   * 因此这里不存在 0 元记录。
   */
  incomeAmount: number;
  status: EarningStatus;
  /** 冻结时刻 = 订单进入 `completed` 的时刻 */
  frozenAt: string;
  /**
   * 计划解冻时刻 = 本单的 `Order.complaintDeadlineAt`。
   *
   * ⚠️ 它是**计划值**，不是「实际解冻发生的时刻」：创建时就写下来，
   * 之后**永不刷新**——包括 `frozen → available` 那一次。这样「这笔钱什么时候到期」
   * 与「这笔钱实际上什么时候变成可提现」两个事实各自都有出处，且前者不依赖
   * sweep 什么时候被调用（惰性物化意味着调用时机由「有没有人访问」决定，
   * 把它写进 availableAt 会让同一个业务事实在不同机器上有不同的时间戳）。
   */
  availableAt: string | null;
  /** 提现时刻。**仍无写入路径**（不做提现），恒为 null */
  withdrawnAt: string | null;
  /**
   * **累计**已冲正金额（分）——P0-13 起有写入路径（退款冲回），初始为 0。
   *
   * ⚠️ 它是**累计值**，不是「最近一次冲了多少」：同一笔收益可以被多次退款
   * 反复冲减（产品裁定 Q2-d），因此这里每次是**加上去**，不是覆盖。
   *
   * ⚠️ **不变式：`0 <= reversedAmount <= incomeAmount`**（产品裁定 Q2-d）。
   * 由服务端在冲回时钳制保证（`P0-13/02-decisions.md` §十一 D4），
   * 任何一次冲回都不允许把它推过 `incomeAmount`。
   *
   * ⚠️ `incomeAmount` **永远不会因为冲回而变小**（Q2-a）：打手看到的是
   * 「原本挣了多少、被冲回多少、还剩多少」三个数，而不是一个悄悄改小的原值。
   * 「还剩多少」= `incomeAmount - reversedAmount`，是**算出来的**，不另存字段。
   *
   * ⚠️ **与 `EarningAdjustment` 明细的关系是「读用总数、审计用明细」**：
   * 页面读这个字段（O(1)），对账读明细（可逐笔追溯是哪一笔退款、谁的责任）。
   * 两者在同一次原子写入里一起落库，且有测试钉死
   * 「`reversedAmount` === 该收益全部调整明细之和」——单一真值源，
   * 不是两份各自维护的账。
   */
  reversedAmount: number;
  /** 罚款金额（分）。**仍无写入路径**，恒为 0 */
  fineAmount: number;
};

/**
 * 收益调整的类型。**当前只有一种**，刻意不做成开放式字符串。
 *
 * 用一个窄的联合类型而不是 `string`：新增一种调整（比如人工补款、罚款）
 * 必须是一次显式的类型改动，会让所有 `switch` 立刻报错提醒。
 */
export type EarningAdjustmentType = "refund_reversal";

/**
 * 一次**收益调整**明细（P0-13，产品裁定 Q2-b）。
 *
 * ## 为什么必须有它，而不能只改 `Earning.reversedAmount`
 *
 * 产品裁定 Q1-c 的原话是：平台承担的部分「必须留下明确、可审计的业务记录，
 * 不能仅通过『没有 reversal』间接推断」。一个只减数字的 `reversedAmount`
 * 正好就是那种「只能靠没发生什么来推断」的记录——它答不出
 * 「这 3000 是哪一笔退款冲的、当时认定谁的责任」。
 *
 * ⚠️ **它不是会计总账、不是钱包、不是余额桶**（Q2-b 明确不做那些）：
 * 它只是「这一笔收益被哪一次退款冲减了多少」这一行事实。没有对方科目、
 * 没有期初期末、不参与任何余额计算。
 *
 * ⚠️ 一条 `EarningAdjustment` **对应一次退款决策**，`refundId` 是幂等键
 * （同一笔退款重复批准只可能有一条明细，见 D7/D8）。
 */
export type EarningAdjustment = {
  id: string;
  /** 被冲减的那笔收益 */
  earningId: string;
  /** 冗余带上订单 id：按订单追查时不必先查 Earning */
  orderId: string;
  /** 触发这次冲减的退款决策（幂等键） */
  refundId: string;
  type: EarningAdjustmentType;
  /**
   * 冲减金额（分）。**恒为正整数**，方向由 `type` 表达——
   * 存带符号的数会让「求和校验」与「绝对值校验」混在一起，
   * 而当前只有「冲减」一个方向，符号没有信息量。
   */
  amount: number;
  /**
   * 这一次退款认定的资金责任归属（与 `RefundDecision.responsibility` 同值）。
   *
   * ⚠️ 冗余存一份而不是每次回查退款单：退款单可以被后续流程改动，
   * 而「当时是按谁的责任冲的」是一个**历史事实**，必须冻在这里。
   */
  responsibility: RefundResponsibility;
  createdAt: string;
  /**
   * 做出这次退款决策的管理员账号 id（`AdminAccount.id`）。
   *
   * ⚠️ 产品裁定「至少关联」的字段清单里**没有**它（`P0-13/02-decisions.md` §十 D-Q2 ④），
   * 但同一节的 Q1-c 要求资金记录「可审计」，而少了他就答不出「是谁批的这笔冲回」——
   * 退款记录上虽然也有 `reviewedBy`，但那份记录回答的是「这笔申请怎么处理的」，
   * 与「这笔钱是谁决定从打手身上冲回来的」不是同一个问题（同一次决策可以没有申请）。
   * 裁定同时要求「**不多加其它字段**」，因此只补这一个。
   */
  adminId: string;
};

/* ───────────────────────── 打手端 DTO（P0-9 §九） ───────────────────────── */

/**
 * 打手「我的收益」列表项。
 *
 * ## 刻意不含的东西
 *
 * ⚠️ **不含 `clubNetIncome`**（平台净收入是平台自己的账，打手端没有任何展示位置）、
 * **不含 `companionBaseIncome` 之外的任何订单金额**（`totalAmount` / `actualPaidAmount` /
 * `companionRateSnapshot` 都不给：打手要回答的是「我这一单挣了多少」，
 * 而「用户付了多少、平台抽了几成」是另一件事）。
 *
 * ⚠️ **不含 `fineAmount` / `withdrawnAt`**：它们仍然恒为初始值，
 * 带上去只是让永远为空的字段顺着响应流到浏览器。
 *
 * ⚠️ **P0-13 起含 `reversedAmount`**：它不再是「恒为初始值」的字段了。
 * 一笔被部分冲回的收益如果只显示原金额，打手会以为那笔钱还能全提——
 * 而页面上一句解释都没有。所以原值、冲回额、净额三个数一起给。
 *
 * ⚠️ **不含 `companionId`**：这一份 DTO 只会在「当前登录打手自己的收益」上下文里出现
 * （服务层按会话过滤），把 id 再带上没有用途，反而给「换个 id 试试」留了一个参数位。
 *
 * ⚠️ 本类型与其它的 DTO 一样是**显式挑字段**的：给 `Earning` 新增字段
 * 不会自动出现在打手端响应里。
 */
export type CompanionEarningItem = {
  id: string;
  /** 产生这笔收益的订单号（用户看到的是同一个号） */
  orderNo: string;
  /** 关联订单 id：页面上要能点进那一单 */
  orderId: string;
  /** 单位：分。展示时由页面转成元。**这是原始承诺额，不因退款冲回而变小**（Q2-a） */
  incomeAmount: number;
  /** 累计被退款冲回的金额（分），初始 0。**恒为正整数**，`0 <= reversedAmount <= incomeAmount` */
  reversedAmount: number;
  /**
   * 净额（分）= `incomeAmount - reversedAmount`。
   *
   * ⚠️ 就是产品裁定里的 `netAvailableAmount`（`P0-13/02-decisions.md` §十 Q2-a）。
   * **服务端算好给**，页面不做减法——金额算术只有一处。
   */
  netAmount: number;
  status: EarningStatus;
  /** 状态中文名（`EARNING_STATUS_LABELS`）。服务端给，页面不自己维护一份文案 */
  statusLabel: string;
  frozenAt: string;
  /**
   * 计划解冻时刻；历史缺快照的记录为 null（页面显示「—」而不是编一个时间）。
   *
   * 页面据此显示「预计 xx 解冻」，**不据此判断能不能提现**——能不能只由 `status` 说。
   */
  availableAt: string | null;
};

/**
 * 打手「我的收益」合计。
 *
 * 三个数都只统计**当前打手自己**的记录，且都是整数分。
 * `frozen` 与 `available` 分开给：合并成一个「总收益」会让打手以为冻结中的钱现在就能用。
 *
 * ⚠️ **P0-13 起这两个合计都是「净额」**（即 `Σ netAmount`，已扣掉退款冲回）：
 * 合计回答的是「我现在有多少钱能提」，那就必须是能提的数。用冲回前的原值求和，
 * 会让页面顶部显示一个点不出来的数字。原值与冲回额在每条记录上各自可见。
 *
 * ⚠️ `reversed`（整笔冲销）的记录两个合计都**不计入**——它的净额本来就是 0，
 * 计进去只会把「记录条数」与「金额」绑成一件说不清的事。
 */
export type CompanionEarningSummary = {
  /** 仍在冻结中的收益**净额**合计（分） */
  frozenAmount: number;
  /** 已可用的收益**净额**合计（分） */
  availableAmount: number;
  /** 记录条数 */
  count: number;
};

/** 打手「我的收益」一次要显示的全部内容。 */
export type CompanionEarningListData = {
  items: CompanionEarningItem[];
  summary: CompanionEarningSummary;
  /**
   * 页面顶部说明文案。
   *
   * 服务端给：它要同时说清「为什么这笔钱是冻结的」与「什么时候会解冻」，
   * 而这两句话依赖平台参数（投诉窗口），页面自己拼会把规则写成两份。
   */
  notice: string;
};
