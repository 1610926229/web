import type { Companion } from "@/lib/types/companion";
import type {
  CompletionSubmission,
  CompletionSubmissionReviewSource,
  CompletionSubmissionStatus,
} from "@/lib/types/completion";
import type { DispatchAcceptSource, DispatchRecord, DispatchState } from "@/lib/types/dispatch";
import type { Earning, EarningStatus } from "@/lib/types/earning";
import type { SupportEvidence } from "@/lib/types/evidence";
import type { Notification, NotificationKind } from "@/lib/types/notification";
import type {
  Order,
  OrderAddonSnapshot,
  OrderCompanionSnapshot,
  OrderCouponSnapshot,
  OrderStatus,
} from "@/lib/types/order";

/**
 * W1 写闭包里**每一张表 ↔ 领域对象**的**唯一**一份映射。
 *
 * ## 为什么单独成文件
 *
 * 本轮有 13 个 Pg 仓储、6 个 Pg 事务实现同时在读这些表。若每个文件各写一份
 * 「snake_case 行 → camelCase 领域对象」，那么 `orders` 的 38 个列就会有 13 份
 * 各自演化的副本——而**漏掉一个列**不会报错，只会让某个页面悄悄少显示一个字段。
 * 因此行类型与映射函数只在这里定义一次，仓储与事务都从这里取。
 *
 * ## 为什么映射函数必须逐字段手写（不能自动转 camelCase）
 *
 * 因为**契约是逐字段的**：`Order` 上哪个字段可空、`jsonb` 映射成哪个 TS 类型、
 * 时间列是 `string | null` 还是 `string`，都不是「snake_case → camelCase」这条
 * 机械规则能表达的信息。`folder-structure` 意义上的「等价翻译」指的正是这一份
 * 逐字段对应关系，它必须能被读、被核对。
 *
 * ## 时间：**永远是 string**
 *
 * `lib/data/pg/pool.ts` 在模块加载时把 `timestamptz`（OID 1184）的解析器注册成
 * `new Date(v).toISOString()`，因此驱动交到这里的已经是定长 ISO 字符串。
 * 领域对象里一个 `Date` 都不会出现——与 Mock 实现**完全一致**，
 * `<` / `>` 的字典序比较因此在两个实现里同样成立。
 *
 * ## jsonb：驱动已经解析过
 *
 * `jsonb` 列由驱动还原成 JS 值（对象 / 数组），因此这里**直接赋值**，
 * 不写 `JSON.parse`——多解析一次会把一个对象塞进 `JSON.parse` 并当场抛错。
 */

/* ───────────────────────────────── orders ───────────────────────────────── */

export const ORDER_COLUMNS = [
  "id",
  "order_no",
  "user_id",
  "status",
  "created_at",
  "paid_at",
  "accepted_at",
  "serving_at",
  "completed_at",
  "refunded_at",
  "ever_accepted_at",
  "product_id",
  "product_title",
  "product_cover_url",
  "spec_id",
  "spec_name",
  "unit_price",
  "quantity",
  "game_name",
  "region",
  "game_account_id",
  "remark",
  "addons",
  "items_amount",
  "addons_amount",
  "total_amount",
  "original_amount",
  "coupon_discount_amount",
  "actual_paid_amount",
  "companion_rate_snapshot",
  "companion_base_income",
  "club_net_income",
  "refunded_amount",
  "coupon",
  "actual_companion_id",
  "companion",
  "complaint_window_minutes_snapshot",
  "complaint_deadline_at",
].join(", ");

