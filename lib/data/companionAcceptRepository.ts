import type {
  CompanionAcceptEvent,
  DerivedAcceptEvent,
} from "@/lib/types/companionAccept";
import { mockCompanionAcceptRepository } from "./mockCompanionAcceptRepository";

/**
 * 接单事件（`CompanionAcceptEvent`）的可替换仓储（P1-5）。
 *
 * ## 为什么只有读方法，没有 `createAcceptEvent()`
 *
 * 接单事件**只在原子区段里诞生**：写它的那一刻必须同时把派单标成已接、
 * 把订单写成 `accepted`、给下单用户发通知——少一件，系统就进入自相矛盾的状态
 * （订单说「已接单」而派单还在池子里等）。那些区段不能有 `await`，
 * 因此写入入口不在本接口上，而在 `lib/data/mockCompanionAcceptRepository.ts`
 * 导出的**同步写原语**，由 `lib/data/companionDispatchTransaction.ts` 的伪事务调用。
 *
 * 这与履约退出历史（`lib/data/companionReleaseRepository.ts`）、派单
 * （`lib/data/dispatchRepository.ts`）是**同一种不对称**，理由也一样：
 * 在接口上开一个 `createAcceptEvent()`，就等于开出第二条写入路径——那条路径没有原子区段、
 * 没有「同一次接单只写一条」的约束，而它与伪事务的差别只在
 * 「有人绕过服务层直接调仓储」时才会暴露。
 *
 * ## 全仓只有这一份接单历史
 *
 * ⚠️ 不要另建「接单日志」「派单流水」或任何第二套表。同一件事有两个出处，
 * 迟早会有一处少写——而接单榜的数字正是从它数出来的。
 */
export type CompanionAcceptRepository = {
  /**
   * 全部接单事件（**不分页、不按打手收窄**）。
   *
   * 榜单要按打手聚合，因此查询本身就是全量的；按打手收窄在这里没有意义
   * （那会把「这位打手这个周期接了几次」拆成 N 次查询）。
   *
   * ⚠️ 它**不**包含存量派生事件，两者故意分开：这一份是**真的发生过、
   * 真的被记下来的**历史，另一份是「现模型里还读得出来的那一次」。
   * 调用方要的是并集，但两者必须能分开断言——否则测试就无法区分
   * 「事件真的写进去了」与「碰巧被派生补上了」。
   */
  listAcceptEvents(): Promise<CompanionAcceptEvent[]>;

  /**
   * 存量数据里**仍然可考据**的那一次接单（每条仍处于 `accepted` 的派单记录一条）。
   *
   * 只补「最后一次」，因此对历史上发生过多次换人的存量单是**下界**；
   * 详见 `lib/types/companionAccept.ts` 的 `DerivedAcceptEvent`。
   */
  listLegacyAcceptEvents(): Promise<DerivedAcceptEvent[]>;
};

export function getCompanionAcceptRepository(): CompanionAcceptRepository {
  return mockCompanionAcceptRepository;
}
