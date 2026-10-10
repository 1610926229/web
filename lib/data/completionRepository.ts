import type { CompletionSubmission, CompletionSubmissionStatus } from "@/lib/types/completion";
import { mockCompletionRepository } from "./mockCompletionRepository";

/**
 * 完成材料的可替换仓储（P0-8）。
 *
 * ## 为什么这里没有写入方法
 *
 * 完成材料的**写入必须与订单写入同生共死**（「submission approved 但 Order 仍 serving」
 * 是明确禁止出现的一致状态，见 `01-prompt.md` §十），因此写入入口只有一处：
 * `lib/data/completionTransaction.ts` 的伪事务。它拿的是 `mockCompletionRepository` 的
 * 同步写原语（`appendCompletionSubmission` / `applyCompletionReview`），**不是**本接口——
 * 本接口是给业务读的（客服列表 / 详情、打手详情摘要）。
 *
 * 于是这里出现与平台参数同一个刻意的**不对称**：读走接口、写走事务。
 * 若在这里加一个 `updateStatus()`，就等于开出了第二条写入路径——
 * 那条路径没有「同一订单最多一份 pending」的判定，也没有与订单的原子一致。
 */
export type CompletionRepository = {
  /** 按 id 取一条完成材料；不存在返回 null。 */
  findCompletionById(id: string): Promise<CompletionSubmission | null>;

  /** 某个订单**最近一次**提交的完成材料；从未提交过返回 null。 */
  findLatestCompletionByOrderId(orderId: string): Promise<CompletionSubmission | null>;

  /**
   * 某个订单**属于指定打手**的最近一次提交；该打手从未提交过返回 null。
   *
   * ⚠️ 与 `findLatestCompletionByOrderId` 刻意分开：打手订单详情的完成材料摘要
   * 必须只回**当前履约人自己**的那一份，否则换人（P0-9 封禁回池 / 客服改派）之后
   * 新打手会看到上一位打手的驳回原因。
   */
  findLatestCompletionByOrderIdAndCompanionId(
    orderId: string,
    companionId: string,
  ): Promise<CompletionSubmission | null>;

  /** 客服端全量列表（按提交时间倒序）；`status === null` 表示不限状态。 */
  listCompletionsForStaff(filter: {
    status: CompletionSubmissionStatus | null;
  }): Promise<CompletionSubmission[]>;
};

export function getCompletionRepository(): CompletionRepository {
  return mockCompletionRepository;
}
