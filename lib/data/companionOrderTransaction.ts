import {
  DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
  DISPATCH_NOTIFICATION_COMPANION_DISABLED,
  DISPATCH_NOTIFICATION_STAFF_REASSIGNED,
  DISPATCH_NOTIFICATION_STAFF_REPLACED,
} from "@/lib/constants/dispatch";
import { isCompanionAcceptingOrders, toOrderCompanionSnapshot } from "@/lib/constants/companions";
import { canTransitionOrder } from "@/lib/constants/orders";
import { parseNotificationInput } from "@/lib/constants/service";
import type { CompanionReleaseRecord, CompanionReleaseSource } from "@/lib/types/companionRelease";
import type { CompanionWriteContext } from "@/lib/types/dispatch";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import type {
  CompanionCancelOutcome,
  CompanionOrdersReleaseOutcome,
  CompanionStartOutcome,
  Order,
  OrderCompanionSnapshot,
  StaffOrderReleaseOutcome,
  StaffOrderReplaceOutcome,
} from "@/lib/types/order";
import {
  appendCompanionRelease,
  bindCompanionReleaseKey,
  findCompanionRelease,
  findCompanionReleaseIdByKey,
} from "./mockCompanionReleaseRepository";
import { readCompanionRecord } from "./mockCompanionRepository";
import {
  applyDispatchAccepted,
  applyDispatchToPublic,
  dispatchStore,
} from "./mockDispatchRepository";
import { appendNotification, newNotificationId } from "./mockNotificationRepository";
import {
  applyOrderAcceptanceReleased,
  applyOrderAccepted,
  applyOrderServing,
  paymentStore,
} from "./mockPaymentRepository";
import { readPlatformConfig } from "./mockPlatformConfigRepository";
import {
  canInvalidatePendingCompletionForOrder,
  invalidatePendingCompletionForOrder,
} from "./completionTransaction";

/**
 * 订单**履约绑定**域的伪事务（P0-6 / P0-7 / P0-11）。
 *
 * 这里处理的是同一件事的四个面：**「谁在履约」这个绑定怎么建立、怎么解除**。
 * 因此**五个**公开入口共用本文件与同一份原子性依据，不各建一个伪事务文件
 * （`P0-6/02-decisions.md` D1 记录了理由，P0-11 沿用）：
 *
 * | 入口 | 触发者 | 做什么 |
 * |---|---|---|
 * | `startCompanionOrder` | 打手本人 | `accepted → serving` |
 * | `cancelAcceptedOrder` | 打手本人 | `accepted → paid`，派单回公共池 |
 * | `releaseOrderByStaff` | 客服 | `accepted`/`serving → paid`，派单回公共池 |
 * | `replaceOrderCompanionByStaff` | 客服 | 同上，但派单**不回池**，直接改绑给新打手 |
 * | `releaseOrdersForCompanion` | 管理员（封禁） | 把某位打手手上**所有**在履约的单按上一行的第一种方式退回公共池 |
 *
 * ⚠️ 后三个入口**不是**「打手对自己做什么」：它们的触发者是客服 / 管理员，
 * 权限判定在各自的服务层（`requireStaff()` / `requireAdmin()`），
 * 事务层只回答「这一单此刻能不能被解除、这位打手能不能被指定」。
 *
 * ## 「换人」为什么不是一条新状态边
 *
 * 客服直接换人时，原单若处于 `serving`，落点是 `serving → paid → accepted`：
 * **同一段无 `await` 的同步代码内连续两次写入**，中间那个 `paid` 谁也读不到
 * （Node 单线程：不让出执行权，就没有并发读者）。因此
 * `ORDER_TRANSITIONS` 里**不需要**、也**不得**新增 `serving → accepted`——
 * 那条边会把「必须先解除旧绑定」这件事从状态机里抹掉
 * （`01-prompt.md` §三的明确约束）。
 *
 * ## 原子性是怎么成立的
 *
 * 与 `lib/data/companionDispatchTransaction.ts` 同一条依据：Node 是单线程的，
 * 「读—判断—写」之间只要不让出执行权，别的请求就插不进来。
 * **本文件里没有一个 `await`**（两个导出函数都是 `async` 只是为了签名与
 * `acceptDispatch` 一致，函数体会一路同步执行到底），因此整个函数体就是一段原子区段。
 *
 * ⚠️ **在标注的边界之后加一个 `await` 就是 bug**，哪怕加的是 `await Promise.resolve()`：
 * 「订单已回到 `paid`、派单还在 `accepted`」的那一瞬会被别的请求读到。
 *
 * ## 一次履约解除必须同时成立的**五**件事
 *
 * 1. 这一单当前那份 `pending` 完成材料**立即作废**（P0-11 新增）；
 * 2. 退出历史写一条（谁退的、为什么、什么时候、谁触发的）；
 * 3. 订单履约绑定解除（`status: paid` / `acceptedAt` / `actualCompanionId` /
 *    `companion` / **`servingAt`**）；
 * 4. 派单回到公共池，并**按此刻的平台配置重冻**三个 public 字段
 *    （「客服直接换人」不走这一步：派单**直接改绑**给新打手，见下）；
 * 5. 下单用户收到一条通知。
 *
 * 少任何一件都会留下自相矛盾的状态：只有 3 是「订单没主了但派单还说被 A 接了」，
 * 只有 4 是「派单空着但订单还挂在 A 名下」，只有 2 是「历史里没有这次退出」（客服再也答不出
 * 「刚才那个人为什么走了」），只有 5 是「用户以为还有人给他做」——
 * 而只有 1 最阴：那份材料的 `autoApprovalDeadlineAt` 一到就会**自动通过**，
 * 把一张已经换了人的订单判成已完成（EX-COMP-02）。
 *
 * ## 为什么作废必须排在**整个区段的第一步**
 *
 * 它是这五件事里**唯一可能失败**的一件（索引与记录对不上 = 数据已经被写坏）。
 * 排在第一步，失败时区段里还没有任何写入，整件事干净地失败；
 * 排在中间，前四件已经写下去了，那时只能二选一：带着半完成状态返回，
 * 或者假装没看见继续释放。
 *
 * ⚠️ 它**不是**「读一次、写一次」的两段：`invalidatePendingCompletionForOrder`
 * 的失败分支在任何写入之前返回（见那个函数的说明）。
 *
 * ## 一次「开始服务」只有一件事要写
 *
 * 与取消**刻意相反**：它不产生附属记录、不动派单、不发通知，只是在同一段同步代码里把
 * 订单从 `accepted` 推进到 `serving` 并冻结 `servingAt`（`02-decisions.md` D6 记录了
 * 「本轮不新增通知」的依据）。原子性的范围因此更窄，但要求不变——
 * 「读到的还是 `accepted`、写的时候已经被改过」这个窗口同样必须关掉。
 *
 * ⚠️ 两者共用「先验证意图，再原子写入事实」这条裁决，但**判定顺序不同**，
 * 因为幂等判据不同：取消靠幂等键（第 1 步查索引），开始服务靠**状态本身**
 * （第 2 步判 `serving` 即重放，见 D2）。
 *
 * ## 为什么不用 `adminWriteSupport` 的 `operationId`
 *
 * 那套机制配的是**管理操作审计表**，取消接单不是管理行为，往里写会让审计表变成
 * 一本什么都记的流水（`companionDispatchTransaction` 头部已论证过同一件事）。
 * 这里用的是 `api-contract.md` §2.8 的第一种机制：**幂等键索引**，
 * 落在退出历史 store 自己的 `releaseIdByKey` 上，与审计表无关。
 *
 * ⚠️ 索引**只是让「同一打手连点两次」的第二次返回第一次的结果**（而不是一个
 * 令用户困惑的 404）；真正的安全边界仍然是**状态与归属**：
 * 键是调用方给的一个串，而 `order.actualCompanionId === companionId`
 * 与 `order.status === "accepted"` 是**事实**。
 */

