import type { PageResult } from "@/lib/types/common";
import type {
  Coupon,
  CouponClaim,
  CouponDisplayStatus,
  CouponFormKey,
  OwnedCouponItem,
} from "@/lib/types/coupon";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 优惠券的状态、文案与查询规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type`，没有运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三条边界，写在这里是为了让「不能做」和「能做」一样明确：
 *
 * 1. **券面值不参与计算**。`valueLabel` 是展示文案，「减多少、能不能叠加」属于尚未确认的
 *    规则，本阶段一律不实现，因此这里没有任何金额运算函数。
 * 2. **能不能领由服务端判定**。`couponClaimability` 是唯一的判定实现，页面与接口共用，
 *    前端不自己看时间推断。
 * 3. **已过期是推导出来的展示状态**。券一旦过期，展示状态就变成「已过期」，
 *    不需要任何人去改记录。
 */

/** 优惠形式的展示文案。**唯一一份**，接口与页面共用。 */
export const COUPON_FORM_LABELS: Record<CouponFormKey, string> = {
  threshold: "满减券",
  discount: "折扣券",
  gift: "无门槛券",
};

export const COUPON_FORM_KEYS: readonly CouponFormKey[] = ["threshold", "discount", "gift"];

export function isCouponForm(value: string): value is CouponFormKey {
  return (COUPON_FORM_KEYS as readonly string[]).includes(value);
}

/** 三个展示状态。 */
export const COUPON_DISPLAY_STATUSES: readonly CouponDisplayStatus[] = [
  "unused",
  "used",
  "expired",
];

export const COUPON_STATUS_LABELS: Record<CouponDisplayStatus, string> = {
  unused: "未使用",
  used: "已使用",
  expired: "已过期",
};

/** 状态文字色：复用 `app/globals.css` 的 `--color-status-*` 令牌。 */
export const COUPON_STATUS_CLASS: Record<CouponDisplayStatus, string> = {
  unused: "text-status-pending",
  used: "text-status-muted",
  expired: "text-status-muted",
};

/**
 * 券面底色类名。
 *
 * 原型只有空态（暂无优惠券），没有给出券卡片的具体视觉：这里按「未使用 / 其他」
 * 两档给出克制的样式差异，不自行发明券的视觉语言（原生图待确认后再对齐）。
 */
export const COUPON_CARD_CLASS: Record<CouponDisplayStatus, string> = {
  unused: "border-brand-red/40",
  used: "border-line",
  expired: "border-line",
};

/**
 * 两个 Tab。
 *
 * 原型文案是「已拥有 / 可领取」，这里照抄；`heading` 是每个 Tab 内部的小标题，
 * 让「我的优惠券 / 领券中心」这两个说法在页面上有落点（需求里用的是后一种说法）。
 */
export type CouponTabKey = "owned" | "claimable";

export const COUPON_TABS: readonly { key: CouponTabKey; label: string; heading: string }[] = [
  { key: "owned", label: "已拥有", heading: "我的优惠券" },
  { key: "claimable", label: "可领取", heading: "领券中心" },
];

export const COUPON_TAB_INVALID_MESSAGE = "优惠券列表类型无效";

export const COUPON_PAGE_SIZE = 10;
export const COUPON_MAX_PAGE_SIZE = 20;
export const COUPON_MAX_PAGE = 1000;

/** 找不到券（或券已被移除）时的提示。**与「不属于当前用户」用同一句话**，避免被用来试探。 */
export const COUPON_NOT_FOUND_MESSAGE = "优惠券不存在";

/** 不可领取的三种原因。文案只有一份，按钮旁边的说明与接口报错都用它。 */
export const COUPON_DISABLED_REASON = "该券已停用，暂时无法领取";
export const COUPON_EXPIRED_REASON = "该券已过有效期，无法领取";
/** 还没到有效期的券同样不能领（原型与需求都没提「预约领取」这类玩法）。 */
export const COUPON_NOT_STARTED_REASON = "该券尚未开始，暂时无法领取";

/** 已领取的标识（领券中心里按钮上的文字）。 */
export const COUPON_CLAIMED_LABEL = "已领取";

export const COUPON_CLAIM_BUTTON_LABEL = "立即领取";
export const COUPON_CLAIM_PENDING_LABEL = "领取中…";

/**
 * 券面数据的性质说明。
 *
 * 这句必须出现在页面上：券面值是 Mock 文案，且优惠券**不影响结算金额**——
 * 不说清楚的话，「领了券下单却没便宜」就成了一个看起来像 Bug 的现象。
 */
export const COUPON_MOCK_NOTICE =
  "券面内容为本地 Mock 数据，仅用于展示。优惠券当前不参与结算，领取后不会改变订单金额，也不支持核销。";

/** 查询条件。 */
export type CouponListQueryInput = {
  tab: CouponTabKey;
  page: number;
  pageSize: number;
};

/** 解析 Tab：空串按默认（已拥有）处理，非法值失败。 */
export function parseCouponTab(raw: string | null): CouponTabKey | "invalid" {
  const value = (raw ?? "").trim();
  if (!value) return "owned";
  return value === "owned" || value === "claimable" ? value : "invalid";
}

/**
 * 解析优惠券列表的查询条件。
 *
 * 与订单 / 投诉列表同一套行为：Tab 取值非法直接失败（不静默回退），
 * 分页参数规范化到安全范围。
 */
export function parseCouponListQuery(
  params: URLSearchParams,
): { ok: true; query: CouponListQueryInput } | { ok: false; message: string } {
  const tab = parseCouponTab(params.get("tab"));
  if (tab === "invalid") return { ok: false, message: COUPON_TAB_INVALID_MESSAGE };

  return {
    ok: true,
    query: {
      tab,
      page: clampPage(params.get("page"), COUPON_MAX_PAGE),
      pageSize: clampPageSize(params.get("pageSize"), COUPON_PAGE_SIZE, COUPON_MAX_PAGE_SIZE),
    },
  };
}

/**
 * 领取记录的展示状态：已使用 > 已过期 > 未使用。
 *
 * 「已过期」是**按当前时间推出来的**，不是记录里的一个字段：一张没被用掉的券过期后
 * 展示状态自然变成「已过期」，不需要有人去改数据。
 */
export function couponDisplayStatus(
  claim: Pick<CouponClaim, "status" | "snapshot">,
  now: Date,
): CouponDisplayStatus {
  if (claim.status === "used") return "used";
  return isExpiredAt(claim.snapshot.validTo, now) ? "expired" : "unused";
}

/** 有效期是否已过：`validTo` 当天的结束时刻之前都算有效。 */
export function isExpiredAt(validTo: string, now: Date): boolean {
  const time = Date.parse(validTo);
  if (!Number.isFinite(time)) return true;
  return now.getTime() > time;
}

/**
 * 能不能领取。
 *
 * 三种情况不可领取，顺序即优先级：**已停用 → 已过期 → 在有效期内才能领**。
 * 判定只此一处：页面用它渲染按钮与说明，接口用它决定是否写入。
 */
export function couponClaimability(
  coupon: Pick<Coupon, "enabled" | "validFrom" | "validTo">,
  now: Date,
): { claimable: boolean; reason: string } {
  if (!coupon.enabled) return { claimable: false, reason: COUPON_DISABLED_REASON };

  const from = Date.parse(coupon.validFrom);
  if (Number.isFinite(from) && now.getTime() < from) {
    return { claimable: false, reason: COUPON_NOT_STARTED_REASON };
  }
  if (isExpiredAt(coupon.validTo, now)) {
    return { claimable: false, reason: COUPON_EXPIRED_REASON };
  }

  return { claimable: true, reason: "" };
}

/**
 * 领取记录的默认排序：领取时间倒序，最新的在最前面。
 *
 * 时间相同时用 id 兜底，保证同一份数据每次排出来的顺序完全一致，
 * 否则分页时同一条记录可能先在第二页出现、又在第一页出现。
 */
export function compareClaimsNewestFirst(
  a: { claimedAt: string; id: string },
  b: { claimedAt: string; id: string },
): number {
  if (a.claimedAt !== b.claimedAt) return a.claimedAt < b.claimedAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 券的默认排序：有效期晚的在前，其次按 id，保证顺序稳定。 */
export function compareCouponsNewestFirst(
  a: { validTo: string; id: string },
  b: { validTo: string; id: string },
): number {
  if (a.validTo !== b.validTo) return a.validTo < b.validTo ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 领取记录 → 「我的优惠券」列表项。**显式挑字段**：`userId` 与内部索引不会出现。 */
export function toOwnedCouponItem(claim: CouponClaim, now: Date): OwnedCouponItem {
  const status = couponDisplayStatus(claim, now);
  return {
    id: claim.id,
    couponId: claim.couponId,
    name: claim.snapshot.name,
    formLabel: claim.snapshot.formLabel,
    valueLabel: claim.snapshot.valueLabel,
    conditionLabel: claim.snapshot.conditionLabel,
    validFrom: claim.snapshot.validFrom,
    validTo: claim.snapshot.validTo,
    status,
    statusLabel: COUPON_STATUS_LABELS[status],
    claimedAt: claim.claimedAt,
    usedAt: claim.usedAt,
  };
}

/**
 * 「加载更多」的合并：追加 + 按 id 去重，通用规则在 `lib/constants/pagination.ts`。
 * 优惠券列表与订单、投诉列表因此共用同一套行为。
 */
export function mergeCouponPage<T extends { id: string }, P extends PageResult<T>>(
  current: P,
  next: P,
): P {
  return mergePageResult(current, next);
}

