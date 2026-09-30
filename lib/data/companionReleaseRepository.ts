import type { CompanionReleaseRecord } from "@/lib/types/companionRelease";
import { mockCompanionReleaseRepository } from "./mockCompanionReleaseRepository";

/**
 * 履约退出历史（`CompanionReleaseRecord`）的可替换仓储（P0-6）。
 *
 * ## 为什么只有读方法，没有 `createRelease()`
 *
 * 退出历史**只在原子区段里诞生**：写它的那一刻必须同时清掉订单的履约绑定、
 * 把派单打回公共池、给下单用户发通知——四件事少一件，系统就进入自相矛盾的状态
 * （订单说「等待接单」而派单还说「被 A 接了」）。那些区段不能有 `await`，
 * 因此写入入口不在本接口上，而在 `lib/data/mockCompanionReleaseRepository.ts`
 * 导出的**同步写原语**，由 `lib/data/companionOrderTransaction.ts` 的伪事务调用。
 *
 * 这与派单（`lib/data/dispatchRepository.ts`）是**同一种不对称**，理由也一样：
 * 在接口上开一个 `createRelease()`，就等于开出第二条写入路径——那条路径没有原子区段、
 * 没有幂等索引、也没有「同一次取消只能有一条记录」的约束，而它与伪事务的差别
 * 只在「有人绕过服务层直接调仓储」时才会暴露。
 *
 * ⚠️ **全仓只有这一份退出历史**。不要另建「打手操作日志」「履约变更记录」
 * 或任何第二套追溯表：同一件事有两个出处，迟早会有一处少写。
 */
export type CompanionReleaseRepository = {
  /**
   * 某一单的退出历史，按 `createdAt` 正序（最早的一次在前）。
   *
   * 只按 `orderId` 查、**不按打手收窄**：这个问题问的是「**这一单**上发生过什么」，
   * 而不是「某个打手干过什么」——退出者恰好是当前履约人时，按打手收窄会让他
   * 看不到自己那一笔。谁看得到由**路由层**决定，不由本查询决定。
   *
   * ⚠️ 调用方有**四个**，全都是内部工作台，且每一个都已经过了自己的守卫：
   * `requireAdmin()` 的管理端订单详情，以及 `requireStaff()` 的客服会话 / 投诉 /
   * 退款详情。⚠️ 管理端与客服工作台是**两套账号**：`canEnterAdminConsole(role)`
   * 只对 `admin` 为真，`customer_service` **进不了** `/admin`（`lib/constants/admin.ts`）。
   * 客服能看到这份历史，是因为客服自己的工作台也挂了它，**不是**因为「进的是同一个后台」。
   *
   * 没有退出过返回**空数组**，不是 `null`。
   */
  listReleasesByOrderId(orderId: string): Promise<CompanionReleaseRecord[]>;
};

export function getCompanionReleaseRepository(): CompanionReleaseRepository {
  return mockCompanionReleaseRepository;
}
