import NavBar from "@/components/common/NavBar";
import { COMPANION_RANKING_PAGE_TITLE } from "@/lib/constants/companionRankings";

/**
 * 打手排行榜的加载边界（P1-5）。
 *
 * 保留顶部返回导航，加载完成时布局不跳。本页面不在 `(tabs)` 内，因此没有 TabBar。
 *
 * ⚠️ 这一层**不能省**，理由与消费榜的 `rank/loading.tsx` 完全相同：
 * 页面在渲染前先 `await` 取数，会先挂起；没有这层 Suspense 边界时，
 * 取数失败发生在外壳阶段，React 无法恢复，整个响应会退化成 500 的应用级错误页。
 * 有了它，响应保持 200，错误交给同段的 `error.tsx` 在客户端接管。
 *
 * ⚠️ 它是**同段**的边界：`app/(mobile)/rank/loading.tsx` **不会**罩住
 * `app/(mobile)/rank/companions/`——路由段的 Suspense 边界按目录生效，
 * 只有 `rank/` 自己的那一页在它的子树里。因此本文件必须存在，
 * 不能靠「上一级已经有 loading」来省掉。
 */
export default function CompanionRankLoading() {
  return (
    <>
      <NavBar title={COMPANION_RANKING_PAGE_TITLE} showBack />
      <div className="flex flex-1 items-center justify-center bg-page px-4 py-16">
        <p className="text-[14px] text-ink-3">加载中…</p>
      </div>
    </>
  );
}
