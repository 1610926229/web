import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { replaceStaffOrderCompanion } from "@/lib/services/staffOrderActions";

/**
 * 客服直接指定新护航接替这一单：`POST /api/staff/orders/[id]/replace`（P0-11）。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ⚠️ 请求体只读**要指定的护航**（`companionId`）。**没有幂等键**，
 * 也**不需要管理员审批**（`01-prompt.md` §「Staff direct replace」明文）：
 * 客服的会话身份就是全部授权，本接口不读任何管理端开关。
 *
 * ⚠️ 原单若处于 `serving`，落点是同一段同步事务内的 `serving → paid → accepted`，
 * 中间那个 `paid` 不会被任何并发请求读到（`ORDER_TRANSITIONS` 里**没有**
 * `serving → accepted` 这条边，那是刻意的）。
 *
 * ⚠️ 本接口**不做金额联动**：不退款、不改订单金额，也不动打手收益。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/orders/[id]/replace">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await replaceStaffOrderCompanion(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
