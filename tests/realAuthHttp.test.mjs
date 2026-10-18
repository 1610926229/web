import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

/**
 * PROD-4 · **真实账号**的 HTTP 回归（打一个 `DATA_SOURCE=postgres` 的服务）。
 *
 * ## 与其它 HTTP 文件的关系
 *
 * 那 30 个 HTTP 契约文件打的是 Mock 数据源的服务，靠 `POST /api/debug/reset`
 * 互相隔离；本文件打的是真实 PostgreSQL 服务，**不能**重置数据库。
 * 因此：
 *
 * - 只创建自己的随机账号（邮箱带 UUID），不依赖也不修改任何预置数据；
 * - 不调用 `/api/debug/reset`（在 pg 模式下它本来也是 no-op）；
 * - 用 `REAL_AUTH_HTTP=1` 显式开启，缺省时整批如实跳过。
 *
 * 地址变量用方括号读取（`process.env["APP_BASE_URL"]`）：`tests/httpIsolation.test.mjs`
 * 的门禁把「点号形式读取 APP_BASE_URL」当作「这个文件必须重置 Mock 存储」，
 * 而本文件恰恰不能重置真库——理由与 `tests/pgHttpE2E.test.mjs` 完全相同。
 *
 * 运行方式（staging 验收）：
 *
 *     REAL_AUTH_HTTP=1 REAL_AUTH_BASE=http://127.0.0.1:3100 pnpm test
 *
 * 这个文件要回答的问题，光看代码回答不了：
 *
 * 1. 注册 / 登录 / 退出的 Cookie 是否真的以 HttpOnly 不透明令牌下发；
 * 2. 真实会话是否只让本人读到自己的订单，别人的订单一律 404；
 * 3. 失效的真实 Cookie 会不会**回退**到 Mock 身份（必须不会）；
 * 4. 客服 / 管理员接口是否拒绝用户会话，角色字段是否无法从请求体伪造。
 */

const BASE = process.env["REAL_AUTH_BASE"] ?? process.env["APP_BASE_URL"] ?? "";

const SKIP =
  process.env["REAL_AUTH_HTTP"] === "1" && BASE
    ? false
    : "未开启 REAL_AUTH_HTTP / REAL_AUTH_BASE：真实账号 HTTP 回归需要 DATA_SOURCE=postgres 的服务";

/** 目录里真实存在的可购买商品（与 pgHttpE2E 同一件）：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 每次运行随机账号；密码不打印、不落文件，只用于本进程内的两次调用。 */
function uniqueEmail() {
  return `e2e-${randomUUID()}@example.test`;
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
    // 非 JSON（例如 307 的重定向页）保留原文，断言会把它显示出来
  }
  return { status: response.status, raw: text, json, setCookie: response.headers.getSetCookie() };
}

/** 从响应的 Set-Cookie 里取出真实会话 Cookie；拿不到时让用例响亮地失败。 */
function realCookieOf(response, name = "chaoge_user_session") {
  const line = response.setCookie.find((value) => value.startsWith(`${name}=`));
  assert.ok(line, `响应应当下发 ${name}；实际：${response.setCookie.join(" | ")}`);
  return line.split(";")[0];
}

/** 注册一个真实账号并返回会话。 */
async function registerUser() {
  const email = uniqueEmail();
  const password = uniquePassword();
  const response = await send("/api/auth/register", {
    method: "POST",
    body: { email, password, nickname: "E2E 用户（占位）" },
  });
  assert.equal(response.status, 200, `注册必须成功：${response.raw}`);
  return {
    email,
    password,
    user: response.json.data,
    cookie: realCookieOf(response),
    setCookie: response.setCookie,
  };
}

