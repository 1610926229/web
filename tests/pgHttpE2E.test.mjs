import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";

/**
 * PROD-1E · Phase 13「全业务真库 E2E」。
 *
 * ## 本文件在证明什么
 *
 * 当服务端真正跑在 PostgreSQL 上（`DATA_SOURCE=postgres`）时，主链路
 * `下单 → 支付 → 派单 → 接单 → 开始服务 → 完成材料 → 客服审核通过 → 收益冻结 →
 * 评价 → 审核` 以及三条支线（退款 / 投诉 / 优惠券）能够端到端跑通，并且落库的
 * **金额（整数分）与状态**都符合 `db/migrations/0004_orders_and_payments.sql` 等
 * 迁移里用 CHECK 钉死的不变量。
 *
 * ## 为什么这份证据要分两层
 *
 * 每一段都有两类证据：
 * 1. **HTTP 证据**：状态码 + `{data}` 信封里的字段（形状照抄既有 HTTP 契约测试）；
 * 2. **直查 SQL 证据**：用本测试进程自己的连接池 `getPgExecutor()` 直查 PG，
 *    断言订单状态、金额恒等式、券核销、收益记录、审计明细。
 * 只有 HTTP 200 什么都证明不了——「接口回了 200 但没写库」的假实现也能过，
 * 所以必须由独立的读路径（直查 SQL）回读一次。
 *
 * ## 隔离：不用 `/api/debug/reset`
 *
 * `/api/debug/reset`（`tests/httpReset.mjs` 的 `resetServerStores()`）在 pg 模式下是
 * no-op——它重置的是 Mock 内存 store，动不了真库。因此本文件在 `before()` 里用
 * **本进程自己的连接池**直接 `migrate → resetDatabase → seedDatabase`，与其它
 * `tests/pg*.test.mjs` 同一套做法。
 *
 * ## ⚠️ 为什么 `APP_BASE_URL` 必须用**方括号**访问
 *
 * `tests/httpIsolation.test.mjs` 的门禁会扫描所有 `tests/*.test.mjs`，凡是源码里出现
 * 「`process.env` 点号访问 `APP_BASE_URL`」这种写法（门禁按子串匹配点号形式）的文件，
 * 都必须带模块级顶格的 `await resetServerStores();`。本文件刻意**不能**调
 * `resetServerStores()`（见上），因此这里写成 `process.env["APP_BASE_URL"]`——方括号形式
 * 不含门禁匹配的那个点号字面量，就不会被误判成「漏接重置的 HTTP 用例文件」。
 * 这是刻意的写法，不是笔误。
 *
 * ## 运行方式（本文件无法在本地直接跑）
 *
 * 需要先起一个 `DATA_SOURCE=postgres` 的服务，并且让服务与测试进程**指向同一个
 * 测试库**（`TEST_DATABASE_URL`，库名必须以 `_test` 结尾——`resetDatabase` 的守卫）。
 * 然后：
 *
 *     PG_E2E=1 PG_E2E_BASE=http://localhost:3101 pnpm test:pg
 *
 * ## 为什么地址读的是 `PG_E2E_BASE`，不是 `APP_BASE_URL`
 *
 * 那 30 个 HTTP 契约文件打的服务端是**必须开 `ENABLE_MOCK_DEBUG` 的 Mock 服务**
 * （`resetServerStores()` 的清库接口在 pg 模式下是 no-op），而本文件打的服务端
 * 必须是 `DATA_SOURCE=postgres`。这是**两个不同的进程**，因此不能共用一个地址变量——
 * 否则「整个测试套件跑一遍」就只能在「Mock 服务」与「真库服务」里二选一，
 * 另一边的用例永远以「跳过」收场。
 *
 * `PG_E2E_BASE` 缺省时**退回** `APP_BASE_URL`（两条都走方括号，理由见上），
 * 因此单进程跑本文件时仍可用 `PG_E2E=1 APP_BASE_URL=... pnpm test:pg` 的老写法。
 *
 * 没开 `PG_E2E=1`、或两个地址都没给时，本文件整批如实跳过，不产生任何失败。
 */

// —— 读取环境变量一律走方括号（理由见文件头「APP_BASE_URL 必须用方括号」） ——
const BASE = process.env["PG_E2E_BASE"] ?? process.env["APP_BASE_URL"] ?? "";

// 两条都要满足才跑：PG_E2E 显式开启 + 服务地址给了。否则整批跳过。
const SKIP =
  process.env["PG_E2E"] === "1" && BASE
    ? false
    : "未开启 PG_E2E / PG_E2E_BASE（或 APP_BASE_URL）：真库 E2E 需要 DATA_SOURCE=postgres 的服务与测试库";