/**
 * 构造并校验一条**发给下单用户**的通知（尚未写入）。
 *
 * ⚠️ 校验发生在**进入原子区段之前**（裁决：先验证意图，再原子写入事实）。
 * 文案格式错误、`href` 带查询串这类问题必须在这里抛出来——等到订单已经回了 `paid`、
 * 派单已经回了公共池再抛，留下的就是一段半完成的业务状态。
 *
 * ⚠️ 与 `companionDispatchTransaction` 的 `planNotification` 形状相同而**刻意各留一份**。
 * 理由不是「合并会让收件人变成调用方可声明的」——本函数自己就以 `userId` 为参数，
 * 收件人**本来就是**由调用点按自己的订单决定的。真正的理由是代价比：
 * 它只有十几行、不含任何业务判断，两处的 `kind` 与文案也各自独立；
 * 而合并成一个公共模块，就得为「将来第三种通知」预留参数与分支，
 * 那笔复杂度比这两份纯函数的重复更贵。
 *
 * 判断依据放在这里，是为了让下一个想合并的人看见**动机**而不只是结论。
 *
 * `href` 只带订单 id，不带任何说明或理由：通知是只读展示，要看细节进订单详情页，
 * 那里会重新校验归属。
 */
function planNotification(input: {
  userId: string;
  orderId: string;
  content: { title: string; summary: string; body: string };
  at: string;
}): Notification {
  const payload: NotificationInput = {
    userId: input.userId,
    kind: "dispatch",
    title: input.content.title,
    summary: input.content.summary,
    body: input.content.body,
    href: `/orders/${input.orderId}`,
  };

  const parsed = parseNotificationInput(payload);
  // 文案是常量、收件人与 href 都来自订单本身，这里失败只可能是常量被改坏了——
  // 那就该整段失败，而不是把一条格式不对的通知写进用户的收件箱
  if (!parsed.ok) throw new Error(`取消接单通知内容非法：${parsed.message}`);

  return {
    id: newNotificationId(),
    userId: parsed.value.userId,
    kind: parsed.value.kind,
    title: parsed.value.title,
    summary: parsed.value.summary,
    body: parsed.value.body,
    // 通知的时间就是**那件事发生的时间**，不是「谁碰巧来看了一眼的时间」
    createdAt: input.at,
    readAt: null,
    href: parsed.value.href,
  };
}

/**
 * 一次履约解除的写入结果（**同步、内部**）。
 *
 * `inconsistent` 是**不可能状态**（见 `CompanionOrdersReleaseOutcome` 的说明）：
 * 它出现时区段里还没有任何写入，调用方按 500 回答即可。
 */
type AssignmentReleaseWrite =
  | { kind: "ok"; release: CompanionReleaseRecord }
  | { kind: "inconsistent"; orderId: string };

