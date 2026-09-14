import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_REFUND_LIST_NOTICE,
  ADMIN_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_REFUND_NOT_FOUND_MESSAGE,
  ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE,
  ADMIN_REFUND_STATUS_INVALID_MESSAGE,
  DEFAULT_ADMIN_REFUND_STATUS_FILTER,
  adminRefundTransitionMessage,
  buildAdminRefundListQuery,
  normalizeAdminReviewNote,
  readAdminRefundStatusFilter,
  refundMatchesAdminKeyword,
  toAdminRefundDetail,
  toAdminRefundListItem,
  type AdminRefundListQuery,
} from "@/lib/constants/adminRefunds";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import { REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { IDEMPOTENCY_KEY_PATTERN, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import {
  approveRefund,
  rejectRefund,
  startReviewRefund,
  type AdminRefundWriteFailure,
  type AdminWriteContext,
} from "@/lib/data/adminRefundTransaction";
import { ADMIN_ORDER_UNFILTERED_QUERY, getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  AdminRefundDetail,
  AdminRefundListData,
  AdminRefundWriteResult,
  RefundRequest,
  RefundStatus,
} from "@/lib/types/refund";
import type { AdminUserSummary } from "@/lib/types/user";

/**
 * 管理端「退款审核」服务 —— 列表、详情与三个审核动作的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/adminRoute.ts`）。
 *
 * ⚠️ **本文件接收不到金额**。三个动作的入参只有幂等键与审核意见两个字符串；
 * 退款金额是申请创建时的服务端订单实付快照，管理端**没有任何入口**能改它
 * （写入侧 `applyRefundReview` 也没有接收金额的位置）。这不是靠调用方自觉，
 * 是类型上就没有那个字段。
 *
 * ⚠️ **三个动作的业务规则不在这里判断**：合法迁移在 `lib/constants/adminRefunds.ts`
 * 的状态机里，原子写入在 `lib/data/adminRefundTransaction.ts` 的伪事务里。
 * 这里只做三件事：解析入参、把失败翻译成明确的接口错误、把成功翻译成 DTO。
 */

// ——————————————————————————— 用户与订单摘要 ———————————————————————————

/**
 * userId → 用户摘要。与订单列表同一做法：一次取回全部用户，避免逐条查询。
 */
async function adminUserIndex(): Promise<Map<string, AdminUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [user.id, { id: user.id, displayId: user.displayId, nickname: user.nickname }]),
  );
}

/**
 * orderId → 订单。
 *
 * ⚠️ 关键词里含**订单号**，而订单号在订单上、不在退款申请上。因此匹配必须在分页**之前**
 * 完成，也就必须先把订单取回来——逐条 `findOrderById` 会让「先翻到第 2 页、再判断这一页
 * 命中没有」成为唯一可能的顺序，那样 `total` 与实际能翻到的条数必然分叉。
 */
async function adminOrderIndex(): Promise<Map<string, Order>> {
  const orders = await getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
  return new Map(orders.map((order) => [order.id, order]));
}

/**
 * 退款申请挂着的订单。
 *
 * 订单一定存在（退款只能针对已有订单创建，订单也不会被删除），因此「找不到」属于
 * 存储被写坏的不可能状态。读侧对它的处理是**当作这条退款不可读**：
 * 列表跳过、详情返回 null（由接口转 404）。理由与假事务里那句注释一致——
 * 刚确认过的东西再查不到，只能说明数据坏了；此时**编不出一条订单摘要来**，
 * 硬凑一行「订单号为空、状态未知」的记录会让读到它的人以为真有这么一单。
 *
 * ⚠️ 注意这与 §原子性 要求的不是同一件事：那一条管的是**写**不能半完成，
 * 而这里连写都到不了（`order-missing` 在任何写入之前就被挡掉了）。
 */
function orderOf(index: Map<string, Order>, refund: RefundRequest): Order | undefined {
  return index.get(refund.orderId);
}

