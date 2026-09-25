import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import { releaseStaffOrder } from "@/lib/services/staffOrderActions";

/**
 * 客服把订单退回公共池：`POST /api/staff/orders/[id]/release`（P0-11）。
 *
 * ⚠️ 第一件事是 `requireStaff()`，且必须在读请求体之前。
 *
 * ⚠️ 请求体只读**原因**。操作者（谁触发的这条退出历史）不在这里：
 * 客服身份来自守卫返回的会话，`staffId` 由服务层从会话取。
 * 原因**必填**（trim 后非空即 400），长度不限。
 *
 * ⚠️ 这条路径会**同时**做五件事（`01-prompt.md` §「禁用释放」同一套要求）：
 * 作废这一单那份 `pending` 完成材料、写退出历史、清订单履约绑定、把派单送回公共池、
 * 通知下单用户。它们在 `releaseOrderByStaff` 的同一段无 `await` 的同步代码里完成，
 * 本文件与那个函数都不做判定之外的事。
 *
 * ⚠️ 本接口**不做金额联动**：不退款、不改订单金额。
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RouteContext<"/api/staff/orders/[id]/release">,
) {
  try {
    const staff = await requireStaff();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await releaseStaffOrder(id ?? "", staff, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
