import { compareStaffCompletions } from "@/lib/constants/staffCompletions";
import type {
  CompletionSubmission,
  CompletionSubmissionStatus,
} from "@/lib/types/completion";
import { getMockStore } from "./mockStore";
import type { CompletionRepository } from "./completionRepository";

/**
 * 完成材料的**进程内** Mock 存储（P0-8）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（订单唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次。
 * 完成材料**没有预置数据**：它是「打手宣布护航完成」这件事的记录，全部由运行时写入。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。真正跨实体的原子写入在
 * `lib/data/completionTransaction.ts` 的伪事务里完成，本文件只提供同步写原语。
 */

type MockCompletionStore = {
  submissions: Map<string, CompletionSubmission>;
  /** orderId → 当前 pending 的 submission id。同一订单**最多一份 pending**（单值索引） */
  pendingSubmissionIdByOrder: Map<string, string>;
};

function createStore(): MockCompletionStore {
  return {
    submissions: new Map(),
    pendingSubmissionIdByOrder: new Map(),
  };
}

function store(): MockCompletionStore {
  return getMockStore("completion", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * 与 `refundStore()` / `complaintStore()` 同一个理由：提交、审核与自动清扫的
 * 「读—判断—写」必须发生在同一段没有 `await` 的同步代码里，
 * 走 `getCompletionRepository()` 的异步方法做不到。
 */
export function completionStore(): MockCompletionStore {
  return store();
}

/**
 * 追加一条完成材料（**同步写原语**，无 `await`）。
 *
 * ⚠️ **只负责写**，不判断合不合法（订单是不是 serving、打手是不是本人、有没有别的
 * pending）——合法性由伪事务在调用它之前判定。它同时维护 pending 索引：
 * 记录与索引必须在同一条同步路径里一起变。
 */
export function appendCompletionSubmission(submission: CompletionSubmission): void {
  const current = store();
  current.submissions.set(submission.id, submission);
  if (submission.status === "pending") {
    current.pendingSubmissionIdByOrder.set(submission.orderId, submission.id);
  }
}

/**
 * 把一条完成材料写成 `approved` / `rejected`（**同步写原语**，无 `await`）。
 *
 * ⚠️ **只负责写**，不判断这次审核合不合法（状态是不是 pending、订单还在不在 serving）
 * ——合法性由伪事务在调用它之前判定。审核人三个字段直接写在这里：它们就是这次
 * 审核结果的记录，不需要单独的审计表（System 自动通过时三者都是 null / system）。
 *
 * ⚠️ 一旦离开 pending，就从 pending 索引里移除——这不是「判定合法性」，
 * 而是维护「记录状态与索引一致」：写与索引必须在同一段同步代码里完成，
 * 否则会出现「记录已 approved、索引还占着 pending 额度」的悬空状态。
 */
export function applyCompletionReview(
  id: string,
  to: Extract<CompletionSubmissionStatus, "approved" | "rejected">,
  input: {
    at: string;
    reviewSource: "staff" | "system";
    reviewedByStaffId: string | null;
    reviewedByName: string | null;
    rejectReason: string | null;
  },
): { previous: CompletionSubmission; updated: CompletionSubmission } | null {
  const current = store();
  const submission = current.submissions.get(id);
  if (!submission) return null;

  const previous = { ...submission };
  const updated: CompletionSubmission = {
    ...submission,
    status: to,
    reviewSource: input.reviewSource,
    reviewedByStaffId: input.reviewedByStaffId,
    reviewedByName: input.reviewedByName,
    // 第一次出审核结果才写时间；已经出过（例如被同一条 approved 原样重写）不刷新它——
    // 与 `applyOrderCompletion` 的 `completedAt ?? at` 同一语义。对唯一可达路径
    // （pending 的 reviewedAt 必为 null）与原来完全等价。
    reviewedAt: submission.reviewedAt ?? input.at,
    // 只有驳回才写原因；通过（人工或 System）把 pending 时的 null 原样保留
    rejectReason: to === "rejected" ? input.rejectReason : submission.rejectReason,
  };
  current.submissions.set(id, updated);

  if (current.pendingSubmissionIdByOrder.get(submission.orderId) === id) {
    current.pendingSubmissionIdByOrder.delete(submission.orderId);
  }

  return { previous, updated };
}

export const mockCompletionRepository: CompletionRepository = {
  async findCompletionById(id) {
    return store().submissions.get(id) ?? null;
  },

  async findLatestCompletionByOrderId(orderId) {
    const matches = [...store().submissions.values()]
      .filter((submission) => submission.orderId === orderId)
      .sort(compareStaffCompletions);
    return matches[0] ?? null;
  },

  async findLatestCompletionByOrderIdAndCompanionId(orderId, companionId) {
    const matches = [...store().submissions.values()]
      .filter(
        (submission) =>
          submission.orderId === orderId && submission.companionId === companionId,
      )
      .sort(compareStaffCompletions);
    return matches[0] ?? null;
  },

  async listCompletionsForStaff(filter) {
    return [...store().submissions.values()]
      .filter((submission) => filter.status === null || submission.status === filter.status)
      .sort(compareStaffCompletions);
  },
};
