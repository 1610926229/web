"use client";

import NavBar from "@/components/common/NavBar";
import ErrorState from "@/components/common/ErrorState";
import { SUGGESTION_PAGE_TITLE } from "@/lib/constants/suggestions";

/**
 * 功能建议列表取数失败的错误边界。
 *
 * 之前这里没有局部错误边界：`/suggestions?mockError=1` 会落到**应用级**错误页
 * （HTTP 500 + 白屏），与其他二级列表页的表现不一致——同样是「列表没取到」，
 * 优惠券、评价、鸡腿记录都给的是「页面还在 + 加载失败 + 重试」。
 *
 * 本文件把这一档补齐：顶部返回照常（不把人困在错误页上），正文位置给出错误说明与重试，
 * 二级页面因此仍然没有底部 TabBar。**不改动意见反馈的数据模型与正常提交流程**：
 * 这里只处理「列表这一屏取数失败」，`/suggestions/new` 的表单链路完全不受影响。
 *
 * 与 `/rights` 等页面一样，本文件依赖同段的 `loading.tsx`：没有那层 Suspense 边界，
 * 取数失败会发生在外壳阶段，React 无法恢复，响应直接变成 500（HTTP 冒烟测试实测），
 * 错误边界根本没机会渲染。所以 `loading.tsx` 在这里不是可选项。
 */
export default function SuggestionsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <NavBar title={SUGGESTION_PAGE_TITLE} showBack />
      <ErrorState error={error} reset={reset} />
    </>
  );
}
