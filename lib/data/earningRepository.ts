import type { Earning } from "@/lib/types/earning";
import { mockEarningRepository } from "./mockEarningRepository";

/**
 * 打手收益的读取契约（P0-9）。
 *
 * ## 为什么这里**只有读**，写入在别处
 *
 * 与完成材料（`lib/data/completionRepository.ts`）是同一套结构：**写入不经过本接口**。
 * 一条收益的创建必须与「订单写成 completed + 冻结投诉窗口快照」发生在**同一段
 * 没有 `await` 的同步代码**里（`lib/data/earningTransaction.ts` 的伪事务），
 * 而异步的仓储方法做不到这件事——在它前后让出执行权，就会出现「订单已 completed、
 * 收益还没建」的半写状态。
 *
 * 因此本接口只服务读取（页面与接口），写原语由 `mockEarningRepository.ts` 以
 * **同步导出的函数**形式提供，只允许伪事务调用。
 *
 * ## 归属是查询条件，不是过滤项
 *
 * `listEarningsForCompanion(companionId)` 只可能返回这一位打手的收益，
 * 调用方不需要（也不应该）拿到结果后再过滤一次——与 `PaymentRepository`
 * 的 `queryOrdersByCompanion` 同一条约定。打手端页面永远只回答「我挣了多少」。
 */
export type EarningRepository = {
  /**
   * 某个打手**自己**的全部收益，按产生时间倒序（最新在前）。
   *
   * 不分页：本阶段是一位打手自己的一份账，条数受他实际完成的订单数约束；
   * 真实数据库接入时再按时间分页（届时排序键仍然由仓储回答）。
   */
  listEarningsForCompanion(companionId: string): Promise<Earning[]>;

  /**
   * 按订单取那一条收益；没有返回 null。
   *
   * 用于回答「这一单的收益状态是什么」这类单点问题，也是「一个订单最多一条收益」
   * 这条约束的读取侧入口。**不做归属判断**：归属由调用方校验。
   */
  findEarningByOrderId(orderId: string): Promise<Earning | null>;
};

export function getEarningRepository(): EarningRepository {
  return mockEarningRepository;
}
