/**
 * 公网只读预览 · 应用守卫与 Nginx 配置的安全回归
 *
 * ## 守的是什么
 *
 * Staging 的公网请求与 SSH 隧道请求进入**同一个 Next.js 进程**。只要有一层
 * 白名单写松，公网访客就可能：
 *
 *   · POST `/api/auth/mock-login` 切换成任意 Mock 身份；
 *   · POST `/api/admin/auth/mock-login` 进入管理端；
 *   · POST `/api/payments/mock-confirm` 伪造支付；
 *   · 直接读写订单/退款/客服会话；
 *   · 伪造 `mock_user_id` / `mock_admin_id` Cookie 让 SSR 页面以别的身份渲染。
 *
 * 因此这里同时断言两层：
 *
 * 1. `lib/config/publicPreview.ts` 的路径/方法白名单；
 * 2. Nginx 配置只代理公开路径、清 Cookie、注入公网标记头，并且有兜底 404。
 *
 * ## 运行方式
 *
 *     pnpm test
 *
 * 纯静态：不安装 nginx、不连服务器、不读任何凭据。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
  isPublicPreviewMethod,
  isPublicPreviewPath,
  normalizePublicPreviewPath,
} from "../lib/config/publicPreview.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

const proxy = read("proxy.ts");
const nginx = read("deploy/proxy/chaoge-public.conf");
const installer = read("deploy/proxy/install-public-proxy.sh");
const rollback = read("deploy/proxy/rollback-public-proxy.sh");

/** 去掉整行注释：注释里会提到被禁止的命令名与路径，不能作为「执行了」的证据。 */
function stripHashComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const nginxCode = stripHashComments(nginx);
const installerCode = stripHashComments(installer);
const rollbackCode = stripHashComments(rollback);

function bashSyntaxOk(file) {
  const result = spawnSync("bash", ["-n", path.join(REPO_ROOT, file)], {
    encoding: "utf8",
  });
  return result.status === 0;
}

const BASH_OK = (() => {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();
const SKIP_NO_BASH = BASH_OK ? false : "需要 bash（Windows 上由 Git Bash 提供）";

// ── 1. 路径白名单 ─────────────────────────────────────────────────────────────

test("公网预览允许游客可浏览的页面", () => {
  for (const pathname of [
    "/",
    "/category",
    "/category/",
    "/rank",
    "/rank/companions",
    "/rank/companions/",
    "/companions",
    "/companions/",
    "/product/p-400w",
    "/product/p-400w/",
    "/companions/cp-1",
    "/agreements",
    "/activities",
    "/help",
    "/placeholder",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), true, `应放行 ${pathname}`);
  }
});

test("公网预览允许首页/商品/陪玩/协议/榜单的只读接口", () => {
  for (const pathname of [
    "/api/home",
    "/api/home/",
    "/api/catalog/products",
    "/api/companions",
    "/api/agreements",
    "/api/rankings/consumption",
    "/api/rankings/companions",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), true, `应放行 ${pathname}`);
  }
});

test("公网预览拒绝身份切换、管理、客服、打手与 Mock 危险接口", () => {
  for (const pathname of [
    "/api/auth/mock-login",
    "/api/auth/logout",
    "/api/admin/auth/mock-login",
    "/api/admin/auth/session",
    "/api/admin/dashboard",
    "/api/admin/orders",
    "/api/admin/content/announcements",
    "/api/staff/auth/mock-login",
    "/api/staff/orders",
    "/api/companion/orders",
    "/api/debug/reset",
    "/api/payments/mock-confirm",
    "/api/orders/pay",
    "/api/orders/preview",
    "/api/orders",
    "/api/me",
    "/api/favorites",
    "/api/coupons",
    "/api/refunds/1",
    "/api/service/conversations",
    "/api/suggestions",
    "/api/tips",
    "/api/reviews",
    "/api",
    "/api/",
    "/api/unknown",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), false, `必须拒绝 ${pathname}`);
  }
});

test("公网预览拒绝所有需要登录的页面与后台页面", () => {
  for (const pathname of [
    "/admin",
    "/admin/login",
    "/admin/orders",
    "/staff",
    "/staff/login",
    "/companion",
    "/companion/orders",
    "/orders",
    "/orders/o-1",
    "/checkout",
    "/pay/result",
    "/mine",
    "/service",
    "/rights",
    "/coupons",
    "/favorites",
    "/join",
    "/join/status",
    "/reviews",
    "/reviews/new/o-1",
    "/settings",
    "/profile/edit",
    "/complaints",
    "/suggestions",
    "/tips",
    "/login",
    "/logout",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), false, `必须拒绝 ${pathname}`);
  }
});

