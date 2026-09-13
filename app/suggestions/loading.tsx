import NavBar from "@/components/common/NavBar";
import { SUGGESTION_PAGE_TITLE } from "@/lib/constants/suggestions";

/**
 * 功能建议列表的加载边界。
 *
 * 保留顶部返回导航，加载完成时布局不跳。本页面不在 `(tabs)` 内，因此没有 TabBar。
 *
 * 这里有个**不能省**的原因（与 `/rank/loading.tsx` 相同）：页面在渲染前先 `await` 取数，
 * 会先挂起。没有这层 Suspense 边界时，取数失败发生在外壳阶段，React 无法恢复，
 * 整个响应会退化成 500 的应用级错误页（实测）；有了它，响应保持 200，
 * 错误交给同一段的 `error.tsx` 在客户端接管，用户看到的是「加载失败 + 重试 + 返回」。
 *
 * 未登录时的加载态同样是这一屏：`RequireAuth` 的登录引导要等页面组件执行到才会出现，
 * 在那之前显示的是这里的「加载中…」。
 */
export default function SuggestionsLoading() {
  return (
    <>
      <NavBar title={SUGGESTION_PAGE_TITLE} showBack />
      <div className="flex flex-1 items-center justify-center bg-page px-4 py-16">
        <p className="text-[14px] text-ink-3">加载中…</p>
      </div>
    </>
  );
}
