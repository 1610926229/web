import {
  applicationMatchesAdminKeyword,
  compareApplicationsForAdmin,
} from "@/lib/constants/adminApplications";
import { companionApplicationSeed } from "@/lib/mocks/fixtures/companionApplicationSeed";
import type {
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import type { CompanionApplicationRepository } from "./companionApplicationRepository";
import { getMockStore } from "./mockStore";

/**
 * 护航入驻申请的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`(user_id)` 唯一索引 + 幂等键唯一索引 +
 * 事务），本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置申请与用户新提交的申请因此进的是**同一个 Map、同一套查询方法**，
 * 「提交后刷新页面仍然看得到」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，下面「读—判断—写」的**原子区段内没有 `await`**。
 */

type MockCompanionApplicationStore = {
  applications: Map<string, CompanionApplication>;
  /** `${userId}` → 申请 id：**一个人最多一条**这条规则的落点 */
  applicationIdByUser: Map<string, string>;
  /** `${userId}:${idempotencyKey}` → 申请 id */
  applicationIdByKey: Map<string, string>;
};

function createStore(): MockCompanionApplicationStore {
  return {
    applications: new Map(companionApplicationSeed.map((item) => [item.id, item])),
    applicationIdByUser: new Map(
      companionApplicationSeed.map((item) => [item.userId, item.id]),
    ),
    applicationIdByKey: new Map(),
  };
}

/**
 * ⚠️ `companionApplicationStore()` 是**导出**的，理由与 `companionStore()` 相同：
 * 审核通过要在一段不可打断的同步区段里同时写「申请 + 资格 + 护航 + 审计」，
 * 那段伪事务（`lib/data/adminCompanionTransaction.ts`）需要直接拿到这份申请记录。
 * 除它以外不要从别处取这个 store。
 */
export function companionApplicationStore(): MockCompanionApplicationStore {
  return getMockStore("companionApplication", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockCompanionApplicationStore {
  return companionApplicationStore();
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

export const mockCompanionApplicationRepository: CompanionApplicationRepository = {
  async findApplicationByUser(userId) {
    const id = store().applicationIdByUser.get(userId);
    return id ? (store().applications.get(id) ?? null) : null;
  },

  async findApplicationById(id) {
    return store().applications.get(id) ?? null;
  },

  async countApplicationsByStatus() {
    // 一次遍历同时统计全部状态：概览要的是七个数字，不是七次扫描
    const counts: Record<CompanionApplicationStatus, number> = {
      pending: 0,
      reviewing: 0,
      approved: 0,
      rejected: 0,
      withdrawn: 0,
    };

    for (const application of store().applications.values()) {
      counts[application.status] += 1;
    }

    return counts;
  },

  async queryApplicationsForAdmin(filter) {
    const { status, keyword, gameId } = filter;

    return [...store().applications.values()]
      .filter((application) => !status || application.status === status)
      .filter((application) => !gameId || application.gameIds.includes(gameId))
      .filter((application) => applicationMatchesAdminKeyword(application, keyword))
      // 默认排序：提交时间倒序，相等时按 id 兜底——顺序不确定时分页会出现
      // 同一条在两页里各出现一次
      .sort(compareApplicationsForAdmin)
      .map((application) => ({ ...application }));
  },

  async findApplicationByKey(userId, idempotencyKey) {
    const id = store().applicationIdByKey.get(keyOf(userId, idempotencyKey));
    return id ? (store().applications.get(id) ?? null) : null;
  },

  async createApplication(application, idempotencyKey) {
    const current = store();
    const key = keyOf(application.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // ① 幂等键：同一次提交意图重复到达时返回上一次的结果
    const existingByKeyId = current.applicationIdByKey.get(key);
    if (existingByKeyId) {
      const existing = current.applications.get(existingByKeyId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按「没创建过」继续往下走，
      // 保证不会把用户卡在提交失败上
      if (existing) return { kind: "idempotent", application: existing };
    }

    // ② 一个人最多一条：换一个幂等键再提交也写不进第二条
    const existingByUserId = current.applicationIdByUser.get(application.userId);
    if (existingByUserId) {
      const existing = current.applications.get(existingByUserId);
      if (existing) return { kind: "already-applied", application: existing };
    }

    current.applications.set(application.id, application);
    current.applicationIdByUser.set(application.userId, application.id);
    current.applicationIdByKey.set(key, application.id);
    // —— 原子区段结束 ——

    return { kind: "created", application };
  },

  async withdrawApplication(id, at) {
    const current = store();

    // —— 原子区段开始（无 await）——
    const existing = current.applications.get(id);
    if (!existing) return null;

    // 已经是「已撤销」：重复撤销返回同一条记录，不产生第二次变更
    if (existing.status === "withdrawn") return { application: existing, withdrawn: false };
    // 只有「待查看」可以撤销
    if (existing.status !== "pending") return null;

    const updated: CompanionApplication = {
      ...existing,
      status: "withdrawn",
      updatedAt: at,
      // 撤销不会产生审核时间与审核备注
      reviewedAt: null,
      reviewNote: "",
    };
    current.applications.set(id, updated);
    // —— 原子区段结束 ——

    return { application: updated, withdrawn: true };
  },
};

// ——————————————————————————— 同步写入器 ———————————————————————————

/**
 * 审核状态迁移的**同步**实现。仓储方法没有对应的 `async` 包装，因为这条路径
 * **只能**由那段伪事务调用（`lib/data/adminCompanionTransaction.ts`）——
 * 它必须和「护航 + 资格 + 审计」写在同一个不可打断的区段里。
 *
 * ⚠️ 这里**只负责写**：合法迁移由调用方用 `canTransitionCompanionApplication()`
 * 判定。函数本身再挡一次「不合法的目标状态」，是为了让「绕过判定直接写」也不可能
 * 写进一个非法状态——传入的目标状态不是三种审核结果时直接返回 `null`。
 */
export function applyApplicationReview(
  id: string,
  to: CompanionApplicationStatus,
  input: { at: string; reviewNote: string },
): { previous: CompanionApplication; updated: CompanionApplication } | null {
  if (to !== "reviewing" && to !== "approved" && to !== "rejected") return null;

  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.applications.get(id);
  if (!existing) return null;

  const reviewed = to === "approved" || to === "rejected";

  const updated: CompanionApplication = {
    ...existing,
    status: to,
    updatedAt: input.at,
    // 「开始审核」不是结果：它既不写审核时间，也不写审核意见
    reviewedAt: reviewed ? input.at : existing.reviewedAt,
    reviewNote: reviewed ? input.reviewNote : existing.reviewNote,
  };
  current.applications.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}