/**
 * 「作废 pending 完成材料 → 写退出历史 → 清当前履约绑定 → 派单的去向 → 通知」
 * 这条底层能力（**同步、内部**）。
 *
 * `directory-structure.md` §8.1 C 把这几件事归为同一段可复用能力：
 * **打手 `accepted` 主动取消**、Admin 封禁当前打手、Staff 直接换人。
 * 它们对订单做的动作完全一样（解除绑定），区别只在 `source`、谁触发、
 * 以及**派单接下来去哪**，因此由参数化表达，而不是各写一份
 * （`P0-11/02-decisions.md` D3）。
 *
 * ⚠️ **派单的去向只有两种**，由 `reassign` 决定：
 *
 * | `reassign` | 订单 | 派单 |
 * |---|---|---|
 * | `null` | `→ paid`，停在这里等别人接 | 回公共池，重冻三个 public 字段 |
 * | 非 null | `→ paid → accepted`（同段两次写入） | **不回池**，直接改绑给新打手 |
 *
 * 直换那一列**刻意不经过公共池**：它既没有「进池 — 被抢 — 出池」这回事，
 * 也不该让别人有哪怕一瞬的机会抢走这一单（`01-prompt.md` §三）。
 *
 * ⚠️ 它**不判断合法性**：是不是本人实际履约、状态是不是 `accepted` / `serving`、
 * 被指定的人能不能接单、原因有没有填——全部由调用者在此之前判定。
 * 本函数只负责「写」。
 *
 * ⚠️ `idempotencyKey` **允许为 null**：只有打手主动取消那条路径有幂等键
 * （客户端生成、服务端记在退出历史的索引上）；客服 / 管理员触发的三条没有键，
 * 它们的幂等判据是状态本身。为 `null` 时**不写索引**——编一个键塞进去，
 * 就等于把「调用方给的一个串」伪装成业务事实。
 */
function releaseCurrentAssignment(input: {
  order: Order;
  /** 这一单当前的派单记录 id（调用方已经确认它存在） */
  dispatchId: string;
  companionId: string;
  source: CompanionReleaseSource;
  reason: string | null;
  actorId: string | null;
  idempotencyKey: string | null;
  at: string;
  /** 此刻的平台公共池超时（分钟）。**读一次、整段用同一份**，不在区段内再读 */
  publicPoolTimeoutMinutes: number;
  notification: Notification;
  /** `null` = 派单回公共池；非 null = 直接改绑给这位打手（客服直接换人） */
  reassign: { companionId: string; companion: OrderCompanionSnapshot } | null;
}): AssignmentReleaseWrite {
  // —— 原子区段开始（无 await）——

  /* —— 第 1 件：这一单当前的 pending 完成材料立即作废（唯一可能失败的一件）—— */
  // 排在整段写之前：见文件头部「为什么作废必须排在第一步」
  const invalidation = invalidatePendingCompletionForOrder({
    orderId: input.order.id,
    at: input.at,
  });
  if (invalidation.kind === "not-pending" || invalidation.kind === "missing-record") {
    return { kind: "inconsistent", orderId: input.order.id };
  }

  /* —— 第 2 件：退出历史 —— */
  const release = appendCompanionRelease({
    orderId: input.order.id,
    companionId: input.companionId,
    source: input.source,
    reason: input.reason,
    actorId: input.actorId,
    createdAt: input.at,
  });
  // 绑定紧跟写入：键与记录要么一起存在，要么一起不存在。
  // 顺序反过来的话，一次失败的写入会留下一个指向不存在记录的键
  if (input.idempotencyKey !== null) {
    bindCompanionReleaseKey(input.companionId, input.idempotencyKey, release.id);
  }

  /* —— 第 3、4 件：订单与派单必须**同段**写 —— */
  // 中间让出执行权就会出现「订单说等待接单、派单说被 A 接了」。
  // ⚠️ 直换那条分支里订单被连写两次（→ paid → accepted），
  // 中间态同样不暴露：这一段没有 await。
  applyOrderAcceptanceReleased(input.order.id);
  if (input.reassign) {
    applyDispatchAccepted(input.dispatchId, input.reassign.companionId, input.at);
    applyOrderAccepted(input.order.id, {
      companionId: input.reassign.companionId,
      companion: input.reassign.companion,
      at: input.at,
    });
  } else {
    applyDispatchToPublic(input.dispatchId, input.at, input.publicPoolTimeoutMinutes);
  }

  /* —— 第 5 件：通知 —— */
  appendNotification(input.notification);
  // —— 原子区段结束 ——

  return { kind: "ok", release };
}

