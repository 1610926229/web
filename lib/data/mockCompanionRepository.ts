import {
  companionMatchesKeyword,
  compareCompanionsForList,
  isCompanionListed,
} from "@/lib/constants/companions";
import { companionSeed } from "@/lib/mocks/fixtures/seed";
import type { Companion } from "@/lib/types/companion";
import type {
  CompanionCreateOutcome,
  CompanionProfilePatch,
  CompanionRepository,
} from "./companionRepository";
import { getMockStore } from "./mockStore";

/**
 * 护航名单的**进程内** Mock 存储（P8A 起这里成为唯一的可写名单）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（`(user_id)` 唯一索引 + 软删除 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * 建仓时把预置陪玩**逐字段复制**进 Map（连 `reviews` 数组也复制一层），
 * 而不是把 `companionSeed` 里的对象直接放进去：后台会改这些记录，
 * 如果 Map 里存的就是模块级常量里的那个对象，一次编辑就把常量改了——
 * 测试之间互相污染，热更新后也再也回不到初始数据。
 *
 * 并发安全的前提：Node 是单线程的，下面「读—判断—写」的**原子区段内没有 `await`**。
 *
 * ⚠️ `companionStore()` 是**导出**的：审核通过与后台编辑要在一段不可打断的同步区段里
 * 同时写「护航 + 申请 + 资格 + 审计」，那段伪事务在 `lib/data/adminCompanionTransaction.ts`。
 * 除它以外不要从别处取这个 store。
 */

type MockCompanionStore = {
  companions: Map<string, Companion>;
  /**
   * `${userId}` → 护航 id，**只登记未移除的记录**。
   *
   * 「一名用户最多关联一条有效护航」这条规则的落点。移除后索引要删掉，
   * 否则这位用户再被审核通过时会被自己的历史记录挡住。
   */
  companionIdByUser: Map<string, string>;
};

function createStore(): MockCompanionStore {
  const companions = new Map<string, Companion>();

  for (const seed of companionSeed) {
    companions.set(seed.id, { ...seed, reviews: [...seed.reviews] });
  }

  const companionIdByUser = new Map<string, string>();
  for (const companion of companions.values()) {
    // 预置数据里这两项都是 null（见 companionSeed 的说明），因此这条循环当前不会登记任何东西；
    // 保留它，是为了「将来种子补一条带 userId 的记录」时索引自动跟上，而不是静默漏掉。
    if (companion.userId && companion.removedAt === null) {
      companionIdByUser.set(companion.userId, companion.id);
    }
  }

  return { companions, companionIdByUser };
}

