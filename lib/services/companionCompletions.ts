import { ApiError } from "@/lib/api/ApiError";
import {
  COMPLETION_ORDER_NOT_FOUND_MESSAGE,
  COMPLETION_ORDER_NOT_SERVING_MESSAGE,
  COMPLETION_PENDING_EXISTS_MESSAGE,
  buildCompanionCompletionInfo,
  normalizeCompletionSummary,
} from "@/lib/constants/completions";
import { EVIDENCE_MAX_COUNT, parseEvidenceInput, toStoredEvidence } from "@/lib/constants/evidence";
import { readTrimmedString } from "@/lib/constants/writes";
import { getCompletionRepository } from "@/lib/data/completionRepository";
import { submitCompletion as submitCompletionTransaction } from "@/lib/data/completionTransaction";
import type {
  CompanionCompletionInfo,
  CompanionCompletionSubmitOutcome,
} from "@/lib/types/completion";
import type { OrderStatus } from "@/lib/types/order";

/**
 * 打手端「完成材料」服务（P0-8）—— 提交完成材料的唯一入口，与订单详情的完成材料摘要。
 *
 * ⚠️ **只被服务端引用**：本模块依赖 `lib/data` 与 `lib/mocks`，
 * 浏览器端取数走 `lib/services/companionHttp.ts`（不在本批次范围）。
 *
 * ## 本文件只做三件事
 *
 * 1. 解析与校验入参（完成说明 5～50 字、凭证格式）；
 * 2. 取一个时刻并调用伪事务；
 * 3. 把伪事务的失败翻译成明确的接口错误。
 *
 * 「能不能提交」（是不是本人、状态是不是 serving、有没有别的 pending）全部在
 * `submitCompletion` 的原子区段里判定，并在**同一段**代码里写下去。
 *
 * ⚠️ `companionId` **只允许**来自 `requireCompanion()` 返回的会话身份，
 * 不允许来自请求体。
 */

/** 提交成功的唯一结果（`ok`）。失败在 `submitCompanionCompletion` 里抛成 `ApiError`。 */
export type CompanionCompletionSubmitSuccess = Extract<
  CompanionCompletionSubmitOutcome,
  { kind: "ok" }
>;

/**
 * 打手提交完成材料（`serving` → pending submission）。
 *
 * ## 失败语义
 *
 * | 结果 | 抛出 | 为什么 |
 * |---|---|---|
 * | 订单不存在 / 不是本人实际履约 | `NOT_FOUND` → 404 | 两种表现必须一致，不泄露存在性 |
 * | 是本人的单，但状态不是 `serving` | `BAD_REQUEST` → 400 | 不是重放，是「点了此刻不该存在的按钮」 |
 * | 该订单已有 pending | `BAD_REQUEST` → 400 | 同一订单最多一份待审核材料 |
 *
 * ⚠️ 没有幂等键：这个动作每次都是新建记录，幂等判据是「同一订单最多一份 pending」
 * 的索引。完成说明长度与凭证格式在这里校验（`normalizeCompletionSummary` /
 * `parseEvidenceInput`），事务层收到的已经是合法意图。
 */
export async function submitCompanionCompletion(
  companionId: string,
  orderId: string,
  body: Record<string, unknown>,
): Promise<CompanionCompletionSubmitSuccess> {
  if (!orderId) throw new ApiError("NOT_FOUND", COMPLETION_ORDER_NOT_FOUND_MESSAGE, 404);

  const summary = normalizeCompletionSummary(readTrimmedString(body, "summary"));
  if (!summary.ok) throw new ApiError("BAD_REQUEST", summary.message, 400);

  const evidenceParsed = parseEvidenceInput(body.evidence, EVIDENCE_MAX_COUNT);
  if (!evidenceParsed.ok) throw new ApiError("BAD_REQUEST", evidenceParsed.message, 400);

  const at = new Date().toISOString();

  const outcome = await submitCompletionTransaction({
    companionId,
    orderId,
    summary: summary.value,
    evidence: toStoredEvidence(evidenceParsed.items),
    at,
  });

  if (outcome.kind === "ok") return outcome;
  if (outcome.kind === "not-found") {
    throw new ApiError("NOT_FOUND", COMPLETION_ORDER_NOT_FOUND_MESSAGE, 404);
  }
  if (outcome.kind === "pending-exists") {
    throw new ApiError("BAD_REQUEST", COMPLETION_PENDING_EXISTS_MESSAGE, 400);
  }
  throw new ApiError("BAD_REQUEST", COMPLETION_ORDER_NOT_SERVING_MESSAGE, 400);
}

/**
 * 订单 + **当前履约人**的最近一次提交 → 打手订单详情上的完成材料摘要。
 *
 * 供 `companionOrders.ts` 的详情拼装复用：判定逻辑（`canSubmit`）只写在
 * `buildCompanionCompletionInfo` 一处，这里只负责把「属于 `order.actualCompanionId`
 * 的那一份提交」取出来。
 *
 * ## 为什么必须按 `actualCompanionId` 过滤
 *
 * 取「该订单最近一次提交」而不校验提交者，会把**前一位打手**的材料（尤其驳回原因）
 * 回给现在履约的人。P0-9 封禁回池 / 客服改派之后，订单会 `serving → paid →
 * 他人重新接单`，同一订单上就会出现两位打手的提交记录——新打手 B 不该看到 A 的驳回原因。
 * `approveCompletion` 的第 7 步为同一个场景写了 `stale-submission` 守卫，
 * 这里补的是**读侧**的同一条边界。
 *
 * ## 过滤后的一个已知语义（P0-9 之前不可达，如实记录）
 *
 * 若该订单存在**别人的** pending 提交，本函数对「我」返回 `submission = null`，
 * `buildCompanionCompletionInfo` 会把 `canSubmit` 算成 `true`（`serving` 且「我」无记录），
 * 而事务层会返回 `pending-exists`。这在 P0-9 之前不可达：同一订单不可能同时是 A 的
 * pending 又是 B 的 serving（两者都要求订单 serving，而 serving 的履约人是唯一的）。
 * 因此这里**不**把别人的 pending 当成「你有 pending」——那会反过来污染 `canSubmit`，
 * 让我看到一句「请等待审核结果」却不属于我。到 P0-9 落地时若这一条真的可达，
 * 修法是让事务层的 pending 索引按 `(orderId, companionId)` 建，而不是在 DTO 里凑。
 */
export async function getCompanionCompletionInfo(
  orderId: string,
  order: { status: OrderStatus; actualCompanionId: string | null },
): Promise<CompanionCompletionInfo> {
  const submission = order.actualCompanionId
    ? await getCompletionRepository().findLatestCompletionByOrderIdAndCompanionId(
        orderId,
        order.actualCompanionId,
      )
    : null;
  return buildCompanionCompletionInfo(order, submission);
}
