/**
 * 图片公告列表的加载边界。
 *
 * ⚠️ 收在**这一个子页面**里，不能上提到 `content/` 那一层：上提一层会把
 * 活动 Banner、快捷入口、协议三个兄弟页面一起罩住，其中一个还在取数时，
 * 另外三个（已经能在服务端拿到数据的）也要先看骨架屏。
 *
 * 形状与页面的实际布局对齐（页头 → 筛选角标 → 表格），因此数据到达时
 * 页面不会整体跳一下——骨架屏的价值就在于「位置对得上」。
 */
export default function AdminContentAnnouncementsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className="h-6 w-40 animate-pulse rounded bg-line" />
      <div className="h-9 w-72 animate-pulse rounded bg-line" />
      <div className="h-64 animate-pulse rounded-xl border border-admin-line bg-surface" />
      <span className="sr-only">加载中…</span>
    </div>
  );
}
