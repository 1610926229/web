import { ApiError } from "@/lib/api/ApiError";
import {
  normalizeAdminReviewNote,
} from "@/lib/constants/adminRefunds";
import { REFUND_STATUS_LABELS } from "@/lib/constants/refunds";
import { toStaffCompanionReleaseEntry } from "@/lib/constants/staff";
import {
  DEFAULT_STAFF_REFUND_STATUS_FILTER,
  STAFF_REFUND_LIST_NOTICE,
  STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  STAFF_REFUND_NOT_FOUND_MESSAGE,
  STAFF_REFUND_OPERATION_CONFLICT_MESSAGE,
  STAFF_REFUND_STATUS_INVALID_MESSAGE,
  buildStaffRefundListQuery,
  compareStaffRefunds,
  readStaffRefundStatusFilter,
  staffRefundMatchesKeyword,
  staffRefundTransitionMessage,
  toStaffRefundDetail,
  toStaffRefundListItem,
  type StaffRefundListQuery,
} from "@/lib/constants/staffRefunds";
import { IDEMPOTENCY_KEY_PATTERN, readIdempotencyKey, readTrimmedString } from "@/lib/constants/writes";
import {
  rejectRefund,
  startReviewRefund,
  type AdminWriteContext,
  type RefundReviewWriteFailure,
} from "@/lib/data/adminRefundTransaction";
import { getCompanionReleaseRepository } from "@/lib/data/companionReleaseRepository";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import { getMessageRepository } from "@/lib/data/messageRepository";
import { ADMIN_ORDER_UNFILTERED_QUERY, getPaymentRepository } from "@/lib/data/paymentRepository";
import { getRefundRepository } from "@/lib/data/refundRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { Order } from "@/lib/types/order";
import type {
  RefundRequest,
  RefundStatus,
  StaffRefundDetail,
  StaffRefundListData,
  StaffRefundWriteResult,
} from "@/lib/types/refund";
import type {
  StaffCompanionReleaseEntry,
  StaffSessionUser,
  StaffUserSummary,
} from "@/lib/types/staff";

/**
 * 客服工作台「退款处理」服务 —— 列表、详情与两个审核动作的唯一入口。
 *
 * ⚠️ 本文件**只服务客服端**，每一个调用它的接口都先经过 `requireStaff()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`lib/api/staffRoute.ts`）。
 *
 * ⚠️ **本文件接收不到金额**。两个动作的入参只有幂等键与（驳回时的）审核意见；
 * 退款金额是申请创建时的服务端订单实付快照，客服端**没有任何入口**能改它。
 *
 * ⚠️ **两个动作的业务规则不在这里判断**：合法迁移在 `lib/constants/adminRefunds.ts`
 * 的状态机里，原子写入在 `lib/data/adminRefundTransaction.ts` 的伪事务里。
 * 这里只做三件事：解析入参、把失败翻译成明确的接口错误、把成功翻译成 DTO。
 *
 * ⚠️ 写操作的 `ctx` **只从 `requireStaff()` 返回的会话拼**：`actorId` = 客服 id、
 * `actorRole` = `customer_service`、`actorName` = 客服显示名快照。请求体里的
 * actor 字段在这里没有任何进入路径。
 */

// ——————————————————————————— 用户与订单摘要 ———————————————————————————

/**
 * userId → 用户摘要。与订单列表同一做法：一次取回全部用户，避免逐条查询。
 *
 * ⚠️ 字段表就是边界：`StaffUserSummary` 只有 id / 昵称 / 头像，
 * 没有平台展示 ID，也没有任何支付相关字段。
 */
