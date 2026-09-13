import { levelSeed } from "@/lib/mocks/fixtures/levelSeed";
import type { ConsumptionLevel } from "@/lib/types/level";
import { getMockStore } from "./mockStore";
import type { LevelRepository } from "./levelRepository";

/**
 * 消费等级配置的**进程内** Mock 存储 —— 只读。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置配置；
 * 不写 localStorage、不写文件、不写数据库。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`。本仓储没有任何写入方法
 * （原因见 `lib/data/levelRepository.ts`），因此不存在「预置配置被改掉」这类问题。
 *
 * 建仓时**逐字段复制**并深拷贝权益数组：判定逻辑不会拿到种子对象的引用，
 * 也就不会出现「某次改动把模块级常量改了」。
 */

type MockLevelStore = {
  levels: Map<string, ConsumptionLevel>;
};

function cloneLevel(level: ConsumptionLevel): ConsumptionLevel {
  return {
    ...level,
    privileges: level.privileges.map((privilege) => ({ ...privilege })),
  };
}

function createStore(): MockLevelStore {
  const levels = new Map<string, ConsumptionLevel>(
    levelSeed.map((level) => [level.id, cloneLevel(level)]),
  );
  if (levels.size !== levelSeed.length) {
    throw new Error("预置消费等级存在重复 id");
  }
  return { levels };
}

function store(): MockLevelStore {
  return getMockStore("level", createStore);
}

export const mockLevelRepository: LevelRepository = {
  async listLevels() {
    return [...store().levels.values()].map(cloneLevel);
  },
};
