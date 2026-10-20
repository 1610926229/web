/**
 * 公网访问策略（PROD-6）。
 *
 * ## 与 `publicPreview.ts` 的关系
 *
 * `publicPreview.ts` 定义的是**匿名只读预览**：公开页面 + 6 个只读 API。
 * 本文件在它之上增加**登录入口与工作台**，同时保持“只读预览”的原有语义不变：
 *
 * | 路径 | 方法 | Cookie | 鉴权 |
 * |---|---|---|---|
 * | 公开只读页面 / API | GET / HEAD | 清空 | 无 |
 * | `/staff/login`、`/admin/login`、`/wechat-login`、`/mine` | GET / HEAD | 保留 | 页面自身处理 |
 * | `/staff/**`、`/admin/**` | GET / HEAD | 保留 | 服务端布局 / Guard |
 * | `/api/staff/**`、`/api/admin/**` | 标准方法 | 保留 | `requireStaff` / `requireAdmin` |
 * | `/api/auth/wechat/{status,start,callback}` | GET / HEAD | 保留 | OAuth state |
 * | `/api/auth/logout` | POST | 保留 | 会话 |
 *
 * ## 明确拒绝
 *
 * Mock 与调试能力**不因为落在已放行前缀里就可用**。本文件先判拒绝清单，
 * 再判放行清单；Nginx 模板也有同样的显式 404。
 *
 * ## 不是权限判断
 *
 * 登录后的操作能不能做，仍由服务端会话与 `requireStaff()` / `requireAdmin()` /
 * `requireUser()` 决定。本文件只回答“公网请求能不能到达这个路由”。
 */

import {
  isPublicPreviewMethod,
  isPublicPreviewPath,
  normalizePublicPreviewPath,
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
} from "./publicPreview";

/** 登录页面（匿名可达）。 */
const LOGIN_PAGE_EXACT: readonly string[] = ["/staff/login", "/admin/login", "/wechat-login"];

/** 普通用户登录入口；页面内部再决定是否显示登录拦截。 */
const USER_LOGIN_PAGE_EXACT: readonly string[] = ["/mine"];

/** 两端工作台根路径（其余子路径走前缀）。 */
const CONSOLE_EXACT: readonly string[] = ["/staff", "/admin"];

/** 两端工作台前缀。 */
const CONSOLE_PREFIXES: readonly string[] = ["/staff/", "/admin/"];

/** 用户登录相关 API：只允许与建立 / 结束身份直接相关的那几个。 */
const USER_AUTH_API_EXACT: readonly string[] = [
  "/api/me",
  "/api/auth/logout",
  "/api/auth/wechat/status",
  "/api/auth/wechat/start",
  "/api/auth/wechat/callback",
];

/** 客服 / 管理端 API 前缀；每个接口内部仍必须调用各自的 Guard。 */
const STAFF_ADMIN_API_PREFIXES: readonly string[] = ["/api/staff/", "/api/admin/"];

/** 公网永不开放的 Mock / 调试路径（精确）。 */
const DENIED_EXACT: readonly string[] = [
  "/wechat-mock",
  "/api/auth/mock-login",
  "/api/auth/wechat/mock/complete",
  "/api/staff/auth/mock-login",
  "/api/admin/auth/mock-login",
  "/api/payments/mock-confirm",
  "/api/debug/reset",
];

/** 公网永不开放的 Mock / 调试路径（前缀）。 */
const DENIED_PREFIXES: readonly string[] = ["/api/debug/"];

/** 是否是公网请求（由 Nginx 覆盖写入标记头）。 */
export function isPublicAccessRequest(headers: Headers): boolean {
  return headers.get(PUBLIC_PREVIEW_HEADER) === PUBLIC_PREVIEW_HEADER_VALUE;
}

/** 是否明确禁止公网访问。 */
export function isDeniedPublicPath(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);
  return (
    DENIED_EXACT.includes(normalized) ||
    DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/** 是否登录 / 工作台页面。这些路径需要保留 Cookie。 */
export function isPublicLoginOrConsolePage(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);
  if (LOGIN_PAGE_EXACT.includes(normalized)) return true;
  if (USER_LOGIN_PAGE_EXACT.includes(normalized)) return true;
  if (CONSOLE_EXACT.includes(normalized)) return true;
  return CONSOLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** 是否用户登录相关 API。 */
export function isPublicUserAuthApi(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);
  return USER_AUTH_API_EXACT.includes(normalized);
}

/** 是否客服 / 管理端 API。 */
export function isPublicStaffAdminApi(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);
  return STAFF_ADMIN_API_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 公网请求是否可以到达该路径。
 *
 * 拒绝清单优先：`/api/staff/auth/mock-login` 虽然命中 `/api/staff/` 前缀，
 * 也必须拒绝。
 */
export function isPublicAccessPath(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);

  if (isDeniedPublicPath(normalized)) return false;
  if (isPublicPreviewPath(normalized)) return true;
  if (isPublicLoginOrConsolePage(normalized)) return true;
  if (isPublicUserAuthApi(normalized)) return true;
  if (isPublicStaffAdminApi(normalized)) return true;

  return false;
}

/**
 * 公网请求的方法是否允许。
 *
 * 读路径只允许 GET/HEAD；登录 / 退出只允许 POST；客服 / 管理端 API 允许
 * 标准读写方法（真正的权限仍由各接口 Guard 判定）。
 */
