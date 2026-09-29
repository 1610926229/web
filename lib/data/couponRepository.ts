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
   * 按「用户 + 领取记录 id」查一条领取记录；不存在或不属于该用户时返回 null（P1-4）。
   *
   * ⚠️ `userId` 是**查询条件**而不是事后校验：结算页把用户选的 `claimId` 传进来，
   * 若这里只按 id 查、让调用方自己比 `userId`，那么任何一个漏掉那一步的调用方
   * 都能拿别人的券下单。让「查不到」与「不是你的」在本层就合成同一个结果，
   * 上层就没有可漏的地方。
   */
  findClaimById(userId: string, claimId: string): Promise<CouponClaim | null>;

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

  /**
   * 幂等创建**管理员发放**的领取记录（P1-4 验收整改轮 §五）。
   *
   * ⚠️ **它刻意不是 `createClaim` 的一个参数**。两者的防重规则**不同**：
   *
   * | | `createClaim`（自己领） | `createGrant`（管理员发） |
   * |---|---|---|
   * | 业务唯一键 `(userId, couponId)` | **有**：一个人对一张券只能领一次 | **没有**：可以重复发、可以对已领过的人再发 |
   * | 幂等键 `(userId, idempotencyKey)` | 有 | 有 |
   *
   * 把它们合成一个方法、用一个布尔开关切行为，等于把「哪种来源受哪条约束」这件事
   * 藏进一个运行期分支里；而它是一条**业务规则**（裁定 §五），值得在类型上分开。
   *
   * 同时也决定了它**不能**写 `claimIdByCoupon` 索引：那个索引是「一人一券」的实现，
   * 让发放去覆盖它，会把用户自己领的那张从索引里挤掉——`findClaim()` 之后就查不到了。
   *
   * 幂等键索引仍然写，且键里带上 adminId：同一个管理员重复提交同一份表单只会发一张，
   * 而不同管理员各自的发放意图不会互相顶掉。
   */
  createGrant(
    claim: CouponClaim,
    idempotencyKey: string,
  ): Promise<{ claim: CouponClaim; created: boolean }>;
};

export function getCouponRepository(): CouponRepository {
  return mockCouponRepository;
}
