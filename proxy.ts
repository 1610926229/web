import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
  isPublicPreviewMethod,
  isPublicPreviewPath,
} from "@/lib/config/publicPreview";

/**
 * 公网只读预览的应用内守卫（Next.js 16 的 `proxy` 文件约定）。
 *
 * ## 它只在「公网请求」上生效
 *
 * 判据是 Nginx 覆盖写入的 `X-Chaoge-Public-Preview: 1`。没有这个头的请求
 * （SSH 隧道直连 `127.0.0.1:3000`、本地开发、自动化测试）**完全不受影响**，
 * 管理端、客服端、打手端、Mock 登录与模拟支付照常可用。
 *
 * ## 为什么不能只靠 Nginx
 *
 * Staging 的公网访问与私有验收访问进入**同一个进程**，来源地址都是回环，
 * 进程无法用 IP 区分。Nginx 的路径白名单是主防线，但一份被改松的配置、
 * 一条新加的反代 location、或未来换一个前置代理，都会让请求直接落到路由。
 * 因此应用层再按同一份白名单判一次：**两层同时失效才会暴露 Mock 权限**。
 *
 * ## Cookie 也必须清掉
 *
 * 公网访客可以手工写任意 `mock_user_id` / `mock_admin_id` / `mock_staff_id`
 * Cookie。即使路径白名单正确，SSR 页面仍会读会话。Nginx 已经用
 * `proxy_set_header Cookie ""` 清过一次；这里再删一次，确保「公网请求 =
 * 无身份」不依赖前置代理的配置细节。
 *
 * ## 静态资源
 *
 * `matcher` 排除 `/_next/static`、`/_next/image`、`/mock/` 与 `favicon.ico`。
 * 它们不含会话判断，由 Next 直接返回；把它们排除也避免给每个 JS/CSS 请求
 * 增加一次代理函数调用。
 */
export function proxy(request: NextRequest) {
  if (
    request.headers.get(PUBLIC_PREVIEW_HEADER) !== PUBLIC_PREVIEW_HEADER_VALUE
  ) {
    return NextResponse.next();
  }

  if (!isPublicPreviewMethod(request.method)) {
    return NextResponse.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "公网预览只允许浏览" } },
      { status: 405, headers: { allow: "GET, HEAD" } },
    );
  }

  if (!isPublicPreviewPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "页面不存在" } },
      { status: 404 },
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|mock/|favicon.ico).*)"],
};
