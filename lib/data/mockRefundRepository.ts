import { compareRefundsForAdmin } from "@/lib/constants/adminRefunds";
import { isActiveRefundStatus } from "@/lib/constants/refunds";
import { refundSeed } from "@/lib/mocks/fixtures/refundSeed";
import type { ActorRole } from "@/lib/types/actor";
import type { RefundDecision, RefundRequest, RefundStatus } from "@/lib/types/refund";
import { getMockStore } from "./mockStore";
import type {
  AdminRefundQueryFilter,
  CancelRefundOutcome,
  CreateRefundOutcome,
  RefundRepository,
} from "./refundRepository";

/**
 * 退款申请的**进程内** Mock 存储。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后全部丢失；不写 localStorage、
 * 不写文件、不写数据库。将来由真实数据库替换（订单唯一索引 + 事务），
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`：`createStore` 只执行一次，
 * 预置的退款申请与用户新提交的申请因此进的是**同一个 Map、同一套查询方法**，
 * 不会出现「新提交的申请在列表里看不到」。
 *
 * 并发安全的前提：Node 是单线程的，而下面「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 */

type MockRefundStore = {
  refunds: Map<string, RefundRequest>;
  /** `${userId}:${idempotencyKey}` → 退款申请 id */
  refundIdByKey: Map<string, string>;
  /**
   * orderId → 该订单的退款申请 id **列表**，按创建先后排列。
   *
   * ⚠️ **P0-13 起由单值改为多值**：部分退款要求同一订单能有多条申请
   * （「一次退不完、之后再退一次」），而原来的单值索引 + 创建时的
   * `order_has_active_refund` 拒绝路径让这件事根本不可能发生。
   * 未来数据库上它不再是唯一索引，而是一条普通索引 + 「同一订单同一时刻
   * 最多一条进行中」的部分唯一索引。
   */
  refundIdsByOrder: Map<string, string[]>;
};

function createStore(): MockRefundStore {
  const refunds = new Map(refundSeed.map((refund) => [refund.id, refund]));
  const refundIdsByOrder = new Map<string, string[]>();
  for (const refund of refundSeed) {
    // ⚠️ 这里**不再**检查「一个订单只有一条退款」——P0-13 起那是合法数据。
    // 保留的只有「同一条种子不能出现两次」这个 trivial 事实，它由上面的 Map 保证。
    const list = refundIdsByOrder.get(refund.orderId) ?? [];
    list.push(refund.id);
    refundIdsByOrder.set(refund.orderId, list);
  }

  return { refunds, refundIdByKey: new Map(), refundIdsByOrder };
}

function store(): MockRefundStore {
  return getMockStore("refund", createStore);
}

/**
 * 把这份存储交给伪事务使用（**只读句柄，绝不在调用方缓存**）。
 *
 * 导出的理由与 `companionApplicationStore()` 一样：`adminRefundTransaction` 的原子区段
 * 需要读写这个 `Map`，而「读—判断—写」必须发生在同一段没有 `await` 的同步代码里。
 * 走 `getRefundRepository()` 的异步方法做不到这一点——每个 `await` 都会让出执行权。
 *
 * ⚠️ 测试里的 `resetMockStore()` 会换掉整份存储，因此句柄必须**每次现取**。
 */
export function refundStore(): MockRefundStore {
  return store();
}

function keyOf(userId: string, idempotencyKey: string): string {
  return `${userId}:${idempotencyKey}`;
}

/**
 * 某订单的**全部**退款申请，按创建先后排列（**同步读，无 `await`**）。
 *
 * ⚠️ 给伪事务用的：审批时要读「这一单此前已批准退款的冲回额之和」，
 * 而那个读取必须与后面的写入在同一段同步代码里（`adminRefundTransaction`）。
 * 因此它不能用 `getRefundRepository()` 的异步方法。
 *
 * 走索引而不是遍历 `refunds`：索引是「哪些申请属于这一单」这份事实的唯一表达，
 * 遍历 Map 再按 `orderId` 过滤等于把同一份事实重新推导一遍。
 */
