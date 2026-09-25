import { ApiError } from "@/lib/api/ApiError";
import {
  COMPANION_CANCEL_REASON_REQUIRED_MESSAGE,
  COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE,
  COMPANION_ORDER_NOT_FOUND_MESSAGE,
  COMPANION_ORDER_NOT_STARTABLE_MESSAGE,
  ORDER_DATA_INCONSISTENT_MESSAGE,
} from "@/lib/constants/dispatch";
import { ORDER_STATUS_LABELS } from "@/lib/constants/orders";
import {
  IDEMPOTENCY_KEY_MISSING_MESSAGE,
  readIdempotencyKey,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  cancelAcceptedOrder,
  // 事务层与服务层同名（两处都是这个域动作的对外名字）。这里显式起别名，
  // 是为了让下面那一行调用一眼能看出「这是数据层的伪事务，不是本文件自己的函数」
  startCompanionOrder as startCompanionOrderTransaction,
} from "@/lib/data/companionOrderTransaction";
import { sweepCompletionAutoApprovals } from "@/lib/data/completionTransaction";
import { getPaymentRepository } from "@/lib/data/paymentRepository";
import { getUserRepository } from "@/lib/data/userRepository";
import type {
  CompanionCancelOutcome,
  CompanionOrderDetail,
  CompanionOrderListData,
  CompanionOrderListItem,
  CompanionStartOutcome,
  Order,
} from "@/lib/types/order";
import { getCompanionCompletionInfo } from "./companionCompletions";

/**
 * 打手「我的订单」服务（P0-6 / P0-7）—— 列表、详情与两个订单动作的**唯一**入口。
 *
 * ⚠️ **只被服务端引用**：本模块依赖 `lib/data` 与 `lib/mocks`，
 * 浏览器端取数走 `lib/services/companionHttp.ts`。两者分开是必须的，
 * 否则 Mock 存储与种子数据会被打进浏览器产物。
 *
 * ## 归属只按 `actualCompanionId`
 *
 * 四个导出函数都以 `Order.actualCompanionId === companionId` 为准：
 *
 * - 列表把它当**查询条件**（`queryOrdersByCompanion`），不是「查出来再比对」；
 * - 详情**服务端重新校验**，不是「列表里没有就等于看不到」——列表入口隐藏不是保护；
 * - 开始服务与取消把它当**真正的安全边界**（两个伪事务的原子区段里各再判一次）。
 *
 * ⚠️ `exclusiveCompanionId === companionId` **绝不等于**订单归本人：那是「用户当初
 * 指定了谁」的历史事实，订单回公共池、被别人接走之后都不清（见 `DispatchRecord`）。
 *
 * ## 这个模块不判资格
 *
 * 「他是不是打手」只由 `requireCompanion()`（接口）回答，本模块不再查一次。
 * 也不引入 `isCompanionAcceptingOrders()`（`available`）：那是「能不能接**新**单」，
 * 开始服务与取消针对的都是**已经在自己名下**的单，拿它当门槛会得出
 * 「暂停接单的人无法完成手上这一单」这个荒谬结论。
 *
 * ## DTO 最小化
 *
 * 两个函数都走 `toCompanionOrderListItem` / `CompanionOrderDetail` 的**显式挑字段**，
 * 绝不复用 `OrderDetail` 或 `AdminOrderDetail`：前者带平台金额域与售后摘要，
 * 后者带用户指定的人、退款与投诉摘要。给 `Order` 新增字段不会自动流到打手端响应里。
 */

/** 取消成功的两种结果（`ok` / `replayed`）。失败在 `cancelCompanionOrder` 里抛成 `ApiError`。 */
export type CompanionCancelSuccess = Extract<
  CompanionCancelOutcome,
  { kind: "ok" } | { kind: "replayed" }
>;

/**
 * 开始服务成功的两种结果（`ok` / `replayed`）。
 * 失败在 `startCompanionOrder` 里抛成 `ApiError`。
 */