/** 用户记录缺失时的占位摘要（同订单列表：缺一条用户记录不该让整页打不开）。 */
function missingUser(userId: string): AdminUserSummary {
  return { id: userId, nickname: "", displayId: "" };
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 *
 * 状态筛选必须解析：一个手改坏的状态若静默按默认值处理，页面会显示一批与筛选栏不符的申请。
 */
export async function resolveAdminRefundListQuery(
  params: URLSearchParams,
  strict: boolean,
): Promise<AdminRefundListQuery> {
  const status = readAdminRefundStatusFilter(params.get("status"));
  if (strict && status === null) {
    throw new ApiError("BAD_REQUEST", ADMIN_REFUND_STATUS_INVALID_MESSAGE, 400);
  }

  return buildAdminRefundListQuery({
    params,
    status: status ?? DEFAULT_ADMIN_REFUND_STATUS_FILTER,
  });
}

/**
 * 管理端退款列表。
 *
 * `?mockEmpty=refunds` 演示空列表（空数据不是错误，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两者都只在 `ENABLE_MOCK_DEBUG=true` 时生效，
 * 且都在这一层处理——`app/admin/**` 下的页面不引用 `lib/mocks`。
 */
export async function queryAdminRefundList(
  query: AdminRefundListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminRefundListData> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "refunds")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        notice: ADMIN_REFUND_LIST_NOTICE,
      };
    }

    const [rows, orders, users] = await Promise.all([
      getRefundRepository().queryRefundsForAdmin({
        status: query.status === "all" ? null : query.status,
      }),
      adminOrderIndex(),
      adminUserIndex(),
    ]);

    const matched = rows
      .map((refund) => ({ refund, order: orderOf(orders, refund) }))
      .filter((row): row is { refund: RefundRequest; order: Order } => row.order !== undefined)
      .filter(({ refund, order }) => {
        const user = users.get(refund.userId);
        return refundMatchesAdminKeyword(
          {
            refundNo: refund.refundNo,
            orderNo: order.orderNo,
            nickname: user?.nickname ?? "",
            displayId: user?.displayId ?? "",
          },
          query.keyword,
        );
      });

    // 分页排在关键词过滤之后：数据层只回答「某个状态的有哪些、什么顺序」
    const start = (query.page - 1) * query.pageSize;
    const items = matched
      .slice(start, start + query.pageSize)
      .map(({ refund, order }) =>
        toAdminRefundListItem(refund, order, users.get(refund.userId) ?? missingUser(refund.userId)),
      );

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      hasMore: start + items.length < matched.length,
      notice: ADMIN_REFUND_LIST_NOTICE,
    };
  });
}

/**
 * 管理端退款详情。不存在（或它的订单不可读）返回 null，由页面 `notFound()`。
 *
 * 详情里补齐原因、说明、凭证、审核信息、进度时间轴与**服务端判定的** `allowedActions`：
 * 页面不拿状态自己写 `if`，终态三项都是 false。
 */
export async function getAdminRefundDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminRefundDetail | null> {
  if (!id) return null;

  return withMockDebug(params, surface, async () => {
    const refund = await getRefundRepository().findRefundById(id);
    if (!refund) return null;

    const order = await getPaymentRepository().findOrderById(refund.orderId);
    if (!order) return null;

    const users = await adminUserIndex();

    return toAdminRefundDetail(
      refund,
      order,
      users.get(refund.userId) ?? missingUser(refund.userId),
    );
  });
}

// ——————————————————————————— 三个审核动作 ———————————————————————————

/**
 * 从请求体里取幂等键。
 *
 * ⚠️ **不能依赖按钮禁用防重**（§九）：按钮只能挡住手快，挡不住网络重试与用户刷新后重发，
 * 也挡不住直接请求接口。真正的防重是这里读到的幂等键，加上伪事务里的重放判定。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", ADMIN_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
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
    throw new ApiError("BAD_REQUEST", ADMIN_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
}

/** 组装一次写操作的上下文。时间戳只取一次，业务写入与审计写入共用同一个。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return { adminId, operationId, at: new Date().toISOString() };
}

/** 把伪事务的「不合法迁移」翻译成带当前状态的 400（文案取自常量层）。 */
function invalidTransition(status: RefundStatus): ApiError {
  return new ApiError("BAD_REQUEST", adminRefundTransitionMessage(status), 400);
}

