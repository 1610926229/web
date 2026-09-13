import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import {
  TIP_MOCK_NOTICE,
  TIP_PAGE_SIZE,
  TIP_STATUS_CLASS,
  TIP_STATUS_LABELS,
  TIP_STATUS_OPTIONS,
  TIP_SUBMIT_DISABLED_REASON,
  TIP_STATUS_INVALID_MESSAGE,
  mergeTipPage,
  parseTipListQuery,
} from "../lib/constants/tips.ts";
import { getTipRepository } from "../lib/data/tipRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import { tipSeed } from "../lib/mocks/fixtures/tipSeed.ts";
import { queryTipsForUser } from "../lib/services/tips.ts";
import * as tipsHttp from "../lib/services/tipsHttp.ts";

/**
 * 鸡腿记录的持续测试。
 *
 * 跑的是**真实实现**：真实的只读 Mock 仓储 + 真实的 `lib/services/tips.ts`，
 * 因此「只看得到自己的记录」「筛选与分页口径」「只展示原始记录值」
 * 这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * 其中三条是本阶段的**边界**，必须由测试守住：
 * 1. 用户端没有「创建鸡腿记录」的接口 —— 仓储没有写方法、
 *    `/api/tips` 只有 GET、浏览器端只有一个读函数；
 * 2. DTO 里没有单价、兑换比例、平台抽成、打手到手金额 —— 规则未确认就不能先发出去；
 * 3. `/tips/new` 是纯说明页 —— 不读数据、不发请求、不接支付。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 记录里出现这些词就说明把未确认的规则写进数据了。 */
const FORBIDDEN_KEY_PATTERN = /price|amount|ratio|rate|net|commission|cash|settle|exchange/i;

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function list(userId, params = {}) {
  return queryTipsForUser(userId, page(params), "server");
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("tip");
});

test("鸡腿记录只包含当前用户的记录，且按创建时间倒序", async () => {
  const result = await list(USER_A);

  assert.equal(result.total, 4);
  assert.equal(result.status, "all");
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["tip-seed-1001-03", "tip-seed-1001-04", "tip-seed-1001-01", "tip-seed-1001-02"],
  );
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].createdAt >= result.items[index].createdAt);
  }

  // B 一条记录都没有：空态不需要额外的调试开关就能看到（原型就是空态）
  const other = await list(USER_B);
  assert.equal(other.total, 0);
  assert.deepEqual(other.items, []);
  assert.deepEqual(other.counts, { all: 0, paid: 0, pending: 0, failed: 0 });
});

test("记录里保留的是下单时的订单与打手快照，不是今天的值", async () => {
  const result = await list(USER_A);

  for (const item of result.items) {
    const order = orderSeed.find((entry) => entry.id === item.orderId);
    assert.ok(order, `记录关联了不存在的订单：${item.orderId}`);
    // 快照逐字段等于订单上的值：订单将来改名、打手改名都不会改变历史记录
    assert.equal(item.orderNo, order.orderNo);
    assert.equal(item.productTitle, order.productTitle);
    assert.equal(item.productCoverUrl, order.productCoverUrl);
    assert.deepEqual(item.companion, order.companion);
  }

  // 有一单还没有绑定打手：记录照样完整，页面显示「未绑定」而不是留空
  const unbound = result.items.find((item) => item.id === "tip-seed-1001-03");
  assert.equal(unbound.companion, null);

  // 数量是**原始记录值**，不是金额：整数，且与种子里写下的一致
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(byId.get("tip-seed-1001-01").quantity, 2);
  assert.equal(byId.get("tip-seed-1001-04").quantity, 3);
  for (const item of result.items) assert.equal(Number.isInteger(item.quantity), true);
});

