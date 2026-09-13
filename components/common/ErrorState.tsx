"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import EmptyState from "./EmptyState";

/**
 * 统一的错误状态：错误说明 + 重试。
 *
 * 取数失败时用它，而不是伪装成「暂无数据」——空数据与取数失败是两回事，
 * 用户看到的文案与可执行的动作都不同。
 *
 * 各路由的 error.tsx 都复用本组件，保证错误态的视觉与交互只有一份实现。
 *
 * **重试不能是「点了没反应」**。正常失败时调 Next 给的 `reset()`：重新渲染该路由段并
 * 重新取数。但如果失败来自 `?mockError=…` 这个故障注入参数，`reset()` 只是拿着同一个
 * 地址再取一次数，结果必然同样失败——用户看到的是「点一下、闪一下、又回到错误页」。
 * 因此这种情况下先把调试参数从地址里去掉再导航过去，这一次才是真的重试。
 * 该分支只在参数存在时生效，真实故障走的仍是 `reset()`。
 */

/** 服务端故障注入参数（`?mockError=1` / `?mockError=api`）。 */
const MOCK_ERROR_PARAM = "mockError";

export default function ErrorState({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  /** Next 提供的重试：重新渲染该路由段并重新取数 */
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // 目前没有错误上报服务，先留在控制台；接入监控后改由这里上报
    console.error(error);
  }, [error]);

  function handleRetry() {
    // 用 window.location 而不是 useSearchParams：这里只需要「点下去那一刻」的真实地址，
    // 用 hook 会要求本组件（连带各页面的 error.tsx）额外套一层 Suspense。
    const { pathname, search } = window.location;
    const params = new URLSearchParams(search);

    if (params.has(MOCK_ERROR_PARAM)) {
      params.delete(MOCK_ERROR_PARAM);
      const query = params.toString();
      // 客户端导航到去掉调试参数后的地址：路由段重新渲染并真的取一次数
      router.replace(query ? `${pathname}?${query}` : pathname);
      return;
    }

    reset();
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
      <EmptyState
        title="加载失败"
        description={error.message || "服务暂时不可用，请稍后重试。"}
      />

      <button
        type="button"
        onClick={handleRetry}
        className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
      >
        重试
      </button>
    </div>
  );
}
