import assert from "node:assert/strict";
import test from "node:test";

import { COMPANION_EARNINGS_NOTICE } from "../lib/constants/earnings.ts";

/**
 * P0-9 HTTP 契约 —— 打手收益接口（`GET /api/companion/earnings`）的权限矩阵与只读契约。
 *
 * ## 只测守卫、只读与信封形状，不造一笔真的完成
 *
 * 一次「完成订单」的 HTTP 调用会在共享内存里留下真实订单与收益，而且会被后续读路径的
 * 清扫顺手自动通过——污染同进程的其它 HTTP 用例。因此「完成 → 冻结 → 解冻」这条链
 * 由 `tests/earning.test.mjs` 在进程内的伪事务层覆盖；这里只回答：
 * **谁连门都进不来、谁进门后被拒，以及这个接口在 HTTP 面上到底吐出了什么字段。**
 *
 * 依赖真实服务：没设 `APP_BASE_URL` 时整批自动跳过（与 `http-smoke.test.mjs` /
 * `completionHttp.test.mjs` 同一取舍）。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://127.0.0.1:3100），跳过 P0-9 收益接口 HTTP 契约";

const PATH = "/api/companion/earnings";

/**
 * 打手端收益 DTO 的**全部**字段（`CompanionEarningItem`，恰好八个）。
 *
 * 白名单在这里再钉一遍：`tests/earning.test.mjs` 已在服务层钉过同一个集合，
 * 但那一层钉的是「函数返回了什么」，这里钉的是「HTTP 响应里真的出现了什么」——
 * 中间隔着一个响应序列化，两个边界都值得有一次断言。
 */
const DTO_KEYS = [
  "id",
  "orderNo",
  "orderId",
  "incomeAmount",
  "status",
  "statusLabel",
  "frozenAt",
  "availableAt",
];

/** 明确**不得**出现在打手端响应里的字段（平台账 / 内部归属 / 未实现的钱包域）。 */
const FORBIDDEN_KEYS = [
  "companionId",
  "clubNetIncome",
  "userPaidAmount",
  "companionRateBp",
  "withdrawnAt",
  "reversedAmount",
  "fineAmount",
  "userId",
  "order",
  "earning",
];

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

/** 发一个请求，返回状态码 + JSON（非 JSON 响应留 null）。 */
async function getEarnings({ cookie, method = "GET", pathname = PATH } = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应（如网关错误页）留空
  }
  return { status: response.status, json };
}

