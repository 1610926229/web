import type { PageResult } from "@/lib/types/common";
import type { TipRecord, TipStatusFilter } from "@/lib/types/tip";
import { mockTipRepository } from "./mockTipRepository";

/**
 * 鸡腿记录的可替换仓储 —— **只读**。
 *
 * ⚠️ 这里**故意没有任何写入方法**，这不是「还没写完」，而是本阶段的结论：
 * 鸡腿的价格、兑换比例、支付方式与打手结算规则都还没有确认，一旦提供一个
 * 「创建鸡腿记录」的入口，就会顺带定下价格与结算口径——那是必须先与业务确认的事。
 *
 * 没有写方法带来两个好处：
 * - 服务层与接口层**不可能**误写出「创建鸡腿记录」的路径，编译期就挡住了；
 * - 将来确认规则后新增写方法，是一次**纯新增**的改动，不需要先拆掉任何东西。
 *
 * 读取侧只按「当前用户 + 状态」查询：`userId` 是查询条件而不是过滤项，
 * 调用方拿不到「别人的记录」这种东西。
 */

export type TipListQuery = {
  userId: string;
  status: TipStatusFilter;
  page: number;
  pageSize: number;
};

export type TipRepository = {
  /** 按用户 + 状态分页查询，按记录创建时间倒序（排序规则在仓储内保证，不交给调用方）。 */
  queryTips(query: TipListQuery): Promise<PageResult<TipRecord>>;

  /** 统计某个用户在各状态下的记录数（列表角标用，与分页无关）。 */
  countTipsByStatus(userId: string): Promise<Record<TipStatusFilter, number>>;
};

export function getTipRepository(): TipRepository {
  return mockTipRepository;
}