export function companionStore(): MockCompanionStore {
  return getMockStore("companion", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockCompanionStore {
  return companionStore();
}

/**
 * 按 id **同步**读取一条护航资料（只读，返回副本）。
 *
 * ⚠️ 存在的理由只有一个：**伪事务的原子区段里不能有 `await`**，走不了本仓储的
 * 异步方法。接单事务要在「写下去之前」的最后一步确认这位打手的资料还在架
 * （`lib/data/companionDispatchTransaction.ts`）——少了这一步，一位刚好被管理员
 * 下架的打手仍能把单接走，而他随后既看不到订单也提交不了材料。
 *
 * ⚠️ 因此本函数**不对外提供 store 本身**：调用方只能取走一条记录的副本，
 * 拿不到 `Map` 就没有「顺手改一下」的位置。写入仍然只有审核通过与后台管理
 * 那两处伪事务。
 */
export function readCompanionRecord(id: string): Companion | null {
  const record = store().companions.get(id);
  return record ? { ...record, reviews: [...record.reviews] } : null;
}

export const mockCompanionRepository: CompanionRepository = {
  async listCompanions() {
    // 复制一层再返回：调用方拿到的是快照，后续的后台编辑不会影响正在聚合的这一次
    return [...store().companions.values()].map((companion) => ({ ...companion }));
  },

  async findCompanionById(id) {
    const found = store().companions.get(id);
    return found ? { ...found } : null;
  },

  async findCompanionByUser(userId) {
    const id = store().companionIdByUser.get(userId);
    if (!id) return null;
    const found = store().companions.get(id) ?? null;
    return found ? { ...found } : null;
  },

  async queryCompanions(query) {
    const { keyword, gameId, availability } = query;

    const filtered = [...store().companions.values()]
      // 公开列表口径：下架与已移除都不出现。判定与详情 DTO、结算校验共用同一个函数
      .filter(isCompanionListed)
      .filter((companion) => !gameId || companion.gameIds.includes(gameId))
      .filter((companion) => {
        if (availability === "all") return true;
        return availability === "available" ? companion.available : !companion.available;
      })
      .filter((companion) => companionMatchesKeyword(companion, keyword))
      // 排序权重 + id 兜底：顺序不确定时分页会出现同一条在两页里各出现一次
      .sort(compareCompanionsForList);

    return filtered.map((companion) => ({ ...companion }));
  },

  async queryCompanionsForAdmin(query) {
    const { keyword, gameId, enabled, availability, removal } = query;

    return [...store().companions.values()]
      .filter((companion) =>
        removal === "removed" ? companion.removedAt !== null : companion.removedAt === null,
      )
      .filter((companion) => {
        if (enabled === "") return true;
        return enabled === "enabled" ? companion.enabled : !companion.enabled;
      })
      .filter((companion) => {
        if (availability === "") return true;
        if (availability === "available") return companion.available;
        return !companion.available;
      })
      .filter((companion) => !gameId || companion.gameIds.includes(gameId))
      .filter((companion) => companionMatchesKeyword(companion, keyword))
      .sort(compareCompanionsForList)
      .map((companion) => ({ ...companion }));
  },

  async listCompanionsForAdmin() {
    return [...store().companions.values()]
      .sort(compareCompanionsForList)
      .map((companion) => ({ ...companion }));
  },

  async createCompanion(companion) {
    return createCompanionRecord(companion);
  },

  async updateCompanion(id, patch) {
    return applyCompanionPatch(id, patch);
  },

  async markCompanionRemoved(id, at) {
    return applyCompanionRemoval(id, at);
  },
};

// ——————————————————————————— 同步写入器 ———————————————————————————

/**
 * 下面三个函数是**同步**的，并且是这一份名单唯一的写入实现。
 *
 * 为什么要把写入抽成同步函数：审核通过要在一段**没有 `await`** 的区段里
 * 同时写「申请 + 资格 + 护航 + 审计」（§七）。如果那段伪事务直接操作 Map，
 * 它就得自己维护 `companionIdByUser` 这个索引——而索引是这份存储的内部约定，
 * 一旦有两处维护，迟早出现「记录建了、索引没建」这种查不出来的脏数据。
 *
 * 因此：仓储方法只是把它们包成 `async`（对外接口不变），
 * 伪事务（`lib/data/adminCompanionTransaction.ts`）直接调用同步版本。
 * 两者共用同一份实现，行为不可能分叉。
 */

/**
 * 创建一条护航，或返回这位用户**已有的**那一条。
 *
 * `already-linked` 就是「一名用户最多一条有效护航」这条规则生效的返回：
 * 重复审核通过只会在第一次建出记录，后面每次都被索引挡回来。
 */
export function createCompanionRecord(companion: Companion): CompanionCreateOutcome {
  const current = store();

  // —— 原子区段开始（无 await）——
  if (companion.userId) {
    const existingId = current.companionIdByUser.get(companion.userId);
    if (existingId) {
      const existing = current.companions.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按「没创建过」继续往下走，
      // 免得把这个人卡在「有护航但查不到」的死角里
      if (existing) return { kind: "already-linked", companion: { ...existing } };
    }
  }

  current.companions.set(companion.id, { ...companion, reviews: [...companion.reviews] });
  if (companion.userId && companion.removedAt === null) {
    current.companionIdByUser.set(companion.userId, companion.id);
  }
  // —— 原子区段结束 ——

  return { kind: "created", companion: { ...companion } };
}

/**
 * 编辑资料。
 *
 * ⚠️ 只覆盖 `patch` 里那些字段：统计、关联用户、来源申请、评价一律原样保留。
 * `userId` / `applicationId` / `removedAt` 不在 `CompanionProfilePatch` 里，
 * 因此「顺手改一下关联用户」在这里没有位置可写——§八 的白名单在类型上就成立了。
 */
export function applyCompanionPatch(
  id: string,
  patch: CompanionProfilePatch,
): { previous: Companion; updated: Companion } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.companions.get(id);
  if (!existing) return null;

  const updated: Companion = { ...existing, ...patch };
  current.companions.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

/**
 * 只改「能不能接单」这三个字段（暂停 / 恢复 / 启用 / 停用走同一条路径）。
 *
 * ⚠️ 单独开一个窄写入器，而不是复用 `applyCompanionPatch()`：
 * 后台的「暂停接单」按钮只应当改这三个字段，**绝不能**顺带把昵称、介绍、排序
 * 一起写回去——那需要调用方先把整条记录读出来再拼一个完整 patch，
 * 而那份读取发生在原子区段之外，两位管理员同时操作时后写入的那次
 * 会把另一位刚改好的昵称覆盖回旧值。窄写入器让这种覆盖在结构上不可能发生。
 */
export function applyCompanionFlags(
  id: string,
  flags: { enabled: boolean; available: boolean; unavailableReason: string },
): { previous: Companion; updated: Companion } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.companions.get(id);
  if (!existing) return null;

  const updated: Companion = { ...existing, ...flags };
  current.companions.set(id, updated);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}

/**
 * 软移除。**不删除记录**：历史订单、评价与鸡腿记录都要继续指得到它。
 *
 * 已经移除时原样返回（`previous === updated`）且**不刷新时间戳**：
 * 重复移除不产生第二次变更，因此调用方据此就不该写第二条审计。
 */
export function applyCompanionRemoval(
  id: string,
  at: string,
): { previous: Companion; updated: Companion } | null {
  const current = store();

  // —— 原子区段开始（无 await）——
  const existing = current.companions.get(id);
  if (!existing) return null;

  if (existing.removedAt !== null) {
    return { previous: { ...existing }, updated: { ...existing } };
  }

  const updated: Companion = { ...existing, removedAt: at };
  current.companions.set(id, updated);
  // 移除后不再占用「一名用户一条有效护航」的名额
  if (updated.userId) current.companionIdByUser.delete(updated.userId);
  // —— 原子区段结束 ——

  return { previous: { ...existing }, updated: { ...updated } };
}
