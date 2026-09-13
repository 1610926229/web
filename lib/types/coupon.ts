import type { PageResult } from "./common";

/**
 * 优惠券类型与对外 DTO。
 *
 * ⚠️ 本阶段的优惠券是**展示用的 Mock 券面**，刻意不参与任何金额计算：
 *
 * - 券面值（`valueLabel`）只是一句展示文案，不是可参与运算的数字，因此不存在
 *   「满减怎么算、能不能叠加、能不能与折扣同享」这类尚未确认的规则；
 * - 结算（P4）完全不读这里的数据，`lib/services/checkout.ts` 也不会引用本模块，
 *   所以领券不会让订单金额发生变化——这是本阶段最重要的一条边界。
 *
 * 将来确认了券的适用范围、叠加与排他规则之后，再引入金额字段与核销逻辑；
 * 在那之前，任何「顺手算一下能减多少」的实现都是提前替产品做了决定。
 */

/**
 * 优惠形式。只作为**展示分类**（原型卡片上的一行字），不是计算规则。
 * 取值由服务端校验，文案与浏览器共用 `lib/constants/coupons.ts`。
 */
export type CouponFormKey = "threshold" | "discount" | "gift";

/** 券面快照：领取那一刻的券面内容，之后券的文案改了不影响已领取的记录。 */
export type CouponSnapshot = {
  name: string;
  formKey: CouponFormKey;
  /** 优惠形式的展示文案，如「满减券」 */
  formLabel: string;
  /** 券面值展示文案（Mock 文案，不参与计算） */
  valueLabel: string;
  /** 使用条件的展示文案 */
  conditionLabel: string;
  /** 有效期起（ISO） */
  validFrom: string;
  /** 有效期止（ISO） */
  validTo: string;
};

/**
 * 券模板（领券中心里可领取的券）。
 *
 * `enabled` 由平台侧决定：停用的券还能看到（否则已领取的人会以为券凭空消失），
 * 但不能再领取。
 */
export type Coupon = CouponSnapshot & {
  id: string;
  /** 平台是否启用；停用后不可再领取 */
  enabled: boolean;
};

/**
 * 用户领取记录（仓储内部类型）。
 *
 * 只记「未使用 / 已使用」两个**由平台写入**的状态；`expired` 是**按当前时间推导**的
 * 展示状态（见 `couponDisplayStatus`），不落库——否则一张没被用掉的券会永远停在
 * 「未使用」上，除非有人跑一个定时任务去改它。
 */
export type CouponClaimStatus = "unused" | "used";

/** 展示状态：在领取记录状态之上叠加「已过期」。 */
export type CouponDisplayStatus = CouponClaimStatus | "expired";

export type CouponClaim = {
  id: string;
  userId: string;
  couponId: string;
  status: CouponClaimStatus;
  claimedAt: string;
  usedAt: string | null;
  /** 领取那一刻的券面快照 */
  snapshot: CouponSnapshot;
};

/**
 * 「我的优惠券」列表项 DTO。
 *
 * 只返回当前用户的领取记录，且只带券面展示所需的字段：`userId`、券模板 id 之外的
 * 内部字段（如幂等索引）一律不出现。
 */
export type OwnedCouponItem = {
  /** 领取记录 id */
  id: string;
  couponId: string;
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  status: CouponDisplayStatus;
  /** 状态文案。由服务端按同一套规则算好，前端不自己推导，避免两侧口径不一致 */
  statusLabel: string;
  claimedAt: string;
  usedAt: string | null;
};

/**
 * 「领券中心」列表项 DTO。
 *
 * `claimable` / `reason` / `claimed` **都由服务端判定**：券是否停用、是否过期、
 * 当前用户是否已经领过，前端只负责按值显示按钮与说明，不自己推断。
 */
export type ClaimableCouponItem = {
  id: string;
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  /** 当前用户能否领取 */
  claimable: boolean;
  /** 不能领取时的说明；能领取时为空串 */
  reason: string;
  /** 当前用户是否已经领取过 */
  claimed: boolean;
};

/** 两个 Tab 上的数量。每次列表请求都会带上，避免前端自己加减导致角标漂移。 */
export type CouponTabCounts = {
  /** 我的优惠券：我的领取记录数 */
  owned: number;
  /** 可领取：我还没领过、且当前可领取的券数 */
  claimable: number;
};

/**
 * 一次列表请求的返回：分页结果 + 两个 Tab 的数量 + 本次的 Tab。
 *
 * 两个 Tab 各有一个**具体的**类型（`tab` 是字面量），而不是一个泛型：
 * 服务端返回的是二者的联合，页面据此判断该渲染哪个列表，不需要任何类型断言；
 * 客户端组件也能安全引用这些形状（类型文件没有运行时依赖，
 * 而服务端模块依赖 `lib/data` 与 `lib/mocks`，客户端不该 import 它）。
 */
export type OwnedCouponPage = PageResult<OwnedCouponItem> & {
  tab: "owned";
  counts: CouponTabCounts;
};

export type ClaimableCouponPage = PageResult<ClaimableCouponItem> & {
  tab: "claimable";
  counts: CouponTabCounts;
};

/** 列表接口的返回：哪个 Tab 就是哪一份，联合里带得下。 */
export type CouponListPage = OwnedCouponPage | ClaimableCouponPage;

/** 领取结果。重复领取不再是错误：`created` 为 false 且返回第一次的结果。 */
export type CouponClaimResult = {
  claimId: string;
  couponId: string;
  created: boolean;
};
