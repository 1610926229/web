import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { disableAdminStaff } from "@/lib/services/adminStaff";

/**
 * 停用客服账号：`POST /api/admin/staff/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **停用后立即失去客服工作台权限，现有客服端 Cookie 也失效**（§二）。
 * 这件事**不是**靠这里去删什么会话实现的——本阶段没有会话表可删，
 * 而是靠客服端每个请求都重新查一次账号状态（`lib/services/staffAuth.ts`）。
 * 因此停用只改一个 `enabled` 字段，旧 Cookie 在下一次请求就失效。
 *
 * 停用**不删除任何历史**：会话、消息、审计都还在，消息里的名称与头像快照也不受影响。
 * 真要让人彻底从名单里消失用的是「移除」。
 *
 * 重复停用不是错误：已经停用了就不写时间戳、不写第二条审计。
 */
export async function POST(request: Request, context: RouteContext<"/api/admin/staff/[id]/disable">) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await disableAdminStaff(id ?? "", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
