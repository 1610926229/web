import { ApiError } from "@/lib/api/ApiError";
import {
  COUPON_CLAIMED_LABEL,
  COUPON_NOT_FOUND_MESSAGE,
  couponClaimability,
  parseCouponListQuery,
  toOwnedCouponItem,
} from "@/lib/constants/coupons";
import type { CouponListQueryInput } from "@/lib/constants/coupons";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getCouponRepository } from "@/lib/data/couponRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  ClaimableCouponItem,
  Coupon,
  CouponClaimResult,
  CouponListPage,
  CouponTabCounts,
} from "@/lib/types/coupon";

/**
 * 优惠券服务 —— 领券中心、我的优惠券与领取接口共用的唯一入口。
 *
 * 五条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只返回当前用户的数据**。所有函数都要求传入会话里读到的 `userId`，
 *    仓储把它当成查询条件；接口不接受任何「查谁的券」参数。
 * 2. **不能领的券就领不了**。停用、未开始、已过期的券在服务端被拒绝，
 *    前端的按钮只是提示，不是权限。
 * 3. **重复领取不是错误，但不会产生第二条记录**。业务唯一键是「用户 + 券」，
 *    幂等键是通用兜底；命中时返回第一次的结果（`created: false`）。
 * 4. **优惠券不参与结算**。本文件没有任何金额运算，也不引用订单 / 支付 / 结算模块：
 *    领券不会改变订单金额，也没有核销入口。券面值是展示文案。
 * 5. **状态文案由服务端算**。`已过期` 是按当前时间推出来的，前端不自己看时间判断。
 */

/** 领券中心的一项：券面 + 由服务端判定的领取状态。 */
function toClaimableCouponItem(
  coupon: Coupon,
  claimed: boolean,
  now: Date,
): ClaimableCouponItem {
  const { claimable, reason } = couponClaimability(coupon, now);

  return {
    id: coupon.id,
    name: coupon.name,
    formLabel: coupon.formLabel,
    valueLabel: coupon.valueLabel,
    conditionLabel: coupon.conditionLabel,
    validFrom: coupon.validFrom,
    validTo: coupon.validTo,
    // 已经领过的券不再是「可领取」，按钮上的文字也换成「已领取」
    claimable: claimable && !claimed,
    reason: claimed ? COUPON_CLAIMED_LABEL : reason,
    claimed,
  };
}

/** 两个 Tab 的数量：已拥有 = 我的领取记录数；可领取 = 我还没领过、且当前可领的券数。 */
async function loadCounts(userId: string, now: Date): Promise<CouponTabCounts> {
  const repository = getCouponRepository();
  const owned = await repository.countOwnedCoupons(userId);

  // 角标只关心「还能领几张」，因此把券模板全部取出来逐条判定：
  // 券的数量是平台配置量，比让前端自己推算要可靠得多。
  const all = await repository.queryCoupons({
    userId,
    page: 1,
    pageSize: Number.MAX_SAFE_INTEGER,
  });

  let claimable = 0;
  for (const coupon of all.items) {
    if (!couponClaimability(coupon, now).claimable) continue;
    // 已经领过的不能再算进「可领取」，否则领完角标不动，看起来像没领成功
    if (await repository.findClaim(userId, coupon.id)) continue;
    claimable += 1;
  }

  return { owned, claimable };
}

/**
 * 查询优惠券列表（我的优惠券 / 领券中心）。
 *
 * Tab 取值非法抛 `BAD_REQUEST`：这是**明确的业务条件写错了**，静默回退成「已拥有」
 * 会让调用方以为自己在看另一份数据。分页参数的非法值走规范化，两者行为不同是刻意的。
 *
 * `now` 只在测试里显式传入：过期与「可领取」都依赖当前时间，
 * 测试必须能把时间钉死，否则用例会在某一天突然变红。
 */
export async function queryCouponsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<CouponListPage> {
  const parsed = parseCouponListQuery(params);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  const query: CouponListQueryInput = parsed.query;
  const repository = getCouponRepository();

  if (query.tab === "owned") {
    const page = await withMockDebug(params, surface, () =>
      repository.queryOwnedCoupons({
        userId,
        page: query.page,
        pageSize: query.pageSize,
      }),
    );

    return {
      ...page,
      // 转换只在这里发生：仓储返回的领取记录（含 userId）不会直接出现在接口响应里
      items: page.items.map((claim) => toOwnedCouponItem(claim, now)),
      tab: "owned",
      counts: await withMockDebug(params, surface, () => loadCounts(userId, now)),
    };
  }

  const page = await withMockDebug(params, surface, () =>
    repository.queryCoupons({ userId, page: query.page, pageSize: query.pageSize }),
  );

  // 「我领过没有」逐条查：领过的券在领券中心里显示「已领取」，
  // 从而不会出现「同一张券领了两次」这种在业务上不可能的状态。
  const items: ClaimableCouponItem[] = [];
  for (const coupon of page.items) {
    const claim = await repository.findClaim(userId, coupon.id);
    items.push(toClaimableCouponItem(coupon, claim !== null, now));
  }

  return {
    ...page,
    items,
    tab: "claimable",
    counts: await withMockDebug(params, surface, () => loadCounts(userId, now)),
  };
}

/**
 * 领取优惠券。
 *
 * 顺序刻意如此：
 *
 * 1. **快速路径**：这个键提交过就返回上一次的结果，连校验都不重来
 *    （重试要的是「和上次一样的结果」，而不是「按现在的状态重新算一遍」）；
 * 2. 券不存在（或已被平台移除）→ 404，与「不属于当前用户」的对外表现一致；
 * 3. 已经领过 → **不是错误**，返回已有记录、`created: false`；
 *    重复点击、刷新页面重发、并发点击都只会得到同一条记录；
 * 4. 券停用 / 未开始 / 已过期 → 400，带上不能领取的具体原因。
 *
 * 客户端提交的任何 `userId` / `status` / `claimedAt` 都不会被读取：
 * 请求体只按白名单取幂等键（券由路径决定）。
 */
export async function claimCouponForUser(
  userId: string,
  couponId: string,
  body: Record<string, unknown>,
  surface: MockSurface,
  params?: URLSearchParams,
  now: Date = new Date(),
): Promise<CouponClaimResult> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getCouponRepository();

  const coupon = await withMockDebug(params, surface, () => repository.findCouponById(couponId));
  if (!coupon) throw new ApiError("NOT_FOUND", COUPON_NOT_FOUND_MESSAGE);

  // 已经领过：直接返回第一条记录，不重复校验、不重复写入
  const existing = await repository.findClaim(userId, coupon.id);
  if (existing) return { claimId: existing.id, couponId: coupon.id, created: false };

  const { claimable, reason } = couponClaimability(coupon, now);
  if (!claimable) throw new ApiError("BAD_REQUEST", reason);

  const result = await repository.createClaim(
    {
      id: `claim_${crypto.randomUUID()}`,
      userId,
      couponId: coupon.id,
      // 新领取的券一定是「未使用」；「已过期」是按时间推出来的展示状态
      status: "unused",
      // 领取时间由服务端写，客户端说什么都不算
      claimedAt: now.toISOString(),
      usedAt: null,
      snapshot: {
        name: coupon.name,
        formKey: coupon.formKey,
        formLabel: coupon.formLabel,
        valueLabel: coupon.valueLabel,
        conditionLabel: coupon.conditionLabel,
        validFrom: coupon.validFrom,
        validTo: coupon.validTo,
      },
    },
    idempotencyKey,
  );

  return { claimId: result.claim.id, couponId: coupon.id, created: result.created };
}
