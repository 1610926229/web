/**
 * 打手收益（Earning）与结算（Settlement）——P0-9。
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
 * ## 本阶段刻意**没有**的东西
 *
 * `withdrawnAt` / `reversedAmount` / `fineAmount` 三个字段按
 * `database-schema.md` T2 保留在类型上，但**没有任何写入路径**：提现、冲正、
 * 自动罚款都不在本批次的范围内（P0-9 §十三明确不做）。它们不是「预留字段」——
 * 它们是同一张表在完整设计里的字段，写入者是后续批次。当前它们恒为初始值，
 * 且**任何 DTO 都不带它们**（没有值可显示，且「已提现多少」是钱包域的事）。
 */

/**
 * 收益状态。
 *
 * - `frozen`    冻结中（订单刚完成，投诉窗口还没走完）
 * - `available` 可提现（窗口到期且无阻塞）
 * - `withdrawn` 已提现（**P0-9 不可达**：不做提现）
 * - `reversed`  已冲正（**P0-9 不可达**：不做冲正）
 *
 * ⚠️ 取值与 `database-schema.md` T2 完全一致，**不另造平行模型**。
 * 后两个取值在本阶段没有写入路径，但留在类型上：它们是同一张表的设计字段，
 * 删除它们等于宣称这张表只有两个状态，而后续批次会立刻推翻这个宣称
 * （见本文件头部「刻意没有的东西」）。
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
  /** 提现时刻。P0-9 **无写入路径**（不做提现），恒为 null */
  withdrawnAt: string | null;
  /** 已冲正金额（分）。P0-9 **无写入路径**，恒为 0 */
  reversedAmount: number;
  /** 罚款金额（分）。P0-9 **无写入路径**，恒为 0 */
  fineAmount: number;
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
 * ⚠️ **不含 `reversedAmount` / `fineAmount` / `withdrawnAt`**：P0-9 里它们恒为初始值，
 * 带上去只是让三个永远为空的字段顺着响应流到浏览器。
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
  /** 单位：分。展示时由页面转成元 */
  incomeAmount: number;
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
 */
export type CompanionEarningSummary = {
  /** 仍在冻结中的收益合计（分） */
  frozenAmount: number;
  /** 已可用的收益合计（分） */
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
