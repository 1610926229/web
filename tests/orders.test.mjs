import assert from "node:assert/strict";
import test from "node:test";
import {
  ORDER_PAGE_SIZE,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  canTransitionOrder,
  mergeOrderPage,
} from "../lib/constants/orders.ts";
import { getOrderDetailForUser, queryOrdersForUser } from "../lib/services/orders.ts";
import { resolveSource } from "./app-path.mjs";
import { readSource, stripComments } from "./source-text.mjs";

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
    // ⚠️ 这里写的是「原价 × 比例」，成立的前提是 R3 确认的「分账基数 = 原价」。
    // 原价与分账基数是两个概念（见 lib/constants/orderAmount.ts）——
    // 将来出现「进原价但不进基数」的收费项时，这一条必须改成基数表达式，
    // 而不是把期望值顺手调大。
    assert.equal(
      detail.companionBaseIncome,
      Math.floor((detail.originalAmount * detail.companionRateSnapshot) / 10000),
      `订单 ${detail.orderNo} 的护航收益应当等于分账基数 × 比例（向下取整）`,
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

// ————————————————— 订单状态机：ORDER_TRANSITIONS / canTransitionOrder（P0-6）—————————————————
//
// 这一节守的是冻结的那张迁移表。它回答的**只是**「这种迁移在结构上讲不讲得通」，
// 不是业务 Guard：`paid → accepted` 仍要过接单资格与 deadline，`serving → completed`
// 仍要过完成审核，`completed → refunded` 仍要过售后流程，本轮新增的 `accepted → paid`
// 仍要过「仅当前实际打手 + 必须填写原因」的领域 Guard。
//
// 因此这张表一旦被顺手改宽（例如为了某个页面方便而加一条 `paid → completed`），
// 后果不是「少了一次检查」，而是**凭空多出一个看起来合法的入口**。
// 下面每一条都写得比实现啰嗦：它们要挡住的是「改一行、谁都看不出来」的改动。
//
// ⚠️ P0-6（2026-09-23）相对 P0-5.5 的变化 —— 只动了 `accepted` 与 `serving` 两行，
//    在各自数组的**最前面**插入 `"paid"`（顺序本身也是规范的一部分，见下面的首位断言）：
//
//      accepted: ["serving", "refunded"]   → ["paid", "serving", "refunded"]
//      serving:  ["completed", "refunded"] → ["paid", "completed", "refunded"]
//
//    这表达的是「回池」这一**结构能力**：`accepted → paid` 由本轮的打手主动取消使用。
//
//    ⚠️ `serving → paid` **只是进了结构状态机**——本轮不实现封禁回池、不实现客服换人、
//    也不提供 serving 的普通主动取消，因此它**没有任何 API 入口**（P0-6 scope 边界）。
//    「结构表允许」≠「这个动作有入口」：表里多一条边只说明这种迁移讲得通，
//    能不能做由领域 Guard 与入口是否存在共同决定。
//    **不要**因为这条断言变绿就以为 serving 回池已经可用。
//
//    `paid` / `completed` / `refunded` 三行本轮**不应**变化，下面单独钉住它们防止误改。

test("迁移表逐项冻结：五个状态的出边与冻结表完全相等，顺序也要一致", () => {
  assert.deepEqual(ORDER_TRANSITIONS, {
    paid: ["accepted", "refunded"],
    // P0-6：回池边插在最前面，不是追加在末尾
    accepted: ["paid", "serving", "refunded"],
    serving: ["paid", "completed", "refunded"],
    completed: ["refunded"],
    refunded: [],
  });

  // 键的顺序也是契约的一部分：它与 ORDER_STATUSES 的五个 Tab 顺序一致，读起来才对得上
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS), [
    "paid",
    "accepted",
    "serving",
    "completed",
    "refunded",
  ]);
});

test("迁移表的键集合与 ORDER_STATUSES 是同一个：加了新状态却忘了补迁移规则会在这里现形", () => {
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS), [...ORDER_STATUSES]);
  // 键集合「覆盖全部 OrderStatus」还要是同一个**五**元集合，不多不少：
  // 上面那条只比了顺序与内容，这里把「一个都没有漏」再钉一次
  const keySet = new Set(Object.keys(ORDER_TRANSITIONS));
  for (const status of ORDER_STATUSES) {
    assert.ok(keySet.has(status), `迁移表缺少状态 ${status} 的出边定义`);
  }
  assert.equal(keySet.size, ORDER_STATUSES.length, "迁移表的键不应多出 ORDER_STATUSES 之外的状态");
});

