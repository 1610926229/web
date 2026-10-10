import type { PageResult } from "@/lib/types/common";
import type { EvidenceKind } from "@/lib/types/evidence";
import type { Order, OrderCompanionSnapshot, OrderStatus } from "@/lib/types/order";
import type {
  OrderReview,
  PublicReviewItem,
  ReviewAggregate,
  ReviewAllowedActions,
  ReviewDimension,
  ReviewDimensionKey,
  ReviewListItem,
  ReviewPendingItem,
  ReviewRange,
  ReviewRating,
  ReviewStatus,
  ReviewTabKey,
} from "@/lib/types/review";
import { BEIJING_OFFSET_MINUTES } from "@/lib/utils/format";
import { countCharacters, maskNickname } from "@/lib/utils/text";
import { clampPage, clampPageSize, mergePageResult, mergePageResultBy } from "./pagination";

/**
 * 评价的规则、文案与查询条件（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除 `lib/utils/text.ts`（字符计数 + 昵称脱敏）与 `lib/utils/format.ts`
 * （北京时间偏移常量）这两个纯函数模块外没有运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ## 本文件承载的四条口径（页面、接口、测试共用同一份实现）
 *
 * 1. **能不能评价**由 `canReviewOrder` 判定，且**只看 `completedAt`**（`D18` / `D19`）。
 *    这是一个刻意的收窄：评价资格问的是「这一单的服务完成过没有」，而不是「订单现在什么状态」。
 *    两者会分叉——已完成的订单后来全额退款，状态变成 `refunded`，但服务确实完成过，
 *    评价资格**不受影响**；反过来，付款后没完成就退款的订单**从来就没有** `completedAt`，
 *    自然评不了。用订单状态去判会把这两类订单**判反**。
 * 2. **公开面只认 `approved`**（`D14`）：平均分、评价数、最近评价三处同源，
 *    由 `buildReviewAggregate` 一个函数产出，商品侧与打手侧走的是同一段代码（`R3`）。
 * 3. **`reviewCount` 数的是维度而不是评价条数**（`D15`）：一条只评了商品的评价
 *    对商品侧 +1、对打手侧 +0，因此聚合必须按维度切分后再数。
 * 4. **时间筛选**由 `isWithinReviewRange` 判定，且**必须把当前时间作为参数传入**，
 *    否则测试会在某一天突然变红、也无法验证边界。
 */

/** 星级取值范围。**只允许这五个整数**，前端与服务端共用。 */
export const REVIEW_RATINGS: readonly ReviewRating[] = [1, 2, 3, 4, 5];

export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;

/** 星级的无障碍名称（星星本身是图形，读屏用户需要文字）。 */
export const REVIEW_RATING_LABELS: Record<ReviewRating, string> = {
  1: "1 星",
  2: "2 星",
  3: "3 星",
  4: "4 星",
  5: "5 星",
};

/** 还没选评分时星级位置上的说法。 */
export const REVIEW_RATING_UNSELECTED_LABEL = "请选择";

/** 星级文案；还没选（0）或取值不合法时返回「请选择」，不留空白。 */
export function reviewRatingLabel(rating: number): string {
  return isReviewRating(rating) ? REVIEW_RATING_LABELS[rating] : REVIEW_RATING_UNSELECTED_LABEL;
}

export function isReviewRating(value: unknown): value is ReviewRating {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= REVIEW_RATING_MIN &&
    value <= REVIEW_RATING_MAX
  );
}

/* ───────────────────────── 评价维度（D1 / D2 / D3）───────────────────────── */

/** 两个评价维度的固定顺序：**商品在前、打手在后**，与结算页的阅读顺序一致。 */
export const REVIEW_DIMENSIONS: readonly ReviewDimensionKey[] = ["product", "companion"];

export const REVIEW_DIMENSION_LABELS: Record<ReviewDimensionKey, string> = {
  product: "商品",
  companion: "打手",
};

/** 页面上的完整说法（表单里的分组标题）。 */
export const REVIEW_DIMENSION_HEADINGS: Record<ReviewDimensionKey, string> = {
  product: "评价本单商品",
  companion: "评价本单打手",
};

/** 某个维度没有被评价时展示的说法。 */
export const REVIEW_DIMENSION_EMPTY_LABEL = "未评价";

export function isReviewDimensionKey(value: string): value is ReviewDimensionKey {
  return value === "product" || value === "companion";
}

/** 取一条评价里指定维度的内容。**唯一**的判断位置：调用方不再自己挑字段。 */
export function reviewDimensionOf(
  review: OrderReview,
  key: ReviewDimensionKey,
): ReviewDimension | null {
  return key === "product" ? review.productReview : review.companionReview;
}

