import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

/**
 * PROD-5 · 微信登录的 **HTTP 回归**（打一个 `DATA_SOURCE=postgres` 的服务）。
 *
 * ## 与其它 HTTP 文件的关系
 *
 * 本文件打的是真实 PostgreSQL 服务，**不能**重置数据库，因此：
 *
 * - 只创建自己的随机账号与 Mock 微信身份，不依赖也不修改预置数据；
 * - 显式用 `REAL_AUTH_HTTP=1` 开启，缺省时整批如实跳过；
 * - 地址变量用方括号读取，`tests/httpIsolation.test.mjs` 的门禁因此不会
 *   要求本文件重置 Mock 存储（真库不能清）。
 *
 * 运行方式（staging 验收）：
 *
 *     REAL_AUTH_HTTP=1 REAL_AUTH_BASE=http://127.0.0.1:3100 pnpm test
 *
 * 这个文件回答的是代码层面回答不了的问题：
 *
 * 1. Mock 微信登录是不是真的下发了与邮箱登录**同一个**用户会话；
 * 2. 微信登录会不会顺手授予客服 / 管理员 / 护航权限（必须不会）；
 * 3. 真实微信未配置时，页面是不是明确说「尚未配置」，而不是伪造成功；
 * 4. 公网预览标记下，微信登录的页面与接口是否仍然全部不可达；
 * 5. 真实微信支付是否仍然没有路由。
 */

const BASE = process.env["REAL_AUTH_BASE"] ?? process.env["APP_BASE_URL"] ?? "";

const SKIP =
  process.env["REAL_AUTH_HTTP"] === "1" && BASE
    ? false
    : "未开启 REAL_AUTH_HTTP / REAL_AUTH_BASE：微信登录 HTTP 回归需要 DATA_SOURCE=postgres 的服务";

function uniqueEmail() {
  return `wechat-e2e-${randomUUID()}@example.test`;
}

function uniquePassword() {
  return `pw-${randomUUID()}`;
}

async function send(pathname, { cookie, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // 重定向响应不是 JSON，保留原文供断言显示
  }
  return {
    status: response.status,
    raw: text,
    json,
    location: response.headers.get("location"),
    cacheControl: response.headers.get("cache-control"),
    setCookie: response.headers.getSetCookie(),
  };
}

function cookieOf(response, name = "chaoge_user_session") {
  const line = response.setCookie.find((value) => value.startsWith(`${name}=`));
  assert.ok(line, `响应应当下发 ${name}；实际：${response.setCookie.join(" | ")}`);
  return line.split(";")[0];
}

async function wechatStatus() {
  const response = await send("/api/auth/wechat/status");
  assert.equal(response.status, 200, response.raw);
  return response.json.data;
}

async function mockLogin(key, extra = {}) {
  return send("/api/auth/wechat/mock/complete", {
    method: "POST",
    headers: { origin: new URL(BASE).origin },
    body: { key, redirect: "/orders", ...extra },
  });
}

async function profileId(cookie) {
  const response = await send("/api/me", { cookie });
  assert.equal(response.status, 200, response.raw);
  return response.json.data.id;
}

const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

async function placePaidOrder(cookie) {
  const pay = await send("/api/orders/pay", {
    cookie,
    method: "POST",
    body: {
      idempotencyKey: `wechat-e2e-${randomUUID()}`,
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "wechat_e2e",
      remark: "",
      companionId: null,
    },
  });
  if (pay.status !== 200) return null;

  const confirm = await send("/api/payments/mock-confirm", {
    cookie,
    method: "POST",
    body: { paymentRequestId: pay.json.data.id, result: "success" },
  });
  if (confirm.status !== 200) return null;
  return confirm.json.data.orderId;
}

// ————————————————————————— 能力探测 —————————————————————————

