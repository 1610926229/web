import { redirect } from "next/navigation";

/**
 * `/admin/content` 本身不是一个页面，它只是「运营内容」这一组的入口地址
 * （侧栏那一项指向的就是它）。
 *
 * ⚠️ 这个文件**必须存在**：`lib/constants/admin.ts` 里「运营内容」的 `href`
 * 正是 `/admin/content`，没有它侧栏点进去就是 404。四个子模块平级，
 * 没有一个天然更「主要」——这里选图片公告作为落地页，因为它是运营最常改的一项。
 *
 * 用 `redirect()` 而不是渲染一份「请选择子模块」的中间页：中间页要多一次点击，
 * 而且要维护第五份文案；子页签本来就一直挂在布局上（`layout.tsx`），
 * 落地即到图片公告并不妨碍一眼看到另外三个。
 */
export default function AdminContentIndexPage() {
  redirect("/admin/content/announcements");
}
