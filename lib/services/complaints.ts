import { ApiError } from "@/lib/api/ApiError";
import {
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_TYPE_LABELS,
  COMPLAINT_TYPE_REQUIRED_MESSAGE,
  isComplaintType,
  parseComplaintListQuery,
  validateComplaintText,
} from "@/lib/constants/complaints";
import { parseEvidenceInput, toStoredEvidence, type EvidenceDraft } from "@/lib/constants/evidence";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { PageResult } from "@/lib/types/common";
import type {
  Complaint,
  ComplaintDetail,
  ComplaintListItem,
  ComplaintTimelineEntry,
  ComplaintTypeKey,
  OrderComplaintSummary,
} from "@/lib/types/complaint";

/**
 * 投诉服务 —— 投诉列表、投诉详情、提交投诉与投诉接口共用的唯一入口。
 *
 * 四条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只能投诉自己的订单**。带订单提交时，订单不存在、不属于当前用户一律 404，
 *    两种情况的对外表现完全相同。不带订单提交也允许（平台服务类问题）。
 * 2. **投诉不改动订单，也不产生任何退款**。这里没有一处写订单或退款的地方；
 *    处理结果只能来自预置数据或将来后台的返回，用户端不产生结论。
 * 3. **列表与详情是两个 DTO**。列表刻意丢掉投诉说明、凭证、联系方式与处理结果。
 * 4. **写入幂等**。同「用户 + 幂等键」只产生一条投诉，快速连点不会多出记录。
 */

// ——————————————————————————— 输入解析 ———————————————————————————

type ComplaintInput = {
  typeKey: ComplaintTypeKey;
  description: string;
  contact: string;
  evidence: EvidenceDraft[];
  /** 关联订单 id；不关联时为空串 */
  orderId: string;
};

/**
 * 按**白名单**解析投诉表单。
 *
 * 只有类型、描述、联系方式、凭证、关联订单五类字段会被读取——`status` / `result` /
 * `userId` 之类即便塞进请求体也会被直接丢弃：投诉的状态与处理结果是平台侧的，
 * 用户提交不了。
 */
export function parseComplaintInput(body: Record<string, unknown>): ComplaintInput {
  const rawType = readTrimmedString(body, "typeKey");
  if (!rawType || !isComplaintType(rawType)) {
    throw new ApiError("BAD_REQUEST", COMPLAINT_TYPE_REQUIRED_MESSAGE);
  }

  const text = validateComplaintText(
    typeof body.description === "string" ? body.description : "",
    typeof body.contact === "string" ? body.contact : "",
  );
  if (!text.ok) throw new ApiError("BAD_REQUEST", text.message);

  const evidence = parseEvidenceInput(body.evidence);
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  return {
    typeKey: rawType,
    description: text.description,
    contact: text.contact,
    evidence: evidence.items,
    orderId: readTrimmedString(body, "orderId"),
  };
}

// ——————————————————————————— 转换 ———————————————————————————

/** 投诉 → 列表项。**显式挑字段**：说明、凭证、联系方式与处理结果都不会出现在列表里。 */
export function toComplaintListItem(complaint: Complaint): ComplaintListItem {
  return {
    id: complaint.id,
    complaintNo: complaint.complaintNo,
    status: complaint.status,
    typeLabel: complaint.typeLabel,
    orderNo: complaint.orderNo,
    createdAt: complaint.createdAt,
    updatedAt: complaint.updatedAt,
  };
}

/** 投诉单号：日期 + 随机尾号。只用于展示，不作为业务主键。 */
function makeComplaintNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const tail = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return `TS${stamp}${tail}`;
}

