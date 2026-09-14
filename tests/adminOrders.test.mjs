import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  ADMIN_ORDER_DATE_INVALID_MESSAGE,
  ADMIN_ORDER_DATE_RANGE_INVALID_MESSAGE,
  ADMIN_ORDER_GAME_INVALID_MESSAGE,
  ADMIN_ORDER_PAGE_SIZE,
  ADMIN_ORDER_STATUS_INVALID_MESSAGE,
  orderBeijingDate,
} from "../lib/constants/adminOrders.ts";
import { ORDER_STATUSES } from "../lib/constants/orders.ts";
import {
  ADMIN_ORDER_UNFILTERED_QUERY,
  getPaymentRepository,
} from "../lib/data/paymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import {
  getAdminOrderDetail,
  queryAdminOrderList,
  resolveAdminOrderListQuery,
} from "../lib/services/adminOrders.ts";

/**
 * 管理端「全量订单」的持续测试（P8C）。
 *
 * 跑的是**真实实现**：真实的 Mock 支付仓储 + 真实的 `lib/services/adminOrders.ts`。
 * 因此「列表按创建时间倒序且稳定」「列表不带敏感字段」「详情金额快照自洽」
 * 「本阶段订单详情只读」这些规则每次提交都会被重新验证。
 *
 * 每个用例开始前重建支付仓储（拿到干净的预置订单）。其它仓储不重建：
 * 订单服务只读它们，任何一次写入都应当在这里暴露出来。
 */
const UI_SURFACE = "server";

function page(overrides = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params;
}

async function allOrders() {
  return getPaymentRepository().queryOrdersForAdmin(ADMIN_ORDER_UNFILTERED_QUERY);
}

async function list(query = {}, params = page()) {
  const resolved = await resolveAdminOrderListQuery(params, false);
  return queryAdminOrderList({ ...resolved, ...query }, params, UI_SURFACE);
}

beforeEach(() => {
  resetMockStore("payment");
});

test("列表默认按创建时间倒序，同一时间按 id 兜底（顺序稳定，翻页不会重复）", async () => {
  const data = await list({ pageSize: 100 });

  assert.ok(data.total > 10, "预置订单太少，这条断言失去意义");
  for (let index = 1; index < data.items.length; index += 1) {
    const previous = data.items[index - 1];
    const current = data.items[index];
    assert.ok(
      previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id < current.id),
      `第 ${index} 条的顺序不满足「创建时间倒序 + id 兜底」`,
    );
  }

  // 翻页不重不漏：两页拼起来必须等于一次取回的前 N 条
  const first = await list({ page: 1, pageSize: 4 });
  const second = await list({ page: 2, pageSize: 4 });
  const whole = await list({ page: 1, pageSize: 8 });
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    whole.items.map((item) => item.id),
  );
  assert.equal(first.total, whole.total, "total 是过滤后的总数，不随页码变化");
  // 两页拼起来正好是前 8 条，因此「后面还有吗」的答案必须与一次取 8 条时一致：
  // hasMore 只表示「还有更多」，不是「这一页满了」
  assert.equal(second.hasMore, whole.hasMore, "hasMore 应当只取决于还剩多少条");
});

test("关键词搜索：订单号 / 用户昵称 / 平台 ID / 商品名四处任一命中", async () => {
  const orders = await allOrders();
  const sample = orders[0];
  assert.ok(sample, "预置订单为空");

  const detail = await getAdminOrderDetail(sample.id, undefined, UI_SURFACE);
  const nickname = detail.user.nickname;
  const displayId = detail.user.displayId;
  assert.ok(nickname.length > 0 && displayId.length > 0, "预置订单应当能找到对应用户");

  for (const [label, keyword] of [
    ["订单号", sample.orderNo],
    ["商品名", sample.productTitle],
    ["用户昵称", nickname],
    ["平台 ID", displayId],
  ]) {
    const data = await list({ keyword, pageSize: 100 });
    assert.ok(
      data.items.some((item) => item.id === sample.id),
      `按${label}「${keyword}」没有搜到这一单`,
    );
    // 搜出来的每一条都确实在四处之一命中了关键词——不是「搜了但没筛」
    const needle = keyword.toLowerCase();
    assert.equal(
      data.items.every((item) =>
        [item.orderNo, item.productTitle, item.user.nickname, item.user.displayId].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      ),
      true,
      `按${label}搜出来的每一条都应当命中关键词`,
    );
  }

  // 大小写不敏感（订单号里有字母）
  const upper = await list({ keyword: sample.orderNo.toUpperCase(), pageSize: 100 });
  assert.ok(upper.items.some((item) => item.id === sample.id), "关键词应当大小写不敏感");

  const none = await list({ keyword: "不存在的关键词-zzz" });
  assert.equal(none.items.length, 0);
  assert.equal(none.total, 0);
  assert.equal(none.hasMore, false, "空结果不该说「后面还有」");
});

