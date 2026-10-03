import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { resubmitReviewForUser } from "@/lib/services/reviews";

/**
 * 重新提交被驳回的评价：`POST /api/reviews/[id]/resubmit`（`D9`）。
 *
 * ⚠️ 权限：必须登录，且这条评价必须是**当前用户自己的**。
 * 不存在与不属于你返回**同一个 404**——否则可以拿评价 id 试探别人写了什么。
 *
 * ⚠️ **只能在 `rejected` 状态下调用**。其余状态（`pending` / `approved` / `hidden`）
 * 一律 400：已经公开的评价不能靠「重提」打回待审核，那等于绕过了隐藏动作（`R2`）。
 *
 * ⚠️ 重提**不新建记录**：它是同一条评价的状态迁移（`rejected → pending`），
 * id 与首次提交时间都不变。因此不存在「重提几次就有几条评价」这种事。
 *
 * ⚠️ 重提后**重新进入审核队列**：内容变了就必须重新看一遍，这是 `D9` 的核心。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/reviews/[id]/resubmit">,
) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await resubmitReviewForUser(id, user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