/** 进度时间轴：只包含**已经发生**的节点，按时间先后排列。 */
export function buildComplaintTimeline(complaint: Complaint): ComplaintTimelineEntry[] {
  const entries: ComplaintTimelineEntry[] = [
    {
      key: "pending",
      label: COMPLAINT_STATUS_LABELS.pending,
      at: complaint.createdAt,
      note: "投诉已提交，客服会尽快查看",
    },
  ];

  if (complaint.processingAt) {
    entries.push({
      key: "processing",
      label: COMPLAINT_STATUS_LABELS.processing,
      at: complaint.processingAt,
      note: "客服已开始核实你反馈的问题",
    });
  }
  if (complaint.status === "resolved" && complaint.handledAt) {
    entries.push({
      key: "resolved",
      label: COMPLAINT_STATUS_LABELS.resolved,
      at: complaint.handledAt,
      note: complaint.result || "客服已处理本次投诉",
    });
  }
  if (complaint.status === "closed" && complaint.handledAt) {
    entries.push({
      key: "closed",
      label: COMPLAINT_STATUS_LABELS.closed,
      at: complaint.handledAt,
      note: complaint.result || "本次投诉已关闭",
    });
  }

  return entries.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

/** 投诉 → 详情。投诉说明、凭证与处理结果只在这里出现，且只返回给投诉人。 */
export function toComplaintDetail(complaint: Complaint): ComplaintDetail {
  return {
    ...toComplaintListItem(complaint),
    orderId: complaint.orderId,
    typeKey: complaint.typeKey,
    description: complaint.description,
    evidence: complaint.evidence,
    contact: complaint.contact,
    processingAt: complaint.processingAt,
    handledAt: complaint.handledAt,
    result: complaint.result,
    timeline: buildComplaintTimeline(complaint),
  };
}

/** 订单详情里的投诉摘要：只回答「有没有、到哪一步了」。 */
export function toOrderComplaintSummary(stats: {
  count: number;
  latest: Complaint | null;
}): OrderComplaintSummary | null {
  if (stats.count === 0 || !stats.latest) return null;
  return {
    count: stats.count,
    latestId: stats.latest.id,
    latestStatus: stats.latest.status,
    latestStatusLabel: COMPLAINT_STATUS_LABELS[stats.latest.status],
    latestCreatedAt: stats.latest.createdAt,
  };
}

/** 某一笔订单的投诉摘要（订单详情页用）。 */
export async function getOrderComplaintSummary(orderId: string): Promise<OrderComplaintSummary | null> {
  const stats = await getComplaintRepository().summarizeComplaintsByOrder(orderId);
  return toOrderComplaintSummary(stats);
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 查询当前用户的投诉列表。
 *
 * 筛选条件解析失败（状态取值非法）抛 `BAD_REQUEST`：这是**明确的业务条件写错了**，
 * 静默当成「全部」会让调用方以为筛选生效了。分页参数的非法值走规范化，两者行为不同是刻意的。
 */
export async function queryComplaintsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<PageResult<ComplaintListItem>> {
  const parsed = parseComplaintListQuery(params);
  if (!parsed.ok) throw new ApiError("BAD_REQUEST", parsed.message);

  const page = await withMockDebug(params, surface, () =>
    getComplaintRepository().queryComplaints({ ...parsed.query, userId }),
  );

  return { ...page, items: page.items.map(toComplaintListItem) };
}

/**
 * 读取单条投诉详情。
 *
 * 投诉不存在、或不属于当前用户，一律返回 null——**两种情况的对外表现完全相同**，
 * 调用方据此返回同一个 404，从而不能拿别人的投诉 id 来试探它是否存在。
 */
export async function getComplaintDetailForUser(
  complaintId: string,
  userId: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<ComplaintDetail | null> {
  if (!complaintId) return null;

  const complaint = await withMockDebug(params, surface, () =>
    getComplaintRepository().findComplaintById(complaintId),
  );
  if (!complaint || complaint.userId !== userId) return null;

  return toComplaintDetail(complaint);
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 提交投诉。
 *
 * 关联订单是选填的：从订单详情进来会带上订单 id，从投诉专区进来也可以不选订单。
 * 带上订单时**必须是自己的一笔订单**，否则 404。
 *
 * 提交**不改动订单状态、不产生退款**：新投诉只会是 `pending`，处理结果留空，
 * 页面按 `COMPLAINT_RESULT_PENDING_NOTE` 如实说明「结果以客服反馈为准」。
 */
export async function createComplaintForUser(
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<{ complaintId: string; created: boolean }> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getComplaintRepository();

  // 快速路径：这个键提交过就返回上一次的结果，不重复校验与写入
  const existing = await repository.findComplaintByKey(userId, idempotencyKey);
  if (existing) return { complaintId: existing.id, created: false };

  const input = parseComplaintInput(body);

  // 关联订单：不存在或不属于当前用户一律 404。这里不做「先查订单再校验用户」的两次判断，
  // 而是把两个条件合成一次，避免有人漏掉其中一个。
  let orderId: string | null = null;
  let orderNo: string | null = null;
  if (input.orderId) {
    const order = await withMockDebug(params, surface, () =>
      getPaymentRepository().findOrderById(input.orderId),
    );
    if (!order || order.userId !== userId) throw new ApiError("NOT_FOUND", "订单不存在");
    orderId = order.id;
    // 订单号快照：之后订单号规则变化不影响历史投诉的展示
    orderNo = order.orderNo;
  }

  const now = new Date().toISOString();

  const result = await repository.createComplaint(
    {
      id: `cmp_${crypto.randomUUID()}`,
      complaintNo: makeComplaintNo(new Date()),
      userId,
      orderId,
      orderNo,

      // 用户新提交的投诉只会是「待处理」：本阶段没有任何用户端的处理入口
      status: "pending",
      typeKey: input.typeKey,
      typeLabel: COMPLAINT_TYPE_LABELS[input.typeKey] ?? input.typeKey,
      description: input.description,
      evidence: toStoredEvidence(input.evidence),
      contact: input.contact,

      createdAt: now,
      updatedAt: now,
      processingAt: null,
      handledAt: null,
      // 处理结果由客服给出，用户提交时一定是空的——处理人也一样
      handledByAdminId: null,
      result: "",
    },
    idempotencyKey,
  );

  return { complaintId: result.complaint.id, created: result.created };
}
