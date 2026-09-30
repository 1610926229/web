import type { PlatformConfig } from "@/lib/types/platformConfig";
import { mockPlatformConfigRepository } from "./mockPlatformConfigRepository";

/**
 * 平台级参数的可替换仓储（P0-1）。
 *
 * ## 为什么只有一个读方法
 *
 * 平台参数的写入**必须**与审计写入同生共死（「谁在什么时候把公共池超时改成了几分钟」
 * 是这类参数唯一的事后依据），因此写入入口只有一处：
 * `lib/data/adminPlatformConfigTransaction.ts` 的伪事务。它拿的是
 * `mockPlatformConfigRepository` 的同步写原语（`writePlatformConfig`），
 * **不是**本接口——本接口是给业务读的。
 *
 * 于是这里出现一个刻意的**不对称**：读走接口、写走事务。
 * 若在这里加一个 `updateConfig()`，就等于开出了第二条写入路径——
 * 那条路径没有幂等判定、没有审计，而且它与伪事务的差别
 * 只在「有人绕过服务层直接调仓储」时才会暴露。
 *
 * ⚠️ 与审计表的分工见 `lib/types/platformConfig.ts`：仓储不判断
 * 「这个值合不合法」——那是 `lib/constants/platformConfig.ts` 的规则，
 * 由服务层与事务层调用。
 */
export type PlatformConfigRepository = {
  /**
   * 当前生效的平台参数。
   *
   * 返回的是**副本**：调用方改它不会影响存储。
   *
   * ⚠️ 这个值是「现在新发生的业务按什么规则走」，**不是**「某一张在途订单按什么规则走」。
   * 后者看订单自己身上的快照字段（见 `lib/types/platformConfig.ts` 的说明）。
   */
  getConfig(): Promise<PlatformConfig>;
};

/** 一次平台参数写入的返回：改动前后的配置（与本仓其它模块的写入结果同形）。 */
export type PlatformConfigWriteResult = { previous: PlatformConfig; updated: PlatformConfig };

export function getPlatformConfigRepository(): PlatformConfigRepository {
  return mockPlatformConfigRepository;
}
