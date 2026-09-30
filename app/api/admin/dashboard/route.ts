import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, toApiError } from "@/lib/api/route";
import { getAdminDashboard } from "@/lib/services/adminDashboard";

/**
 * 管理后台经营首页：`GET /api/admin/dashboard`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`，且必须在这里、不在服务层：页面上的隐藏入口
 * 不构成保护，接口是可以被直接请求的。这道守卫同时决定了四格拒绝行为——
 * 未登录 `401`、已登录但不是管理端账号 `403`。
 *
 * ⚠️ **本接口只读**：没有 POST / PATCH / DELETE，因为经营首页不做任何业务动作
 * （不审批、不退款、不换人、不改状态）。要看明细或处理业务，点卡片进对应的管理页。
 *
 * ⚠️ **统计逻辑一行都不在本文件里**：这里只做三件事——守卫、取 `searchParams`、
 * 调服务层。口径全部在 `lib/services/adminDashboard.ts` 与
 * `lib/constants/adminDashboard.ts`，因此「页面看到的数」与「接口返回的数」
 * 必然是同一份实现算出来的。
 *
 * ⚠️ `searchParams` 只承载 Mock 调试参数（`?mockError=…` / `?mockEmpty=dashboard`），
 * 与其它管理接口一样由服务层解释；没有 `page` / `status` 这类业务筛选，
 * 因为经营首页没有列表。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);

    return ok(await getAdminDashboard(searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
