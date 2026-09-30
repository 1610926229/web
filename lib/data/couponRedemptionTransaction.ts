import { resolveCouponApplication, toOrderCouponSnapshot } from "@/lib/constants/coupons";
import type { Order, OrderCouponSnapshot } from "@/lib/types/order";
import { couponStore } from "./mockCouponRepository";

/**
 * 券核销的伪事务（P1-4）—— **唯一**能把一张 `CouponClaim` 从 `unused` 改成 `used` 的地方。
 *
 * ## 为什么单独一个文件，而不是给 `CouponRepository` 加一个 `consumeClaim()`
 *
 * 因为核销**必须与建单发生在同一段原子区段里**（裁定 §5：
 * 「核销必须发生在真实成功形成订单/支付结果的原子业务流程中」）。
 * 而那段区段（`mockPaymentRepository.confirmPaymentRequest`）里**不能有 `await`**——
 * 它同时写下订单、支付记录、派单记录与领取记录，中间让出执行权就会留下
 * 「订单存在了但券还是未使用」或者反过来的半完成状态。
 *
 * `CouponRepository` 的方法一律返回 `Promise`，一旦调用就必须 `await`，
 * 于是区段被打断。这里的做法与本仓库既有的**另一个**跨域同步写入完全一致：
 * `lib/data/companionDispatchTransaction.ts` 的 `createDispatchForOrder()`——
 * 同样是「服务层直接调用的、同步的、专门的写模块」，也同样在支付原子区段里被调用。
 *
 * ## 幂等由状态本身给出，不靠幂等键
 *
 * 与派单那次裁决（见 `companionDispatchTransaction.ts` 的说明）同理：
 * `status === "used"` 就是**事实**，重复调用会被 `resolveCouponApplication()`
 * 直接拒掉（`COUPON_USE_USED_REASON`），不需要额外一张审计表。
 *
 * 这也顺带堵住了一个真实的双花窗口：用户对**同一张券**创建两笔待支付请求
 * （换一个幂等键即可），两笔都支付成功。第二笔在建单前复查时会看到券已经是
 * `used`，于是**抛错、不建单**——而不是核销两次。
 */

/** 核销结果。失败时 `reason` 是一句可以直接给用户看的话。 */
export type CouponRedemptionResult =
  | { ok: true; coupon: OrderCouponSnapshot }
  | { ok: false; reason: string };

/** 没找到券 / 券不属于这个人时的说明。与「不属于当前用户」用同一句话，避免被用来试探。 */
const CLAIM_NOT_FOUND_REASON = "优惠券不存在或不属于当前用户";

/**
 * 把一张券核销在**这一单**上（**同步**）。
 *
 * 失败一律返回 `{ ok: false }` 而**不抛错**：调用方（建单）需要区分
 * 「券的问题」（用户可纠正，应当看到原因）与「系统的问题」（抛错）。
 * 抛出与「券不可用」同一种异常会让这两者混在一条错误链上。
 *
 * ⚠️ **它必须是同步的**。见文件头的说明——这里的每一次 `await` 都会让
 * 「券已核销但订单没建出来」变成真实可能。
 *
 * @param originalAmount 券的门槛基数（**优惠前应付**，裁定 §2），**不是实付**
 */
export function redeemCouponClaimForOrder(input: {
  userId: string;
  claimId: string;
  originalAmount: number;
  /** 核销时刻。取**支付成功那一刻**，不是「谁碰巧来看了一眼」的时间 */
  at: string;
}): CouponRedemptionResult {
  const current = couponStore();

  // —— 原子区段开始（无 await）——
  const claim = current.claims.get(input.claimId);
  // 归属校验在**这里**做，不靠调用方：服务层的校验只说明「用户选的是自己的券」，
  // 而这一段是最后一道闸，绕过接口直接调服务也走它
  if (!claim || claim.userId !== input.userId) {
    return { ok: false, reason: CLAIM_NOT_FOUND_REASON };
  }

  // 券模板「此刻」是否启用。裁定未明文，本实现按「停用后已领取的也不能再用」处理，
  // 并在交付记录里列为待产品追认项
  const enabled = current.coupons.get(claim.couponId)?.enabled ?? false;

  // 判定与试算共用同一个纯函数，因此「试算说能用、下单却被拒」不可能发生
  const application = resolveCouponApplication(
    claim,
    input.originalAmount,
    new Date(input.at),
    enabled,
  );
  if (!application.applicable) return { ok: false, reason: application.reason };

  // —— 写入：核销 ——
  // 只改 status 与 usedAt。领取时刻的券面快照**原样保留**：它是历史事实，
  // 而 `usedAt` 是这次核销发生的时刻，两者不该互相覆盖
  current.claims.set(claim.id, { ...claim, status: "used", usedAt: input.at });
  // —— 原子区段结束 ——

  return { ok: true, coupon: toOrderCouponSnapshot(claim) };
}