export function listRefundsForOrderSync(orderId: string): RefundRequest[] {
  const current = store();
  const ids = current.refundIdsByOrder.get(orderId) ?? [];
  return ids
    .map((id) => current.refunds.get(id))
    .filter((refund): refund is RefundRequest => refund !== undefined);
}

export const mockRefundRepository: RefundRepository = {
  async findRefundById(id) {
    return store().refunds.get(id) ?? null;
  },

  async findRefundByKey(userId, idempotencyKey) {
    const id = store().refundIdByKey.get(keyOf(userId, idempotencyKey));
    return id ? (store().refunds.get(id) ?? null) : null;
  },

  async findRefundByOrderId(orderId) {
    // P0-13：一单可以有多条申请，这里给**最新的一条**（列表尾）。
    // 「最新」是页面要的那个：订单详情上的那张退款卡回答的是
    // 「这一单的退款现在走到哪了」，而不是「历史上退过几次」。
    const list = listRefundsForOrderSync(orderId);
    return list.length > 0 ? list[list.length - 1] : null;
  },

  async listRefundsByOrderId(orderId) {
    return listRefundsForOrderSync(orderId);
  },

  async createRefundRequest(refund, idempotencyKey): Promise<CreateRefundOutcome> {
    const current = store();
    const key = keyOf(refund.userId, idempotencyKey);

    // —— 原子区段开始（无 await）——
    // 1) 幂等：这个键提交过就直接返回上一次的结果
    const existingId = current.refundIdByKey.get(key);
    if (existingId) {
      const existing = current.refunds.get(existingId);
      if (existing) return { ok: true, refund: existing, created: false };
    }

    // 2) **同一时刻只能有一条进行中**（P0-13 起）。
    //    ⚠️ 判据是「进行中」而不是「有任何记录」：部分退款要求同一单能退第二次，
    //    因此已批准 / 已拒绝 / 已撤销的记录**不再挡**。这一处与
    //    `canRequestRefund(status, hasActiveRefund)` 是同一个判断的两处落点，
    //    而这里是**真正生效**的那一处（服务层那次只是提前给出好一点的提示）。
    const existingForOrder = listRefundsForOrderSync(refund.orderId).find((item) =>
      isActiveRefundStatus(item.status),
    );
    if (existingForOrder) {
      return { ok: false, reason: "order_has_active_refund", existing: existingForOrder };
    }

    current.refunds.set(refund.id, refund);
    current.refundIdByKey.set(key, refund.id);
    const list = current.refundIdsByOrder.get(refund.orderId) ?? [];
    list.push(refund.id);
    current.refundIdsByOrder.set(refund.orderId, list);
    // —— 原子区段结束 ——

    return { ok: true, refund, created: true };
  },

  async cancelRefund(id, userId, cancelledAt): Promise<CancelRefundOutcome> {
    const current = store();

    // —— 原子区段开始（无 await）——
    const refund = current.refunds.get(id);
    // 不存在与不属于你表现完全一致：调用方无法用接口枚举别人的退款申请 id
    if (!refund || refund.userId !== userId) return { ok: false, reason: "not_found" };
    if (refund.status !== "pending") return { ok: false, reason: "not_cancellable" };

    const updated: RefundRequest = {
      ...refund,
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
    };
    current.refunds.set(id, updated);
    // —— 原子区段结束 ——

    return { ok: true, refund: updated };
  },

  async queryRefundsForAdmin(filter: AdminRefundQueryFilter) {
    return [...store().refunds.values()]
      .filter((refund) => filter.status === null || refund.status === filter.status)
      .sort(compareRefundsForAdmin);
  },
};

