/**
 * 服务事件 `CompanionServiceEvent`（P1-7）——**只增不改**的历史。
 *
 * ## 它为什么必须存在（产品裁定 `D10` 的附加要求，逐字）
 *
 * > 从 P1-7 起，真实进入 `serving` 时必须留下一个**不可变、可审计的历史事实**。
 * > ……**不要用当前 `Order.servingAt` 单字段承担历史多 assignment 事实。**
 *
 * 缺口的成因是**结构性的**，不是「顺手加一张表」：
 *
 * - `Order.servingAt` 在产品口径里表达的是「**当前这位**打手从何时开始服务」
 *   （P0-11 §九 D-Q1），而打手被换掉 / 回池时它会被**清成 `null`**
 *   （`lib/data/mockPaymentRepository.ts` 的 `applyOrderAcceptanceReleased`）。
 *   于是「A 服务过、后来换成了 B」这件事里，**A 的服务时刻在任何地方都不存在**。
 * - 派单记录（`DispatchRecord`）**一单只有一行**，换人会**复用并覆盖**它
 *   （`dispatchIdByOrder` 保证唯一）。它回答「现在是谁」，回答不了「先后有谁服务过」。
 * - 履约退出历史（`CompanionReleaseRecord`）回答「谁**走**了」，且明文**不记「换给了谁」**，
 *   它的时间戳是**退出时刻**——拿它冒充服务时刻就是产品明令禁止的「猜历史」。
 * - 接单事件（`CompanionAcceptEvent`）回答「谁**接单**了」。接单**不等于**服务：
 *   `accepted → 取消` 从未开始服务的打手也会留下接单事件。
 *
 * ⇒ 因此「**谁真实进入过 `serving`**」在现模型里**读不出来**，而产品裁定 `D7` 的
 * 「常用打手」正要以它为准。一张只增不改的服务历史是这句话**唯一**的落点。
 *
 * ⚠️ **它不是第二套追溯表**：接单事件答「谁**来**了」（接单动作写），退出历史答
 * 「谁**走**了」（退出动作写），服务事件答「谁**开始服务**了」（进入 serving 动作写）。
 * 三件事各有一个出处，**互不重复表达**。
 *
 * ## 旧数据怎么办（`D10` 主裁定：fail-closed）
 *
 * > 无法证明某位**已退出** assignment 真实进入过 `serving` 的：**不计入**……
 * > 当前统计**允许是历史真值的 lower-bound**。
 *
 * 本表建仓时是**空的**，且**不 backfill**。存量数据里**仍然写得明明白白**的那一次
 * （订单当前/最终的 `servingAt` + `actualCompanionId`）由读取侧**派生**补上——
 * 那是「把订单上白纸黑字写着的事实读出来」，与「编造一段从未发生过的历史」是两件事。
 * 这与接单榜「存量是历史下界」的处理方式**同源**（见 `lib/types/companionAccept.ts`）。
 */

/**
 * 一条服务事件。
 *
 * ⚠️ **唯一的业务判据是三元组 `(orderId, companionId, servingAt)`**：
 * 「同一个打手在同一条订单上、从同一个时刻开始的服务」只应有一条。
 * 它由写入侧的在写前查重保证——但它是**推导**出来的判据，不是记录里的字段，
 * 因此不重复存一份。
 *
 * ⚠️ **金额、订单状态快照一概不记**：进入 `serving` 的那一刻既不定价也不结束订单，
 * 把「现在的状态」写进历史就是伪造历史（与 `CompanionAcceptEvent` 同一条纪律）。
 */
export type CompanionServiceEvent = {
  id: string;
  /** 服务的是哪一单 */
  orderId: string;
  /** **真实进入服务**的这位打手。⚠️ 与订单当前的 `actualCompanionId` 可以不同（换人之后） */
  companionId: string;
  /**
   * 这次服务发生在**哪一条派单**上（`DispatchRecord.id`）。
   *
   * ⚠️ **它不是唯一键**：换人复用同一条派单记录，因此同一条订单上先后服务的两位打手
   * 会共享同一个 `dispatchId`。它只用来回答「这次服务挂在哪条派单上」，
   * 读不出来时为 `null`（**不编一个 id**）。
   */
  dispatchId: string | null;
  /** **真实进入 `serving` 的那一刻** */
  servingAt: string;
  /**
   * 服务开始时该打手的**用户可见快照**（名字 / 头像）。
   *
   * 为什么要存在（产品裁定 `D9` 的直接后果）：「常用打手」要展示
   * 「**最近一次真实 serving 对应的那份历史公开快照**」，而 A 被换成 B 之后，
   * 订单上的 `companion` 快照已经变成 B 的了——**A 的名字在订单上已经读不出来**。
   * 而裁定同时要求「不依赖当前 Companion 私有资料」来展示历史。
   *
   * ⚠️ 快照的**来源与订单的 `companion` 同源**（`OrderCompanionSnapshot`），
   * 因此它是**本来就已对用户可见**的信息，不构成新的泄露：
   * 订单列表接口早就把 `{ id, name, avatarUrl }` 发给用户了。
   * 这里**不记**任何 `enabled` / `removedAt` / `sortOrder` / `linkedUserId` 之类的内部字段。
   */
  companionName: string;
  companionAvatarUrl: string;
};

/**
 * 服务事件在**没有历史记录**时仍可考据的那一次（存量数据的下界）。
 *
 * 与真实的 `CompanionServiceEvent` 形状一致，但 `id` 由订单派生（不占用事件表的 id 空间），
 * 且**只对订单当前/最终的那位打手**派生——因为 `Order.servingAt` 只保留最后一次。
 *
 * ⚠️ **派生的边界（必须如实告知）**：对历史上真的发生过 A → B 换人的存量单，
 * 只有**最后**那位读得出来。这正是产品裁定 `D10` 说的「允许是 lower-bound」。
 */
export type DerivedServiceEvent = {
  orderId: string;
  companionId: string;
  dispatchId: string | null;
  servingAt: string;
  companionName: string;
  companionAvatarUrl: string;
};