/**
 * 某个维度指向的**聚合身份**。
 *
 * 商品维度答 `productId`；打手维度答**实际履约打手**的 id（`D4`），
 * 订单未绑定打手时为 `null`（那时打手维度必然也不存在）。
 * 这个值决定「这条评价计入谁的平均分」，与快照字段（`productTitle` / `companion.name`）无关——
 * 商品改名、打手换昵称都不会让已有的评价漂到别的对象上去（`R4`）。
 */
export function reviewDimensionOwnerId(
  review: OrderReview,
  key: ReviewDimensionKey,
): string | null {
  return key === "product" ? review.productId : (review.companion?.id ?? null);
}

/**
 * 这条评价**实际评了几个维度**（`D3` 的「至少一个」判定用的就是它）。
 *
 * 值为 0 的评价不存在——写入前会被拒——但读侧仍然按「可能为 0」写，
 * 这样将来数据出问题时页面上是「没有可展示的维度」而不是崩溃。
 */
export function countReviewDimensions(review: OrderReview): number {
  return REVIEW_DIMENSIONS.filter((key) => reviewDimensionOf(review, key) !== null).length;
}

/* ───────────────────────── 审核状态（D7 / D8 / D10）───────────────────────── */

/** 四个状态。顺序与管理员列表上的筛选 chip 一致。 */
export const REVIEW_STATUSES: readonly ReviewStatus[] = ["pending", "approved", "rejected", "hidden"];

export function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * 状态文案。
 *
 * `hidden` 的说法刻意比其它三个长且指向明确（`D8`）：作者看到「已被管理员隐藏」时
 * 需要立刻知道这不是自己操作的结果、也不是系统故障；只说「已隐藏」会让人以为是网络问题。
 */
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "审核中",
  approved: "已通过",
  rejected: "已驳回",
  hidden: "已被管理员隐藏",
};

/** 状态标签在界面上的语气（中性 / 通过 / 驳回 / 隐藏），供徽标配色使用。 */
export const REVIEW_STATUS_TONES: Record<ReviewStatus, "neutral" | "positive" | "negative"> = {
  pending: "neutral",
  approved: "positive",
  rejected: "negative",
  hidden: "negative",
};

export function reviewStatusLabel(status: ReviewStatus): string {
  return REVIEW_STATUS_LABELS[status];
}

/**
 * 状态机的全部合法迁移（`D7` / `D9` / `D11`）。
 *
 * ```
 * pending → approved / rejected      管理员审核
 * approved → hidden                  管理员隐藏（D11 可逆）
 * hidden → approved                  管理员恢复
 * rejected → pending                 用户重新提交（D9，唯一由用户触发的迁移）
 * ```
 *
 * ⚠️ **本表是状态机的唯一真值源**：服务层、管理端事务与测试都读它，
 * 不允许任何一处自己写 `if (status === "pending")` 之类的判断——
 * 那样的判断会散落在各层，加一个状态就要改很多地方，且很容易漏。
 *
 * 注意表里**没有** `approved → rejected` / `hidden → rejected`：
 * 已经公开过的内容要变成「不公开」，正确的动作是**隐藏**而不是驳回（`R2`）。
 */
export const REVIEW_STATUS_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["hidden"],
  rejected: ["pending"],
  hidden: ["approved"],
};

export function canTransitionReviewStatus(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_STATUS_TRANSITIONS[from].includes(to);
}

/** 状态迁移非法时的提示。对外只说结果，不解释状态机（避免把内部模型暴露给调用方）。 */
export const REVIEW_STATUS_TRANSITION_INVALID_MESSAGE = "当前评价状态不允许该操作";

/**
 * 管理员能做的四个动作（`D12`：**不含任何修改星级 / 正文的动作**）。
 *
 * 与状态迁移的对应关系写在 `REVIEW_MODERATION_TARGET_STATUS` 里，两者一起构成
 * 管理端审核的全部权限面——加动作时改这两处，接口、页面、审计落点会一起跟上。
 */
export type ReviewModerationAction = "approve" | "reject" | "hide" | "unhide";

export const REVIEW_MODERATION_ACTIONS: readonly ReviewModerationAction[] = [
  "approve",
  "reject",
  "hide",
  "unhide",
];

export function isReviewModerationAction(value: string): value is ReviewModerationAction {
  return (REVIEW_MODERATION_ACTIONS as readonly string[]).includes(value);
}

/** 动作 → 迁移目标状态。 */
export const REVIEW_MODERATION_TARGET_STATUS: Record<ReviewModerationAction, ReviewStatus> = {
  approve: "approved",
  reject: "rejected",
  hide: "hidden",
  unhide: "approved",
};

