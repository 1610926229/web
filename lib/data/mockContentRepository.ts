import {
  announcementSeed,
  bannerSeed,
  quickEntrySeed,
} from "@/lib/mocks/fixtures/contentSeed";
import type {
  ContentAnnouncementRecord,
  ContentBannerRecord,
  QuickEntryRecord,
} from "@/lib/types/content";
import type {
  ContentAnnouncementPatch,
  ContentBannerPatch,
  ContentQuickEntryPatch,
  ContentRepository,
  ContentWriteResult,
} from "./contentRepository";
import { getMockStore } from "./mockStore";

/**
 * 首页运营内容的**进程内** Mock 存储（P8E-1 起这里成为唯一的可写运营内容）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置数据；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（唯一索引 + 软删除 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * 建仓时把预置数据**逐字段复制**进 Map，而不是把 `contentSeed` 里的对象直接放进去：
 * 后台会改这些记录，如果 Map 里存的就是模块级常量里的那个对象，一次编辑就把常量改了
 * ——测试之间互相污染，热更新后也再也回不到初始数据（与 `mockCatalogRepository` 同）。
 *
 * 并发安全的前提：Node 是单线程的，下面「读—判断—写」的**原子区段内没有 `await`**。
 * 本文件里的每个写入方法内部都没有 `await`，因此它们各自是一个原子动作；
 * 而「重放判定 + 写业务 + 写审计」这三件事合起来的原子性由
 * `lib/data/adminContentTransaction.ts` 保证。
 *
 * ⚠️ `contentStore()` 是**导出**的：后台写操作要在一段不可打断的同步区段里
 * 同时写「业务记录 + 审计」，那段伪事务在 `lib/data/adminContentTransaction.ts`。
 * 除它以外不要从别处取这个 store。
 */

type MockContentStore = {
  announcements: Map<string, ContentAnnouncementRecord>;
  banners: Map<string, ContentBannerRecord>;
  quickEntries: Map<string, QuickEntryRecord>;
};

function createStore(): MockContentStore {
  const announcements = new Map<string, ContentAnnouncementRecord>();
  for (const seed of announcementSeed) {
    announcements.set(seed.id, { ...seed });
  }

  const banners = new Map<string, ContentBannerRecord>();
  for (const seed of bannerSeed) {
    banners.set(seed.id, { ...seed });
  }

  const quickEntries = new Map<string, QuickEntryRecord>();
  for (const seed of quickEntrySeed) {
    quickEntries.set(seed.id, { ...seed });
  }

  return { announcements, banners, quickEntries };
}

