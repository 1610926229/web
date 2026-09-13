import { compareSuggestionsNewestFirst } from "@/lib/constants/suggestions";
import { suggestionSeed } from "@/lib/mocks/fixtures/suggestionSeed";
import type { Suggestion } from "@/lib/types/suggestion";
import { getMockStore } from "./mockStore";
import type { CreateSuggestionOutcome, SuggestionRepository } from "./suggestionRepository";

/**
 * 意见反馈的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（「用户 + 幂等键」唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置反馈与用户新提交的反馈因此进的是**同一个 Map、同一套查询方法**，
 * 「刚提交的反馈立刻出现在列表里」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 */

type MockSuggestionStore = {
  suggestions: Map<string, Suggestion>;
  /** `${userId}:${idempotencyKey}` → 反馈 id */
  suggestionIdByKey: Map<string, string>;
};

function idempotencyKeyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

function createStore(): MockSuggestionStore {
  const suggestions = new Map<string, Suggestion>();

  for (const suggestion of suggestionSeed) {
    // 预置数据的 id 重复在种子里就会暴露出来，不必等到「提交完看不见自己那条」
    if (suggestions.has(suggestion.id)) {
      throw new Error(`预置反馈数据出现重复 id：${suggestion.id}`);
    }
    suggestions.set(suggestion.id, suggestion);
  }

  return { suggestions, suggestionIdByKey: new Map() };
}

function store(): MockSuggestionStore {
  return getMockStore("suggestion", createStore);
}

export const mockSuggestionRepository: SuggestionRepository = {
  async querySuggestions(query) {
    const { userId, page, pageSize } = query;

    const filtered = [...store().suggestions.values()]
      .filter((suggestion) => suggestion.userId === userId)
      .sort(compareSuggestionsNewestFirst);

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

  async findSuggestionByKey(userId, idempotencyKey) {
    const id = store().suggestionIdByKey.get(idempotencyKeyOf(userId, idempotencyKey));
    return id ? (store().suggestions.get(id) ?? null) : null;
  },

  async createSuggestion(suggestion, idempotencyKey): Promise<CreateSuggestionOutcome> {
    const current = store();
    const key = idempotencyKeyOf(suggestion.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    const existingId = current.suggestionIdByKey.get(key);
    if (existingId) {
      const existing = current.suggestions.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按未创建处理，保证不会卡住提交
      if (existing) return { suggestion: existing, created: false };
    }

    current.suggestions.set(suggestion.id, suggestion);
    current.suggestionIdByKey.set(key, suggestion.id);
    // —— 原子区段结束 ——

    return { suggestion, created: true };
  },
};
