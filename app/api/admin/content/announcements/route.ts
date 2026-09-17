import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  createAdminAnnouncement,
  queryAdminAnnouncementList,
  resolveAdminContentListQuery,
} from "@/lib/services/adminAnnouncements";

/**
 * 管理端图片公告列表与新建：`GET` / `POST /api/admin/content/announcements`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。普通用户、客服、护航与停用管理员
 * 一律 401 / 403 —— 权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * GET 返回**全部**公告（含停用与已移除，`removal=removed` 筛出后者）：
 * 「后台看不到自己停用过哪条公告」是不行的——停用与移除都必须是可回查的状态。
 * 这一条**不分页**：运营内容是个位数到几十条，加分页只会制造
 * 「改完第 3 页的排序、第 1 页没变」这类由分页自己造出来的问题。
 *
 * POST 的可改字段就是 `AdminAnnouncementProfilePatch` 那些（名称、图片地址、
 * 图片说明、排序、启用状态）。`id`、`createdAt`、`updatedAt`、`removedAt` 在服务端
 * **没有读取的位置**，客户端多传一个也不会有任何效果（§九）。
 * 「移除」不是这里的一个字段，它有自己的接口与审计动作。
 *
 * 数据源只有一份：本接口与用户端首页公告区读的是同一个仓储，保存即刻生效。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveAdminContentListQuery(searchParams, true);

    return ok(await queryAdminAnnouncementList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminAnnouncement(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
