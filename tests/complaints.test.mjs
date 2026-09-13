import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  COMPLAINT_STATUSES,
  COMPLAINT_DESCRIPTION_MAX_LENGTH,
  mergeComplaintPage,
} from "../lib/constants/complaints.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { complaintSeed } from "../lib/mocks/fixtures/complaintSeed.ts";
import { orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import {
  createComplaintForUser,
  getComplaintDetailForUser,
  getOrderComplaintSummary,
  queryComplaintsForUser,
} from "../lib/services/complaints.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";

/**
 * 投诉业务的持续测试。
 *
 * 跑真实实现：真实的 Mock 仓储 + 真实的 `lib/services/complaints.ts`。
 * 重点覆盖四件事：**只能投诉自己的订单**、**投诉不改动订单状态**、
 * **列表 DTO 不带投诉内容**、**重复提交只产生一条记录**。
 *
 * 每个用例开始前重建投诉 store，拿到干净的预置数据。订单 store 不重建：
 * 投诉本来就不该改动订单，任何用例把订单改了都应当在这里暴露。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 没有任何预置投诉的订单（属于 USER_A） */
const CLEAN_ORDER = "ord-seed-1001-02";
/** 预置了一条「处理中」投诉的订单 */
const PRESET_COMPLAINT_ORDER = "ord-seed-1001-12";

function key() {
  return crypto.randomUUID();
}

function complaintBody(overrides = {}) {
  return {
    typeKey: "companion_service",
    description: "约好的时间打手迟到了四十分钟，也没有提前说明。",
    contact: "",
    evidence: [],
    orderId: "",
    idempotencyKey: key(),
    ...overrides,
  };
}

function params(input = {}) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (value !== undefined) search.set(name, String(value));
  }
  return search;
}

function list(userId, input) {
  return queryComplaintsForUser(userId, params(input), "server");
}

async function expectApiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("complaint");
});

test("可以不关联订单提交，提交后立刻出现在列表最前且状态是待处理", async () => {
  const before = await list(USER_A, { pageSize: 20 });
  const { complaintId, created } = await createComplaintForUser(
    USER_A,
    complaintBody({ typeKey: "platform_service" }),
    undefined,
    "server",
  );
  assert.equal(created, true);

  const after = await list(USER_A, { pageSize: 20 });
  assert.equal(after.total, before.total + 1);
  assert.equal(after.items[0].id, complaintId);
  assert.equal(after.items[0].status, "pending");
  // 未关联订单的投诉如实显示，不编一个订单号出来
  assert.equal(after.items[0].orderNo, null);
});

test("关联自己的订单提交：订单号被快照下来，但订单状态一个字段都不变", async () => {
  const before = await getOrderDetailForUser(CLEAN_ORDER, USER_A, undefined, "server");
  assert.equal(before.complaintSummary, null);

  const { complaintId } = await createComplaintForUser(
    USER_A,
    complaintBody({ orderId: CLEAN_ORDER, typeKey: "payment_issue" }),
    undefined,
    "server",
  );

  const after = await getOrderDetailForUser(CLEAN_ORDER, USER_A, undefined, "server");
  // 订单状态没有变化，只是多了一条投诉摘要
  assert.equal(after.status, before.status);
  assert.equal(after.complaintSummary.count, 1);
  assert.equal(after.complaintSummary.latestId, complaintId);
  assert.equal(after.complaintSummary.latestStatus, "pending");

  const detail = await getComplaintDetailForUser(complaintId, USER_A, undefined, "server");
  assert.equal(detail.orderId, CLEAN_ORDER);
  assert.equal(detail.orderNo, before.orderNo);
  assert.equal(detail.result, "");
});

test("不能投诉别人的订单，也不能投诉一笔不存在的订单", async () => {
  const otherOrder = orderSeed.find((order) => order.userId === USER_B);
  await expectApiError(
    createComplaintForUser(USER_A, complaintBody({ orderId: otherOrder.id }), undefined, "server"),
    "NOT_FOUND",
  );
  await expectApiError(
    createComplaintForUser(USER_A, complaintBody({ orderId: "ord-not-exist" }), undefined, "server"),
    "NOT_FOUND",
  );

  // 失败的两次提交都没有留下记录
  const mine = await list(USER_A, { pageSize: 20 });
  assert.equal(mine.total, complaintSeed.filter((item) => item.userId === USER_A).length);
});

test("同一个幂等键重复提交只产生一条投诉", async () => {
  const body = complaintBody({ typeKey: "refund_dispute" });
  const first = await createComplaintForUser(USER_A, body, undefined, "server");
  const second = await createComplaintForUser(USER_A, body, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.complaintId, first.complaintId);
});

