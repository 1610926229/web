"use client";

import { formatYuan } from "@/lib/utils/format";
import type { CheckoutCouponOption } from "@/lib/types/coupon";

/**
 * 优惠券选择面板（底部弹出）。
 *
 * 用券是**可选**的：第一项就是「不使用优惠券」，选它一样可以正常下单支付。
 *
 * 三条边界：
 *
 * 1. **判定不在这里做**。每一项的「能不能用、减多少、为什么不能用」都是服务端
 *    按**这一单的原价**算好送来的（`applicable` / `reason` / `discountAmount`）。
 *    组件只负责显示，绝不自己比对门槛——否则「页面算出来能减、服务端算出来不能减」
 *    会变成一个用户完全无法理解的失败。
 * 2. **不能用但仍然在列表里的券要置灰并给出原因**。当前只会有一种：未达门槛
 *    （其余情形服务端压根不会送过来，见 `loadCheckoutCoupons`）。它出现是有意义的——
 *    那是用户唯一能靠自己解决的一种，藏起来他会一直找「我刚领的券去哪了」。
 * 3. **不显示内部字段**。`claimId` / `couponId` 只用于选中与回传，
 *    不渲染成可见文字（它们是内部标识，出现在界面上只会让人困惑）。
 *
 * ⚠️ 这里**没有**「券不可用还是可以用原价买」的按钮：不可用的券根本选不中，
 * 所以不存在「选了却不能用」这个状态。服务端仍会独立再判一次（裁定 §2）。
 */
export default function CouponSheet({
  open,
  coupons,
  selectedClaimId,
  onSelect,
  onClose,
}: {
  open: boolean;
  coupons: CheckoutCouponOption[];
  selectedClaimId: string | null;
  onSelect: (coupon: CheckoutCouponOption | null) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* 遮罩本身也是按钮：点它关闭，避免在非交互元素上挂点击事件 */}
      <button type="button" aria-label="关闭优惠券选择" onClick={onClose} className="flex-1 bg-black/40" />

      <div className="max-h-[70%] overflow-y-auto rounded-t-[16px] bg-surface">
        <div className="sticky top-0 flex items-center border-b border-line bg-surface px-4 py-3">
          <h2 className="flex-1 text-[16px] font-medium text-ink">优惠券</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center text-ink-3"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            aria-pressed={selectedClaimId === null}
            onClick={() => onSelect(null)}
            className={`mb-2 w-full rounded-[10px] border px-3 py-3 text-left text-[14px] ${
              selectedClaimId === null ? "border-brand-red text-brand-red" : "border-line text-ink-2"
            }`}
          >
            不使用优惠券
          </button>

          {coupons.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-ink-3">
              暂时没有可用于这一单的优惠券
            </p>
          ) : null}

          {coupons.map((coupon) => {
            const active = coupon.claimId === selectedClaimId;
            return (
              <button
                key={coupon.claimId}
                type="button"
                disabled={!coupon.applicable}
                aria-pressed={active}
                onClick={() => onSelect(coupon)}
                className={`mb-2 flex w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left disabled:opacity-50 ${
                  active ? "border-brand-red" : "border-line"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">
                    {coupon.name}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {/* 能用时显示条件文案；不能用时显示**具体原因**（含还差多少）——
                        只说「不可用」会让人无从判断该改什么 */}
                    {coupon.applicable ? coupon.conditionLabel : coupon.reason}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[14px] text-brand-red">{coupon.valueLabel}</span>
                  {coupon.applicable ? (
                    <span className="block text-[11px] text-ink-3">
                      本单可减 ¥{formatYuan(coupon.discountAmount)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
