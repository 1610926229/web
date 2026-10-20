import AdminAnnouncementConsole from "@/components/admin/AdminAnnouncementConsole";
import {
  queryAdminAnnouncementList,
  resolveAdminContentListQuery,
} from "@/lib/services/adminAnnouncements";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 图片公告（`/admin/content/announcements`）。
 *
 * 阅读顺序是**服务端渲染首屏 → 客户端接管**：这一页在服务端取一次列表交给
 * `AdminAnnouncementConsole`，之后筛选、写操作与错误处理都在浏览器里完成。
 * 因此地址栏直接打开这一页时看到的是数据，而不是一片骨架屏。
 *
 * ⚠️ 地址栏参数用**宽松**模式解析（`strict: false`）：`?removal=xxx` 这种被手改坏的地址
 * 收敛到默认筛选，而不是整页报错。接口那一路用严格模式（非法枚举 400）——
 * 调用方是程序，静默当成「全部」会让它拿着不知道筛了什么的结果继续往下用。
 *
 * ⚠️ 筛选状态**在 URL 里**（`removal=active` 是默认值也照样写出来）：
 * 复制给同事的链接打开的是同一个视图，而不是「我以为是默认值」的另一份数据。
 */
export default async function AdminContentAnnouncementsPage({
  searchParams,
}: PageProps<"/admin/content/announcements">) {
  const params = toSearchParams(await searchParams);
  const query = resolveAdminContentListQuery(params, false);
  const data = await queryAdminAnnouncementList(query, params, "server");

  return <AdminAnnouncementConsole initialResult={data} initialRemoval={query.removal} />;
}
