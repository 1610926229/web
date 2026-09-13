import { compareComplaintsNewestFirst } from "@/lib/constants/complaints";
import { complaintSeed } from "@/lib/mocks/fixtures/complaintSeed";
import type { Complaint } from "@/lib/types/complaint";
import type { ComplaintOrderStats, ComplaintRepository } from "./complaintRepository";
import { getMockStore } from "./mockStore";

/**
 * 投诉的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置投诉与用户新提交的投诉因此进的是**同一个 Map、同一套查询方法**，
 * 「提交后立刻出现在进度列表里」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**。
 */

type MockComplaintStore = {
  complaints: Map<string, Complaint>;
  /** `${userId}:${idempotencyKey}` → 投诉 id */
  complaintIdByKey: Map<string, string>;
};

function createStore(): MockComplaintStore {
  return {
    complaints: new Map(complaintSeed.map((complaint) => [complaint.id, complaint])),
    complaintIdByKey: new Map(),
  };
}

function store(): MockComplaintStore {
  return getMockStore("complaint", createStore);
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

export const mockComplaintRepository: ComplaintRepository = {
  async queryComplaints(query) {
    const { userId, status, page, pageSize } = query;

    const filtered = [...store().complaints.values()]
      .filter((complaint) => complaint.userId === userId)
      .filter((complaint) => status === null || complaint.status === status)
      .sort(compareComplaintsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async findComplaintById(id) {
    return store().complaints.get(id) ?? null;
  },

  async findComplaintByKey(userId, idempotencyKey) {
    const id = store().complaintIdByKey.get(keyOf(userId, idempotencyKey));
    return id ? (store().complaints.get(id) ?? null) : null;
  },

  async createComplaint(complaint, idempotencyKey) {
    const current = store();
    const key = keyOf(complaint.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    const existingId = current.complaintIdByKey.get(key);
    if (existingId) {
      const existing = current.complaints.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按未创建处理，保证不会卡住提交
      if (existing) return { complaint: existing, created: false };
    }
    current.complaints.set(complaint.id, complaint);
    current.complaintIdByKey.set(key, complaint.id);
    // —— 原子区段结束 ——

    return { complaint, created: true };
  },

  async summarizeComplaintsByOrder(orderId): Promise<ComplaintOrderStats> {
    const related = [...store().complaints.values()]
      .filter((complaint) => complaint.orderId === orderId)
      .sort(compareComplaintsNewestFirst);

    return { count: related.length, latest: related[0] ?? null };
  },
};
