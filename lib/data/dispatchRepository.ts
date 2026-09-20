import type { DispatchRecord } from "@/lib/types/dispatch";
import { mockDispatchRepository } from "./mockDispatchRepository";

/**
 * 派单记录的可替换仓储（P0-5）。
 *
 * ## 为什么只有两个读方法
 *
 * 派单的**每一次写入都发生在原子区段里**（接单要同时改派单与订单，超时清扫要同时
 * 改派单与订单与通知），而那些区段不能有 `await`。因此写入入口不在本接口上，
 * 而在 `lib/data/mockDispatchRepository.ts` 导出的**同步写原语**，
 * 由 `lib/data/companionDispatchTransaction.ts` 的伪事务调用。
 *
 * 这与平台参数（读走仓储、写走事务）是同一种不对称，理由也一样：
 * 在接口上加一个 `updateDispatch()`，就等于开出了第二条写入路径——
 * 那条路径没有原子区段、没有「一个订单只能有一条派单记录」的不变量、
 * 也没有「exclusiveCompanionId 不许被覆盖」的约束，而它与伪事务的差别
 * 只在「有人绕过服务层直接调仓储」时才会暴露。
 */
export type DispatchRepository = {
  /**
   * 所有**还在等人接**的派单（`exclusive` / `public`）。
   *
   * ⚠️ **不按打手收窄**：谁能看到哪一条由服务层判定（专属池只给指定的那位，
   * 公共池给所有有资格的打手），仓储只回答「现在有哪些单在等」。
   * 把过滤写在仓储里，会让「资格规则」在数据库查询与业务代码里各有一份。
   *
   * 返回值只在服务端转成打手端 DTO（`CompanionPoolItem`），
   * `CompanionPoolItem` 里**没有**游戏账号与备注，因此这一份数据不会原样出网。
   */
  listOpenDispatches(): Promise<DispatchRecord[]>;

  /**
   * 按订单取派单记录；没有则返回 `null`。
   *
   * `null` 是**正常情况**而不是异常：退款订单在种子里就没有派单记录
   * （见 `lib/mocks/fixtures/dispatchSeed.ts`），管理员手动退款一条在池中的订单
   * 也不会去动它的派单记录。所有调用方都必须处理「查不到」。
   */
  findDispatchByOrderId(orderId: string): Promise<DispatchRecord | null>;
};

export function getDispatchRepository(): DispatchRepository {
  return mockDispatchRepository;
}
