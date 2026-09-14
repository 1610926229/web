import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_COMPLAINT_LIST_NOTICE,
  ADMIN_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_COMPLAINT_NOT_FOUND_MESSAGE,
  ADMIN_COMPLAINT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COMPLAINT_STATUS_INVALID_MESSAGE,
  ADMIN_COMPLAINT_TYPE_INVALID_MESSAGE,
  DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER,
  adminComplaintTransitionMessage,
  buildAdminComplaintListQuery,
  complaintMatchesAdminKeyword,
  normalizeAdminComplaintResult,
  readAdminComplaintStatusFilter,
  readAdminComplaintTypeFilter,
  toAdminComplaintDetail,
  toAdminComplaintListItem,
  type AdminComplaintListQuery,
  type AdminComplaintOrderInput,
} from "@/lib/constants/adminComplaints";
import { COMPLAINT_STATUS_LABELS } from "@/lib/constants/complaints";
import { IDEMPOTENCY_KEY_PATTERN, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import {
  applyAdminComplaintIntent,
  type AdminComplaintWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminComplaintTransaction";
import { getComplaintRepository } from "@/lib/data/complaintRepository";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  AdminComplaintDetail,
  AdminComplaintListData,
  AdminComplaintWriteResult,
  Complaint,
} from "@/lib/types/complaint";
import type { AdminUserSummary } from "@/lib/types/user";

/**
 * 管理端「投诉处理」服务 —— 列表、详情与三个处理动作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`）。
 *
 * ⚠️ **本文件既不写订单，也不写退款申请**：三个处理动作的入参只有幂等键与一段文本，
 * 写入侧（`lib/data/adminComplaintTransaction.ts`）连订单与退款的模块都不 import。
 * 这一条在 §投诉处理 里是硬要求——投诉不自动修改订单，也不自动退款。
 *
 * ⚠️ **用户提交的内容不可被覆盖**：`description` / `evidence` / `contact` 只在详情里读出展示，
 * 本文件没有任何接收它们的写接口，写入侧也没有写它们的位置。处理结果写在另一个字段里。
 */

// ——————————————————————————— 用户摘要 ———————————————————————————

/** userId → 用户摘要。与另外两组管理服务同一做法：一次取回全部用户，避免逐条查询。 */
async function adminUserIndex(): Promise<Map<string, AdminUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [user.id, { id: user.id, displayId: user.displayId, nickname: user.nickname }]),
  );
}

/** 用户记录缺失时的占位摘要（缺一条用户记录不该让整页打不开）。 */
function missingUser(userId: string): AdminUserSummary {
  return { id: userId, nickname: "", displayId: "" };
}

/**
 * 投诉关联的订单摘要输入。
 *
 * 未关联订单时返回 null；**关联的订单查不到时也返回 null**——这里与退款详情不同，
 * 退款详情的 DTO 要求订单摘要是必填的（没有订单就没有订单号与商品可展示），
 * 而投诉本身是完整可读的：正文、凭证、联系方式、处理结果都在投诉自己身上。
 * 为了一条查不到的订单把整条投诉变成 404，会让客服连用户写了什么都看不到。
 *
 * 两种情况的差别由 `orderId`（投诉自己带的那份快照）如实回答：它有值、而这里返回 null，
 * 就是「订单记录缺失」。
 */
async function orderSummaryInput(orderId: string | null): Promise<AdminComplaintOrderInput | null> {
  if (!orderId) return null;

  const order = await getPaymentRepository().findOrderById(orderId);
  if (!order) return null;

  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    productTitle: order.productTitle,
    totalAmount: order.totalAmount,
  };
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 *
 * 状态与类型两个筛选都要解析：它们都会**改变查到的数据**，
 * 一个手改坏的值若静默按「全部」处理，页面会显示一批与筛选栏不符的投诉。
 */
export async function resolveAdminComplaintListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminComplaintListQuery> {
  const status = readAdminComplaintStatusFilter(params.get("status"));
  const type = readAdminComplaintTypeFilter(params.get("type"));

  if (strict) {
    if (status === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_COMPLAINT_STATUS_INVALID_MESSAGE, 400);
    }
    if (type === null) {
      throw new ApiError("BAD_REQUEST", ADMIN_COMPLAINT_TYPE_INVALID_MESSAGE, 400);
    }
  }

  return buildAdminComplaintListQuery({
    params,
    status: status ?? DEFAULT_ADMIN_COMPLAINT_STATUS_FILTER,
    type: type ?? "all",
  });
}

/**
 * 管理端投诉列表。
 *
 * `?mockEmpty=complaints` 演示空列表（空数据不是错误，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两者都只在 `ENABLE_MOCK_DEBUG=true` 时生效。
 */