export type CompanionStartSuccess = Extract<
  CompanionStartOutcome,
  { kind: "ok" } | { kind: "replayed" }
>;

/** 订单 → 打手端列表项。**显式挑字段**：新增的订单字段不会自动出现在这里。 */
function toCompanionOrderListItem(order: Order): CompanionOrderListItem {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    paidAt: order.paidAt,
    acceptedAt: order.acceptedAt,
    productTitle: order.productTitle,
    productCoverUrl: order.productCoverUrl,
    specName: order.specName,
    quantity: order.quantity,
    gameName: order.gameName,
    region: order.region,
    // 两个动作旗标都由服务端算好，前端不自己用状态推断
    // （见 CompanionOrderListItem.canCancel / canStart）
    canCancel: order.status === "accepted",
    // ⚠️ 与 `canCancel` 今天恰好同值（两个动作都只在 accepted 上成立），
    // 但它们是**两条独立的规则**：`serving` 的取消将来可能开放（TARGET），
    // 开始服务则永远不会。因此两处各写一遍，不合并成 `canAct`
    canStart: order.status === "accepted",
  };
}

/**
 * 把已经到点的完成材料自动通过写成事实。
 *
 * 与用户端 / 管理端订单读同一套惰性物化机制（P0-8）：自动通过不是被定时触发的，
 * 而是「deadline 到点就已经成立」，读取路径只是恰好把它写下来。打手提交完成材料后
 * 若一直没人打开用户 / 管理端 / 客服的读路径，他自己刷新订单也该看到「已完成」，
 * 而不是停在「护航中」——因此打手端的列表与详情两条读路径也都要挂。
 *
 * 重复执行幂等：第一次执行后 submission 已不是 pending，第二次直接跳过，
 * 不重复完成、不刷新 `completedAt`。真实调度器上线后调用**同一个**
 * `sweepCompletionAutoApprovals()`，**不是**另写一套。
 */
function materializeCompletionAutoApprovals(): void {
  sweepCompletionAutoApprovals(new Date().toISOString());
}

/**
 * 当前打手**实际履约过**的订单。
 *
 * 状态与排序都由仓储决定（支付时间倒序），服务层只做 DTO 裁剪：
 * 唯一的归属条件是 `actualCompanionId`，因此返回的每一单都是他自己接过的，
 * 里面不可能混进「用户指定给他、但他从没接」的单。
 *
 * `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份。
 */
export async function listCompanionOrders(companionId: string): Promise<CompanionOrderListData> {
  // 惰性物化自动通过事实（幂等）：列表同样展示订单状态，只挂详情会让列表停在 serving
  materializeCompletionAutoApprovals();

  const orders = await getPaymentRepository().queryOrdersByCompanion(companionId);
  return { items: orders.map(toCompanionOrderListItem) };
}

/**
 * 下单用户的昵称——只够在页面上称呼对方。
 *
 * 查不到用户记录时给空串，**不让整页报错**：订单本身是有效的，
 * 而预置订单里就有刻意不指向任何用户的条目。页面看到的是一行空称呼，
 * 不是一整页错误。
 */
async function resolveCustomerNickname(userId: string): Promise<string> {
  const user = await getUserRepository().findUserById(userId);
  return user?.nickname ?? "";
}

/**
 * 打手订单详情。
 *
 * **服务端重新校验归属**：订单不存在、或 `actualCompanionId` 不是本人，一律返回 `null`
 * ——两种情况的对外表现完全相同，由接口层转成同一个 404，因此不能拿别人的订单 id
 * 来试探它是否存在（`api-contract.md` §2.9）。不能只依赖「列表里看不到」。
 *
 * 详情里的 `gameAccountId` / `remark` 是**履约所必需**的：没有账号与备注就打不了这一单。
 * 除此之外仍然没有联系方式、平台展示 ID、头像、金额域与售后摘要。
 */
