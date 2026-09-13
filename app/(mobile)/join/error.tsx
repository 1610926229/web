"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { COMPANION_JOIN_PAGE_TITLE } from "@/lib/constants/companionApplications";

/**
 * 入驻申请页取数失败的错误边界。
 *
 * 顶部返回照常（不把人困在错误页上），正文给出错误说明与重试，二级页面没有 TabBar。
 * 重试由 `ErrorState` 处理：它会先把 `?mockError` 从地址里去掉再导航，
 * 否则重试只是拿着同一个故障注入参数再取一次数。
 *
 * 这一层同时盖住「读取自己的申请状态」失败：读不到状态就不该渲染表单，
 * 否则用户填完一整张表才在提交时被告知「你已经申请过了」。
 */
export default function JoinError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={COMPANION_JOIN_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
