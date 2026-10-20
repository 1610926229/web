/**
 * 公网访问策略 · PROD-6
 *
 * 守三件事：
 *
 * 1. 公网只到「登录页 + 工作台 + 必要登录 API + 原只读预览」，
 *    Mock / 调试 / 模拟支付即使落在已放行前缀里也必须拒绝；
 * 2. 公网非安全方法必须同源（CSRF）；
 * 3. 登录失败限流按身份与 IP 双维度生效，且成功只清身份计数。
 *
 * 纯单元测试：不启动服务器、不连数据库。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isDeniedPublicPath,
  isPublicAccessMethod,
  isPublicAccessPath,
  isPublicLoginOrConsolePage,
  isPublicStaffAdminApi,
  isPublicUserAuthApi,
  isSameOriginPublicRequest,
  publicClientIp,
  shouldStripPublicCookies,
} from "../lib/config/publicAccess.ts";
import { publicPreviewSafeHref } from "../lib/config/publicPreview.ts";
import {
  LOGIN_RATE_LIMIT_WINDOW_MS,
  checkLoginRateLimit,
  clearLoginIdentityFailures,
  noteLoginFailure,
  resetLoginRateLimitStore,
} from "../lib/auth/loginRateLimit.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

// ── 1. 路径矩阵 ───────────────────────────────────────────────────────────────

test("公网放行登录页、两端工作台与用户微信入口", () => {
  for (const pathname of [
    "/staff/login",
    "/staff/login/",
    "/admin/login",
    "/admin/login/",
    "/staff",
    "/admin",
    "/staff/orders",
    "/staff/orders/",
    "/admin/dashboard",
    "/admin/orders/o-1",
  ]) {
    assert.equal(isPublicAccessPath(pathname), true, `应放行 ${pathname}`);
  }

  for (const pathname of ["/wechat-login", "/mine", "/api/me"]) {
    assert.equal(isPublicAccessPath(pathname), true, `应放行 ${pathname}`);
  }

  assert.equal(isPublicLoginOrConsolePage("/staff/orders"), true);
  assert.equal(isPublicLoginOrConsolePage("/admin"), true);
  assert.equal(isPublicLoginOrConsolePage("/mine"), true);
  assert.equal(isPublicLoginOrConsolePage("/orders"), false);
});

test("公网放行必要的登录 / OAuth 接口", () => {
  for (const pathname of [
    "/api/auth/wechat/status",
    "/api/auth/wechat/start",
    "/api/auth/wechat/callback",
    "/api/auth/logout",
    "/api/staff/auth/login",
    "/api/staff/auth/logout",
    "/api/admin/auth/login",
    "/api/admin/auth/logout",
    "/api/staff/orders",
    "/api/admin/dashboard",
  ]) {
    assert.equal(isPublicAccessPath(pathname), true, `应放行 ${pathname}`);
  }

  assert.equal(isPublicUserAuthApi("/api/auth/logout"), true);
  assert.equal(isPublicUserAuthApi("/api/auth/login"), false);
  assert.equal(isPublicStaffAdminApi("/api/staff/orders"), true);
  assert.equal(isPublicStaffAdminApi("/api/companion/orders"), false);
});

test("公网拒绝 Mock 登录、Mock 支付与调试接口（即使在前缀内）", () => {
  for (const pathname of [
    "/api/auth/mock-login",
    "/api/staff/auth/mock-login",
    "/api/admin/auth/mock-login",
    "/api/auth/wechat/mock/complete",
    "/api/payments/mock-confirm",
    "/api/debug/reset",
    "/api/debug/anything",
    "/wechat-mock",
  ]) {
    assert.equal(isDeniedPublicPath(pathname), true, `必须标记拒绝 ${pathname}`);
    assert.equal(isPublicAccessPath(pathname), false, `必须拒绝 ${pathname}`);
  }

  // Mock 路径即使落在 /api/staff/ 前缀里也不能被前缀规则放行。
  assert.equal(isPublicStaffAdminApi("/api/staff/auth/mock-login"), true);
  assert.equal(isPublicAccessPath("/api/staff/auth/mock-login"), false);
});

test("公网导航保留登录入口，交易面仍改写到占位页", () => {
  for (const [href, label] of [
    ["/mine", "我的"],
    ["/staff/login", "客服登录"],
    ["/admin/login", "管理员登录"],
    ["/wechat-login", "微信登录"],
  ]) {
    assert.equal(
      publicPreviewSafeHref(href, label, isPublicAccessPath),
      href,
      `登录入口 ${href} 不应被改写到占位页`,
    );
  }

  for (const [href, label] of [
    ["/orders", "订单"],
    ["/service", "客服"],
    ["/checkout", "结算"],
    ["/companion", "打手工作台"],
  ]) {
    const rewritten = publicPreviewSafeHref(href, label, isPublicAccessPath);
    assert.match(rewritten, /^\/placeholder\?/, `${href} 应改写为占位页`);
  }
});

test("公网拒绝其余用户交易面与后台路径", () => {
  for (const pathname of [
    "/api/orders",
    "/api/orders/pay",
    "/api/payments/wechat/notify",
    "/api/companion/orders",
    "/api/service/conversations",
    "/api/favorites",
    "/api/coupons",
    "/api/refunds/1",
    "/api/auth/login",
    "/api/tips",
    "/orders",
    "/checkout",
    "/pay/result",
    "/companion",
    "/service",
    "/adminx",
    "/staffx",
  ]) {
    assert.equal(isPublicAccessPath(pathname), false, `必须拒绝 ${pathname}`);
  }
});

// ── 2. 方法矩阵 ───────────────────────────────────────────────────────────────

test("公开只读页面与 API 仍只允许 GET / HEAD", () => {
  for (const pathname of ["/", "/product/p-1", "/api/home"]) {
    assert.equal(isPublicAccessMethod(pathname, "GET"), true);
    assert.equal(isPublicAccessMethod(pathname, "HEAD"), true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.equal(isPublicAccessMethod(pathname, method), false, `${pathname} 必须拒绝 ${method}`);
    }
  }
});

test("登录 / 退出只允许 POST，工作台页面只允许 GET / HEAD", () => {
  for (const pathname of [
    "/api/staff/auth/login",
    "/api/staff/auth/logout",
    "/api/admin/auth/login",
    "/api/admin/auth/logout",
    "/api/auth/logout",
  ]) {
    assert.equal(isPublicAccessMethod(pathname, "POST"), true, `${pathname} 应允许 POST`);
    assert.equal(isPublicAccessMethod(pathname, "GET"), false, `${pathname} 不应允许 GET`);
  }

  for (const pathname of ["/staff", "/staff/login", "/admin", "/admin/login", "/mine"]) {
    assert.equal(isPublicAccessMethod(pathname, "GET"), true);
    assert.equal(isPublicAccessMethod(pathname, "HEAD"), true);
    assert.equal(isPublicAccessMethod(pathname, "POST"), false, `${pathname} 不应允许 POST`);
  }
});

test("工作台 API 允许标准读写方法，但不允许 OPTIONS / TRACE", () => {
  for (const method of ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]) {
    assert.equal(isPublicAccessMethod("/api/staff/orders", method), true, `应允许 ${method}`);
    assert.equal(isPublicAccessMethod("/api/admin/orders", method), true, `应允许 ${method}`);
  }
  for (const method of ["OPTIONS", "TRACE", "CONNECT"]) {
    assert.equal(isPublicAccessMethod("/api/staff/orders", method), false, `必须拒绝 ${method}`);
  }
});

test("用户登录相关 API 只允许读取", () => {
  for (const pathname of ["/api/me", "/api/auth/wechat/status", "/api/auth/wechat/start", "/api/auth/wechat/callback"]) {
    assert.equal(isPublicAccessMethod(pathname, "GET"), true);
    assert.equal(isPublicAccessMethod(pathname, "POST"), false, `${pathname} 不应允许 POST`);
  }
});

// ── 3. Cookie 清空范围 ────────────────────────────────────────────────────────

test("只读预览清 Cookie，登录 / 工作台保留会话 Cookie", () => {
  for (const pathname of ["/", "/category", "/product/p-1", "/api/home", "/api/companions"]) {
    assert.equal(shouldStripPublicCookies(pathname), true, `${pathname} 应清空 Cookie`);
  }
  for (const pathname of [
    "/staff/login",
    "/staff",
    "/staff/orders",
    "/admin/login",
    "/admin",
    "/admin/dashboard",
    "/wechat-login",
    "/mine",
    "/api/me",
    "/api/auth/logout",
    "/api/auth/wechat/status",
    "/api/staff/auth/login",
    "/api/admin/dashboard",
  ]) {
    assert.equal(shouldStripPublicCookies(pathname), false, `${pathname} 必须保留 Cookie`);
  }
});

// ── 4. CSRF 同源校验 ──────────────────────────────────────────────────────────

function headersOf(entries) {
  return new Headers(entries);
}

test("CSRF：安全方法不要求 Origin", () => {
  for (const method of ["GET", "HEAD"]) {
    assert.equal(isSameOriginPublicRequest(headersOf({ host: "example.com" }), method), true);
  }
});

test("CSRF：同源 Origin / Referer 放行", () => {
  const origin = headersOf({
    host: "example.com",
    origin: "https://example.com",
    "x-forwarded-proto": "https",
  });
  assert.equal(isSameOriginPublicRequest(origin, "POST"), true);

  const referer = headersOf({
    "x-forwarded-host": "example.com",
    referer: "https://example.com/staff/login",
    "x-forwarded-proto": "https",
  });
  assert.equal(isSameOriginPublicRequest(referer, "POST"), true);
});

test("CSRF：跨站、缺失、主机或协议不一致一律拒绝", () => {
  const cases = [
    // Sec-Fetch-Site 明确跨站
    headersOf({
      host: "example.com",
      origin: "https://example.com",
      "sec-fetch-site": "cross-site",
    }),
    // 没有 Origin 也没有 Referer
    headersOf({ host: "example.com" }),
    // Origin: null（沙箱 iframe / 某些重定向）
    headersOf({ host: "example.com", origin: "null" }),
    // 主机不同
    headersOf({ host: "example.com", origin: "https://evil.example" }),
    // 协议不同（HTTP 降级 / 混用）
    headersOf({
      host: "example.com",
      origin: "http://example.com",
      "x-forwarded-proto": "https",
    }),
    // 没有 Host，无法判断同源
    headersOf({ origin: "https://example.com" }),
    // 非法 Origin
    headersOf({ host: "example.com", origin: "not a url" }),
  ];

  for (const [index, headers] of cases.entries()) {
    assert.equal(
      isSameOriginPublicRequest(headers, "POST"),
      false,
      `第 ${index + 1} 个跨站/异常请求必须拒绝`,
    );
  }
});

test("CSRF：X-Forwarded-Host 优先于 Host", () => {
  const headers = headersOf({
    host: "127.0.0.1:3000",
    "x-forwarded-host": "chaoge.example",
    origin: "https://chaoge.example",
    "x-forwarded-proto": "https",
  });
  assert.equal(isSameOriginPublicRequest(headers, "PATCH"), true);
});

// ── 5. 客户端 IP ──────────────────────────────────────────────────────────────

test("客户端 IP 取 X-Forwarded-For 第一段，其次 X-Real-IP", () => {
  assert.equal(
    publicClientIp(headersOf({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    "203.0.113.7",
  );
  assert.equal(publicClientIp(headersOf({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(publicClientIp(headersOf({})), "unknown");
});

// ── 6. 登录失败限流 ───────────────────────────────────────────────────────────

test("同一身份 5 次失败后限流，15 分钟窗口内不得登录", () => {
  resetLoginRateLimitStore();
  const now = 1_000_000;
  const ip = "203.0.113.7";
  const username = "kefu-test";

  for (let i = 0; i < 4; i += 1) {
    assert.equal(checkLoginRateLimit("staff", ip, username, now).allowed, true);
    noteLoginFailure("staff", ip, username, now);
  }

  const fifth = checkLoginRateLimit("staff", ip, username, now);
  assert.equal(fifth.allowed, true, "第 5 次尝试仍应被允许（前 4 次失败）");

  noteLoginFailure("staff", ip, username, now);

  const limited = checkLoginRateLimit("staff", ip, username, now);
  assert.equal(limited.allowed, false);
  assert.equal(limited.limitedBy, "identity");
  assert.ok(limited.retryAfterSeconds > 0 && limited.retryAfterSeconds <= 900);

  // 窗口未过期仍限流
  assert.equal(
    checkLoginRateLimit("staff", ip, username, now + LOGIN_RATE_LIMIT_WINDOW_MS - 1).allowed,
    false,
  );

  // 窗口过期后恢复
  assert.equal(
    checkLoginRateLimit("staff", ip, username, now + LOGIN_RATE_LIMIT_WINDOW_MS).allowed,
    true,
  );
});

test("登录名大小写与首尾空格共享同一身份额度", () => {
  resetLoginRateLimitStore();
  const now = 2_000_000;
  for (let i = 0; i < 5; i += 1) {
    noteLoginFailure("admin", "198.51.100.1", i === 0 ? " Admin " : "ADMIN", now);
  }
  assert.equal(checkLoginRateLimit("admin", "198.51.100.1", "admin", now).allowed, false);
});

test("同一 IP 跨不同登录名累计 20 次失败后限流", () => {
  resetLoginRateLimitStore();
  const now = 3_000_000;
  const ip = "198.51.100.2";

  for (let i = 0; i < 20; i += 1) {
    const decision = checkLoginRateLimit("admin", ip, `user-${i}`, now);
    assert.equal(decision.allowed, true, `第 ${i + 1} 次尝试不应提前限流`);
    noteLoginFailure("admin", ip, `user-${i}`, now);
  }

  const limited = checkLoginRateLimit("admin", ip, "another-user", now);
  assert.equal(limited.allowed, false);
  assert.equal(limited.limitedBy, "ip");
});

test("成功登录清身份计数，但不清 IP 计数", () => {
  resetLoginRateLimitStore();
  const now = 4_000_000;
  const ip = "198.51.100.3";

  for (let i = 0; i < 5; i += 1) {
    noteLoginFailure("staff", ip, "kefu-a", now);
  }
  assert.equal(checkLoginRateLimit("staff", ip, "kefu-a", now).allowed, false);

  clearLoginIdentityFailures("staff", "kefu-a");
  assert.equal(checkLoginRateLimit("staff", ip, "kefu-a", now).allowed, true);

  // IP 维度仍有 5 次失败；补到 20 次后，即使是清过计数的账号也被挡住。
  for (let i = 0; i < 15; i += 1) {
    noteLoginFailure("staff", ip, `kefu-${i}`, now);
  }
  assert.equal(checkLoginRateLimit("staff", ip, "kefu-a", now).allowed, false);
});

test("客服与管理员的限流额度互不影响", () => {
  resetLoginRateLimitStore();
  const now = 5_000_000;
  const ip = "198.51.100.4";

  for (let i = 0; i < 20; i += 1) {
    noteLoginFailure("staff", ip, `user-${i}`, now);
  }

  assert.equal(checkLoginRateLimit("staff", ip, "new-user", now).allowed, false);
  assert.equal(checkLoginRateLimit("admin", ip, "new-user", now).allowed, true);
});

// ── 7. 接线静态检查 ───────────────────────────────────────────────────────────

test("proxy.ts 接入公网访问策略与 CSRF 校验", () => {
  const proxy = read("proxy.ts");
  assert.ok(proxy.includes("isPublicAccessPath(pathname)"));
  assert.ok(proxy.includes("isPublicAccessMethod(pathname, request.method)"));
  assert.ok(proxy.includes("isSameOriginPublicRequest(request.headers, request.method)"));
  assert.ok(proxy.includes("shouldStripPublicCookies(pathname)"));
  assert.ok(
    proxy.indexOf("isSameOriginPublicRequest") <
      proxy.indexOf("NextResponse.next({ request: { headers } })"),
    "CSRF 校验必须在放行之前",
  );
});

test("客服 / 管理员登录路由接入公网失败限流", () => {
  for (const route of [
    "app/api/staff/auth/login/route.ts",
    "app/api/admin/auth/login/route.ts",
  ]) {
    const source = read(route);
    assert.ok(source.includes("beginPublicLogin"), `${route} 必须接入限流`);
    assert.ok(source.includes("guard.succeeded()"), `${route} 成功必须清身份计数`);
    assert.ok(source.includes("guard.failed(cause)"), `${route} 失败必须记账`);
    assert.ok(
      source.indexOf("beginPublicLogin") < source.indexOf("loginStaffWithPassword") ||
        source.indexOf("beginPublicLogin") < source.indexOf("loginAdminWithPassword"),
      `${route} 必须先查额度再校验密码`,
    );
  }
});

test("公网登录拦截只展示微信入口，不展示邮箱密码 / 注册 / Mock", () => {
  const gate = read("lib/auth/LoginGate.tsx");
  assert.ok(gate.includes("publicRequest?: boolean"));
  assert.match(
    gate,
    /publicRequest\s*\?\s*\([\s\S]*?<WechatLoginButton \/>/,
    "公网分支必须渲染微信入口",
  );
  assert.ok(
    gate.indexOf("{publicRequest ?") < gate.indexOf(") : realAuthEnabled ?"),
    "公网分支必须先于真实邮箱密码表单",
  );

  const requireAuth = read("lib/auth/RequireAuth.tsx");
  assert.match(requireAuth, /isPublicPreviewRequest\(\)/);
  assert.match(requireAuth, /mockAuthEnabled=\{isMockAuthEnabled\(\) && !publicRequest\}/);
  assert.match(requireAuth, /realAuthEnabled=\{isRealAuthEnabled\(\) && !publicRequest\}/);

  // 微信登录失败页的「返回登录」必须落在公网可达的 /mine，而不是被拒绝的 /orders。
  const resultPage = read("app/(mobile)/wechat-login/page.tsx");
  assert.match(resultPage, /href="\/mine"/);
});

test("公网微信状态接口强制隐藏 Mock 可用性", () => {
  const source = read("app/api/auth/wechat/status/route.ts");
  assert.match(source, /isPublicPreviewRequest\(\)/);
  assert.match(source, /mockAvailable:\s*publicRequest\s*\?\s*false\s*:\s*status\.mockAvailable/);
});

test("TOO_MANY_REQUESTS 进入统一错误码与 429 映射", () => {
  const types = read("lib/types/common.ts");
  assert.ok(types.includes('"TOO_MANY_REQUESTS"'));

  const apiError = read("lib/api/ApiError.ts");
  assert.match(apiError, /TOO_MANY_REQUESTS:\s*429/);
  assert.match(apiError, /retryAfterSeconds/);

  const route = read("lib/api/route.ts");
  assert.match(route, /retry-after/);
});
