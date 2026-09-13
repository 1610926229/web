import { ApiError } from "@/lib/api/ApiError";
import { parseEvidenceInput, toStoredEvidence, type EvidenceDraft } from "@/lib/constants/evidence";
import {
  SUGGESTION_EVIDENCE_KINDS,
  SUGGESTION_EVIDENCE_MAX_COUNT,
  SUGGESTION_TYPE_LABELS,
  SUGGESTION_TYPE_REQUIRED_MESSAGE,
  isSuggestionType,
  normalizeSuggestionContact,
  normalizeSuggestionContent,
  parseSuggestionListQuery,
  toSuggestionListItem,
} from "@/lib/constants/suggestions";
import {
  IDEMPOTENCY_KEY_MISSING_MESSAGE,
  readIdempotencyKey,
  readTrimmedString,
} from "@/lib/constants/writes";
import { getSuggestionRepository } from "@/lib/data/suggestionRepository";
import { withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type {
  SuggestionCreateResult,
  SuggestionPage,
  SuggestionTypeKey,
} from "@/lib/types/suggestion";

/**
 * 意见反馈服务 —— 反馈列表、提交表单与接口共用的唯一入口。
 *
 * 四条硬规则，本文件是它们唯一的落点：
 *
 * 1. **只处理当前用户的数据**。所有函数都要求传入会话里读到的 `userId`，仓储把它当成
 *    查询条件；接口不接受任何「查谁的反馈」参数，因此改参数读不到别人的记录。
 * 2. **状态、回复与时间一律由服务端写**。请求体只按白名单取「类型 / 内容 / 联系方式 / 凭证」，
 *    客户端塞进来的 `userId` / `status` / `reply` / `repliedAt` / `createdAt` 都不会被读取。
 *    新反馈的状态写死为「已提交」，回复留空——平台回复只能来自预置数据或将来后台的返回。
 * 3. **写入幂等**。同一「用户 + 幂等键」只产生一条反馈，命中时返回第一次的结果
 *    （`created: false`），快速连点与失败重试都不会多出记录。
 * 4. **反馈不改动任何业务数据**。这里不写订单、不写支付、不产生优惠与鸡腿记录，
 *    也不参与消费等级计算。
 *
 * 与投诉的区别：投诉可以关联一笔订单，反馈针对平台本身，因此**没有订单校验**这一步，
 * 也就没有「拿别人的订单 id 来试探」的可能。
 */

// ——————————————————————————— 输入解析 ———————————————————————————

type SuggestionInput = {
  typeKey: SuggestionTypeKey;
  content: string;
  contact: string;
  evidence: EvidenceDraft[];
};

/**
 * 按**白名单**解析反馈表单。
 *
 * 只有类型、内容、联系方式、凭证四类字段会被读取——`status` / `reply` / `userId` 之类
 * 即便塞进请求体也会被直接丢弃。这不是「检查一下状态对不对」，
 * 而是根本不存在接收这些字段的位置。
 */
export function parseSuggestionInput(body: Record<string, unknown>): SuggestionInput {
  const rawType = readTrimmedString(body, "typeKey");
  if (!rawType || !isSuggestionType(rawType)) {
    throw new ApiError("BAD_REQUEST", SUGGESTION_TYPE_REQUIRED_MESSAGE);
  }

  const content = normalizeSuggestionContent(
    typeof body.content === "string" ? body.content : "",
  );
  if (!content.ok) throw new ApiError("BAD_REQUEST", content.message);

  const contact = normalizeSuggestionContact(
    typeof body.contact === "string" ? body.contact : "",
  );
  if (!contact.ok) throw new ApiError("BAD_REQUEST", contact.message);

  const evidence = parseEvidenceInput(
    body.evidence,
    SUGGESTION_EVIDENCE_MAX_COUNT,
    SUGGESTION_EVIDENCE_KINDS,
  );
  if (!evidence.ok) throw new ApiError("BAD_REQUEST", evidence.message);

  return {
    typeKey: rawType,
    content: content.content,
    contact: contact.contact,
    evidence: evidence.items,
  };
}

// ——————————————————————————— 读取 ———————————————————————————

/**
 * 查询当前用户的反馈列表。
 *
 * 只有分页参数，没有状态筛选（原型上也没有），因此不存在「筛选条件非法」这一分支；
 * 分页参数的非法值走规范化，坏掉的页码不该让整页报错。
 */
export async function querySuggestionsForUser(
  userId: string,
  params: URLSearchParams,
  surface: MockSurface,
): Promise<SuggestionPage> {
  const query = parseSuggestionListQuery(params);

  const page = await withMockDebug(params, surface, () =>
    getSuggestionRepository().querySuggestions({ ...query, userId }),
  );

  // 转换只在这里发生：仓储实体（含 userId）不会直接出现在接口响应里
  return { ...page, items: page.items.map(toSuggestionListItem) };
}

// ——————————————————————————— 提交 ———————————————————————————

/**
 * 提交反馈。
 *
 * 顺序刻意如此：
 *
 * 1. 幂等键格式不对直接拒绝——没有键就无法防重，宁可不做；
 * 2. **快速路径**：这个键提交过就返回上一次的结果，连校验都不重来
 *    （重试要的是「和上次一样的结果」，而不是按现在的状态重新算一遍）；
 * 3. 白名单解析并校验（类型必选、内容去首尾空格后非空且不超长、联系方式选填）；
 * 4. 写入：id、状态（`submitted`）、提交时间都由服务端生成，
 *    回复留空、回复时间为 null。凭证只收客户端给的「类型 + 文件名」，
 *    `id` 与地址由服务端补。
 */
export async function createSuggestionForUser(
  userId: string,
  body: Record<string, unknown>,
  params: URLSearchParams | undefined,
  surface: MockSurface,
  now: Date = new Date(),
): Promise<SuggestionCreateResult> {
  const idempotencyKey = readIdempotencyKey(body);
  if (!idempotencyKey) throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);

  const repository = getSuggestionRepository();

  const byKey = await repository.findSuggestionByKey(userId, idempotencyKey);
  if (byKey) return { suggestionId: byKey.id, created: false };

  const input = parseSuggestionInput(body);

  const outcome = await withMockDebug(params, surface, () =>
    repository.createSuggestion(
      {
        id: `sug_${crypto.randomUUID()}`,
        userId,
        typeKey: input.typeKey,
        typeLabel: SUGGESTION_TYPE_LABELS[input.typeKey] ?? input.typeKey,
        content: input.content,
        contact: input.contact,
        // 凭证的 id 与地址在这里生成，客户端只提交了类型与文件名
        evidence: toStoredEvidence(input.evidence),

        // 用户新提交的反馈只会是「已提交」：本阶段没有任何用户端的回复 / 关闭入口
        status: "submitted",
        reply: "",
        repliedAt: null,
        createdAt: now.toISOString(),
      },
      idempotencyKey,
    ),
  );

  // 命中幂等键时返回第一次的结果，调用方据此提示「已提交过」而不是再写一条
  return { suggestionId: outcome.suggestion.id, created: outcome.created };
}