test("三种支付状态都能筛出来，角标随每一页一起返回", async () => {
  assert.deepEqual((await list(USER_A)).counts, { all: 4, paid: 2, pending: 1, failed: 1 });

  const paid = await list(USER_A, { status: "paid" });
  assert.equal(paid.total, 2);
  assert.equal(paid.status, "paid");
  for (const item of paid.items) assert.equal(item.paymentStatus, "paid");

  const pending = await list(USER_A, { status: "pending" });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].id, "tip-seed-1001-04");
  // 状态文案与服务端同源，前端不自己映射
  assert.equal(pending.items[0].paymentStatusLabel, TIP_STATUS_LABELS.pending);
  assert.equal(pending.items[0].paymentStatusLabel, "待支付");

  const failed = await list(USER_A, { status: "failed" });
  assert.equal(failed.total, 1);
  assert.equal(failed.items[0].id, "tip-seed-1001-03");

  // 角标与筛选无关，始终是全部记录的统计
  assert.deepEqual(failed.counts, { all: 4, paid: 2, pending: 1, failed: 1 });
});

test("分页稳定不重复，加载更多是合并不是替换", async () => {
  const first = await list(USER_A, { page: 1, pageSize: 2 });
  const second = await list(USER_A, { page: 2, pageSize: 2 });

  assert.deepEqual(
    first.items.map((item) => item.id),
    ["tip-seed-1001-03", "tip-seed-1001-04"],
  );
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["tip-seed-1001-01", "tip-seed-1001-02"],
  );

  const seen = new Set();
  for (const item of [...first.items, ...second.items]) {
    assert.equal(seen.has(item.id), false, `${item.id} 在分页里重复出现`);
    seen.add(item.id);
  }
  assert.equal(seen.size, 4);

  // 重复取同一页再合并：去重后条数不变（「加载更多」连点两次的兜底），额外字段还在
  const merged = mergeTipPage(first, first);
  assert.equal(merged.items.length, first.items.length);
  assert.equal(merged.status, "all");
  assert.deepEqual(merged.counts, first.counts);
});

test("查询规则的纯函数：状态非法失败、分页收敛到安全范围", async () => {
  const fallback = parseTipListQuery(page());
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.query, { status: "all", page: 1, pageSize: TIP_PAGE_SIZE });

  assert.equal(parseTipListQuery(page({ status: "paid" })).query.status, "paid");
  assert.equal(parseTipListQuery(page({ pageSize: 999 })).query.pageSize, 20);
  assert.equal(parseTipListQuery(page({ page: "abc" })).query.page, 1);
  assert.equal(parseTipListQuery(page({ status: "succeeded" })).ok, false);

  // 接口层：状态写错直接 400（不静默回退成「全部」）
  await expectApiError(
    list(USER_A, { status: "succeeded" }),
    "BAD_REQUEST",
    TIP_STATUS_INVALID_MESSAGE,
  );
});

test("DTO 只含原始记录值：没有单价、兑换比例、平台抽成与到手金额", async () => {
  const result = await list(USER_A);

  for (const item of result.items) {
    // 键名层面：任何带 price / amount / ratio / net / commission 的字段都不允许出现
    for (const key of Object.keys(item)) {
      assert.equal(
        FORBIDDEN_KEY_PATTERN.test(key),
        false,
        `鸡腿记录 DTO 不该出现未确认字段：${key}`,
      );
    }
  }

  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    "companion",
    "createdAt",
    "id",
    "orderId",
    "orderNo",
    "paymentStatus",
    "paymentStatusLabel",
    "productCoverUrl",
    "productTitle",
    "quantity",
  ]);
  // userId 只在仓储实体里，接口不返回
  assert.equal("userId" in result.items[0], false);
  // 分页结果的形状固定：角标始终随每一页一起返回
  assert.deepEqual(Object.keys(result).sort(), [
    "counts",
    "hasMore",
    "items",
    "page",
    "pageSize",
    "status",
    "total",
  ]);
});

