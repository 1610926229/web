"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { COMPANION_JOIN_STATUS_PAGE_TITLE } from "@/lib/constants/companionApplications";

/**
 * 入驻进度页取数失败的错误边界。
 *
 * 顶部返回照常，正文给出错误说明与重试，二级页面没有 TabBar。
 * 重试由 `ErrorState` 处理：它会先把 `?mockError` 从地址里去掉再导航，
 * 否则重试只是拿着同一个故障注入参数再取一次数，点了必然又回到这一屏。
 */
export default function JoinStatusError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={COMPANION_JOIN_STATUS_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