/**
 * 动作 → **允许发起该动作的当前状态**。
 *
 * ## 为什么不能只看「目标状态够不够得着」
 *
 * `approve` 与 `unhide` 的目标状态**都是** `approved`，而状态机里有两条边通向它：
 * `pending → approved` 与 `hidden → approved`。只按目标状态判断的话，
 * 对一条**隐藏中的**评价点「通过」也会被判成合法——写下去的数据一样，
 * 但审计里记的是 `review.approve`，读起来像「管理员通过了一条新评价」，
 * 而实际发生的是「把一条隐藏的评价恢复公开」。
 *
 * `D22` 要求审计能回答「做了什么动作」，四个动作在授权范围里也是分开列的
 * （`通过·驳回·隐藏·恢复公开`），因此动作与**起点**必须一一对应。
 *
 * ⚠️ 这张表**必须与 `REVIEW_STATUS_TRANSITIONS` 一致**：
 * 每一项的 `source → target` 都要是状态机里的一条边。`canApplyReviewModeration()`
 * 会同时校验这两件事，因此万一有人改了状态机而忘了改这里，
 * 结果是**动作被拒**（拒绝得明确），而不是放行一个状态机不允许的迁移。
 */
export const REVIEW_MODERATION_SOURCE_STATUS: Record<ReviewModerationAction, ReviewStatus> = {
  approve: "pending",
  reject: "pending",
  hide: "approved",
  unhide: "hidden",
};

/**
 * 这个动作现在能不能做。
 *
 * 两个条件缺一不可：
 * 1. 当前状态就是该动作的**起点**（`REVIEW_MODERATION_SOURCE_STATUS`）；
 * 2. 起点到目标确实是状态机里的一条边（`canTransitionReviewStatus`）。
 *
 * 第 2 条让**状态机保持唯一真值源**：这张起点表是「动作 ↔ 边」的对应关系，
 * 而不是第二份状态机。因此管理端按钮的可用性（管理端常量层）、
 * 写入侧的前置校验（伪事务）用的是同一个函数，界面不可能比服务端宽或者窄。
 *
 * ⚠️ 它**不覆盖**「已经是目标状态」那种情形（比如对已通过的评价再点一次「通过」）——
 * 那是**幂等的空操作**，由写入侧单独放行（返回 `changed: false`），
 * 而不是一个「允许的迁移」。
 */
export function canApplyReviewModeration(
  current: ReviewStatus,
  action: ReviewModerationAction,
): boolean {
  return (
    current === REVIEW_MODERATION_SOURCE_STATUS[action] &&
    canTransitionReviewStatus(current, REVIEW_MODERATION_TARGET_STATUS[action])
  );
}

/**
 * 动作 → 是否**必须**填写原因（`D10`）。
 *
 * `reject` / `hide` 要求必填：这两件事都在对用户做负面判定，不写原因用户无法修改也无法申辩。
 * `approve` 不要求：通过是默认预期，写原因只是可选备注。
 * `unhide` 不要求业务原因，但**仍然产生 AdminAudit**（`D10` / `D11`）——
 * 「谁在什么时候把一条隐藏的评价放回公开列表」本身就是要能追溯的事实，
 * 所以它不写进 DTO 的原因字段，却不能从审计里消失。
 */
export const REVIEW_MODERATION_REQUIRES_REASON: Record<ReviewModerationAction, boolean> = {
  approve: false,
  reject: true,
  hide: true,
  unhide: false,
};

/** 动作 → 管理员界面上的按钮文案。 */
export const REVIEW_MODERATION_ACTION_LABELS: Record<ReviewModerationAction, string> = {
  approve: "通过",
  reject: "驳回",
  hide: "隐藏",
  unhide: "恢复公开",
};

/** 动作 → 审计里的动作名（`D22`：沿用现有 AdminAudit，不建第二套）。 */
export const REVIEW_MODERATION_AUDIT_ACTIONS: Record<ReviewModerationAction, string> = {
  approve: "review.approve",
  reject: "review.reject",
  hide: "review.hide",
  unhide: "review.unhide",
};

/** 原因字段长度上限，与管理员其它原因字段（退款裁定 / 投诉处理）取同一口径。 */
export const REVIEW_REASON_MAX_LENGTH = 200;

export const REVIEW_REASON_REQUIRED_MESSAGE = "请填写原因";
export const REVIEW_REASON_TOO_LONG_MESSAGE = `原因不能超过 ${REVIEW_REASON_MAX_LENGTH} 个字符`;

/**
 * 规范化管理员填写的原因。
 *
 * `required` 为真时空串直接失败（`D10`：trim 之后非空才算填了）；
 * 为假时空串是合法的，统一收敛成 `null` ——「没写原因」与「写了个空串」
 * 在数据里必须是同一个值，否则读侧要判两种情况。
 */
