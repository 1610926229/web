import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { startProcessingAdminComplaint } from "@/lib/services/adminComplaints";

/**
 * 开始处理投诉：`POST /api/admin/complaints/[id]/start-processing`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * ⚠️ **只改状态**：`pending → processing`，**不产生任何结论**——处理结果一个字都不写。
 * 请求体里的 `result` 即便传了也不会被读取（写入侧在 `start-processing` 意图下忽略它），
 * 否则会出现「处理中但已经有结果」这种读不出来的记录。
 *
 * ⚠️ **不自动修改订单，也不自动退款**：这一组接口连订单与退款的模块都不 import。
 *
 * 重复点击、网络重试与并发请求不会重复迁移状态、也不会重复写审计：
 * 判定在 `lib/data/adminComplaintTransaction.ts` 的原子区段里。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/complaints/[id]/start-processing">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await startProcessingAdminComplaint(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