export function isPublicAccessMethod(pathname: string, method: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);
  const upper = method.toUpperCase();

  if (isDeniedPublicPath(normalized)) return false;

  if (isPublicPreviewPath(normalized)) {
    return isPublicPreviewMethod(upper);
  }

  if (isPublicLoginOrConsolePage(normalized)) {
    return upper === "GET" || upper === "HEAD";
  }

  if (normalized === "/api/me") {
    return upper === "GET" || upper === "HEAD";
  }

  if (
    normalized === "/api/auth/wechat/status" ||
    normalized === "/api/auth/wechat/start" ||
    normalized === "/api/auth/wechat/callback"
  ) {
    return upper === "GET" || upper === "HEAD";
  }

  if (
    normalized === "/api/auth/logout" ||
    normalized === "/api/staff/auth/login" ||
    normalized === "/api/staff/auth/logout" ||
    normalized === "/api/admin/auth/login" ||
    normalized === "/api/admin/auth/logout"
  ) {
    return upper === "POST";
  }

  if (isPublicStaffAdminApi(normalized)) {
    return ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"].includes(upper);
  }

  return false;
}

/**
 * 公网请求是否应该清空 Cookie。
 *
 * 只读预览继续匿名；登录 / 工作台 / 用户登录入口需要会话，必须保留。
 */
export function shouldStripPublicCookies(pathname: string): boolean {
  return isPublicPreviewPath(normalizePublicPreviewPath(pathname));
}

/**
 * 从代理头解析客户端 IP；仅用于应用层限流，Nginx 限流不依赖它。
 *
 * ⚠️ **只信任最靠近应用的那一跳**：
 *
 * - `X-Real-IP` 由 Nginx 用 `$remote_addr` 覆盖写入，客户端无法伪造，优先使用；
 * - `X-Forwarded-For` 退而取**最后一段**。客户端可以随意在请求里自带一段
 *   `X-Forwarded-For: 1.2.3.4`，现有公网配置又用 `$proxy_add_x_forwarded_for`
 *   追加真实地址——第一段完全由客户端控制，拿它当限流 IP 等于没有限流。
 *   最后一段是最近一跳代理写入的地址；新的 HTTPS 模板则直接把整条头覆盖成
 *   `$remote_addr`，两种配置下都正确。
 *
 * 取不到任何可信地址时返回 `"unknown"`，限流仍会按这个桶生效。
 */
export function publicClientIp(headers: Headers): string {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const trusted = parts[parts.length - 1];
    if (trusted) return trusted;
  }

  return "unknown";
}

/** Mock 身份 Cookie 的公共前缀；它们只属于私有验收环境，公网一律丢弃。 */
const MOCK_IDENTITY_COOKIE_PREFIX = "mock_";

/**
 * 从 `Cookie` 头中删除所有 `mock_*` 身份 Cookie，保留真实会话 Cookie。
 *
 * 公网登录 / 工作台需要保留 `chaoge_*_session`，但 Mock 身份 Cookie 没有签名、
 * 没有凭据，任何人手工写一个 `mock_admin_id=admin-1` 就能冒充账号。
 * `proxy.ts` 在公网请求进入应用前统一剥掉它们，作为 `getSession*()` 内部
 * 「公网不吃 Mock」之外的第二道防线。
 *
 * 私有 Staging / 本地开发不带公网标记头，不走这条路径，Mock 登录照常可用。
 */
export function stripMockIdentityCookies(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = part.slice(0, part.indexOf("=") === -1 ? part.length : part.indexOf("="));
      return !name.trim().startsWith(MOCK_IDENTITY_COOKIE_PREFIX);
    })
    .join("; ");
}

function safeMethod(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === "GET" || upper === "HEAD";
}

/**
 * 公网非安全方法必须同源。
 *
 * 攻击者可以让受害者浏览器向本站发起跨站 POST（登录 CSRF、退出 CSRF、
 * 工作台写操作的 CSRF）。`SameSite=Lax` 已经挡住跨站 POST 的 Cookie，
 * 这里再显式核对 Origin / Referer，避免把浏览器版本差异当成唯一防线。
 *
 * 判据：
 * - 安全方法直接通过；
 * - 有 `Sec-Fetch-Site: cross-site` 直接拒绝；
 * - Origin 优先，其次 Referer；二者都没有则拒绝；
 * - Origin 的 host 必须与 `X-Forwarded-Host` / `Host` 一致；
 * - 若 `X-Forwarded-Proto` 存在，协议也必须一致。
 */
export function isSameOriginPublicRequest(headers: Headers, method: string): boolean {
  if (safeMethod(method)) return true;

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const originHeader = headers.get("origin");
  const refererHeader = headers.get("referer");
  const originValue =
    originHeader && originHeader !== "null"
      ? originHeader
      : refererHeader
        ? originFromReferer(refererHeader)
        : null;

  if (!originValue) return false;

  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    return false;
  }

  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;

  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return false;
  if (origin.host !== host) return false;

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto && `${origin.protocol.slice(0, -1)}` !== forwardedProto) return false;

  return true;
}

function originFromReferer(referer: string): string | null {
  try {
    const url = new URL(referer);
    return url.origin;
  } catch {
    return null;
  }
}