export async function getCompanionOrderDetail(
  companionId: string,
  orderId: string,
): Promise<CompanionOrderDetail | null> {
  if (!orderId) return null;

  // 惰性物化自动通过事实（幂等）：详情要显示得出「已完成」，而不是停在「护航中 + 已过期的
  // 自动审核截止时刻」（见 materializeCompletionAutoApprovals 的注释）
  materializeCompletionAutoApprovals();

  const order = await getPaymentRepository().findOrderById(orderId);
  if (!order || order.actualCompanionId !== companionId) return null;

  return {
    ...toCompanionOrderListItem(order),
    // ⚠️ `servingAt` **只在这里出现**，不进列表项：列表卡片只显示下单与接单两个节点，
    // `serving` 那一单在列表里由状态名「护航中」表达（见 CompanionOrderDetail 的注释）
    servingAt: order.servingAt,
    gameAccountId: order.gameAccountId,
    remark: order.remark,
    addons: order.addons,
    addonsAmount: order.addonsAmount,
    unitPrice: order.unitPrice,
    itemsAmount: order.itemsAmount,
    totalAmount: order.totalAmount,
    customerNickname: await resolveCustomerNickname(order.userId),
    // 完成材料摘要（P0-8）：`canSubmit` 由 `buildCompanionCompletionInfo` 服务端算好，
    // 页面只按值渲染，不自己用订单状态推断（serving + 已有 pending 时 canSubmit 为 false）
    completion: await getCompanionCompletionInfo(order.id, order),
  };
}

/**
 * 当前实际履约的打手主动取消接单。
 *
 * ## 本函数只做三件事：解析、取一个时刻、把事务结果转成对外结果
 *
 * 「能不能取消」（是不是本人、状态是不是还停在 `accepted`）全部在
 * `cancelAcceptedOrder` 的原子区段里判定，并在**同一段**代码里写完退出历史、
 * 订单、派单与通知。到这里再判一次就等于把判定与写入拆开——中间那段窗口正是
 * 「判完到写之间状态被改掉」的入口。
 *
 * ## 校验发生在这里，因为这里才有「返回 400」这件事
 *
 * 原因必须**非空**（只 trim，**不发明**长度规则：需求没有冻结字数，
 * 5～50 这类限制是自己造出来的），幂等键必须**合法**。
 * 两件事都在进事务之前判：事务层的签名里没有「参数非法」这种结果，
 * 它收到的就已经是一个合法的意图。
 *
 * `at` 取**一次**并贯穿整段事务：事务里再取一次 `new Date()` 的话，
 * 一次操作里的通知时间、历史时间与新的公共池截止时间会来自两个时刻。
 *
 * ## 失败语义（与 D5 一致）
 *
 * | 结果 | 抛出 | 为什么 |
 * |---|---|---|
 * | 订单不存在 / 不是本人实际履约 | `NOT_FOUND` → 404 | 两种表现必须一致，不泄露存在性 |
 * | 是本人的单，但状态已不是 `accepted` | `BAD_REQUEST` → 400 | 不是重放，是「点了此刻不该存在的按钮」 |
 * | 完成材料的索引与记录对不上 | `SERVER_ERROR` → 500 | **不可能状态**，见下 |
 *
 * ⚠️ 那一条 500 是 P0-11 加的：解除履约从此还要作废这一单那份 `pending` 完成材料
 * （EX-COMP-02），而那是整件事里**唯一可能失败**的一件。它失败时区段里
 * **一笔都没写**，所以既不能报「已取消」，也不能报 404 / 400——前两个会把
 * 一个存储被写坏的事实说成「打手操作有误」，而这正是 `order-missing` 在
 * `staffCompletions.ts` 里报 500 的同一条理由。
 *
 * `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 不允许来自请求体：否则任何人都能以别人的名义取消。
 */
