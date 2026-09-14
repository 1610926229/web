import { ApiError } from "@/lib/api/ApiError";
import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_STAFF_NOT_FOUND_MESSAGE } from "@/lib/constants/adminStaff";
import { getAdminStaffDetail, updateAdminStaff } from "@/lib/services/adminStaff";

/**
 * 管理端客服账号详情与编辑：`GET | PATCH /api/admin/staff/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * `GET` 返回详情：比列表多两样服务端算好的结论——`role`（这条记录到底是什么角色，
 * 页面要能看出它是不是客服）与 `canEnterStaffConsole`（能不能进工作台）。
 * 页面不自己判角色，判错了就是一个假的权限提示。
 *
 * `PATCH` 只改**资料**（登录名 / 名称 / 头像）。**不碰状态**：
 * 启用、停用、移除各有自己的接口，编辑时顺手写状态会在两位管理员同时操作时，
 * 让后写的那次把另一位刚停用的账号重新启用。
 *
 * ⚠️ 编辑也不涉及任何凭据：本阶段没有密码字段，也没有「重置密码」这个动作。
 * 登录入口是一份测试账号列表（`/staff/login`）。
 */
export async function GET(request: Request, context: RouteContext<"/api/admin/staff/[id]">) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminStaffDetail(id ?? "", searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", ADMIN_STAFF_NOT_FOUND_MESSAGE);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(request: Request, context: RouteContext<"/api/admin/staff/[id]">) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminStaff(id ?? "", admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
