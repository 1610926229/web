"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { COMPANION_DETAIL_PAGE_TITLE } from "@/lib/constants/companions";

/**
 * 陪玩详情取数失败的错误边界。
 *
 * 顶部返回照常（不把人困在错误页上），正文给出错误说明与重试，二级页面没有 TabBar。
 * 重试由 `ErrorState` 处理：它会先把 `?mockError` 从地址里去掉再导航，
 * 否则重试只是拿着同一个故障注入参数再取一次数。
 *
 * 注意这里与 `not-found.tsx` 是**两件事**：「取数失败」和「这个陪玩不存在」，
 * 文案与可执行的动作都不同，不能合并成一屏。
 */
export default function CompanionDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={COMPANION_DETAIL_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
