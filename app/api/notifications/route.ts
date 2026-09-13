import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { queryNotificationsForUser } from "@/lib/services/notifications";

/**
 * 系统通知列表接口（浏览器端调用，客服首页「系统通知」用）。
 *
 * 权限：必须登录；返回的只有当前用户自己的通知，接口没有任何「查谁」的参数。
 *
 * 返回体在 `PageResult` 之上多一个 `unreadCount`：客服页要在 Tab 上显示未读数，
 * 为了一个角标再发一次请求不值得。分页参数同样走规范化，坏掉的页码不会让整页报错。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryNotificationsForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
