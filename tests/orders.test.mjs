import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_PAGE_SIZE,
  ORDER_STATUSES,
  mergeOrderPage,
} from "../lib/constants/orders.ts";
import { getOrderDetailForUser, queryOrdersForUser } from "../lib/services/orders.ts";

/**
 * 订单查询的仓储 / service 级测试。
 *
 * 直接跑 `lib/services/orders.ts` 的真实实现与真实的 Mock 仓储，不复制一份逻辑，
 * 因此「状态筛选」「订单号搜索」「分页不重复」「用户隔离」这些行为的验证是长期的、
 * 可重复的，而不是一次性脚本。
 *
 * 用户名固定用两个 Mock 用户；需要写数据的用例一律用随机用户 id，
 * 避免污染 u-1001 的分页与筛选断言（内存仓储在同一进程内是共享的）。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 组装查询参数；值为 undefined 的键不写入，模拟「参数缺失」。 */
function params(input = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search;
}

function list(userId, input) {
  return queryOrdersForUser(userId, params(input), "server");
}

/** 翻完所有页，用来断言「某个筛选下的全部订单」。 */
async function listAll(userId, input = {}) {
  const first = await list(userId, { ...input, page: 1, pageSize: 20 });
  const items = [...first.items];
  let page = first.page;

  while (page * first.pageSize < first.total) {
    page += 1;
    const next = await list(userId, { ...input, page, pageSize: 20 });
    items.push(...next.items);
  }
  return items;
}

test("状态筛选：每个状态只返回该状态的订单，且五种状态都有预置数据", async () => {
  for (const status of ORDER_STATUSES) {
    const result = await listAll(USER_A, { status });
    assert.ok(result.length > 0, `状态 ${status} 应当有预置订单`);
    assert.ok(
      result.every((order) => order.status === status),
      `状态 ${status} 的结果里混进了别的状态`,
    );
  }
});

test("「全部」不是订单状态：不加状态条件时返回该用户的全部订单，五种状态齐全", async () => {
  const all = await listAll(USER_A);

  assert.equal(
    new Set(all.map((order) => order.status)).size,
    ORDER_STATUSES.length,
    "「全部」应当覆盖所有状态",
  );

  let sum = 0;
  for (const status of ORDER_STATUSES) {
    sum += (await list(USER_A, { status })).total;
  }
  assert.equal(sum, all.length, "各状态的条数之和应当等于「全部」的条数");
});

test("订单号搜索：完整订单号精确命中", async () => {
  const [first] = (await list(USER_A)).items;
  const result = await list(USER_A, { keyword: first.orderNo });

  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, first.id);
});

test("订单号搜索：部分订单号、首尾空格、大小写都能命中", async () => {
  const [first] = (await list(USER_A)).items;
  const partial = first.orderNo.slice(-6);

  for (const keyword of [partial, `  ${partial}  `, partial.toLowerCase()]) {
    const result = await list(USER_A, { keyword });
    assert.ok(
      result.items.some((order) => order.id === first.id),
      `关键字 ${keyword} 应当命中 ${first.orderNo}`,
    );
    assert.ok(
      result.items.every((order) => order.orderNo.toLowerCase().includes(partial.toLowerCase())),
      `关键字 ${keyword} 命中了订单号不匹配的订单`,
    );
  }
});

test("订单号搜索：无结果时是空列表而不是错误，且只在列表区域为空", async () => {
  const result = await list(USER_A, { keyword: "YM00000000000000" });

  assert.equal(result.total, 0);
  assert.deepEqual(result.items, []);
  assert.equal(result.hasMore, false);
  assert.equal(result.page, 1);
});

test("状态与搜索同时生效", async () => {
  const paid = await listAll(USER_A, { status: "paid" });
  const target = paid[0];
  const keyword = target.orderNo.slice(-6);

  const result = await listAll(USER_A, { status: "paid", keyword });
  assert.ok(result.length > 0);
  assert.ok(result.every((order) => order.status === "paid"));
  assert.ok(result.every((order) => order.orderNo.includes(keyword)));
});

