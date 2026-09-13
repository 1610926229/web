import { COUPON_FORM_LABELS } from "@/lib/constants/coupons";
import type { Coupon, CouponClaim, CouponFormKey } from "@/lib/types/coupon";

/**
 * 预置优惠券种子（券模板 + 用户的领取记录）。
 *
 * ⚠️ 券面是**本地 Mock 数据**，`valueLabel` / `conditionLabel` 是展示文案，
 * 不是可参与运算的金额。这里刻意不写「满 100 减 10」之外的适用范围、叠加与排他规则：
 * 那些规则尚未确认，写进来就会被当成已确认的产品规则。
 *
 * 种子要覆盖的边界：
 * - 可领取 / 已停用 / 已过期 / 尚未开始，四种情况在领券中心里都能看到；
 * - 已有领取记录的券，在领券中心里显示「已领取」而不是再领一次；
 * - 「我的优惠券」覆盖未使用 / 已使用 / 已过期三种展示状态。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

type PresetCouponInput = {
  id: string;
  name: string;
  formKey: CouponFormKey;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  /** 不填表示启用 */
  enabled?: boolean;
};

function build(input: PresetCouponInput): Coupon {
  return {
    id: input.id,
    name: input.name,
    formKey: input.formKey,
    // 形式文案只此一份（与页面、接口共用同一个映射表）
    formLabel: COUPON_FORM_LABELS[input.formKey],
    valueLabel: input.valueLabel,
    conditionLabel: input.conditionLabel,
    validFrom: input.validFrom,
    validTo: input.validTo,
    enabled: input.enabled ?? true,
  };
}

/** 券面文案统一带「（Mock）」：任何人打开页面都能一眼看出这不是真实营销活动。 */
export const couponSeed: Coupon[] = [
  build({
    id: "cpn-mock-new-user",
    name: "新人立减券（Mock）",
    formKey: "threshold",
    valueLabel: "满 100 减 10",
    conditionLabel: "仅限首次下单使用（Mock 文案）",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T15:59:59.000Z",
  }),
  build({
    id: "cpn-mock-holiday",
    name: "节日折扣券（Mock）",
    formKey: "discount",
    valueLabel: "9 折",
    conditionLabel: "全站通用（Mock 文案，适用范围待确认）",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T15:59:59.000Z",
  }),
  build({
    id: "cpn-mock-no-threshold",
    name: "无门槛体验券（Mock）",
    formKey: "gift",
    valueLabel: "立减 5",
    conditionLabel: "无使用门槛（Mock 文案）",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T15:59:59.000Z",
  }),
  build({
    id: "cpn-mock-expired",
    name: "暑期活动券（Mock）",
    formKey: "threshold",
    valueLabel: "满 50 减 5",
    conditionLabel: "暑期活动专享（Mock 文案）",
    validFrom: "2026-06-01T00:00:00.000Z",
    validTo: "2026-08-31T15:59:59.000Z",
  }),
  build({
    id: "cpn-mock-disabled",
    name: "已停用券（Mock）",
    formKey: "gift",
    valueLabel: "立减 3",
    conditionLabel: "该券已停止发放（Mock 文案）",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T15:59:59.000Z",
    enabled: false,
  }),
  build({
    id: "cpn-mock-upcoming",
    name: "双十一预告券（Mock）",
    formKey: "threshold",
    valueLabel: "满 200 减 30",
    conditionLabel: "活动开始后可用（Mock 文案）",
    validFrom: "2026-11-01T00:00:00.000Z",
    validTo: "2026-11-30T15:59:59.000Z",
  }),
];

type PresetClaimInput = {
  id: string;
  couponId: string;
  status: CouponClaim["status"];
  claimedAt: string;
  usedAt?: string;
};

function requireCoupon(id: string): Coupon {
  const coupon = couponSeed.find((item) => item.id === id);
  if (!coupon) throw new Error(`Mock 种子缺失优惠券：${id}`);
  return coupon;
}

/**
 * 领取记录。**只给老板A（u-1001）预置**：
 * 老板B 的「我的优惠券」因此是空的，空态不需要额外的调试开关就能看到。
 */
export const couponClaimSeed: CouponClaim[] = (
  [
    {
      id: "claim-seed-1001-01",
      couponId: "cpn-mock-new-user",
      status: "unused",
      claimedAt: "2026-09-08T02:10:00.000Z",
    },
    {
      id: "claim-seed-1001-02",
      couponId: "cpn-mock-holiday",
      status: "used",
      claimedAt: "2026-09-01T05:30:00.000Z",
      usedAt: "2026-09-02T04:00:00.000Z",
    },
    {
      id: "claim-seed-1001-03",
      couponId: "cpn-mock-expired",
      // 记录本身只记「未使用」，「已过期」是按当前时间推出来的展示状态
      status: "unused",
      claimedAt: "2026-07-20T08:00:00.000Z",
    },
  ] satisfies PresetClaimInput[]
).map((input) => {
  const coupon = requireCoupon(input.couponId);

  return {
    id: input.id,
    userId: "u-1001",
    couponId: coupon.id,
    status: input.status,
    claimedAt: input.claimedAt,
    usedAt: input.usedAt ?? null,
    // 券面快照：领取那一刻的内容，之后券改名改文案不影响已有记录
    snapshot: {
      name: coupon.name,
      formKey: coupon.formKey,
      formLabel: coupon.formLabel,
      valueLabel: coupon.valueLabel,
      conditionLabel: coupon.conditionLabel,
      validFrom: coupon.validFrom,
      validTo: coupon.validTo,
    },
  } satisfies CouponClaim;
});
