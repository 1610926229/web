import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createSuggestionForUser, querySuggestionsForUser } from "@/lib/services/suggestions";

/**
 * 意见反馈列表与提交反馈接口（浏览器端调用）。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的反馈」参数，
 * 因此不可能通过改参数读到别人的反馈。
 *
 * 参数契约（详见 `lib/constants/suggestions.ts`）：
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围（本阶段没有状态筛选）。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await querySuggestionsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 提交反馈。
 *
 * 三件事由服务端保证：
 * - **状态、回复与时间用户写不了**：新反馈只会是「已提交」，`reply` 留空、
 *   `repliedAt` 为 null，提交时间由服务端生成；
 * - **不改动任何业务数据**：本接口只写反馈记录，不碰订单、支付与优惠；
 * - **幂等**：同一「用户 + 幂等键」只产生一条反馈。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await createSuggestionForUser(user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
