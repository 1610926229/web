/**
 * 最小履约退出历史 `CompanionReleaseRecord`（`database-schema.md` T4）。
 *
 * ## 它回答的唯一问题
 *
 * 订单上的「谁在履约」是一个**当前状态**字段：打手退出之后它必须被清空
 * （否则订单回到「等待接单」却还挂着一个并不在履约的名字）。但清空会丢掉
 * 「谁曾经接过、为什么退出、什么时候退出、谁触发的」——而那正是客服与管理员
 * 处理争议时要看的东西。
 *
 * 因此这里单独记一条**只增不改**的历史：退出动作写一条，订单上的绑定照样清。
 * 两者不是二选一：状态字段回答「现在是谁」，本记录回答「之前是谁、为什么走」。
 *
 * ## 为什么只有 7 个字段
 *
 * P0 明确**不引入复杂 Assignment 聚合**（`database-schema.md` 第三部分把
 * 「复杂 Replacement / Assignment 聚合」列为 `TBD — DO NOT INVENT`）。
 * 这里只记追溯所必需的七样，不承载新的订单状态机、不记退出前的快照、
 * 不记「换给了谁」——那些属于本记录之外的概念。
 *
 * ⚠️ 幂等索引（`${companionId}:${idempotencyKey}` → 本条 id）**不是**这里的字段：
 * 它落在退出历史仓储的 store 里（见 `lib/data/mockCompanionReleaseRepository.ts`），
 * 与订单 store 的 `requestIdByKey`、退款 store 的 `refundIdByKey` 同一套做法。
 * 加成一个字段就等于把「调用方给的一个串」写进业务事实里。
 */

/**
 * 结束当前履约绑定的原因。
 *
 * ⚠️ **本轮只有 `companion_cancel` 有入口**（打手在 `accepted` 阶段主动取消接单）。
 * 另外两个取值是 `database-schema.md` T4 已定义的 TARGET 占位，
 * **尚未实现、也没有任何写入路径**：
 *
 * - `companion_disabled` —— 打手被封禁 / 移除导致回池，属于系统侧后续 Round；
 * - `staff_reassign`    —— 客服主动换人，同样属于后续 Round。
 *
 * 保留它们是为了让「同一张订单上出现过几种退出」这个问题的取值集合一次定死，
 * 而不是为了提前设计封禁与换人流程（那是明确禁止的）。
 */
export type CompanionReleaseSource = "companion_cancel" | "companion_disabled" | "staff_reassign";

/**
 * 一条履约退出历史（仓储内部类型）。
 *
 * 页面与接口**不直接返回本类型**：管理端订单详情走 `AdminOrderDetail.releaseHistory`，
 * 而且这一份**只对客服 / 管理员可见**——普通公共池打手看不到别人为什么退出，
 * 下单用户也不看（他收到的是一条通知，不是别人的退出记录）。
 */
export type CompanionReleaseRecord = {
  id: string;
  orderId: string;
  /** 退出时**正在履约**的那位打手（不是用户当初指定的人） */
  companionId: string;
  source: CompanionReleaseSource;
  /**
   * 退出原因。
   *
   * ⚠️ `source === "companion_cancel"` 时**必须非空**（`01-prompt.md` §2.2）。
   * 这条不变量的**唯一**执行点是主动取消的入口
   * （`lib/services/companionOrders.ts` 的 `cancelCompanionOrder`：trim 后为空即 400），
   * 伪事务据此只负责把已经校验过的原文写下来。
   * 在那里再判一次，就等于同一条规则有两个出处——两处对同一个请求给出不同答案时，
   * 没有人能说出哪一处才是规则。
   *
   * 其余两个 source 由系统 / 客服触发，允许为空：那时没有「他自己写的一句话」这种东西，
   * 编一句出来反而更糟。
   */
  reason: string | null;
  /** 谁触发的：主动取消时是打手本人（= `companionId`），系统 / 管理员场景允许为空 */
  actorId: string | null;
  createdAt: string;
};