test("分页：第一页与第二页不重复，合计等于 total", async () => {
  const first = await list(USER_A, { page: 1 });
  const second = await list(USER_A, { page: 2 });

  assert.equal(first.pageSize, ORDER_PAGE_SIZE);
  assert.ok(first.items.length > 0);

  const firstIds = new Set(first.items.map((order) => order.id));
  const secondIds = second.items.map((order) => order.id);
  assert.equal(new Set(secondIds).size, secondIds.length, "同一页内不应出现重复订单");
  for (const id of secondIds) {
    assert.ok(!firstIds.has(id), `订单 ${id} 同时出现在第一页与第二页`);
  }

  assert.equal(first.hasMore, true, "预置数据应当超过一页");
  assert.equal(first.items.length + second.items.length, first.total);
});

test("分页：末页 hasMore 为 false，越界页返回空列表且 hasMore 为 false", async () => {
  const first = await list(USER_A, { page: 1, pageSize: ORDER_PAGE_SIZE });
  const lastPage = Math.ceil(first.total / ORDER_PAGE_SIZE);
  const last = await list(USER_A, { page: lastPage, pageSize: ORDER_PAGE_SIZE });
  assert.equal(last.hasMore, false);

  const beyond = await list(USER_A, { page: lastPage + 5, pageSize: ORDER_PAGE_SIZE });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, first.total, "越界页仍应返回真实总数");
  assert.equal(beyond.hasMore, false);
});

test("分页：pageSize 超过上限被收敛到上限，page 非法时回到第 1 页", async () => {
  const tooBig = await list(USER_A, { pageSize: 999 });
  assert.equal(tooBig.pageSize, 20);

  for (const page of ["0", "-3", "abc", ""]) {
    const result = await list(USER_A, { page });
    assert.equal(result.page, 1, `page=${JSON.stringify(page)} 应当回到第 1 页`);
  }

  const badSize = await list(USER_A, { pageSize: "abc" });
  assert.equal(badSize.pageSize, ORDER_PAGE_SIZE, "非法 pageSize 应当用默认值");
});

test("非法状态返回 BAD_REQUEST，不静默回退成「全部」", async () => {
  await assert.rejects(
    () => list(USER_A, { status: "pending" }),
    (error) => error.code === "BAD_REQUEST",
  );
  await assert.rejects(
    () => list(USER_A, { status: "已付款" }),
    (error) => error.code === "BAD_REQUEST",
  );
});

test("搜索关键字超长返回 BAD_REQUEST", async () => {
  await assert.rejects(
    () => list(USER_A, { keyword: "1".repeat(33) }),
    (error) => error.code === "BAD_REQUEST",
  );
});

test("用户隔离：两个用户各自只看到自己的订单", async () => {
  const a = await listAll(USER_A);
  const b = await listAll(USER_B);

  assert.ok(a.length > 0 && b.length > 0);

  const aIds = new Set(a.map((order) => order.id));
  for (const order of b) {
    assert.ok(!aIds.has(order.id), `订单 ${order.id} 同时出现在两个用户名下`);
  }
});

test("用户隔离：拿不到别人的订单详情，两种失败原因表现一致", async () => {
  const bOrder = (await listAll(USER_B))[0];

  assert.equal(await getOrderDetailForUser(bOrder.id, USER_A, undefined, "server"), null);
  assert.equal(await getOrderDetailForUser("ord-不存在的订单", USER_A, undefined, "server"), null);
  assert.equal(await getOrderDetailForUser("", USER_A, undefined, "server"), null);

  const own = await getOrderDetailForUser(bOrder.id, USER_B, undefined, "server");
  assert.equal(own.id, bOrder.id);
});

