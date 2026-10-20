import { plusMinutes } from "@/lib/constants/dispatch";
import {
  EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
} from "@/lib/constants/platformConfig";
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
 * ## 预置接单的来源：`acceptedVia = "companion"`（P1-5 §九-F）
 *
 * 已接单的那一批预置记录把 `acceptedVia` 写成 **`"companion"`**（打手自己接单）。
 * 这是**对这份种子本身的陈述**，不是对真实历史来源的推断。依据**只有一条**：
 *
 * - 这批单在**其余每一条读路径上**都表现为「用户下单 → 派单 → 打手接单 → 履约」的
 *   普通流程（`actualCompanionId` / `acceptedAt` 与派单记录同源），**种子里没有第二套说法**。
 *   因此这里没有任何一条记录**能够被识别为** `Staff direct replacement / assignment`
 *   （判据见 `lib/types/dispatch.ts` 的 `DispatchAcceptSource`）。
 *
 * ⚠️ **一条曾经写过、但不成立的依据，留在这里免得下次再被想出来**：
 * 「履约退出历史 store 建仓时是空的（`mockCompanionReleaseRepository.ts`），而客服换人
 * 必然留下一条退出历史，所以种子里没有换人」——**这是自证**：那个 store 为空
 * 是因为**没有人给它预置数据**，而不是因为「换人没发生过」。它顶多能说明
 * **本种子自身没有制造出可识别的换人记录**，说明不了真实历史是什么样。
 * 真正站得住的只有上面那一条（**读路径说法一致**）。
 *
 * ⚠️ **这一行是有意的、可被一句话推翻的**：产品裁定要求「认不出来源就不得凭空补」
 * （`deriveLegacyAcceptEvents` 里 `null` 那一档）。若产品负责人认为**存量**接单榜
 * 应当连这批预置数据也一并排除，把上面那个 `"companion"` 改成 `null` 即可——
 * 存量接单榜会立刻变成「只有真实事件」，其余口径一个字都不用动
 * （⚠️ **代价**：`04-acceptance.md` 里那份「阿泽 18 / 老K 8 / 小北 7」的验收读数会全部归零）。
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
 * 代价是：预置的等待单会随进程运行时间自然到期（专属池、公共池各按默认配置）。
 * 这是**正确的业务行为**，不是 bug；想重新拿到这批样本，重启服务即可。
 *
 * ⚠️ 两个池的时长都取 `platformConfig` 的**默认值常量**（而不是读当前配置）：
 * 种子描述的是「一批历史样本当初按什么规则生成」，而它必须可重复且结果相同。
 * 读当前配置会让「同一个种子在管理员改过参数之后生成出不同的 deadline」——
 * 那正是本文件最不该有的一种不确定性。（新订单的时长走 `createDispatchForOrder`，
 * 那里读的是**当下**的配置，两条路互不干扰。）
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
        exclusiveDeadlineAt: plusMinutes(order.paidAt, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES),
        exclusiveTimeoutMinutesSnapshot: EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
        publicPoolEnteredAt: null,
        publicDeadlineAt: null,
        publicTimeoutMinutesSnapshot: null,
        acceptedByCompanionId: companionId,
        acceptedAt: order.acceptedAt,
        // 见文件头「预置接单的来源」：这份种子里**不存在**客服换人 / 直接指定的样本
        acceptedVia: "companion",
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
            exclusiveDeadlineAt: plusMinutes(at, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES),
            exclusiveTimeoutMinutesSnapshot: EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
            publicPoolEnteredAt: null,
            publicDeadlineAt: null,
            publicTimeoutMinutesSnapshot: null,
            acceptedByCompanionId: null,
            acceptedAt: null,
            acceptedVia: null,
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
            exclusiveTimeoutMinutesSnapshot: null,
            publicPoolEnteredAt: at,
            publicDeadlineAt: plusMinutes(at, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES),
            publicTimeoutMinutesSnapshot: PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
            acceptedByCompanionId: null,
            acceptedAt: null,
            acceptedVia: null,
            timedOutAt: null,
            createdAt: order.paidAt,
            updatedAt: at,
          };

    // 已退款：见文件头——不编造它是怎么退的
    case "refunded":
      return null;
  }
}