/**
 * 当前实际履约的打手**主动取消接单**（P0-6）。
 *
 * ## 判定顺序是有讲究的（先验证意图，再原子写入）
 *
 * 1. **先查幂等索引**——命中就是「同一次取消的第二次到达」（连点两次、网络重试），
 *    原样返回第一次的结果，**一个字节都不写**。放在最前面是因为它是**唯一**能让
 *    「连点两次」不变成 404 的路径，而它比任何业务判定都便宜。
 * 2. **再取订单**——不存在、或 `actualCompanionId` 不是本人，一律 `not-found`：
 *    两种情况的对外表现必须完全相同，否则可以用别人的订单 id 试探它是否存在
 *    （`api-contract.md` §2.9，`01-prompt.md` §7.2）。
 * 3. **再看状态**——不是 `accepted` 就 `not-accepted`，**绝不**把 `serving` /
 *    `completed` / `refunded` 拉回 `paid`。这不是重放，是「你点了一个此刻不该存在的按钮」，
 *    因此必须失败而不是幂等成功（D5）。
 * 4. **读一次平台配置**，把公共池超时**当下**的值冻结进这一单的新截止时间。
 *    用今天启动时的旧值、或硬编码一个时长，都是第二套 timeout 算法。
 * 5. 通知在**区段之外**构造并校验完（含 id）。
 * 6. 进入原子区段，四件事一次写完。
 *
 * ⚠️ `ctx.companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 事务层不认识请求体、不认识 Cookie，因此「我是哪位打手」在结构上不可能由调用方声明。
 *
 * ⚠️ `ctx.reason` 必须已由调用方 **trim 并确认非空**（服务层 `cancelCompanionOrder`），
 * 本函数把它原样存进退出历史。事务层不重复一遍校验：同一条规则有两个出处时，
 * 两处对同一个请求给出不同答案，就没有人说得清哪一处才是规则。
 */
export async function cancelAcceptedOrder(
  ctx: CompanionWriteContext & { orderId: string; reason: string; idempotencyKey: string },
): Promise<CompanionCancelOutcome> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const payments = paymentStore();
  const dispatches = dispatchStore();

  /* —— 第 1 步：幂等索引（命中即返回，不进入写入区段）—— */
  const existingId = findCompanionReleaseIdByKey(ctx.companionId, ctx.idempotencyKey);
  if (existingId) {
    const existing = findCompanionRelease(existingId);
    // 键命中但记录已不存在属于不可能状态；真出现时按未命中继续，不猜一个结果出来。
    //
    // ⚠️ 键被**误用到别的单上**（同一个键提交了另一张订单）时不返回那条记录：
    // 那会把别人订单的状态当成这次请求的结果，用户会看到一张自己没操作过的单号。
    if (existing && existing.orderId === ctx.orderId) {
      const order = payments.orders.get(existing.orderId);
      if (order) {
        return {
          kind: "replayed",
          orderId: existing.orderId,
          orderNo: order.orderNo,
          status: "paid",
          releaseRecordId: existing.id,
          // 第一次的时刻，不是现在：重放不刷新任何时间
          cancelledAt: existing.createdAt,
          changed: false,
        };
      }
    }
    return { kind: "not-found" };
  }

  /* —— 第 2 步：订单存在，且**当前履约人就是我** ——
     判定与写入必须在同一段同步代码里：分开就会留下「判完到写之间被别人接走 / 退回」
     的窗口。这两个字段是**事实**，而幂等键只是调用方给的一个串。 */
  const order = payments.orders.get(ctx.orderId);
  if (!order || order.actualCompanionId !== ctx.companionId) return { kind: "not-found" };

  /* —— 第 3 步：状态必须**恰好**停在 accepted —— */
  // serving 之后没有普通主动取消入口；completed / refunded 是终态；
  // paid 说明这一单早就不在他名下（或从未被接）。四种都拒绝，一个都不回退。
  if (order.status !== "accepted") return { kind: "not-accepted", status: order.status };

  /* —— 第 4 步：这一单对应的派单记录 —— */
  // 用**既有的** `dispatchIdByOrder` 索引找，不新增第二套索引；
  // 也不走 `getDispatchRepository().findDispatchByOrderId()`——那是 async 的，
  // 在这里 await 一次就等于把判定与写入拆到两个 tick 上。
  const dispatchId = dispatches.dispatchIdByOrder.get(order.id);
  // 订单说「A 在履约」却查不到派单记录：数据已经不自洽。此时**宁可整件事失败**，
  // 也不能只把订单退回 paid——那张单会既不在任何池子里、也没人能再接。
  //
  // ⚠️ 必须**同时**确认记录本身还在：索引命中只证明「索引里存过一个 id」。
  // 若出现「索引在、记录丢」的悬空状态，只查索引会放行到下面，
  // 而 `applyDispatchToPublic` 在记录缺失时**静默返回 null**（它不抛错），
  // 结果是订单被写回 `paid`、派单却一点没变——正好是上面那句注释要避免的后果。
  // `createDispatchRecord` 对同一状态有同样的防御（索引命中但记录不存在 → 当作不存在），
  // 这里对齐它，不为此新增第二套索引。
  if (!dispatchId || !dispatches.dispatches.has(dispatchId)) return { kind: "not-found" };

  /* —— 第 5 步：区段之外把通知备好（含校验与 id）—— */
  const notification = planNotification({
    userId: order.userId,
    orderId: order.id,
    content: DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED,
    at: ctx.at,
  });

  // 公共池超时读**当前**配置：用户与后来接单的打手被承诺的是「重新进池那一刻的规则」
  const config = readPlatformConfig();

  /* —— 第 6 步：原子区段（在 releaseCurrentAssignment 内部，无 await）—— */
  const written = releaseCurrentAssignment({
    order,
    dispatchId,
    companionId: ctx.companionId,
    source: "companion_cancel",
    reason: ctx.reason,
    // 主动取消的触发者就是打手本人
    actorId: ctx.companionId,
    idempotencyKey: ctx.idempotencyKey,
    at: ctx.at,
    publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
    notification,
    // 打手自己取消：这一单**没有人接替**，派单回公共池等别人来
    reassign: null,
  });

  // 唯一可能失败的一件（完成材料的索引与记录对不上）发生在任何写入之前。
  // 这时**没有任何一件写下去**，因此如实报 500，不编一个「已取消」的结果出来
  if (written.kind === "inconsistent") {
    return { kind: "inconsistent", orderId: order.id };
  }

  return {
    kind: "ok",
    orderId: order.id,
    orderNo: order.orderNo,
    status: "paid",
    releaseRecordId: written.release.id,
    cancelledAt: ctx.at,
    changed: true,
  };
}