async function staffUserIndex(): Promise<Map<string, StaffUserSummary>> {
  const users = await getUserRepository().listUsers();
  return new Map(
    users.map((user) => [
      user.id,
      { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
    ]),
  );
}

/**
 * orderId → 订单。
 *
 * ⚠️ 关键词里含**订单号**，而订单号在订单上、不在退款申请上。因此匹配必须在分页**之前**
 * 完成，也就必须先把订单取回来。
 */
async function staffOrderIndex(): Promise<Map<string, Order>> {
  const orders = await getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
  return new Map(orders.map((order) => [order.id, order]));
}

/** 退款申请挂着的订单。找不到属于存储被写坏，当作这条退款不可读。 */
function orderOf(index: Map<string, Order>, refund: RefundRequest): Order | undefined {
  return index.get(refund.orderId);
}

/** 用户记录缺失时的占位摘要（缺一条用户记录不该让整页打不开）。 */
function missingUser(userId: string): StaffUserSummary {
  return { id: userId, nickname: "", avatarUrl: "" };
}

/**
 * 订单 → 客服可读的履约退出历史（P0-6）。
 *
 * 客服看一笔退款时最先会问的是「有人在服务前取消过接单吗」——那件事在订单上
 * 已经查不到了（取消之后履约人被清空，订单要能重新进公共池）。
 *
 * ⚠️ 与 `staffUserIndex()` / `missingUser()` 一样，这是**客服侧各服务各写一份的私有小助手**：
 * 「一条退出历史怎么变成客服看得懂的条目」不在这里——它在
 * `toStaffCompanionReleaseEntry()`（唯一转换点），因此三处不会出现三种口径。
 * 名字用 `findCompanionById()`（事后被下架的护航照样要显示得出名字），
 * 查不到时传空串、由构造函数回落到 `companionId`。
 *
 * ⚠️ 它与金额**无关**：本轮退出不退款、不罚款，因此既不改 `amount`，
 * 也不改任何审核结论——它只是这一单发生过的事实的只读记录。
 *
 * 没有退出过返回**空数组**，不是 `null`：那是正常情况，不是「查不到」。
 */
async function releaseHistoryFor(orderId: string): Promise<StaffCompanionReleaseEntry[]> {
  const records = await getCompanionReleaseRepository().listReleasesByOrderId(orderId);
  if (records.length === 0) return [];

  // 同一单上可能同一位护航退出过多次：按 id 缓存名字，不重复查同一条资料
  const names = new Map<string, string>();
  for (const record of records) {
    if (names.has(record.companionId)) continue;
    const companion = await getCompanionRepository().findCompanionById(record.companionId);
    names.set(record.companionId, companion ? companion.displayName : "");
  }

  return records.map((record) =>
    toStaffCompanionReleaseEntry(record, names.get(record.companionId) ?? ""),
  );
}

// ——————————————————————————— 列表 ———————————————————————————

/**
 * 解析列表查询条件。**接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化。
 *
 * 状态筛选必须解析：一个手改坏的状态若静默按默认值处理，页面会显示一批与筛选栏不符的申请。
 */
export function resolveStaffRefundListQuery(
  params: URLSearchParams,
  strict: boolean,
): StaffRefundListQuery {
  const status = readStaffRefundStatusFilter(params.get("status"));
  if (strict && status === null) {
    throw new ApiError("BAD_REQUEST", STAFF_REFUND_STATUS_INVALID_MESSAGE, 400);
  }

  return buildStaffRefundListQuery({
    params,
    status: status ?? DEFAULT_STAFF_REFUND_STATUS_FILTER,
  });
}

/**
 * 客服端退款列表。
 *
 * `?mockEmpty=refunds` 演示空列表（空数据不是错误，不抛错，由页面渲染空态）；
 * `?mockError=…` 由 `withMockDebug` 统一处理。两者都只在 `ENABLE_MOCK_DEBUG=true` 时生效，
 * 且都在这一层处理——`app/staff/**` 下的页面不引用 `lib/mocks`。
 */
export async function listStaffRefunds(
  query: StaffRefundListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffRefundListData> {
  return withMockDebug(params, surface, async () => {
    if (mockEmptyApplies(params, "refunds")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        notice: STAFF_REFUND_LIST_NOTICE,
      };
    }

    const [rows, orders, users] = await Promise.all([
      getRefundRepository().queryRefundsForAdmin({
        status: query.status === "all" ? null : query.status,
      }),
      staffOrderIndex(),
      staffUserIndex(),
    ]);

    const matched = rows
      .map((refund) => ({ refund, order: orderOf(orders, refund) }))
      .filter((row): row is { refund: RefundRequest; order: Order } => row.order !== undefined)
      .filter(({ refund, order }) => {
        const user = users.get(refund.userId);
        return staffRefundMatchesKeyword(
          {
            refundNo: refund.refundNo,
            orderNo: order.orderNo,
            nickname: user?.nickname ?? "",
          },
          query.keyword,
        );
      })
      .sort((a, b) => compareStaffRefunds(a.refund, b.refund));

    const start = (query.page - 1) * query.pageSize;
    const items = matched
      .slice(start, start + query.pageSize)
      .map(({ refund, order }) =>
        toStaffRefundListItem(refund, order, users.get(refund.userId) ?? missingUser(refund.userId)),
      );

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: matched.length,
      hasMore: start + items.length < matched.length,
      notice: STAFF_REFUND_LIST_NOTICE,
    };
  });
}

/**
 * 客服端退款详情。不存在（或它的订单不可读）返回 null，由页面 `notFound()`。
 *
 * 详情里补齐原因、说明、凭证、金额对照、审核信息、进度时间轴与**服务端判定的**
 * `allowedActions`，以及**关联会话入口**（§八：只有已经存在会话的订单才给出
 * `/staff/conversations/[orderId]` 链接，没有沟通记录时为 null）。
 */
