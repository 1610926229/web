import type { PageResult } from "@/lib/types/common";
import type { Complaint, ComplaintStatus } from "@/lib/types/complaint";
import { mockComplaintRepository } from "./mockComplaintRepository";

/**
 * 投诉的可替换仓储（读写）。
 *
 * 与订单列表同一套路：**筛选、排序、分页都在仓储里完成**，页面与接口都不自己过滤，
 * 否则「按状态筛选」在两侧会慢慢长成两套行为。
 *
 * 同样与订单列表一样，`query.userId` 是**查询条件的一部分**而不是可选的过滤项：
 * 本层只可能返回该用户的投诉，调用方不需要（也不应该）拿到结果后再过滤一次。
 *
 * 幂等：同「用户 + 幂等键」只会创建一条投诉，快速连点不会多出记录。
 *
 * ⚠️ 本层**不判断**「这笔订单是不是你的」「订单存不存在」：那是业务规则，
 * 在 `lib/services/complaints.ts` 里做。
 */

export type ComplaintListQuery = {
  userId: string;
  /** null 表示「全部」 */
  status: ComplaintStatus | null;
  page: number;
  pageSize: number;
};

/** 订单详情联动的投诉统计：这一单有几条投诉、最新一条是哪条（原始记录，转换由服务层做）。 */
export type ComplaintOrderStats = {
  count: number;
  latest: Complaint | null;
};

export type ComplaintRepository = {
  /** 查询某个用户的投诉列表（列表页与接口的唯一入口）。 */
  queryComplaints(query: ComplaintListQuery): Promise<PageResult<Complaint>>;

  /** 按 id 取单条投诉（不做归属判断，归属由服务层校验）。 */
  findComplaintById(id: string): Promise<Complaint | null>;

  /** 按「用户 + 幂等键」查已提交过的投诉；不存在返回 null。 */
  findComplaintByKey(userId: string, idempotencyKey: string): Promise<Complaint | null>;

  /** 幂等创建：同「用户 + 幂等键」已存在时不再创建，返回已存在的那条。 */
  createComplaint(
    complaint: Complaint,
    idempotencyKey: string,
  ): Promise<{ complaint: Complaint; created: boolean }>;

  /** 某一笔订单的投诉统计（订单详情页用，避免为了一个角标把整页投诉都取回来）。 */
  summarizeComplaintsByOrder(orderId: string): Promise<ComplaintOrderStats>;
};

export function getComplaintRepository(): ComplaintRepository {
  return mockComplaintRepository;
}
