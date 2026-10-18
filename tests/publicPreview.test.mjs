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
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_PREVIEW_HEADER,
  PUBLIC_PREVIEW_HEADER_VALUE,
  PUBLIC_PREVIEW_UNAVAILABLE_REASON,
  isPublicPreviewMethod,
  isPublicPreviewPath,
  normalizePublicPreviewPath,
  publicPreviewSafeHref,
  publicPreviewUnavailableHref,
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

test("公网预览把受保护入口改写到「暂不可用」占位页", () => {
  // 公开路径原样保留（含查询串），不改变正常导航。
  for (const [href, label] of [
    ["/", "首页"],
    ["/category?tab=all", "分类"],
    ["/product/p-400w", "商品"],
    ["/companions/cp-demo#reviews", "陪玩"],
    ["/placeholder", "占位"],
  ]) {
    assert.equal(publicPreviewSafeHref(href, label), href, `不应改写 ${href}`);
  }

  // 外链与非本站协议原样返回，不误改。
  for (const href of [
    "https://example.com/orders",
    "weixin://dl/business",
    "tel:10086",
    "#top",
  ]) {
    assert.equal(publicPreviewSafeHref(href, "外部"), href, `不应改写外链 ${href}`);
  }

  // 受保护页面改写到占位页，并带上可读标题与原因。
  for (const [href, label] of [
    ["/orders", "订单"],
    ["/service", "客服"],
    ["/mine", "我的"],
    ["/join", "考核入驻"],
    ["/complaints", "投诉客服专区"],
    ["/coupons?tab=valid", "优惠券"],
  ]) {
    const rewritten = publicPreviewSafeHref(href, label);
    const url = new URL(rewritten, "https://public-preview.invalid");
    assert.equal(url.pathname, "/placeholder", `${href} 应改写到占位页`);
    assert.equal(url.searchParams.get("title"), label);
    assert.equal(url.searchParams.get("reason"), PUBLIC_PREVIEW_UNAVAILABLE_REASON);
  }

  const encoded = publicPreviewUnavailableHref("  ");
  assert.equal(new URL(encoded, "https://public-preview.invalid").searchParams.get("title"), "该功能");
});

test("导航 / 快捷入口 / 占位页都接入公网落点改写", () => {
  const tabBar = read("components/common/TabBar.tsx");
  assert.match(tabBar, /publicPreviewSafeHref\(href, label\)/);
  assert.match(tabBar, /publicPreview \? publicPreviewSafeHref\(href, label\) : href/);

  const layout = read("app/(mobile)/(tabs)/layout.tsx");
  assert.match(layout, /isPublicPreviewRequest\(\)/);
  assert.match(layout, /<TabBar publicPreview=\{publicPreview\}/);

  const home = read("app/(mobile)/(tabs)/page.tsx");
  assert.match(home, /isPublicPreviewRequest\(\)/);
  assert.match(home, /publicPreviewSafeHref\(shortcut\.href, shortcut\.label\)/);

  const placeholder = read("components/common/PlaceholderPage.tsx");
  assert.match(placeholder, /PUBLIC_PREVIEW_UNAVAILABLE_REASON/);
  assert.match(placeholder, /暂不可用/);
  assert.match(placeholder, /PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION/);

  const route = read("app/(mobile)/placeholder/page.tsx");
  assert.match(route, /params\.reason/);
  assert.match(route, /reason=\{reason\}/);
});

test("商品详情的受限操作在公网预览下说明「暂不可用」，不展示模拟登录文案", () => {
  const page = read("app/(mobile)/product/[id]/page.tsx");
  assert.match(page, /const publicPreview = await isPublicPreviewRequest\(\)/);
  assert.match(page, /mockAuthEnabled=\{isMockAuthEnabled\(\) && !publicPreview\}/);
  assert.match(page, /<ProductPurchasePanel[\s\S]*publicPreview=\{publicPreview\}/);

  const panel = read("components/product/ProductPurchasePanel.tsx");
  assert.match(panel, /publicPreview\?: boolean/);
  assert.match(panel, /<LoginSheet[\s\S]*publicPreview=\{publicPreview\}/);

  const sheet = read("components/auth/LoginSheet.tsx");
  assert.match(sheet, /PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION/);
  assert.match(sheet, /publicPreview \? "该功能暂不可用" : "登录后继续"/);
  assert.match(
    sheet,
    /publicPreview\s*\n?\s*\? PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION/,
    "公网预览必须使用统一说明，而不是模拟登录文案",
  );
  assert.match(sheet, /publicPreview \? "返回" : "暂不登录"/);
});

