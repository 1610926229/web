import type { PageResult } from "@/lib/types/common";
import type { EvidenceKind } from "@/lib/types/evidence";
import type { Order, OrderCompanionSnapshot, OrderStatus } from "@/lib/types/order";
import type { RefundStatus } from "@/lib/types/refund";
import type {
  OrderReview,
  ReviewAllowedActions,
  ReviewListItem,
  ReviewPendingItem,
  ReviewRange,
  ReviewRating,
  ReviewTabKey,
} from "@/lib/types/review";
import { BEIJING_OFFSET_MINUTES } from "@/lib/utils/format";
import { countCharacters } from "@/lib/utils/text";
import { clampPage, clampPageSize, mergePageResult, mergePageResultBy } from "./pagination";
import { isActiveRefundStatus } from "./refunds";

/**
 * 评价的规则、文案与查询条件（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除 `lib/utils/text.ts`（字符计数）与 `lib/utils/format.ts`（北京时间偏移常量）
 * 这两个纯函数模块外没有运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 三条规则写在这里，页面与接口共用同一份实现，不存在两套口径：
 *
 * 1. **能不能评价**由 `canReviewOrder` 判定：已完成、未评价、无进行中或已通过的退款；
 * 2. **时间筛选**由 `isWithinReviewRange` 判定，且**必须把当前时间作为参数传入**，
 *    否则测试会在某一天突然变红、也无法验证边界；
 * 3. **字数**由 `countCharacters` 计算（汉字、字母、普通 Emoji 都算 1 个），
 *    与会话里的昵称/简介、退款说明用的是同一套计数规则。
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

/**
 * 评价正文的长度上限。
 *
 * 原型没有标注字数上限，这里取一个**保守的 Mock 上限**并写在唯一一处：
 * 退款说明同样取 200，两处的口径保持一致，将来确认后只改这一个常量。
 */
export const REVIEW_CONTENT_MAX_LENGTH = 200;

export const REVIEW_CONTENT_EMPTY_MESSAGE = "请填写评价内容";
export const REVIEW_CONTENT_TOO_LONG_MESSAGE = `评价内容不能超过 ${REVIEW_CONTENT_MAX_LENGTH} 个字符`;
export const REVIEW_RATING_REQUIRED_MESSAGE = "请选择评分";

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
export const REVIEW_NOT_COMPLETED_MESSAGE = "只有已完成的订单可以评价";
export const REVIEW_REFUND_ACTIVE_MESSAGE = "该订单正在退款处理中，暂时无法评价";
export const REVIEW_ORDER_REFUNDED_MESSAGE = "该订单已退款，无法评价";

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

/**
 * 能不能评价某一笔订单。
 *
 * 四项条件按优先级排列，理由文案跟着最先生效的那一条走：
 *
 * 1. 已经评价过 → 一单一评，重复提交不会产生第二条（这是业务唯一键，不是提示）；
 * 2. 订单不是「已完成」→ 已付款 / 已接单 / 护航中都还没结束，**已退款**也在此列；
 * 3. 退款已通过 → 这一单的钱已经退回，不应再产生评价；
 * 4. 退款进行中（待审核 / 审核中）→ 结论未定，等退款结束再评价。
 *
 * 退款被拒绝或已撤销不影响评价：那些订单的服务是正常完成的。
 */
export function canReviewOrder(
  status: OrderStatus,
  options: { hasReview: boolean; refundStatus: RefundStatus | null },
): ReviewAllowedActions {
  if (options.hasReview) return { canReview: false, reason: REVIEW_ALREADY_REVIEWED_MESSAGE };
  if (status !== "completed") return { canReview: false, reason: REVIEW_NOT_COMPLETED_MESSAGE };

  if (options.refundStatus === "approved") {
    return { canReview: false, reason: REVIEW_ORDER_REFUNDED_MESSAGE };
  }
  if (options.refundStatus && isActiveRefundStatus(options.refundStatus)) {
    return { canReview: false, reason: REVIEW_REFUND_ACTIVE_MESSAGE };
  }

  return { canReview: true, reason: "" };
}

/** 订单是否还需要评价（待评价列表的过滤条件：已完成 + 没有评价记录）。 */
export function isPendingReview(order: Order, hasReview: boolean): boolean {
  return order.status === "completed" && !hasReview;
}

// ——————————————————————————— 表单校验 ———————————————————————————

/**
 * 评分与正文的校验结果。
 *
 * 与「编辑资料」同一套做法：错误从当前输入**推导**出来，不额外存一份状态，
 * 用户改到合法之后提示自动消失；「请选择评分」「请填写评价内容」只在点过提交之后出现。
 */
export function reviewFieldErrors(input: {
  rating: number;
  content: string;
  /** 是否已经点过一次提交：没点过就先不报「请填写」 */
  attempted: boolean;
}): { rating: string | null; content: string | null } {
  const content = input.content.trim();

  return {
    rating:
      input.attempted && !isReviewRating(input.rating) ? REVIEW_RATING_REQUIRED_MESSAGE : null,
    content: !content
      ? input.attempted
        ? REVIEW_CONTENT_EMPTY_MESSAGE
        : null
      : countCharacters(content) > REVIEW_CONTENT_MAX_LENGTH
        ? REVIEW_CONTENT_TOO_LONG_MESSAGE
        : null,
  };
}

/** 正文的规范化结果：去首尾空格后按字符数校验。 */
export function normalizeReviewContent(
  raw: string,
): { ok: true; content: string } | { ok: false; message: string } {
  const content = raw.trim();
  if (!content) return { ok: false, message: REVIEW_CONTENT_EMPTY_MESSAGE };
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

// ——————————————————————————— 排序与转换 ———————————————————————————

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

/** 评价 → 已评价列表项。**显式挑字段**：`userId` 与订单的私密字段都不会出现。 */
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
    rating: review.rating,
    content: review.content,
    evidence: review.evidence,
    createdAt: review.createdAt,
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
    // 只有已完成的订单会进这个列表；真的缺完成时间时退回到支付时间，
    // 宁可显示一个略微不准的时间，也不要在页面上留一个空白。
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