/** u-1001 是预置普通用户（名下没有护航资料）。u-1022 名下是 `cp-10`，一个**有效打手**。 */
const SESSION_PLAIN = BASE ? await loginAs("u-1001") : null;
const SESSION_COMPANION = BASE ? await loginAs("u-1022") : null;
const SKIP_SESSION =
  SKIP || (SESSION_PLAIN ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

test("收益接口 1：未登录 401，且伪造的用户 Cookie 与不存在的用户 id 同样是 401", { skip: SKIP }, async () => {
  const anon = await getEarnings();
  assert.equal(anon.status, 401);
  assert.equal(anon.json?.error?.code, "UNAUTHORIZED");

  // 守卫必须在**读任何输入**之前成立：这个接口连查询参数都不接，
  // 因此「带上别人的 companionId 就能看到别人的收益」这种参数位根本不存在
  const withParams = await getEarnings({
    pathname: `${PATH}?companionId=cp-1&companionId=cp-2&userId=u-1001`,
  });
  assert.equal(withParams.status, 401, "带查询参数不改变「未登录」这个事实");

  // 伪造 / 指向一个不存在的用户：会话查不到 → 与未登录同一句话
  for (const forged of ["mock_user_id=u-does-not-exist", "mock_user_id=", "mock_admin_id=admin-1"]) {
    const response = await getEarnings({ cookie: forged });
    assert.equal(response.status, 401, `（${forged}）应当 401`);
    assert.equal(response.json?.error?.code, "UNAUTHORIZED");
  }
});

test("收益接口 2：已登录但不是护航 403（普通用户），只带客服 Cookie 是 401（不是 403）", { skip: SKIP_SESSION }, async () => {
  assert.ok(SESSION_PLAIN, "预置普通用户 u-1001 必须能登录");
  const plain = await getEarnings({ cookie: SESSION_PLAIN });
  assert.equal(plain.status, 403, "登录了但名下没有有效护航资料 → 403");
  assert.equal(plain.json?.error?.code, "FORBIDDEN");

  // ⚠️ 客服是**另一套 Cookie**（`mock_staff_id`），而打手复用**用户**会话（`mock_user_id`）。
  // 因此「只带客服 Cookie」在这个接口上就是**未登录**，答案是 401 而不是 403。
  // 这一条钉住的是「不要把它写成 403」——写错会让验收的人以为权限出了问题。
  //
  // ⚠️ **两条分支都必须有断言**（与 `completionHttp.test.mjs` 同一写法）：
  // 只写 `if (200) { assert 401 }` 而不写 else，会让「客服端开关关掉 / 预置被改」
  // 时这一整段断言**静默蒸发**，用例却仍然绿着——那正是这条钉子唯一要防的事。
  const login = await staffLogin("staff-1");
  if (login.status === 200 && login.setCookie.length > 0) {
    const staffCookie = login.setCookie[0].split(";")[0];
    const asStaff = await getEarnings({ cookie: staffCookie });
    assert.equal(asStaff.status, 401, "客服会话 ≠ 用户会话：在这个接口上它是「未登录」");
    assert.equal(asStaff.json?.error?.code, "UNAUTHORIZED");
  } else {
    // 客服端开关关闭：真实客服 id 的**伪造** Cookie 同样进不来（401）。
    // 这一条仍然是「客服会话不等于用户会话」的同一个事实，只是换了种证法
    const forged = await getEarnings({ cookie: "mock_staff_id=staff-1" });
    assert.equal(forged.status, 401, "开关关闭时伪造客服 Cookie 也应当 401");
    assert.equal(forged.json?.error?.code, "UNAUTHORIZED");
  }
});

test("收益接口 3：有效打手 200，信封形状与字段白名单都在 HTTP 边界上成立", { skip: SKIP_SESSION }, async () => {
  assert.ok(SESSION_COMPANION, "预置有效打手 u-1022 必须能登录");

  const response = await getEarnings({ cookie: SESSION_COMPANION });
  assert.equal(response.status, 200);

  const data = response.json?.data;
  assert.ok(data, "响应信封必须有 data");
  assert.deepEqual(Object.keys(data).sort(), ["items", "notice", "summary"]);
  assert.equal(data.notice, COMPANION_EARNINGS_NOTICE, "说明文案由服务端给，页面不自己拼");

  assert.equal(Array.isArray(data.items), true, "items 必须是数组");
  assert.deepEqual(Object.keys(data.summary).sort(), ["availableAmount", "count", "frozenAmount"]);
  assert.equal(data.summary.count, data.items.length, "合计的条数必须等于列表长度");

  // 两个桶都是**整数「分」**，不是浮点求和的结果
  for (const key of ["frozenAmount", "availableAmount"]) {
    assert.equal(Number.isInteger(data.summary[key]), true, `summary.${key} 必须是整数分`);
  }
  assert.equal(
    data.summary.frozenAmount + data.summary.availableAmount,
    data.items.reduce((total, item) => total + item.incomeAmount, 0),
    "两个桶之和必须等于列表里所有收益之和",
  );

  // ⚠️ 这里**不**造一笔真的完成（会污染共享内存），因此「有新收益时字段恰好八个」
  // 由 `tests/earning.test.mjs` 在服务层钉住；本用例负责的是**任何时候都不许出现**的
  // 那些字段——包括列表为空时（信封本身不得夹带内部实体）
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.equal(forbidden in data, false, `响应信封不得带 ${forbidden}`);
    assert.equal(forbidden in data.summary, false, `summary 不得带 ${forbidden}`);
  }
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), [...DTO_KEYS].sort(), "收益项必须恰好是那八个字段");
    for (const forbidden of FORBIDDEN_KEYS) {
      assert.equal(forbidden in item, false, `收益项不得带 ${forbidden}`);
    }
  }
});

test("收益接口 4：只读——写方法与不支持的动词一律 405，且不产生任何副作用", { skip: SKIP }, async () => {
  // 该 route 只导出 `GET`。Next 的路由层对「路由存在但方法没导出」的回答是 405，
  // 因此这里断言的是**契约**：这个阶段没有提现、没有余额调整，也就没有写入口。
  //
  // ⚠️ 用「改动前后的条数相同」而不是「条数 == 0」：本批次共享一个进程内 Mock Store，
  // 别的 HTTP 用例可能已经完成过订单，写死 0 会让这条用例变成对执行顺序的断言。
  const baseline = SESSION_COMPANION
    ? (await getEarnings({ cookie: SESSION_COMPANION })).json?.data?.summary?.count
    : null;

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const anonymous = await getEarnings({ method });
    assert.equal(anonymous.status, 405, `匿名 ${method} 应当 405`);

    // 带**有效打手**会话也一样：不是「守卫拦住了」，而是这个动词根本不存在
    if (SESSION_COMPANION) {
      const asCompanion = await getEarnings({ method, cookie: SESSION_COMPANION });
      assert.equal(asCompanion.status, 405, `打手 ${method} 应当 405（没有写入口）`);
    }
  }

  // 405 之后 GET 仍然正常，且条数与写尝试之前一致：说明那几次尝试什么都没改
  if (SESSION_COMPANION) {
    const after = await getEarnings({ cookie: SESSION_COMPANION });
    assert.equal(after.status, 200);
    assert.equal(after.json?.data?.summary?.count, baseline, "写尝试不得凭空造出收益记录");
  }
});
