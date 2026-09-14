import { compareComplaintsForAdmin } from "@/lib/constants/adminComplaints";
import { compareComplaintsNewestFirst } from "@/lib/constants/complaints";
import { complaintSeed } from "@/lib/mocks/fixtures/complaintSeed";
import type { ActorRole } from "@/lib/types/actor";
import type { Complaint, ComplaintStatus } from "@/lib/types/complaint";
import type {
  AdminComplaintQueryFilter,
  ComplaintOrderStats,
  ComplaintRepository,
} from "./complaintRepository";
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

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * 与 `refundStore()` 同一个理由：管理端处理投诉的「读—判断—写」必须发生在
 * 同一段没有 `await` 的同步代码里，走 `getComplaintRepository()` 的异步方法做不到。
 */
export function complaintStore(): MockComplaintStore {
  return store();
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

  async queryComplaintsForAdmin(filter: AdminComplaintQueryFilter) {
    return [...store().complaints.values()]
      .filter((complaint) => filter.status === null || complaint.status === filter.status)
      .filter((complaint) => filter.type === null || complaint.typeKey === filter.type)
      .sort(compareComplaintsForAdmin);
  },
};

/**
 * 处理动作的**同步写入器**（无 `await`）。
 *
 * ⚠️ 与 `applyRefundReview` 同一套路：**只负责写**，不判断这次迁移合不合法。
 *
 * ⚠️ P8D-2 起管理端与客服端共用这一个写入器（调用方是
 * `adminComplaintTransaction` 的原子区段）。因此「处理人」不再是「管理员」，
 * 而是由 `input` 带进来的 `actorId` / `actorRole` / `actorName` 三样——
 * 三个字段必须一起写，只写 id 会让读的人不知道去哪张表查这个名字。
 *
 * 三个目标状态各写各的字段：
 * - `processing`：只写 `processingAt`。**不写处理人与结果**——「有人开始看了」还没有结论；
 * - `resolved` / `closed`：写 `handledAt`、处理人三件套与传入的结论文本。
 *
 * ⚠️ `description`、`evidence`、`contact`、`orderId`、`userId`、`complaintNo` **一个都不碰**：
 * 前三个是**用户提交的原始材料**，平台侧不可覆盖（§投诉处理）。这不是「暂时没做」，
 * 而是这个方法里根本没有写它们的语句——多传一个字段进来也不会生效。
 * 客服身份的加入没有改变这一点：客服能看到正文，但同样改不了（没有写它的参数）。
 *
 * ⚠️ 又是**同步**的：它只在 `adminComplaintTransaction` 的原子区段里被调用。
 */
export function applyComplaintStatus(
  id: string,
  to: Extract<ComplaintStatus, "processing" | "resolved" | "closed">,
  input: {
    at: string;
    result: string;
    actorId: string;
    actorRole: ActorRole;
    actorName: string | null;
  },
): { previous: Complaint; updated: Complaint } | null {
  const current = store();
  const complaint = current.complaints.get(id);
  if (!complaint) return null;

  const previous = { ...complaint };
  const settled = to === "resolved" || to === "closed";

  const updated: Complaint = {
    ...complaint,
    status: to,
    updatedAt: input.at,
    processingAt: to === "processing" ? input.at : complaint.processingAt,
    handledAt: settled ? input.at : complaint.handledAt,
    handledById: settled ? input.actorId : complaint.handledById,
    handledByRole: settled ? input.actorRole : complaint.handledByRole,
    handledByName: settled ? input.actorName : complaint.handledByName,
    result: settled ? input.result : complaint.result,
  };
  current.complaints.set(id, updated);

  return { previous, updated };
}
