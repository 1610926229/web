import type { PageResult } from "@/lib/types/common";
import type {
  Coupon,
  CouponClaim,
  CouponClaimSource,
  CouponDisplayStatus,
  CouponFormKey,
  CouponSnapshot,
  OwnedCouponItem,
} from "@/lib/types/coupon";
import type { OrderCouponSnapshot } from "@/lib/types/order";
import { formatYuan } from "@/lib/utils/format";
import { resolveCouponDiscountAmount } from "./orderAmount";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 优惠券的状态、文案与查询规则（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type`、`./orderAmount`、`./pagination` 与 `@/lib/utils/format`
 * （三者同样是纯函数模块，都不 import 任何东西），没有服务端依赖：
 * 客户端组件引用它不会把 `lib/data` 或 `lib/mocks` 打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * ⚠️ 金额一律用 `formatYuan`（**恒两位小数**）。本文件曾经自带一个 `formatCouponYuan`
 * 去掉尾部零，与全站口径不符（¥70.10 会显示成「¥70.1」），已删除。
 *
 * 四条边界，写在这里是为了让「不能做」和「能做」一样明确：
 *
 * 1. **展示文案与金额是两件事**。`valueLabel` / `conditionLabel` **永远不参与计算**；
 *    能算的只有 `thresholdAmount` / `discountAmount`（整数分），且只有满减券有值。
 *    「用正则从券面文案里抠数字」这类做法一律不做——文案改一个字就会算错钱。
 * 2. **能不能领由服务端判定**。`couponClaimability` 是唯一的判定实现，页面与接口共用，
 *    前端不自己看时间推断。
 * 3. **能不能用另有一套判定**（P1-4）：`resolveCouponApplication` 是**唯一的**实现，
 *    preview 与正式下单共用它，因此两边不可能给出不同的结论。
 *    ⚠️ 它与 `couponClaimability` **不是同一个问题**：领的时候说「无法领取」，
 *    用的时候说「无法领取」会让人以为要去重新领一张。
 * 4. **已过期是推导出来的展示状态**。券一旦过期，展示状态就变成「已过期」，
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

/**
 * 来源文案（P1-4 验收整改轮 §六）。
 *
 * ⚠️ 管理员发的那张也要让**用户**看出来源：同一个人可能手里同时躺着
 * 自己领的一张和客服补发的一张，两张长得一模一样。不说来源，
 * 「为什么我有两张一样的券」就变成了一个只能靠猜的问题。
 */
export const COUPON_SOURCE_LABELS: Record<CouponClaimSource, string> = {
  self_claim: "自行领取",
  admin_grant: "平台发放",
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

/* ───────────────── 使用（核销）规则的文案 ───────────────── */

/**
 * 券不能用于这一单时的说明。
 *
 * ⚠️ 与上面三个**领取**文案刻意分开：对着一张已经领到的券说「无法领取」，
 * 用户的第一反应是「那我去再领一张」——他会一直点下去，因为券明明已经在手里。
 */
export const COUPON_USE_DISABLED_REASON = "该券已停用，无法使用";
export const COUPON_USE_EXPIRED_REASON = "该券已过有效期，无法使用";
export const COUPON_USE_NOT_STARTED_REASON = "该券尚未到可用时间";
export const COUPON_USE_USED_REASON = "该券已使用";
/**
 * 核销时**找不到那张券**、或那张券不属于当前用户时的说明（PROD-1D 从
 * `couponRedemptionTransaction.ts` 搬来这里：Mock 与 PostgreSQL 两个核销实现
 * 必须用**同一句话**，否则同一次失败会在两个存储上给出两种文案）。
 *
 * ⚠️ 「不存在」与「不属于你」刻意共用一句：分开写等于提供一个
 * 「拿别人的 claimId 来试」的探测器。
 */
export const COUPON_CLAIM_NOT_FOUND_REASON = "优惠券不存在或不属于当前用户";
/** 非满减券：可计算字段恒为 null，因此不存在「优惠 0 元」这种解释空间。 */
export const COUPON_USE_UNSUPPORTED_REASON = "该券类型暂不支持抵扣";
/** 券的数据不完整（可计算字段缺失或非法）。属于坏数据，不猜、不按 0 处理。 */
export const COUPON_USE_INVALID_REASON = "该券信息异常，无法使用";

/**
 * 「我的优惠券」里那张**不能参与结算**的券上写的话（P1-4 验收整改轮 §九）。
 *
 * ⚠️ 与 `COUPON_USE_UNSUPPORTED_REASON` 是**同一件事的两种说法**，因为听众不同：
 * 在结算页，用户已经在挑券，「该券类型暂不支持抵扣」直接回答了「为什么点不动」；
 * 在账户页，用户还没看任何一单，要的是「这张券现在能不能用出去」，
 * 所以明写「暂不可用于结算」。
 *
 * 两句话必须由**同一个判定**产生（见 `resolveCouponSettlementUsability`），
 * 否则又会出现「账户说能用、结算说不能」——那正是本轮要修的缺陷。
 */
export const COUPON_SETTLEMENT_UNSUPPORTED_REASON = "暂不可用于结算（当前仅满减券参与结算）";

/** 「这张券现在能用来下单」的正面标记。 */
export const COUPON_SETTLEMENT_USABLE_LABEL = "可用于结算";

/**
 * 未达门槛的说明，**写明还差多少**（P1-4 验收整改轮 §十）。
 *
 * ⚠️ 原文案是「未满 X 元，当前 Y 元」——它把两个数字摆出来让用户自己减。
 * 裁定 §十 给的例子是「满 ¥50 可用，还差 ¥12」：差额是用户唯一能行动的信息
 * （「我再加一件就够了」），让他心算一遍没有任何好处。
 *
 * 入参是**分**，展示成元。
 */
export function couponThresholdNotMetReason(
  originalAmount: number,
  thresholdAmount: number,
): string {
  const gap = Math.max(0, thresholdAmount - originalAmount);
  return `满 ¥${formatYuan(thresholdAmount)} 可用，还差 ¥${formatYuan(gap)}`;
}

/* ───────────────── 券面文案的派生（P1-6） ───────────────── */

/**
 * 券面上的金额写法：**整数元不带小数，否则两位小数**。
 *
 * - `10_000` → `100`；`1_000` → `10`；`1_050` → `10.50`；`1_005` → `10.05`。
 *
 * ⚠️ **它只用于券面文案，不是全站金额展示口径**。全站金额一律走
 * `formatYuan()`（恒两位小数，见 `lib/utils/format.ts`），那是「¥70.10」这种
 * 金额本身的写法。券面上的「满 100 减 10」是一句**读起来像话的券名**，
 * 带上 `.00` 会变成「满 100.00 减 10.00」——那不像券，像一张对账单。
 *
 * ⚠️ 与那个被删掉的 `formatCouponYuan` 的区别：那一个对**所有**金额做去零，
 * 于是 `10.05` 会被 `toFixed(1)` 抹成 `10.1`——**改钱**。这里只在**分位为 0**
 * 时省略小数，其余一律交给 `formatYuan`，因此没有任何一位数字被丢掉。
 */
export function formatCouponYuan(cents: number): string {
  if (!Number.isFinite(cents)) return "0";
  if (cents % 100 === 0) return String(Math.trunc(cents) / 100);
  return formatYuan(cents);
}

/**
 * 满减券的券面文案 —— **由金额派生的唯一一份**（P1-6 §3）。
 *
 * ```
 * 满 100 减 10 / 全场通用，满 100 元可用
 * ```
 *
 * ## 为什么必须派生，而不能让调用方传文案
 *
 * P1-6 §3 明文：`valueLabel` / `conditionLabel` **不作为业务真值**。
 * 后台新建 / 编辑一张券时，客户端只提交 `thresholdAmount` 与 `discountAmount`，
 * 文案由这里生成。这样一来：
 *
 * - 「满 100 减 10」与 `thresholdAmount: 10_000` **不可能对不上**——
 *   它们不是两份可以各自编辑的数据，而是同一份数据的两种呈现；
 * - 客户端也就没有伪造文案的位置（与 §九「客户端伪造字段必须被忽略」同一方向）。
 *
 * ⚠️ **它只服务于后台写路径**。「文案与金额分开」这条 P1-4 的老规矩并没有被推翻：
 * 已经存在的历史模板（种子券）保留它们手写的文案，已发放的 Claim 更是保留**快照**里的
 * 那一份——本函数**不追溯**它们。理由很直接：快照是历史事实，
 * 用今天的派生规则去重写用户手里的券，等于篡改历史。
 *
 * ⚠️ 派生的输出与种子券的写法**逐字一致**（`满 100 减 10`），这不是巧合：
 * 格式一旦分叉，后台新建的券与预置的券在用户端会长得不一样。
 */
export function buildThresholdCouponLabels(
  thresholdAmount: number,
  discountAmount: number,
): { valueLabel: string; conditionLabel: string } {
  const threshold = formatCouponYuan(thresholdAmount);
  return {
    valueLabel: `满 ${threshold} 减 ${formatCouponYuan(discountAmount)}`,
    // 适用范围一律是**全场券**（P1-4 裁定 §3），因此这句话里没有「限某类商品」的位置
    conditionLabel: `全场通用，满 ${threshold} 元可用`,
  };
}

/**
 * 券面数据的性质说明。
 *
 * ⚠️ P1-4 起这句话**必须重写**：原文写着「优惠券当前不参与结算……也不支持核销」，
 * 而满减券现在真的会改订单金额并被核销。留着原文就是让页面骗人。
 *
 * 改成说明「哪些券能用」——这仍然是一句必须出现在页面上的话：
 * 券面是 Mock 数据，且只有满减券参与结算，不说清楚的话，
 * 「领了折扣券下单却没便宜」会成为一个看起来像 Bug 的现象。
 */
export const COUPON_MOCK_NOTICE =
  "券面内容为本地 Mock 数据。满减券在结算时可按面额抵扣，订单金额以结算页试算结果为准；折扣券与无门槛券目前仅作展示，暂不支持抵扣。";

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

/* ───────────────── 能不能用（P1-4） ───────────────── */

/**
 * 这种券**能不能参与抵扣**（P1-4 裁定 §1：只有满减券）。
 *
 * 判断券能否抵扣的唯一依据就是它。不要再散落 `formKey === "threshold"`——
 * 将来放开第二种券时，改这里一处即可，而散落的写法会让「页面允许选、服务端拒绝」
 * 这种最难受的分裂状态出现。
 */
export function isComputableCouponForm(formKey: CouponFormKey): boolean {
  return formKey === "threshold";
}

/**
 * 券不能用的原因分类（**机器可读**）。
 *
 * ⚠️ 它存在的唯一理由是：**调用方需要按原因分流**，而 `reason` 是给人看的一句话。
 * 让调用方去匹配文案前缀（`reason.startsWith("未满")`）会把一句文案变成契约——
 * 文案改一个字，功能就悄悄坏了。有了 code，文案随便改，分流不受影响。
 *
 * 目前只有一处用到分流：结算页列出可选券时，**只有 `threshold_not_met` 要留下**
 * （那是用户唯一能靠自己解决的），其余统统不展示。将来若没有第二种分流需求，
 * 这个字段仍然值得留——它同时也是日志与排查的分类。
 */
export type CouponDenialCode =
  | "used"
  | "disabled"
  | "not_started"
  | "expired"
  | "unsupported_form"
  | "invalid_data"
  | "threshold_not_met";

/** `resolveCouponApplication()` 的结论。`applicable` 为 false 时 `reason` 一定非空。 */
export type CouponApplication =
  | { applicable: true; discountAmount: number; reason: ""; code: null }
  | { applicable: false; discountAmount: 0; reason: string; code: CouponDenialCode };

/**
 * **与具体订单无关的那几道闸**——「这张券此刻本身有没有资格被用掉」。
 *
 * 判定顺序即优先级，与 `couponClaimability` 一致（停用 → 时间 → 其他），
 * 因为「券被平台停用」比「这张券类型不支持」更接近用户的第一个疑问。
 *
 * ## 为什么把它单独拆出来（P1-4 验收整改轮 §八 / §九）
 *
 * 人工验收发现的缺陷是：**账户页写「可用」、结算页永远说「暂无可用优惠券」**。
 * 根因正是这里曾经有**两套**口径——
 *
 * | 页面 | 当年用的判定 | 看得到什么 |
 * |---|---|---|
 * | 我的优惠券 | `couponDisplayStatus()` | 只有 `status` 与快照 `validTo` |
 * | 结算页 | `resolveCouponApplication()` | 还要看 `formKey`、模板 `enabled`、门槛 |
 *
 * 于是「一张 `unused` 的折扣券」在账户页是**未使用（= 可用）**，
 * 在结算页却因为 `unsupported_form` 被整个滤掉。两边都没算错，**是口径分叉了**。
 *
 * 修法不是把两句话调成一样，而是**只留一个口径**：
 * 把 `resolveCouponApplication()` 拆成「本函数（前置闸）」+「门槛闸」。
 * 结算页用两段；账户页只用这一段（它没有订单金额，谈不上门槛）。
 * 这样「账户说可用、结算说不可用」在结构上不可能再出现。
 *
 * ⚠️ **它回答不了「这一单够不够门槛」**——那一问必须给出 `originalAmount`，
 * 因此只属于 `resolveCouponApplication()`。
 */
export function resolveCouponClaimGate(
  claim: Pick<CouponClaim, "status" | "snapshot">,
  now: Date,
  /** 券模板此刻是否启用。裁定未明文，本实现按「停用后已领的也不能再用」处理 */
  couponEnabled: boolean,
): { ok: true } | { ok: false; code: CouponDenialCode; reason: string } {
  // 已经用掉的券不能再选。它与「已过期」不同：过期是时间推出来的，这个是写下来的事实
  if (claim.status === "used") {
    return { ok: false, code: "used", reason: COUPON_USE_USED_REASON };
  }

  if (!couponEnabled) {
    return { ok: false, code: "disabled", reason: COUPON_USE_DISABLED_REASON };
  }

  const from = Date.parse(claim.snapshot.validFrom);
  if (Number.isFinite(from) && now.getTime() < from) {
    return { ok: false, code: "not_started", reason: COUPON_USE_NOT_STARTED_REASON };
  }
  if (isExpiredAt(claim.snapshot.validTo, now)) {
    return { ok: false, code: "expired", reason: COUPON_USE_EXPIRED_REASON };
  }

  // 非满减券：两个可计算字段恒为 null，因此这里一定被拦下——不会静默按 0 元放行
  if (!isComputableCouponForm(claim.snapshot.formKey)) {
    return { ok: false, code: "unsupported_form", reason: COUPON_USE_UNSUPPORTED_REASON };
  }

  const { thresholdAmount, discountAmount } = claim.snapshot;
  // 满减券却没有金额：坏数据。猜一个门槛或面额都比拒绝更危险
  if (thresholdAmount === null || discountAmount === null) {
    return { ok: false, code: "invalid_data", reason: COUPON_USE_INVALID_REASON };
  }
  if (!Number.isFinite(thresholdAmount) || !Number.isFinite(discountAmount)) {
    return { ok: false, code: "invalid_data", reason: COUPON_USE_INVALID_REASON };
  }

  return { ok: true };
}

/**
 * **一张券能不能用在原价为 `originalAmount` 的这一单上**——唯一的判定实现。
 *
 * 调用方有三处，全部共用本函数，因此「试算说能用、下单却被拒」这种分叉在结构上
 * 不可能出现（`previewCheckout` 与 `createPaymentRequest` 在 `lib/services/checkout.ts`，
 * 核销在 `lib/data/couponRedemptionTransaction.ts`）：试算把结论返回给界面、
 * 下单直接抛 400、核销返回失败原因——**三处判的是同一件事**。
 *
 * ⚠️ 前置闸全部委托给 `resolveCouponClaimGate()`（见那里对「两套口径」的说明），
 * 本函数只负责**再**加上门槛那一问。
 *
 * ⚠️ **门槛基数用 `originalAmount`（优惠前应付）**，不是实付、也不是分账基数
 * （裁定 §2）。三者当前数值相同，但原价才是「这一单买了多少钱」的定义。
 *
 * ⚠️ 本函数是**纯函数、只读**：它不消耗任何东西，因此试算可以随便调。
 * 真正的核销发生在支付成功的原子区段（`lib/data/couponRedemptionTransaction.ts`）。
 */
export function resolveCouponApplication(
  claim: Pick<CouponClaim, "status" | "snapshot">,
  originalAmount: number,
  now: Date,
  /** 券模板此刻是否启用。裁定未明文，本实现按「停用后已领的也不能再用」处理 */
  couponEnabled: boolean,
): CouponApplication {
  const gate = resolveCouponClaimGate(claim, now, couponEnabled);
  if (!gate.ok) {
    return { applicable: false, discountAmount: 0, reason: gate.reason, code: gate.code };
  }

  // 上面那道闸已经排除了 null / 非有限值，因此这里两个数一定是合法整数
  const { thresholdAmount, discountAmount } = claim.snapshot as {
    thresholdAmount: number;
    discountAmount: number;
  };

  if (originalAmount < thresholdAmount) {
    return {
      applicable: false,
      discountAmount: 0,
      reason: couponThresholdNotMetReason(originalAmount, thresholdAmount),
      code: "threshold_not_met",
    };
  }

  // 抵扣额夹到不超过原价：保证 `actualPaidAmount >= 0`（裁定 §2）。
  // 夹取是**向下封顶**，不是把券作废——满 10 减 100 的券在这一单上就该抵到 0 元
  return {
    applicable: true,
    discountAmount: resolveCouponDiscountAmount(discountAmount, originalAmount),
    reason: "",
    code: null,
  };
}

/**
 * **账户页口径**：这张券此刻能不能参与结算（P1-4 验收整改轮 §九）。
 *
 * 就是前置闸，**只把「非满减券」那句话换成账户页的措辞**——
 * 因为站在账户页的用户还没看任何一单，「暂不支持抵扣」不如「暂不可用于结算」直白。
 * 判定本身一个字都没改，两处不可能分叉。
 */
export function resolveCouponSettlementUsability(
  claim: Pick<CouponClaim, "status" | "snapshot">,
  now: Date,
  couponEnabled: boolean,
): { usable: boolean; reason: string } {
  const gate = resolveCouponClaimGate(claim, now, couponEnabled);
  if (gate.ok) return { usable: true, reason: "" };

  return {
    usable: false,
    reason:
      gate.code === "unsupported_form" ? COUPON_SETTLEMENT_UNSUPPORTED_REASON : gate.reason,
  };
}

/**
 * **券模板 → 券面快照**：把一张券「此刻是什么」冻结下来（P1-4 裁定 §九）。
 *
 * ## 为什么它必须是一个**共用**函数（验收整改轮 §七）
 *
 * 现在有**两条**路径会产生 Claim 快照：
 *
 * | 路径 | 触发 |
 * |---|---|
 * | 用户自己领 | `lib/services/coupons.ts` 的 `claimCouponForUser` |
 * | 管理员发放 | `lib/services/adminCoupons.ts` 的 `grantCouponToUser` |
 *
 * 裁定 §七 要求后者「同样按照当前 Coupon 模板生成 snapshot」，且**模板后续修改
 * 不得追溯已发出的 Claim**。两条路径各写一份字段列表，迟早会有一条忘了加新字段
 * （比如将来多一个 `scope`），于是「自己领的券有 scope、管理员发的没有」——
 * 而那种缺失只会在结算时才暴露。
 *
 * ⚠️ **从券模板取，不从任何 Claim 取**：发放/领取那一刻的模板就是这张券的全部内容。
 * 冻结之后模板怎么改都与已有 Claim 无关了。
 */
export function toCouponSnapshot(coupon: Coupon): CouponSnapshot {
  return {
    name: coupon.name,
    formKey: coupon.formKey,
    formLabel: coupon.formLabel,
    valueLabel: coupon.valueLabel,
    conditionLabel: coupon.conditionLabel,
    validFrom: coupon.validFrom,
    validTo: coupon.validTo,
    // 两个可计算字段进快照（P1-4 裁定 §9）：券面文案与券的金额是**同一份冻结**，
    // 此后改券模板不追溯已发出的记录
    thresholdAmount: coupon.thresholdAmount,
    discountAmount: coupon.discountAmount,
  };
}

/**
 * 领取记录 → 订单上的券快照（P1-4 裁定 §9 要求冻结的那几个字段）。
 *
 * ⚠️ 从**领取记录的 `snapshot`** 取，不从券模板取：订单要冻结的是「用户手里那张券
 * 长什么样」，而券模板可能在领取之后被改过（见 `CouponSnapshot` 的说明）。
 * `couponId` 单独传，因为领取记录上它不在 `snapshot` 里。
 *
 * `claimId` 是本实现多加的一个字段（裁定 §9 说的是「至少」）：没有它，
 * `Order.coupon` 回答不了「这张券被哪一单用掉了」，追溯只能靠遍历。
 */
export function toOrderCouponSnapshot(
  claim: Pick<CouponClaim, "id" | "couponId" | "snapshot">,
): OrderCouponSnapshot {
  return {
    claimId: claim.id,
    couponId: claim.couponId,
    name: claim.snapshot.name,
    formKey: claim.snapshot.formKey,
    thresholdAmount: claim.snapshot.thresholdAmount,
    discountAmount: claim.snapshot.discountAmount,
    valueLabel: claim.snapshot.valueLabel,
    conditionLabel: claim.snapshot.conditionLabel,
  };
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
export function toOwnedCouponItem(
  claim: CouponClaim,
  now: Date,
  /**
   * 券模板此刻是否启用。**必须由调用方查出来传进来**（它在券模板上，不在 Claim 上）。
   *
   * ⚠️ 这是本函数签名在验收整改轮里唯一的变化，而它是必须的：
   * 「能不能用于结算」要判模板 `enabled`，不传就只能漏判，
   * 而漏判的后果正是账户页把一张已停用的券标成「可用于结算」。
   */
  couponEnabled: boolean,
): OwnedCouponItem {
  const status = couponDisplayStatus(claim, now);
  const settlement = resolveCouponSettlementUsability(claim, now, couponEnabled);
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
    source: claim.source,
    sourceLabel: COUPON_SOURCE_LABELS[claim.source],
    settlementUsable: settlement.usable,
    settlementReason: settlement.reason,
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

