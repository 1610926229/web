import { cache } from "react";
import { headers } from "next/headers";
import {
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
} from "@/lib/config/publicPreview";

/**
 * 当前请求是否来自公网只读预览（仅服务端使用）。
 *
 * 判据与 `proxy.ts` 完全相同：Nginx 覆盖写入的标记头。用于**不渲染**只在
 * 私有验收环境有意义的控件（Mock 身份切换面板、模拟登录按钮），
 * 让公网访客看到的是一个干净的只读站点，而不是一堆点了会 405 的开发工具。
 *
 * ⚠️ 这不是权限判断。真正的权限拒绝在 `proxy.ts`（路径/方法白名单）与
 * Nginx 两层；本函数只决定「要不要展示开发工具」。任何人伪造这个头只会
 * 让自己少看到两个按钮，不会多拿到任何能力。
 *
 * 用 `React.cache` 包起来：一次渲染里布局与页面可能各问一次，读一份就够。
 */
export const isPublicPreviewRequest = cache(async function isPublicPreviewRequest(): Promise<boolean> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get(PUBLIC_PREVIEW_HEADER) === PUBLIC_PREVIEW_HEADER_VALUE
  );
});
