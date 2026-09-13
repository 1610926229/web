import type { ConsumptionLevel } from "@/lib/types/level";
import { mockLevelRepository } from "./mockLevelRepository";

/**
 * 消费等级配置的可替换仓储 —— **只读**。
 *
 * ⚠️ 这里**故意没有任何写入方法**：消费等级的阈值、名称与权益由管理者在未来 PC 管理后台
 * 配置，本阶段只完成用户端读取与 Mock 数据访问层。提供一个写入口，就等于顺带定下了
 * 「谁能改等级、改了之后已产生的消费怎么算」这些必须在管理端阶段确认的事。
 *
 * 读取侧返回**全部配置（含停用项）**：「是否启用、如何排序、取哪一版」都是业务规则，
 * 由 `lib/constants/levels.ts` 决定。仓储只负责把数据取出来，不替调用方筛选——
 * 否则「停用等级不参与判定」这条规则就会散落在仓储与页面两处。
 */
export type LevelRepository = {
  /** 全部等级配置，含停用项。顺序不做保证（判定前会按阈值排序）。 */
  listLevels(): Promise<ConsumptionLevel[]>;
};

export function getLevelRepository(): LevelRepository {
  return mockLevelRepository;
}
