/**
 * 经营首页的加载边界。
 *
 * ⚠️ **它必须待在路由组 `(overview)` 里，不能放在 `(console)` 这一层。**
 * `loading.tsx` 是一个 Suspense 边界，会罩住它下面**所有**子路由：
 * 放在 `(console)` 就会连 `applications/[id]`、`companions/[id]` 一起罩住，
 * 那边迟到的 `notFound()` 只能改页面内容、改不了已经以 200 发出的状态码，
 * 「不存在的申请」于是变成一屏 200 的 404 文案。
 *
 * 同理，`/admin/applications` 与 `/admin/companions` 的加载边界各在自己的 `(list)` 里。
 * 代价是每个需要加载态的路由段都多一个几行的文件；换来的是详情页有真正的 404。
 *
 * ⚠️ 骨架的形状跟着页面走（P1-1）：四段——今日经营 3 张、当前待办 3 张、
 * 快捷入口 6 项、全量累计 4 列。**骨架与真实布局对不上时，加载完的那一下会跳得很明显**，
 * 所以每次改页面布局都要回来改这里。
 */
export default function AdminOverviewLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-6 w-40 animate-pulse rounded bg-line" />
        <div className="h-4 w-full animate-pulse rounded bg-line" />
      </div>

      {/* 今日经营 + 当前待办：两组各 3 张，卡片高度与 AdminDashboardBoard 一致 */}
      {[0, 1].map((group) => (
        <div key={group} className="flex flex-col gap-3">
          <div className="h-5 w-24 animate-pulse rounded bg-line" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-28 animate-pulse rounded-xl border border-admin-line bg-surface"
              />
            ))}
          </div>
        </div>
      ))}

      {/* 快捷入口：6 项，比数字卡矮一截 */}
      <div className="flex flex-col gap-3">
        <div className="h-5 w-24 animate-pulse rounded bg-line" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-20 animate-pulse rounded-xl border border-admin-line bg-surface"
            />
          ))}
        </div>
      </div>

      {/* 全量累计：沿用原来的 4 列 */}
      <div className="flex flex-col gap-3">
        <div className="h-5 w-48 animate-pulse rounded bg-line" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className="h-28 animate-pulse rounded-xl border border-admin-line bg-surface"
            />
          ))}
        </div>
      </div>

      <span className="sr-only">加载中…</span>
    </div>
  );
}