/**
 * P0-6 新增的保护：**回池边必须排在各自数组的第一位。**
 *
 * 顺序在这张表里是规范的一部分，理由不是「好看」：
 * - 这张表是**唯一**一份状态机定义处，读表、写文档、以及将来「取唯一一条回池边」
 *   的代码都可能依赖它是第一条；
 * - 一个只比对「集合相等」的断言，在有人按字母序 / 按生命周期序顺手重排整张表时，
 *   会连同期望值一起被改掉而**静默变绿**——而重排本身就是一次没人看得见的规范改动。
 *
 * 回池迁移是 2026-09-23（P0-6）新增的能力：`accepted` / `serving` 的数组从两条变三条，
 * 新增的 `"paid"` 插在**最前面**。位置变了，就说明有人无意（或有意）重排了这张表。
 */
test("回池边冻结在首位：accepted / serving 的第一条出边必须是 paid", () => {
  assert.equal(
    ORDER_TRANSITIONS.accepted[0],
    "paid",
    "accepted 的第一条出边必须是回池边 paid（P0-6 新增，插在最前面而不是追加在后面）",
  );
  assert.equal(
    ORDER_TRANSITIONS.serving[0],
    "paid",
    "serving 的第一条出边必须是回池边 paid（P0-6 只进结构表，无入口）",
  );

  // 首元素之外，整行也逐字钉住：只允许「最前面多一条 paid」，不允许把 paid 挪到别处
  assert.deepEqual(ORDER_TRANSITIONS.accepted, ["paid", "serving", "refunded"]);
  assert.deepEqual(ORDER_TRANSITIONS.serving, ["paid", "completed", "refunded"]);
});

/**
 * P0-6 的 scope 只覆盖 `accepted` / `serving` 两行；其余三行是「本轮没打算动」的地方。
 * 它们单独钉住，是因为「改一处、动一片」的改动最容易在这里留下没人察觉的痕迹：
 * 主 `deepEqual` 会一起变绿（期望值也被同步改了），而这三行本来不该出现在本轮的 diff 里。
 */
test("P0-6 未触及的三行仍然冻结：paid / completed / refunded 不得被顺手改动", () => {
  assert.deepEqual(ORDER_TRANSITIONS.paid, ["accepted", "refunded"], "paid 本轮不应变化");
  assert.deepEqual(ORDER_TRANSITIONS.completed, ["refunded"], "completed 本轮不应变化");
  assert.deepEqual(ORDER_TRANSITIONS.refunded, [], "refunded 本轮不应变化（终态写空数组）");
});

test("合法迁移全部为 true：三条主线 + 两条回池 + 四条可退款", () => {
  const legal = [
    // 主线：付款 → 接单 → 护航 → 完成
    ["paid", "accepted"],
    ["accepted", "serving"],
    ["serving", "completed"],
    // 回池（P0-6 新增的结构能力）：已接单 / 护航中都能回到「等人接单」
    // ⚠️ 本轮只有 `accepted → paid` 有入口（打手主动取消）；`serving → paid` 没有入口，
    //    它在这里为 true 只说明「结构上讲得通」，不代表界面上有这条路
    ["accepted", "paid"],
    ["serving", "paid"],
    // 退款：四个非终态都能进入退款
    ["paid", "refunded"],
    ["accepted", "refunded"],
    ["serving", "refunded"],
    ["completed", "refunded"],
  ];

  for (const [from, to] of legal) {
    assert.equal(canTransitionOrder(from, to), true, `${from} → ${to} 应当允许`);
  }
});

test("非法迁移全部为 false：前跳、非回池的回退、终态复活都不行", () => {
  const illegal = [
    // 前跳：没接单就不能已在护航，没护航就不能已完成，更不能不接单直接完成
    ["paid", "completed"],
    ["paid", "serving"],
    ["accepted", "completed"],
    // 回退：**只有回池（→ paid）是结构上允许的回退**（见上面的合法清单），其余回退一律不行。
    // 注意 `serving → paid` 已从本条清单移走——它在 P0-6 之后是合法的。
    ["completed", "serving"],
    ["completed", "paid"],
    ["completed", "accepted"],
    // 终态：已退款不能回到任何活跃状态，也不能再「退一次」
    ["refunded", "paid"],
    ["refunded", "accepted"],
    ["refunded", "refunded"],
  ];

  for (const [from, to] of illegal) {
    assert.equal(canTransitionOrder(from, to), false, `${from} → ${to} 必须被拒`);
  }
});

test("from === to 恒为 false：原地不动不是一次「迁移」", () => {
  for (const status of ORDER_STATUSES) {
    assert.equal(canTransitionOrder(status, status), false, `${status} → ${status} 不该被当成迁移`);
  }
});