export type OrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  status: string;
  created_at: string;
  paid_at: string;
  accepted_at: string | null;
  serving_at: string | null;
  completed_at: string | null;
  refunded_at: string | null;
  ever_accepted_at: string | null;
  product_id: string;
  product_title: string;
  product_cover_url: string;
  spec_id: string;
  spec_name: string;
  unit_price: number;
  quantity: number;
  game_name: string;
  region: string;
  game_account_id: string;
  remark: string;
  addons: OrderAddonSnapshot[];
  items_amount: number;
  addons_amount: number;
  total_amount: number;
  original_amount: number;
  coupon_discount_amount: number;
  actual_paid_amount: number;
  companion_rate_snapshot: number;
  companion_base_income: number;
  club_net_income: number;
  refunded_amount: number;
  coupon: OrderCouponSnapshot | null;
  actual_companion_id: string | null;
  companion: OrderCompanionSnapshot | null;
  complaint_window_minutes_snapshot: number | null;
  complaint_deadline_at: string | null;
};

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    orderNo: row.order_no,
    userId: row.user_id,
    status: row.status as OrderStatus,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    acceptedAt: row.accepted_at,
    servingAt: row.serving_at,
    completedAt: row.completed_at,
    refundedAt: row.refunded_at,
    everAcceptedAt: row.ever_accepted_at,
    productId: row.product_id,
    productTitle: row.product_title,
    productCoverUrl: row.product_cover_url,
    specId: row.spec_id,
    specName: row.spec_name,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    gameName: row.game_name,
    region: row.region,
    gameAccountId: row.game_account_id,
    remark: row.remark,
    // jsonb 由驱动解析；万一手工改库把这一列写坏了，宁可退化成空数组，
    // 也不要让一条脏数据把整个订单列表打崩（与 suggestionRepository 同一种态度）
    addons: Array.isArray(row.addons) ? row.addons : [],
    itemsAmount: row.items_amount,
    addonsAmount: row.addons_amount,
    totalAmount: row.total_amount,
    originalAmount: row.original_amount,
    couponDiscountAmount: row.coupon_discount_amount,
    actualPaidAmount: row.actual_paid_amount,
    companionRateSnapshot: row.companion_rate_snapshot,
    companionBaseIncome: row.companion_base_income,
    clubNetIncome: row.club_net_income,
    refundedAmount: row.refunded_amount,
    coupon: row.coupon ?? null,
    actualCompanionId: row.actual_companion_id,
    companion: row.companion ?? null,
    complaintWindowMinutesSnapshot: row.complaint_window_minutes_snapshot,
    complaintDeadlineAt: row.complaint_deadline_at,
  };
}

/* ──────────────────────────── dispatch_records ──────────────────────────── */

export const DISPATCH_COLUMNS = [
  "id",
  "order_id",
  "state",
  "exclusive_companion_id",
  "exclusive_entered_at",
  "exclusive_deadline_at",
  "exclusive_timeout_minutes_snapshot",
  "public_pool_entered_at",
  "public_deadline_at",
  "public_timeout_minutes_snapshot",
  "accepted_by_companion_id",
  "accepted_at",
  "accepted_via",
  "timed_out_at",
  "created_at",
  "updated_at",
].join(", ");

export type DispatchRow = {
  id: string;
  order_id: string;
  state: string;
  exclusive_companion_id: string | null;
  exclusive_entered_at: string | null;
  exclusive_deadline_at: string | null;
  exclusive_timeout_minutes_snapshot: number | null;
  public_pool_entered_at: string | null;
  public_deadline_at: string | null;
  public_timeout_minutes_snapshot: number | null;
  accepted_by_companion_id: string | null;
  accepted_at: string | null;
  accepted_via: string | null;
  timed_out_at: string | null;
  created_at: string;
  updated_at: string;
};

export function toDispatch(row: DispatchRow): DispatchRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    state: row.state as DispatchState,
    exclusiveCompanionId: row.exclusive_companion_id,
    exclusiveEnteredAt: row.exclusive_entered_at,
    exclusiveDeadlineAt: row.exclusive_deadline_at,
    exclusiveTimeoutMinutesSnapshot: row.exclusive_timeout_minutes_snapshot,
    publicPoolEnteredAt: row.public_pool_entered_at,
    publicDeadlineAt: row.public_deadline_at,
    publicTimeoutMinutesSnapshot: row.public_timeout_minutes_snapshot,
    acceptedByCompanionId: row.accepted_by_companion_id,
    acceptedAt: row.accepted_at,
    acceptedVia: row.accepted_via as DispatchAcceptSource | null,
    timedOutAt: row.timed_out_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ───────────────────────────────  companions ─────────────────────────────── */

/**
 * 列名**数组**（而不只是拼好的字符串）：`companionRepository` 还要用它生成
 * `UPDATE … RETURNING prev.x AS previous_x` 的成对列名，只有字符串是做不到的。
 */
export const COMPANION_COLUMN_NAMES = [
  "id",
  "user_id",
  "application_id",
  "removed_at",
  "display_name",
  "avatar_url",
  "rank_label",
  "intro",
  "game_ids",
  "regions",
  "service_tags",
  "available",
  "unavailable_reason",
  "completed_order_count",
  "tips_count",
  "sort_order",
  "enabled",
] as const;

export const COMPANION_COLUMNS = COMPANION_COLUMN_NAMES.join(", ");