export function normalizeReviewReason(
  raw: string,
  required: boolean,
): { ok: true; reason: string | null } | { ok: false; message: string } {
  const reason = raw.trim();
  if (!reason) {
    return required ? { ok: false, message: REVIEW_REASON_REQUIRED_MESSAGE } : { ok: true, reason: null };
  }
  if (countCharacters(reason) > REVIEW_REASON_MAX_LENGTH) {
    return { ok: false, message: REVIEW_REASON_TOO_LONG_MESSAGE };
  }
  return { ok: true, reason };
}

/* ───────────────────────── 长度与凭证 ───────────────────────── */

/**
 * 评价正文的长度上限。
 *
 * 原型没有标注字数上限，这里取一个**保守的 Mock 上限**并写在唯一一处：
 * 退款说明同样取 200，两处的口径保持一致，将来确认后只改这一个常量。
 */
export const REVIEW_CONTENT_MAX_LENGTH = 200;

export const REVIEW_CONTENT_TOO_LONG_MESSAGE = `评价内容不能超过 ${REVIEW_CONTENT_MAX_LENGTH} 个字符`;
export const REVIEW_RATING_REQUIRED_MESSAGE = "请选择评分";

/**
 * 一个维度都没有时的提示（`D3`：至少一个维度有效）。
 *
 * 说法刻意把两个选项都念出来：「请至少评价一项」容易被理解成「随便点一个地方」，
 * 而用户真正需要知道的是**可以只评商品、也可以只评打手**——否则会以为漏填了。
 */
export const REVIEW_DIMENSION_MISSING_MESSAGE = "请至少评价一项（商品或打手）";

/** 评价凭证数量上限。原型写的是「最多 4 张」，因此只收图片。 */
export const REVIEW_EVIDENCE_MAX_COUNT = 4;

/**
 * 评价凭证允许的类型。
 *
 * 与 `REVIEW_EVIDENCE_MAX_COUNT` 一起传给 `EvidencePicker` 与服务端的 `parseEvidenceInput`：
 * 界面上的入口、提示文案、服务端校验用的是同一个数组，不会出现三处口径不一致。
 */
export const REVIEW_EVIDENCE_KINDS: readonly EvidenceKind[] = ["image"];

/** 打手未绑定时页面上的固定说法：留空会让用户以为是页面没加载出来。 */
export const REVIEW_COMPANION_UNBOUND_LABEL = "未绑定";

export const REVIEW_MOCK_NOTICE =
  "评价与凭证均为本地 Mock 数据，凭证以占位图展示。评价不影响订单金额，也不参与消费等级计算。";

/** 时间筛选：取值与文案。顺序与页面上的 chip 一致。 */
export type ReviewRangeOption = { key: ReviewRange; label: string };

export const REVIEW_RANGES: readonly ReviewRangeOption[] = [
  { key: "all", label: "全部" },
  { key: "month", label: "近一月" },
  { key: "threeMonths", label: "近三月" },
  { key: "halfYear", label: "近半年" },
  { key: "year", label: "今年" },
];

const REVIEW_RANGE_KEYS = REVIEW_RANGES.map((item) => item.key);

export function isReviewRange(value: string): value is ReviewRange {
  return (REVIEW_RANGE_KEYS as readonly string[]).includes(value);
}

/** 两个 Tab：已评价在前（「我的评价」首先是已经写下的记录），待评价在后。 */
export const REVIEW_TABS: readonly { key: ReviewTabKey; label: string; heading: string }[] = [
  { key: "reviewed", label: "已评价", heading: "我的评价" },
  { key: "pending", label: "待评价", heading: "待评价订单" },
];

export function isReviewTab(value: string): value is ReviewTabKey {
  return value === "reviewed" || value === "pending";
}

export const REVIEW_PAGE_SIZE = 10;
export const REVIEW_MAX_PAGE_SIZE = 20;
export const REVIEW_MAX_PAGE = 1000;

export const REVIEW_TAB_INVALID_MESSAGE = "评价列表类型无效";
export const REVIEW_RANGE_INVALID_MESSAGE = "时间筛选无效";

/** 订单不存在、或不属于当前用户时的提示。**两种情况用同一句话**，避免被用来试探。 */
export const REVIEW_ORDER_NOT_FOUND_MESSAGE = "订单不存在";
export const REVIEW_ALREADY_REVIEWED_MESSAGE = "该订单已评价过";

/**
 * 不能评价时的说法（`D19`）。
 *
 * 只保留了这一条「还没完成」的原因：历史上的「退款中不能评价」「已退款不能评价」
 * 两句文案随退款闸一起删除——它们对应的规则已经被 `D18` 推翻，
 * 留着文案就等于留着一个随时会被误用的错误结论。
 */
export const REVIEW_NOT_COMPLETED_MESSAGE = "服务完成之后才能评价";

