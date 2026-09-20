import { EXCLUSIVE_WAIT_MINUTES, plusMinutes } from "@/lib/constants/dispatch";
import { PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES } from "@/lib/constants/platformConfig";
import type { DispatchRecord } from "@/lib/types/dispatch";
import type { Order } from "@/lib/types/order";

/**
 * 预置派单记录（P0-5）。
 *
 * 用途只有一个：让**已经存在的历史订单**在派单域里是自洽的——一条 `accepted`
 * 的订单，如果查不到对应的派单记录，用户端与管理端就只能显示「等待接单」，
 * 而它的状态明明写着「已接单」。数据自相矛盾比缺少数据更难查。
 *
 * ⚠️ **不覆盖退款订单**。它们当初是超时退的还是管理员退的，种子里并没有记下来，
 * 硬造一条 `timed_out` 就等于编造一段没发生过的事实。派单查询因此必须能返回 null，
 * 而那条路径本来也必须存在：管理员手动退款一条在池中的订单时，派单记录同样不参与。
 *
 * ⚠️ **存量事实，不是规则**。下面把历史订单的 `exclusiveCompanionId` 也填成
 * 「实际接单的那位」，是因为这些单当初就是直接绑定了人。**不要**把这条写进任何
 * 生产逻辑，也不要断言它是不变量——P0-5 之后的新订单，「用户指定」与「实际接单」
 * 完全可以是两个人。
 *
 * ⚠️ 与 `orderSeed` 一同在接入真实后端后移除。
 */

/**
 * 一条预置订单对应一行派单记录。
 *
 * 在池中的那几条（`paid`）的时刻**相对 `now`（进程基准时间）而不是相对订单的支付时间**：
 * 种子里 `paid` 的订单支付于几天前，若按支付时间算截止时间，它们在服务启动的
 * 第一次清扫里就会全部超时退款，用户端再也看不到「等待接单」这个状态——
 * 而那正是这几条预置数据存在的意义。
 *
 * 代价是：预置的等待单会随进程运行时间自然到期（专属池 10 分钟、公共池按默认配置）。
 * 这是**正确的业务行为**，不是 bug；想重新拿到这批样本，重启服务即可。
 */
export function buildDispatchSeed(orders: Order[], now: Date): DispatchRecord[] {
  const at = now.toISOString();
  const records: DispatchRecord[] = [];

  for (const order of orders) {
    const record = buildOne(order, at);
    if (record) records.push(record);
  }

  return records;
}

function buildOne(order: Order, at: string): DispatchRecord | null {
  const companionId = order.actualCompanionId;

  // 只创建一条派单记录：它的 id 由订单 id 派生，因此重复建仓不会产生两份
  const id = `dsp-${order.id}`;

  switch (order.status) {
    // 已接单 / 护航中 / 已完成：派单早已结束。进入专属池的时刻按订单的支付时间还原，
    // 接单时刻直接用订单自己的时间节点——两处时间来自同一份数据，不会互相矛盾
    case "accepted":
    case "serving":
    case "completed":
      if (!companionId) return null;
      return {
        id,
        orderId: order.id,
        state: "accepted",
        exclusiveCompanionId: companionId,
        exclusiveEnteredAt: order.paidAt,
        exclusiveDeadlineAt: plusMinutes(order.paidAt, EXCLUSIVE_WAIT_MINUTES),
        publicPoolEnteredAt: null,
        publicDeadlineAt: null,
        publicTimeoutMinutesSnapshot: null,
        acceptedByCompanionId: companionId,
        acceptedAt: order.acceptedAt,
        timedOutAt: null,
        createdAt: order.paidAt,
        updatedAt: order.acceptedAt ?? order.paidAt,
      };

    // 等待接单：按订单当初有没有绑定打手，决定它落在专属池还是公共池
    case "paid":
      return companionId
        ? {
            id,
            orderId: order.id,
            state: "exclusive",
            exclusiveCompanionId: companionId,
            exclusiveEnteredAt: at,
            exclusiveDeadlineAt: plusMinutes(at, EXCLUSIVE_WAIT_MINUTES),
            publicPoolEnteredAt: null,
            publicDeadlineAt: null,
            publicTimeoutMinutesSnapshot: null,
            acceptedByCompanionId: null,
            acceptedAt: null,
            timedOutAt: null,
            createdAt: order.paidAt,
            updatedAt: at,
          }
        : {
            id,
            orderId: order.id,
            state: "public",
            exclusiveCompanionId: null,
            exclusiveEnteredAt: null,
            exclusiveDeadlineAt: null,
            publicPoolEnteredAt: at,
            publicDeadlineAt: plusMinutes(at, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES),
            publicTimeoutMinutesSnapshot: PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
            acceptedByCompanionId: null,
            acceptedAt: null,
            timedOutAt: null,
            createdAt: order.paidAt,
            updatedAt: at,
          };

    // 已退款：见文件头——不编造它是怎么退的
    case "refunded":
      return null;
  }
}
