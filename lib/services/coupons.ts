import { ApiError } from "@/lib/api/ApiError";
import {
  COUPON_CLAIMED_LABEL,
  COUPON_NOT_FOUND_MESSAGE,
  couponClaimability,
  parseCouponListQuery,
  resolveCouponApplication,
  toCouponSnapshot,
  toOwnedCouponItem,
} from "@/lib/constants/coupons";
import type { CouponListQueryInput } from "@/lib/constants/coupons";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey } from "@/lib/constants/writes";
import { getCouponRepository } from "@/lib/data/couponRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  CheckoutCouponOption,
  ClaimableCouponItem,
  Coupon,
  CouponClaimResult,
  CouponListPage,
  CouponTabCounts,
  OwnedCouponItem,
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
 * 4. **本文件仍然不做任何金额运算**（P1-4 起这句话的**范围**变了，含义没变）。
 *    满减券现在确实会改变订单金额，但算钱的只有
 *    `lib/constants/orderAmount.ts`，判定能不能用的只有
 *    `lib/constants/coupons.ts` 的 `resolveCouponApplication()`——
 *    两者都不在本文件。**核销也不在本文件**：它必须与建单发生在同一段原子区段里
 *    （裁定 §5），落点是 `lib/data/couponRedemptionTransaction.ts`。
 *    这里只负责「领」与「列」。
 * 5. **状态文案由服务端算**。`已过期` 是按当前时间推出来的，前端不自己看时间判断。
 * 6. **结算页选券的列表也走本文件**（`loadCheckoutCoupons`）：能不能用要对着
 *    **某一单的原价**判，因此那个函数必须收 `originalAmount`，不能只给一份「我的券」。
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

    // ⚠️ 逐条查券模板的 `enabled`（P1-4 验收整改轮 §九）：它不在 Claim 上，
    // 而在**当前**的券模板上。不查它，「这张券能不能用于结算」就只能漏判一条，
    // 而漏判的方向恰好是把已停用的券标成「可用于结算」——比不标更糟。
    const items: OwnedCouponItem[] = [];
    for (const claim of page.items) {
      const template = await withMockDebug(params, surface, () =>
        repository.findCouponById(claim.couponId),
      );
      // 模板查不到（已被平台移除）按「停用」处理：与核销侧同一个 fail-closed 方向
      items.push(toOwnedCouponItem(claim, now, template?.enabled ?? false));
    }

    return {
      ...page,
      // 转换只在这里发生：仓储返回的领取记录（含 userId）不会直接出现在接口响应里
      items,
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
      // 自己领的。管理员发放走另一条路（`grantCouponToUser`），来源字段必填，
      // 因此这里不可能漏写（P1-4 验收整改轮 §六）
      source: "self_claim",
      // 领取时间由服务端写，客户端说什么都不算
      claimedAt: now.toISOString(),
      usedAt: null,
      // 自己领的券没有发放人
      grantedByAdminId: null,
      // 与管理员发放**共用同一个**快照构造器（验收整改轮 §七）：两条路径各写一份
      // 字段列表，迟早会有一条忘了加新字段，而那种缺失只在结算时才暴露
      snapshot: toCouponSnapshot(coupon),
    },
    idempotencyKey,
  );

  return { claimId: result.claim.id, couponId: coupon.id, created: result.created };
}

/**
 * 结算页可选的券（P1-4）。
 *
 * 与「我的优惠券」的区别只有一条，但很关键：**判定要对着这一单的原价做**。
 * 同一张「满 100 减 10」的券，在 80 元的单上不能用、在 120 元的单上能用，
 * 因此这个函数必须收 `originalAmount`，返回的每一项都带 `applicable` / `reason` /
 * `discountAmount`（都由服务端算好，界面不自己比门槛）。
 *
 * ⚠️ **它只读**：试算与列出可选券都不会消耗任何东西（裁定 §5）。
 * 真正的核销在支付成功的原子区段里。
 *
 * **列的取舍**（这一步必须在这里做，不能留给界面——界面过滤等于把「哪些券能用」
 * 的口径复制到浏览器上，两侧迟早不一致）：
 *
 * | 情形 | 列不列 | 为什么 |
 * |---|---|---|
 * | 能用 | ✅ | —— |
 * | **未达门槛** | ✅ | 唯一一个用户能靠自己解决的（改数量 / 加增值服务），藏起来他会一直找「我刚领的券去哪了」 |
 * | 已核销 / 已过期 / 未开始 / 类型不支持 / 数据异常 | ❌ | 在这一单上**永不可能**生效，列出来只会让人点一下再被拒 |
 * | 券模板已不存在 | ❌ | 券面都没了，展示不出任何东西 |
 *
 * 判定依据是 `CouponApplication.code`，**不是**文案——文案是给人看的，会改。
 */
export async function loadCheckoutCoupons(
  userId: string,
  originalAmount: number,
  now: Date = new Date(),
): Promise<CheckoutCouponOption[]> {
  const repository = getCouponRepository();

  // 一个人的券是有限几条，一次取全；分页在这里没有意义（结算页不翻页）
  const page = await repository.queryOwnedCoupons({
    userId,
    page: 1,
    pageSize: Number.MAX_SAFE_INTEGER,
  });

  const options: CheckoutCouponOption[] = [];
  for (const claim of page.items) {
    const template = await repository.findCouponById(claim.couponId);
    // 券模板被删掉了：连券面都取不到，展示不出名字与文案
    if (!template) continue;

    const application = resolveCouponApplication(claim, originalAmount, now, template.enabled);
    if (!application.applicable && application.code !== "threshold_not_met") continue;

    options.push({
      claimId: claim.id,
      couponId: claim.couponId,
      name: claim.snapshot.name,
      valueLabel: claim.snapshot.valueLabel,
      conditionLabel: claim.snapshot.conditionLabel,
      validFrom: claim.snapshot.validFrom,
      validTo: claim.snapshot.validTo,
      applicable: application.applicable,
      reason: application.reason,
      discountAmount: application.discountAmount,
    });
  }

  // 能减得多的排前面：结算页要的是「我现在用哪张最划算」。
  // 直接按抵扣额倒序即可——「能用」的抵扣额一定 > 0，不能用的恒为 0，
  // 于是「能用的在前」是这个排序的**结果**，不需要再单独排一轮
  return options.sort((a, b) => b.discountAmount - a.discountAmount);
}