test("协议页签改为可换行布局，390px 下不横向裁切", () => {
  const source = read("components/agreements/AgreementTabs.tsx");
  assert.match(source, /role="tablist"/);
  assert.match(source, /flex flex-wrap gap-1/);
  assert.doesNotMatch(source, /overflow-x-auto/, "页签不应再依赖横向滚动");
  assert.match(source, /rounded-full px-2 /);
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

test("Nginx 用精确匹配承接 /companions，避免 301/308 重定向环", () => {
  const exact = nginxCode.match(/location\s*=\s*\/companions\s*\{([^}]*)\}/);
  assert.ok(exact, "缺少 location = /companions，前缀 location 会把无斜杠地址 301 到带斜杠");
  assert.match(
    exact[1],
    /proxy_pass\s+http:\/\/127\.0\.0\.1:3000;/,
    "/companions 必须直接代理到上游，而不是 redirect",
  );
  assert.ok(
    exact.index < nginxCode.indexOf("location ^~ /companions/"),
    "精确匹配必须写在前缀匹配之前，便于阅读（Nginx 的 = 本就优先，但顺序仍需明确）",
  );
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

/**
 * Nginx 指令的轻量语义解析。
 *
 * 为什么不能只做字符串断言：`limit_conn zone=name 20` 里的每个字符串都
 * 「看起来对」，但 Nginx 的 limit_conn 语法是 `limit_conn <zone> <number>`，
 * 没有 `zone=` 前缀。真实故障是 `nginx -t` 报
 * `zero size shared memory zone "zone=chaoge_public_conn"`——只有把指令
 * 拆成「名字 + 参数」并核对引用关系，才能在本地发现它。
 */
function tokenizeNginx(source) {
  const tokens = [];
  let word = "";
  let i = 0;
  const flush = () => {
    if (word) {
      tokens.push(word);
      word = "";
    }
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "#") {
      flush();
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      flush();
      const quote = ch;
      i++;
      let value = "";
      while (i < source.length && source[i] !== quote) value += source[i++];
      i++;
      tokens.push(`"${value}"`);
      continue;
    }

    if (ch === "{" || ch === "}" || ch === ";") {
      flush();
      tokens.push(ch);
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }

    word += ch;
    i++;
  }

  flush();
  return tokens;
}

/** 把 token 流切成 `{ words, depth, terminator }`，depth 为指令所在块深度。 */
function parseNginxStatements(source) {
  const statements = [];
  let words = [];
  let depth = 0;

  for (const token of tokenizeNginx(source)) {
    if (token === "{") {
      if (words.length) statements.push({ words, depth, terminator: "{" });
      words = [];
      depth++;
      continue;
    }
    if (token === "}") {
      if (words.length) statements.push({ words, depth, terminator: ";" });
      words = [];
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token === ";") {
      if (words.length) statements.push({ words, depth, terminator: ";" });
      words = [];
      continue;
    }
    words.push(token);
  }

  if (words.length) statements.push({ words, depth, terminator: ";" });
  return statements;
}

function parseSize(value) {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value);
  if (!match) return 0;
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Number(match[1]) * scale[match[2].toLowerCase()];
}

function parseLimitDirectives(source) {
  const connZones = new Map();
  const reqZones = new Map();
  const connUsages = [];
  const reqUsages = [];

  for (const statement of parseNginxStatements(source)) {
    const [name, ...args] = statement.words;

    if (name === "limit_conn_zone") {
      const match = /^(\S+)\s+zone=([A-Za-z0-9_]+):(\S+)$/.exec(args.join(" "));
      assert.ok(match, `limit_conn_zone 语法不正确：${statement.words.join(" ")}`);
      const size = parseSize(match[3]);
      assert.ok(size > 0, `limit_conn_zone 的共享内存大小必须大于 0：${match[3]}`);
      assert.equal(statement.depth, 0, "limit_conn_zone 必须位于 http 作用域");
      connZones.set(match[2], { size, key: match[1] });
    }

    if (name === "limit_req_zone") {
      const match = /^(\S+)\s+zone=([A-Za-z0-9_]+):(\S+)\s+rate=\S+$/.exec(
        args.join(" "),
      );
      assert.ok(match, `limit_req_zone 语法不正确：${statement.words.join(" ")}`);
      const size = parseSize(match[3]);
      assert.ok(size > 0, `limit_req_zone 的共享内存大小必须大于 0：${match[3]}`);
      assert.equal(statement.depth, 0, "limit_req_zone 必须位于 http 作用域");
      reqZones.set(match[2], { size, key: match[1] });
    }

    if (name === "limit_conn") {
      connUsages.push({ args, depth: statement.depth });
    }

    if (name === "limit_req") {
      reqUsages.push({ args, depth: statement.depth });
    }
  }

  return { connZones, reqZones, connUsages, reqUsages };
}

test("Nginx limit_conn 语义正确：区名不带 zone= 前缀且已声明", () => {
  const { connZones, connUsages } = parseLimitDirectives(nginxCode);

  assert.ok(connZones.size >= 1, "必须声明至少一个 limit_conn_zone");
  assert.ok(connUsages.length >= 1, "必须使用 limit_conn");

  for (const { args, depth } of connUsages) {
    assert.ok(depth >= 1, "limit_conn 必须位于 server/location 作用域");
    assert.equal(
      args.length,
      2,
      `limit_conn 的语法必须是「limit_conn <zone> <number>」，收到：${args.join(" ")}`,
    );

    const [zone, number] = args;
    assert.doesNotMatch(
      zone,
      /^zone=/,
      "limit_conn 没有 zone= 前缀；写成 zone=name 会被当成区名，nginx -t 报 zero size shared memory zone",
    );
    assert.match(zone, /^[A-Za-z0-9_]+$/, `limit_conn 区名不合法：${zone}`);
    assert.match(number, /^\d+$/, `limit_conn 连接数不合法：${number}`);
    assert.ok(
      connZones.has(zone),
      `limit_conn 引用了未声明的区：${zone}（已声明：${[...connZones.keys()].join(", ")}）`,
    );
  }
});

test("Nginx limit_req 语义正确：zone= 引用已声明且参数合法", () => {
  const { reqZones, reqUsages } = parseLimitDirectives(nginxCode);

  assert.ok(reqZones.size >= 1, "必须声明至少一个 limit_req_zone");
  assert.ok(reqUsages.length >= 1, "必须使用 limit_req");

  for (const { args, depth } of reqUsages) {
    assert.ok(depth >= 1, "limit_req 必须位于 server/location 作用域");

    const match =
      /^zone=([A-Za-z0-9_]+)(?:\s+burst=(\d+))?(?:\s+(?:nodelay|delay=\d+))?$/.exec(
        args.join(" "),
      );
    assert.ok(
      match,
      `limit_req 语法不正确：limit_req ${args.join(" ")}（应为 zone=name [burst=N] [nodelay|delay=N]）`,
    );
    assert.ok(
      reqZones.has(match[1]),
      `limit_req 引用了未声明的区：${match[1]}（已声明：${[...reqZones.keys()].join(", ")}）`,
    );
  }
});

const NGINX_AVAILABLE = (() => {
  try {
    return spawnSync("nginx", ["-v"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

test(
  "Nginx 真实配置解析通过（有 nginx 可执行文件时）",
  { skip: NGINX_AVAILABLE ? false : "本机没有 nginx；语义测试仍会运行" },
  () => {
    // 用临时 wrapper 把站点配置 include 进 http 作用域，并把日志/临时目录
    // 指到临时目录，这样普通用户也能跑 nginx -t，不碰系统配置。
    const tmp = mkdtempSync(path.join(tmpdir(), "chaoge-nginx-"));
    try {
      mkdirSync(path.join(tmp, "logs"), { recursive: true });
      for (const dir of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]) {
        mkdirSync(path.join(tmp, dir), { recursive: true });
      }

      // nginx -t 会尝试 bind 监听端口；非 root 绑定 80 会因权限失败（与配置
      // 正确性无关）。临时副本改到高位端口，其余指令保持不变。
      const siteConf = nginx
        .replaceAll("/var/log/nginx", `${tmp}/logs`)
        .replaceAll("listen 80 default_server;", "listen 18080 default_server;")
        .replaceAll(
          "listen [::]:80 default_server;",
          "listen [::]:18080 default_server;",
        );
      const sitePath = path.join(tmp, "site.conf");
      writeFileSync(sitePath, siteConf);

      const wrapperPath = path.join(tmp, "nginx.conf");
      writeFileSync(
        wrapperPath,
        [
          "worker_processes 1;",
          `error_log ${tmp}/logs/error.log;`,
          `pid ${tmp}/nginx.pid;`,
          "events { worker_connections 64; }",
          "http {",
          "    access_log off;",
          `    client_body_temp_path ${tmp}/client_body;`,
          `    proxy_temp_path ${tmp}/proxy;`,
          `    fastcgi_temp_path ${tmp}/fastcgi;`,
          `    uwsgi_temp_path ${tmp}/uwsgi;`,
          `    scgi_temp_path ${tmp}/scgi;`,
          `    include ${sitePath};`,
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        "nginx",
        ["-t", "-p", tmp, "-c", wrapperPath],
        { encoding: "utf8" },
      );

      assert.equal(
        result.status,
        0,
        `nginx -t 失败：\n${result.stderr || result.stdout}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);

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

test("安装脚本的验收必须经过 Nginx 80，不能直连上游", () => {
  // 直连 3000 看到的是私有路径：没有公网标记头，/api/admin/dashboard 会返回
  // 401 而不是 404，Mock 面板也会正常渲染——用它做验收会得出错误结论。
  assert.ok(
    installer.includes('PUBLIC_URL="http://127.0.0.1"'),
    "必须定义经过 Nginx 的验收地址",
  );

  // 所有验收请求统一由 http_of 拼到 PUBLIC_URL 上。
  assert.ok(installer.includes('"$PUBLIC_URL$path"'), "http_of 必须请求 Nginx 地址");

  for (const call of [
    '"$(http_of /)"',
    '"$(http_of /api/home)"',
    '"$(http_of /api/admin/dashboard)"',
    '"$(http_of /admin)"',
  ]) {
    assert.ok(installer.includes(call), `缺少经过 Nginx 的验收请求：${call}`);
  }
  assert.match(
    installerCode,
    /http_of -X POST[^\n]*\/api\/auth\/mock-login/,
    "Mock 登录验收必须经过 Nginx",
  );

  // 出现 UPSTREAM 说明又直连了 3000。
  assert.doesNotMatch(
    installerCode,
    /status_of[^\n]*\$UPSTREAM/,
    "验收不得直连上游 3000",
  );
  assert.ok(!installer.includes("status_of()"), "status_of 已由 http_of 取代");
});

test("Nginx 返回安装验收专用响应头，请求侧标记保持不变", () => {
  // 默认站点同样返回 200；验收必须靠这个只有本配置才有的响应头区分。
  assert.ok(nginx.includes('add_header X-Chaoge-Public-Proxy "1" always;'));
  // 请求侧标记仍然存在，且与响应头不同名。
  assert.ok(nginx.includes('proxy_set_header X-Chaoge-Public-Preview "1";'));
});

test("安装验收等待专属响应头，默认站点的 200 不会误判为成功", () => {
  assert.match(installerCode, /X-Chaoge-Public-Proxy: 1/);
  assert.ok(
    installer.includes('[[ "$CODE" == "200" ]] && has_proxy_marker'),
    "必须同时满足 200 与专属响应头才继续",
  );
  assert.match(installerCode, /for _ in \$\(seq 1 40\)/, "必须带重试窗口");
  assert.ok(installer.includes("dump_home_diagnostics"), "失败时必须打印诊断");
  assert.ok(
    installer.includes('"$TITLE" != "<title>超哥电竞</title>"'),
    "必须校验完整标题，而不是只看单个字符串",
  );
  assert.ok(installer.includes('"announcements"'), "首页 API 必须校验响应体内容");
  assert.ok(
    installer.includes("has_proxy_marker || die_probe"),
    "私有接口的 404 也必须确认来自 chaoge 站点",
  );
});

// ── 5. 验收探针的行为测试 ──────────────────────────────────────────────────────
//
// 只断言字符串救不了 `000000000`：旧实现把 path 当第一个参数，POST 调用里的
// `-X` 被当成了路径，curl 于是收到 `POST`、`/api/auth/mock-login`、
// `http://127.0.0.1-X` 三个 URL，每个失败都输出 `000`，拼成九位。
// 下面的测试把安装器里的 http_of 原样提取出来，对着真实本地 HTTP 服务执行
// 安装器里的每一条验收调用，核对服务器实际收到的 method/path。

const CURL_AVAILABLE = (() => {
  try {
    return spawnSync("curl", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

const SKIP_NO_PROBE_TOOLCHAIN = SKIP_NO_BASH
  ? SKIP_NO_BASH
  : CURL_AVAILABLE
    ? false
    : "需要 curl 才能运行行为测试";

function extractHttpOfFunction() {
  const match = installer.match(/# >>> http_of[\s\S]*?# <<< http_of/);
  assert.ok(match, "安装器必须用 http_of 标记包住探针函数，供行为测试提取");
  return match[0].replace(/\r\n/g, "\n");
}

function extractProbeCalls() {
  const calls = installer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^CODE="\$\(http_of .+\)"$/.test(line));

  assert.ok(
    calls.length >= 5,
    `应至少提取到 5 个验收调用，实际 ${calls.length} 个`,
  );
  return calls;
}

function buildProbeHarness({ publicUrl, calls }) {
  return [
    "set -uo pipefail",
    'HEADERS="$(mktemp)"',
    'BODY="$(mktemp)"',
    'CURL_ERR="$(mktemp)"',
    'CURL_RC="$(mktemp)"',
    `PUBLIC_URL=${JSON.stringify(publicUrl)}`,
    extractHttpOfFunction(),
    ...calls.flatMap((call) => [call, `printf 'CODE=%s\\n' "$CODE"`]),
    'rm -f "$HEADERS" "$BODY" "$CURL_ERR" "$CURL_RC"',
    "",
  ].join("\n");
}

function runBashAsync(script) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-s"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: `${stderr}${error}` }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
}

test(
  "安装器验收探针把最后一个参数当作路径：POST mock-login 真正到达服务器",
  { skip: SKIP_NO_PROBE_TOOLCHAIN },
  async () => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          body,
          contentType: req.headers["content-type"] ?? "",
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = server.address();
      const publicUrl = `http://127.0.0.1:${port}`;
      const calls = extractProbeCalls();

      const result = await runBashAsync(
        buildProbeHarness({ publicUrl, calls }),
      );
      assert.equal(result.code, 0, result.stderr);

      const codes = [...result.stdout.matchAll(/^CODE=(.*)$/gm)].map(
        (match) => match[1],
      );
      assert.equal(codes.length, calls.length, "每个验收调用都应输出一个状态码");
      assert.deepEqual(codes, calls.map(() => "200"));

      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.url}`),
        [
          "GET /",
          "GET /api/home",
          "GET /api/admin/dashboard",
          "POST /api/auth/mock-login",
          "GET /admin",
        ],
        "探针请求的 method/path 必须与安装器验收步骤一一对应",
      );

      const post = requests.find((request) => request.method === "POST");
      assert.ok(post, "POST 探针没有到达服务器——path 可能被当成了 URL");
      assert.equal(post.body, "{}");
      assert.match(post.contentType, /application\/json/);

      // curl 对多个 URL 会输出拼接的状态码；探针必须归一为单个 000，
      // 而不是把 `200200` / `000000000` 当成接口状态。
      const beforeMulti = requests.length;
      const multi = await runBashAsync(
        buildProbeHarness({
          publicUrl,
          calls: ['CODE="$(http_of "$PUBLIC_URL/extra" /api/home)"'],
        }),
      );
      assert.equal(multi.code, 0, multi.stderr);
      assert.match(multi.stdout, /^CODE=000$/m, "多 URL 输出必须归一为 000");
      assert.equal(requests.length, beforeMulti + 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

test(
  "安装器探针把 curl 失败归一为单个 000，并保留退出码与 stderr",
  { skip: SKIP_NO_PROBE_TOOLCHAIN },
  async () => {
    const script = [
      "set -uo pipefail",
      'HEADERS="$(mktemp)"',
      'BODY="$(mktemp)"',
      'CURL_ERR="$(mktemp)"',
      'CURL_RC="$(mktemp)"',
      'PUBLIC_URL="http://127.0.0.1:1"',
      extractHttpOfFunction(),
      'CODE="$(http_of /api/home)"',
      `printf 'CODE=%s\\nRC=%s\\nERR_LEN=%s\\n' "$CODE" "$(cat "$CURL_RC")" "$(wc -c < "$CURL_ERR" | tr -d ' ')"`,
      'rm -f "$HEADERS" "$BODY" "$CURL_ERR" "$CURL_RC"',
    ].join("\n");

    const result = await runBashAsync(script);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^CODE=000$/m);
    assert.doesNotMatch(result.stdout, /^CODE=\d{4,}$/m);
    assert.match(result.stdout, /^RC=[1-9][0-9]*$/m, "必须保留 curl 退出码");
    assert.match(result.stdout, /^ERR_LEN=[1-9][0-9]*$/m, "必须保留 curl stderr");
  },
);

test("安装器探针失败时打印 curl 退出码与 stderr", () => {
  assert.ok(installer.includes("dump_curl_diagnostics"));
  assert.ok(installer.includes("die_probe"));
  assert.match(
    installerCode,
    /\[\[ "\$CODE" == "404" \]\] \|\| die_probe "POST \/api\/auth\/mock-login/,
    "POST 探针失败必须走带 curl 诊断的分支",
  );
});