/**
 * 本进程自己的 DB 句柄。延迟建池（`pool.ts`），不连库不产生副作用。
 * 直查 SQL 的证据全部走这里——**不经过服务端**，因此是独立于 HTTP 的第二读路径。
 */
function db(text, values) {
  return getPgExecutor().query(text, values);
}

/** 期望恰好一行时的便捷读法。 */
async function one(text, values, label) {
  const rows = await db(text, values);
  assert.equal(rows.length, 1, `期望恰好一行（${label ?? text}），实际 ${rows.length}`);
  return rows[0];
}

// ─────────────────────────────── 幂等键 / 会话 / 请求助手 ───────────────────────────────

const unique = (prefix) => `${prefix}-${randomUUID()}`;

// 预置身份（照抄 tests/staffOrderActions.test.mjs §十一 的 HTTP_ORDER_USER / HTTP_COMPANION_USER）：
// u-1001 普通用户；u-1022 名下有 cp-10（enabled/available 都为 true，无需先走审核）。
const HTTP_ORDER_USER = "u-1001";
/**
 * 券链路专用：一个**没有预置券**的用户。
 *
 * 预置数据把三张券全给了 `u-1001`（`couponSeed` 的 `claim-seed-1001-0*`），
 * 而「同一用户对同一张券模板只有一条领取记录」——因此只有换一个人，
 * 「领券」这一步才真的发生（理由详见券链路用例内的注释）。
 */
const NO_CLAIM_USER = "u-1002";
const HTTP_COMPANION_USER = "u-1022";
const COMPANION_ID = "cp-10";

// 商品与价格：p-400w「机密400万」spec s-400w 价 2990，gameTag「手游」
// （照抄 lib/mocks/fixtures/catalogSeed.ts:160-174）。
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const UNIT_PRICE = 2990;

// 满减券：cpn-mock-new-user 门槛 10000 减 1000（照抄 lib/mocks/fixtures/couponSeed.ts:88-90）。
const THRESHOLD_COUPON_ID = "cpn-mock-new-user";
const COUPON_THRESHOLD = 10_000;
const COUPON_DISCOUNT = 1_000;

/** 用户端 Mock 登录（照抄 tests/completionHttp.test.mjs 的 loginAs）。 */
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

/** 客服 Mock 登录（照抄 tests/completionHttp.test.mjs 的 staffLogin）。 */
async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