/** 重新提交时，这条评价已经不是「被驳回」状态了（管理员在此期间通过或隐藏了它）。 */
export const REVIEW_RESUBMIT_NOT_ALLOWED_MESSAGE = "该评价当前不可重新提交";

/**
 * 同一个幂等键被用在了**另一张订单**上。
 *
 * ⚠️ 这与「同键重放」是两件事，不能混为一谈：重放是「同一次提交又发了一遍」，
 * 应当返回第一次的结果；换单复用是**调用方复用了键**，是真 bug。
 * 若在这里安静地返回第一张单的评价，第二张单会永远评不上，而且**没有任何报错**
 * ——调用方以为提交成功了。管理端的 `takeReplayForAction` 对同一种情形报冲突，
 * 用户侧必须同口径。
 */
export const REVIEW_OPERATION_CONFLICT_MESSAGE = "该幂等键已用于另一次提交，请重新提交";

// ——————————————————————————— 时间筛选 ———————————————————————————

/**
 * 把 ISO 时间换算成「北京时间的那一面」：返回值按 **UTC 字段**读出来就是北京时间。
 *
 * 与 `lib/utils/format.ts` 的展示口径完全一致——「今年」这类规则必须与用户看到的
 * 日期算在同一个时区里，否则会出现「显示 2026-01-01 却被今年筛掉」。
 */
function beijingTime(iso: string): number | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return time + BEIJING_OFFSET_MINUTES * 60_000;
}

/**
 * 回退 N 个自然月，**日号超出目标月份时收到该月最后一天**。
 *
 * 直接用 `setUTCMonth` 会让「3 月 31 日减一个月」变成「3 月 3 日」——
 * 那等于边界反而往后跳了，是这类筛选最容易出错的地方。
 */
function shiftMonths(months: number, now: number): number {
  const shifted = new Date(now);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();

  const first = Date.UTC(year, month + months, 1, 0, 0, 0, 0);
  const target = new Date(first);
  // 目标月份的天数：下个月的第 0 天 = 本月最后一天
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

  return Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    Math.min(day, lastDay),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
    shifted.getUTCSeconds(),
    shifted.getUTCMilliseconds(),
  );
}

/**
 * 时间筛选的下界（北京时间）。`all` 没有下界，返回 null。
 *
 * 「今年」是**自然年**（1 月 1 日起），其余三个是滚动的自然月窗口。
 */
