import { compareTipsNewestFirst, countTipStatuses } from "@/lib/constants/tips";
import { tipSeed } from "@/lib/mocks/fixtures/tipSeed";
import type { TipRecord } from "@/lib/types/tip";
import { getMockStore } from "./mockStore";
import type { TipRepository } from "./tipRepository";

/**
 * 鸡腿记录的**进程内** Mock 存储 —— 只读。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置记录；
 * 不写 localStorage、不写文件、不写数据库。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`。本仓储没有任何写入方法
 * （原因见 `lib/data/tipRepository.ts`），因此不存在「预置数据被冲掉」这类问题。
 */

type MockTipStore = {
  tips: Map<string, TipRecord>;
};

function createStore(): MockTipStore {
  const tips = new Map(tipSeed.map((tip) => [tip.id, tip]));
  if (tips.size !== tipSeed.length) {
    throw new Error("预置鸡腿记录存在重复 id");
  }
  return { tips };
}

function store(): MockTipStore {
  return getMockStore("tip", createStore);
}

export const mockTipRepository: TipRepository = {
  async queryTips({ userId, status, page, pageSize }) {
    const filtered = [...store().tips.values()]
      .filter((tip) => tip.userId === userId)
      .filter((tip) => status === "all" || tip.paymentStatus === status)
      .sort(compareTipsNewestFirst);

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

  async countTipsByStatus(userId) {
    // 统计规则只有一处实现（`countTipStatuses`），仓储与列表不会各算一套
    return countTipStatuses([...store().tips.values()].filter((tip) => tip.userId === userId));
  },
};
