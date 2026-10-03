import type {
  CompanionServiceEvent,
  DerivedServiceEvent,
} from "@/lib/types/companionService";
import { mockCompanionServiceRepository } from "./mockCompanionServiceRepository";

/**
 * 服务事件（`CompanionServiceEvent`）的可替换仓储（P1-7）。
 *
 * ## 为什么只有读方法，没有 `createServiceEvent()`
 *
 * 服务事件**只在原子区段里诞生**：写它的那一刻必须同时把订单推进到 `serving`
 * 并写下 `servingAt`——少一件，系统就进入自相矛盾的状态（订单说「服务中」而历史里
 * 没有那次服务）。那些区段不能有 `await`，因此写入入口不在本接口上，
 * 而在 `lib/data/mockCompanionServiceRepository.ts` 导出的**同步写原语**
 * `appendCompanionService()`，由 `lib/data/companionOrderTransaction.ts` 的伪事务调用。
 *
 * 这与接单事件（`lib/data/companionAcceptRepository.ts`）、履约退出历史
 * （`lib/data/companionReleaseRepository.ts`）、派单（`lib/data/dispatchRepository.ts`）
 * 是**同一种不对称**，理由也一样：在接口上开一个 `createServiceEvent()`，
 * 就等于开出第二条写入路径——那条路径没有原子区段、没有「同一 assignment 只记一次」
 * 的约束，而它与伪事务的差别只在「有人绕过服务层直接调仓储」时才会暴露。
 *
 * ## 全仓只有这一份服务历史
 *
 * ⚠️ 不要另建「服务日志」「护航流水」或任何第二套表。同一件事有两个出处，
 * 迟早会有一处少写——而「常用打手」的数字正是从它数出来的。
 */
export type CompanionServiceRepository = {
  /**
   * 全部服务事件（**不分页、不按打手收窄**）。
   *
   * 面板要按打手聚合，因此查询本身就是全量的；按打手收窄在这里没有意义
   * （那会把「这位打手在这个老板这儿服务了几次」拆成 N 次查询）。
   *
   * ⚠️ 它**不**包含存量派生事件，两者故意分开：这一份是**真的发生过、
   * 真的被记下来的**历史，另一份是「现模型里还读得出来的那一次」。
   * 调用方要的是并集，但两者必须能分开断言——否则测试就无法区分
   * 「事件真的写进去了」与「碰巧被派生补上了」。
   */
  listServiceEvents(): Promise<CompanionServiceEvent[]>;

  /**
   * 存量数据里**仍然可考据**的那一次服务（每张仍有 `servingAt` + `actualCompanionId` 的订单一条）。
   *
   * 只补「最后一次」，因此对历史上发生过换人的存量单是**下界**；
   * 详见 `lib/types/companionService.ts` 的 `DerivedServiceEvent`。
   */
  listLegacyServiceEvents(): Promise<DerivedServiceEvent[]>;
};

export function getCompanionServiceRepository(): CompanionServiceRepository {
  return mockCompanionServiceRepository;
}
