import { ApiError } from "@/lib/api/ApiError";
import { parseTipListQuery, toTipListItem } from "@/lib/constants/tips";
import { getTipRepository } from "@/lib/data/tipRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { TipPage } from "@/lib/types/tip";

/**
 * 鸡腿记录服务 —— **只读**。
 *
 * ⚠️ 本文件**没有、也不应该有**「送鸡腿 / 创建鸡腿记录」的函数：
 *
 * - 鸡腿的价格、兑换比例、支付方式与打手结算规则都还没有确认。提前提供一个写入口，
 *   就等于顺带定下了价格与结算口径，那是必须先与业务确认、而不是由代码决定的事。
 * - 因此这里也不会调用 P4 的支付链路，不会产生 `PaymentRequest`、订单或鸡腿记录。
 *
 * 两条读取规则：
 *
 * 1. **只读当前用户的数据**。`userId` 来自服务端会话，接口不接受任何「查谁的记录」参数，
 *    仓储把它当作查询条件而不是过滤项。
 * 2. **只返回原始记录值**。DTO 由 `toTipListItem` 显式挑字段，里面没有单价、比例、
 *    平台抽成与打手到手金额——将来即便实体上多出这些字段，也不会自动出现在接口响应里。
 */

/**
 * 查询当前用户的鸡腿记录。
 *
 * 状态取值非法抛 `BAD_REQUEST`：它是**明确的业务条件写错了**，静默回退成「全部」
 * 会让调用方以为筛选生效了。分页参数的非法值走规范化，两者行为不同是刻意的。
 */
export async function queryTipsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<TipPage> {
  const parsed = parseTipListQuery(params);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  const { status, page, pageSize } = parsed.query;
  const repository = getTipRepository();

  const result = await withMockDebug(params, surface, () =>
    repository.queryTips({ userId, status, page, pageSize }),
  );

  return {
    ...result,
    // 转换只在这里发生：仓储实体（含 userId）不会直接出现在接口响应里
    items: result.items.map(toTipListItem),
    status,
    counts: await withMockDebug(params, surface, () => repository.countTipsByStatus(userId)),
  };
}