/**
 * 当前实际履约的打手**开始服务**（`accepted → serving`，P0-7）。
 *
 * ## 判定顺序（先验证意图，再原子写入）
 *
 * ```
 * 1. 订单不存在 / actualCompanionId ≠ 我   → not-found（对外 404，不泄露存在性）
 * 2. status === "serving"                  → replayed（已经是我的服务中订单，一个字节都不写）
 * 3. 结构校验 canTransitionOrder(…, serving) → false 则 not-startable（对外 400）
 * 4. 领域 Guard：status 必须恰好是 accepted → false 则 not-startable（对外 400）
 * 5. 原子写入（applyOrderServing）
 * ```
 *
 * - **第 1 步先于第 2 步**：归属是**事实**，状态只是它的属性。先看状态的话，
 *   别人就能拿一个订单 id 试探出「这一单已经开始服务了」。
 * - **第 2 步必须早于第 3 步**：`serving → serving` **不在**中央状态表里，
 *   先做结构校验会把一次重复点击判成「非法迁移」（400），而它本来只是一次重放。
 * - **第 3、4 步语义不同，两道门都要留**（`01-prompt.md` §三）：
 *   结构表回答「这条边存不存在」（将来状态表变了，它先知道），
 *   领域 Guard 回答「这一单此刻就站在这条边的起点上吗」。
 *   ⚠️ 走完第 2 步之后两者在同一个集合上成立，因此**看起来**重复——
 *   但「状态机允许」不是权限，不得用其中一条替代另一条。
 * - **不因状态表允许其它迁移而开放其它动作**：`serving → completed / refunded` 都在表里，
 *   本轮一个都不开（`serving` 的普通主动取消也是明确的不做项）。
 *
 * ⚠️ **幂等判据是状态本身，不是幂等键**（D2）：这个动作没有附属记录要找回、
 * 请求体也是空的，状态就是那次操作的结果。因此本函数**不接收** `idempotencyKey`，
 * 客户端也不生成——发明一个服务端文档里不存在的必填字段，等于给调用方加规则。
 *
 * ⚠️ `ctx.companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 事务层不认识请求体、不认识 Cookie，因此「我是哪位打手」在结构上不可能由调用方声明。
 */
export async function startCompanionOrder(
  ctx: CompanionWriteContext & { orderId: string },
): Promise<CompanionStartOutcome> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const payments = paymentStore();

  // —— 原子区段开始（无 await）——

  /* —— 第 1 步：订单存在，且**当前履约人就是我** —— */
  const order = payments.orders.get(ctx.orderId);
  if (!order || order.actualCompanionId !== ctx.companionId) return { kind: "not-found" };

  /* —— 第 2 步：已经是我的服务中订单 → 重放 —— */
  if (order.status === "serving") {
    return {
      kind: "replayed",
      orderId: order.id,
      orderNo: order.orderNo,
      status: "serving",
      // **第一次**开始的时刻，不是现在：重放不刷新任何时间。
      // 正常路径下这里必然有值（写入器进入 serving 时一定写下它）；
      // 若历史数据里是 null，就如实给出 null——「编一个开始时间」比空值更坏
      servingAt: order.servingAt,
      changed: false,
    };
  }

  /* —— 第 3 步：结构校验（中央状态机）—— */
  // 这条判定先于领域 Guard，为的是让「状态表里根本没有这条边」这件事由状态表自己回答：
  // 它同时也是唯一一处「新增状态时该改哪里」的提示
  if (!canTransitionOrder(order.status, "serving")) {
    return { kind: "not-startable", status: order.status };
  }

  /* —— 第 4 步：领域 Guard —— */
  // ⚠️ 与第 3 步并列存在，不是它的重复：能走到这里的状态今天恰好只剩 accepted，
  // 但这句才是「这一单此刻允许开始服务吗」的答案。删掉它，将来状态表一变宽，
  // 权限就跟着变宽了——那就成了「状态机即权限」
  if (order.status !== "accepted") return { kind: "not-startable", status: order.status };

  /* —— 第 5 步：原子写入（订单 → serving + servingAt）—— */
  const written = applyOrderServing(order.id, ctx.at);
  // 同一段同步代码里刚读到它，这里不可能为 null；真出现就按 404 回答，不编结果
  if (!written) return { kind: "not-found" };

  // 防御：第 2 步已经排除 serving，走到这里写入器必然真的改了。真出现「写入器说没变」
  // （例如上面的判定顺序被改坏了），按重放回答——报一个与事实相反的 `changed: true`
  // 会让调用方以为状态刚被推进过
  if (!written.changed) {
    return {
      kind: "replayed",
      orderId: written.updated.id,
      orderNo: written.updated.orderNo,
      status: "serving",
      servingAt: written.updated.servingAt,
      changed: false,
    };
  }

  // —— 原子区段结束 ——

  return {
    kind: "ok",
    orderId: written.updated.id,
    orderNo: written.updated.orderNo,
    status: "serving",
    servingAt: written.updated.servingAt,
    changed: true,
  };
}

