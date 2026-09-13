import { userSeed } from "@/lib/mocks/fixtures/seed";
import { getMockStore } from "./mockStore";
import type { UserProfilePatch, UserRecord, UserRepository } from "./userRepository";

/**
 * 用户资料的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换，本文件的删除不影响上层接口。
 *
 * 建仓时把预置用户**逐字段复制**进 Map，而不是直接把 seed 里的对象放进去：
 * 编辑资料会改对象，如果 Map 里存的就是 `userSeed` 里的那个对象，一次修改就把
 * 模块级常量改了——测试之间会互相污染，热更新后也再也回不到初始数据。
 *
 * 建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 因此用户在页面上改的资料与预置数据进的是**同一个 Map、同一套查询方法**，
 * 同一个服务器进程内刷新页面修改仍然存在。
 */

type MockUserStore = {
  users: Map<string, UserRecord>;
};

function createStore(): MockUserStore {
  const users = new Map<string, UserRecord>();

  for (const seed of userSeed) {
    users.set(seed.id, {
      id: seed.id,
      displayId: seed.displayId,
      nickname: seed.nickname,
      avatarUrl: seed.avatarUrl,
      bio: seed.bio,
    });
  }

  return { users };
}

function store(): MockUserStore {
  return getMockStore("user", createStore);
}

export const mockUserRepository: UserRepository = {
  async findUserById(id) {
    return store().users.get(id) ?? null;
  },

  async updateProfile(id, patch: UserProfilePatch): Promise<UserRecord | null> {
    const current = store();

    // —— 原子区段开始（无 await）——
    const existing = current.users.get(id);
    if (!existing) return null;

    // 展开既有记录后只覆盖三个字段：id / displayId 原样保留
    const updated: UserRecord = {
      ...existing,
      nickname: patch.nickname,
      avatarUrl: patch.avatarUrl,
      bio: patch.bio,
    };
    current.users.set(id, updated);
    // —— 原子区段结束 ——

    return updated;
  },
};