test("组合筛选：状态、游戏、时间范围与关键词同时生效", async () => {
  const orders = await allOrders();
  const sample = orders.find((order) => order.status === "completed") ?? orders[0];
  const day = orderBeijingDate(sample);

  const data = await list({
    status: sample.status,
    game: sample.gameName,
    from: day,
    to: day,
    keyword: sample.orderNo,
    pageSize: 100,
  });
  assert.equal(data.total, 1, "四个条件同时指向同一单时应当只剩一条");
  assert.equal(data.items[0].id, sample.id);
  assert.equal(data.items[0].status, sample.status);
  assert.equal(data.items[0].gameName, sample.gameName);

  // 每一条都确实满足全部条件——组合筛选不是「任一命中」
  const loose = await list({ status: sample.status, game: sample.gameName, pageSize: 100 });
  for (const item of loose.items) {
    assert.equal(item.status, sample.status);
    assert.equal(item.gameName, sample.gameName);
  }

  // 把时间范围挪到这一单的前一天：结果里不能再有它
  const before = await list({ status: sample.status, to: "2000-01-01", pageSize: 100 });
  assert.equal(before.items.some((item) => item.id === sample.id), false);

  // 游戏筛选确实起作用：先找一个不是所有订单都用的游戏
  const games = new Set(orders.map((order) => order.gameName));
  if (games.size > 1) {
    const only = await list({ game: sample.gameName, pageSize: 100 });
    assert.equal(
      only.items.every((item) => item.gameName === sample.gameName),
      true,
      "按游戏筛选后不该混进别的游戏",
    );
    assert.ok(only.total < orders.length, "游戏筛选应当真的减少结果");
  }
});

test("非法筛选条件：接口报 400，页面收敛到默认值（两条路径刻意不同）", async () => {
  // 页面用宽松模式：地址栏改坏了不该变成一屏 400
  for (const params of [
    page({ status: "whatever" }),
    page({ game: "不存在的游戏" }),
    page({ from: "2026/09/01" }),
    page({ from: "2026-09-10", to: "2026-09-01" }),
  ]) {
    const resolved = await resolveAdminOrderListQuery(params, false);
    assert.equal(typeof resolved.status, "string");
    assert.equal(Number.isInteger(resolved.page), true);
  }

  // 接口用严格模式：同样的值一律 400，且带上各自的说明
  for (const [params, message] of [
    [page({ status: "whatever" }), ADMIN_ORDER_STATUS_INVALID_MESSAGE],
    [page({ game: "不存在的游戏" }), ADMIN_ORDER_GAME_INVALID_MESSAGE],
    [page({ from: "2026/09/01" }), ADMIN_ORDER_DATE_INVALID_MESSAGE],
    [page({ from: "2026-09-10", to: "2026-09-01" }), ADMIN_ORDER_DATE_RANGE_INVALID_MESSAGE],
  ]) {
    await assert.rejects(resolveAdminOrderListQuery(params, true), (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, message);
      return true;
    });
  }

  // 分页参数永远不规范化为 400：翻到 0 页不是「筛错了」
  const clamped = await resolveAdminOrderListQuery(page({ page: "0", pageSize: "9999" }), true);
  assert.equal(clamped.page, 1);
  assert.ok(clamped.pageSize > 0);
});

