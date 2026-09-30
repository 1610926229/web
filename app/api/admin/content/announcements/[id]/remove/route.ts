import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { removeAdminAnnouncement } from "@/lib/services/adminAnnouncements";

/**
 * 移除公告（软删除）：`POST /api/admin/content/announcements/[id]/remove`。
 *
 * ⚠️ 第一件事是 `requireAdmin()`。
 *
 * 移除是**软删除**：记录保留（已经发出去、用户看过的图，事后要能回答
 * 「当时首页上那张是什么」），后台可以用 `removal=removed` 筛到，详情也照常打开。
 *
 * 移除之后这条记录**不再接受编辑与启停**（`该公告已移除`）：它已经不在用户端了，
 * 改名称与排序没有任何去向。这是一条单向迁移，没有「取消移除」的接口
 * ——需要重新上线时是新建一条，而不是把历史状态抹掉。
 *
 * 重复移除是幂等的：不刷新时间戳、不写第二条审计。
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/content/announcements/[id]/remove">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await removeAdminAnnouncement(id, admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