/* ═════════════════════ 客服换人 / 封禁回池（P0-11） ═════════════════════ */

/**
 * 客服把这一单**退回公共池**（`accepted` / `serving` 均可）。
 *
 * ## 判定顺序（先验证意图，再原子写入）
 *
 * ```
 * 1. 订单不存在                       → not-found（404）
 * 2. 结构校验 canTransitionOrder(…, paid) → not-releasable（400）
 * 3. 领域 Guard：状态恰好是 accepted / serving，且有实际履约人 → not-releasable（400）
 * 4. 派单记录索引与记录都在            → 否则 dispatch-missing（500）
 * 5. 区段之外备好通知（含校验与 id）+ 读一次平台配置
 * 6. 原子区段：五件事一次写完
 * ```
 *
 * - **第 2、3 步语义不同，两道门都要留**（与 `startCompanionOrder` 同一条依据）：
 *   结构表回答「这条边存不存在」，领域 Guard 回答「这一单此刻就站在这条边的起点上吗」。
 * - **第 3 步也检查 `actualCompanionId`**：状态说「有人在履约」而字段是空的历史脏数据，
 *   在这里被挡住，而不是写一条 `companionId` 为空的退出历史。
 * - **没有幂等键**：与打手取消刻意不同。客服侧的这个动作，重复到达时订单已经不在
 *   履约中，第 3 步会给出 `not-releasable` 与**当前状态**——那正是使用者需要的答案
 *   （「这一单现在已经不是那个状态了」），比一个假装成功的重放诚实。
 * - **原因必填**由服务层判定（trim 后非空即 400），事务层把已校验过的原文原样写进历史。
 *   与 `cancelAcceptedOrder` 同一条裁决：同一条规则只留一个出处。
 *
 * ⚠️ `input.staffId` **只允许**来自 `requireStaff()` 返回的会话身份，
 * 事务层不认识请求体、不认识 Cookie。
 */
export async function releaseOrderByStaff(input: {
  orderId: string;
  staffId: string;
  reason: string;
  at: string;
}): Promise<StaffOrderReleaseOutcome> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const payments = paymentStore();
  const dispatches = dispatchStore();

  /* —— 第 1 步：订单存在 —— */
  const order = payments.orders.get(input.orderId);
  if (!order) return { kind: "not-found" };

  /* —— 第 2 步：结构校验（中央状态机）—— */
  if (!canTransitionOrder(order.status, "paid")) {
    return { kind: "not-releasable", status: order.status };
  }

  /* —— 第 3 步：领域 Guard —— */
  if (order.status !== "accepted" && order.status !== "serving") {
    return { kind: "not-releasable", status: order.status };
  }
  // 走完上一步之后这一条今天恒成立（能回到 paid 的只有这两个状态）。
  // 留着它是因为「谁在履约」是**事实**字段，不是状态的函数：
  // 状态说有人在履约、字段却是空的时候，这里必须挡住，
  // 而不是写一条 companionId 为空的退出历史
  if (!order.actualCompanionId) return { kind: "not-releasable", status: order.status };

  /* —— 第 4 步：这一单对应的派单记录（索引 + 记录本身）—— */
  const dispatchId = dispatches.dispatchIdByOrder.get(order.id);
  if (!dispatchId || !dispatches.dispatches.has(dispatchId)) {
    return { kind: "dispatch-missing" };
  }

  /* —— 第 5 步：区段之外把通知与配置备好 —— */
  const notification = planNotification({
    userId: order.userId,
    orderId: order.id,
    content: DISPATCH_NOTIFICATION_STAFF_REASSIGNED,
    at: input.at,
  });
  // 公共池超时读**当前**配置：用户与后来接单的打手被承诺的是「重新进池那一刻的规则」
  const config = readPlatformConfig();

  /* —— 第 6 步：原子区段（在 releaseCurrentAssignment 内部，无 await）—— */
  const written = releaseCurrentAssignment({
    order,
    dispatchId,
    companionId: order.actualCompanionId,
    source: "staff_reassign",
    reason: input.reason,
    actorId: input.staffId,
    // 客服触发的解除没有幂等键（幂等判据是状态本身）
    idempotencyKey: null,
    at: input.at,
    publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
    notification,
    // 退回公共池：等**其他**护航来接，此刻还没有接替者
    reassign: null,
  });
  if (written.kind === "inconsistent") return { kind: "inconsistent", orderId: order.id };

  return {
    kind: "ok",
    orderId: order.id,
    orderNo: order.orderNo,
    previousStatus: order.status,
    releaseRecordId: written.release.id,
    releasedAt: input.at,
    changed: true,
  };
}

