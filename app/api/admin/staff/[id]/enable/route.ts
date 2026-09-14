import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { enableAdminStaff } from "@/lib/services/adminStaff";

/**
 * 启用客服账号：`POST /api/admin/staff/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 启用只把 `enabled` 打开，**不重置任何资料**：登录名、名称、头像、
 * 上次登录时间一个都不变。「启用」不是「恢复出厂设置」。
 *
 * ⚠️ **已移除的账号不能启用**（400）：移除是软删除，不是可以来回拨的开关。
 * 要让一位已移除的客服重新上岗，请新建一个账号——这也让审计里
 * 「谁在什么时候被移除」与「谁在什么时候被新增」保持是两件独立的事。
 *
 * 重复启用不是错误：本来就在启用状态时，不写时间戳、不写第二条审计。
 */
export async function POST(request: Request, context: RouteContext<"/api/admin/staff/[id]/enable">) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await enableAdminStaff(id ?? "", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
