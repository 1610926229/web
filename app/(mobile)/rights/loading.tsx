import NavBar from "@/components/common/NavBar";
import { LEVEL_PAGE_TITLE } from "@/lib/constants/levels";

/**
 * 消费等级页的加载边界。
 *
 * 保留顶部返回导航，加载完成时布局不跳。本页面不在 `(tabs)` 内，因此没有 TabBar。
 *
 * 这层边界同时是 `error.tsx` 生效的前提：没有它，`await` 取数失败会落在外壳阶段，
 * React 无法恢复，整个响应退化成 500；有了它，响应保持 200，错误由同一段的
 * `error.tsx` 在客户端接管（详见 `/rank/loading.tsx` 的说明）。
 */
export default function RightsLoading() {
  return (
    <>
      <NavBar title={LEVEL_PAGE_TITLE} showBack />
      <div className="flex flex-1 items-center justify-center bg-page px-4 py-16">
        <p className="text-[14px] text-ink-3">加载中…</p>
      </div>
    </>
  );
}