export async function queryAdminComplaintList(
  query: AdminComplaintListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminComplaintListData> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "complaints")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        notice: ADMIN_COMPLAINT_LIST_NOTICE,
      };
    }

    const [rows, users] = await Promise.all([
      getComplaintRepository().queryComplaintsForAdmin({
        status: query.status === "all" ? null : query.status,
        type: query.type === "all" ? null : query.type,
      }),
      adminUserIndex(),
    ]);

    // 关键词里的订单号取自**投诉自己的快照**（`complaint.orderNo`），不必去查订单，
    // 因此这里没有退款列表那样的订单索引——那一个是订单号只存在订单上才需要的
    const matched = rows.filter((complaint) => {
      const user = users.get(complaint.userId);
      return complaintMatchesAdminKeyword(
        {
          complaintNo: complaint.complaintNo,
          orderNo: complaint.orderNo ?? "",
          nickname: user?.nickname ?? "",
          displayId: user?.displayId ?? "",
        },
        query.keyword,
      );
    });

    // 分页排在关键词过滤之后：数据层只回答「状态与类型符合的有哪些、什么顺序」
    const start = (query.page - 1) * query.pageSize;
    const items = matched
      .slice(start, start + query.pageSize)
      .map((complaint) =>
        toAdminComplaintListItem(
          complaint,
          users.get(complaint.userId) ?? missingUser(complaint.userId),
        ),
      );

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      hasMore: start + items.length < matched.length,
      notice: ADMIN_COMPLAINT_LIST_NOTICE,
    };
  });
}

/**
 * 管理端投诉详情。不存在返回 null，由页面 `notFound()`。
 *
 * 详情里补齐正文、凭证、联系方式、处理信息、关联订单摘要、进度时间轴与
 * **服务端判定的** `allowedActions`：页面不拿状态自己写 `if`，终态三项都是 false。
 */
export async function getAdminComplaintDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminComplaintDetail | null> {
  if (!id) return null;

  return withMockDebug(params, surface, async () => {
    const complaint = await getComplaintRepository().findComplaintById(id);
    if (!complaint) return null;

    const [users, order] = await Promise.all([
      adminUserIndex(),
      orderSummaryInput(complaint.orderId),
    ]);

    return toAdminComplaintDetail(
      complaint,
      users.get(complaint.userId) ?? missingUser(complaint.userId),
      order,
    );
  });
}

// ——————————————————————————— 三个处理动作 ———————————————————————————

/**
 * 从请求体里取幂等键。
 *
 * ⚠️ **不能依赖按钮禁用防重**（§九）：按钮只能挡住手快，挡不住网络重试与用户刷新后重发，
 * 也挡不住直接请求接口。真正的防重是这里读到的幂等键，加上伪事务里的重放判定。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", ADMIN_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 幂等键格式的说明性检查。
 *
 * `readIdempotencyKey()` 已经做过一次格式校验，这里保留一条**独立的**断言，
 * 是为了让「幂等键必须是客户端生成、同一意图下保持不变的字符串」这件事
 * 在本文件里也留下痕迹——它同时是审计表的 `operationId` 来源。
 */
function assertIdempotencyKeyShape(key: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError("BAD_REQUEST", ADMIN_COMPLAINT_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
}

/** 组装一次写操作的上下文。时间戳只取一次，业务写入与审计写入共用同一个。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

/** 三个动作共用的失败翻译。三种情形在三个动作里完全相同，写三遍只会写出三种口径。 */
function toApiError(outcome: AdminComplaintWriteFailure): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_COMPLAINT_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      return new ApiError("BAD_REQUEST", adminComplaintTransitionMessage(outcome.status), 400);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_COMPLAINT_OPERATION_CONFLICT_MESSAGE, 400);
  }
}

/** 伪事务的结果 → 接口返回。 */
function toWriteResult(complaint: Complaint, changed: boolean): AdminComplaintWriteResult {
  return {
    complaintId: complaint.id,
    status: complaint.status,
    statusLabel: COMPLAINT_STATUS_LABELS[complaint.status],
    handledAt: complaint.handledAt,
    changed,
  };
}

/**
 * 开始处理：`pending → processing`。
 *
 * ⚠️ **不产生任何结论**：只有状态变化，处理结果一个字都不写（写入侧在
 * `start-processing` 意图下连 `result` 参数都不读）。也没有任何订单或退款代码会执行。
 */
export async function startProcessingAdminComplaint(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminComplaintWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  // 传空串而不是「不传」：三个意图共用一条写入路径，`start-processing` 会忽略它
  const outcome = await applyAdminComplaintIntent(id, "start-processing", "", writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.complaint, outcome.changed);
}

/**
 * 解决：`pending | processing → resolved`。
 *
 * ⚠️ **必须填写处理结果**（`normalizeAdminComplaintResult`，`intent: "resolve"`）。
 * 处理结果会同步展示给提交投诉的用户，因此它同时是「给用户的答复」。
 *
 * ⚠️ **不改订单、不退款**：解决一条投诉不会让任何一笔钱动起来。
 * 用户要退款仍然要走退款申请那一套。
 */
export async function resolveAdminComplaint(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminComplaintWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const result = normalizeAdminComplaintResult(readTrimmedString(body, "result"), "resolve");
  if (!result.ok) throw new ApiError("BAD_REQUEST", result.message, 400);

  const outcome = await applyAdminComplaintIntent(id, "resolve", result.value, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.complaint, outcome.changed);
}

/**
 * 关闭：`pending | processing → closed`。**终态，不可再改为已处理。**
 *
 * ⚠️ **关闭说明必填**，且与「解决」共用同一个字段（`result`）但**文案不同**：
 * 对客服说「请填写处理结果」与「请填写关闭说明」是两件事，
 * 前者是「你怎么处理的」，后者是「为什么关掉」。
 */
export async function closeAdminComplaint(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminComplaintWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const note = normalizeAdminComplaintResult(readTrimmedString(body, "result"), "close");
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);

  const outcome = await applyAdminComplaintIntent(id, "close", note.value, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.complaint, outcome.changed);
}
