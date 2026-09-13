import { compareClaimsNewestFirst, compareCouponsNewestFirst } from "@/lib/constants/coupons";
import { couponClaimSeed, couponSeed } from "@/lib/mocks/fixtures/couponSeed";
import type { Coupon, CouponClaim } from "@/lib/types/coupon";
import type { CouponRepository } from "./couponRepository";
import { getMockStore } from "./mockStore";

/**
 * 优惠券的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置的券与用户新领取的记录进的是**同一个 Map、同一套查询方法**，
 * 「领取后立刻出现在我的优惠券里」正是由这一点保证的。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**。
 */
type MockCouponStore = {
  coupons: Map<string, Coupon>;
  claims: Map<string, CouponClaim>;
  /** `${userId}:${couponId}` → 领取记录 id（业务唯一键） */
  claimIdByCoupon: Map<string, string>;
  /** `${userId}:${idempotencyKey}` → 领取记录 id（通用幂等索引） */
  claimIdByKey: Map<string, string>;
};

function createStore(): MockCouponStore {
  return {
    coupons: new Map(couponSeed.map((coupon) => [coupon.id, coupon])),
    claims: new Map(couponClaimSeed.map((claim) => [claim.id, claim])),
    claimIdByCoupon: new Map(
      couponClaimSeed.map((claim) => [couponKey(claim.userId, claim.couponId), claim.id]),
    ),
    claimIdByKey: new Map(),
  };
}

function store(): MockCouponStore {
  return getMockStore("coupon", createStore);
}

function couponKey(userId: string, couponId: string): string {
  return `${userId}:${couponId}`;
}

function idempotencyKeyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

export const mockCouponRepository: CouponRepository = {
  async queryOwnedCoupons(query) {
    const { userId, page, pageSize } = query;

    const filtered = [...store().claims.values()]
      .filter((claim) => claim.userId === userId)
      .sort(compareClaimsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: filtered.length,
      // 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致
      hasMore: start + items.length < filtered.length,
    };
  },

  async queryCoupons(query) {
    const { page, pageSize } = query;

    // 券模板与用户无关（任何人都能看到同一批券），因此这里不按 userId 过滤；
    // 「我领过没有」由服务层逐条比对领取记录得出。
    const all = [...store().coupons.values()].sort(compareCouponsNewestFirst);

    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize);

    return {
      items,
      page,
      pageSize,
      total: all.length,
      hasMore: start + items.length < all.length,
    };
  },

  async countOwnedCoupons(userId) {
    return [...store().claims.values()].filter((claim) => claim.userId === userId).length;
  },

  async findCouponById(id) {
    return store().coupons.get(id) ?? null;
  },

  async findClaim(userId, couponId) {
    const id = store().claimIdByCoupon.get(couponKey(userId, couponId));
    return id ? (store().claims.get(id) ?? null) : null;
  },

  async createClaim(claim, idempotencyKey) {
    const current = store();
    const businessKey = couponKey(claim.userId, claim.couponId);
    const requestKey = idempotencyKeyOf(claim.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // ① 业务唯一键：同一个人对同一张券只可能有一条记录
    const existingId = current.claimIdByCoupon.get(businessKey);
    if (existingId) {
      const existing = current.claims.get(existingId);
      // 索引命中但记录已不存在属于不可能状态；真出现时按未创建处理，保证不会卡住领取
      if (existing) return { claim: existing, created: false };
    }

    // ② 幂等键：同一次领取意图重复到达时返回上一次的结果
    const byRequest = current.claimIdByKey.get(requestKey);
    if (byRequest) {
      const existing = current.claims.get(byRequest);
      if (existing) return { claim: existing, created: false };
    }

    current.claims.set(claim.id, claim);
    current.claimIdByCoupon.set(businessKey, claim.id);
    current.claimIdByKey.set(requestKey, claim.id);
    // —— 原子区段结束 ——

    return { claim, created: true };
  },
};