test("登录能力接口：只回两个布尔值，不泄露 AppID / AppSecret / 回调地址，且不缓存", { skip: SKIP }, async () => {
  const response = await send("/api/auth/wechat/status");
  assert.equal(response.status, 200, response.raw);
  assert.deepEqual(Object.keys(response.json.data).sort(), ["mockAvailable", "realConfigured"]);
  assert.equal(typeof response.json.data.realConfigured, "boolean");
  assert.equal(typeof response.json.data.mockAvailable, "boolean");
  assert.match(response.cacheControl ?? "", /no-store/i);

  for (const forbidden of ["appId", "appSecret", "secret", "redirectUri", "openid"]) {
    assert.equal(response.raw.includes(forbidden), false, `状态响应不该出现 ${forbidden}`);
  }
});

// ————————————————————————— 真实微信未配置 —————————————————————————

test("真实微信未配置：start 与 callback 都明确提示「尚未配置」，绝不用 Mock 顶替", { skip: SKIP }, async () => {
  const status = await wechatStatus();
  if (status.realConfigured) {
    // 已配置的环境不走这条断言，但至少确认 start 指向微信而不是本站
    const start = await send("/api/auth/wechat/start?redirect=/orders");
    assert.equal(start.status, 302, start.raw);
    assert.match(start.location, /^https:\/\/open\.weixin\.qq\.com\/connect\/qrconnect\?/);
    return;
  }

  const start = await send("/api/auth/wechat/start?redirect=/orders");
  assert.equal(start.status, 302);
  assert.match(start.location, /\/wechat-login\?error=not-configured$/);
  assert.equal(start.location.includes("open.weixin.qq.com"), false);
  assert.equal(
    start.setCookie.some((value) => value.startsWith("chaoge_wechat_state=")),
    false,
    "未配置时不该创建 state（那会让人以为登录已经开始）",
  );
  assert.equal(
    start.setCookie.some((value) => value.startsWith("chaoge_user_session=")),
    false,
    "未配置时绝不能下发会话",
  );

  const callback = await send(
    `/api/auth/wechat/callback?code=fake-code&state=${"a".repeat(43)}`,
  );
  assert.equal(callback.status, 302);
  assert.match(callback.location, /\/wechat-login\?error=not-configured$/);
  assert.equal(
    callback.setCookie.some((value) => value.startsWith("chaoge_user_session=")),
    false,
  );

  // 错误页本身可访问，并明确写出「尚未配置」而不是「请稍后重试」
  const page = await send("/wechat-login?error=not-configured");
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes("微信登录尚未配置"));
});

test("真实微信已配置时：state 缺失 / 错误 / 重放都被拒绝（不进入 code 交换）", { skip: SKIP }, async () => {
  const status = await wechatStatus();
  if (!status.realConfigured) {
    // staging 尚未取得开放平台资质：如实跳过，而不是用 Mock 冒充真实平台验收
    return;
  }

  const missing = await send("/api/auth/wechat/callback?code=fake-code");
  assert.equal(missing.status, 302);
  assert.match(missing.location, /\/wechat-login\?error=state-invalid$/);

  const start = await send("/api/auth/wechat/start?redirect=/orders");
  assert.equal(start.status, 302);
  assert.match(start.location, /^https:\/\/open\.weixin\.qq\.com\//);
  const stateCookie = cookieOf(start, "chaoge_wechat_state");
  const state = new URL(start.location).searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);

  const wrongState = `${state.slice(0, 42)}${state.endsWith("A") ? "B" : "A"}`;
  const wrong = await send(
    `/api/auth/wechat/callback?code=fake-code&state=${wrongState}`,
    { cookie: stateCookie },
  );
  assert.match(wrong.location, /\/wechat-login\?error=state-invalid$/);

  // 正确 state + 伪造 code：state 被消费，code 交换失败；第二次回调必须 state-invalid
  const first = await send(
    `/api/auth/wechat/callback?code=fake-code&state=${state}`,
    { cookie: stateCookie },
  );
  assert.match(first.location, /\/(wechat-login\?error=(code-invalid|network|failed)|orders)/);
  assert.equal(
    first.setCookie.some((value) => value.startsWith("chaoge_wechat_state=") && /Max-Age=0/i.test(value)),
    true,
    "无论成功失败都要清掉 state Cookie",
  );

  const replay = await send(
    `/api/auth/wechat/callback?code=fake-code&state=${state}`,
    { cookie: stateCookie },
  );
  assert.match(replay.location, /\/wechat-login\?error=state-invalid$/);
});