/**
 * 5 × 5 的预期矩阵。**手写的**，不是用 `ORDER_TRANSITIONS[from].includes(to)` 现算的：
 * 拿实现反推期望值等于用实现验证实现——表被改宽时，这样写出来的用例会跟着一起变绿，
 * 而那正是这条用例唯一要防的事。列顺序与 `ORDER_STATUSES` 一致。
 *
 * 列：paid / accepted / serving / completed / refunded，1 = 允许，0 = 拒绝。
 *
 * P0-6（2026-09-23）只把 `accepted → paid` 与 `serving → paid` 两格从 0 改成 1
 * （回池能力进了结构表），其余 23 格不变。
 */
const TRANSITION_MATRIX = [
  ["paid", [0, 1, 0, 0, 1]],
  ["accepted", [1, 0, 1, 0, 1]],
  ["serving", [1, 0, 0, 1, 1]],
  ["completed", [0, 0, 0, 0, 1]],
  ["refunded", [0, 0, 0, 0, 0]],
];

test("穷举 25 格：逐格与手写的预期矩阵比对（矩阵自己也要先自检）", () => {
  // 手写表最常见的错法是行数与列数对不上：先把它钉住，免得「25 格」名不副实
  assert.deepEqual(ORDER_STATUSES, ["paid", "accepted", "serving", "completed", "refunded"]);
  assert.equal(TRANSITION_MATRIX.length, ORDER_STATUSES.length, "矩阵的行数必须覆盖五个状态");
  assert.deepEqual(
    TRANSITION_MATRIX.map(([from]) => from),
    [...ORDER_STATUSES],
    "矩阵的行顺序必须与 ORDER_STATUSES 一致，否则对错了格子",
  );

  let cells = 0;
  for (const [from, row] of TRANSITION_MATRIX) {
    assert.equal(row.length, ORDER_STATUSES.length, `${from} 那一行必须写满五格`);
    ORDER_STATUSES.forEach((to, index) => {
      cells += 1;
      assert.equal(
        canTransitionOrder(from, to),
        row[index] === 1,
        `${from} → ${to} 与手写预期矩阵不一致`,
      );
    });
  }
  assert.equal(cells, 25, "五乘五必须一格不漏");
});

test("refunded 是终态：没有任何一条出边（已退款不能复活，也不能再退一次）", () => {
  for (const to of ORDER_STATUSES) {
    assert.equal(canTransitionOrder("refunded", to), false, `refunded → ${to} 必须被拒`);
  }
  assert.deepEqual(ORDER_TRANSITIONS.refunded, [], "终态写出空数组，而不是省略这一行");
});

test("源码约束：orders.ts 的依赖只有 import type + 同层的纯函数 ./pagination（仍可被客户端组件引用）", () => {
  const code = stripComments(readSource(resolveSource("lib/constants/orders.ts")));

  // 跨行的 import 也算一条；先去掉注释，否则文档注释里那句「不得出现任何运行时的 import」
  // 会被当成一条真的 import 语句
  const statements = code.match(/^import[\s\S]*?;$/gm) ?? [];
  assert.equal(statements.length, 3, `扫到的 import 语句数量变了：\n${statements.join("\n")}`);

  const typeImports = statements.filter((statement) => /^import\s+type\b/.test(statement));
  const runtimeImports = statements.filter((statement) => !/^import\s+type\b/.test(statement));

  // 类型 import 编译后完全消失，不构成「把服务端模块打进浏览器产物」的风险
  assert.equal(typeImports.length, 2, "订单与分页的类型必须是 import type");

  // ⚠️ 本文件**确实有一条运行时 import**（`./pagination` 的纯函数），因此
  //    「所有 import 都是 import type」与仓库现状不符。真正要守的是 R1 的那句话：
  //    依赖只有 import type + 纯函数。于是把运行时依赖**逐条冻结**——
  //    多引一个模块（尤其 `@/lib/data/**`）立刻变红。
  assert.deepEqual(
    runtimeImports.map((statement) => statement.match(/from\s+"([^"]+)"/)?.[1]),
    ["./pagination"],
    "运行时依赖变了：多出来的那一个会被打进浏览器产物",
  );

  // 最容易发生的一种回流：顺手引一个服务端模块（这正是这条断言存在的理由）
  for (const forbidden of [
    "@/lib/data/",
    "@/lib/services/",
    "@/lib/mocks/",
    "@/lib/api/",
    "next/server",
    "next/headers",
    "server-only",
  ]) {
    assert.equal(code.includes(forbidden), false, `orders.ts 不该引用 ${forbidden}`);
  }
});
