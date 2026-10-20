import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import {
  createAdminBanner,
  queryAdminBannerList,
  resolveAdminContentListQuery,
} from "@/lib/services/adminBanners";

/**
 * 管理端活动图列表与新建：`GET` / `POST /api/admin/content/banners`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。权限判断只有 `lib/api/adminRoute.ts` 一处。
 *
 * ⚠️ 接口里可以有很多张活动图，**用户端首页永远只有一张**（§三 冻结口径）：
 * 用户端取 `enabled` 中排序最前的那一条。后台的价值在于「提前备好素材，
 * 换活动时切一下排序或启用状态」，而不是让首页变成轮播。
 *
 * GET 返回**全部**活动图（含停用与已移除），也**不分页**：这个量级是给运营
 * 翻看与调顺序用的，分页会让「改完第 3 页的排序、第 1 页没变」变成一个真问题。
 *
 * POST 的可改字段与公告完全相同（名称、图片地址、图片说明、排序、启用状态）；
 * `id`、`createdAt`、`updatedAt`、`removedAt` 在服务端没有读取的位置（§九）。
 * 新建**不会**自动顶掉当前正在投的那张——上线要么改排序、要么停用当前那张，
 * 两件事都是显式的。
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(request.url);
    const query = resolveAdminContentListQuery(searchParams, true);

    return ok(await queryAdminBannerList(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJsonBody(request);

    return ok(await createAdminBanner(admin.id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
