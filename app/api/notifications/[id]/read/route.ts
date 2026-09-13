import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { markNotificationReadForUser } from "@/lib/services/notifications";

/**
 * 标记通知已读（浏览器端调用）。
 *
 * 已读是**用户自己的状态**：只影响未读角标，不改动通知内容。
 * 重复标记是幂等的，不会把「什么时候读的」刷新成现在——
 * 否则每次进页面都会把历史已读时间改掉。
 *
 * 通知不存在或不属于当前用户返回 404：两种表现一致，不能拿通知 id 试探别人的通知。
 */
export async function POST(request: Request, { params }: RouteContext<"/api/notifications/[id]/read">) {
  try {
    const user = await requireUser();
    const { id } = await params;

    return ok(await markNotificationReadForUser(user.id, id ?? ""));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
