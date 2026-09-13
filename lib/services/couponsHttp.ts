import { apiGet, apiPost } from "@/lib/api/client";
import { COUPON_PAGE_SIZE, type CouponTabKey } from "@/lib/constants/coupons";
import type {
  ClaimableCouponPage,
  CouponClaimResult,
  OwnedCouponPage,
} from "@/lib/types/coupon";

/**
 * 优惠券的**浏览器端**取数（切 Tab / 加载更多 / 领取）。
 *
 * 与服务端模块 `lib/services/coupons.ts` 分开是必须的：那个模块依赖 `lib/data` 与
 * `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 两个 Tab 的首屏都由 Server Component 直接取数，不经过本文件。
 */

export type CouponListRequest = {
  page?: number;
  pageSize?: number;
};

/** 已拥有的券列表。 */
export function fetchOwnedCoupons(input: CouponListRequest): Promise<OwnedCouponPage> {
  return fetchCouponPage<OwnedCouponPage>("owned", input);
}

/** 领券中心。 */
export function fetchClaimableCoupons(input: CouponListRequest): Promise<ClaimableCouponPage> {
  return fetchCouponPage<ClaimableCouponPage>("claimable", input);
}

function fetchCouponPage<T>(tab: CouponTabKey, input: CouponListRequest): Promise<T> {
  const params = new URLSearchParams();
  params.set("tab", tab);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? COUPON_PAGE_SIZE));

  return apiGet<T>(`/api/coupons?${params.toString()}`);
}

/**
 * 领取优惠券。
 *
 * 请求体里**只有幂等键**：券由路径决定，`userId` / `status` / 领取时间都由服务端写，
 * 客户端塞什么都不算。重复领取不会报错，返回第一次的结果（`created: false`）。
 */
export function claimCoupon(couponId: string, idempotencyKey: string): Promise<CouponClaimResult> {
  return apiPost<CouponClaimResult>(`/api/coupons/${encodeURIComponent(couponId)}/claim`, {
    idempotencyKey,
  });
}