test("列表 DTO 不返回游戏 ID、备注与金额明细", async () => {
  const [item] = (await list(USER_A)).items;

  for (const field of ["gameAccountId", "remark", "unitPrice", "itemsAmount", "addonsAmount", "addons"]) {
    assert.ok(!(field in item), `列表项不应包含 ${field}`);
  }
  // 详情页要用的字段仍在
  assert.equal(typeof item.totalAmount, "number");
  assert.equal(typeof item.orderNo, "string");
});

test("详情 DTO 含游戏 ID 与备注，金额以「分」为单位且算术自洽", async () => {
  const orders = await listAll(USER_A);

  for (const item of orders) {
    const detail = await getOrderDetailForUser(item.id, USER_A, undefined, "server");

    assert.ok(detail, `订单 ${item.id} 的详情应当能取到`);
    assert.equal(typeof detail.gameAccountId, "string");
    assert.ok(detail.gameAccountId.length > 0, "预置订单应当有游戏 ID");
    assert.equal(detail.gameName.length > 0, true);

    assert.ok(Number.isInteger(detail.unitPrice), "单价应当是整数分");
    assert.equal(detail.itemsAmount, detail.unitPrice * detail.quantity);
    assert.equal(
      detail.addonsAmount,
      detail.addons.reduce((sum, addon) => sum + addon.price, 0),
    );
    assert.equal(detail.totalAmount, detail.itemsAmount + detail.addonsAmount);
  }
});

test("详情 DTO 带上金额域的三行展示值，但不带平台净收入", async () => {
  const [item] = (await list(USER_A)).items;
  const detail = await getOrderDetailForUser(item.id, USER_A, undefined, "server");

  // 页面上「原价 / 实付 / 护航收益」三行读的就是这几个字段
  for (const field of [
    "originalAmount",
    "couponDiscountAmount",
    "actualPaidAmount",
    "companionRateSnapshot",
    "companionBaseIncome",
    "refundedAmount",
  ]) {
    assert.equal(typeof detail[field], "number", `详情应当带上 ${field}`);
  }

  // 平台净收入是平台自己的账：用户端没有展示位置，
  // 放进 DTO 只会顺着接口响应流到浏览器
  assert.equal("clubNetIncome" in detail, false);

  // 列表仍然是摘要：金额域整块都不该出现在列表项里
  for (const field of [
    "originalAmount",
    "couponDiscountAmount",
    "actualPaidAmount",
    "companionRateSnapshot",
    "companionBaseIncome",
    "clubNetIncome",
    "refundedAmount",
  ]) {
    assert.equal(field in item, false, `列表项不应包含 ${field}`);
  }
});

test("预置订单的金额域由公式算出，而不是手写的常量", async () => {
  // 种子调用的是 `lib/constants/orderAmount.ts` 里那组函数本身（不是抄一份数字），
  // 因此只要有人在种子里写死一个对不上的数，下面两条关系立刻就红
  for (const item of await listAll(USER_A)) {
    const detail = await getOrderDetailForUser(item.id, USER_A, undefined, "server");

    assert.equal(
      detail.actualPaidAmount,
      detail.originalAmount - detail.couponDiscountAmount,
      `订单 ${detail.orderNo} 的实付应当等于原价减抵扣`,
    );
    assert.equal(
      detail.companionBaseIncome,
      Math.floor((detail.originalAmount * detail.companionRateSnapshot) / 10000),
      `订单 ${detail.orderNo} 的护航收益应当等于原价 × 比例（向下取整）`,
    );
    // 已退款的整单退，其余一笔都没退过
    assert.equal(
      detail.refundedAmount,
      detail.status === "refunded" ? detail.actualPaidAmount : 0,
      `订单 ${detail.orderNo} 的累计已退不对`,
    );
  }
});

