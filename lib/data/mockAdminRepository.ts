import { adminSeed } from "@/lib/mocks/fixtures/adminSeed";
import type { AdminAccount } from "@/lib/types/admin";
import type { AdminRepository } from "./adminRepository";
import { getMockStore } from "./mockStore";

/**
 * 管理端账号的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；
 * 不写 localStorage、不写文件、不写数据库。将来由真实数据库替换
 * （唯一索引 + 密码哈希 + 会话表），本文件的删除不影响上层接口。
 *
 * 与其它仓储同一套建仓语义（见 `lib/data/mockStore.ts`）：`createStore` 只执行一次，
 * 预置账号与之后写入的 `lastLoginAt` 进的是同一个 Map。
 *
 * 并发安全的前提：Node 是单线程的，且下面「读—写」的原子区段内没有 `await`。
 */

type MockAdminStore = {
  admins: Map<string, AdminAccount>;
};

function createStore(): MockAdminStore {
  return {
    admins: new Map(adminSeed.map((item) => [item.id, { ...item }])),
  };
}

function store(): MockAdminStore {
  return getMockStore("admin", createStore);
}

export const mockAdminRepository: AdminRepository = {
  async findAdminById(id) {
    return store().admins.get(id) ?? null;
  },

  async listAdmins() {
    return [...store().admins.values()];
  },

  async markLoggedIn(id, at) {
    // —— 原子区段开始（无 await）——
    const current = store().admins.get(id);
    if (!current) return null;

    const updated: AdminAccount = { ...current, lastLoginAt: at };
    store().admins.set(id, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
