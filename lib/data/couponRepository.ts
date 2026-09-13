import type { PageResult } from "@/lib/types/common";
import type { Coupon, CouponClaim } from "@/lib/types/coupon";
import { mockCouponRepository } from "./mockCouponRepository";

/**
 * 优惠券的可替换仓储（读写）。
 *
 * 与订单 / 投诉列表同一套路：**筛选、排序、分页都在仓储里完成**，页面与接口都不自己过滤。
 *
 * `userId` 是**查询条件的一部分**而不是可选的过滤项：本层只可能返回该用户的领取记录，
 * 调用方不需要（也不应该）拿到结果后再过滤一次。「只领取自己的券」也由本层保证——
 * `createClaim` 写入的记录的 `userId` 就是调用方传进来的那个。
 *
 * 幂等有**两道**：
 * 1. **业务唯一键 `(userId, couponId)`**：同一个人对同一张券只会有一条领取记录，
 *    这是本模块真正的防重（重复点击、并发点击、网络重试都归它管）；
 * 2. **幂等键 `(userId, idempotencyKey)`**：与其他写接口一致的通用兜底索引。
 *
 * ⚠️ 本层**不判断**「这张券能不能领」：那是业务规则，在 `lib/services/coupons.ts` 里做。
 * 将来换成数据库时，两道约束分别对应 `(user_id, coupon_id)` 唯一索引与幂等键唯一索引。
 */

export type CouponListQuery = {
  userId: string;
  page: number;
  pageSize: number;
};

export type CouponRepository = {
  /** 我的领取记录（「我的优惠券」列表与接口的唯一入口）。 */
  queryOwnedCoupons(query: CouponListQuery): Promise<PageResult<CouponClaim>>;

  /** 领券中心：券模板列表。是否可领、是否已领由服务层逐条判定。 */
  queryCoupons(query: CouponListQuery): Promise<PageResult<Coupon>>;

  /** 我领过的全部记录（算角标数量用，避免为了两个数字把两页数据都取回来）。 */
  countOwnedCoupons(userId: string): Promise<number>;

  /** 按 id 取券模板；不存在返回 null。 */
  findCouponById(id: string): Promise<Coupon | null>;

  /** 按「用户 + 券」查领取记录；没领过返回 null。 */
  findClaim(userId: string, couponId: string): Promise<CouponClaim | null>;

  /**
   * 幂等创建领取记录。
   *
   * 同「用户 + 券」或同「用户 + 幂等键」已存在时不再创建，返回已存在的那条、
   * `created` 置为 false。检查与写入在同一段同步代码里完成，并发重复提交只会产生一条。
   */
  createClaim(
    claim: CouponClaim,
    idempotencyKey: string,
  ): Promise<{ claim: CouponClaim; created: boolean }>;
};

export function getCouponRepository(): CouponRepository {
  return mockCouponRepository;
}
