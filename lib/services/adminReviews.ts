import { ApiError } from "@/lib/api/ApiError";
import {
  ADMIN_REVIEW_LIST_NOTICE,
  ADMIN_REVIEW_NOT_FOUND_MESSAGE,
  ADMIN_REVIEW_OPERATION_CONFLICT_MESSAGE,
  ADMIN_REVIEW_STATUS_INVALID_MESSAGE,
  adminReviewInvalidTransitionMessage,
  buildAdminReviewListQuery,
  readAdminReviewStatusFilter,
  toAdminReviewListItem,
  toAdminReviewWriteResult,
} from "@/lib/constants/adminReviews";
import {
  REVIEW_MODERATION_ACTION_LABELS,
  REVIEW_MODERATION_AUDIT_ACTIONS,
  REVIEW_MODERATION_REQUIRES_REASON,
  normalizeReviewReason,
  reviewStatusLabel,
  type ReviewModerationAction,
} from "@/lib/constants/reviews";
import {
  IDEMPOTENCY_KEY_MISSING_MESSAGE,
  readIdempotencyKey,
  readTrimmedString,
} from "@/lib/constants/writes";
import {
  moderateReview,
  type AdminReviewWriteOutcome,
  type AdminWriteContext,
} from "@/lib/data/adminReviewTransaction";
import { getReviewRepository, type AdminReviewListQuery } from "@/lib/data/reviewRepository";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import { adminUserIndex, missingUser } from "./adminIndex";
import type {
  AdminReviewDetail,
  AdminReviewListData,
  AdminReviewWriteResult,
} from "@/lib/types/review";

/**
 * 管理端「评价审核」服务 —— 列表、详情与四种审核动作的唯一入口（P1-8）。
 *
 * ⚠️ 本文件**只服务管理端**，每一个调用它的接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处（`D21`：权限在服务端强制）。
 *
 * 这一层负责四件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能给的只有 `action` 与 `reason`）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 生成 DTO —— 仓储实体（含 `userId`）不会流到浏览器；
 * 4. 补上作者摘要（仓储里评价只带 `userId`）。
 *
 * ## 这里**没有**「改星级 / 改正文」的入口（`D12`）
 *
 * 不是「还没做」，是这一层根本没有接收这两个字段的位置：`moderateReview()`
 * 只收「动作 + 原因」，`ReviewStatusPatch` 里只有审核字段。
 * 管理员能做的四件事就是 `通过 / 驳回 / 隐藏 / 恢复公开`。
 *
 * ## 为什么四个动作只有一个接口函数
 *
 * 它们**唯一的区别**是动作名：目标状态、是否需要原因、审计动作名、可不可行，
 * 全部由 `lib/constants/reviews.ts` 的三张表与状态机决定。
 * 写成四个函数就是把同一段「解析 → 写 → 翻译」抄四遍，而漏掉的那一遍会表现为
 * 「某个动作不做幂等校验」。因此这里是**一个** `moderateAdminReview()`，
 * 动作由调用方给出（四个 Route Handler 各传一个，页面按钮各传一个）。
 *
 * ⚠️ **数据源只有一份**：本文件改的是用户提交的那条评价本身。
 * `approved` 变成 `hidden` 之后，商品页与打手页的评分**下一次读取就会变**
 * ——不需要任何同步动作，因为它们聚合的是同一批记录（`D14` / `R3`）。
 */

/** 列表查询条件。接口 `strict: true` 非法枚举 400；页面 `strict: false` 规范化到默认值。 */
export function resolveAdminReviewListQuery(
  params: URLSearchParams,
  strict: boolean,
): AdminReviewListQuery {
  const raw = params.get("status");
  const status = readAdminReviewStatusFilter(raw);

  // ⚠️ 传了非法状态时：接口报错，页面回退。分页参数则一律规范化——
  // 页码不是业务条件，状态是。这个区别与其它后台列表一致。
  if (strict && status === null && raw !== null && raw !== "") {
    throw new ApiError("BAD_REQUEST", ADMIN_REVIEW_STATUS_INVALID_MESSAGE, 400);
  }

  // 缺省只看待审核：这是这个页面的主用途（「待审核队列」），
  // 而不是「全部评价」——默认落在全部会让人以为队列里只有这么几条。
  return buildAdminReviewListQuery({ params, status: status ?? "pending" });
}