test("非法类型、空描述与超长描述都被拒绝", async () => {
  await expectApiError(
    createComplaintForUser(USER_A, complaintBody({ typeKey: "not_a_type" }), undefined, "server"),
    "BAD_REQUEST",
  );
  await expectApiError(
    createComplaintForUser(USER_A, complaintBody({ description: "   " }), undefined, "server"),
    "BAD_REQUEST",
  );
  await expectApiError(
    createComplaintForUser(
      USER_A,
      complaintBody({ description: "啊".repeat(COMPLAINT_DESCRIPTION_MAX_LENGTH + 1) }),
      undefined,
      "server",
    ),
    "BAD_REQUEST",
  );
  // 提交进来的 status / result 不会被采纳：投诉状态与处理结果只能由平台侧产生
  const { complaintId } = await createComplaintForUser(
    USER_A,
    complaintBody({ status: "resolved", result: "已为你免单" }),
    undefined,
    "server",
  );
  const detail = await getComplaintDetailForUser(complaintId, USER_A, undefined, "server");
  assert.equal(detail.status, "pending");
  assert.equal(detail.result, "");
});

test("用户隔离：只能看到与打开自己的投诉", async () => {
  const mine = await list(USER_A, { pageSize: 20 });
  const other = complaintSeed.find((item) => item.userId === USER_B);

  assert.ok(mine.items.every((item) => item.id !== other.id));
  assert.equal(await getComplaintDetailForUser(other.id, USER_A, undefined, "server"), null);
  assert.equal(await getComplaintDetailForUser(mine.items[0].id, USER_B, undefined, "server"), null);
});

test("状态筛选：四个状态各有预置数据，且筛选结果不含别的状态", async () => {
  for (const status of COMPLAINT_STATUSES) {
    const result = await list(USER_A, { status, pageSize: 20 });
    assert.ok(result.total > 0, `状态 ${status} 应当有预置投诉`);
    assert.ok(result.items.every((item) => item.status === status));
  }

  // 非法状态是明确的业务条件写错，报错而不是静默当成「全部」
  await expectApiError(list(USER_A, { status: "unknown" }), "BAD_REQUEST");
});

test("列表 DTO 只带摘要：不含投诉说明、凭证、联系方式与处理结果", async () => {
  const result = await list(USER_A, { pageSize: 20 });
  const item = result.items.find((row) => row.id === "cmp-seed-1001-03");
  assert.ok(item, "预置的「已处理」投诉应当出现在列表里");
  assert.deepEqual(Object.keys(item).sort(), [
    "complaintNo",
    "createdAt",
    "id",
    "orderNo",
    "status",
    "typeLabel",
    "updatedAt",
  ]);

  // 同样一条投诉，详情里才有完整内容
  const detail = await getComplaintDetailForUser("cmp-seed-1001-03", USER_A, undefined, "server");
  assert.equal(typeof detail.description, "string");
  assert.ok(detail.description.length > 0);
  assert.equal(typeof detail.result, "string");
  assert.ok(detail.result.length > 0);
});

test("预置的处理结果不承诺平台没有承诺过的东西", async () => {
  const forbidden = ["免单", "补偿", "赔偿", "退款", "返现", "赔付"];
  for (const item of complaintSeed) {
    for (const word of forbidden) {
      assert.ok(
        !item.result.includes(word),
        `预置投诉 ${item.id} 的处理结果出现了承诺性字眼「${word}」`,
      );
    }
  }

  // 预置投诉同样不许关联别人的订单
  for (const item of complaintSeed) {
    if (!item.orderId) continue;
    const order = orderSeed.find((order) => order.id === item.orderId);
    assert.equal(order.userId, item.userId);
  }
});

test("订单详情里的投诉摘要只回答「有没有、到哪一步」", async () => {
  const summary = await getOrderComplaintSummary(PRESET_COMPLAINT_ORDER);
  assert.equal(summary.count, 1);
  assert.equal(summary.latestStatus, "processing");
  assert.deepEqual(Object.keys(summary).sort(), [
    "count",
    "latestCreatedAt",
    "latestId",
    "latestStatus",
    "latestStatusLabel",
  ]);

  // 没有投诉的订单没有摘要
  assert.equal(await getOrderComplaintSummary(CLEAN_ORDER), null);
});

test("加载更多：追加而不是替换，重复的投诉只出现一次", async () => {
  const first = await list(USER_A, { page: 1, pageSize: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);

  const second = await list(USER_A, { page: 2, pageSize: 2 });
  const merged = mergeComplaintPage(first, second);

  assert.equal(merged.items.length, 4);
  assert.equal(new Set(merged.items.map((item) => item.id)).size, 4);
  assert.deepEqual(merged.items.map((item) => item.id), [
    ...first.items.map((item) => item.id),
    ...second.items.map((item) => item.id),
  ]);

  // 重复合并同一页不会把列表撑长
  const again = mergeComplaintPage(merged, second);
  assert.equal(again.items.length, 4);
});