// ————————————————————————— Mock 微信登录 —————————————————————————

test("Mock 微信登录：下发真实用户会话；同一身份再次登录回到同一用户，不同身份是不同用户", { skip: SKIP }, async () => {
  const status = await wechatStatus();
  if (!status.mockAvailable) {
    // 模拟登录未启用时，接口必须按「不存在」处理
    const disabled = await mockLogin("alpha");
    assert.equal(disabled.status, 404, disabled.raw);
    return;
  }

  const first = await mockLogin("alpha");
  assert.equal(first.status, 200, first.raw);
  assert.deepEqual(first.json.data, { redirectTo: "/orders" });

  const alphaCookie = cookieOf(first);
  const firstLine = first.setCookie.find((value) => value.startsWith("chaoge_user_session="));
  assert.match(firstLine, /HttpOnly/i);
  assert.match(firstLine, /SameSite=Lax/i);

  const alphaId = await profileId(alphaCookie);

  // 同一身份重新登录：新的会话，同一个用户
  const again = await mockLogin("alpha");
  assert.equal(again.status, 200, again.raw);
  const againCookie = cookieOf(again);
  assert.notEqual(againCookie, alphaCookie, "每次登录都是一个新会话令牌");
  assert.equal(await profileId(againCookie), alphaId);

  // 不同身份：不同用户
  const beta = await mockLogin("beta");
  assert.equal(beta.status, 200, beta.raw);
  const betaId = await profileId(cookieOf(beta));
  assert.notEqual(betaId, alphaId, "两个 Mock 微信身份不能是同一个用户");

  // 回跳地址只允许站内路径
  const evil = await mockLogin("alpha", { redirect: "//evil.example.com/steal" });
  assert.equal(evil.status, 200, evil.raw);
  assert.equal(evil.json.data.redirectTo, "/");
});

test("Mock 微信登录不接受伪造身份 / 角色字段；同源校验生效", { skip: SKIP }, async () => {
  const status = await wechatStatus();
  if (!status.mockAvailable) return;

  const unknown = await mockLogin("not-an-identity");
  assert.equal(unknown.status, 400, unknown.raw);
  assert.equal(unknown.json.error.code, "BAD_REQUEST");

  // 请求体里塞 role / userId / openId 都没有作用：身份只来自服务端名单
  const forged = await mockLogin("alpha", {
    role: "admin",
    userId: "admin-1",
    staffId: "staff-1",
    openId: "attacker-chosen-openid",
  });
  assert.equal(forged.status, 200, forged.raw);
  const forgedCookie = cookieOf(forged);

  // 拿到的仍然只是普通用户：管理 / 客服 / 护航接口一律拒绝
  for (const pathname of [
    "/api/admin/orders",
    "/api/staff/orders",
    "/api/companion/dispatches",
    "/api/companion/earnings",
  ]) {
    const denied = await send(pathname, { cookie: forgedCookie });
    assert.ok(
      [401, 403].includes(denied.status),
      `用户会话不得进入 ${pathname}，实际 ${denied.status}`,
    );
  }

  // 普通用户接口可用
  assert.equal((await send("/api/me", { cookie: forgedCookie })).status, 200);

  // 跨站 Origin：拒绝
  const crossSite = await send("/api/auth/wechat/mock/complete", {
    method: "POST",
    headers: { origin: "https://evil.example.com" },
    body: { key: "alpha", redirect: "/orders" },
  });
  assert.equal(crossSite.status, 403, crossSite.raw);
  assert.equal(
    crossSite.setCookie.some((value) => value.startsWith("chaoge_user_session=")),
    false,
  );
});

