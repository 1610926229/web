/**
 * 公网 HTTPS 配置模板 · PROD-6
 *
 * 这些配置**不会**在本测试里安装到任何服务器；只做静态断言与（有 nginx 时）
 * 临时目录里的 `nginx -t`。真正的 root 安装需要产品负责人批准后人工执行。
 *
 * 守的重点：
 *   · 80 只做 ACME 与 301，不代理登录 / 工作台；
 *   · 443 只代理登录页、工作台、必要登录 API 与原只读预览；
 *   · Mock / 调试 / 模拟支付显式 404，且优先于前缀匹配；
 *   · 只读路径清 Cookie，登录 / 工作台保留 Cookie；
 *   · 登录 API 有独立限流；
 *   · 安装器先备份、先 nginx -t，失败回滚，不碰 SSH / 防火墙 / sudoers。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

const template = read("deploy/proxy/chaoge-public-https.conf.template");
const publicSnippet = read("deploy/proxy/chaoge-proxy-public.inc");
const sessionSnippet = read("deploy/proxy/chaoge-proxy-session.inc");
const installer = read("deploy/proxy/install-public-https.sh");
const rollback = read("deploy/proxy/rollback-public-https.sh");

const stripHashComments = (source) =>
  source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const templateCode = stripHashComments(template);
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

// ── 1. 模板结构 ───────────────────────────────────────────────────────────────

test("HTTPS 模板：80 只做 ACME 与 301，不代理上游", () => {
  const httpServer = template.split("# ── HTTPS")[0];
  assert.ok(httpServer.includes("listen 80 default_server;"), "缺少 80 server");

  assert.match(httpServer, /listen\s+80\s+default_server;/);
  assert.match(httpServer, /location\s+\^~\s+\/\.well-known\/acme-challenge\//);
  assert.match(httpServer, /return\s+301\s+https:\/\/__SERVER_NAME__\$request_uri;/);
  assert.doesNotMatch(httpServer, /proxy_pass/, "80 不得代理任何请求");
  assert.doesNotMatch(httpServer, /return\s+301\s+https:\/\/\$host/, "不得用 Host 头拼跳转地址");
});

test("HTTPS 模板：443 使用占位域名与 Let's Encrypt 证书，启用 HSTS", () => {
  assert.match(templateCode, /listen\s+443\s+ssl\s+default_server;/);
  assert.match(templateCode, /server_name\s+__SERVER_NAME__;/);
  assert.match(
    templateCode,
    /ssl_certificate\s+\/etc\/letsencrypt\/live\/__SERVER_NAME__\/fullchain\.pem;/,
  );
  assert.match(
    templateCode,
    /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/__SERVER_NAME__\/privkey\.pem;/,
  );
  assert.match(templateCode, /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3;/);
  assert.match(templateCode, /Strict-Transport-Security/);
  assert.match(templateCode, /if \(\$host != __SERVER_NAME__\)/);
  assert.match(templateCode, /return 444;/);
});

test("HTTPS 模板：不监听 3000 / 5432", () => {
  assert.doesNotMatch(templateCode, /listen\s+(?:\S*:)?3000\b/);
  assert.doesNotMatch(templateCode, /listen\s+(?:\S*:)?5432\b/);
  assert.doesNotMatch(templateCode, /proxy_pass\s+http:\/\/(?!127\.0\.0\.1:3000)/);
});

test("HTTPS 模板：放行登录页、工作台与必要登录 API（保留 Cookie）", () => {
  for (const location of [
    "location = /staff/login",
    "location = /staff",
    "location ^~ /staff/",
    "location = /admin/login",
    "location = /admin",
    "location ^~ /admin/",
    "location = /mine",
    "location = /wechat-login",
    "location = /api/me",
    "location = /api/auth/logout",
    "location = /api/auth/wechat/status",
    "location = /api/auth/wechat/start",
    "location = /api/auth/wechat/callback",
    "location = /api/staff/auth/login",
    "location = /api/admin/auth/login",
    "location ^~ /api/staff/",
    "location ^~ /api/admin/",
  ]) {
    assert.ok(template.includes(location), `缺少 ${location}`);
  }

  // 登录 / 工作台 / 登录 API 必须使用保留 Cookie 的片段。
  const sessionIncludes = template.match(/include snippets\/chaoge-proxy-session\.inc;/g) ?? [];
  assert.ok(sessionIncludes.length >= 17, `保留 Cookie 的 location 数量异常：${sessionIncludes.length}`);

  // 登录页与工作台只允许 GET / HEAD。
  assert.match(
    templateCode,
    /location = \/staff\/login\s*\{[\s\S]*?if \(\$request_method !~ \^\(GET\|HEAD\)\$\)/,
  );
  assert.match(
    templateCode,
    /location = \/admin\/login\s*\{[\s\S]*?if \(\$request_method !~ \^\(GET\|HEAD\)\$\)/,
  );
});

test("HTTPS 模板：登录 API 只允许 POST 且有独立限流", () => {
  for (const route of ["/api/staff/auth/login", "/api/admin/auth/login"]) {
    const match = templateCode.match(
      new RegExp(`location = ${route.replace(/[/]/g, "\\/")}\\s*\\{([\\s\\S]*?)\\n    \\}`),
    );
    assert.ok(match, `缺少 ${route}`);
    const block = match[1];
    assert.match(block, /limit_req zone=chaoge_login burst=5 nodelay;/);
    assert.match(block, /if \(\$request_method !~ \^\(POST\)\$\)/);
    assert.match(block, /include snippets\/chaoge-proxy-session\.inc;/);
    assert.match(block, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  }

  assert.match(template, /limit_req_zone\s+\$binary_remote_addr\s+zone=chaoge_login:10m\s+rate=10r\/m;/);
  assert.match(template, /limit_req_status 429;/);
});

test("HTTPS 模板：Mock / 调试 / 模拟支付显式 404", () => {
  for (const location of [
    "/wechat-mock",
    "/api/auth/mock-login",
    "/api/auth/wechat/mock/complete",
    "/api/staff/auth/mock-login",
    "/api/admin/auth/mock-login",
    "/api/payments/mock-confirm",
  ]) {
    assert.ok(
      template.includes(`location = ${location} {`),
      `缺少显式 404：${location}`,
    );
  }
  assert.ok(template.includes("location ^~ /api/debug/ {"));
});

test("HTTPS 模板：只读预览清空 Cookie，公开只读 API 仍是六个", () => {
  for (const location of [
    "location = /api/home",
    "location = /api/catalog/products",
    "location = /api/companions",
    "location = /api/agreements",
    "location = /api/rankings/consumption",
    "location = /api/rankings/companions",
  ]) {
    assert.ok(template.includes(location), `缺少公开只读接口 ${location}`);
  }

  const publicIncludes = template.match(/include snippets\/chaoge-proxy-public\.inc;/g) ?? [];
  assert.ok(publicIncludes.length >= 10, `清 Cookie 的 location 数量异常：${publicIncludes.length}`);

  assert.match(templateCode, /location \/api\/\s*\{\s*return 404;/);
  assert.match(templateCode, /location \/\s*\{\s*return 404;/);
});

test("Cookie 策略只写在片段里，避免 Nginx 继承陷阱", () => {
  assert.doesNotMatch(template, /proxy_set_header Cookie/, "模板不得在 server/location 级写 Cookie");
  assert.match(publicSnippet, /proxy_set_header Cookie "";/);
  assert.match(sessionSnippet, /proxy_set_header Cookie \$http_cookie;/);

  for (const snippet of [publicSnippet, sessionSnippet]) {
    for (const header of [
      'proxy_set_header Host $host;',
      'proxy_set_header X-Real-IP $remote_addr;',
      'proxy_set_header X-Forwarded-For $remote_addr;',
      'proxy_set_header X-Forwarded-Proto $scheme;',
      'proxy_set_header X-Forwarded-Host $host;',
      'proxy_set_header X-Chaoge-Public-Preview "1";',
      'proxy_set_header Authorization "";',
    ]) {
      assert.ok(snippet.includes(header), `片段缺少 ${header}`);
    }
  }
});

// ── 2. 安装 / 回滚脚本 ────────────────────────────────────────────────────────

test(
  "HTTPS 安装器与回滚脚本语法正确",
  { skip: SKIP_NO_BASH },
  () => {
    assert.equal(bashSyntaxOk("deploy/proxy/install-public-https.sh"), true);
    assert.equal(bashSyntaxOk("deploy/proxy/rollback-public-https.sh"), true);
  },
);

test("HTTPS 安装器默认只预检，--apply 才要求 root", () => {
  assert.match(installer, /--apply/);
  assert.match(installer, /\[\[ "\$\(id -u\)" == "0" \]\]/);
  assert.ok(
    installer.indexOf("APPLY") < installer.indexOf('[[ "$(id -u)" == "0" ]]'),
    "root 检查必须在 --apply 分支内",
  );
  assert.match(installerCode, /nginx -t/);
  assert.match(installerCode, /systemctl reload nginx/);
  assert.ok(
    installer.indexOf("nginx -t") < installer.indexOf("systemctl reload nginx"),
    "nginx -t 必须在 reload 之前",
  );
  assert.match(installerCode, /cp -a "\$SITES_AVAILABLE" "\$BACKUP"/);
  assert.match(installerCode, /restore_previous/);
});

test("HTTPS 安装器不修改 SSH / 防火墙 / sudoers，也不输出凭据", () => {
  for (const forbidden of [
    "ufw ",
    "iptables",
    "firewall-cmd",
    "sshd_config",
    "/etc/sudoers",
    "NOPASSWD",
    "chaoge_prod",
    "5432",
  ]) {
    assert.ok(!installerCode.includes(forbidden), `安装器不得包含 ${forbidden}`);
    assert.ok(!rollbackCode.includes(forbidden), `回滚脚本不得包含 ${forbidden}`);
  }

  // 不读取应用环境文件或数据库口令。
  for (const forbidden of [".env", "DATABASE_URL", "PGPASSWORD"]) {
    assert.ok(!installerCode.includes(forbidden), `安装器不得读取 ${forbidden}`);
  }
});

test("HTTPS 安装器的验收覆盖登录页、未登录拒绝、Mock 404、CSRF 与 HTTP 跳转", () => {
  assert.ok(installer.includes("$BASE_URL/staff/login"));
  assert.ok(installer.includes("$BASE_URL/admin/login"));
  assert.ok(installer.includes("$BASE_URL/staff"));
  assert.ok(installer.includes("$BASE_URL/admin"));
  assert.ok(installer.includes("$BASE_URL/api/staff/orders"));
  assert.ok(installer.includes("$BASE_URL/api/admin/dashboard"));
  assert.ok(installer.includes("$BASE_URL/api/auth/mock-login"));
  assert.ok(installer.includes("$BASE_URL/api/admin/auth/mock-login"));
  assert.ok(installer.includes("缺 Origin 的登录 POST"));
  assert.match(installerCode, /期望 403/);
  assert.ok(installer.includes('HTTP_CODE" == "301"'));
  assert.ok(installer.includes("--resolve"));
});

test("HTTPS 回滚脚本只恢复配置并 reload，不停止 Nginx", () => {
  assert.match(rollbackCode, /SITES_AVAILABLE"\.pre-https\.\*/);
  assert.match(rollbackCode, /nginx -t/);
  assert.match(rollbackCode, /systemctl reload nginx/);
  assert.doesNotMatch(rollbackCode, /systemctl stop nginx/);
  assert.doesNotMatch(rollbackCode, /systemctl disable nginx/);
});