export function reviewRangeStart(range: ReviewRange, now: Date): number | null {
  const current = now.getTime() + BEIJING_OFFSET_MINUTES * 60_000;

  switch (range) {
    case "all":
      return null;
    case "month":
      return shiftMonths(-1, current);
    case "threeMonths":
      return shiftMonths(-3, current);
    case "halfYear":
      return shiftMonths(-6, current);
    case "year":
      return Date.UTC(new Date(current).getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  }
}

/**
 * 时间是否落在筛选范围内。
 *
 * ⚠️ `now` 必须显式传入：规则依赖当前时间，测试要能把时间钉死。
 * 时间串坏掉时**按不在范围内处理**（宁可少显示一条，也不要凭空多出一条无法核对时间的记录）。
 */
export function isWithinReviewRange(iso: string, range: ReviewRange, now: Date): boolean {
  if (range === "all") return true;

  const time = beijingTime(iso);
  if (time === null) return false;

  const start = reviewRangeStart(range, now);
  return start === null ? true : time >= start;
}

// ——————————————————————————— 评价资格 ———————————————————————————

/** `canReviewOrder` 只关心订单的这两项事实。收窄入参让「它不看订单状态」这件事在类型上就成立。 */
export type ReviewEligibilityOrder = {
  status: OrderStatus;
  /** 服务完成时间。**这就是评价资格的唯一事实依据**（`D19`） */
  completedAt: string | null;
};

/**
 * 能不能评价某一笔订单。
 *
 * 两项条件，顺序刻意如此：
 *
 * 1. 已经评价过 → 一单一评。这是**业务唯一键**，不是提示：无论重复提交、并发提交还是
 *    驳回后重提，都只会存在同一条评价（重提走的是 `rejected → pending` 的状态迁移，不是新建）。
 * 2. 没有真实的完成时间 → 这一单的服务从来没有完成过。**已付款 / 已接单 / 护航中**都在此列，
 *    而「完成前就退款」的订单同样在此列——它从来没有过 `completedAt`，正是 `D19` 要挡住的那一类。
 *
 * ## 为什么这里**完全不看退款**（`D18` / `D19` / `D20`）
 *
 * 退款回答的是「钱退了多少」，评价回答的是「这次服务怎么样」。两者是可以同时成立的事实：
 * 一次打完但随后全额退款的订单，服务**确实发生过**，用户对它的评价仍然是有效信息。
 * 反过来，退款比例也不构成评价的资格线——「退了一半所以只能评一半」没有对应的表达方式。
 *
 * 因此：
 *
 * - 已完成 → 之后部分退款 / 全额退款，**都仍可评价**；
 * - 完成前就退款（`paid → refunded` / `accepted → refunded`）→ 没有 `completedAt`，**不可评价**。
 *
 * ⚠️ 这条规则与 `D20`（已 approved 的评价不因退款自动撤下）是同一条原则的两面：
 * **退款与评价审核是两条互不干涉的线**，谁都不自动改写对方。
 */
export function canReviewOrder(
  order: ReviewEligibilityOrder,
  options: { hasReview: boolean },
): ReviewAllowedActions {
  if (options.hasReview) return { canReview: false, reason: REVIEW_ALREADY_REVIEWED_MESSAGE };
  if (!order.completedAt) return { canReview: false, reason: REVIEW_NOT_COMPLETED_MESSAGE };

  return { canReview: true, reason: "" };
}

/**
 * 订单是否还需要评价（待评价列表的过滤条件）。
 *
 * 判据与 `canReviewOrder` **同源**：有完成时间、且还没有评价记录。
 * 刻意不复用 `canReviewOrder(...).canReview`，因为这里的入参是 `Order` 而那里是收窄过的结构，
 * 但两者的条件必须一起改——`tests/reviews.test.mjs` 有一条用例专门守住「两者结论一致」。
 */
export function isPendingReview(order: Order, hasReview: boolean): boolean {
  return order.completedAt !== null && !hasReview;
}

// ——————————————————————————— 表单校验 ———————————————————————————

/**
 * 一个维度的校验结果。
 *
 * 与「编辑资料」同一套做法：错误从当前输入**推导**出来，不额外存一份状态，
 * 用户改到合法之后提示自动消失；「请选择评分」只在点过提交之后出现。
 *
 * ⚠️ **正文不报「请填写」**（`D3`：星级必填、文字可选）。星级才是维度的存在标志——
 * 没有星级就没有这个维度，只有文字不成一个维度。因此：
 *
 * - `rating` 无效 → 报「请选择评分」；
 * - `content` 为空 → **合法**，提交时收敛成 `null`；
 * - `content` 超长 → 报超长（无论是否点过提交，超长是即时可见的客观事实）。
 */
export function reviewDimensionErrors(input: {
  rating: number;
  content: string;
  /** 是否已经点过一次提交：没点过就先不报「请选择评分」 */
  attempted: boolean;
}): { rating: string | null; content: string | null } {
  const content = input.content.trim();

  return {
    rating:
      input.attempted && !isReviewRating(input.rating) ? REVIEW_RATING_REQUIRED_MESSAGE : null,
    content:
      content && countCharacters(content) > REVIEW_CONTENT_MAX_LENGTH
        ? REVIEW_CONTENT_TOO_LONG_MESSAGE
        : null,
  };
}

/**
 * 正文的规范化结果：去首尾空格后按字符数校验。
 *
 * 空串**是合法的**（`D3`），返回 `null` 表示「这个维度没有写文字」。
 * 这与「写了但全是空格」是同一个结果——两者在用户眼里没有区别。
 */
export function normalizeReviewContent(
  raw: string,
): { ok: true; content: string | null } | { ok: false; message: string } {
  const content = raw.trim();
  if (!content) return { ok: true, content: null };
  if (countCharacters(content) > REVIEW_CONTENT_MAX_LENGTH) {
    return { ok: false, message: REVIEW_CONTENT_TOO_LONG_MESSAGE };
  }
  return { ok: true, content };
}

// ——————————————————————————— 查询条件 ———————————————————————————

export type ReviewListQuery = {
  tab: ReviewTabKey;
  range: ReviewRange;
  page: number;
  pageSize: number;
};

/**
 * 解析评价列表的查询条件。
 *
 * Tab 与时间筛选取值非法都**直接失败**：它们是明确的业务条件，静默回退成
 * 「已评价 / 全部」会让调用方以为自己在看另一份数据。分页参数走规范化，区别是刻意的。
 */
export function parseReviewListQuery(
  params: URLSearchParams,
): { ok: true; query: ReviewListQuery } | { ok: false; message: string } {
  const rawTab = (params.get("tab") ?? "").trim();
  if (rawTab && !isReviewTab(rawTab)) {
    return { ok: false, message: REVIEW_TAB_INVALID_MESSAGE };
  }

  const rawRange = (params.get("range") ?? "").trim();
  if (rawRange && !isReviewRange(rawRange)) {
    return { ok: false, message: REVIEW_RANGE_INVALID_MESSAGE };
  }

  // 走到这里两个取值要么为空、要么合法（非法的已经在上面的分支返回），因此用类型守卫收窄即可
  return {
    ok: true,
    query: {
      tab: isReviewTab(rawTab) ? rawTab : "reviewed",
      range: isReviewRange(rawRange) ? rawRange : "all",
      page: clampPage(params.get("page"), REVIEW_MAX_PAGE),
      pageSize: clampPageSize(params.get("pageSize"), REVIEW_PAGE_SIZE, REVIEW_MAX_PAGE_SIZE),
    },
  };
}

// ——————————————————————————— 排序 ———————————————————————————

/**
 * 默认排序：时间倒序，最新的在最前面；时间相同时用 id 兜底。
 *
 * 兜底那一步不能省：排序不稳定时，同一条记录可能在第一页出现过、第二页又出现一次。
 */
export function compareReviewsNewestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 待评价订单的排序口径与订单列表一致：按下单时间倒序。 */
export function comparePendingNewestFirst(
  a: { paidAt: string; id: string },
  b: { paidAt: string; id: string },
): number {
  if (a.paidAt !== b.paidAt) return a.paidAt < b.paidAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

// ——————————————————————————— 转换 ———————————————————————————

/**
 * 评价 → 已评价列表项（**作者本人**视角，`D8`）。
 *
 * **显式挑字段**：`userId` 不会出现在这里——作者不需要知道自己的 id，
 * 而这份 DTO 的形状一旦带上它，将来被复用到别处时就顺手泄漏了。
 *
 * `canResubmit` 由服务端算好（`D9`）：只有 `rejected` 能回表单，
 * 页面据此显示「重新提交」入口，不自己拿 `status === "rejected"` 去比。
 */
export function toReviewListItem(review: OrderReview): ReviewListItem {
  return {
    id: review.id,
    orderId: review.orderId,
    orderNo: review.orderNo,
    productTitle: review.productTitle,
    productCoverUrl: review.productCoverUrl,
    specName: review.specName,
    quantity: review.quantity,
    companion: review.companion,
    completedAt: review.completedAt,

    productReview: review.productReview,
    companionReview: review.companionReview,
    evidence: review.evidence,

    status: review.status,
    statusLabel: reviewStatusLabel(review.status),
    rejectReason: review.rejectReason,
    hideReason: review.hideReason,

    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    canResubmit: review.status === "rejected",
  };
}

/**
 * 订单 + 评价资格 → 待评价列表项。
 *
 * 同样**显式挑字段**：游戏 ID、备注、金额明细都不出现在这里——
 * 待评价列表只需要回答「哪一单、什么商品、谁打的、什么时候完成的」。
 */
export function toReviewPendingItem(
  order: Order,
  allowedActions: ReviewAllowedActions,
): ReviewPendingItem {
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    companion: order.companion,
    // 能进这个列表的订单都有完成时间（isPendingReview 的前提），
    // 真的缺时退回到支付时间，宁可显示一个略微不准的时间，也不要在页面上留空白。
    completedAt: order.completedAt ?? order.paidAt,
    allowedActions,
  };
}

/** 「加载更多」的合并：追加 + 去重，通用规则见 `lib/constants/pagination.ts`。 */
export function mergeReviewPage<T extends { id: string }, P extends PageResult<T>>(
  current: P,
  next: P,
): P {
  return mergePageResult(current, next);
}

/**
 * 待评价订单的「加载更多」合并。
 *
 * 单独一份是因为它的身份字段是 `orderId`（那不是一条评价记录，只是一笔还没评价的订单），
 * 按 `id` 去重的通用版本套不上。
 */
export function mergePendingReviewPage<P extends PageResult<ReviewPendingItem>>(
  current: P,
  next: P,
): P {
  return mergePageResultBy(current, next, (item: ReviewPendingItem) => item.orderId);
}

/** 打手展示名：未绑定时使用固定说法，不留空白。 */
export function companionLabel(companion: OrderCompanionSnapshot | null): string {
  return companion ? companion.name : REVIEW_COMPANION_UNBOUND_LABEL;
}

/* ───────────────────── 公开面聚合（D6 / D13 / D14 / D15 / R3）───────────────────── */

/** 公开面「最近评价」的条数上限（`D15`）。 */
export const REVIEW_AGGREGATE_LIMIT = 3;

/**
 * 空聚合 —— 「这个对象没有任何 approved 评价」时的唯一答案。
 *
 * ⚠️ **唯一的一处空值字面量**：取数层（`lib/services/reviewAggregates.ts`）与
 * 测试都用它，不在各处各写一遍 `{ averageRating: null, reviewCount: 0, … }`。
 * 那不是简洁问题：分开写的时候，有人加一个新字段（比如「评分分布」）只会改其中几处，
 * 而漏掉的那一处表现为页面上莫名其妙地少了一块，并不报错。
 */
export const EMPTY_REVIEW_AGGREGATE: ReviewAggregate = {
  averageRating: null,
  reviewCount: 0,
  reviews: [],
  reviewsTruncated: false,
};

/** 没有任何公开评价时页面上的说法（`D15`）。 */
export const REVIEW_NO_RATING_LABEL = "暂无评分";

/**
 * 公开面「还有更多评价」的说法。
 *
 * 本阶段不做完整评价列表页（`D16`），但**必须**让读者知道被截断了——
 * 只显示 3 条却不说，会让人以为这件商品总共就 3 条评价。
 */
export const REVIEW_TRUNCATED_NOTICE = "仅显示最近 3 条评价";

/** 平均分文案：1 位小数；没有公开评价时说「暂无评分」。**商品侧与打手侧共用**。 */
export function formatAverageRating(averageRating: number | null): string {
  return averageRating === null ? REVIEW_NO_RATING_LABEL : averageRating.toFixed(1);
}

/**
 * 评价 → 公开评价条目。
 *
 * ⚠️ **只有四个字段**：`id` / 脱敏昵称 / 星级 / 正文 / 时间。
 * `userId`、订单号、订单 id、凭证、审核原因与审核人**一个都不带**——
 * 公开面要回答「这件商品好不好」，不需要也不应该暴露「是谁、哪一单、为什么被审过」。
 *
 * 昵称在这里**就地脱敏**（`D13`）：脱敏必须在服务端完成，
 * 客户端即使不渲染这个字段，它也已经躺在响应体里了。
 */
export function toPublicReviewItem(
  review: OrderReview,
  dimension: ReviewDimension,
  nickname: string,
): PublicReviewItem {
  return {
    id: review.id,
    nickname: maskNickname(nickname),
    rating: dimension.rating,
    content: dimension.content,
    createdAt: review.createdAt,
  };
}

/**
 * 某个对象的公开评分聚合 —— **商品侧与打手侧的唯一聚合入口**（`R3`）。
 *
 * 同一个函数、同一份 `approved only` 语义，靠 `key` 决定读哪一维：
 * 两边各写一套是这类功能最典型的漂移来源（一边漏了状态过滤，或者一边把
 * `reviewCount` 数成了评价条数），而两套实现都能"看起来正常"。
 *
 * 四件事：
 *
 * 1. **筛**：只认 `approved`（`D14`），且这个维度必须存在、必须指向 `targetId`；
 * 2. **算**：平均分 = 各维度星级之和 / 维度数量，四舍五入到 **1 位小数**（`D15`）；
 * 3. **数**：`reviewCount` = **维度数量**，不是评价条数（`D15`）——
 *    一条只评了商品的评价，对商品侧 +1、对打手侧 +0；
 * 4. **截**：最近评价按时间倒序取前 `limit` 条，并如实标注「还有更多」。
 *
 * `nickname` 由调用方从用户仓储查好后注入：本文件是纯函数模块，
 * 不引入任何仓储依赖，因此可以被浏览器与 node 测试直接加载。
 */
export function buildReviewAggregate(input: {
  reviews: readonly OrderReview[];
  key: ReviewDimensionKey;
  targetId: string;
  nickname: (userId: string) => string;
  limit?: number;
}): ReviewAggregate {
  const { reviews, key, targetId, nickname } = input;
  const limit = input.limit ?? REVIEW_AGGREGATE_LIMIT;

  const counted: { review: OrderReview; dimension: ReviewDimension }[] = [];
  for (const review of reviews) {
    if (review.status !== "approved") continue;
    if (reviewDimensionOwnerId(review, key) !== targetId) continue;

    const dimension = reviewDimensionOf(review, key);
    if (!dimension) continue;
    counted.push({ review, dimension });
  }

  if (counted.length === 0) {
    // 返回新对象而不是共享常量：调用方拿到手的是一份可以随便改的普通数据
    return { averageRating: null, reviewCount: 0, reviews: [], reviewsTruncated: false };
  }

  counted.sort((a, b) => compareReviewsNewestFirst(a.review, b.review));

  const sum = counted.reduce((total, item) => total + item.dimension.rating, 0);
  const shown = counted.slice(0, limit);

  return {
    // 先乘后除再除回，避免 4.5 / 4.6 这类值在浮点上出「4.499999」的尾巴
    averageRating: Math.round((sum * 10) / counted.length) / 10,
    reviewCount: counted.length,
    reviews: shown.map((item) =>
      toPublicReviewItem(item.review, item.dimension, nickname(item.review.userId)),
    ),
    reviewsTruncated: counted.length > shown.length,
  };
}
