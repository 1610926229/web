import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { createAdminStaff, queryAdminStaffList, resolveAdminStaffListQuery } from "@/lib/services/adminStaff";

/**
 * 管理端客服账号：`GET /api/admin/staff`、`POST /api/admin/staff`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * ⚠️ 返回的是**管理端 DTO**，不是客服端会话，也不是仓储记录本身：
 * 没有 Cookie、没有密码、没有会话标识、没有仓储内部索引——
 * 前三样在这份数据里根本不存在（本阶段是 Mock 认证，账号里没有密码字段）。
 *
 * `GET` 的 `state` 支持 `all / enabled / disabled / removed`，
 * 非法值返回 400。已移除的账号**能筛出来看**：软删除不是消失，
 * 后台要能回答「这个账号现在是什么状态」。
 *
 * `POST` 新增：**角色写死为客服**。请求体里塞 `role: "admin"` 没有落脚的地方——
 * 不是「校验之后拒绝」，而是压根读不到那个字段。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveAdminStaffListQuery(searchParams, true);

    return ok(await queryAdminStaffList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminStaff(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
