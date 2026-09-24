import type {
  QualificationRepository,
  UserQualificationRecord,
  UserQualificationRole,
} from "./qualificationRepository";
import { getMockStore } from "./mockStore";

/**
 * 用户资格的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`(user_id, role)` 唯一索引），
 * 本文件的删除不影响上层接口。
 *
 * **建仓时是空的**，这一点和别的仓储不一样：资格只是**审计历史**，不是运行时的判据
 * （判据是「用户名下有没有有效护航资料」，见 `lib/services/companionAccess.ts`）。
 * 因此不给它预置数据：凭空造一条资格，就会出现一个「有护航资格但查不到对应护航资料」
 * 的用户，那种数据在后台是解释不清的。
 *
 * ⚠️ 预置陪玩里已经**有**关联用户的记录（`cp-10` / `cp-11` → `u-1022` / `u-1023`，
 * DEV-1 为验收链路新增）。它们靠护航资料本身取得资格，**不**依赖本仓储有记录——
 * 这正是「本仓储为空也不影响资格判定」的活证据。
 *
 * 并发安全的前提：Node 是单线程的，而写入发生在 `lib/data/adminCompanionTransaction.ts`
 * 那段**没有 `await` 的同步区段**里。
 *
 * ⚠️ `qualificationStore()` 是**导出**的，理由与 `companionStore()` 相同：
 * 审核通过要在一段不可打断的区段里同时写四样东西，除那段伪事务外不要从别处取它。
 */

type MockQualificationStore = {
  /** `${userId}:${role}` → 资格记录 */
  qualifications: Map<string, UserQualificationRecord>;
};

function createStore(): MockQualificationStore {
  return { qualifications: new Map() };
}

export function qualificationStore(): MockQualificationStore {
  return getMockStore("qualification", createStore);
}

function keyOf(userId: string, role: UserQualificationRole): string {
  return `${userId}:${role}`;
}

// ——————————————————————————— 同步写入器 ———————————————————————————

/**
 * 同步读取：这位用户有没有这条资格。
 *
 * 给伪事务用的——「发放了没有」必须在**写入之前**问清楚，才能把它写进审计的
 * `before` / `after`（重复审核通过时第二次是「本来就有」，不是「刚发放」）。
 */
export function findQualificationRecord(
  userId: string,
  role: UserQualificationRole,
): UserQualificationRecord | null {
  return qualificationStore().qualifications.get(keyOf(userId, role)) ?? null;
}

/**
 * 发放资格。**同步**，且天然幂等：同一个 `(userId, role)` 只有第一次会写进去。
 *
 * 返回 `created` 而不是抛错：重复审核通过时第二次走到这里，应当安静地返回
 * 「本来就有」——那一次的成功与第一次是同一件事，不该报错。
 *
 * ⚠️ 只由 `lib/data/adminCompanionTransaction.ts` 调用（与护航、申请状态、审计
 * 写在同一个不可打断的区段里），因此这里没有对应的 `async` 仓储方法。
 */
export function grantQualificationRecord(record: UserQualificationRecord): { created: boolean } {
  const store = qualificationStore();
  const key = keyOf(record.userId, record.role);

  if (store.qualifications.has(key)) return { created: false };

  store.qualifications.set(key, record);
  return { created: true };
}

export const mockQualificationRepository: QualificationRepository = {
  async findQualification(userId, role) {
    return qualificationStore().qualifications.get(keyOf(userId, role)) ?? null;
  },

  async listQualificationsByUser(userId) {
    return [...qualificationStore().qualifications.values()].filter(
      (qualification) => qualification.userId === userId,
    );
  },

  async listQualifications() {
    return [...qualificationStore().qualifications.values()];
  },
};