/**
 * 客服**直接指定新打手**接替这一单（`accepted` / `serving` 均可）。
 *
 * 与 `releaseOrderByStaff` 共用同一个写入器，差别只有派单的去向：这里**不回公共池**，
 * 而是在同一段同步代码里改绑给新打手，并把订单 `→ paid → accepted`
 * （`01-prompt.md` §三：不得让中间那个 `paid` 暴露给并发抢单）。
 *
 * ## 判定顺序
 *
 * ```
 * 1. 订单不存在                          → not-found（404）
 * 2. 结构校验 + 领域 Guard（accepted/serving，且有履约人）→ not-replaceable（400）
 * 3. 指定的就是此刻正在履约的那位        → same-companion（400）
 * 4. 打手记录不存在                      → companion-not-found（400）
 * 5. 资格：复用 isCompanionAcceptingOrders → companion-unavailable（400）
 * 6. 指定的人是下单用户本人              → self-order（400）
 * 7. 派单记录索引与记录都在              → dispatch-missing（500）
 * 8. 区段之外备好通知 + 读一次平台配置
 * 9. 原子区段：五件事一次写完（订单连写两次，派单改绑）
 * ```
 *
 * - **第 3 步先于第 4、5 步**：指定的就是他本人时，说「他当前不能接单」是反的
 *   ——他正在做着这一单。`same-companion` 才是这件事的准确说法。
 * - **第 5 步复用 `isCompanionAcceptingOrders()`**：仓库里「这位打手此刻能不能接新的单」
 *   只有这一个谓词（它自己的注释点名了三处调用方）。新写一个「换人时用的资格判定」
 *   就会出现两套资格口径，而它们迟早会对同一个打手给出不同答案
 *   （`P0-11/02-decisions.md` D5 记录了这条复用，以及它对 `available` 的取舍）。
 * - **第 6 步与接单的 `self-order` 同一条规则、同一个写法**（显式判 `userId !== null`，
 *   否则 `null === null` 会把一位没有绑定微信的打手误判成「自己给自己下单」）。
 * - **`not-replaceable` 覆盖 `paid` / `completed` / `refunded`**：这一轮只做「换人」，
 *   不做「给还没人接的单指派打手」——那是另一个能力（公共池的单属于所有可接单的打手，
 *   直接指派会绕过「先到先得」与用户指定这两套既有规则）。
 *
 * ⚠️ 换人对**新打手**而言不是「跳过接单」：他拿到的状态与他自己点接单完全一样
 * （`accepted`），「开始服务」与完成材料仍然由他本人做。
 */
export async function replaceOrderCompanionByStaff(input: {
  orderId: string;
  newCompanionId: string;
  staffId: string;
  at: string;
}): Promise<StaffOrderReplaceOutcome> {
  // 句柄在写之前取好。测试里的 resetMockStore() 会换掉整份存储，因此每次都现取
  const payments = paymentStore();
  const dispatches = dispatchStore();

  /* —— 第 1 步：订单存在 —— */
  const order = payments.orders.get(input.orderId);
  if (!order) return { kind: "not-found" };

  /* —— 第 2 步：结构校验 + 领域 Guard —— */
  if (!canTransitionOrder(order.status, "paid")) {
    return { kind: "not-replaceable", status: order.status };
  }
  if (order.status !== "accepted" && order.status !== "serving") {
    return { kind: "not-replaceable", status: order.status };
  }
  if (!order.actualCompanionId) {
    return { kind: "not-replaceable", status: order.status };
  }

  /* —— 第 3 步：指定的就是他本人 —— */
  if (order.actualCompanionId === input.newCompanionId) {
    return { kind: "same-companion" };
  }

  /* —— 第 4 步：打手记录存在 —— */
  const next = readCompanionRecord(input.newCompanionId);
  if (!next) return { kind: "companion-not-found" };

  /* —— 第 5 步：资格（复用仓库里唯一的那个谓词）—— */
  if (!isCompanionAcceptingOrders(next)) return { kind: "companion-unavailable" };

  /* —— 第 6 步：禁止自接单（EX-DISPATCH-08）—— */
  if (next.userId !== null && order.userId === next.userId) return { kind: "self-order" };

  /* —— 第 7 步：这一单对应的派单记录 —— */
  const dispatchId = dispatches.dispatchIdByOrder.get(order.id);
  if (!dispatchId || !dispatches.dispatches.has(dispatchId)) {
    return { kind: "dispatch-missing" };
  }

  /* —— 第 8 步：区段之外把通知与配置备好 —— */
  const notification = planNotification({
    userId: order.userId,
    orderId: order.id,
    content: DISPATCH_NOTIFICATION_STAFF_REPLACED,
    at: input.at,
  });
  // 直换**不经过公共池**，因此这条路径上这次读到的超时不会被写进任何字段。
  // 仍然读它，是因为写入器对两种去向收同一份入参——为一条分支省一次读，
  // 换来的是两个签名与两个调用点，而那笔复杂度比一次纯函数调用贵
  const config = readPlatformConfig();

  /* —— 第 9 步：原子区段 —— */
  const written = releaseCurrentAssignment({
    order,
    dispatchId,
    // 退出历史记的是**被解除的那位**，不是新来的
    companionId: order.actualCompanionId,
    source: "staff_reassign",
    reason: null,
    actorId: input.staffId,
    idempotencyKey: null,
    at: input.at,
    publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
    notification,
    // 新打手接手：派单不回池，直接改绑
    reassign: {
      companionId: next.id,
      // 与 `acceptDispatch` 写的是同一种快照：之后他改昵称换头像，这一单的展示不受影响
      companion: toOrderCompanionSnapshot(next),
    },
  });
  if (written.kind === "inconsistent") return { kind: "inconsistent", orderId: order.id };

  return {
    kind: "ok",
    orderId: order.id,
    orderNo: order.orderNo,
    previousStatus: order.status,
    previousCompanionId: order.actualCompanionId,
    newCompanionId: next.id,
    releaseRecordId: written.release.id,
    replacedAt: input.at,
    changed: true,
  };
}