/**
 * 审核动作的**同步写入器**（无 `await`）。
 *
 * ⚠️ 与 `applyApplicationReview` / `applyOrderRefund` 同一套路：**只负责写**，
 * 不判断这次迁移合不合法——合法性由伪事务在调用它之前用状态机判定。
 *
 * ⚠️ P8D-2 起管理端与客服端共用这一个写入器（调用方是 `adminRefundTransaction`
 * 的原子区段）。因此「审核人」不再必然是管理员，而是由 `input` 带进来的
 * `actorId` / `actorRole` / `actorName` 三样——三个字段必须一起写，
 * 只写 id 会让读的人不知道去哪张表查这个名字。
 *
 * 三个目标状态各写各的字段，`from` 一律从记录里现读（因此不存在「调用方记错了原状态」）：
 * - `reviewing`：只写 `reviewingAt`。**不写审核人与意见**——开始审核还没有结论；
 * - `approved` / `rejected`：写 `reviewedAt` 与审核人三件套，意见用传入的那份
 *   （拒绝对应的意见由服务层校验为非空；通过时传既有意见，通常是空串）。
 *
 * `amount`、`reasonKey`、`description`、`evidence`、`orderId`、`userId` **一个都不碰**：
 * 这张表里没有任何一个字段是平台侧可改的，`amount` 尤其——它是申请创建时的订单实付快照。
 * 客服身份的加入没有改变这一点：客服看得到金额，但同样改不了（没有写它的参数）。
 *
 * ⚠️ **P0-13：`decision` 是唯一新增的可写字段**，而且它**只在 `to === "approved"` 时写**。
 * 这不是把上面那条「平台侧不可改金额」放宽了——`amount` 仍然一个字节都不动。
 * 决策是**另一个字段**：它记的是「这一次退多少、谁承担」，
 * 而「这一单申请时实付多少」是历史事实，两者回答不同的问题（见 `RefundDecision` 的注释）。
 * 把决策写进 `amount` 才是真的违规。
 *
 * ⚠️ `decision` 由伪事务算好后传进来（**同步写入器不做金额算术**）：
 * 算金额要读订单与既往申请，那是伪事务在原子区段里做的事。
 *
 * ⚠️ 又是**同步**的：它只在 `adminRefundTransaction` 的原子区段里被调用。
 */
export function applyRefundReview(
  id: string,
  to: Extract<RefundStatus, "reviewing" | "approved" | "rejected">,
  input: {
    at: string;
    reviewNote: string;
    actorId: string;
    actorRole: ActorRole;
    actorName: string | null;
    /**
     * 这一次退款的资金决策。只有 `to === "approved"` 时才会被写入；
     * 其余两个目标状态一律**保持原值不变**（拒绝一条申请不该抹掉它的历史决策，
     * 而实际上被拒的申请从来没有决策，因此保持原值就是保持 null）。
     */
    decision?: RefundDecision | null;
  },
): { previous: RefundRequest; updated: RefundRequest } | null {
  const current = store();
  const refund = current.refunds.get(id);
  if (!refund) return null;

  const previous = { ...refund };
  const settled = to === "approved" || to === "rejected";
  const approved = to === "approved";

  const updated: RefundRequest = {
    ...refund,
    status: to,
    updatedAt: input.at,
    decision: approved ? (input.decision ?? null) : refund.decision,
    // 只有「开始审核」这一步写 reviewingAt。`pending → approved` 是合法迁移（§退款审核），
    // 那条路径上平台没有单独走「开始审核」，因此**不替它补一个时间**——
    // 补了会让进度时间轴凭空多出一个没人做过的节点。
    reviewingAt: to === "reviewing" ? input.at : refund.reviewingAt,
    // 只有出了结果才写审核人与审核时间；开始审核只更新「审核中」这一格
    reviewedAt: settled ? input.at : refund.reviewedAt,
    reviewedBy: settled ? input.actorId : refund.reviewedBy,
    reviewedByRole: settled ? input.actorRole : refund.reviewedByRole,
    reviewedByName: settled ? input.actorName : refund.reviewedByName,
    reviewNote: settled ? input.reviewNote : refund.reviewNote,
  };
  current.refunds.set(id, updated);

  return { previous, updated };
}