/**
 * 审核意见：**拒绝必填，通过选填**。
 *
 * 两者共用同一个长度上限与同一个「不能只有空白」的判定（`normalizeAdminReviewNote`），
 * 区别只有一个：通过时留空是允许的——批准一笔退款通常不需要额外解释，
 * 强行要求填写只会逼出一堆「ok」。
 *
 * ⚠️ 但**一旦写了就按同一套规则校验**：长度上限不会因为「这是通过」而放宽，
 * 否则同一条意见在两个动作里的可容纳长度不同，没人能说出哪个才对。
 */
function normalizeOptionalReviewNote(raw: string): string {
  const value = raw.trim();
  if (!value) return "";

  const note = normalizeAdminReviewNote(value);
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);
  return note.value;
}

/** 伪事务的结果 → 接口返回。订单状态如实反映写入之后的订单。 */
function toWriteResult(
  refund: RefundRequest,
  order: Pick<Order, "id" | "status">,
  changed: boolean,
  orderChanged: boolean,
): AdminRefundWriteResult {
  return {
    refundId: refund.id,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    orderId: order.id,
    orderStatus: order.status,
    orderStatusLabel: ORDER_STATUS_LABELS[order.status],
    reviewedAt: refund.reviewedAt,
    changed,
    orderChanged,
  };
}

/** 三个动作共用的失败翻译。三个 `switch` 的每种情形完全相同，写三遍只会写出三种口径。 */
function toApiError(outcome: AdminRefundWriteFailure): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", ADMIN_REFUND_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      return invalidTransition(outcome.status);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", ADMIN_REFUND_OPERATION_CONFLICT_MESSAGE, 400);
    case "order-missing":
      // 退款申请挂着的订单不见了，属于服务端数据问题，报 500 而不是 404
      return new ApiError("SERVER_ERROR", "退款申请对应的订单不存在，请联系技术支持", 500);
  }
}

/**
 * 开始审核：`pending → reviewing`。
 *
 * ⚠️ **只改退款申请**：订单状态、金额与用户的消费统计都不变，
 * 也**不写审核人与审核意见**——那两样是「结果」，这一步还没有结果。
 */
export async function startReviewAdminRefund(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminRefundWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const outcome = await startReviewRefund(id, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.refund, outcome.value.order, outcome.changed, false);
}

/**
 * 通过：`pending | reviewing → approved`，并**在同一次写入里**把订单改成 `refunded`。
 *
 * 四件事（退款状态、审核人 / 意见 / 时间、订单状态、审计）由伪事务在同一段无 `await`
 * 的同步区段里完成，因此不会出现「退款已通过但订单未退款」或相反的半完成状态。
 *
 * 审核意见选填，见 `normalizeOptionalReviewNote`。
 */
export async function approveAdminRefund(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminRefundWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const reviewNote = normalizeOptionalReviewNote(readTrimmedString(body, "reviewNote"));

  const outcome = await approveRefund(id, reviewNote, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(
    outcome.value.refund,
    outcome.value.order,
    outcome.changed,
    outcome.value.orderChanged,
  );
}

/**
 * 拒绝：`pending | reviewing → rejected`。
 *
 * ⚠️ **必须填写审核意见**，规则在 `lib/constants/adminApplications.ts` 的
 * `normalizeAdminReviewNote()`（与入驻审核共用一份）。
 *
 * ⚠️ **不改订单状态，也不改任何消费金额**：用户看到的订单继续按原进度走，
 * 累计有效消费不受影响。这正是「退款状态与订单状态是两条独立的线」在拒绝路径上的体现。
 */
export async function rejectAdminRefund(
  id: string,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminRefundWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const note = normalizeAdminReviewNote(readTrimmedString(body, "reviewNote"));
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);

  const outcome = await rejectRefund(id, note.value, writeContext(adminId, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.refund, outcome.value.order, outcome.changed, false);
}