/* ───────────────── 另一个方向：退券（P1-4 验收整改轮） ───────────────── */

/** 一次退券的结果。`null` 表示「这一单不该退券」，不是错误。 */
export type CouponRestoreResult = { claimId: string; couponId: string; userId: string };

/**
 * 把**这一单当初用掉的那张券**的使用资格还回去（**同步**）。
 *
 * ## 判据只有一条：订单历史上有没有被承接（裁定 §一）

 * ```
 * 从未进入 accepted  →  还券
 * 曾经进入 accepted  →  不还
 * ```
 *
 * ⚠️ **不看退款比例**（§一 明文），**也不能只看退款瞬间的 `Order.status`**：
 * 一张 `accepted → 客服取消回池 → paid` 的单，退款那一刻它是 `paid`，
 * 但它**已经被承接过了**，因此**不还券**。只判 `status === "paid"` 是错的。
 * 唯一的判据是 `order.everAcceptedAt`（见 `lib/types/order.ts` 上那个字段的说明：
 * 它为什么会存在、为什么四个候选字段都不能替代它）。
 *
 * ⚠️ 这里**刻意不读 `Dispatch.acceptedVia`**：那是 P1-5 接单榜的来源标记，
 * 而裁定 §一.3 明文**不得**用它判断返券——客服直接指定的单同样算「已被承接」，
 * 券一样不还。两个领域问的是两个问题，共用字段迟早会把其中一个答错。
 *
 * ## 它做与不做的
 *
 * | | |
 * |---|---|
 * | **做** | 把**原来那张** Claim 从 `used` 改回 `unused`，并清掉 `usedAt` |
 * | **不做** | 新建一张券。裁定 §一.1 明文「不得创建一张新的重复券」——多一张就是多一次打折 |
 * | **不做** | 碰订单上的 `coupon` / `couponDiscountAmount` / `actualPaidAmount`。裁定 §二明文保留：订单历史仍要能说明「当时用过这张券」 |
 * | **不做** | 判 `enabled` / 有效期 / 门槛。§三 说得清楚：**返还的是「未使用资格」，不是绕过它们**。还回去之后，那张券能不能用仍然由当下重新判 |
 *
 * ## 幂等
 *
 * 与核销同一套：**状态本身就是事实**。只有 `used` 才动，重复调用第二次会看到
 * `unused` 而直接返回 `null`。不需要额外的审计表，也不可能把 `usedAt` 刷成别的时刻。
 *
 * ## 为什么必须同步
 *
 * 它在**退款事务的原子区段里**被调用（`directRefundTransaction` /
 * `adminRefundTransaction` / `companionDispatchTransaction` 三处）。
 * 那一段里出现任何 `await` 都会让出执行权，「钱退了但券还没还」的那一瞬会被别的请求读到——
 * 而裁定 §十二 要求的正是「**退款实际成功 → 才恢复 Claim**」，两者之间不允许有窗口。
 *
 * @param order **退款之前**的那一份订单（`applyOrderRefund` 返回的 `previous`）。
 *   传退款后的版本会读不到本该读到的历史——尤其 `everAcceptedAt` 与 `coupon`。
 *
 * ⚠️ **没有 `at` 参数**：还券只做一件事——把 `status` 改回 `unused` 并把 `usedAt` 清空。
 * 它**不记录「什么时候还的」**，因为裁定 §二 只要这两项，而那个时刻本来就能从订单上读到
 * （`refundedAt`）。加一个 `restoredAt` 会造出第二份「这张券什么时候变的」真值，
 * 而两份真值迟早会不一致。
 */
export function restoreCouponClaimForOrder(
  order: Pick<Order, "userId" | "everAcceptedAt" | "coupon">,
): CouponRestoreResult | null {
  // —— 判据：曾经被承接就不还（裁定 §一）——
  if (order.everAcceptedAt !== null) return null;

  const claimId = order.coupon?.claimId;
  if (!claimId) return null;

  const current = couponStore();

  // —— 原子区段开始（无 await）——
  const claim = current.claims.get(claimId);
  // 归属校验在这里再做一次：订单上的快照是历史事实，而这一句防的是
  // 「快照里的 claimId 指向了别人的券」这种坏数据
  if (!claim || claim.userId !== order.userId) return null;
  // 只有「用过」才谈得上「还」。已经是 unused 说明还过了（或从未核销），直接不动
  if (claim.status !== "used") return null;

  current.claims.set(claimId, { ...claim, status: "unused", usedAt: null });
  // —— 原子区段结束 ——

  return { claimId, couponId: claim.couponId, userId: claim.userId };
}
