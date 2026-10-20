import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";
import { fileURLToPath } from "node:url";
import {
  ADMIN_AFTERSALE_CASE_TYPE_INVALID_MESSAGE,
  ADMIN_AFTERSALE_DATE_INVALID_MESSAGE,
  ADMIN_AFTERSALE_MAX_PAGE,
  ADMIN_AFTERSALE_MAX_PAGE_SIZE,
  ADMIN_AFTERSALE_VIEW_INVALID_MESSAGE,
  AFTERSALE_IN_PROGRESS_STATUSES,
  aftersaleComplaintStatusesForView,
  aftersaleComplaintViewOf,
  aftersaleInDateRange,
  aftersaleMatchesKeyword,
  aftersaleRefundStatusesForView,
  aftersaleRefundViewOf,
  buildAdminAftersaleListQuery,
  compareAftersaleRowsNewestFirst,
  normalizeAdminAftersaleCaseType,
  normalizeAdminAftersaleView,
  readAdminAftersaleCaseType,
  readAdminAftersaleView,
} from "../lib/constants/adminAftersales.ts";
import { COMPLAINT_STATUSES, OPEN_COMPLAINT_STATUSES } from "../lib/constants/complaints.ts";
import { OPEN_REFUND_STATUSES, REFUND_STATUSES } from "../lib/constants/refunds.ts";
import { getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { getRefundRepository } from "../lib/data/refundRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { MOCK_ADMIN_LOGIN_ID } from "../lib/mocks/fixtures/adminSeed.ts";
import {
  getAdminAftersaleDetail,
  queryAdminAftersaleList,
  resolveAdminAftersaleListQuery,
} from "../lib/services/adminAftersales.ts";
import { getAdminOrderDetail } from "../lib/services/adminOrders.ts";

/**
 * P1-3「管理员售后 / 投诉统一工作台」的回归测试。
 *
 * 被测对象是三份新文件（`lib/types/aftersale.ts`、`lib/constants/adminAftersales.ts`、
 * `lib/services/adminAftersales.ts`）加一个只读接口 `app/api/admin/aftersales/route.ts`。
 *
 * 工作台**只读**：它把退款申请与投诉并进一张待办队列，处置动作仍然留在
 * 各自专用页面。因此这里没有写事务、没有金额公式，守的是几条**读侧**不变量：
 *
 * 1. `counts` 三桶口径（`all === open + closed`、`processing ⊆ open`）与「四视图 counts 一致」
 *    —— 这是防「把视图下沉到仓储层收窄、导致另外两个桶恒为 0」这个真实历史缺陷；
 *    同时钉死「open 是未完结全集、含 processing」这一 BLOCKER 语义（D-P1-3-8）：
 *    `open` 页签必须能看到 `reviewing` 退款与 `processing` 投诉，不能按「精确桶 === 视图」收窄；
 * 2. 视图反函数对（`aftersale*ViewOf` ↔ `aftersale*StatusesForView`）与
 *    `processing ⊆ open`、`closed = open 补集`（D-P1-3-2）；
 * 3. 筛选口径：`caseType` / 日期 / 关键词五路（**不搜**说明、正文、联系方式）；
 * 4. DTO 最小化：行 DTO 不整包返回订单 / 用户 / 打手实体，投诉金额是 `null` 不是 `0`；
 * 5. 详情聚合：无订单投诉的 `order` 是 `null` 而不是整体 404（D-P1-3-4）。
 *
 * 鉴权用「成对正反例」：结构上断言 `requireAdmin()` 是第一步（不依赖真实服务），
 * 加一组走 `APP_BASE_URL` 的 HTTP 用例（匿名 401 / 客服 403 / 管理员 200），
 * 未设置 `APP_BASE_URL` 时该组自动跳过——与 `tests/admin.test.mjs` 同一套做法。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API_DIR = path.join(ROOT, "app", "api", "admin");
const SURFACE = "server";
const ROW_VIEWS = ["open", "processing", "closed"];

const BASE = process.env.APP_BASE_URL;

// ⚠️ 必须在**发起任何请求之前**执行——这一行加上 --test-concurrency=1，才是「本文件的断言读到的是预置状态」的保证。
await resetServerStores();
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过售后工作台 HTTP 用例";

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(file) {
  return readFileSync(file, "utf8");
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 默认查询：全部、不限、第一页、足够大的 pageSize。 */
function query(overrides = {}) {
  return {
    view: "all",
    caseType: "all",
    keyword: "",
    from: "",
    to: "",
    page: 1,
    pageSize: 100,
    ...overrides,
  };
}

function runList(overrides = {}) {
  return queryAdminAftersaleList(query(overrides), undefined, SURFACE);
}

async function requestWithCookie(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function mockLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  return { status: response.status };
}

beforeEach(() => {
  // 售后工作台只读，但详情聚合会触达订单 / 会话 / 派单 / 完成等仓储，
  // 逐一清干净，避免用例之间共享同一份内存。
  resetMockStore("payment");
  resetMockStore("refund");
  resetMockStore("complaint");
  resetMockStore("user");
  resetMockStore("companion");
  resetMockStore("dispatch");
  resetMockStore("completion");
  resetMockStore("message");
  resetMockStore("review");
  resetMockStore("companionRelease");
  resetMockStore("earning");
});

// ——————————————————————————— counts 与视图收窄 ———————————————————————————

test("counts 三桶口径与四视图一致：open 是未完结全集、processing 是它的子集（防视图下沉到仓储的缺陷）", async () => {
  // D-P1-3-2 / D-P1-3-8：open 含 processing（未完结全集），closed 是 open 的补集。
  // 因此 all === open + closed、processing ⊆ open；三桶求和 ≠ all（open 与 processing 刻意重叠）。
  const expected = { all: 12, open: 7, processing: 3, closed: 5 };
  for (const view of ["all", "open", "processing", "closed"]) {
    const data = await runList({ view });

    // 两个构造性恒等式，与「三桶求和 === all」无关（那条已经不成立）
    assert.equal(
      data.counts.open + data.counts.closed,
      data.counts.all,
      `view=${view} 时 open + closed 必须等于 all`,
    );
    assert.ok(data.counts.processing <= data.counts.open, `view=${view} 时 processing 必须 ⊆ open`);

    // 无论停在哪个视图，四个角标都来自同一批数据的分桶，不被当前视图收窄
    assert.deepEqual(data.counts, expected, `view=${view} 时 counts 被视图收窄了或分桶错误`);

    if (view === "all") {
      assert.equal(data.total, data.counts.all);
      assert.equal(data.items.length, 12);
    } else {
      assert.equal(data.total, data.counts[view], `view=${view} 时 total 应等于该桶条数`);
      for (const row of data.items) {
        if (view === "open") {
          // open 是未完结全集：精确桶为 open 或 processing 的行都属于它
          assert.notEqual(row.view, "closed", `open 视图不该有 closed 行 ${row.id}`);
        } else if (view === "processing") {
          assert.equal(row.view, "processing", `processing 视图下混入了 view=${row.view} 的行 ${row.id}`);
        } else {
          assert.equal(row.view, "closed", `closed 视图下混入了 view=${row.view} 的行 ${row.id}`);
        }
      }
    }
  }
});

test("counts 与 OPEN/IN_PROGRESS 常量独立分桶一致（不经过 aftersale*ViewOf）", async () => {
  const [refunds, complaints] = await Promise.all([
    getRefundRepository().queryRefundsForAdmin({ statuses: null }),
    getComplaintRepository().queryComplaintsForAdmin({ statuses: null, type: null }),
  ]);

  // 独立重算服务端 counts 的口径：open = 未完结全集（含 processing），
  // closed = 补集，processing = 已接手子集。与 aftersale*ViewOf 完全无关。
  const expected = { all: 0, open: 0, processing: 0, closed: 0 };
  for (const refund of refunds) {
    expected.all += 1;
    const inOpen = OPEN_REFUND_STATUSES.includes(refund.status);
    const inProgress = AFTERSALE_IN_PROGRESS_STATUSES.refund.includes(refund.status);
    if (inOpen) expected.open += 1;
    else expected.closed += 1;
    if (inProgress) expected.processing += 1;
  }
  for (const complaint of complaints) {
    expected.all += 1;
    const inOpen = OPEN_COMPLAINT_STATUSES.includes(complaint.status);
    const inProgress = AFTERSALE_IN_PROGRESS_STATUSES.complaint.includes(complaint.status);
    if (inOpen) expected.open += 1;
    else expected.closed += 1;
    if (inProgress) expected.processing += 1;
  }

  assert.deepEqual(expected, { all: 12, open: 7, processing: 3, closed: 5 });

  const data = await runList({ view: "all" });
  assert.deepEqual(data.counts, expected);
});

test("view=open 不再漏掉已接手的案件：reviewing 退款与 processing 投诉都在未完结里（D-P1-3-8 守门人）", async () => {
  const open = await runList({ view: "open" });
  assert.equal(open.total, 7, "未完结总数应是 7");
  assert.equal(open.items.length, 7);
  // 角标必须等于该视图真实条数（这正是角标口径，counts.open === 点开「未完结」看到的条数）
  assert.equal(open.counts.open, open.total, "counts.open 必须等于 view=open 的总条数");

  const ids = open.items.map((row) => row.id);
  // 已接手的案件绝不能从「未完结」漏掉：reviewing 退款 + processing 投诉
  // （第一版拿 row.view === "open" 收窄，正是把这三条漏掉的 BLOCKER 缺陷）
  assert.ok(ids.includes("rf-seed-1001-02"), "reviewing 退款（rf-seed-1001-02）不该从未完结漏掉");
  assert.ok(ids.includes("cmp-seed-1001-02"), "processing 投诉（cmp-seed-1001-02）不该从未完结漏掉");
  assert.ok(ids.includes("cmp-seed-1002-01"), "processing 投诉（cmp-seed-1002-01）不该从未完结漏掉");

  // 已结束的绝不能混进未完结
  assert.ok(!ids.includes("rf-seed-1001-03"), "approved 退款（rf-seed-1001-03）不该出现在未完结");
  assert.ok(!ids.includes("cmp-seed-1001-03"), "resolved 投诉（cmp-seed-1001-03）不该出现在未完结");
});

// ——————————————————————————— 视图反函数对（D-P1-3-2）———————————————————————————

/**
 * 「精确桶」：status 落在 view 的状态集合里，且**不落在更细的 processing 集合里**。
 *
 * ⚠️ 这里不能用字面的「status ∈ statusesForView(v) ⟺ viewOf(status) === v」，
 * 因为 D-P1-3-2 明令 `processing ⊆ open`（不是互斥三桶）：`reviewing` 同时落在
 * `statusesForView("open")` 与 `statusesForView("processing")` 里，而 `viewOf("reviewing")`
 * 是 `processing`。因此「互为反函数」的正确口径是：viewOf 返回**最细的那一桶**，
 * open 桶的精确集合 = open − processing。逐格断言时对 open 视图要扣掉 processing。
 */
function inExactBucket(statusesForView, status, view) {
  return (
    statusesForView(view).includes(status) &&
    (view !== "open" || !statusesForView("processing").includes(status))
  );
}

test("退款视图反函数对：对全部 RefundStatus 逐格断言「精确桶 ⟺ viewOf === view」", () => {
  for (const status of REFUND_STATUSES) {
    for (const view of ROW_VIEWS) {
      const exact = inExactBucket(aftersaleRefundStatusesForView, status, view);
      assert.equal(
        exact,
        aftersaleRefundViewOf(status) === view,
        `refund ${status} × view ${view} 反函数不一致`,
      );
    }
  }
});

test("投诉视图反函数对：对全部 ComplaintStatus 逐格断言「精确桶 ⟺ viewOf === view」", () => {
  for (const status of COMPLAINT_STATUSES) {
    for (const view of ROW_VIEWS) {
      const exact = inExactBucket(aftersaleComplaintStatusesForView, status, view);
      assert.equal(
        exact,
        aftersaleComplaintViewOf(status) === view,
        `complaint ${status} × view ${view} 反函数不一致`,
      );
    }
  }
});

test("processing 是 open 的子集；closed 是 open 的补集；open 复用唯一常量", () => {
  // open 必须是 OPEN_* 常量**本身**，不是复制出的第二套
  assert.equal(aftersaleRefundStatusesForView("open"), OPEN_REFUND_STATUSES);
  assert.equal(aftersaleComplaintStatusesForView("open"), OPEN_COMPLAINT_STATUSES);
  assert.equal(aftersaleRefundStatusesForView("all"), null);
  assert.equal(aftersaleComplaintStatusesForView("all"), null);

  for (const status of REFUND_STATUSES) {
    const inOpen = OPEN_REFUND_STATUSES.includes(status);
    const inProcessing = AFTERSALE_IN_PROGRESS_STATUSES.refund.includes(status);
    const inClosed = aftersaleRefundStatusesForView("closed").includes(status);
    if (inProcessing) {
      assert.ok(inOpen, `refund ${status} 在 processing 里就必须在 open 里（子集）`);
    }
    assert.equal(inClosed, !inOpen, `refund ${status} closed 必须是 open 的补集`);
  }
  for (const status of COMPLAINT_STATUSES) {
    const inOpen = OPEN_COMPLAINT_STATUSES.includes(status);
    const inProcessing = AFTERSALE_IN_PROGRESS_STATUSES.complaint.includes(status);
    const inClosed = aftersaleComplaintStatusesForView("closed").includes(status);
    if (inProcessing) {
      assert.ok(inOpen, `complaint ${status} 在 processing 里就必须在 open 里（子集）`);
    }
    assert.equal(inClosed, !inOpen, `complaint ${status} closed 必须是 open 的补集`);
  }
});

// ——————————————————————————— 查询解析：strict vs non-strict ———————————————————————————

test("视图与案件类型读取：空值回默认，非法值 null，normalize 回落默认", () => {
  assert.equal(readAdminAftersaleView(null), "open");
  assert.equal(readAdminAftersaleView(""), "open");
  assert.equal(readAdminAftersaleView("   "), "open");
  assert.equal(readAdminAftersaleView("all"), "all");
  assert.equal(readAdminAftersaleView("closed"), "closed");
  assert.equal(readAdminAftersaleView("bogus"), null);
  assert.equal(normalizeAdminAftersaleView("bogus"), "open");

  assert.equal(readAdminAftersaleCaseType(null), "all");
  assert.equal(readAdminAftersaleCaseType(""), "all");
  assert.equal(readAdminAftersaleCaseType("refund"), "refund");
  assert.equal(readAdminAftersaleCaseType("complaint"), "complaint");
  assert.equal(readAdminAftersaleCaseType("bogus"), null);
  assert.equal(normalizeAdminAftersaleCaseType("bogus"), "all");
});

test("接口解析：非法 view / caseType / 日期 / 倒序区间在 strict 下抛 400", async () => {
  await assert.rejects(
    () => resolveAdminAftersaleListQuery(page({ view: "bogus" }), true),
    { code: "BAD_REQUEST", status: 400, message: ADMIN_AFTERSALE_VIEW_INVALID_MESSAGE },
  );
  await assert.rejects(
    () => resolveAdminAftersaleListQuery(page({ caseType: "bogus" }), true),
    { code: "BAD_REQUEST", status: 400, message: ADMIN_AFTERSALE_CASE_TYPE_INVALID_MESSAGE },
  );
  await assert.rejects(
    () => resolveAdminAftersaleListQuery(page({ from: "2026-13-45" }), true),
    { code: "BAD_REQUEST", status: 400, message: ADMIN_AFTERSALE_DATE_INVALID_MESSAGE },
  );
  await assert.rejects(
    () => resolveAdminAftersaleListQuery(page({ from: "2026-09-12", to: "2026-09-01" }), true),
    { code: "BAD_REQUEST", status: 400, message: ADMIN_AFTERSALE_DATE_INVALID_MESSAGE },
  );
});

test("页面解析：非法值在 non-strict 下回落默认 / 不限，倒序区间丢成不限日期", async () => {
  const normalized = await resolveAdminAftersaleListQuery(
    page({ view: "bogus", caseType: "bogus" }),
    false,
  );
  assert.equal(normalized.view, "open");
  assert.equal(normalized.caseType, "all");

  const reversed = await resolveAdminAftersaleListQuery(
    page({ from: "2026-09-12", to: "2026-09-01" }),
    false,
  );
  assert.equal(reversed.from, "");
  assert.equal(reversed.to, "");
});

// ——————————————————————————— 筛选 ———————————————————————————

test("caseType 筛选：只留下该类型，且 counts 含 caseType 筛选", async () => {
  const refunds = await runList({ caseType: "refund" });
  assert.equal(refunds.total, 7);
  assert.ok(refunds.items.every((row) => row.caseType === "refund"));
  assert.deepEqual(refunds.counts, { all: 7, open: 4, processing: 1, closed: 3 });

  const complaints = await runList({ caseType: "complaint" });
  assert.equal(complaints.total, 5);
  assert.ok(complaints.items.every((row) => row.caseType === "complaint"));
  assert.deepEqual(complaints.counts, { all: 5, open: 3, processing: 2, closed: 2 });
});

test("aftersaleInDateRange：闭区间、北京自然日、坏时间戳按不在范围", () => {
  // 2026-09-12T01:20Z → 北京时间 09-12
  const row = { submittedAt: "2026-09-12T01:20:00.000Z" };
  assert.equal(aftersaleInDateRange(row, "", ""), true);
  assert.equal(aftersaleInDateRange(row, "2026-09-12", "2026-09-12"), true);
  assert.equal(aftersaleInDateRange(row, "2026-09-13", ""), false);
  assert.equal(aftersaleInDateRange(row, "", "2026-09-11"), false);
  assert.equal(aftersaleInDateRange({ submittedAt: "not-a-date" }, "2026-09-12", "2026-09-12"), false);
});

test("日期筛选：北京时间自然日闭区间，与列表展示同一天筛得到", async () => {
  const day = await runList({ from: "2026-09-12", to: "2026-09-12" });
  assert.deepEqual(
    day.items.map((row) => row.id).sort(),
    ["rf-seed-1001-02", "rf-seed-1001-04", "rf-seed-1002-01"],
  );
  assert.deepEqual(day.counts, { all: 3, open: 2, processing: 1, closed: 1 });

  const only = await runList({ from: "2026-09-01", to: "2026-09-01" });
  assert.deepEqual(only.items.map((row) => row.id), ["rf-seed-1003-01"]);
});

test("aftersaleMatchesKeyword：空关键词命中，五路任一命中，大小写不敏感", () => {
  const input = {
    caseNo: "RF-01",
    orderNo: "YM-01",
    nickname: "老板A",
    displayId: "abc123",
    companionName: "阿泽",
  };
  assert.equal(aftersaleMatchesKeyword(input, ""), true);
  assert.equal(aftersaleMatchesKeyword(input, "   "), true);
  assert.equal(aftersaleMatchesKeyword(input, "rf-01"), true);
  assert.equal(aftersaleMatchesKeyword(input, "ym-01"), true);
  assert.equal(aftersaleMatchesKeyword(input, "老板a"), true);
  assert.equal(aftersaleMatchesKeyword(input, "ABC123"), true);
  assert.equal(aftersaleMatchesKeyword(input, "阿泽"), true);
  assert.equal(aftersaleMatchesKeyword(input, "不存在的词"), false);
});

test("关键词只搜五路：案件号/订单号/昵称/展示ID/打手昵称，不搜说明/正文/联系方式", async () => {
  const byNickname = await runList({ keyword: "老板A" });
  assert.equal(byNickname.total, 9);
  assert.ok(byNickname.items.every((row) => row.user.nickname === "老板A（占位）"));

  const byDisplayId = await runList({ keyword: "3f2a9c14" });
  assert.equal(byDisplayId.total, 9);

  const byCompanion = await runList({ keyword: "阿泽" });
  assert.equal(byCompanion.total, 3);
  assert.ok(byCompanion.items.every((row) => row.companion?.name === "阿泽（占位）"));

  const byCaseNo = await runList({ keyword: "RF20260912" });
  assert.deepEqual(
    byCaseNo.items.map((row) => row.id).sort(),
    ["rf-seed-1001-02", "rf-seed-1001-04", "rf-seed-1002-01"],
  );

  const byOrderNo = await runList({ keyword: "YM20260904000110" });
  assert.deepEqual(byOrderNo.items.map((row) => row.id), ["cmp-seed-1001-01"]);

  // 隐私负例：说明 / 正文 / 联系方式 / 凭证里的词一个都不能命中
  for (const keyword of ["出差", "微信同手机号", "掉线"]) {
    const empty = await runList({ keyword });
    assert.equal(empty.total, 0, `关键词「${keyword}」不应命中任何行`);
    assert.deepEqual(empty.counts, { all: 0, open: 0, processing: 0, closed: 0 });
  }
});

// ——————————————————————————— 排序 ———————————————————————————

test("compareAftersaleRowsNewestFirst：时间倒序，同时间按 caseType 升序，再按 id 升序", () => {
  const mk = (submittedAt, caseType, id) => ({ submittedAt, caseType, id });
  assert.ok(
    compareAftersaleRowsNewestFirst(mk("2026-09-12T00:00Z", "refund", "a"), mk("2026-09-11T00:00Z", "refund", "b")) < 0,
    "时间更近的排前面",
  );
  assert.ok(
    compareAftersaleRowsNewestFirst(mk("2026-09-12T00:00Z", "complaint", "a"), mk("2026-09-12T00:00Z", "refund", "a")) < 0,
    "同时间 complaint 在 refund 之前",
  );
  assert.ok(
    compareAftersaleRowsNewestFirst(mk("2026-09-12T00:00Z", "refund", "a"), mk("2026-09-12T00:00Z", "complaint", "a")) > 0,
  );
  assert.ok(
    compareAftersaleRowsNewestFirst(mk("2026-09-12T00:00Z", "refund", "a"), mk("2026-09-12T00:00Z", "refund", "b")) < 0,
    "同时间同类型按 id 升序",
  );
  assert.equal(
    compareAftersaleRowsNewestFirst(mk("2026-09-12T00:00Z", "refund", "a"), mk("2026-09-12T00:00Z", "refund", "a")),
    0,
  );
});

test("列表排序：提交时间倒序，最新在前（种子时间戳不重叠）", async () => {
  const data = await runList({ view: "all" });
  assert.deepEqual(
    data.items.map((row) => row.id),
    [
      "rf-seed-1001-04", // 09-12 14:00
      "rf-seed-1002-01", // 09-12 09:40
      "rf-seed-1001-02", // 09-12 01:20
      "rf-seed-1001-01", // 09-11 15:10
      "cmp-seed-1001-03", // 09-10 08:00
      "rf-seed-1001-03", // 09-09 11:40
      "rf-seed-1001-05", // 09-08 10:00
      "cmp-seed-1002-01", // 09-07 05:00
      "cmp-seed-1001-02", // 09-05 06:20
      "cmp-seed-1001-01", // 09-04 13:00
      "cmp-seed-1001-04", // 09-02 03:00
      "rf-seed-1003-01", // 09-01 09:30
    ],
  );
});

// ——————————————————————————— 分页 ———————————————————————————

test("分页：page/pageSize 生效，翻页不重不漏", async () => {
  const page1 = await runList({ view: "all", page: 1, pageSize: 5 });
  assert.equal(page1.items.length, 5);
  assert.equal(page1.total, 12);
  assert.equal(page1.hasMore, true);

  const page2 = await runList({ view: "all", page: 2, pageSize: 5 });
  assert.equal(page2.items.length, 5);
  assert.equal(page2.hasMore, true);

  const page3 = await runList({ view: "all", page: 3, pageSize: 5 });
  assert.equal(page3.items.length, 2);
  assert.equal(page3.hasMore, false);

  const paged = [...page1.items, ...page2.items, ...page3.items].map((row) => row.id);
  assert.equal(new Set(paged).size, 12, "翻页不得重复");

  const full = await runList({ view: "all" });
  assert.deepEqual(paged, full.items.map((row) => row.id));
});

test("分页越界规范化：page/pageSize 夹到安全范围", () => {
  const clamped = buildAdminAftersaleListQuery({
    params: page({ page: "0", pageSize: "999999" }),
    view: "all",
    caseType: "all",
    from: "",
    to: "",
  });
  assert.equal(clamped.page, 1);
  assert.equal(clamped.pageSize, ADMIN_AFTERSALE_MAX_PAGE_SIZE);

  const clamped2 = buildAdminAftersaleListQuery({
    params: page({ page: "9999999", pageSize: "1" }),
    view: "all",
    caseType: "all",
    from: "",
    to: "",
  });
  assert.equal(clamped2.page, ADMIN_AFTERSALE_MAX_PAGE);
  assert.equal(clamped2.pageSize, 1);
});

// ——————————————————————————— DTO 最小化 ———————————————————————————

const ROW_KEYS = [
  "amount",
  "caseNo",
  "caseType",
  "caseTypeLabel",
  "companion",
  "decidedAmount",
  "id",
  "orderId",
  "orderNo",
  "orderStatus",
  "orderStatusLabel",
  "productTitle",
  "status",
  "statusLabel",
  "submittedAt",
  "user",
  "view",
].sort();

test("行 DTO 最小化：顶层字段集合钉死，用户与打手快照都是最小形状", async () => {
  const data = await runList({ view: "all" });
  assert.equal(data.items.length, 12);

  for (const row of data.items) {
    assert.deepEqual(Object.keys(row).sort(), ROW_KEYS, `row ${row.id} 顶层字段集合`);
    assert.deepEqual(Object.keys(row.user).sort(), ["displayId", "id", "nickname"], "用户摘要只有三项");
    if (row.companion) {
      assert.deepEqual(
        Object.keys(row.companion).sort(),
        ["avatarUrl", "id", "name"],
        "打手快照只有三项",
      );
    }
  }
});

test("行 DTO 隐私：不含游戏账号/备注/说明/正文/凭证/联系方式与平台财务字段", async () => {
  const data = await runList({ view: "all" });
  const forbiddenTopLevel = [
    "gameAccountId",
    "remark",
    "description",
    "evidence",
    "contact",
    "reviewNote",
    "reasonKey",
    "reasonLabel",
    "result",
    "typeKey",
    "typeLabel",
    "refundNo",
    "complaintNo",
    "companionBaseIncome",
    "platformNetIncome",
    "actualPaidAmount",
    "refundedAmount",
    "itemsAmount",
    "addonsAmount",
    "totalAmount",
    "companionReversalAmount",
  ];

  for (const row of data.items) {
    for (const key of forbiddenTopLevel) {
      assert.equal(key in row, false, `row ${row.id} 顶层不该有 ${key}`);
    }
  }

  const serialized = JSON.stringify(data.items);
  for (const token of ["openid", "unionId", "gameAccountId", "reviewNote"]) {
    assert.equal(serialized.includes(token), false, `序列化结果不该出现 ${token}`);
  }
});

test("金额口径：投诉 amount/decidedAmount 恒 null（不是 0），全额退款 decidedAmount === amount", async () => {
  const data = await runList({ view: "all" });
  const byId = new Map(data.items.map((row) => [row.id, row]));

  for (const row of data.items) {
    if (row.caseType === "complaint") {
      assert.equal(row.amount, null, `投诉 ${row.id} amount 应为 null`);
      assert.equal(row.decidedAmount, null, `投诉 ${row.id} decidedAmount 应为 null`);
    } else {
      assert.equal(typeof row.amount, "number", `退款 ${row.id} amount 应为数字`);
      assert.ok(row.amount > 0, `退款 ${row.id} amount 应大于 0`);
    }
  }

  // rf-seed-1001-03 是 100% 全额退款：核定金额 = 申请时的实付快照
  const approved = byId.get("rf-seed-1001-03");
  assert.equal(approved.decidedAmount, approved.amount, "全额退款 decidedAmount 应等于 amount");

  // 其余退款都未决策：decidedAmount 为 null，不是 0
  for (const id of [
    "rf-seed-1001-01",
    "rf-seed-1001-02",
    "rf-seed-1001-04",
    "rf-seed-1001-05",
    "rf-seed-1003-01",
    "rf-seed-1002-01",
  ]) {
    assert.equal(byId.get(id).decidedAmount, null, `${id} 未决策应 null`);
  }
});

// ——————————————————————————— 详情聚合（D-P1-3-4）———————————————————————————

test("详情聚合：退款带订单，投诉带订单，无订单投诉 order 为 null（不是整体 404）", async () => {
  const refundDetail = await getAdminAftersaleDetail("refund", "rf-seed-1001-03", undefined, SURFACE);
  assert.ok(refundDetail, "退款详情应可读");
  assert.equal(refundDetail.caseType, "refund");
  assert.ok(refundDetail.refund);
  assert.equal(refundDetail.refund.id, "rf-seed-1001-03");
  assert.equal(refundDetail.complaint, null);
  assert.ok(refundDetail.order);
  assert.equal(refundDetail.order.id, "ord-seed-1001-06");

  const complaintDetail = await getAdminAftersaleDetail("complaint", "cmp-seed-1001-01", undefined, SURFACE);
  assert.ok(complaintDetail, "投诉详情应可读");
  assert.equal(complaintDetail.caseType, "complaint");
  assert.ok(complaintDetail.complaint);
  assert.equal(complaintDetail.complaint.id, "cmp-seed-1001-01");
  assert.equal(complaintDetail.refund, null);
  assert.ok(complaintDetail.order);
  assert.equal(complaintDetail.order.id, "ord-seed-1001-10");

  // cmp-seed-1001-04 不关联订单：order 为 null，投诉本身仍完整可读
  const noOrder = await getAdminAftersaleDetail("complaint", "cmp-seed-1001-04", undefined, SURFACE);
  assert.ok(noOrder, "无订单投诉不应整体为 null");
  assert.equal(noOrder.caseType, "complaint");
  assert.ok(noOrder.complaint);
  assert.equal(noOrder.complaint.id, "cmp-seed-1001-04");
  assert.equal(noOrder.order, null);

  // 不存在 / 空 id → null
  assert.equal(await getAdminAftersaleDetail("refund", "nope", undefined, SURFACE), null);
  assert.equal(await getAdminAftersaleDetail("complaint", "", undefined, SURFACE), null);
});

test("详情聚合：调查历史与客服会话取自既有 getAdminOrderDetail，不另造（D-P1-3-4 / cmd 第 10 条）", async () => {
  // rf-seed-1001-02 挂在 ord-seed-1001-04 上：该单同时有 service 与 assignment 两段会话
  // （种子注释明示：2 段、共 6 条消息、合计 3 条未读）。
  const viaWorkbench = await getAdminAftersaleDetail("refund", "rf-seed-1001-02", undefined, SURFACE);
  assert.ok(viaWorkbench?.order, "退款详情应带出订单聚合");
  assert.equal(viaWorkbench.order.id, "ord-seed-1001-04");

  const direct = await getAdminOrderDetail("ord-seed-1001-04", undefined, SURFACE);
  assert.ok(direct, "订单详情应直接可读");

  // 客服会话可达（cmd 第 10 条）：两段会话合并成订单级统计，且不因聚合而丢失
  assert.ok(direct.conversationSummary, "该单应有会话摘要");
  assert.equal(direct.conversationSummary.orderId, "ord-seed-1001-04");
  assert.equal(direct.conversationSummary.messageCount, 6);
  assert.equal(direct.conversationSummary.unreadCount, 3);

  // 聚合没有另造一份：releaseHistory 与 conversationSummary 都等于直接取订单详情的结果
  // （D-P1-3-4 的要害是「不新建查询」——这里用 deepEqual 钉住两处返回的是同一份内容）
  assert.ok(Array.isArray(viaWorkbench.order.releaseHistory), "releaseHistory 必须是数组（无退出过为空数组）");
  assert.deepEqual(viaWorkbench.order.releaseHistory, direct.releaseHistory);
  assert.deepEqual(viaWorkbench.order.conversationSummary, direct.conversationSummary);
});

test("金额口径·订单状态闸：全额退款行 orderStatus === refunded，非 approved 行不是 refunded（P0-15）", async () => {
  const data = await runList({ view: "all" });
  const byId = new Map(data.items.map((row) => [row.id, row]));

  // 全额退款（rf-seed-1001-03，refundRateBp 10000）→ 订单状态「已退款」
  const full = byId.get("rf-seed-1001-03");
  assert.equal(full.orderStatus, "refunded");
  assert.equal(full.orderStatusLabel, "已退款");

  // 其余 6 条退款全是 pending / reviewing / rejected / cancelled：
  // 读侧必须与「审核中 / 已拒绝 / 已撤销不改变订单状态」同口径，订单绝不是 refunded
  const nonApprovedRefundIds = [
    "rf-seed-1001-01",
    "rf-seed-1001-02",
    "rf-seed-1001-04",
    "rf-seed-1001-05",
    "rf-seed-1003-01",
    "rf-seed-1002-01",
  ];
  for (const id of nonApprovedRefundIds) {
    assert.notEqual(
      byId.get(id).orderStatus,
      "refunded",
      `${id} 不是 approved，订单却显示成已退款`,
    );
  }
});

// ——————————————————————————— 接口门禁与鉴权 ———————————————————————————

test("售后工作台接口：只有 GET，且 requireAdmin 是解析查询之前的第一步", () => {
  const code = stripComments(readSource(path.join(ADMIN_API_DIR, "aftersales", "route.ts")));

  // handler 切分：`export async function ` 之后到下一个之前是一段。
  // 这里只允许一个 handler（GET），因此也必须恰好切出一段。
  const handlers = code.split(/export async function /).slice(1);
  assert.deepEqual(
    handlers.map((handler) => handler.slice(0, handler.indexOf("(")).trim()),
    ["GET"],
    "只读接口只能暴露 GET 这一个 handler",
  );

  // 更强的判据（同 `tests/adminContentImages.test.mjs`）：handler 的第一个 await
  // 必须是 `requireAdmin()`——不依赖 import 出现的位置。
  for (const handler of handlers) {
    const firstAwait = handler.indexOf("await ");
    assert.equal(
      handler.slice(firstAwait, firstAwait + "await requireAdmin()".length),
      "await requireAdmin()",
      "handler 的第一个 await 不是 requireAdmin()：权限没有排在业务之前",
    );
  }

  // 解析查询必须发生在鉴权之后：从 requireAdmin 调用点**往后**找 resolve 调用点。
  // 若调用点真的跑到守卫前面，这里会返回 -1，下一句如实报错。
  const requireIdx = code.indexOf("await requireAdmin()");
  const resolveIdx = code.indexOf("resolveAdminAftersaleListQuery", requireIdx);
  assert.ok(requireIdx !== -1, "必须调用 requireAdmin()");
  assert.ok(resolveIdx !== -1, "resolveAdminAftersaleListQuery 必须发生在 requireAdmin 之后");

  // 角色判断只有 `lib/api/adminRoute.ts` 一处，接口层不得自己判
  assert.equal(/role\s*===\s*["']admin["']/.test(code), false, "接口层不得自己判断角色");
});

test("售后工作台服务结构约束：收窄走 aftersaleRowInView、索引来自 ./adminIndex（防 BLOCKER 回退）", () => {
  const code = stripComments(readSource(path.join(ROOT, "lib", "services", "adminAftersales.ts")));

  // BLOCKER-1 守门人：按视图收窄必须按状态集合（aftersaleRowInView），
  // 不得再用「精确桶 === 视图」——那会把 reviewing/processing 从未完结漏掉。
  assert.equal(code.includes("row.view === query.view"), false, "不得再用 row.view === query.view 收窄");
  assert.equal(code.includes("query.view === row.view"), false, "不得再用 query.view === row.view 收窄");
  assert.ok(code.includes("aftersaleRowInView"), "收窄必须走 aftersaleRowInView");

  // P1-3 抽取：索引与占位必须从 ./adminIndex 引入，不得在本文件本地重新定义第二份
  assert.equal(code.includes("function adminUserIndex"), false, "不得本地定义 adminUserIndex");
  assert.equal(code.includes("function adminOrderIndex"), false, "不得本地定义 adminOrderIndex");
  assert.equal(code.includes("function missingUser"), false, "不得本地定义 missingUser");
  assert.ok(code.includes('from "./adminIndex"'), "必须从 ./adminIndex 引入索引与占位");
});

test("售后工作台接口鉴权成对正反例：匿名 401，客服 403，管理员 200", { skip: SKIP_HTTP }, async () => {
  const anonymous = await requestWithCookie("/api/admin/aftersales", null);
  assert.equal(anonymous.status, 401);
  assert.ok(anonymous.body.includes("UNAUTHORIZED"));

  const login = await mockLogin();
  if (login.status !== 200) {
    // 开关关闭：一律按未登录处理，匿名 401 已验，其余身份无需再验
    return;
  }

  const allowed = await requestWithCookie(
    "/api/admin/aftersales",
    `mock_admin_id=${MOCK_ADMIN_LOGIN_ID}`,
  );
  assert.equal(allowed.status, 200);
  assert.ok(allowed.body.includes('"data"'));

  const forbidden = await requestWithCookie("/api/admin/aftersales", "mock_admin_id=admin-2");
  assert.equal(forbidden.status, 403);
  assert.ok(forbidden.body.includes("FORBIDDEN"));
});

// ——————————————————————————— 调试装置 ———————————————————————————

test("mockEmpty=aftersales：队列与 counts 一并归零（ENABLE_MOCK_DEBUG）", async () => {
  const original = process.env.ENABLE_MOCK_DEBUG;
  process.env.ENABLE_MOCK_DEBUG = "true";
  try {
    const data = await queryAdminAftersaleList(query(), page({ mockEmpty: "aftersales" }), SURFACE);
    assert.deepEqual(data.items, []);
    assert.equal(data.total, 0);
    assert.equal(data.hasMore, false);
    assert.deepEqual(data.counts, { all: 0, open: 0, processing: 0, closed: 0 });
  } finally {
    if (original === undefined) delete process.env.ENABLE_MOCK_DEBUG;
    else process.env.ENABLE_MOCK_DEBUG = original;
  }
});

test("mockError=1：取数抛 500（ENABLE_MOCK_DEBUG）", async () => {
  const original = process.env.ENABLE_MOCK_DEBUG;
  process.env.ENABLE_MOCK_DEBUG = "true";
  try {
    await assert.rejects(
      () => queryAdminAftersaleList(query(), page({ mockError: "1" }), SURFACE),
      { code: "SERVER_ERROR", status: 500 },
    );
  } finally {
    if (original === undefined) delete process.env.ENABLE_MOCK_DEBUG;
    else process.env.ENABLE_MOCK_DEBUG = original;
  }
});
