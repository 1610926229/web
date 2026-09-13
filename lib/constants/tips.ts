import type { PageResult } from "@/lib/types/common";
import type { TipPaymentStatus, TipRecord, TipStatusCounts, TipStatusFilter } from "@/lib/types/tip";
import { clampPage, clampPageSize, mergePageResult } from "./pagination";

/**
 * 鸡腿记录的文案、状态与查询条件（服务端与浏览器共用）。
 *
 * ⚠️ 本文件只有 `import type` 与 `lib/constants/pagination.ts` 这两个纯模块，
 * 没有任何运行时依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * **本阶段只读**：这里没有任何「创建鸡腿记录」的规则、校验或文案，
 * 服务端也没有对应的写接口（见 `lib/data/tipRepository.ts` 的说明）。
 * 原因是鸡腿的价格、兑换比例、支付方式与结算规则都还没有确认，
 * 提前定下其中任何一项，都会变成后面必须推翻的「事实」。
 */

/** 页面标题（与原型一致）。 */
export const TIP_PAGE_TITLE = "鸡腿记录";
/** 新增入口页的标题。 */
export const TIP_CREATE_PAGE_TITLE = "送鸡腿";

/** 未绑定打手时的固定说法：留空会让用户以为是页面没加载出来。 */
export const TIP_COMPANION_UNBOUND_LABEL = "未绑定";

/**
 * 列表顶部的说明。
 *
 * 三件事必须写在明处：数据是 Mock、只记录不结算、单价与比例还没确认。
 * 用户看到「鸡腿个数」时最容易自己脑补一个价格，因此这句话不能省。
 */
export const TIP_MOCK_NOTICE =
  "以下为本地 Mock 历史记录。鸡腿的价格、兑换比例、支付方式与结算规则尚待确认，本页只展示原始记录值，不展示金额与兑换比例。";

/**
 * `/tips/new` 页面上的说明。
 *
 * ⚠️ 这是**本阶段最重要的一句话**：它解释了为什么这个页面只有一个不能点的按钮。
 */
export const TIP_RULES_PENDING_NOTE =
  "鸡腿的价格、支付方式与打手结算规则仍在确认中，因此本页暂时不能提交，也不会产生任何支付请求或鸡腿记录。";

/** 禁用按钮旁边必须写明的理由（在按钮上作为无障碍名称，与提示文案同源）。 */
export const TIP_SUBMIT_DISABLED_REASON = "规则待确认，暂不可提交";

/** 禁用按钮的文案。 */
export const TIP_SUBMIT_DISABLED_LABEL = "暂不可送鸡腿";

/** 状态取值与文案。顺序与列表上的筛选 chip 一致。 */
export const TIP_STATUS_LABELS: Record<TipPaymentStatus, string> = {
  paid: "已支付",
  pending: "待支付",
  failed: "支付失败",
};

/** 状态对应的颜色 class（与订单状态的展示口径一致，只在这里定义一次）。 */
export const TIP_STATUS_CLASS: Record<TipPaymentStatus, string> = {
  paid: "text-status-success",
  pending: "text-status-warning",
  failed: "text-status-danger",
};

export type TipStatusOption = { key: TipStatusFilter; label: string };

export const TIP_STATUS_OPTIONS: readonly TipStatusOption[] = [
  { key: "all", label: "全部" },
  { key: "paid", label: TIP_STATUS_LABELS.paid },
  { key: "pending", label: TIP_STATUS_LABELS.pending },
  { key: "failed", label: TIP_STATUS_LABELS.failed },
];

const TIP_STATUS_KEYS = TIP_STATUS_OPTIONS.map((item) => item.key);

export function isTipStatusFilter(value: string): value is TipStatusFilter {
  return (TIP_STATUS_KEYS as readonly string[]).includes(value);
}

export const TIP_STATUS_INVALID_MESSAGE = "鸡腿记录状态筛选无效";

export const TIP_PAGE_SIZE = 10;
export const TIP_MAX_PAGE_SIZE = 20;
export const TIP_MAX_PAGE = 1000;

export function tipPaymentStatusLabel(status: TipPaymentStatus): string {
  return TIP_STATUS_LABELS[status];
}

/**
 * 解析列表的查询条件。
 *
 * 状态取值非法**直接失败**（与订单列表一致）：它是明确的业务条件，
 * 静默回退成「全部」会让调用方以为筛选生效了。分页参数走规范化，区别是刻意的。
 */
export function parseTipListQuery(
  params: URLSearchParams,
): { ok: true; query: { status: TipStatusFilter; page: number; pageSize: number } } | { ok: false; message: string } {
  const rawStatus = (params.get("status") ?? "").trim();
  if (rawStatus && !isTipStatusFilter(rawStatus)) {
    return { ok: false, message: TIP_STATUS_INVALID_MESSAGE };
  }

  return {
    ok: true,
    query: {
      status: isTipStatusFilter(rawStatus) ? rawStatus : "all",
      page: clampPage(params.get("page"), TIP_MAX_PAGE),
      pageSize: clampPageSize(params.get("pageSize"), TIP_PAGE_SIZE, TIP_MAX_PAGE_SIZE),
    },
  };
}

/**
 * 列表排序：创建时间倒序，时间相同时用 id 兜底。
 *
 * 兜底那一步不能省：排序不稳定时，同一条记录可能在第一页出现过、第二页又出现一次。
 */
export function compareTipsNewestFirst(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * 鸡腿记录 → 列表项。**显式挑字段**。
 *
 * 这一层同时是「不展示未确认规则」的最后一道闸门：即便将来仓储实体上多出了
 * 单价 / 比例 / 到手金额之类的字段，只要不在这里挑出来，接口与页面就看不到。
 */
export function toTipListItem(record: TipRecord): {
  id: string;
  orderId: string;
  orderNo: string;
  productTitle: string;
  productCoverUrl: string;
  companion: TipRecord["companion"];
  quantity: number;
  paymentStatus: TipPaymentStatus;
  paymentStatusLabel: string;
  createdAt: string;
} {
  return {
    id: record.id,
    orderId: record.orderId,
    orderNo: record.orderNo,
    productTitle: record.productTitle,
    productCoverUrl: record.productCoverUrl,
    companion: record.companion,
    // 只搬原始个数：这里不做任何乘法，也没有可乘的单价
    quantity: record.quantity,
    paymentStatus: record.paymentStatus,
    paymentStatusLabel: tipPaymentStatusLabel(record.paymentStatus),
    createdAt: record.createdAt,
  };
}

/** 各状态的角标：一次算清，随每一页一起返回。 */
export function countTipStatuses(records: readonly TipRecord[]): TipStatusCounts {
  const counts: TipStatusCounts = { all: records.length, paid: 0, pending: 0, failed: 0 };
  for (const record of records) counts[record.paymentStatus] += 1;
  return counts;
}

/** 「加载更多」的合并：追加 + 去重，通用规则见 `lib/constants/pagination.ts`。 */
export function mergeTipPage<T extends { id: string }, P extends PageResult<T>>(
  current: P,
  next: P,
): P {
  return mergePageResult(current, next);
}
