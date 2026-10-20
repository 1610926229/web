import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
  isPublicPreviewMethod,
  isPublicPreviewPath,
} from "@/lib/config/publicPreview";
import {
  isPublicAccessMethod,
  isPublicAccessPath,
  isSameOriginPublicRequest,
  shouldStripPublicCookies,
  stripMockIdentityCookies,
} from "@/lib/config/publicAccess";

/**
 * 公网访问的应用内守卫（Next.js 16 的 `proxy` 文件约定）。
 *
 * ## 它只在「公网请求」上生效
 *
 * 判据是 Nginx 覆盖写入的 `X-Chaoge-Public-Preview: 1`。没有这个头的请求
 * （SSH 隧道直连 `127.0.0.1:3000`、本地开发、自动化测试）**完全不受影响**，
 * 管理端、客服端、打手端、Mock 登录与模拟支付照常可用。
 *
 * ## 两层白名单
 *
 * - `publicPreview.ts`：匿名只读预览（公开页面 + 6 个只读 API）；
 * - `publicAccess.ts`：在预览之上增加登录页、客服 / 管理端工作台与其 API、
 *   用户微信登录入口，并显式拒绝 Mock / 调试 / 模拟支付路径。
 *
 * 路径与方法都必须命中；任何一层单独失效都不足以把危险能力暴露到公网。
 *
 * ## Cookie 不是一律清除
 *
 * 只读预览继续 `Cookie ""`（Nginx）与应用内删除，保持「公网访客 = 无身份」。
 * 登录页、工作台、用户登录入口必须保留 Cookie，否则登录永远无法建立会话。
 * Nginx 对这些 location 使用 `proxy_set_header Cookie $http_cookie;`，
 * 应用层按路径决定删不删。
 *
 * ## CSRF
 *
 * 公网非安全方法必须同源（Origin / Referer 与 Host 一致），
 * `Sec-Fetch-Site: cross-site` 直接拒绝。SameSite=Lax 仍是第二道。
 *
 * ## 静态资源
 *
 * `matcher` 排除 `/_next/static`、`/_next/image`、`/mock/` 与 `favicon.ico`。
 */
export function proxy(request: NextRequest) {
  if (
    request.headers.get(PUBLIC_PREVIEW_HEADER) !== PUBLIC_PREVIEW_HEADER_VALUE
  ) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;

  if (!isPublicAccessPath(pathname)) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "页面不存在" } },
      { status: 404 },
    );
  }

  // 只读预览沿用原来的方法规则：只允许 GET / HEAD。
  // 登录 / 工作台 / 用户登录 API 的方法规则见 isPublicAccessMethod()。
  const previewPath = isPublicPreviewPath(request.nextUrl.pathname);
  if (!isPublicPreviewMethod(request.method) && previewPath) {
    return NextResponse.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "公网预览只允许浏览" } },
      { status: 405, headers: { allow: "GET, HEAD" } },
    );
  }

  if (!isPublicAccessMethod(pathname, request.method)) {
    return NextResponse.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "不支持该公网请求方法" } },
      { status: 405, headers: { allow: "GET, HEAD, POST" } },
    );
  }

  if (!isSameOriginPublicRequest(request.headers, request.method)) {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "跨站请求被拒绝" } },
      { status: 403 },
    );
  }

  const headers = new Headers(request.headers);

  if (shouldStripPublicCookies(pathname)) {
    headers.delete("cookie");
    headers.delete("authorization");
  } else {
    // 登录 / 工作台需要保留真实会话 Cookie，但 Mock 身份 Cookie 一律不进应用。
    // Mock 开关在 Staging 默认开启，且 `mock_*` 没有签名——公网携带
    // `mock_admin_id=admin-1` 就等价于冒充管理员。这里先剥掉，再由
    // `getSession*()` 内部的「公网不吃 Mock」兜底。
    const cookie = headers.get("cookie");
    if (cookie) {
      const stripped = stripMockIdentityCookies(cookie);
      if (stripped) headers.set("cookie", stripped);
      else headers.delete("cookie");
    }
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|mock/|favicon.ico).*)"],
};
