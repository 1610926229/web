import { staffSeed } from "@/lib/mocks/fixtures/staffSeed";
import type { StaffAccount } from "@/lib/types/staff";
import { getMockStore } from "./mockStore";
import type { StaffRepository } from "./staffRepository";

/**
 * 客服账号的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；
 * 不写 localStorage、不写文件、不写数据库。将来由真实数据库替换
 * （`username` 唯一索引 + 密码哈希 + 会话表），本文件的删除不影响上层接口。
 *
 * 建仓语义与其它仓储一致（见 `lib/data/mockStore.ts`）：`createStore` 只执行一次，
 * 预置账号与后台新建的账号进的是**同一个 Map**，因此「新建完刷新一下就没了」
 * 这类问题不会出现。
 *
 * ⚠️ `staffStore()` 是**导出**的，理由与 `companionStore()` / `adminAuditStore()` 相同：
 * 业务写入与审计写入必须在同一段不可打断的同步区段里完成，
 * 那段伪事务在 `lib/data/adminStaffTransaction.ts`。除它以外不要从别处取这个 store。
 *
 * 并发安全的前提：Node 是单线程的，且下面「读—判断—写」的原子区段内没有 `await`。
 */

type MockStaffStore = {
  staff: Map<string, StaffAccount>;
};

function createStore(): MockStaffStore {
  return {
    // 浅拷贝一条：预置数组是 `readonly`，直接放进去会让「改一条记录」写到种子对象上
    staff: new Map(staffSeed.map((item) => [item.id, { ...item }])),
  };
}

export function staffStore(): MockStaffStore {
  return getMockStore("staff", createStore);
}

/** 大小写不敏感的登录名比较。唯一性与登录查找都必须用它。 */
function sameUsername(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 同步查同名账号（大小写不敏感）。
 *
 * ⚠️ **同步**是刻意的：唯一性校验必须发生在 `adminStaffTransaction.ts` 的原子区段
 * 里（先查重、再写入，中间不能被打断），而那段里不允许 `await`，因此用不了
 * 仓储的异步方法。仓储的 `findStaffByUsername()` 是给**登录**用的读接口，走它自己的路径。
 *
 * `exceptId` 用于「改自己的资料」：把登录名改成自己的原名不算被自己占用。
 */
export function findStaffWithUsername(
  staff: Map<string, StaffAccount>,
  username: string,
  exceptId?: string,
): StaffAccount | null {
  const value = username.trim();
  if (!value) return null;
  for (const account of staff.values()) {
    if (exceptId !== undefined && account.id === exceptId) continue;
    if (sameUsername(account.username, value)) return account;
  }
  return null;
}

// ——————————————————————————— 同步写入原语 ———————————————————————————

/**
 * 写一条新记录。**同步**，调用方必须在原子区段内使用。
 *
 * 唯一性由 `lib/services/adminStaff.ts` 在调用前校验；这里只负责落盘，
 * 与 `createCompanionRecord()` 的分工一致（仓储不做业务规则判断）。
 */
export function createStaffRecord(account: StaffAccount): StaffAccount {
  staffStore().staff.set(account.id, account);
  return account;
}

/**
 * 覆盖式更新一条记录的资料字段。记录不存在返回 null（调用方转 404）。
 *
 * ⚠️ 只接受**资料字段**：`enabled` / `removedAt` 不在这里，
 * 它们只能走 `applyStaffFlags()`。把状态混进资料更新会让「停用一下」
 * 顺手把展示名称写回旧值。
 *
 * `username` 是资料的一部分（可以改登录名），唯一性由调用方在同一个
 * 原子区段内校验——见 `lib/data/adminStaffTransaction.ts`。
 */
export function applyStaffPatch(
  id: string,
  patch: Pick<StaffAccount, "username" | "displayName" | "avatarUrl" | "updatedAt">,
): { previous: StaffAccount; updated: StaffAccount } | null {
  const store = staffStore();
  const current = store.staff.get(id);
  if (!current) return null;

  const updated: StaffAccount = { ...current, ...patch };
  store.staff.set(id, updated);
  return { previous: { ...current }, updated: { ...updated } };
}

/**
 * 只改「能不能用」的四个状态：启用 / 停用 / 移除。
 *
 * 与 `applyStaffPatch()` 分开，理由与护航那边相同：停用只是把 `enabled` 关掉，
 * 展示名称与头像一个都不该被写一遍——两位管理员同时操作时，后写的那次会把
 * 另一位刚改好的名称覆盖回旧值。
 *
 * `removedAt` 只在真正移除时写入，**永不回退**：移除是软删除，不是可以撤销的开关。
 */
export function applyStaffFlags(
  id: string,
  flags: { enabled: boolean; removedAt: string | null; updatedAt: string },
): { previous: StaffAccount; updated: StaffAccount } | null {
  const store = staffStore();
  const current = store.staff.get(id);
  if (!current) return null;

  const updated: StaffAccount = { ...current, ...flags };
  store.staff.set(id, updated);
  return { previous: { ...current }, updated: { ...updated } };
}

export const mockStaffRepository: StaffRepository = {
  async findStaffById(id) {
    return staffStore().staff.get(id) ?? null;
  },

  async findStaffByUsername(username) {
    return findStaffWithUsername(staffStore().staff, username);
  },

  async listStaff() {
    return [...staffStore().staff.values()];
  },

  async markLoggedIn(id, at) {
    // —— 原子区段开始（无 await）——
    const store = staffStore();
    const current = store.staff.get(id);
    if (!current) return null;

    const updated: StaffAccount = { ...current, lastLoginAt: at };
    store.staff.set(id, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
