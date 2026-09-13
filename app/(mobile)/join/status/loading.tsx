import NavBar from "@/components/common/NavBar";
import { COMPANION_JOIN_STATUS_PAGE_TITLE } from "@/lib/constants/companionApplications";

/**
 * 入驻进度页的加载边界。
 *
 * 保留顶部返回导航，加载完成时布局不跳。本页不在 `(tabs)` 内，因此没有 TabBar。
 *
 * 未登录时的加载态同样是这一屏：`RequireAuth` 的登录引导要等页面组件执行到才会出现。
 */
export default function JoinStatusLoading() {
  return (
    <>
      <NavBar title={COMPANION_JOIN_STATUS_PAGE_TITLE} showBack />
      <div className="flex flex-1 items-center justify-center bg-page px-4 py-16">
        <p className="text-[14px] text-ink-3">加载中…</p>
      </div>
    </>
  );
}
