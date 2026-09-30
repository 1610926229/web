import { fail, ok, toApiError } from "@/lib/api/route";
import { requireStaff } from "@/lib/api/staffRoute";
import {
  listStaffCompletions,
  resolveStaffCompletionListQuery,
} from "@/lib/services/staffCompletions";

/**
 * 客服工作台完成材料列表：`GET /api/staff/completions`。
 *
 * ⚠️ 第一件事是 `requireStaff()`：权限只能在服务端、在每个接口里判。
 *
 * ⚠️ 本接口**严格**解析筛选参数（`strict: true`）：接口是可被直接请求的，
 * 手改坏的状态该给 400 而不是静默回退，否则页面会显示一批与筛选栏不符的材料。
 *
 * ⚠️ 列表 DTO 只有摘要：**没有**证明材料、审核信息与驳回原因
 * （字段表见 `StaffCompletionListItem`）。通过与驳回两个动作在详情页执行。
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    // 守卫的返回值在这里**刻意不用**：完成材料审核是平台口径的待办，
    // 不按客服过滤（本阶段不做工单派发），因此查询不需要「我是谁」。
    // 但这一步不能省——它挡的是「谁可以读」，与「读谁的」是两件事。
    await requireStaff();
    const { searchParams } = new URL(request.url);

    const query = resolveStaffCompletionListQuery(searchParams, true);
    return ok(await listStaffCompletions(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