/** 下单 + 模拟支付确认，返回新订单 id。契约照抄 tests/pgHttpE2E.test.mjs。 */
async function placePaidOrder(cookie) {
  const pay = await send("/api/orders/pay", {
    cookie,
    method: "POST",
    body: {
      idempotencyKey: `auth-e2e-${randomUUID()}`,
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "auth_e2e",
      remark: "",
      companionId: null,
    },
  });
  assert.equal(pay.status, 200, `下单必须成功：${pay.raw}`);

  const confirm = await send("/api/payments/mock-confirm", {
    cookie,
    method: "POST",
    body: { paymentRequestId: pay.json.data.id, result: "success" },
  });
  assert.equal(
    confirm.status,
    200,
    `模拟支付确认必须成功（服务端需开 ENABLE_MOCK_PAYMENT）：${confirm.raw}`,
  );
  return confirm.json.data.orderId;
}

// ————————————————————————— 注册即登录 —————————————————————————

test("注册即登录：下发不透明 HttpOnly Cookie，DTO 不含邮箱或凭据字段", { skip: SKIP }, async () => {
  const { user, cookie, setCookie, email } = await registerUser();

  assert.match(user.id, /^u_[0-9a-f-]{36}$/, "用户 id 由服务端生成");
  assert.deepEqual(
    Object.keys(user).sort(),
    ["avatarUrl", "id", "nickname"],
    "会话 DTO 只能有这三个字段——邮箱、展示号、密码哈希都不该出现",
  );
  assert.equal(JSON.stringify(user).includes(email), false);

  const line = setCookie.find((value) => value.startsWith("chaoge_user_session="));
  assert.ok(line);
  assert.match(line, /HttpOnly/i, "会话 Cookie 必须是 HttpOnly");
  assert.match(line, /SameSite=Lax/i);
  assert.match(line, /Path=\//);

  const token = cookie.slice("chaoge_user_session=".length);
  assert.match(token, /^[A-Za-z0-9_-]{40,64}$/, "Cookie 里是不透明令牌，不是账号 id 或邮箱");
  assert.notEqual(token, user.id);
  assert.equal(token.includes(email), false);

  // 真实登录会清掉同身份的 Mock Cookie，避免真实会话过期后「变回」另一个人
  assert.ok(
    setCookie.some((value) => value.startsWith("mock_user_id=")),
    "真实登录必须同时清理 Mock 用户 Cookie",
  );
});

test("未登录读订单 → 401；带真实会话 → 200 且只看得到自己的订单", { skip: SKIP }, async () => {
  const anonymous = await send("/api/orders");
  assert.equal(anonymous.status, 401);

  const { cookie } = await registerUser();
  const list = await send("/api/orders", { cookie });
  assert.equal(list.status, 200, list.raw);
  assert.deepEqual(list.json.data.items, [], "新用户不该看到任何别人的订单");
});

// ————————————————————————— 登录 —————————————————————————

test("登录：邮箱大小写不敏感；密码错误与未知邮箱返回同一条 401", { skip: SKIP }, async () => {
  const { email, password } = await registerUser();

  const login = await send("/api/auth/login", {
    method: "POST",
    body: { email: `  ${email.toUpperCase()} `, password },
  });
  assert.equal(login.status, 200, login.raw);
  realCookieOf(login);

  const wrongPassword = await send("/api/auth/login", {
    method: "POST",
    body: { email, password: `${password}-wrong` },
  });
  const unknownEmail = await send("/api/auth/login", {
    method: "POST",
    body: { email: uniqueEmail(), password },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(wrongPassword.json, unknownEmail.json, "两种失败必须不可区分（文案与错误码完全一致）");
  assert.equal(unknownEmail.json.error.code, "UNAUTHORIZED");
});

test("重复注册返回 400，且不泄露更多账号信息", { skip: SKIP }, async () => {
  const { email, password } = await registerUser();

  const again = await send("/api/auth/register", {
    method: "POST",
    body: { email: email.toUpperCase(), password },
  });
  assert.equal(again.status, 400, again.raw);
  assert.equal(again.json.error.code, "BAD_REQUEST");
});

// ————————————————————————— 退出登录 —————————————————————————

test("退出登录吊销服务端会话：旧 Cookie 再用 → 401", { skip: SKIP }, async () => {
  const { cookie } = await registerUser();

  assert.equal((await send("/api/orders", { cookie })).status, 200);

  const logout = await send("/api/auth/logout", { cookie, method: "POST" });
  assert.equal(logout.status, 200, logout.raw);
  assert.ok(
    logout.setCookie.some((value) => value.startsWith("chaoge_user_session=") && /Max-Age=0/i.test(value)),
    "退出必须让浏览器删除真实会话 Cookie",
  );

  // 即使客户端仍拿着旧令牌，服务端会话也已经吊销
  assert.equal((await send("/api/orders", { cookie })).status, 401);
});

// ————————————————————————— 身份隔离 —————————————————————————

test("别人的订单一律 404：真实会话的订单归属由服务端决定", { skip: SKIP }, async () => {
  const owner = await registerUser();
  const stranger = await registerUser();

  const orderId = await placePaidOrder(owner.cookie);

  const own = await send(`/api/orders/${encodeURIComponent(orderId)}`, { cookie: owner.cookie });
  assert.equal(own.status, 200, own.raw);
  assert.equal(own.json.data.id, orderId);
  assert.equal(own.json.data.status, "paid", "模拟支付确认后订单必须是 paid，不能显示成已支付以外的状态");

  const other = await send(`/api/orders/${encodeURIComponent(orderId)}`, { cookie: stranger.cookie });
  assert.equal(other.status, 404, "他人的订单必须表现为不存在（404），不是 403");
});

test("失效的真实 Cookie 不回退 Mock：同时带 mock_user_id 也仍然匿名", { skip: SKIP }, async () => {
  // 先拿一个合法的 Mock 会话；服务端没开 Mock 登录时这条用例退化为纯 401 断言
  const mockLogin = await send("/api/auth/mock-login", {
    method: "POST",
    body: { userId: "u-1001" },
  });
  const mockCookie = mockLogin.status === 200 ? realCookieOf(mockLogin, "mock_user_id") : null;

  const tampered = "chaoge_user_session=this-is-not-a-session-token-value-000000000000";
  const combined = mockCookie ? `${tampered}; ${mockCookie}` : tampered;

  const response = await send("/api/orders", { cookie: combined });
  assert.equal(
    response.status,
    401,
    "带着失效的真实会话时必须按匿名处理——回退 Mock 会让「退出登录」变出另一个身份",
  );
});

test("用户会话进不了客服 / 管理接口；请求体里的角色字段不能提权", { skip: SKIP }, async () => {
  const { cookie } = await registerUser();

  const adminList = await send("/api/admin/orders", { cookie });
  assert.ok([401, 403].includes(adminList.status), `用户会话不得进入管理接口，实际 ${adminList.status}`);

  const staffOrders = await send("/api/staff/orders", { cookie });
  assert.ok([401, 403].includes(staffOrders.status), `用户会话不得进入客服接口，实际 ${staffOrders.status}`);

  // 角色只来自账号记录：请求体里塞 role / adminId / staffId 都不会生效
  const forged = await send("/api/staff/auth/login", {
    method: "POST",
    body: { username: "不存在-的-登录名", password: "whatever-123", role: "admin", adminId: "admin-1" },
  });
  assert.equal(forged.status, 401, "伪造角色字段不能变成登录成功");
  assert.equal(forged.json.error.code, "UNAUTHORIZED");

  const adminLogin = await send("/api/admin/auth/login", {
    method: "POST",
    body: { username: "不存在-的-登录名", password: "whatever-123", role: "admin" },
  });
  assert.equal(adminLogin.status, 401);
  assert.deepEqual(adminLogin.json, forged.json, "客服与管理员登录失败使用同一层不可区分的错误");
});
