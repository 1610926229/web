import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { createComplaintForUser, queryComplaintsForUser } from "@/lib/services/complaints";

/**
 * 投诉列表与提交投诉接口（浏览器端调用）。
 *
 * 权限：必须登录；用户身份只来自服务端会话，接口不接受任何「查谁的投诉」参数，
 * 因此不可能通过改参数读到别人的投诉。
 *
 * 参数契约（详见 `lib/constants/complaints.ts`）：
 * - `status` 非法 → 400，不静默回退成「全部」；
 * - `page` / `pageSize` 非数字或越界 → 规范化到安全范围。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryComplaintsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 提交投诉。
 *
 * 关联订单是选填的：带了就必须**属于当前用户**（否则 404）。
 *
 * 三件事由服务端保证：
 * - **状态与处理结果用户写不了**：新投诉只会是「待处理」，`result` 留空；
 * - **不改动订单、不产生退款**：本接口只写投诉记录；
 * - **幂等**：同一「用户 + 幂等键」只产生一条投诉。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await createComplaintForUser(user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