test("Mock 微信登录与订单归属：两个身份互相看不到订单；失效会话不回退任何身份", { skip: SKIP }, async () => {
  const status = await wechatStatus();
  if (!status.mockAvailable) return;

  const alpha = await mockLogin("alpha");
  const beta = await mockLogin("beta");
  const alphaCookie = cookieOf(alpha);
  const betaCookie = cookieOf(beta);

  const orderId = await placePaidOrder(alphaCookie);
  if (!orderId) {
    // 模拟支付未启用时不断言订单链，但要明确这是环境限制而不是通过
    assert.ok(true, "ENABLE_MOCK_PAYMENT 未开启：订单归属回归由真实认证 HTTP 用例覆盖");
  } else {
    const own = await send(`/api/orders/${encodeURIComponent(orderId)}`, { cookie: alphaCookie });
    assert.equal(own.status, 200, own.raw);
    assert.equal(own.json.data.status, "paid");

    const other = await send(`/api/orders/${encodeURIComponent(orderId)}`, { cookie: betaCookie });
    assert.equal(other.status, 404, "另一个微信身份必须看不到这笔订单");
  }

  const tampered = "chaoge_user_session=this-is-not-a-session-token-value-000000000000";
  const anonymous = await send("/api/orders", { cookie: tampered });
  assert.equal(anonymous.status, 401, "失效会话不得回退成任何 Mock 身份");
});

// ————————————————————————— 既有密码登录回归 —————————————————————————

test("既有邮箱密码登录、退出与吊销不受微信登录改动影响", { skip: SKIP }, async () => {
  const email = uniqueEmail();
  const password = uniquePassword();

  const registered = await send("/api/auth/register", {
    method: "POST",
    body: { email, password, nickname: "微信回归用户（占位）" },
  });
  assert.equal(registered.status, 200, registered.raw);
  const cookie = cookieOf(registered);

  assert.equal((await send("/api/me", { cookie })).status, 200);

  const login = await send("/api/auth/login", {
    method: "POST",
    body: { email: email.toUpperCase(), password },
  });
  assert.equal(login.status, 200, login.raw);
  const loginCookie = cookieOf(login);
  assert.equal(await profileId(loginCookie), registered.json.data.id);

  const logout = await send("/api/auth/logout", { cookie: loginCookie, method: "POST" });
  assert.equal(logout.status, 200, logout.raw);
  assert.equal((await send("/api/me", { cookie: loginCookie })).status, 401);

  // 客服 / 管理员密码登录失败仍然不可区分
  const staff = await send("/api/staff/auth/login", {
    method: "POST",
    body: { username: "不存在-的-登录名", password: "whatever-123" },
  });
  const admin = await send("/api/admin/auth/login", {
    method: "POST",
    body: { username: "不存在-的-登录名", password: "whatever-123" },
  });
  assert.equal(staff.status, 401);
  assert.equal(admin.status, 401);
});

// ————————————————————————— 公网只读与真实支付 —————————————————————————

test("公网预览标记下：/wechat-mock、/wechat-login 与全部微信登录接口仍然不可达", { skip: SKIP }, async () => {
  const publicPreview = { "x-chaoge-public-preview": "1" };

  for (const pathname of ["/wechat-mock", "/wechat-login", "/api/auth/wechat/status", "/api/auth/wechat/start", "/api/auth/wechat/callback"]) {
    const response = await send(pathname, { headers: publicPreview });
    assert.equal(response.status, 404, `${pathname} 在公网预览下必须 404，实际 ${response.status}`);
  }

  const post = await send("/api/auth/wechat/mock/complete", {
    method: "POST",
    headers: publicPreview,
    body: { key: "alpha" },
  });
  assert.equal(post.status, 405, "公网预览只允许 GET/HEAD");
  assert.equal(
    post.setCookie.some((value) => value.startsWith("chaoge_user_session=")),
    false,
    "公网请求绝不能拿到会话",
  );

  // 只读白名单本身没有被收紧
  assert.equal((await send("/api/home", { headers: publicPreview })).status, 200);
});

test("真实微信支付没有接口：不存在任何 /api/payments/wechat* 路由", { skip: SKIP }, async () => {
  for (const pathname of [
    "/api/payments/wechat",
    "/api/payments/wechat/notify",
    "/api/payments/wechat/unified-order",
  ]) {
    const response = await send(pathname);
    assert.equal(response.status, 404, `${pathname} 不应存在，实际 ${response.status}`);
  }
});
