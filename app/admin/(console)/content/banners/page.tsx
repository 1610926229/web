import AdminBannerConsole from "@/components/admin/AdminBannerConsole";
import { queryAdminBannerList, resolveAdminContentListQuery } from "@/lib/services/adminBanners";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 活动 Banner（`/admin/content/banners`）。
 *
 * 与公告页同一套读法：服务端取首屏 → 客户端接管筛选与写入；地址栏参数宽松解析，
 * 非法值收敛到默认筛选而不是整页报错。
 *
 * ⚠️ 后台可以有很多张，**用户端首页永远只有一张**（取启用中排序最前的那条）。
 * 这一页的排序与启用状态因此不是「偏好」，而是「现在前台看到的是哪一张」的答案——
 * 那句口径说明写在 `AdminBannerConsole` 的页头与列表下方，不靠这一行注释提醒运营。
 */
export default async function AdminContentBannersPage({
  searchParams,
}: PageProps<"/admin/content/banners">) {
  const params = toSearchParams(await searchParams);
  const query = resolveAdminContentListQuery(params, false);
  const data = await queryAdminBannerList(query, params, "server");

  return <AdminBannerConsole initialResult={data} initialRemoval={query.removal} />;
}
