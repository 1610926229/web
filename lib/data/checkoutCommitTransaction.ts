import { createDispatchForOrder } from "./companionDispatchTransaction";
import { redeemCouponClaimForOrder } from "./couponRedemptionTransaction";
import type { Order } from "@/lib/types/order";
import type { PaymentRequest } from "@/lib/types/payment";

/**
 * T1「支付确认建单」在 **Mock** 这一侧的**事务参与者**（PROD-1D）。
 *
 * ## 为什么有这一个文件
 *
 * 支付成功的完整写闭包是四件事：
 *
 * ```
 * payment confirmed + order created + dispatch created + coupon claim consumed（有券时）
 * ```
 *
 * 在 Pg 那边它们必须落在**同一个** `BEGIN … COMMIT` 里。Mock 没有事务可用，
 * 替代品仍然是用了一整个仓库的那一招：**把「读—判断—写」放进一段没有 `await` 的同步代码**。
 *
 * PROD-1D 之前，这段同步代码写在 `lib/services/checkout.ts` 的 `buildOrderFromRequest()`
 * 体内，而那个函数是**支付仓储的 `buildOrder` 回调**——于是只要支付仓储换成 PostgreSQL
 * 实现，回调里的券核销与派单就会写进 Mock 存储，形成
 * 「订单 / 支付进 PostgreSQL、券核销与派单进 Mock」的半迁移（Hard Rule 1 禁止）。
 *
 * 现在 `buildOrderFromRequest()` 只**纯构造**订单，副作用按存储分家：
 * 本文件是 **Mock 的**那一半，Pg 的那一半在 `lib/data/pg/paymentRepository.ts`
 * 的事务里。两者都调用同一个纯构造函数，因此「订单长什么样」仍然只有一处定义。
 *
 * ## ⚠️ 必须是同步的
 *
 * 它被 `mockPaymentRepository.confirmPaymentRequest()` 在**它那段无 `await` 的原子区段内**
 * 同步调用。这里出现任何一个 `await` 都会让出执行权，于是
 * 「订单存在了但券还没核销」或「派单建立了但没有订单」的那一瞬会真的暴露给别的请求。
 * `tests/couponCheckoutChain.test.mjs` 有一条源码结构断言钉住这一点。
 *
 * ## 顺序：核销 → 派单
 *
 * 与 PROD-1D 之前**逐字相同**（原实现在 `buildOrderFromRequest` 里就是先核销、后排到
 * `createDispatchForOrder()`）：核销失败时**一个字节都不写**，因此不会留下
 * 「有派单、没有订单」的半成品。核销成功之后剩下的只有 `createDispatchForOrder()`——
 * 它是纯同步的建记录 + 一次 Map 写入，当前实现里没有已知抛错点。
 *
 * ## ⚠️ `at` 取自 `order.createdAt`
 *
 * 不是巧合：在旧实现里核销、建单、派单三者共用 `buildOrderFromRequest` 里的**同一个**
 * `at` 变量，而它落到的就是订单的 `createdAt` / `paidAt`。取 `order.createdAt`
 * 因此是**逐字等价**的，而不是一个近似。
 *
 * ## ⚠️ 已知并已核实的**函数级循环依赖**（本轮引入，如实登记）
 *
 * 本文件 import `companionDispatchTransaction`，而后者 import `mockPaymentRepository`
 * ——于是形成
 *
 * ```
 * mockPaymentRepository → checkoutCommitTransaction
 *                       → companionDispatchTransaction → mockPaymentRepository
 * ```
 *
 * 这与 PROD-1D 之前不同（那时 `mockPaymentRepository` 只是被 `companionDispatchTransaction`
 * **单向**依赖，没有环）。判定为**安全**，理由有两条，且是**看过代码而不是猜的**：
 *
 * 1. `companionDispatchTransaction` 只在**函数体里**使用 `mockPaymentRepository` 的导出
 *    （`applyOrderAccepted` / `applyOrderRefund` / `paymentStore`），模块求值期一次都不碰；
 * 2. 本文件的依赖也全部在函数体内使用（`redeemCouponClaimForOrder` / `createDispatchForOrder`
 *    都只在 `commitMockCheckoutParticipants()` 被调用时才取）。
 *
 * 因此 ESM 的活绑定在「循环里的一方尚未初始化」时也不会被读到（TDZ 只在**取值**时触发），
 * 而唯一的取值时刻是运行时调用——那时两个模块都早已求值完毕。
 *
 * ⚠️ 这不是"大概没事"：`tests/couponCheckoutChain.test.mjs` 的整条支付链与
 * `tests/checkout.test.mjs` 都真实走过这条路径并全绿。**但它是本轮新加的环**，
 * 若将来有人在任一侧的**模块顶层**使用对方的值（而不是在函数体里），它会立刻变成
 * `ReferenceError: Cannot access '…' before initialization`。届时的正确修法是把
 * `createDispatchForOrder()` 抽到一个不依赖支付仓储的叶子模块——本轮不做：
 * 那是 PROD-1B 文件的拆分，与本轮「只换持久化实现」的边界无关。
 */
export function commitMockCheckoutParticipants(input: {
  request: PaymentRequest;
  /** 刚由纯构造函数生成的那张订单（尚未写入任何存储） */
  order: Order;
}): { ok: true } | { ok: false; reason: string } {
  const { request, order } = input;
  const at = order.createdAt;

  // —— 核销（裁定 §5）：Mock 侧唯一的核销点，也是最后一道券可用性闸门 ——
  // 放在派单写入之前：失败要发生在任何记录被写下去之前。
  // 双花由「区段内没有 await」堵住：两张用同一张券的待支付请求，第 2 笔在这里
  // 会看到券已经是 `used`，于是被拒、不建单。
  if (request.coupon) {
    const redemption = redeemCouponClaimForOrder({
      userId: request.userId,
      claimId: request.coupon.claimId,
      // 门槛基数是**优惠前应付**（裁定 §2）
      originalAmount: request.totalAmount,
      at,
    });
    if (!redemption.ok) return { ok: false, reason: redemption.reason };
  }

  // —— 派单：订单存在的那一刻，派单记录就必须已经存在（P0-5）——
  createDispatchForOrder({
    orderId: order.id,
    // 结算页选了人 → 专属池；没选 → 直接进公共池
    exclusiveCompanionId: request.snapshot.companion ? request.snapshot.companion.id : null,
    at,
  });

  return { ok: true };
}