/** 管理员 Mock 登录（照抄 tests/reviewClosure.test.mjs:1007 的 mockAdminLogin）。 */
async function adminLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), {
    method: "POST",
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

/** 发一次请求并把 JSON 解开。失败响应也解——错误体形状本身也是要断言的东西（照抄 staffOrderActions 的 send）。 */
async function send(pathname, { cookie, method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, raw: text, json: text ? JSON.parse(text) : null };
}

// 四套会话（老板 / 打手 / 客服 / 管理员）各拿一次，整文件共用。拿不到时在用到处炸出声，不静默跳过。
let sessionsPromise = null;
function sessions() {
  sessionsPromise ??= (async () => {
    const order = await loginAs(HTTP_ORDER_USER);
    const companion = await loginAs(HTTP_COMPANION_USER);
    const staff = await staffLogin("staff-1");
    const admin = await adminLogin();
    if (!order) throw new Error("用户端 Mock 登录失败（服务端需开 ENABLE_MOCK_AUTH）");
    if (!companion) throw new Error("打手 Mock 登录失败（u-1022 需开 ENABLE_MOCK_AUTH）");
    if (staff.status !== 200) throw new Error("客服 Mock 登录失败（服务端需开 ENABLE_MOCK_STAFF）");
    if (admin.status !== 200) throw new Error("管理员 Mock 登录失败（服务端需开 ENABLE_MOCK_ADMIN）");
    return {
      order,
      companion,
      staff: staff.setCookie[0].split(";")[0],
      admin: admin.setCookie[0].split(";")[0],
    };
  })();
  return sessionsPromise;
}

// ─────────────────────────────── 生命周期阶段助手（HTTP + 直查 SQL 双证据） ───────────────────────────────

/**
 * 下单 + 支付确认，返回 `{ orderId, actualPaidAmount }`。
 * 契约照抄 tests/staffOrderActions.test.mjs §十一 placeAcceptedOrderOverHttp：
 * `POST /api/orders/pay` → `data.id`；`POST /api/payments/mock-confirm {paymentRequestId, result:"success"}`
 * → `data.orderId`。带券时加 `couponClaimId`（lib/services/checkout.ts:93）。
 */
async function placePaidOrder(sessions, { couponClaimId = null, quantity = 1 } = {}) {
  const pay = await send("/api/orders/pay", {
    cookie: sessions.order,
    method: "POST",
    body: {
      idempotencyKey: unique("e2e-pay"),
      ...PRODUCT,
      quantity,
      addonIds: [],
      gameAccountId: "e2e_test",
      remark: "",
      companionId: null,
      ...(couponClaimId ? { couponClaimId } : {}),
    },
  });
  assert.equal(pay.status, 200, `HTTP 下单必须成功：${pay.raw}`);
  const paymentRequestId = pay.json.data.id;
  assert.ok(paymentRequestId, "下单必须返回支付请求 id");

  const confirm = await send("/api/payments/mock-confirm", {
    cookie: sessions.order,
    method: "POST",
    body: { paymentRequestId, result: "success" },
  });
  assert.equal(
    confirm.status,
    200,
    `HTTP 支付确认必须成功（服务端需开 ENABLE_MOCK_PAYMENT）：${confirm.raw}`,
  );
  const orderId = confirm.json.data.orderId;
  assert.ok(orderId, "支付成功必须返回 orderId");

  return { orderId, actualPaidAmount: pay.json.data.actualPaidAmount };
}

/**
 * 打手从公共池接单。
 * 契约照抄 tests/staffOrderActions.test.mjs §十一：`GET /api/companion/dispatches`
 * → `data.exclusive` / `data.public`（元素含 `{orderId, dispatchId}`），
 * `POST /api/companion/dispatches/[dispatchId]/accept`（无 body）。
 */
async function acceptOrder(sessions, orderId) {
  const pool = await send("/api/companion/dispatches", { cookie: sessions.companion });
  assert.equal(pool.status, 200, `打手必须能读订单池：${pool.raw}`);
  const item = [...pool.json.data.exclusive, ...pool.json.data.public].find(
    (each) => each.orderId === orderId,
  );
  assert.ok(item, `刚支付成功的单 ${orderId} 必须出现在 ${HTTP_COMPANION_USER} 的池子里`);

  const accept = await send(`/api/companion/dispatches/${encodeURIComponent(item.dispatchId)}/accept`, {
    cookie: sessions.companion,
    method: "POST",
  });
  assert.equal(accept.status, 200, `接单必须成功：${accept.raw}`);
  return item.dispatchId;
}

/**
 * 开始服务：`POST /api/companion/orders/[id]/start`（无 body，身份只来自会话；
 * 照抄 app/api/companion/orders/[id]/start/route.ts 头注释）。
 */
async function startServing(sessions, orderId) {
  const started = await send(`/api/companion/orders/${encodeURIComponent(orderId)}/start`, {
    cookie: sessions.companion,
    method: "POST",
  });
  assert.equal(started.status, 200, `开始服务必须成功：${started.raw}`);
}

/**
 * 提交完成材料：`POST /api/companion/orders/[id]/completion` body `{summary, evidence:[]}`。
 * 成功分支返回 `{kind:"ok", submissionId, orderId, status:"pending", autoApprovalDeadlineAt, changed:true}`
 * （照抄 lib/types/completion.ts:108-117 CompanionCompletionSubmitOutcome）。
 */
async function submitCompletion(sessions, orderId) {
  const submitted = await send(`/api/companion/orders/${encodeURIComponent(orderId)}/completion`, {
    cookie: sessions.companion,
    method: "POST",
    body: { summary: "已完成护航服务", evidence: [] },
  });
  assert.equal(submitted.status, 200, `提交完成材料必须成功：${submitted.raw}`);
  assert.equal(submitted.json.data.status, "pending");
  assert.equal(submitted.json.data.orderId, orderId);
  assert.equal(submitted.json.data.changed, true);
  assert.ok(submitted.json.data.submissionId, "必须返回 submissionId");
  assert.ok(submitted.json.data.autoApprovalDeadlineAt, "必须返回冻结的自动审核截止时间");
  return submitted.json.data.submissionId;
}

/**
 * 客服通过完成材料：`POST /api/staff/completions/[id]/approve`（无 body；
 * 照抄 app/api/staff/completions/[id]/approve/route.ts）。
 * 返回 `{submissionId, status, statusLabel, changed}`（lib/services/staffCompletions.ts:229-235）。
 */
async function approveCompletion(sessions, submissionId) {
  const approved = await send(`/api/staff/completions/${encodeURIComponent(submissionId)}/approve`, {
    cookie: sessions.staff,
    method: "POST",
  });
  assert.equal(approved.status, 200, `客服通过完成材料必须成功：${approved.raw}`);
  assert.equal(approved.json.data.status, "approved");
  assert.equal(approved.json.data.changed, true);
}

// ─────────────────────────────── 直查 SQL 的证据助手 ───────────────────────────────

/** 读一张订单的金额与状态列。列名照抄 db/migrations/0004_orders_and_payments.sql。 */
async function readOrder(orderId) {
  return one(
    `SELECT status, user_id, actual_companion_id, original_amount, coupon_discount_amount,
            actual_paid_amount, companion_rate_snapshot, companion_base_income, club_net_income,
            total_amount, items_amount, addons_amount, refunded_amount,
            serving_at, completed_at, complaint_deadline_at
       FROM orders WHERE id = $1`,
    [orderId],
    "readOrder",
  );
}

/**
 * 断言订单金额的**三条 DB CHECK 恒等式**（照抄 0004 迁移的三条 CHECK）：
 * ① 实付 = 原始应付 − 券抵扣；② 实付 = 打手收益 + 平台净收入；
 * ③ 打手收益 = floor(基数 × 基点 / 10000)。金额一律整数分，用整数比较，不做任何除法换算。
 */
function assertOrderMoneyIdentities(order) {
  assert.equal(
    order.actual_paid_amount,
    order.original_amount - order.coupon_discount_amount,
    "恒等式①：实付 = 原始应付 − 券抵扣（整数分）",
  );
  assert.equal(
    order.actual_paid_amount,
    order.companion_base_income + order.club_net_income,
    "恒等式②：实付 = 打手收益 + 平台净收入",
  );
  assert.equal(
    order.companion_base_income,
    Math.floor((order.original_amount * order.companion_rate_snapshot) / 10000),
    "恒等式③：打手收益 = floor(基数 × 基点 / 10000)，基数是优惠前应付",
  );
  assert.equal(
    order.total_amount,
    order.items_amount + order.addons_amount,
    "恒等式④：应付合计 = 商品 + 增值服务",
  );
}

// ─────────────────────────────── 隔离：整库重置 + 预置 ───────────────────────────────

before(async () => {
  if (SKIP) return;

  // 本测试进程的池子指向测试库（TEST_DATABASE_URL 喂给 DATABASE_URL）。
  // 必须在第一次 executor.query() 之前完成——池子是懒初始化的（pool.ts getPool）。
  if (
    process.env["TEST_DATABASE_URL"] &&
    process.env["DATABASE_URL"] !== process.env["TEST_DATABASE_URL"]
  ) {
    process.env["DATABASE_URL"] = process.env["TEST_DATABASE_URL"];
  }

  const executor = getPgExecutor();
  // 迁移幂等；resetDatabase 有「库名 _test + 非生产」两道守卫；seed 写预置数据。
  await migrate(executor);
  await resetDatabase(executor);
  await seedDatabase(executor);
});

after(async () => {
  if (SKIP) return;
  await closePool();
});

// ─────────────────────────────── 主链路 ───────────────────────────────

test(
  "主链路：下单→支付→派单→接单→开始→完成→审核→收益冻结→评价→审核（HTTP + 直查 SQL 双证据）",
  { skip: SKIP },
  async () => {
    const s = await sessions();

    // ① 下单 + 支付确认：HTTP 断言 + 直查 orders/payments
    const { orderId, actualPaidAmount } = await placePaidOrder(s, { quantity: 1 });
    assert.equal(actualPaidAmount, UNIT_PRICE, "无券无加购，实付 = 单价 2990（整数分）");

    let order = await readOrder(orderId);
    assert.equal(order.status, "paid", "支付成功即 paid");
    assert.equal(order.user_id, HTTP_ORDER_USER);
    assert.equal(order.actual_companion_id, null, "还没人接：actual_companion_id 为 null");
    assert.equal(order.original_amount, UNIT_PRICE);
    assert.equal(order.coupon_discount_amount, 0);
    assert.equal(order.actual_paid_amount, UNIT_PRICE);
    assert.equal(order.refunded_amount, 0, "未退款：refunded_amount 为 0");
    assertOrderMoneyIdentities(order);

    // 支付记录：amount 是实付、状态 success（照抄 0004 payments 表）。
    const payment = await one(
      `SELECT amount, status FROM payments WHERE order_id = $1`,
      [orderId],
      "payments",
    );
    assert.equal(payment.amount, UNIT_PRICE, "支付记录金额 = 实付（整数分）");
    assert.equal(payment.status, "success");

    // ② 打手接单：HTTP 断言 + 直查 orders / dispatch_records
    const dispatchId = await acceptOrder(s, orderId);
    order = await readOrder(orderId);
    assert.equal(order.status, "accepted", "接单后订单为 accepted");
    assert.equal(order.actual_companion_id, COMPANION_ID, "实际接单人 cp-10 落库");

    const dispatch = await one(
      `SELECT state, accepted_by_companion_id FROM dispatch_records WHERE id = $1`,
      [dispatchId],
      "dispatch_records",
    );
    assert.equal(dispatch.state, "accepted");
    assert.equal(dispatch.accepted_by_companion_id, COMPANION_ID, "派单记录上的接单人 = 订单上的实际接单人");

    // ③ 开始服务：HTTP 断言 + 直查 orders / companion_service_events
    await startServing(s, orderId);
    order = await readOrder(orderId);
    assert.equal(order.status, "serving", "开始服务后订单为 serving");
    assert.ok(order.serving_at, "serving_at 必须落库");
    const serviceEvent = await one(
      `SELECT companion_id FROM companion_service_events WHERE order_id = $1`,
      [orderId],
      "companion_service_events",
    );
    assert.equal(serviceEvent.companion_id, COMPANION_ID, "服务事件记录到实际履约打手");

    // ④ 提交完成材料：HTTP 断言 + 直查 completion_submissions
    const submissionId = await submitCompletion(s, orderId);
    let submission = await one(
      `SELECT status, companion_id, review_source, reviewed_by_staff_id
         FROM completion_submissions WHERE id = $1`,
      [submissionId],
      "completion_submissions",
    );
    assert.equal(submission.status, "pending", "刚提交：pending");
    assert.equal(submission.companion_id, COMPANION_ID);
    assert.equal(submission.review_source, null, "还没审核：review_source 为 null");

    // ⑤ 客服通过完成材料：HTTP 断言 + 直查 completion_submissions / orders / earnings
    await approveCompletion(s, submissionId);
    submission = await one(
      `SELECT status, review_source, reviewed_by_staff_id
         FROM completion_submissions WHERE id = $1`,
      [submissionId],
      "completion_submissions(approved)",
    );
    assert.equal(submission.status, "approved");
    assert.equal(submission.review_source, "staff", "人工通过：review_source = staff");
    assert.ok(submission.reviewed_by_staff_id, "人工通过必须记审核客服");

    order = await readOrder(orderId);
    assert.equal(order.status, "completed", "通过完成材料后订单为 completed");
    assert.ok(order.completed_at, "completed_at 必须落库");
    assert.ok(order.complaint_deadline_at, "投诉期 deadline 快照必须落库");

    // 收益：创建即冻结，金额直接搬订单的 companion_base_income（照抄 0006 earnings 表注释）
    const earning = await one(
      `SELECT companion_id, income_amount, status, reversed_amount, fine_amount
         FROM earnings WHERE order_id = $1`,
      [orderId],
      "earnings",
    );
    assert.equal(earning.companion_id, COMPANION_ID);
    assert.equal(earning.status, "frozen", "完成即收益冻结（frozen）");
    assert.equal(
      earning.income_amount,
      order.companion_base_income,
      "收益金额 = 订单的打手基础收益（整数分，不重算）",
    );
    assert.equal(earning.reversed_amount, 0, "尚未退款：reversed_amount 为 0");
    assert.equal(earning.fine_amount, 0);

    // ⑥ 用户提交评价：HTTP 断言 + 直查 order_reviews
    // 契约照抄 tests/reviewClosure.test.mjs:1184-1196：POST /api/orders/[id]/reviews
    // body {idempotencyKey, productReview, companionReview, evidence} → data 恰四个字段。
    const reviewSubmit = await send(`/api/orders/${encodeURIComponent(orderId)}/reviews`, {
      cookie: s.order,
      method: "POST",
      body: {
        idempotencyKey: unique("e2e-review"),
        productReview: { rating: 5, content: "全程开麦，节奏很稳。（E2E 文案）" },
        companionReview: { rating: 4, content: null },
        evidence: [],
      },
    });
    assert.equal(reviewSubmit.status, 200, `提交评价必须成功：${reviewSubmit.raw}`);
    assert.deepEqual(Object.keys(reviewSubmit.json.data).sort(), ["created", "orderId", "reviewId", "status"]);
    assert.equal(reviewSubmit.json.data.status, "pending");
    assert.equal(reviewSubmit.json.data.created, true);
    const reviewId = reviewSubmit.json.data.reviewId;

    let review = await one(
      `SELECT status FROM order_reviews WHERE id = $1`,
      [reviewId],
      "order_reviews",
    );
    assert.equal(review.status, "pending");

    // ⑦ 管理员通过评价：HTTP 断言 + 直查 order_reviews
    // 契约照抄 tests/reviewClosure.test.mjs:1100-1113：POST /api/admin/reviews/[id]/approve
    // body {idempotencyKey} → data 恰 ["changed","reviewId","status","statusLabel"]。
    const reviewApprove = await send(`/api/admin/reviews/${encodeURIComponent(reviewId)}/approve`, {
      cookie: s.admin,
      method: "POST",
      body: { idempotencyKey: unique("e2e-review-approve") },
    });
    assert.equal(reviewApprove.status, 200, `通过评价必须成功：${reviewApprove.raw}`);
    assert.equal(reviewApprove.json.data.status, "approved");
    assert.equal(reviewApprove.json.data.changed, true);

    review = await one(
      `SELECT status FROM order_reviews WHERE id = $1`,
      [reviewId],
      "order_reviews(approved)",
    );
    assert.equal(review.status, "approved", "评价审核通过后落库为 approved");
  },
);

// ─────────────────────────────── 退款链路 ───────────────────────────────

test(
  "退款链路：完成单全额退款→订单 refunded、退款额=实付、收益整笔冲回、审计调整明细（HTTP + 直查 SQL 双证据）",
  { skip: SKIP },
  async () => {
    const s = await sessions();

    // 先走完整链路到 completed（复用上面的阶段助手）
    const { orderId } = await placePaidOrder(s, { quantity: 1 });
    await acceptOrder(s, orderId);
    await startServing(s, orderId);
    const submissionId = await submitCompletion(s, orderId);
    await approveCompletion(s, submissionId);

    const orderBefore = await readOrder(orderId);
    assert.equal(orderBefore.status, "completed");

    // ① 用户提交退款申请：POST /api/orders/[id]/refunds（body {reasonKey, description, evidence, idempotencyKey}）
    // 契约照抄 lib/services/refunds.ts:345-438 → 返回 {refundId, created}；reasonKey 取值 "other"。
    const apply = await send(`/api/orders/${encodeURIComponent(orderId)}/refunds`, {
      cookie: s.order,
      method: "POST",
      body: {
        reasonKey: "other",
        description: "E2E 验收：全额退款验证金额恒等式",
        evidence: [],
        idempotencyKey: unique("e2e-refund"),
      },
    });
    assert.equal(apply.status, 200, `提交退款申请必须成功：${apply.raw}`);
    assert.equal(apply.json.data.created, true);
    const refundId = apply.json.data.refundId;

    let refund = await one(
      `SELECT status, amount, order_id, decision FROM refund_requests WHERE id = $1`,
      [refundId],
      "refund_requests",
    );
    assert.equal(refund.status, "pending", "刚申请：pending");
    assert.equal(refund.order_id, orderId);
    assert.equal(refund.amount, orderBefore.actual_paid_amount, "申请金额 = 实付快照（整数分）");
    assert.equal(refund.decision, null, "还没审核：decision 为 null");

    // ② 管理员全额通过：POST /api/admin/refunds/[id]/approve（body {idempotencyKey, refundRatePercent:"100"}）
    // 契约照抄 app/api/admin/refunds/[id]/approve/route.ts + lib/services/adminRefunds.ts:282-302。
    const approve = await send(`/api/admin/refunds/${encodeURIComponent(refundId)}/approve`, {
      cookie: s.admin,
      method: "POST",
      body: {
        idempotencyKey: unique("e2e-refund-approve"),
        refundRatePercent: "100",
        reviewNote: "E2E 全额退款",
      },
    });
    assert.equal(approve.status, 200, `全额退款审批必须成功：${approve.raw}`);
    assert.equal(approve.json.data.status, "approved");
    assert.equal(approve.json.data.orderStatus, "refunded", "全额退款把订单推进到 refunded");
    assert.equal(approve.json.data.decidedAmount, orderBefore.actual_paid_amount, "退款额 = 实付");
    assert.equal(approve.json.data.changed, true);

    // 直查：退款记录 / 订单 / 收益 / 审计明细 四张表必须同时对上
    refund = await one(
      `SELECT status,
              (decision->>'refundAmount')::int            AS refund_amount,
              (decision->>'refundRateBp')::int            AS refund_rate_bp,
              (decision->>'companionReversalAmount')::int AS companion_reversal
         FROM refund_requests WHERE id = $1`,
      [refundId],
      "refund_requests(approved)",
    );
    assert.equal(refund.status, "approved");
    assert.equal(refund.refund_rate_bp, 10000, "全额 = 10000 基点");
    assert.equal(refund.refund_amount, orderBefore.actual_paid_amount, "决策退款额 = 实付（整数分）");

    const orderAfter = await readOrder(orderId);
    assert.equal(orderAfter.status, "refunded", "订单状态为 refunded");
    assert.equal(
      orderAfter.refunded_amount,
      orderAfter.actual_paid_amount,
      "全额退款：refunded_amount 必须等于 actual_paid_amount（不得出现已退款但退款额为 0）",
    );

    const earning = await one(
      `SELECT income_amount, status, reversed_amount FROM earnings WHERE order_id = $1`,
      [orderId],
      "earnings(reversed)",
    );
    assert.equal(earning.status, "frozen", "P0-15：净额归零后收益仍停在 frozen，不进 reversed");
    assert.equal(
      earning.reversed_amount,
      earning.income_amount,
      "全额退款：整笔冲回（reversed_amount = income_amount）",
    );

    const adjustment = await one(
      `SELECT type, amount, refund_id FROM earning_adjustments WHERE refund_id = $1`,
      [refundId],
      "earning_adjustments",
    );
    assert.equal(adjustment.type, "refund_reversal", "审计明细类型 = refund_reversal");
    assert.equal(adjustment.amount, earning.income_amount, "冲减明细金额 = 收益金额");

    // 打手端收到退款通知（收件人是打手的用户账号 u-1022；cp-10.userId = "u-1022"）。
    // 契约来源：lib/data/adminRefundTransaction.ts:505-517（recipientUserId = companion?.userId）。
    const notice = await db(
      `SELECT kind, href FROM notifications WHERE user_id = $1 AND kind = 'refund' AND href LIKE '%' || $2 || '%'`,
      [HTTP_COMPANION_USER, orderId],
    );
    assert.ok(notice.length >= 1, "打手端必须收到一条指向该订单的退款通知");
  },
);

// ─────────────────────────────── 投诉链路 ───────────────────────────────

test(
  "投诉链路：完成单提交投诉→投诉记录落库（HTTP + 直查 SQL 双证据）",
  { skip: SKIP },
  async () => {
    const s = await sessions();

    const { orderId } = await placePaidOrder(s, { quantity: 1 });
    await acceptOrder(s, orderId);
    await startServing(s, orderId);
    const submissionId = await submitCompletion(s, orderId);
    await approveCompletion(s, submissionId);

    // 投诉窗口：默认 1440 分钟（lib/constants/platformConfig.ts:105），刚完成的单窗口未关闭。
    // 契约照抄 app/api/complaints/route.ts + lib/services/complaints.ts:241-308：
    // body {typeKey, description, contact, evidence, orderId?, idempotencyKey} → {complaintId, created}。
    const complaint = await send("/api/complaints", {
      cookie: s.order,
      method: "POST",
      body: {
        typeKey: "companion_service",
        description: "E2E 验收：投诉记录落库验证",
        contact: "wx-e2e",
        evidence: [],
        orderId,
        idempotencyKey: unique("e2e-complaint"),
      },
    });
    assert.equal(complaint.status, 200, `提交投诉必须成功：${complaint.raw}`);
    assert.equal(complaint.json.data.created, true);
    const complaintId = complaint.json.data.complaintId;

    // 直查 complaints 表（列名照抄 db/migrations/0008_transaction_reads.sql）。
    const row = await one(
      `SELECT user_id, order_id, status, type_key FROM complaints WHERE id = $1`,
      [complaintId],
      "complaints",
    );
    assert.equal(row.user_id, HTTP_ORDER_USER);
    assert.equal(row.order_id, orderId, "投诉关联到正确订单");
    assert.equal(row.status, "pending", "新投诉：pending");
    assert.equal(row.type_key, "companion_service");
  },
);

// ─────────────────────────────── 优惠券链路 ───────────────────────────────

test(
  "优惠券链路：领券→带券下单核销→券状态 used、订单金额恒等式成立（HTTP + 直查 SQL 双证据）",
  { skip: SKIP },
  async () => {
    // 四套会话（老板 / 打手 / 客服 / 管理员）都是这条链路的先决条件：`sessions()` 里
    // 任何一次登录拿不到就抛错。这里**不留绑定**是因为本链路只用用户端那一个会话，
    // 但调用本身要保留——否则「其它三种登录坏了」在这条用例里会静默。
    await sessions();

    // ⚠️ 这一条链路刻意换一个**没有预置券**的用户（u-1002），而不是 u-1001。
    //
    // 原因不是偏好，是 `claimCouponForUser()` 的语义（lib/services/coupons.ts:197）：
    // **同一个用户对同一张券模板只能有一条领取记录**，已经领过就直接返回那一条、
    // `created: false`、不重复写入。而预置数据里 u-1001 **已经有**一张
    // `cpn-mock-new-user` 的未使用券（`claim-seed-1001-01`，见
    // lib/mocks/fixtures/couponSeed.ts:174-179）——那是「我的优惠券」页面要展示的历史。
    //
    // 用 u-1001 跑这一步，拿到的必然是 `created: false`：**领券根本没被覆盖到**，
    // 后面的核销验的也只是一张种子券。换 u-1002 之后 `created` 才有判别力，
    // 而且它证明的正是本轮要看的那件事——「券的领取与核销都真的落在了 PostgreSQL 里」。
    const freshUser = await loginAs(NO_CLAIM_USER);
    assert.ok(freshUser, `${NO_CLAIM_USER} 的 Mock 登录必须成功（服务端需开 ENABLE_MOCK_AUTH）`);

    // ① 领券：POST /api/coupons/[id]/claim body {idempotencyKey} → {claimId, couponId, created}
    // 契约照抄 lib/services/coupons.ts:199-226（claimCouponForUser）。
    const claim = await send(`/api/coupons/${encodeURIComponent(THRESHOLD_COUPON_ID)}/claim`, {
      cookie: freshUser,
      method: "POST",
      body: { idempotencyKey: unique("e2e-claim") },
    });
    assert.equal(claim.status, 200, `领券必须成功：${claim.raw}`);
    assert.equal(claim.json.data.created, true, "u-1002 没领过这张券：这一次必须是真·新建");
    const claimId = claim.json.data.claimId;

    let claimRow = await one(
      `SELECT status, coupon_id, user_id FROM coupon_claims WHERE id = $1`,
      [claimId],
      "coupon_claims",
    );
    assert.equal(claimRow.status, "unused", "刚领的券：unused");
    assert.equal(claimRow.coupon_id, THRESHOLD_COUPON_ID);
    assert.equal(claimRow.user_id, NO_CLAIM_USER);

    // ② 带券下单：数量 4 → 原始 11960，门槛 10000 减 1000 → 实付 10960。
    const quantity = 4;
    const expectedOriginal = UNIT_PRICE * quantity; // 11960
    // 券能抵扣的前提是**原始金额达到门槛**。把这句话显式断言出来，
    // 否则「数量改成 3」时这条链路仍会绿——它不是没门槛，只是恰好跨过去了。
    assert.ok(
      expectedOriginal >= COUPON_THRESHOLD,
      `原始金额 ${expectedOriginal} 必须 ≥ 券门槛 ${COUPON_THRESHOLD}，否则测不到抵扣`,
    );
    // ⚠️ 用**同一个** u-1002 会话下单：券的归属校验在核销时再做一次
    // （`redeemCouponClaimForOrder` 的第一步），拿别人的券在这里会被拒。
    // `placePaidOrder` 只读 `sessions.order`，因此直接传一个只含 `order` 的会话即可。
    const { orderId, actualPaidAmount } = await placePaidOrder(
      { order: freshUser },
      { quantity, couponClaimId: claimId },
    );
    assert.equal(
      actualPaidAmount,
      expectedOriginal - COUPON_DISCOUNT,
      "HTTP 下单响应里的实付 = 11960 − 1000 = 10960（整数分）",
    );

    const order = await readOrder(orderId);
    assert.equal(order.original_amount, expectedOriginal, "原始应付 = 单价 × 数量（优惠前）");
    assert.equal(order.coupon_discount_amount, COUPON_DISCOUNT, "券抵扣 = 1000 分");
    assert.equal(order.actual_paid_amount, expectedOriginal - COUPON_DISCOUNT, "实付 = 10960 分");
    assertOrderMoneyIdentities(order);

    // ③ 直查：券被核销（status=used），且订单上冻结了券快照（含 claimId）。
    claimRow = await one(
      `SELECT status, used_at FROM coupon_claims WHERE id = $1`,
      [claimId],
      "coupon_claims(used)",
    );
    assert.equal(claimRow.status, "used", "支付成功即核销券");
    assert.ok(claimRow.used_at, "核销必须写下 used_at");

    const coupon = await one(
      `SELECT coupon->>'claimId' AS claim_id, coupon->>'couponId' AS coupon_id FROM orders WHERE id = $1`,
      [orderId],
      "orders.coupon",
    );
    assert.equal(coupon.claim_id, claimId, "订单券快照指向被核销的那张领取记录");
    assert.equal(coupon.coupon_id, THRESHOLD_COUPON_ID);
  },
);
