import { buildBossStatsSummary } from "@/lib/constants/bossStats";
import { getCompanionServiceRepository } from "@/lib/data/companionServiceRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import type { BossStatsSummary } from "@/lib/types/bossStats";

/**
 * 老板数据面板服务 —— **只读**，且只读**当前登录用户自己**的数据（P1-7）。
 *
 * ⚠️ 本文件**没有、也不应该有**任何写入函数：五个指标全部是订单与服务历史的
 * **派生结果**，不接受任何写入。仓储侧也就没有对应的写方法。
 *
 * 两条规则：
 *
 * 1. **userId 只来自服务端会话**。接口不接受「查谁的数据」这样的参数，
 *    仓储把它当作查询条件而不是过滤项——因此不存在「用别人的 id 看别人数据」的入口。
 * 2. **口径只在 `lib/constants/bossStats.ts` 一处**。本文件只负责取数与注入时间，
 *    不自己遍历订单做统计。
 */

/**
 * 取当前用户的老板数据摘要。
 *
 * ## 服务历史为什么要合并两个来源
 *
 * - `listServiceEvents()`：**真的发生过、真的被记下来的**服务（P1-7 起由
 *   `companionOrderTransaction.startCompanionOrder` 写入）；
 * - `listLegacyServiceEvents()`：**存量数据里仍然可考据的那一次**——由订单当前/最终的
 *   `servingAt` + `actualCompanionId` 派生。P1-7 之前没有任何地方记过服务历史，
 *   没有它，面板在预置数据上就是空的。
 *
 * 两者的并集是**下界**（产品裁定 `D10`）：换人之后旧打手的那次服务在存量数据里
 * 已经不可考，**不猜、不 backfill**。合并与去重由 `buildCompanionUsage` 负责，
 * 这里只负责把两个来源取齐。
 *
 * ⚠️ `listServiceEvents()` 返回**全部用户**的事件，收窄发生在
 * `buildCompanionUsage` 里（它按当前用户的订单 id 过滤）——本文件**不得**把
 * 「事件本来就不多」当成不收窄的理由。
 */
export async function getBossStatsForUser(
  userId: string,
  /** 注入「现在」，让最近 30 天的时间窗可测（跨零点跑出不同结果是真实风险） */
  now: Date = new Date(),
): Promise<BossStatsSummary> {
  const orders = await getPaymentRepository().listOrdersByUser(userId);
  const serviceRepository = getCompanionServiceRepository();
  const events = [
    ...(await serviceRepository.listServiceEvents()),
    ...(await serviceRepository.listLegacyServiceEvents()),
  ];

  return buildBossStatsSummary(orders, events, now);
}