export async function cancelCompanionOrder(
  companionId: string,
  orderId: string,
  body: Record<string, unknown>,
): Promise<CompanionCancelSuccess> {
  // 幂等键用**现有**校验（`lib/constants/writes.ts`）：不发明第二种键格式，
  // 用户侧八个写接口用的都是它
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  // 只 trim + 拒绝空串。需求没有冻结字数，因此这里没有长度上限
  const reason = readTrimmedString(body, "reason");
  if (!reason) throw new ApiError("BAD_REQUEST", COMPANION_CANCEL_REASON_REQUIRED_MESSAGE);

  const at = new Date().toISOString();

  const outcome = await cancelAcceptedOrder({
    companionId,
    orderId,
    reason,
    idempotencyKey,
    at,
  });

  if (outcome.kind === "ok" || outcome.kind === "replayed") return outcome;
  if (outcome.kind === "not-found") {
    throw new ApiError("NOT_FOUND", COMPANION_ORDER_NOT_FOUND_MESSAGE, 404);
  }
  if (outcome.kind === "inconsistent") {
    throw new ApiError("SERVER_ERROR", ORDER_DATA_INCONSISTENT_MESSAGE, 500);
  }
  throw new ApiError("BAD_REQUEST", COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE, 400);
}

/**
 * 当前实际履约的打手开始服务（`accepted → serving`，P0-7）。
 *
 * ## 本函数只做两件事：取一个时刻、把事务结果转成对外结果
 *
 * 「能不能开始」（是不是本人、状态是不是还停在 `accepted`）全部在
 * `startCompanionOrder` 的原子区段里判定，并在**同一段**代码里写下 `serving` 与
 * `servingAt`。到这里再判一次就等于把判定与写入拆开——中间那段窗口正是
 * 「判完到写之间状态被改掉」的入口。
 *
 * ⚠️ **没有 `body` 参数，也没有任何需要校验的字段**（与取消刻意不同）：
 * 这个动作没有附属记录、没有原因、没有幂等键（幂等判据是状态本身，
 * 见 `02-decisions.md` D2）。因此**没有 400「参数非法」这一类失败**，
 * 失败只剩归属与状态两种。少一个参数就是少一条「哪些字段合法」的规则要维护。
 *
 * ⚠️ 也正因为没有 body，**身份不可能是调用方声明的**：`companionId` 只来自
 * `requireCompanion()` 的会话身份。
 *
 * `at` 取**一次**并贯穿整段事务：事务里再取一次 `new Date()` 的话，
 * 「这次开始服务的时刻」与写进订单的时刻会来自两个时刻。
 *
 * ## 失败语义（与取消同一条取舍）
 *
 * | 结果 | 抛出 | 为什么 |
 * |---|---|---|
 * | 订单不存在 / 不是本人实际履约 | `NOT_FOUND` → 404 | 两种表现必须一致，不泄露存在性 |
 * | 是本人的单，但状态不是 `accepted` | `BAD_REQUEST` → 400 | 不是重放，是「点了此刻不该存在的按钮」 |
 *
 * 「重复点击」不走这条：这一单已经是 `serving` 且归本人时返回 200 与第一次的结果
 * （`kind: "replayed"`，`servingAt` 仍是第一次的时刻）。
 */
export async function startCompanionOrder(
  companionId: string,
  orderId: string,
): Promise<CompanionStartSuccess> {
  const at = new Date().toISOString();

  const outcome = await startCompanionOrderTransaction({ companionId, orderId, at });

  if (outcome.kind === "ok" || outcome.kind === "replayed") return outcome;
  if (outcome.kind === "not-found") {
    throw new ApiError("NOT_FOUND", COMPANION_ORDER_NOT_FOUND_MESSAGE, 404);
  }
  throw new ApiError("BAD_REQUEST", COMPANION_ORDER_NOT_STARTABLE_MESSAGE, 400);
}