test("仓储只有读取方法：用户端没有「创建鸡腿记录」的入口", async () => {
  // ① 仓储层：连一个写方法都没有，服务层与接口层因此不可能误写出创建路径
  const repository = getTipRepository();
  assert.deepEqual(Object.keys(repository).sort(), ["countTipsByStatus", "queryTips"]);
  for (const name of Object.keys(repository)) {
    assert.equal(/create|add|insert|send|write|save/i.test(name), false, `仓储不该有写方法：${name}`);
  }

  // ② 浏览器端服务：只有一个读函数
  assert.deepEqual(Object.keys(tipsHttp), ["fetchTips"]);

  // ③ 接口：`/api/tips` 只导出 GET，没有 POST / PUT / PATCH / DELETE
  const routeSource = readFileSync("app/api/tips/route.ts", "utf8");
  assert.match(routeSource, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(routeSource),
      false,
      `/api/tips 不该出现 ${method} 处理函数`,
    );
  }
});

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「本页没有 X」不算出现 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("/tips/new 是纯说明页：不读数据、不发请求、不接支付", () => {
  // 页面组件无法在 node 里渲染（JSX 不会被剥离），因此用源码守住这几条硬规则
  const source = readFileSync("app/tips/new/page.tsx", "utf8");
  const code = stripComments(source);

  // 不产生任何记录、不调用支付：整页没有导入仓储 / 服务 / 浏览器请求
  for (const forbidden of [
    "paymentRepository",
    "tipRepository",
    "services/tips",
    "apiPost",
    "apiGet",
    "fetchPayment",
    "createPayment",
    "模拟支付",
  ]) {
    assert.equal(code.includes(forbidden), false, `/tips/new 不该出现 ${forbidden}`);
  }
  // 也没有任何可以点的提交按钮：唯一的 button 内联了 disabled
  for (const button of code.match(/<button[\s\S]*?>/g) ?? []) {
    assert.ok(button.includes("disabled"), `提交按钮必须是禁用的：${button}`);
  }

  // 说明与禁用理由是页面上真实存在的文案，且理由来自常量（与无障碍名称同源）
  assert.ok(source.includes("TIP_RULES_PENDING_NOTE"));
  assert.ok(source.includes("TIP_SUBMIT_DISABLED_REASON"));
  assert.ok(source.includes("disabled"));
  assert.ok(source.includes("aria-describedby"));
  assert.ok(TIP_SUBMIT_DISABLED_REASON.length > 0);
});

test("种子与说明都明确标注 Mock，且状态取值与文案齐全", async () => {
  // 页面上必须写明这是 Mock 记录、且只展示原始记录值
  assert.ok(TIP_MOCK_NOTICE.includes("Mock"));
  assert.ok(TIP_MOCK_NOTICE.includes("原始记录值"));
  assert.ok(TIP_MOCK_NOTICE.includes("待确认") || TIP_MOCK_NOTICE.includes("尚待确认"));

  // 三种状态各有文案与颜色，筛选 chip 覆盖全部取值
  assert.deepEqual(TIP_STATUS_OPTIONS.map((item) => item.key), [
    "all",
    "paid",
    "pending",
    "failed",
  ]);
  for (const status of ["paid", "pending", "failed"]) {
    assert.equal(typeof TIP_STATUS_LABELS[status], "string");
    assert.ok(TIP_STATUS_CLASS[status].startsWith("text-status-"));
  }

  // 种子里三种状态都有记录，且每条都能在列表里查到（预置数据与新数据走同一条查询路径）
  const statuses = new Set(tipSeed.map((tip) => tip.paymentStatus));
  assert.deepEqual([...statuses].sort(), ["failed", "paid", "pending"]);
  const listed = new Set((await list(USER_A)).items.map((item) => item.id));
  for (const tip of tipSeed) assert.equal(listed.has(tip.id), true);
});

test("种子数据的自洽性：归属、时间与数量", () => {
  for (const tip of tipSeed) {
    const order = orderSeed.find((entry) => entry.id === tip.orderId);
    assert.ok(order, `${tip.id} 关联了不存在的订单`);
    assert.equal(order.userId, tip.userId, `${tip.id} 的用户与订单归属不一致`);
    // 鸡腿记录不能早于下单时间
    assert.ok(Date.parse(tip.createdAt) >= Date.parse(order.paidAt), `${tip.id} 的时间早于下单时间`);
    assert.equal(Number.isInteger(tip.quantity) && tip.quantity > 0, true);
    // 实体里同样没有任何金额字段
    for (const key of Object.keys(tip)) {
      assert.equal(FORBIDDEN_KEY_PATTERN.test(key), false, `${tip.id} 不该有字段 ${key}`);
    }
  }
});