export function contentStore(): MockContentStore {
  return getMockStore("content", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockContentStore {
  return contentStore();
}

/**
 * 覆盖式更新一条记录：返回改动前后的两份**副本**。
 *
 * `previous` 必须是复制出来的：如果返回 Map 里那个对象本身，调用方紧接着的一次写入
 * 会把 `previous` 一起改掉——审计快照里的 before 于是变成了 after，
 * 而「这次改了什么」正是审计唯一要回答的问题。
 */
function applyProfile<T extends { updatedAt: string; removedAt: string | null }>(
  map: Map<string, T>,
  id: string,
  patch: Record<string, unknown> & { at: string },
  fields: readonly (keyof T)[],
): ContentWriteResult<T> | null {
  const existing = map.get(id);
  if (!existing) return null;

  const previous = { ...existing };
  const next = { ...existing };

  for (const field of fields) {
    // patch 的键与记录的键一一对应，事务层已经校验过取值
    (next as Record<string, unknown>)[field as string] = (patch as Record<string, unknown>)[
      field as string
    ];
  }
  next.updatedAt = patch.at;

  map.set(id, next);
  return { previous, updated: { ...next } };
}

/**
 * 只改启用状态。
 *
 * 已经是目标状态时**原样返回**（`previous === updated` 的值相等），不刷新 `updatedAt`：
 * 「点了一次已经停用的停用按钮」不该在记录上留下一次改动痕迹——那会让后台看到
 * 「最后修改时间刚刚变过」，而实际上什么都没改。
 */
function applyEnabled<T extends { enabled: boolean; updatedAt: string }>(
  map: Map<string, T>,
  id: string,
  enabled: boolean,
  at: string,
): ContentWriteResult<T> | null {
  const existing = map.get(id);
  if (!existing) return null;

  if (existing.enabled === enabled) {
    return { previous: { ...existing }, updated: { ...existing } };
  }

  const previous = { ...existing };
  const next = { ...existing, enabled, updatedAt: at };
  map.set(id, next);
  return { previous, updated: { ...next } };
}

/** 软移除：幂等，已移除的不刷新时间戳。 */
function applyRemoved<T extends { removedAt: string | null; updatedAt: string }>(
  map: Map<string, T>,
  id: string,
  at: string,
): ContentWriteResult<T> | null {
  const existing = map.get(id);
  if (!existing) return null;

  if (existing.removedAt !== null) {
    return { previous: { ...existing }, updated: { ...existing } };
  }

  const previous = { ...existing };
  const next = { ...existing, removedAt: at, updatedAt: at };
  map.set(id, next);
  return { previous, updated: { ...next } };
}

export const mockContentRepository: ContentRepository = {
  // ——————————————————————— 图片公告 ———————————————————————

  async listAnnouncementRecords() {
    return [...store().announcements.values()].map((record) => ({ ...record }));
  },

  async findAnnouncementById(id) {
    const found = store().announcements.get(id);
    return found ? { ...found } : null;
  },

  async createAnnouncement(record) {
    store().announcements.set(record.id, { ...record });
    return { ...record };
  },

  async updateAnnouncement(id, patch: ContentAnnouncementPatch) {
    return applyProfile(store().announcements, id, patch, [
      "title",
      "imageUrl",
      "alt",
      "sortOrder",
      "enabled",
    ]);
  },

  async setAnnouncementEnabled(id, enabled, at) {
    return applyEnabled(store().announcements, id, enabled, at);
  },

  async markAnnouncementRemoved(id, at) {
    return applyRemoved(store().announcements, id, at);
  },

  // ——————————————————————— 活动 Banner ———————————————————————

  async listBannerRecords() {
    return [...store().banners.values()].map((record) => ({ ...record }));
  },

  async findBannerById(id) {
    const found = store().banners.get(id);
    return found ? { ...found } : null;
  },

  async createBanner(record) {
    store().banners.set(record.id, { ...record });
    return { ...record };
  },

  async updateBanner(id, patch: ContentBannerPatch) {
    return applyProfile(store().banners, id, patch, [
      "title",
      "imageUrl",
      "alt",
      "sortOrder",
      "enabled",
    ]);
  },

  async setBannerEnabled(id, enabled, at) {
    return applyEnabled(store().banners, id, enabled, at);
  },

  async markBannerRemoved(id, at) {
    return applyRemoved(store().banners, id, at);
  },

  // ——————————————————————— 快捷入口 ———————————————————————

  async listQuickEntryRecords() {
    return [...store().quickEntries.values()].map((record) => ({ ...record }));
  },

  async findQuickEntryById(id) {
    const found = store().quickEntries.get(id);
    return found ? { ...found } : null;
  },

  async createQuickEntry(record) {
    store().quickEntries.set(record.id, { ...record });
    return { ...record };
  },

  async updateQuickEntry(id, patch: ContentQuickEntryPatch) {
    return applyProfile(store().quickEntries, id, patch, [
      "label",
      "icon",
      "path",
      "sortOrder",
      "enabled",
    ]);
  },

  async setQuickEntryEnabled(id, enabled, at) {
    return applyEnabled(store().quickEntries, id, enabled, at);
  },

  async markQuickEntryRemoved(id, at) {
    return applyRemoved(store().quickEntries, id, at);
  },
};
