import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETION_ORDER_NOT_FOUND_MESSAGE,
  COMPLETION_SUMMARY_EMPTY_MESSAGE,
} from "../lib/constants/completions.ts";

/**
 * P0-8 HTTP 契约 —— 打手提交接口与客服完成材料接口的权限矩阵。
 *
 * ⚠️ 只测**守卫与失败路径**，不写任何一条成功提交：一次成功的 HTTP 提交会在共享
 * 内存里留下真实完成材料、并可能被读取路径的清扫自动通过，污染其它 HTTP 用例。
 * 因此「成功提交 + 200」「到期自动通过」这些路径由 `tests/completions.test.mjs`
 * 在进程内的伪事务层覆盖，这里只回答「谁连门都进不来 / 谁进门后被哪一句文案拒掉」。
 *
 * 依赖真实服务：没设 `APP_BASE_URL` 时整批自动跳过（与 `http-smoke.test.mjs` 同一取舍）。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P0-8 完成材料 HTTP 契约";

async function loginAs(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

async function requestWithCookie(pathname, cookie, init) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应（如网关错误页）留空
  }
  return { status: response.status, json, response };
}

/**
 * u-1001 是预置普通用户（非打手）。u-1022 名下是 `cp-10`
 * （`enabled` / `available` 都为 true），一个**有效打手**。
 */
const SESSION_PLAIN = BASE ? await loginAs("u-1001") : null;
const SESSION_COMPANION = BASE ? await loginAs("u-1022") : null;
const SKIP_SESSION =
  SKIP || (SESSION_PLAIN ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

/** 打手提交完成材料。请求体由调用方决定（含刻意发坏体的失败路径）。 */
async function submitCompletion(orderId, { cookie, body }) {
  const response = await fetch(
    new URL(`/api/companion/orders/${encodeURIComponent(orderId)}/completion`, BASE),
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body,
    },
  );
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应留空
  }
  return { status: response.status, json };
}

const VALID_SUBMIT_BODY = JSON.stringify({ summary: "已完成护航服务", evidence: [] });

test("打手提交完成材料：未登录 401、非打手 403、非本人 / 不存在 404、空说明 400（四者都不写数据）", { skip: SKIP_SESSION }, async () => {
  // (1) 未登录：守卫先于请求体，三种体都 401（体里塞 companionId 也一点用没有）
  for (const body of [undefined, "{}", JSON.stringify({ companionId: "cp-1" })]) {
    const anon = await submitCompletion("ord-p08-not-exist", { body });
    assert.equal(anon.status, 401, `未登录应当 401（体：${body}）`);
    assert.equal(anon.json?.error?.code, "UNAUTHORIZED");
  }

  // (2) 登录了但不是打手：普通用户 403
  assert.ok(SESSION_PLAIN, "预置普通用户 u-1001 必须能登录");
  const plain = await submitCompletion("ord-p08-not-exist", { cookie: SESSION_PLAIN, body: VALID_SUBMIT_BODY });
  assert.equal(plain.status, 403);
  assert.equal(plain.json?.error?.code, "FORBIDDEN");

  // (3) 有效打手 + 不存在 / 不是本人的单：404，与「订单不存在」同一句话
  assert.ok(SESSION_COMPANION, "预置有效打手 u-1022 必须能登录");
  const missing = await submitCompletion("ord-p08-not-exist", { cookie: SESSION_COMPANION, body: VALID_SUBMIT_BODY });
  assert.equal(missing.status, 404);
  assert.equal(missing.json?.error?.code, "NOT_FOUND");
  assert.equal(missing.json?.error?.message, COMPLETION_ORDER_NOT_FOUND_MESSAGE);

  // 预置里 cp-2 名下 accepted 的单：状态恰好是 accepted，但履约人不是我 → 归属先于状态，404
  const others = await submitCompletion("ord-seed-1001-11", { cookie: SESSION_COMPANION, body: VALID_SUBMIT_BODY });
  assert.equal(others.status, 404, "不是本人实际履约 → 404，与不存在同一句话");
  assert.equal(others.json?.error?.code, "NOT_FOUND");

  // (4) 参数校验失败：空说明 400（在事务之前就拒绝，不写任何数据）
  const emptySummary = await submitCompletion("ord-p08-not-exist", { cookie: SESSION_COMPANION, body: JSON.stringify({ summary: "  " }) });
  assert.equal(emptySummary.status, 400);
  assert.equal(emptySummary.json?.error?.code, "BAD_REQUEST");
  assert.equal(emptySummary.json?.error?.message, COMPLETION_SUMMARY_EMPTY_MESSAGE);
});

/** 客服完成材料 4 个接口：列表、详情、通过、驳回。 */
const STAFF_ROUTES = [
  ["GET", "/api/staff/completions"],
  ["GET", "/api/staff/completions/cs-does-not-exist"],
  ["POST", "/api/staff/completions/cs-does-not-exist/approve"],
  ["POST", "/api/staff/completions/cs-does-not-exist/reject"],
];

test("客服完成材料 4 个接口：匿名一律 401（与客服端开关无关）", { skip: SKIP }, async () => {
  for (const [method, pathname] of STAFF_ROUTES) {
    const response = await requestWithCookie(pathname, null, { method });
    assert.equal(response.status, 401, `${method} ${pathname} 匿名应当 401`);
  }
});

test("客服完成材料 4 个接口：伪造客服 Cookie（用户 / 管理员 / 不存在的客服 id）一律 401", { skip: SKIP }, async () => {
  for (const forged of ["mock_staff_id=u-1001", "mock_staff_id=admin-1", "mock_staff_id=staff-999"]) {
    for (const [method, pathname] of STAFF_ROUTES) {
      const response = await requestWithCookie(pathname, forged, { method });
      assert.equal(response.status, 401, `${method} ${pathname}（${forged}）应当 401`);
    }
  }
});

test("客服完成材料 4 个接口：停用 / 已移除客服 403，有效客服可读列表", { skip: SKIP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) {
    // 客服端开关关闭：连真实客服 id 的伪造 Cookie 也进不来（401），这是开关关闭的正确行为
    for (const [method, pathname] of STAFF_ROUTES) {
      const response = await requestWithCookie(pathname, "mock_staff_id=staff-1", { method });
      assert.equal(response.status, 401, `开关关闭时 ${method} ${pathname} 应当 401`);
    }
    return;
  }

  // 记录查得到但进不来（停用 / 已移除）→ 与「订单不存在」同体的 403
  for (const id of ["staff-3", "staff-4", "staff-5"]) {
    for (const [method, pathname] of STAFF_ROUTES) {
      const response = await requestWithCookie(pathname, `mock_staff_id=${id}`, { method });
      assert.equal(response.status, 403, `${method} ${pathname}（${id}）应当 403`);
    }
  }

  // 有效客服能读列表（只读，不写数据）
  const staffCookie = login.setCookie[0].split(";")[0];
  const list = await requestWithCookie("/api/staff/completions", staffCookie);
  assert.equal(list.status, 200);
  assert.ok(list.json?.data, "列表信封必须有 data");
});
