import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  acceptDispatch,
  sweepExpiredDispatches,
} from "../lib/data/companionDispatchTransaction.ts";
import { getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getAdminOrderDetail } from "../lib/services/adminOrders.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";

/**
 * 管理端订单详情里的**两个**护航字段（P0-5）。
 *
 * ## 这一条守的是什么
 *
 * 需求（业务流程表 BF-13 / 异常表 EX-DISPATCH-06）说的是：
 *
 * > 用户指定 A → A 十分钟没接 → 进公共池 → B 接单。
 * > 管理端**必须同时显示**「指定护航：A」与「实际接单：B」。
 *
 * 也就是说，这一条要求的**不是**「数据里存着 A 和 B」（那是 `dispatch.test.mjs`
 * 已经在守的），而是**管理端真的把两个都端出来了**：
 * `AdminOrderDetail.exclusiveCompanion` 与 `AdminOrderDetail.actualCompanion`。
 *
 * 只留一个字段的后果是具体的：客服再也回答不了「我明明指定了 A，怎么是 B 在打」——
 * 后台只会显示 B，而用户说的 A 在系统里无处可查。
 *
 * ## 为什么必须单独一个文件
 *
 * 这一条要的顺序是「下单指定 → 专属池到点 → 别人接走」，也就是要同时动
 * `payment` / `dispatch` / `companion` 三份 Mock 存储。`tests/adminOrders.test.mjs`
 * 刻意只重建 payment（那里的用例只读其它仓储），把这段装配塞进去会破坏它的前提。
 *
 * ## 时间
 *
 * 一次都不等真实时间：判定与清扫用的 `at` 全部由订单的 `paidAt` 推算后显式传入。
 * `getAdminOrderDetail()` 内部用**真实时钟**清扫一次，因此这里被观察的时刻都落在
 * 真实时间之前（专属池固定 10 分钟），它不会改到这些记录。
 */

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的两位：`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";
const COMPANION_B = "cp-2";

let seq = 0;
function unique(tag) {
  seq += 1;
  return `${tag}-p05adm-${process.pid}-${seq}`;
}

beforeEach(() => {
  // 这一条链路会写订单、派单、通知，并读护航名单与平台配置：几份存储都从预置数据重新建仓
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("companion");
  resetMockStore("notification");
  resetMockStore("platformConfig");
});

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
async function placeOrder(companionId = null) {
  const user = unique("u");
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId,
      idempotencyKey: unique("key"),
    },
    user,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", user);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这一条用例需要一张新订单");
  return confirmed.order;
}

async function dispatchOf(orderId) {
  const record = await getDispatchRepository().findDispatchByOrderId(orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  return record;
}

async function detailOf(orderId) {
  const detail = await getAdminOrderDetail(orderId, undefined, "server");
  assert.ok(detail, `订单 ${orderId} 必须能在后台取到详情`);
  return detail;
}

/**
 * 断言快照只带公开信息。
 *
 * 多一个身份字段（例如 `userId`），那位护航的账号就会顺着后台订单详情发出去——
 * 这与池子 DTO 的字段白名单是同一个要求（权限表 §10 数据最小化）。
 */
function assertPublicSnapshot(snapshot, expectedId, label) {
  assert.ok(snapshot, `${label}必须给出快照，而不是 null`);
  assert.equal(snapshot.id, expectedId, `${label}指向的应当是 ${expectedId}`);
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ["avatarUrl", "id", "name"],
    `${label}快照只允许 id / 昵称 / 头像`,
  );
  assert.ok(snapshot.name.length > 0, `${label}要显示得出昵称`);
}

test("管理端：指定 A、实际 B 时，两个字段同时给出且分别指向 A 与 B", async () => {
  const order = await placeOrder(COMPANION_A);
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "exclusive");

  // A 十分钟没接：专属池到点转公共池，指定事实原样保留
  const moved = sweepExpiredDispatches(dispatch.exclusiveDeadlineAt);
  assert.ok(moved.movedToPublicDispatchIds.includes(dispatch.id));

  // B 从公共池接走
  const byB = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_B,
    at: plusMinutes(dispatch.exclusiveDeadlineAt, 1),
  });
  assert.equal(byB.kind, "ok");

  const detail = await detailOf(order.id);
  assertPublicSnapshot(detail.exclusiveCompanion, COMPANION_A, "「指定护航」");
  assertPublicSnapshot(detail.actualCompanion, COMPANION_B, "「实际接单」");
  assert.notEqual(
    detail.exclusiveCompanion.id,
    detail.actualCompanion.id,
    "指定的人与实际接单的人是两个人——两个字段说的是各自的来源，不是互相抄",
  );
});

test("管理端：没指定人时「指定护航」为 null，不拿实际接单的人去填它", async () => {
  const order = await placeOrder();
  const dispatch = await dispatchOf(order.id);
  assert.equal(dispatch.state, "public", "没指定人就直接进公共池");
  assert.equal((await detailOf(order.id)).exclusiveCompanion, null, "「用户指定过谁」这件事没有发生");

  await acceptDispatch(dispatch.id, { companionId: COMPANION_B, at: plusMinutes(order.paidAt, 1) });

  const detail = await detailOf(order.id);
  assert.equal(
    detail.exclusiveCompanion,
    null,
    "有实际接单的人不代表用户指定过谁：填上 B 会让后台凭空多出一条「用户指定 B」",
  );
  assertPublicSnapshot(detail.actualCompanion, COMPANION_B, "「实际接单」");
});

test("管理端：指定 A 且 A 自己接单时，两个字段都是 A", async () => {
  const order = await placeOrder(COMPANION_A);
  const dispatch = await dispatchOf(order.id);

  const byA = await acceptDispatch(dispatch.id, {
    companionId: COMPANION_A,
    at: plusMinutes(order.paidAt, 1),
  });
  assert.equal(byA.kind, "ok");

  const detail = await detailOf(order.id);
  assertPublicSnapshot(detail.exclusiveCompanion, COMPANION_A, "「指定护航」");
  assertPublicSnapshot(detail.actualCompanion, COMPANION_A, "「实际接单」");
});
