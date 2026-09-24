import { DISPATCH_NOTIFICATION_ACCEPTANCE_RELEASED } from "@/lib/constants/dispatch";
import { parseNotificationInput } from "@/lib/constants/service";
import type { CompanionReleaseRecord, CompanionReleaseSource } from "@/lib/types/companionRelease";
import type { CompanionWriteContext } from "@/lib/types/dispatch";
import type { Notification, NotificationInput } from "@/lib/types/notification";
import type { CompanionCancelOutcome, Order } from "@/lib/types/order";
import {
  appendCompanionRelease,
  bindCompanionReleaseKey,
  findCompanionRelease,
  findCompanionReleaseIdByKey,
} from "./mockCompanionReleaseRepository";
import { applyDispatchToPublic, dispatchStore } from "./mockDispatchRepository";
import { appendNotification, newNotificationId } from "./mockNotificationRepository";
import { applyOrderAcceptanceReleased, paymentStore } from "./mockPaymentRepository";
import { readPlatformConfig } from "./mockPlatformConfigRepository";

/**
 * 打手订单域的伪事务（P0-6）—— 当前唯一的公开入口是「主动取消接单」。
 *
 * ## 原子性是怎么成立的
 *
 * 与 `lib/data/companionDispatchTransaction.ts` 同一条依据：Node 是单线程的，
 * 「读—判断—写」之间只要不让出执行权，别的请求就插不进来。
 * **本文件里没有一个 `await`**（`cancelAcceptedOrder` 是 `async` 只是为了签名与
 * `acceptDispatch` 一致，函数体会一路同步执行到底），因此整个函数体就是一段原子区段。
 *
 * ⚠️ **在标注的边界之后加一个 `await` 就是 bug**，哪怕加的是 `await Promise.resolve()`：
 * 「订单已回到 `paid`、派单还在 `accepted`」的那一瞬会被别的请求读到。
 *
 * ## 一次取消必须同时成立的四件事
 *
 * 1. 退出历史写一条（谁退的、为什么、什么时候）；
 * 2. 订单履约绑定解除（`status: paid` / `acceptedAt` / `actualCompanionId` / `companion`）；
 * 3. 派单回到公共池，并**按此刻的平台配置重冻**三个 public 字段；
 * 4. 下单用户收到一条通知。
 *
 * 少任何一件都会留下自相矛盾的状态：只有 2 是「订单没主了但派单还说被 A 接了」，
 * 只有 3 是「派单空着但订单还挂在 A 名下」，只有 1 是「历史里没有这次退出」（客服再也答不出
 * 「刚才那个人为什么走了」），只有 4 是「用户以为还有人给他做」。
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
 * 「写退出历史 → 清当前履约绑定 → 订单回 `paid` → 派单回公共池 → 通知」
 * 这条底层能力（**同步、内部**）。
 *
 * `directory-structure.md` §8.1 C 把这三件事归为同一段可复用能力：
 * **打手 accepted 主动取消**、Admin 封禁 / 移除当前打手、Staff 直接换人。
 * 它们对订单与派单做的动作完全一样，区别只在 `source` 与谁触发，
 * 因此这里由 `source` 参数化，而不是各写一份。
 *
 * ⚠️ **本轮只从 `cancelAcceptedOrder` 调用，`source` 只会是 `companion_cancel`**。
 * 另外两个 source 是 TARGET，**没有调用方、也不导出本函数**：
 * 封禁回池与客服换人属于后续 Round（`01-prompt.md` §十四），
 * 提前开一个「谁都能调的回池函数」等于给它们留了一扇没有 Guard 的门。
 *
 * ⚠️ 它**不判断合法性**：是不是本人实际履约、状态是不是还停在 `accepted`、
 * 原因有没有填——全部由调用者在此之前判定。本函数只负责「写」。
 */
function writeAcceptanceRelease(input: {
  order: Order;
  /** 这一单当前的派单记录 id（调用方已经确认它存在） */
  dispatchId: string;
  companionId: string;
  source: CompanionReleaseSource;
  reason: string | null;
  actorId: string | null;
  idempotencyKey: string;
  at: string;
  /** 此刻的平台公共池超时（分钟）。**读一次、整段用同一份**，不在区段内再读 */
  publicPoolTimeoutMinutes: number;
  notification: Notification;
}): CompanionReleaseRecord {
  // —— 原子区段开始（无 await）——
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
  bindCompanionReleaseKey(input.companionId, input.idempotencyKey, release.id);

  // 订单与派单必须**同段**写：中间让出执行权就会出现「订单说等待接单、派单说被 A 接了」
  applyOrderAcceptanceReleased(input.order.id);
  applyDispatchToPublic(input.dispatchId, input.at, input.publicPoolTimeoutMinutes);

  appendNotification(input.notification);
  // —— 原子区段结束 ——

  return release;
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

  /* —— 第 6 步：原子区段（在 writeAcceptanceRelease 内部，无 await）—— */
  const release = writeAcceptanceRelease({
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
  });

  return {
    kind: "ok",
    orderId: order.id,
    orderNo: order.orderNo,
    status: "paid",
    releaseRecordId: release.id,
    cancelledAt: ctx.at,
    changed: true,
  };
}
