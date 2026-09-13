import { buildConsumptionLevelSummary, sumEffectiveSpend } from "@/lib/constants/levels";
import { getLevelRepository } from "@/lib/data/levelRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { ConsumptionLevelSummary } from "@/lib/types/level";

/**
 * 消费等级服务 —— **只读**，且只读**当前登录用户自己**的数据。
 *
 * ⚠️ 本文件**没有、也不应该有**任何「写入等级」「调整累计金额」的函数：
 * 等级配置将来由管理者在 PC 管理后台维护，累计金额则永远是订单的**派生结果**，
 * 不接受任何写入。仓储侧也就没有对应的写方法。
 *
 * 两条规则：
 *
 * 1. **userId 只来自服务端会话**。接口不接受「查谁的等级」这样的参数，
 *    仓储把它当作查询条件而不是过滤项。
 * 2. **口径只在 `sumEffectiveSpend` 一处**。本文件不自己遍历订单做判断，
 *    因此消费等级页、排行榜与 `/mine` 摘要三处不可能算出不同的金额。
 */

/**
 * 取当前用户的消费等级摘要。
 *
 * 金额来自**订单快照**（`totalAmount`），与等级配置无关：即使等级配置不可用，
 * 金额也照常给出，页面因此可以「显示金额 + 说明等级配置有问题」，而不是整块空白。
 */
export async function getConsumptionLevelForUser(
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<ConsumptionLevelSummary> {
  return withMockDebug(params, surface, async () => {
    const orders = await getPaymentRepository().listOrdersByUser(userId);
    const effectiveSpendAmount = sumEffectiveSpend(orders);

    // `?mockEmpty=levels` 用于验收「无启用等级配置」：这是真实存在的异常场景
    // （管理者把所有等级都停用了），靠删数据造不出来，因此提供显式的空注入。
    const levels = mockEmptyApplies(params, "levels")
      ? []
      : await getLevelRepository().listLevels();

    return buildConsumptionLevelSummary(effectiveSpendAmount, levels);
  });
}
