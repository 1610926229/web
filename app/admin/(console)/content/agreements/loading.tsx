/**
 * 协议列表的加载边界。
 *
 * 收在本子页面里（理由同公告页那份）：上提到 `content/` 会把四个兄弟页面一起罩住。
 */
export default function AdminContentAgreementsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className="h-6 w-40 animate-pulse rounded bg-line" />
      <div className="h-9 w-72 animate-pulse rounded bg-line" />
      <div className="h-64 animate-pulse rounded-xl border border-admin-line bg-surface" />
      <span className="sr-only">加载中…</span>
    </div>
  );
}
