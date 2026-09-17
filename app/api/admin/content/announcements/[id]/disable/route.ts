import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { setAdminAnnouncementEnabled } from "@/lib/services/adminAnnouncements";

/**
 * 停用公告：`POST /api/admin/content/announcements/[id]/disable`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 停用是**可逆**的，与移除不是一回事：记录原封不动，运营随时可以启用回来，
 * 后台默认视图里它仍然在（只是状态是「已停用」）。
 *
 * ❌ 停用**不删素材、不做任何替换**：用户端的公告区就是少一条，
 * 没有「自动顶上下一张」这回事——那会让运营以为停用不生效。
 *
 * 重复停用是幂等的：不写数据、不写第二条审计，返回 `changed: false`。
 * 已移除的公告则一律拒绝（`该公告已移除`）：它已经不在用户端了，改状态没有去向。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/announcements/[id]/disable">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await setAdminAnnouncementEnabled(id, false, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
