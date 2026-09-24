import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import type { CompanionCompletionSubmitOutcome } from "@/lib/types/completion";
import type { CompanionPoolData, DispatchAcceptOutcome } from "@/lib/types/dispatch";
import type { CompanionCancelOutcome, CompanionStartOutcome } from "@/lib/types/order";

/**
 * 打手工作台的**浏览器端**取数（P0-5）。
 *
 * 与服务端模块 `lib/services/companionDispatch.ts` / `companionOrders.ts` 分开是必须的：
 * 那些模块依赖 `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，Mock 存储与种子数据
 * 就会被打进浏览器产物。池子页与「我的订单」两个页面的首屏都由 Server Component
 * 直接取数，不经过本文件；本文件只服务于三个**写**交互（接单、开始服务、取消接单）。
 *
 * ⚠️ 请求里**没有打手标识**：以谁的身份写由服务端会话决定（`requireCompanion()`），
 * 调用方改不动。因此这里也没有「换个打手」这种参数。
 */

/** 读当前打手能看到的两张池子。返回的 `exclusive` 只包含指定给他的单。 */
export function fetchCompanionPools(): Promise<CompanionPoolData> {
  return apiGet<CompanionPoolData>("/api/companion/dispatches");
}

/**
 * 接单。
 *
 * ⚠️ 返回的是**业务结果**而不是「成功 / 抛错」：`{ kind: "not-open" }`
 * （被别人先接走了）是正常的抢单结果，客户端必须按 `kind` 决定说什么话，
 * 而不是把所有失败都塞进一个 `catch`——那里分不出「被抢了」与「网断了」。
 * 只有鉴权失败（未登录 401 / 不是打手或资格已下架 403）才会抛 `ApiError`。
 */
export function acceptDispatchRequest(dispatchId: string): Promise<DispatchAcceptOutcome> {
  return apiPost<DispatchAcceptOutcome>(
    `/api/companion/dispatches/${encodeURIComponent(dispatchId)}/accept`,
  );
}

/**
 * 取消成功的两种结果（`ok` / `replayed`）。
 *
 * ⚠️ 这是**从 `lib/types/order.ts` 的类型里挑出来的**，不是从服务端模块
 * （`lib/services/companionOrders.ts` 的 `CompanionCancelSuccess`）import 过来的：
 * 那个模块依赖 `lib/data`，浏览器端模块的 import 一律只准指向 `lib/types` 与
 * `lib/constants`——写成 `import type` 虽然会被编译抹掉，但「本文件不认识服务端模块」
 * 这条界线一旦靠「它是 type-only 所以没关系」来维持，下一个人改成值导入时就没有东西拦得住。
 */
export type CompanionCancelResult = Extract<
  CompanionCancelOutcome,
  { kind: "ok" } | { kind: "replayed" }
>;

/**
 * 主动取消接单（`accepted → paid`，订单回到公共池）。
 *
 * ## 失败一律是抛错，这里没有 `kind` 可以读
 *
 * 与接单**刻意不同**：接单的 `not-open`（被别人先接走）是一场平等抢单的正常结果，
 * 所以接口用 200 返回它。取消不是——非本人 404、状态已不是 `accepted` 400，
 * 两者都由接口抛成 `ApiError`，页面直接把服务端给的 message 显示出来即可
 * （`COMPANION_ORDER_NOT_FOUND_MESSAGE` / `COMPANION_ORDER_NOT_CANCELLABLE_MESSAGE`）。
 * 前端**不另写一套失败文案**：那会让「接口说什么」与「页面说什么」有一天分叉。
 *
 * ## `idempotencyKey` 由调用方生成，并且必须在**同一次取消意图**里保持不变
 *
 * 同一个键第二次到达时，服务端返回第一次的结果（`kind: "replayed"`）
 * 而不再写一条退出历史。因此连点两次、或断网后重试，都不会变成 404
 * ——那个键是让重放安全的力量，键一换，重放就退化成「点了此刻不该存在的按钮」。
 */
export function cancelCompanionOrderRequest(
  orderId: string,
  input: { reason: string; idempotencyKey: string },
): Promise<CompanionCancelResult> {
  return apiPost<CompanionCancelResult>(
    `/api/companion/orders/${encodeURIComponent(orderId)}/cancel`,
    input,
  );
}

/**
 * 开始服务成功的两种结果（`ok` / `replayed`）。
 *
 * 与 `CompanionCancelResult` 同一条理由：从 `lib/types/order.ts` 的类型里挑，
 * **不** import 服务端模块（那个模块依赖 `lib/data`）。
 */
export type CompanionStartResult = Extract<
  CompanionStartOutcome,
  { kind: "ok" } | { kind: "replayed" }
>;

/**
 * 开始服务（`accepted → serving`）。
 *
 * ## 没有请求体，因为这件事没有参数
 *
 * 没有原因、没有幂等键——幂等的判据是**状态本身**（这一单已经是 `serving` 且归你就是重放），
 * 因此这里**不生成任何键**，`apiPost` 也不带 body（不带时它连 `content-type` 之外的
 * 东西都不发）。给它编一个 `idempotencyKey`，等于替服务端发明一条它并不要求的规则。
 *
 * ## 失败一律是抛错，这里没有 `kind` 可以读
 *
 * 与接单刻意不同，与取消相同：非本人 404「订单不存在或不可操作」、
 * 状态不是 `accepted` 400「当前订单状态不允许开始服务」，两者都由接口抛成 `ApiError`，
 * 页面直接显示服务端给的 message，前端**不另写一套失败文案**。
 */
export function startCompanionOrderRequest(orderId: string): Promise<CompanionStartResult> {
  return apiPost<CompanionStartResult>(
    `/api/companion/orders/${encodeURIComponent(orderId)}/start`,
  );
}

/**
 * 提交完成材料成功的唯一结果（`ok`）。
 *
 * 与 `CompanionCancelResult` / `CompanionStartResult` 同一条理由：从
 * `lib/types/completion.ts` 的类型里挑，**不** import 服务端模块
 * （`lib/services/companionCompletions.ts` 依赖 `lib/data`）。
 */
export type CompanionCompletionSubmitResult = Extract<
  CompanionCompletionSubmitOutcome,
  { kind: "ok" }
>;

/**
 * 提交完成材料（`serving` → 一条 pending 完成材料）。
 *
 * ## 与「开始服务」不同：**有请求体**
 *
 * 完成说明与凭证都在请求体里，因此这里必须传 body（`apiPost` 带 body 时才会
 * 发 JSON 与 `content-type`）。凭证只传「类型 + 文件名」（`EvidenceDraft`），
 * `id` 与地址由服务端生成——客户端没有机会把任意外链或本地路径写成正式地址。
 *
 * ## 没有幂等键，失败一律抛错
 *
 * 这个动作每次都是**新建一条记录**，幂等判据是「同一订单最多一份 pending」的索引
 * （见 `completionTransaction.ts`），不是调用方声明的键。失败语义与「取消」「开始服务」
 * 相同：非本人 404「订单不存在或不属于你」、状态不是 serving 400「只有护航中的订单
 * 才能提交完成材料」、已有 pending 400「该订单已有一份待审核的完成材料」。
 * 页面直接把服务端给的 message 显示出来，前端**不另写一套失败文案**。
 */
export function submitCompanionCompletionRequest(
  orderId: string,
  input: { summary: string; evidence: EvidenceDraft[] },
): Promise<CompanionCompletionSubmitResult> {
  return apiPost<CompanionCompletionSubmitResult>(
    `/api/companion/orders/${encodeURIComponent(orderId)}/completion`,
    input,
  );
}