export async function getStaffRefundDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<StaffRefundDetail | null> {
  if (!id) return null;

  return withMockDebug(params, surface, async () => {
    const refund = await getRefundRepository().findRefundById(id);
    if (!refund) return null;

    const order = await getPaymentRepository().findOrderById(refund.orderId);
    if (!order) return null;

    const users = await staffUserIndex();

    // §八：只读现有仓储，不新建任何方法。会话不存在时给 null，页面就不给入口。
    const conversation = await getMessageRepository().findConversationForStaff(refund.orderId);

    // 履约退出历史（P0-6）：与上一步同一个理由——退款详情有自己的订单区，
    // 而「进入会话」入口在没有沟通记录时是 null，只挂会话页会让这类退款漏掉它
    const releaseHistory = await releaseHistoryFor(refund.orderId);

    return toStaffRefundDetail(
      refund,
      order,
      users.get(refund.userId) ?? missingUser(refund.userId),
      conversation ? refund.orderId : null,
      releaseHistory,
    );
  });
}

// ——————————————————————————— 两个审核动作 ———————————————————————————

/**
 * 从请求体里取幂等键。
 *
 * ⚠️ **不能依赖按钮禁用防重**：按钮只能挡住手快，挡不住网络重试与用户刷新后重发，
 * 也挡不住直接请求接口。真正的防重是这里读到的幂等键，加上伪事务里的重放判定。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
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
    throw new ApiError("BAD_REQUEST", STAFF_REFUND_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
}

/**
 * 组装一次写操作的上下文。时间戳只取一次，业务写入与审计写入共用同一个。
 *
 * ⚠️ 与管理端 `writeContext` 的差别只有两处，而且都是**刻意**的：
 * `actorRole` 是 `customer_service`（不是 `admin`），`actorName` 是客服显示名快照
 * （不是 null）——客服没有「匿名审核人」这一说，驳回之后用户端要显示得出谁批的。
 */
function writeContext(staff: StaffSessionUser, operationId: string): AdminWriteContext {
  return {
    actorId: staff.id,
    actorRole: "customer_service",
    actorName: staff.displayName,
    operationId,
    at: new Date().toISOString(),
  };
}

/** 把伪事务的「不合法迁移」翻译成带当前状态的 400（文案取自常量层）。 */
function invalidTransition(status: RefundStatus): ApiError {
  return new ApiError("BAD_REQUEST", staffRefundTransitionMessage(status), 400);
}

/** 伪事务的结果 → 接口返回。客服的两个动作都不动订单，因此 DTO 里没有订单字段。 */
function toWriteResult(refund: RefundRequest, changed: boolean): StaffRefundWriteResult {
  return {
    refundId: refund.id,
    status: refund.status,
    statusLabel: REFUND_STATUS_LABELS[refund.status],
    reviewedAt: refund.reviewedAt,
    changed,
  };
}

/**
 * 两个动作共用的失败翻译。
 *
 * ⚠️ 入参刻意是 `RefundReviewWriteFailure` 而不是 `AdminRefundWriteFailure`：
 * 客服这两个动作不带资金决策，`decision-invalid` 在类型上就进不来，
 * 因此这里不需要（也不应该）为它编一句客服侧的说法。
 */
function toApiError(outcome: RefundReviewWriteFailure): ApiError {
  switch (outcome.kind) {
    case "not-found":
      return new ApiError("NOT_FOUND", STAFF_REFUND_NOT_FOUND_MESSAGE, 404);
    case "invalid-transition":
      return invalidTransition(outcome.status);
    case "operation-conflict":
      return new ApiError("BAD_REQUEST", STAFF_REFUND_OPERATION_CONFLICT_MESSAGE, 400);
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
export async function startReviewStaffRefund(
  id: string,
  staff: StaffSessionUser,
  body: Record<string, unknown>,
): Promise<StaffRefundWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const outcome = await startReviewRefund(id, writeContext(staff, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.refund, outcome.changed);
}

/**
 * 驳回：`pending | reviewing → rejected`。
 *
 * ⚠️ **必须填写审核意见**，规则复用 `normalizeAdminReviewNote`（与入驻审核、管理端
 * 退款共用同一份）。这是**导入的现成实现**，不是本文件另写的一份。
 *
 * ⚠️ **不改订单状态，也不改任何消费金额**：用户看到的订单继续按原进度走。
 */
export async function rejectStaffRefund(
  id: string,
  staff: StaffSessionUser,
  body: Record<string, unknown>,
): Promise<StaffRefundWriteResult> {
  const operationId = requireIdempotencyKey(body);
  assertIdempotencyKeyShape(operationId);

  const note = normalizeAdminReviewNote(readTrimmedString(body, "reviewNote"));
  if (!note.ok) throw new ApiError("BAD_REQUEST", note.message, 400);

  const outcome = await rejectRefund(id, note.value, writeContext(staff, operationId));
  if (outcome.kind !== "ok") throw toApiError(outcome);

  return toWriteResult(outcome.value.refund, outcome.changed);
}
