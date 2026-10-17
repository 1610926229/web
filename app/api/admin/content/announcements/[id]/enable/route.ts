import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminAnnouncementEnabled } from "@/lib/services/adminAnnouncements";

/**
 * 启用公告：`POST /api/admin/content/announcements/[id]/enable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 走的是**窄写入**（只改 `enabled` 一个字段），不是把整条记录写回去：
 * 列表上的开关如果走「先读出来、拼一个完整 patch 再保存」，两位管理员同时操作时，
 * 后写的那次会把另一位刚换好的素材图覆盖回旧的那张。
 *
 * 重复启用是**幂等**的：已经启用的公告再启用一次不写数据、不写第二条审计，
 * 返回 `changed: false`。真正的防重是幂等键加服务端的状态判断（§九），
 * 不是按钮禁用。
 *
 * 启用之后用户端立刻能看到它（公告区显示全部启用中的公告，按排序值升序）。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/announcements/[id]/enable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminAnnouncementEnabled(id, true, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