/**
 * 打手**资格被下架**时，把他手上所有还在履约的订单退回公共池（**同步**，P0-11）。
 *
 * ## 为什么是同步函数，而不是 `async`
 *
 * 它必须被 `setCompanionFlags()` 的原子区段**直接调用**（EX-COMP-01：
 * 解除与停用必须同时发生，不能有一个「已经停用、单还挂在他名下」的中间态）。
 * 写 `async` 也能用（函数体会同步跑完，因为里面没有 await），但那种正确性依赖
 * 「调用方记得不要 await」这条口头约定；写成同步函数，**结构上**就不可能被拆开。
 *
 * ## 三段式：全量读 → 全量校验 → 全量写
 *
 * 与 `sweepExpiredDispatches` 同一形状。**校验必须全部先做完**：
 * 边校验边写的话，第三单发现派单缺失时，前两单已经解除完了——
 * 管理员看到的是一个「失败」，而数据里已经躺着一半的结果。
 *
 * ⚠️ 校验要覆盖**写循环里全部可能失败的事**，今天有两件：
 * ① 每一单的派单记录都在（`dispatch-missing`）；
 * ② 每一单的 pending 完成材料可以作废（`inconsistent`，即
 * `releaseCurrentAssignment` 的第 1 件）。少校验第 ② 件的话，
 * 「索引在、记录丢」会让第 1 单已经写完、整件事却报失败。
 *
 * ⚠️ 它**不判断这个打手该不该被停用**（存在、未移除、能不能停）：
 * 那些判定在 `setCompanionFlags()` 里，调用方保证进来时前置条件已成立。
 */
export function releaseOrdersForCompanion(input: {
  companionId: string;
  /** 触发的管理员 id。写进每条退出历史的 `actorId` */
  actorId: string;
  reason: string;
  at: string;
}): CompanionOrdersReleaseOutcome {
  const payments = paymentStore();
  const dispatches = dispatchStore();

  /* —— 第 1 步（只读）：他手上还在履约的订单 —— */
  // ⚠️ **只取 accepted / serving**：`completed` / `refunded` 的订单同样挂着
  // `actualCompanionId`（那是「谁做的这一单」，不是「谁在做这一单」），
  // 把它们一起解除就等于抹掉已完成订单的履约人——而历史必须保留（EX-COMP-01）
  const affected = [...payments.orders.values()].filter(
    (order) =>
      order.actualCompanionId === input.companionId &&
      (order.status === "accepted" || order.status === "serving"),
  );
  if (affected.length === 0) {
    return { kind: "ok", companionId: input.companionId, releasedOrderIds: [] };
  }

  /* —— 第 2 步（只读）：每一单的派单记录都在，且 pending 完成材料可以作废 —— */
  const plans: { order: Order; dispatchId: string }[] = [];
  for (const order of affected) {
    const dispatchId = dispatches.dispatchIdByOrder.get(order.id);
    if (!dispatchId || !dispatches.dispatches.has(dispatchId)) {
      return { kind: "dispatch-missing", orderId: order.id };
    }
    // ⚠️ 写入循环里**唯一**可能失败的一步就是「作废这一单的 pending 完成材料」
    // （`releaseCurrentAssignment` 的第 1 件），因此它必须在**任何写入之前**问一遍。
    // 不提前问的话，第 2 单的索引与记录对不上时，第 1 单已经解除完了，
    // 整件事却报 `inconsistent`——正好违反本节开头那句「校验必须全部先做完」
    if (!canInvalidatePendingCompletionForOrder(order.id)) {
      return { kind: "inconsistent", orderId: order.id };
    }
    plans.push({ order, dispatchId });
  }

  /* —— 第 3 步（只读）：每一单的通知都备好 —— */
  const config = readPlatformConfig();
  const notifications = plans.map((plan) =>
    planNotification({
      userId: plan.order.userId,
      orderId: plan.order.id,
      // 封禁的那条文案与「客服换人」不同：不透露平台对这位打手做了什么
      content: DISPATCH_NOTIFICATION_COMPANION_DISABLED,
      at: input.at,
    }),
  );

  /* —— 第 4 步（写）：逐单解除 —— */
  const releasedOrderIds: string[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const written = releaseCurrentAssignment({
      order: plan.order,
      dispatchId: plan.dispatchId,
      companionId: input.companionId,
      source: "companion_disabled",
      reason: input.reason,
      actorId: input.actorId,
      // 系统触发：没有幂等键
      idempotencyKey: null,
      at: input.at,
      publicPoolTimeoutMinutes: config.publicPoolTimeoutMinutes,
      notification: notifications[index],
      // 退回公共池：资格被下架的人不可能再被指定
      reassign: null,
    });
    // 不可能状态：第 2 步已经把这一段里**唯一**可能失败的那一件问过了
    // （作废这一单的 pending 完成材料，第 2 步的 `canInvalidatePendingCompletionForOrder`），
    // 而预检与写入之间没有 `await`，因此结论必然相同。
    // 真出现时**当整件事失败**——调用方（setCompanionFlags）会连同那次停用一起不写，
    // 管理员重试即可
    if (written.kind === "inconsistent") {
      return { kind: "inconsistent", orderId: plan.order.id };
    }
    releasedOrderIds.push(plan.order.id);
  }

  return { kind: "ok", companionId: input.companionId, releasedOrderIds };
}
