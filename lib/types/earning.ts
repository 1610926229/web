/**
 * ⚠️ **P0-15 删除了 `EarningAdjustment.responsibility`**（原先从 `./refund` 引入
 * `RefundResponsibility`）。用户 2026-09-28 裁定废止责任模型：
 * 管理员不再选择责任归属，退款批准即把打手收益整笔取消。
 * 与 `RefundDecision` 的三项责任字段同批删除、同一理由——
 * 本仓库无真库、无历史持久化数据，唯一的历史载体是种子 fixture，迁移成本为零，
 * 因此不做「保留但弃用」的半吊子兼容层。
 */

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
 * - `reversed`  已冲正（**P0-15 起不再可达**：P0-13 曾可达，见下）
 *
 * ⚠️ 取值与 `database-schema.md` T2 完全一致，**不另造平行模型**。
 * `withdrawn` 仍然没有写入路径，但留在类型上：它是同一张表的设计字段，
 * 删除它等于宣称这张表没有这个状态，而后续批次会立刻推翻这个宣称
 * （见本文件头部「刻意没有的东西」）。
 *
 * ⚠️ **`reversed` 只表示「整笔冲销」**：冲回额达到 `incomeAmount` 才进入它。
 *
 * ⛔ **P0-15 的产品裁定让它不再可写**。指令 ②§四 原话：「因为正常退款发生在
 * 结算冻结阶段，所以处理对象应当仍是 `Earning.status = frozen`」，
 * §十(8) 同旨。因此整笔冲销**不改状态**——净额归零的收益**停在 `frozen`**，
 * 由释放判据里的净额闸（`isEarningFullyReversed()`）保证它永远不会被释放。
 * 本条**取代 P0-13 的 D8**（那一版写的是「整笔冲销进入 `reversed`」）。
 *
 * ⚠️ 它留在联合类型里、而不是删掉，与 `withdrawn` 同一条理由：
 * 它是这张表在完整设计里的取值，删除等于宣称这张表没有这个状态。
 * 但它今天**没有写入路径**——看到它的记录只可能来自外部写坏的数据。
 *
 * ⚠️ 这里原先还写着一条 P0-13 的裁定（Q2-c）：「部分冲回**不改变状态**——
 * 一笔 `available` 的收益被冲回 3000/10000 之后仍然是 `available`，
 * 因为剩下的 7000 依然可以提。**把部分冲回也写成 `reversed` 会让打手以为
 * 自己这一单白干了**。」
 * **它的后半句（别让打手以为白干）前提被反转了**：新规则下退款比例不论是
 * 10% 还是 100%，打手这一单的收益**全部取消**——他**确实**白干了。
 * 保留这段文字是为了说明**为什么当年不是这样**，不是为了让谁照它实现。
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
   * 已冲正金额（分）——P0-13 起有写入路径（退款冲回），初始为 0。
   *
   * ⚠️ **P0-15 起它在任何一条真实可达的路径上都等于 `incomeAmount`**：
   * 一个订单最多退一次，而那次退款**必然整笔冲销**。
   * 字段本身仍然是「累加」语义（`applyEarningReversal` 加法写入），
   * 但已经**不再有能让它停在中途的路径**——「半冲」只可能来自写坏的数据，
   * 那属于数据异常，不是业务形态。
   *
   * ⚠️ 原先这里写着「同一笔收益可以被多次退款反复冲减（产品裁定 Q2-d）」。
   * **Q2-d 已被 P0-15 覆盖**：不存在多次退款。保留这句话的删除痕迹，
   * 是为了让后来的人知道这个「累计」不是设计疏忽，而是一套被正式废止的模型。
   *
   * ⚠️ **不变式：`0 <= reversedAmount <= incomeAmount`**，由存储层
   * `applyEarningReversal` 自带护栏维持。⚠️ P0-15 之前它还需要服务端的
   * 「剩余可冲回额」钳制配合（`P0-13/02-decisions.md` §十一 D4），
   * **现在不需要了**：冲回额就是 `incomeAmount` 本身，构造上不可能越界。
   *
   * ⚠️ `incomeAmount` **永远不会因为冲回而变小**（Q2-a，仍然有效）：打手看到的是
   * 「原本挣了多少、被冲回多少、还剩多少」三个数，而不是一个悄悄改小的原值。
   * 「还剩多少」= `incomeAmount - reversedAmount`，是**算出来的**，不另存字段。
   *
   * ⚠️ **与 `EarningAdjustment` 明细的关系是「读用总数、审计用明细」**：
   * 页面读这个字段（O(1)），对账读明细（可追溯是哪一笔退款冲的）。
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
 * 一次**收益调整**明细（P0-13 建立 · P0-15 收窄）。
 *
 * ## 为什么必须有它，而不能只改 `Earning.reversedAmount`
 *
 * 一个只减数字的 `reversedAmount` 是「只能靠没发生什么来推断」的记录——
 * 它答不出「这 3000 是哪一笔退款冲的」。明细回答的正是这个问题。
 *
 * ⚠️ **它不是会计总账、不是钱包、不是余额桶**：
 * 它只是「这一笔收益被哪一次退款冲减了多少」这一行事实。没有对方科目、
 * 没有期初期末、不参与任何余额计算。
 *
 * ⚠️ 一条 `EarningAdjustment` **对应一次退款决策**，`refundId` 是幂等键
 * （同一笔退款重复批准只可能有一条明细）。P0-15 起「一个订单至多一次退款」，
 * 因此**一条 `Earning` 上的明细至多一条**，且 `amount` 恒等于 `incomeAmount`。
 *
 * ⛔ **P0-15 删掉了 `responsibility` 字段**（原 P0-13 裁定 D12 曾打算「保留字段、
 * 新写入不再填」）。理由：责任模型整体废止，一个**永远写 `null`** 的字段
 * 不是「历史兼容」，它是**死字段**——留着只会让下一个读代码的人以为
 * 「还有别的责任分支没写出来」。同一轮把「责任」从 `RefundDecision`、
 * 请求体、界面里一并删除，保持一个方向。
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
  createdAt: string;
  /**
   * 做出这次退款决策的管理员账号 id（`AdminAccount.id`）。
   *
   * ⚠️ 少了他就答不出「是谁批的这笔冲回」——退款记录上虽然也有 `reviewedBy`，
   * 但那份记录回答的是「这笔申请怎么处理的」，与「这笔钱是谁决定从打手身上
   * 冲回来的」不是同一个问题。资金记录要求可审计，因此必须有这一个；
   * 同一份清单也要求「**不多加其它字段**」，因此只有这一个。
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
   * 页面据此显示「预计 xx 解冻」，**不据此判断能不能提现**：
   * ① 时间不是判据——P0-9 起释放还看有无结算阻塞；
   * ② **P0-15 起 `status` 一个人也不够了**——被退款冲光的那笔收益**停在 `frozen`**，
   *    和「正常冻结中」共用同一个状态，只读 `status` 会把一句假话
   *    （「到期自动转为可提现」）念给打手听。
   *
   * 说给打手的那句话由 `earningHintFor({ status, netAmount })` 产出，**页面不自己拼**。
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
 * ⚠️ **净额归零的记录对两个合计都没有贡献**，无论它停在哪个状态：
 * P0-15 之后它停在 `frozen`（不是 `reversed`），而求和用的是 `netAmount`，
 * 因此它加进去是 0。计一条 0 进金额不会改变合计，
 * 但会让「打手看到冻结合计是 0、记录却有好几条」这件事变得可以解释。
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