export type CompanionRow = {
  id: string;
  user_id: string | null;
  application_id: string | null;
  removed_at: string | null;
  display_name: string;
  avatar_url: string;
  rank_label: string;
  intro: string;
  game_ids: string[];
  regions: string[];
  service_tags: string[];
  available: boolean;
  unavailable_reason: string;
  completed_order_count: number;
  tips_count: number;
  sort_order: number;
  enabled: boolean;
};

/** jsonb 数组列：驱动已解析；万一手工改库写成非数组，宁可退化成空数组。 */
function toTextArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export function toCompanion(row: CompanionRow): Companion {
  return {
    id: row.id,
    userId: row.user_id,
    applicationId: row.application_id,
    removedAt: row.removed_at,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    rankLabel: row.rank_label,
    intro: row.intro,
    gameIds: toTextArray(row.game_ids),
    regions: toTextArray(row.regions),
    serviceTags: toTextArray(row.service_tags),
    available: row.available,
    unavailableReason: row.unavailable_reason,
    completedOrderCount: row.completed_order_count,
    tipsCount: row.tips_count,
    sortOrder: row.sort_order,
    enabled: row.enabled,
  };
}

/* ──────────────────────────────── notifications ──────────────────────────── */

export const NOTIFICATION_COLUMNS =
  "id, user_id, kind, title, summary, body, created_at, read_at, href";

export type NotificationRow = {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  created_at: string;
  read_at: string | null;
  href: string | null;
};

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as NotificationKind,
    title: row.title,
    summary: row.summary,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
    href: row.href,
  };
}

/* ─────────────────────────────────── earnings ────────────────────────────── */

export const EARNING_COLUMNS =
  "id, order_id, companion_id, income_amount, status, frozen_at, available_at, withdrawn_at, reversed_amount, fine_amount";

export type EarningRow = {
  id: string;
  order_id: string;
  companion_id: string;
  income_amount: number;
  status: string;
  frozen_at: string;
  available_at: string | null;
  withdrawn_at: string | null;
  reversed_amount: number;
  fine_amount: number;
};

export function toEarning(row: EarningRow): Earning {
  return {
    id: row.id,
    orderId: row.order_id,
    companionId: row.companion_id,
    incomeAmount: row.income_amount,
    status: row.status as EarningStatus,
    frozenAt: row.frozen_at,
    availableAt: row.available_at,
    withdrawnAt: row.withdrawn_at,
    reversedAmount: row.reversed_amount,
    fineAmount: row.fine_amount,
  };
}

/* ────────────────────────── completion_submissions ───────────────────────── */

export const COMPLETION_COLUMNS = [
  "id",
  "order_id",
  "companion_id",
  "summary",
  "evidence",
  "status",
  "submitted_at",
  "auto_approval_minutes_snapshot",
  "auto_approval_deadline_at",
  "review_source",
  "reviewed_by_staff_id",
  "reviewed_by_name",
  "reviewed_at",
  "reject_reason",
  "invalidated_at",
].join(", ");

export type CompletionSubmissionRow = {
  id: string;
  order_id: string;
  companion_id: string;
  summary: string;
  evidence: SupportEvidence[];
  status: string;
  submitted_at: string;
  auto_approval_minutes_snapshot: number;
  auto_approval_deadline_at: string;
  review_source: string | null;
  reviewed_by_staff_id: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  invalidated_at: string | null;
};

export function toCompletionSubmission(row: CompletionSubmissionRow): CompletionSubmission {
  return {
    id: row.id,
    orderId: row.order_id,
    companionId: row.companion_id,
    summary: row.summary,
    // jsonb 由驱动解析；手工改库把这一列写成对象时宁可退化成空数组，
    // 也不要让一条脏数据在 DTO 层把整个列表打崩（与 suggestionRepository 同一种态度）
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    status: row.status as CompletionSubmissionStatus,
    submittedAt: row.submitted_at,
    autoApprovalMinutesSnapshot: row.auto_approval_minutes_snapshot,
    autoApprovalDeadlineAt: row.auto_approval_deadline_at,
    reviewSource: row.review_source as CompletionSubmissionReviewSource,
    reviewedByStaffId: row.reviewed_by_staff_id,
    reviewedByName: row.reviewed_by_name,
    reviewedAt: row.reviewed_at,
    rejectReason: row.reject_reason,
    invalidatedAt: row.invalidated_at,
  };
}