/**
 * 管理端评价列表。
 *
 * ⚠️ 关键词筛选与分页**都在仓储里**完成。这里绝不做「先取一页、再过滤关键词」——
 * 那样 `total` 是页前总数、实际能翻到的却更少，两个数字必然对不上。
 *
 * 角标（`counts`）读的是 `countReviewsByStatus()`，**不受筛选与分页影响**：
 * 它是「后台一共有多少条待审」，用于决定要不要去看这一页。
 */
export async function queryAdminReviewList(
  query: AdminReviewListQuery,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminReviewListData> {
  return withMockDebug(params, surface, async () => {
    const repository = getReviewRepository();

    if (mockEmptyApplies(params, "reviews")) {
      return {
        items: [],
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        hasMore: false,
        // 角标照常给出真实数字：空态注入的是**这一页的列表**，不是「后台没有待审评价」。
        // 把它一起清零等于伪造一个业务事实，而验收空态要看的是版式
        counts: await repository.countReviewsByStatus(),
        notice: ADMIN_REVIEW_LIST_NOTICE,
      };
    }

    const [{ items, ...page }, counts, users] = await Promise.all([
      repository.queryReviewsForAdmin(query),
      repository.countReviewsByStatus(),
      adminUserIndex(),
    ]);

    return {
      ...page,
      items: items.map((review) =>
        toAdminReviewListItem(review, users.get(review.userId) ?? missingUser(review.userId)),
      ),
      counts,
      notice: ADMIN_REVIEW_LIST_NOTICE,
    };
  });
}

/**
 * 管理端评价详情。
 *
 * 本阶段与列表项同形（`AdminReviewDetail = AdminReviewListItem`）：审核需要的字段
 * 列表项里已经全有了。**仍然单独提供一个方法**，因为「列表项就是详情」是一个
 * 当下的巧合——哪天详情要多带一份审计时间线，接口与页面不必跟着改结构。
 */
export async function getAdminReviewDetail(
  id: string,
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<AdminReviewDetail | null> {
  return withMockDebug(params, surface, async () => {
    const review = await getReviewRepository().findReviewById(id);
    if (!review) return null;

    const users = await adminUserIndex();
    return toAdminReviewListItem(review, users.get(review.userId) ?? missingUser(review.userId));
  });
}

// ——————————————————————————— 审核动作 ———————————————————————————

/** 伪事务的写上下文。原因由服务层校验后传下去，审核人由会话给出。 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    // ⚠️ 传 `null` 而不是编一个名字：`AdminAudit` 里记的是**账号 id**，
    // 显示名由读取侧按当前账号资料解析。写死一个快照名字，改名之后历史审计会永远显示旧名
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

/**
 * 审核一条评价（通过 / 驳回 / 隐藏 / 恢复公开）。
 *
 * ## 顺序
 *
 * 1. **幂等键必填**：没有键就无法防重，宁可不做（与其它后台写操作同一口径）；
 * 2. **原因按动作校验**（`D10`）：只有 `reject` / `hide` 需要，且要求 trim 后非空、
 *    不超过 `REVIEW_REASON_MAX_LENGTH`；`approve` / `unhide` **连读都不读**这个字段
 *    （传了不校验、不报错、也不落库）——「不读」比「读了再丢」更省钱也更难出错；
 * 3. 交给伪事务：它在一个**没有 `await` 的同步区段**里完成「重放检查 → 读 → 判定 → 写 →
 *    写审计」，并在服务层之前拦住不存在 / 冲突 / 非法迁移三种情形。
 *
 * ⚠️ 原因**必须在这里校验**，不能只在界面上限制：接口可以被直接调用，
 * 而「驳回却不写原因」正是 `D10` 要挡的那件事——用户收到一条被驳回的评价
 * 却不知道哪里不合规，既改不了也无从申辩。
 *
 * ⚠️ `unhide` 不需要业务原因（`D10`）：把一条评价放回公开列表本身不需要向谁解释。
 * 但它**照样写审计**（`D11` / `D22`）——谁在什么时候做了这件事必须可追溯。
 */
export async function moderateAdminReview(
  reviewId: string,
  action: ReviewModerationAction,
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminReviewWriteResult> {
  const operationId = readIdempotencyKey(body);
  if (!operationId) {
    throw new ApiError("BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE, 400);
  }

  // ⚠️ 不需要原因的动作**根本不读 `reason`**（`D10`），而不是「读了再丢掉」。
  // 差别是真实的：读了就意味着一份超长的 `reason` 会把 `approve` 变成 400，
  // 而调用方（比如一个对所有审核动作都用同一段代码的客户端）送这个字段时，
  // 本意只是「带上而已」，不该让一个与通过无关的字段否决这次通过。
  const reason = REVIEW_MODERATION_REQUIRES_REASON[action]
    ? normalizeReviewReason(readTrimmedString(body, "reason"), true)
    : ({ ok: true, reason: null } as const);
  if (!reason.ok) throw new ApiError("BAD_REQUEST", reason.message, 400);

  const outcome = await moderateReview(reviewId, action, reason.reason, writeContext(adminId, operationId));

  return toWriteResult(outcome, reviewId, action);
}

/**
 * 伪事务的结果 → 接口返回。
 *
 * 成功时**只回状态字段**：界面据此就地更新那一行，不需要为了刷新一条评价重新拉一整页。
 *
 * ⚠️ 三种「成功」在**接口层是同一件事**（都是 `200` + 当前状态）：
 * 真的改了、本来就是目标状态、同一个键重放。它们的区别只在 `changed`
 * ——界面据此决定提示「已通过」还是「该评价已是已通过状态」。
 * 把它们做成不同的状态码会逼调用方去分辨「哪种算成功」，而它们都不需要重试。
 *
 * ⚠️ `invalid-transition` 的提示里带上**当前状态与动作名**：只说「操作失败」
 * 会让管理员以为是自己点错了、于是反复重试同一个动作。文案在常量层，
 * 因为它是三套不同的处置（改点隐藏 / 等用户重提 / 状态不对），合并成一句就没人知道该怎么办。
 */
function toWriteResult(
  outcome: AdminReviewWriteOutcome,
  reviewId: string,
  action: ReviewModerationAction,
): AdminReviewWriteResult {
  switch (outcome.kind) {
    case "not-found":
      throw new ApiError("NOT_FOUND", ADMIN_REVIEW_NOT_FOUND_MESSAGE, 404);
    case "operation-conflict":
      throw new ApiError("BAD_REQUEST", ADMIN_REVIEW_OPERATION_CONFLICT_MESSAGE, 400);
    case "invalid-transition":
      throw new ApiError(
        "BAD_REQUEST",
        adminReviewInvalidTransitionMessage(outcome.current, action),
        400,
      );
    default:
      return toAdminReviewWriteResult(reviewId, outcome.value.updated.status, outcome.changed);
  }
}

/**
 * 动作的中文名与审计动作名 —— 仅供页面与测试读取。
 *
 * 再导出让「按钮上写什么」与「审计里记什么」都从同一张表来：
 * 页面不自己拼「通过」，测试也不自己写 `"review.approve"`。
 */
export const ADMIN_REVIEW_ACTION_LABELS = REVIEW_MODERATION_ACTION_LABELS;
export const ADMIN_REVIEW_AUDIT_ACTIONS = REVIEW_MODERATION_AUDIT_ACTIONS;

/** 状态的中文名再导出：页面与测试共用一份，避免出现第二份「审核中 / 已通过」。 */
export { reviewStatusLabel };
