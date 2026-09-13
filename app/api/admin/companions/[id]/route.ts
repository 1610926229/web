import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_COMPANION_NOT_FOUND_MESSAGE } from "@/lib/constants/adminCompanions";
import { getAdminCompanionDetail, updateAdminCompanion } from "@/lib/services/adminCompanions";

/**
 * 管理端护航详情与编辑：`GET` / `PATCH /api/admin/companions/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 对**已移除**的记录照样返回：后台要能查到「这个人被移除过」。
 * 返回 404 等于把软删除变成了记录消失，那正是软删除要避免的事。
 *
 * PATCH 的可改字段就是 `AdminCompanionProfilePatch` 那些（昵称、头像、介绍、游戏、
 * 大区、服务标签、启用状态、可接单状态、不可接单原因、展示排序），
 * 服务层只从请求体里读这些键——**统计、关联用户、来源申请、评分、订单 / 评价 / 鸡腿数量
 * 在读写两侧都没有位置**，多传一个字段不会有任何效果（§八）。
 *
 * 校验失败返回 400，message 是**第一条**字段错误：接口调用方看不到表单，
 * 至少要能从响应里知道是哪个字段不对。页面走的是服务端直取的那份逐字段错误。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminCompanionDetail(id, searchParams, "http");
    if (!detail) {
      throw new ApiError("NOT_FOUND", ADMIN_COMPANION_NOT_FOUND_MESSAGE, 404);
    }

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/companions/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminCompanion(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
