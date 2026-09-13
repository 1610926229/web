import NavBar from "@/components/common/NavBar";
import { COMPANION_LIST_PAGE_TITLE } from "@/lib/constants/companions";

/**
 * 陪玩列表的加载边界。
 *
 * 保留顶部返回导航，加载完成时布局不跳。本页不在 `(tabs)` 内，因此没有 TabBar。
 *
 * 这里有个**不能省**的原因（与 `/rank`、`/suggestions` 相同）：页面在渲染前先 `await` 取数，
 * 会先挂起。没有这层 Suspense 边界时，取数失败发生在外壳阶段，React 无法恢复，
 * 整个响应会退化成 500 的应用级错误页（实测）；有了它，响应保持 200，
 * 错误交给同一段的 `error.tsx` 在客户端接管，用户看到的是「加载失败 + 重试 + 返回」。
 *
 * ⚠️ **它必须待在路由组 `(list)` 里，不能上提到 `app/companions/`：** 上提一层就会连
 * `app/companions/[id]` 一起罩住，那边迟到的 `notFound()` 只能改页面内容、改不了已经
 * 以 200 发出的状态码，「不存在的陪玩」于是变成一屏 200 的 404 文案。
 * 加载态与真实 404 只能二选一时，这里选了各归各段：列表有加载态，详情有真 404。
 */
export default function CompanionsLoading() {
  return (
    <>
      <NavBar title={COMPANION_LIST_PAGE_TITLE} showBack />
      <div className="flex flex-1 items-center justify-center bg-page px-4 py-16">
        <p className="text-[14px] text-ink-3">加载中…</p>
      </div>
    </>
  );
}