// ── 3. 有 nginx 时做真实解析（自签证书，临时目录）──────────────────────────

const NGINX_AVAILABLE = (() => {
  try {
    return spawnSync("nginx", ["-v"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

const OPENSSL_AVAILABLE = (() => {
  try {
    return spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();

const SKIP_NO_NGINX = !NGINX_AVAILABLE
  ? "本机没有 nginx"
  : !OPENSSL_AVAILABLE
    ? "本机没有 openssl"
    : false;

test("HTTPS 模板在临时目录里通过 nginx -t（自签证书）", { skip: SKIP_NO_NGINX }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "chaoge-https-nginx-"));
  try {
    mkdirSync(path.join(tmp, "logs"), { recursive: true });
    mkdirSync(path.join(tmp, "snippets"), { recursive: true });
    for (const dir of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]) {
      mkdirSync(path.join(tmp, dir), { recursive: true });
    }

    const key = path.join(tmp, "key.pem");
    const cert = path.join(tmp, "cert.pem");
    const gen = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-subj", "/CN=chaoge.test",
      "-keyout", key, "-out", cert, "-days", "1",
    ], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);

    copyFileSync(
      path.join(REPO_ROOT, "deploy/proxy/chaoge-proxy-public.inc"),
      path.join(tmp, "snippets/chaoge-proxy-public.inc"),
    );
    copyFileSync(
      path.join(REPO_ROOT, "deploy/proxy/chaoge-proxy-session.inc"),
      path.join(tmp, "snippets/chaoge-proxy-session.inc"),
    );

    const site = template
      .replaceAll("__SERVER_NAME__", "chaoge.test")
      .replaceAll("/etc/letsencrypt/live/chaoge.test/fullchain.pem", cert)
      .replaceAll("/etc/letsencrypt/live/chaoge.test/privkey.pem", key)
      .replaceAll("/var/log/nginx", `${tmp}/logs`)
      .replaceAll("listen 80 default_server;", "listen 18080 default_server;")
      .replaceAll("listen [::]:80 default_server;", "listen [::]:18080 default_server;")
      .replaceAll("listen 443 ssl default_server;", "listen 18443 ssl default_server;")
      .replaceAll("listen [::]:443 ssl default_server;", "listen [::]:18443 ssl default_server;");
    const sitePath = path.join(tmp, "site.conf");
    writeFileSync(sitePath, site);

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

    const result = spawnSync("nginx", ["-t", "-p", tmp, "-c", wrapperPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `nginx -t 失败：\n${result.stderr || result.stdout}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