test("详情：未绑定打手的已付款订单显示为空，已接单之后必须有打手", async () => {
  const orders = await listAll(USER_A);
  const waiting = orders.filter((order) => order.status === "paid" && order.companion === null);
  const active = orders.filter((order) => order.status !== "paid" && order.status !== "refunded");

  assert.ok(waiting.length > 0, "预置数据应当包含未绑定打手的已付款订单");
  assert.ok(active.length > 0);

  for (const order of active) {
    assert.ok(order.companion, `订单 ${order.orderNo} 处于 ${order.status}，必须有打手快照`);
    assert.ok(order.companion.name.length > 0);
  }
});

test("详情：订单进度只包含已经发生的节点，且时间递增", async () => {
  const completed = (await listAll(USER_A, { status: "completed" }))[0];
  const detail = await getOrderDetailForUser(completed.id, USER_A, undefined, "server");

  assert.deepEqual(
    detail.timeline.map((entry) => entry.key),
    ["paid", "accepted", "serving", "completed"],
  );

  const times = detail.timeline.map((entry) => Date.parse(entry.at));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] >= times[i - 1], "状态时间节点应当按时间先后排列");
  }
});

test("详情：已退款订单保留完整商品与金额快照", async () => {
  const [refunded] = await listAll(USER_A, { status: "refunded" });
  const detail = await getOrderDetailForUser(refunded.id, USER_A, undefined, "server");

  assert.equal(detail.status, "refunded");
  assert.ok(detail.productTitle.length > 0);
  assert.ok(detail.productCoverUrl.length > 0);
  assert.ok(detail.specName.length > 0);
  assert.ok(detail.totalAmount > 0);
  assert.equal(detail.timeline.at(-1).key, "refunded");
});

test("默认按支付时间倒序，最新订单在最前", async () => {
  const orders = await listAll(USER_A);

  for (let i = 1; i < orders.length; i += 1) {
    assert.ok(
      Date.parse(orders[i - 1].paidAt) >= Date.parse(orders[i].paidAt),
      "列表应当按支付时间倒序",
    );
  }
});

test("加载更多：把新一页并到已有列表后面，不是替换掉前面的订单", () => {
  const current = { items: [{ id: "a" }, { id: "b" }], page: 1, pageSize: 2, total: 4, hasMore: true };
  const next = { items: [{ id: "c" }, { id: "d" }], page: 2, pageSize: 2, total: 4, hasMore: false };

  const merged = mergeOrderPage(current, next);

  assert.deepEqual(merged.items.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.equal(merged.page, 2);
  assert.equal(merged.hasMore, false);
});

test("加载更多：翻页期间新订单插到最前，重复的订单只出现一次", () => {
  // 第二页整体后移，订单 b 于是在两页里都出现了一次
  const current = { items: [{ id: "a" }, { id: "b" }], page: 1, pageSize: 2, total: 5, hasMore: true };
  const next = { items: [{ id: "b" }, { id: "c" }], page: 2, pageSize: 2, total: 5, hasMore: false };

  const merged = mergeOrderPage(current, next);
  const ids = merged.items.map((item) => item.id);

  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(new Set(ids).size, ids.length, "合并后不应出现重复订单");
});

test("真实数据下逐页加载：不重复、不丢单、末页正确收尾", async () => {
  const total = (await list(USER_A)).total;
  const pages = Math.ceil(total / ORDER_PAGE_SIZE);

  let merged = await list(USER_A, { page: 1, pageSize: ORDER_PAGE_SIZE });

  for (let number = 2; number <= pages; number += 1) {
    const next = await list(USER_A, { page: number, pageSize: ORDER_PAGE_SIZE });
    merged = mergeOrderPage(merged, next);
  }

  const ids = merged.items.map((item) => item.id);
  assert.equal(ids.length, total, "逐页加载后应当拿到全部订单");
  assert.equal(new Set(ids).size, total, "逐页加载不应出现重复订单");
  assert.equal(merged.hasMore, false, "最后一页 hasMore 应为 false");
});