test("路径前后缀不会被误判为公开", () => {
  for (const pathname of [
    "/productx",
    "/product",
    "/companionsx",
    "/companion",
    "/rankx",
    "/rank/admin",
    "/category/admin",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), false, `必须拒绝 ${pathname}`);
  }

  assert.equal(normalizePublicPreviewPath("/"), "/");
  assert.equal(normalizePublicPreviewPath("/category///"), "/category");
});

test("公网预览只允许 GET / HEAD", () => {
  assert.equal(isPublicPreviewMethod("GET"), true);
  assert.equal(isPublicPreviewMethod("HEAD"), true);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    assert.equal(isPublicPreviewMethod(method), false, `必须拒绝 ${method}`);
  }
});

// ── 2. 应用守卫 ───────────────────────────────────────────────────────────────

test("proxy.ts 只在 Nginx 标记公网请求时生效", () => {
  assert.equal(PUBLIC_PREVIEW_HEADER, "x-chaoge-public-preview");
  assert.equal(PUBLIC_PREVIEW_HEADER_VALUE, "1");
  assert.ok(
    proxy.includes("request.headers.get(PUBLIC_PREVIEW_HEADER)"),
    "必须读取公网标记头",
  );
  assert.ok(
    proxy.indexOf("request.headers.get(PUBLIC_PREVIEW_HEADER)") <
      proxy.indexOf("if (!isPublicPreviewMethod"),
    "标记头判断必须在方法/路径判断之前",
  );
  assert.ok(proxy.includes("isPublicPreviewMethod(request.method)"));
  assert.ok(proxy.includes("isPublicPreviewPath(request.nextUrl.pathname)"));
});

test("proxy.ts 清除公网请求的会话与凭据头", () => {
  assert.ok(proxy.includes('headers.delete("cookie")'));
  assert.ok(proxy.includes('headers.delete("authorization")'));
  assert.ok(
    proxy.indexOf('headers.delete("cookie")') <
      proxy.indexOf("NextResponse.next({ request: { headers } })"),
    "必须先删除 Cookie 再把请求交给路由",
  );
});

test("proxy.ts 不拦截静态资源", () => {
  for (const segment of ["_next/static", "_next/image", "mock/", "favicon.ico"]) {
    assert.ok(proxy.includes(segment), `matcher 必须排除 ${segment}`);
  }
});

// ── 3. Nginx 配置 ─────────────────────────────────────────────────────────────

test("Nginx 只监听 80，不监听 3000/5432", () => {
  assert.match(nginx, /listen\s+80\s+default_server;/);
  assert.doesNotMatch(nginx, /listen\s+(?:\S*:)?3000\b/);
  assert.doesNotMatch(nginx, /listen\s+(?:\S*:)?5432\b/);
  assert.ok(nginx.includes("proxy_pass http://127.0.0.1:3000;"));
  assert.doesNotMatch(nginx, /proxy_pass\s+http:\/\/[^;\s]*5432/);
  assert.doesNotMatch(nginx, /proxy_pass\s+https?:\/\/(?!127\.0\.0\.1:3000)/);
});

test("Nginx 注入公网标记并清空会话 Cookie", () => {
  assert.ok(nginx.includes('proxy_set_header X-Chaoge-Public-Preview "1";'));
  assert.ok(nginx.includes('proxy_set_header Cookie "";'));
  assert.ok(nginx.includes('proxy_set_header Authorization "";'));
  assert.ok(nginx.includes("proxy_hide_header X-Powered-By;"));
});