test("列表 DTO 只带摘要：没有游戏账号、备注、增值明细、售后摘要与任何身份标识", async () => {
  const data = await list({ pageSize: 5 });
  assert.ok(data.items.length > 0);

  const allowed = new Set([
    "id",
    "orderNo",
    "status",
    "statusLabel",
    "createdAt",
    "paidAt",
    "gameName",
    "productTitle",
    "specName",
    "quantity",
    "totalAmount",
    "user",
  ]);

  for (const item of data.items) {
    assert.deepEqual(new Set(Object.keys(item)), allowed, "列表项的字段集合变了");
    assert.deepEqual(
      new Set(Object.keys(item.user)),
      new Set(["id", "displayId", "nickname"]),
      "用户摘要多带了字段",
    );
  }

  // 敏感字段名一个都不该出现在序列化结果里（值可能恰好为空，因此看键名）
  const serialized = JSON.stringify(data);
  for (const forbidden of [
    "gameAccountId",
    "remark",
    "addons",
    "refundSummary",
    "complaintSummary",
    "conversationSummary",
    "reviewSummary",
    "openid",
    "openId",
    "unionid",
    "unionId",
    "cookie",
    "sessionId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `列表 DTO 出现了 ${forbidden}`);
  }
});

test("列表里只有支付成功之后的订单：内部支付请求不进普通订单列表", async () => {
  const data = await list({ pageSize: 200 });
  assert.ok(data.items.length > 0);

  // 订单状态只有这五种；`pending`（待付款）在用户端与后台都不存在
  const allowed = new Set(ORDER_STATUSES);
  for (const item of data.items) {
    assert.ok(allowed.has(item.status), `列表出现了不是订单状态的 ${item.status}`);
    assert.notEqual(item.status, "pending", "订单在支付成功那一刻生成，不该有待付款");
  }

  // 预售商品的展示状态里有 pending，它必须与订单状态是两回事
  assert.equal(ORDER_STATUSES.includes("pending"), false);
});

test("订单详情的金额快照自洽：单价×数量=小计，小计+增值=实付", async () => {
  const orders = await allOrders();

  for (const order of orders.slice(0, 12)) {
    const detail = await getAdminOrderDetail(order.id, undefined, UI_SURFACE);
    assert.ok(detail, `${order.id} 应当能取到详情`);

    assert.equal(
      detail.unitPrice * detail.quantity,
      detail.itemsAmount,
      `${order.id} 的单价×数量与商品小计对不上`,
    );
    assert.equal(
      detail.itemsAmount + detail.addonsAmount,
      detail.totalAmount,
      `${order.id} 的商品小计+增值与实付对不上`,
    );
    assert.equal(
      detail.addons.reduce((sum, addon) => sum + addon.price, 0),
      detail.addonsAmount,
      `${order.id} 的增值明细之和与增值合计对不上`,
    );
    assert.equal(detail.totalAmount, order.totalAmount, "详情不该改掉订单自己的实付金额");
  }
});

test("订单详情是只读的：没有 allowedActions，也没有任何写订单的服务", async () => {
  const orders = await allOrders();
  const detail = await getAdminOrderDetail(orders[0].id, undefined, UI_SURFACE);
  assert.ok(detail);

  assert.equal(
    Object.hasOwn(detail, "allowedActions"),
    false,
    "订单详情不该给出可执行动作——本阶段它只读，写订单的唯一路径是退款审核通过",
  );

  // 详情带上的是列表项的全部字段 + 只读明细，不含任何「能不能改」的开关
  for (const forbidden of ["canUpdate", "canCancel", "canAssign", "canRefund", "actions"]) {
    assert.equal(Object.hasOwn(detail, forbidden), false, `订单详情多出了 ${forbidden}`);
  }

  assert.equal(await getAdminOrderDetail("ord-nope", undefined, UI_SURFACE), null);
  assert.equal(await getAdminOrderDetail("", undefined, UI_SURFACE), null);
});

test("订单详情的时间轴与售后摘要取自真实记录，且不复制退款原因与投诉正文", async () => {
  const orders = await allOrders();
  const withTimeline = [];

  for (const order of orders.slice(0, 12)) {
    const detail = await getAdminOrderDetail(order.id, undefined, UI_SURFACE);
    assert.ok(detail);
    assert.ok(detail.timeline.length > 0, "每一单都至少有一个已发生的节点");
    assert.equal(detail.timeline[0].key, "paid", "时间轴从支付成功开始——订单就是那时生成的");
    for (const entry of detail.timeline) {
      assert.ok(typeof entry.at === "string" && entry.at.length > 0, "时间轴节点必须有时间");
    }
    withTimeline.push(detail);
  }

  // 有退款的订单：摘要只有 id / 状态 / 金额 / 时间，没有原因与说明
  const withRefund = withTimeline.find((detail) => detail.refundSummary);
  if (withRefund) {
    assert.deepEqual(
      new Set(Object.keys(withRefund.refundSummary)),
      new Set(["id", "status", "amount", "createdAt"]),
      "退款摘要多带了字段（原因、说明、凭证都不该在这一层）",
    );
    assert.ok(withRefund.refundSummary.amount > 0);
  }

  // 有投诉的订单：摘要只回答「有几条、最近一条什么状态」
  const withComplaint = withTimeline.find((detail) => detail.complaintSummary);
  if (withComplaint) {
    assert.deepEqual(
      new Set(Object.keys(withComplaint.complaintSummary)),
      new Set(["count", "latestId", "latestStatus", "latestStatusLabel", "latestCreatedAt"]),
      "投诉摘要多带了字段（正文、凭证、联系方式都不该在这一层）",
    );
  }
});

test("分页参数稳定：pageSize 默认值与上限都由常量决定，翻页不会撞到边界", async () => {
  const resolved = await resolveAdminOrderListQuery(page(), true);
  assert.equal(resolved.pageSize, ADMIN_ORDER_PAGE_SIZE);
  assert.equal(resolved.page, 1);

  const data = await list({ page: 999, pageSize: 5 });
  assert.equal(data.page, 999, "越界页码不报错，返回空页由页面渲染空态");
  assert.equal(data.items.length, 0);
  assert.equal(data.hasMore, false);
});
