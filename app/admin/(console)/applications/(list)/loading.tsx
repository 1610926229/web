/**
 * 入驻申请列表的加载边界。
 *
 * 收在 `(list)` 这一段里，**不能上提到 `(console)`**：上提一层就会把
 * `applications/[id]` 一起罩住，详情页迟到的 `notFound()` 会变成一屏 200 的 404 文案。
 * 与用户端 `app/(mobile)/companions/(list)/loading.tsx` 同一个理由。
 */
export default function AdminApplicationsLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <div className="h-6 w-40 animate-pulse rounded bg-line" />
      <div className="h-24 animate-pulse rounded-xl border border-admin-line bg-surface" />
      <div className="h-64 animate-pulse rounded-xl border border-admin-line bg-surface" />
      <span className="sr-only">加载中…</span>
    </div>
  );
}