test("Nginx 的 API 白名单恰好是六个公开只读接口", () => {
  const allowed = [...nginx.matchAll(/location\s*=\s*(\/api\/[^\s{]+)\s*\{/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(allowed, [
    "/api/agreements",
    "/api/catalog/products",
    "/api/companions",
    "/api/home",
    "/api/rankings/companions",
    "/api/rankings/consumption",
  ]);

  assert.match(nginx, /location\s+\/api\/\s*\{\s*return\s+404;/);
});

test("Nginx 只代理公开页面，其余路径兜底 404", () => {
  assert.match(nginx, /location\s*=\s*\/\s*\{\s*proxy_pass/);
  assert.match(nginx, /location\s+\^~\s+\/product\//);
  assert.match(nginx, /location\s+\^~\s+\/companions\//);

  const pageRegex = nginx.match(/location\s+~\s+\^\/\(([^)]+)\)\/\?\$\s*\{/);
  assert.ok(pageRegex, "缺少公开页面正则");
  const pages = pageRegex[1].split("|");
  for (const page of [
    "category",
    "rank",
    "rank/companions",
    "companions",
    "agreements",
    "activities",
    "help",
    "placeholder",
  ]) {
    assert.ok(pages.includes(page), `公开页面正则缺少 ${page}`);
  }

  assert.match(nginx, /location\s+\/\s*\{\s*return\s+404;/);
});

test("Nginx 配置基础防护：安全头、限流、请求体上限", () => {
  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
    "Cross-Origin-Opener-Policy",
  ]) {
    assert.ok(nginx.includes(header), `缺少安全响应头 ${header}`);
  }
  assert.ok(nginx.includes("limit_req_zone"));
  assert.ok(nginx.includes("limit_req zone=chaoge_public_req"));
  assert.ok(nginx.includes("limit_conn"));
  assert.ok(nginx.includes("client_max_body_size 64k;"));
  assert.ok(nginx.includes("server_tokens off;"));
});

test("Nginx 配置不包含任何后台/私有接口的代理", () => {
  for (const privatePath of [
    "/api/admin",
    "/api/staff",
    "/api/companion",
    "/api/auth",
    "/api/debug",
    "/api/payments",
    "/api/orders",
    "/api/me",
    "/admin",
    "/staff",
    "/companion",
  ]) {
    // 负向前瞻避免 `/api/companion` 误命中公开的 `/api/companions`。
    const proxyLine = new RegExp(
      `location[^\\n]*${privatePath.replace(/[/]/g, "\\/")}(?![A-Za-z0-9_-])[^\\n]*\\{[^}]*proxy_pass`,
      "s",
    );
    assert.doesNotMatch(nginxCode, proxyLine, `不得代理 ${privatePath}`);
  }
});

// ── 4. 安装 / 回滚脚本 ────────────────────────────────────────────────────────

test(
  "安装与回滚脚本语法正确",
  { skip: SKIP_NO_BASH },
  () => {
    assert.equal(
      bashSyntaxOk("deploy/proxy/install-public-proxy.sh"),
      true,
      "install-public-proxy.sh 语法错误",
    );
    assert.equal(
      bashSyntaxOk("deploy/proxy/rollback-public-proxy.sh"),
      true,
      "rollback-public-proxy.sh 语法错误",
    );
  },
);

test("安装脚本必须先 nginx -t 再 reload，并且失败时移除配置", () => {
  const testIndex = installer.indexOf("nginx -t");
  const reloadIndex = installer.indexOf("systemctl reload nginx");
  assert.ok(testIndex > 0, "必须运行 nginx -t");
  assert.ok(reloadIndex > testIndex, "nginx -t 必须在 reload 之前");
  assert.ok(installer.includes("rollback_config"));
  assert.ok(installer.includes("rm -f \"$CONF_LINK\""));
});

test("安装 / 回滚脚本不修改防火墙、SSH、sudoers", () => {
  for (const [name, source] of [
    ["install", installerCode],
    ["rollback", rollbackCode],
  ]) {
    for (const forbidden of [
      "ufw ",
      "iptables",
      "firewall-cmd",
      "sshd_config",
      "/etc/sudoers",
      "NOPASSWD",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `${name} 脚本不得包含 ${forbidden}`,
      );
    }
  }
});

test("安装脚本要求 root，回滚脚本关闭 80", () => {
  assert.ok(installer.includes('[[ "$(id -u)" == "0" ]]'));
  assert.ok(rollback.includes('[[ "$(id -u)" == "0" ]]'));
  assert.ok(rollback.includes("systemctl stop nginx"));
  assert.ok(rollback.includes("systemctl disable nginx"));
  assert.ok(rollback.includes("rm -f \"$CONF_LINK\""));
});

test("安装脚本的本地验收覆盖公开内容与私有接口拒绝", () => {
  assert.ok(installer.includes("超哥电竞"));
  assert.ok(installer.includes("开发工具"));
  assert.ok(installer.includes("/api/home"));
  assert.ok(installer.includes("/api/admin/dashboard"));
  assert.ok(installer.includes("/api/auth/mock-login"));
  assert.ok(installer.includes("127.0.0.1:3000"));
  assert.ok(installer.includes("5432"));
});
