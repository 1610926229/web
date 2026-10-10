import { COUPON_FORM_LABELS } from "@/lib/constants/coupons";
import type { Coupon, CouponClaim, CouponFormKey } from "@/lib/types/coupon";

/**
 * 预置优惠券种子（券模板 + 用户的领取记录）。
 *
 * ⚠️ 券面是**本地 Mock 数据**，`valueLabel` / `conditionLabel` 是展示文案，
 * **不参与运算**；能算的只有 `thresholdAmount` / `discountAmount`（整数分），
 * 而它们只对满减券有值（P1-4 裁定 §1：其余两种形态不参与结算）。
 * 适用范围一律是**全场券**（裁定 §3）、一单一张不叠加（裁定 §4）——
 * 这两条是全局规则，种子里没有、也不需要任何表达它们的地方。
 *
 * 种子要覆盖的边界：
 * - 可领取 / 已停用 / 已过期 / 尚未开始，四种情况在领券中心里都能看到；
 * - 满减券三种门槛（满 50 / 满 100 / 满 200）与两种不可计算形态（折扣 / 无门槛），
 *   便于在结算页观察「能用 / 未达门槛 / 类型不支持」三种结论；
 * - 已有领取记录的券，在领券中心里显示「已领取」而不是再领一次；
 * - 「我的优惠券」覆盖未使用 / 已使用 / 已过期三种展示状态。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

/**
 * 种子券模板的建档与最后改动时刻（P1-6 起 `Coupon` 上多了这两个字段）。
 *
 * ⚠️ **写死一个常量**，不用 `new Date()`：种子数据每次建仓都要**完全一样**，
 * 否则「同一条记录」在不同次运行里的 `createdAt` 不同，任何按它的断言都会变成
 * 一条偶尔为真、偶尔为假的用例。除 `cpn-mock-disabled` 外全部相同——
 * 那一张是「被停用过」的样本，它的 `updatedAt` 应当晚于建档时刻，
 * 否则后台列表上会出现一条「停用了但从未被改过」的记录。
 */
const SEED_CREATED_AT = "2025-12-20T00:00:00.000Z";
const SEED_UPDATED_AT = "2025-12-20T00:00:00.000Z";
/** 已停用那张券的最后改动时刻（晚于建档），见上。 */
const SEED_DISABLED_UPDATED_AT = "2026-01-05T00:00:00.000Z";

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
  /** 不填用种子统一的建档时刻 */
  updatedAt?: string;
};

function build(input: PresetCouponInput): Coupon {
  // 满减券的金额从 `valueLabel` **人工对照**着写下来，不做解析：
  // 「满 100 减 10」里的数字是文案的一部分，用正则抠出来就等于让文案变成契约——
  // 改一个字（「满 100 立减 10」）就会算错钱。两个字段显式写，改文案时必须一起看
  const amounts = THRESHOLD_AMOUNTS[input.id] ?? null;
  if (input.formKey === "threshold" && !amounts) {
    throw new Error(`Mock 种子缺失满减金额：${input.id}（满减券必须给出金额，不能只有文案）`);
  }

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
    thresholdAmount: amounts ? amounts.threshold : null,
    discountAmount: amounts ? amounts.discount : null,
    // 后台用的两条时间戳（P1-6）。**不进 `CouponSnapshot`**：
    // 它们描述的是模板而不是用户手里那张券，领取记录里不该出现。
    createdAt: SEED_CREATED_AT,
    updatedAt: input.updatedAt ?? SEED_UPDATED_AT,
  };
}

/**
 * 满减券的金额（**整数分**）——与上面 `valueLabel` 一一对应，改一个必须改另一个。
 *
 * ⚠️ 这正是「文案与金额分开」的代价：多一处要同步。之所以仍然这么选，
 * 是因为另一条路（从文案里解析数字）会让**用户看到的那句话**决定订单金额，
 * 而那句话随时可能被改得更好读。分开之后，最坏情况只是两者不一致，
 * 而上面 `build()` 的断言会让「满减券没写金额」这种情形直接启动失败。
 */
const THRESHOLD_AMOUNTS: Record<string, { threshold: number; discount: number }> = {
  "cpn-mock-new-user": { threshold: 10_000, discount: 1_000 }, // 满 100 减 10
  "cpn-mock-expired": { threshold: 5_000, discount: 500 }, // 满 50 减 5
  "cpn-mock-upcoming": { threshold: 20_000, discount: 3_000 }, // 满 200 减 30
};

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
    updatedAt: SEED_DISABLED_UPDATED_AT,
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
    // 这三条预置记录都是「用户自己在领券中心领的」——种子里没有管理员发放的样本。
    // `source` 是必填字段（P1-4 验收整改轮 §六）：必填之后，任何新增的构造点
    // 在编译期就必须声明来源，不会像可选字段那样被静默漏成 undefined。
    source: "self_claim",
    claimedAt: input.claimedAt,
    usedAt: input.usedAt ?? null,
    // 自己领的券没有发放人。它与 source 互为充要条件（`admin_grant` ⇔ 非 null）
    grantedByAdminId: null,
    // 券面快照：领取那一刻的内容，之后券改名改文案改面额都不影响已有记录。
    // 两个金额字段也在里面（P1-4 裁定 §9）：券面文案与券的金额是**同一份冻结**
    snapshot: {
      name: coupon.name,
      formKey: coupon.formKey,
      formLabel: coupon.formLabel,
      valueLabel: coupon.valueLabel,
      conditionLabel: coupon.conditionLabel,
      validFrom: coupon.validFrom,
      validTo: coupon.validTo,
      thresholdAmount: coupon.thresholdAmount,
      discountAmount: coupon.discountAmount,
    },
  } satisfies CouponClaim;
});
