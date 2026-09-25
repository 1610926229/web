import assert from "node:assert/strict";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { plusMinutes } from "../lib/constants/dispatch.ts";
import {
  STAFF_MAX_PAGE,
  STAFF_MAX_PAGE_SIZE,
  STAFF_ORDER_NOT_FOUND_MESSAGE,
  STAFF_PAGE_SIZE,
  buildStaffOrderListQuery,
} from "../lib/constants/staff.ts";
import { acceptDispatch } from "../lib/data/companionDispatchTransaction.ts";
import { startCompanionOrder as startCompanionOrderTransaction } from "../lib/data/companionOrderTransaction.ts";
import { submitCompletion } from "../lib/data/completionTransaction.ts";
import { completionStore } from "../lib/data/mockCompletionRepository.ts";
import { dispatchStore } from "../lib/data/mockDispatchRepository.ts";
import { paymentStore } from "../lib/data/mockPaymentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getUserRepository } from "../lib/data/userRepository.ts";
import { confirmPaymentRequest, createPaymentRequest } from "../lib/services/checkout.ts";
import {
  getStaffOrderDetail,
  listOrdersForStaff,
  resolveStaffOrderListQuery,
} from "../lib/services/staffOrders.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * P0-10「客服全量订单查询工作台」的持续测试。
 *
 * 本文件钉四件事：
 *
 * 1. **查询条件解析**：非法枚举报 400、非法值在页面上回落默认、分页参数规范化
 *    （`clampPage` / `clampPageSize` 与业务筛选**行为不同是刻意的**）；
 * 2. **列表语义**：筛选真实生效、创建时间倒序 + 稳定次级排序、
 *    关键词匹配（订单号 / 商品名 / 昵称 / 平台 ID `displayId` / 内部 ID `user.id`）、
 *    分页切片**排在关键词过滤之后**（否则 `total` 与能翻到的条数会分叉）；
 * 3. **DTO 边界**：列表项 / 详情 / 派单摘要的 **key 集合精确相等**，不是「不含某几个」。
 *    客服不可见分账比例与平台净收入（用户权限表 §7.2 / `cmd_p0-10.md`），
 *    这条边界只有写成「全集」才挡得住以后给 `Order` 加字段时顺手漏出去；
 * 4. **两个惰性物化真的挂在读取路径上**（行为断言，不是源码字符串匹配）。
 *    这是本文件最重要的一组：漏挂产生的是一条**只在没人在别处访问时才出现**的错误状态，
 *    源码扫描挡不住「调用被挪到读仓储之后」，只有真读一次才看得出来。
 *
 * ## 用例之间怎么隔离
 *
 * `beforeEach` 重置与订单相关的六个 store（与 `tests/completions.test.mjs` 同一份清单）。
 * ⚠️ 预置数据里**有**属于 `u-1001` 的订单（`lib/mocks/fixtures/orderSeed.ts` 的
 * `ord-seed-1001-01` 等十余条）。因此**不要**用「按 `u-1001` 搜到几条」写死计数——
 * 那会把本文件的断言绑死在 seed 的规模上。计数类断言一律**先把自己的单筛出来**
 * （按本文件生成的订单号 / id），或者写成自洽式（`total === items.length` 之类）。
 *
 * ## 关于 `u-1001`
 *
 * 它是 `lib/constants/mockUsers.ts` 里「下单用户（老板 A）」，**在用户记录里真实存在**。
 * 必须用真实存在的用户：关键词匹配的 `displayId` / `userId` 都取自用户记录，
 * 用户记录缺失时传空串（「查不到的用户」不该被任何关键词搜出来）。
 *
 * ⚠️ 他的**平台 ID**（`displayId`，用户资料页上那串）**不是** `u-1001`——
 * 那是内部标识。两串都参与匹配、都在列表上显示，因此本文件两条都要钉：
 * 用户打电话来报的是前者，客服从会话页粘过来的是后者。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 目录里真实存在的可购买商品：机密400万 / 2990 分。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };

/** 预置护航名单里的一位，`enabled: true` / `available: true` / 未移除。 */
const COMPANION_A = "cp-1";

/** 「老板 A」——见文件头。所有计数类断言都建立在「seed 里他没有订单」这一点上。 */
const ORDER_USER = "u-1001";

let seq = 0;
function uniqueKey() {
  seq += 1;
  return `p010key-${process.pid}-${seq}`;
}

/** 走完整下单链路（创建支付请求 → 支付成功），返回订单。 */
async function placeOrder(overrides = {}) {
  const created = await createPaymentRequest(
    {
      ...PRODUCT,
      quantity: 1,
      addonIds: [],
      gameAccountId: "moyu_test",
      remark: "",
      companionId: null,
      ...overrides,
      idempotencyKey: uniqueKey(),
    },
    ORDER_USER,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", ORDER_USER);
  assert.equal(confirmed.ok, true, "支付成功链路必须走通");
  assert.equal(confirmed.orderCreated, true, "这条用例需要一张新订单");
  return confirmed.order;
}

/**
 * 组装一个列表查询条件。
 *
 * ⚠️ 刻意走 `buildStaffOrderListQuery` 而不是手写对象：分页规范化就住在它里面，
 * 手写对象会让「pageSize 上限收敛」这条规则在测试里被绕过（测了个假对象）。
 * 状态与游戏是**已经解析好**的入参（与接口 / 页面两条调用路径一致），因此直接传值。
 */
function listQuery({ status = "all", game = "", ...params } = {}) {
  return buildStaffOrderListQuery({
    params: new URLSearchParams(params),
    status,
    game,
  });
}

async function list(params) {
  return listOrdersForStaff(listQuery(params), new URLSearchParams(), "server");
}

async function detail(orderId) {
  return getStaffOrderDetail(orderId, new URLSearchParams(), "server");
}

/**
 * 把某张订单的派单**钉在公共池里、且截止时间已经过去**。
 *
 * 与 `tests/companionPoolOrder.test.mjs` 的 `pinPublicPoolEntry` 同一条工程约束：
 * `publicPoolEnteredAt` 取的是支付成功那一刻的真实 `new Date()`，测试控制不了，
 * 因此「已经超时」这个事实只能在夹具里布置。仓储返回的是 Map 里的**活对象引用**
 * （`mockDispatchRepository.findDispatchByOrderId` 直接 `dispatches.get(id)`），
 * 写进去的值后续读取真的会看到；而**清扫仍然真实执行**，只有这一个输入被固定。
 *
 * ⚠️ 只改「进池时刻」而留着旧的截止时间会让夹具自相矛盾，因此两者一起写。
 */
function pinExpiredPublicDispatch(orderId, minutesAgo = 30, timeoutMinutes = 10) {
  const record = [...dispatchStore().dispatches.values()].find((entry) => entry.orderId === orderId);
  assert.ok(record, `订单 ${orderId} 必须有派单记录`);
  assert.equal(record.state, "public", "这条用例需要一张正在公共池等人接的单");

  record.publicPoolEnteredAt = plusMinutes(new Date().toISOString(), -minutesAgo);
  record.publicDeadlineAt = plusMinutes(record.publicPoolEnteredAt, timeoutMinutes);
  record.publicTimeoutMinutesSnapshot = timeoutMinutes;
  assert.ok(Date.parse(record.publicDeadlineAt) <= Date.now(), "前置条件：截止时间必须已经过去");
  return record;
}

beforeEach(() => {
  resetMockStore("payment");
  resetMockStore("dispatch");
  resetMockStore("completion");
  resetMockStore("refund");
  resetMockStore("complaint");
  resetMockStore("platformConfig");
});

// ——————————————————————— 一、查询条件解析 ———————————————————————

test("解析 1：严格模式下非法 status / game / 日期一律 400，合法值原样通过", async () => {
  const strict = (query) => resolveStaffOrderListQuery(new URLSearchParams(query), true);

  await assert.rejects(
    () => strict({ status: "bogus" }),
    (error) => error.code === "BAD_REQUEST" && error.status === 400,
    "非法状态必须报 400：静默按「不限」处理会让页面显示一批与筛选栏不符的订单",
  );
  await assert.rejects(
    () => strict({ game: "不存在的游戏" }),
    (error) => error.code === "BAD_REQUEST" && error.status === 400,
  );
  await assert.rejects(
    () => strict({ from: "2026/09/01" }),
    (error) => error.code === "BAD_REQUEST" && error.status === 400,
    "只接受 YYYY-MM-DD：Date.parse 会放行 `2026/9/1` 这类与页面展示对不上的写法",
  );
  await assert.rejects(
    () => strict({ to: "2026-13-45" }),
    (error) => error.code === "BAD_REQUEST" && error.status === 400,
    "形状对但日期不存在的也要挡住",
  );
  await assert.rejects(
    () => strict({ from: "2026-09-10", to: "2026-09-01" }),
    (error) => error.code === "BAD_REQUEST" && error.status === 400,
    "开始晚于结束必然是空结果，但它更像一次写错的查询而不是「没有数据」",
  );

  // 缺省即合法：四个条件都缺失时是「全部订单、不限时间」
  const bare = await strict({});
  assert.equal(bare.status, "all");
  assert.equal(bare.game, "");
  assert.equal(bare.from, "");
  assert.equal(bare.to, "");
  assert.equal(bare.keyword, "");

  // 合法游戏名取自在库订单，不是当前商品目录
  const games = (await list({})).games;
  assert.ok(games.length > 0, "预置数据里必须有订单，否则整组用例空转");
  const chosen = await strict({ game: games[0] });
  assert.equal(chosen.game, games[0]);
});

test("解析 2：宽松模式下非法值回落默认，而不是报错", async () => {
  const loose = (query) => resolveStaffOrderListQuery(new URLSearchParams(query), false);

  const bogus = await loose({ status: "bogus", game: "不存在的游戏", from: "2026/09/01", to: "坏了" });
  assert.equal(bogus.status, "all", "页面模式下非法状态回到「全部」——打开就限定成某一类会让「我这一单呢」变成一个要先想清楚状态才查得到的问题");
  assert.equal(bogus.game, "");
  assert.equal(bogus.from, "");
  assert.equal(bogus.to, "");

  assert.equal((await loose({ status: "" })).status, "all", "空串等同于缺省");
  assert.equal((await loose({ status: "  paid  " })).status, "paid", "首尾空格不算非法");
});

test("解析 3：分页参数规范化——非法回默认、超上限收敛，关键词只去空白不截断", () => {
  const clamped = listQuery({ page: "99999", pageSize: "99999", keyword: "  老板A  " });
  assert.equal(clamped.page, STAFF_MAX_PAGE, "页码上限收敛，不能构造出天文数字的偏移量");
  assert.equal(clamped.pageSize, STAFF_MAX_PAGE_SIZE);

  const bad = listQuery({ page: "0", pageSize: "-3" });
  assert.equal(bad.page, 1);
  assert.equal(bad.pageSize, STAFF_PAGE_SIZE, "每页条数缺失 / 非法用默认值");

  const missing = listQuery({});
  assert.equal(missing.page, 1);
  assert.equal(missing.pageSize, STAFF_PAGE_SIZE);

  const raw = "一".repeat(500);
  assert.equal(
    listQuery({ keyword: `   ${raw}   ` }).keyword,
    raw,
    "只去首尾空白，**不截断、不设上限**：搜索框不该在用户打字时把内容吞掉",
  );

  assert.equal(listQuery({ page: "3.7" }).page, 3, "小数截断而不是四舍五入");
});

// ——————————————————————— 二、列表语义 ———————————————————————

test("列表 1：创建时间倒序，且并列时按支付时间、再按 id 兜底（三层比较都要真发生）", async () => {
  // 全量列表：时间必须非递增
  const all = (await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) })).items;
  assert.ok(all.length >= 2, "预置数据里必须有订单");
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(
      all[i - 1].createdAt >= all[i].createdAt,
      `第 ${i} 项 ${all[i].id} 的创建时间比前一项新：列表必须按创建时间倒序`,
    );
  }

  // 构造一组**完全并列**的订单：创建时间与支付时间都写成同一个值。
  // 此时顺序只能由 id 兜底决定——若没有这一层，同一条可能在第一页出现过、翻页又出现一次
  const placed = [await placeOrder(), await placeOrder(), await placeOrder()];
  const pinned = plusMinutes(new Date().toISOString(), -60);
  for (const order of placed) {
    const record = paymentStore().orders.get(order.id);
    assert.ok(record, `订单 ${order.id} 必须还在 store 里`);
    record.createdAt = pinned;
    record.paidAt = pinned;
  }

  // 只看**本用例放下的这三单**：seed 里 u-1001 本来就有订单，把它们的顺序也算进来
  // 会让这条断言取决于预置数据，而它要钉的是比较函数本身
  const mine = placed.map((order) => order.id);
  const rows = (await list({ keyword: ORDER_USER, pageSize: String(STAFF_MAX_PAGE_SIZE) })).items
    .filter((item) => mine.includes(item.id))
    .map((item) => item.id);
  assert.deepEqual(
    rows,
    [...mine].sort(),
    "创建时间与支付时间都并列时，必须按 id 升序兜底——顺序不确定会让同一条在第一页出现过、翻到第二页又出现一次",
  );
  assert.equal(rows.length, 3, "三单都必须出现，少一单这条断言会悄悄退化成「顺序对了但漏了」");
});

test("列表 2：状态、游戏、时间范围三个筛选都真实改变结果集", async () => {
  const all = await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) });
  const paidOnly = await list({ status: "paid", pageSize: String(STAFF_MAX_PAGE_SIZE) });

  assert.ok(paidOnly.items.length > 0, "预置数据里必须有 paid 订单");
  assert.ok(paidOnly.items.length < all.items.length, "状态筛选必须真的把结果集缩小");
  assert.equal(
    paidOnly.items.every((item) => item.status === "paid"),
    true,
    "筛 paid 就只能返回 paid",
  );

  const game = all.games[0];
  const byGame = await list({ game, pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(byGame.items.length > 0, `游戏 ${game} 必须有订单`);
  assert.equal(byGame.items.every((item) => item.gameName === game), true);

  // 时间范围按**北京时间**的自然日算（与页面上显示的那一天同一个口径）
  const sample = all.items[0];
  const day = new Date(Date.parse(sample.createdAt) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const byDay = await list({ from: day, to: day, pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(
    byDay.items.some((item) => item.id === sample.id),
    `订单 ${sample.id} 创建于北京时间的 ${day}，按这一天筛必须筛得到它——用本地时区或 UTC 都会出现「显示 09-12、却被 09-13 筛掉」`,
  );

  // 空结果不是错误：筛到没有数据是正常查询
  const empty = await list({ from: "1990-01-01", to: "1990-01-02" });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.hasMore, false);
});

test("列表 3：关键词命中订单号 / 商品名 / 用户昵称 / 平台 ID / 内部 ID", async () => {
  const order = await placeOrder();
  const id = await listQuery({});

  // 订单号：唯一的，因此结果集合恰好是这一单
  const byOrderNo = await list({ ...id, keyword: order.orderNo });
  assert.deepEqual(
    byOrderNo.items.map((item) => item.id),
    [order.id],
    "客服手里最常拿到的是订单号，它必须能被搜到",
  );

  // 内部标识（客服会话页给的那串 `StaffUserSummary.id`）与昵称。
  // 这两条**不能**断言「结果恰好是这一单」：seed 里 u-1001 本来就有订单，
  // 因此断言的是「命中集合只由这一类用户构成，且包含我这一单」
  const byUserId = await list({ keyword: ORDER_USER, pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(
    byUserId.items.some((item) => item.id === order.id),
    "用户记录存在时，关键词必须能命中内部标识——客服从会话页粘过来时用的就是它",
  );
  assert.equal(
    byUserId.items.every((item) => item.user.id === ORDER_USER),
    true,
    "按内部标识搜索不得命中别的用户：命中理由必须看得出来",
  );

  // 平台 ID：**用户资料页上那串**（`displayId`，P0-10 整改）。
  // 用户打电话来报的就是它——而它此前根本不参与匹配：搜索框写着「平台 ID」，
  // 实际认的却是内部标识，于是客服对着用户念的那串 ID 搜不到任何东西
  const userRecord = await getUserRepository().findUserById(ORDER_USER);
  assert.ok(userRecord, "u-1001 必须在用户记录里真实存在——否则下面的断言钉的是空串命中");
  const displayId = userRecord.displayId;
  assert.notEqual(
    displayId,
    ORDER_USER,
    "平台 ID 与内部标识必须是两个不同的值，否则这条用例什么也没钉住",
  );

  const byDisplayId = await list({ keyword: displayId, pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(
    byDisplayId.items.some((item) => item.id === order.id),
    "用户报出资料页上那串 ID 时，必须搜得到他的订单",
  );
  assert.equal(
    byDisplayId.items.every((item) => item.user.displayId === displayId),
    true,
    "按平台 ID 搜索不得命中别的用户",
  );
  assert.equal(
    byDisplayId.items.every((item) => item.user.id === ORDER_USER),
    true,
    "同一个用户的两串标识必须指向同一个人",
  );

  const byNickname = await list({ keyword: "老板A", pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(byNickname.items.some((item) => item.id === order.id));
  assert.equal(byNickname.items.every((item) => item.user.nickname.includes("老板A")), true);

  // 商品名：用订单自己的商品名，结果里至少要包含它（别的订单也可能同名）
  const byProduct = await list({ keyword: order.productTitle });
  assert.ok(byProduct.items.some((item) => item.id === order.id));

  // 大小写与首尾空白不参与区分
  assert.deepEqual((await list({ keyword: `  ${order.orderNo.toLowerCase()}  ` })).items.length, 1);

  // 命中的理由看得见：列表项带着那个被搜到的用户摘要，两串标识都在里面
  assert.equal(byOrderNo.items[0].user.id, ORDER_USER);
  assert.equal(byOrderNo.items[0].user.displayId, displayId);
  assert.equal(byOrderNo.items[0].user.nickname.length > 0, true);
});

test("列表 4：关键词为空串时是「不搜索」，而**不是**匹配所有含空串的字段", async () => {
  const bare = await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) });
  const blank = await list({ keyword: "   ", pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.deepEqual(
    blank.items.map((item) => item.id),
    bare.items.map((item) => item.id),
    "只打了空格等同于没搜",
  );
  assert.equal(blank.total, bare.total);
});

test("列表 5：分页切片排在关键词过滤之后——翻完所有页必须恰好等于全量一次取回", async () => {
  // 放 5 单，且把创建时间逐一分层，避免并列（并列时顺序落到 id 兜底，仍然确定，但分层更好读）
  const placed = [];
  for (let i = 0; i < 5; i += 1) {
    const order = await placeOrder();
    const record = paymentStore().orders.get(order.id);
    record.createdAt = plusMinutes(new Date().toISOString(), -i - 1);
    record.paidAt = record.createdAt;
    placed.push(order.id);
  }

  // 全量一次取回作为基准。⚠️ 不写死 total：seed 里 u-1001 本来就有订单，
  // 这条用例要钉的是「翻页拼接 == 一次取回」，不是预置数据有多少条
  const pageSize = 2;
  const full = await list({ keyword: ORDER_USER, pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(
    full.total <= STAFF_MAX_PAGE_SIZE,
    "基准这一次取回必须真的是全量，否则下面的等式会变成两条被截断的列表在比",
  );
  assert.equal(full.total, full.items.length, "一次取回时 items 必须就是全部");
  assert.equal(full.hasMore, false, "最后一页必须给出 hasMore=false");
  assert.ok(full.total > pageSize, "总数必须大于一页，否则这条用例只会翻一页、退化成空转");
  for (const id of placed) {
    assert.ok(full.items.some((item) => item.id === id), `本用例放下的 ${id} 必须出现在全量里`);
  }

  const collected = [];
  let page = 1;
  for (;;) {
    const chunk = await list({ keyword: ORDER_USER, page, pageSize: String(pageSize) });
    assert.equal(chunk.page, page);
    assert.equal(chunk.pageSize, pageSize);
    assert.equal(chunk.total, full.total, "每一页的 total 都是**过滤后**的条数，不随页码变");
    collected.push(...chunk.items.map((item) => item.id));
    if (!chunk.hasMore) break;
    page += 1;
    assert.ok(page <= 200, "分页没有收敛：hasMore 一直为真");
  }
  assert.ok(page > 1, "必须真的翻了不止一页");

  assert.deepEqual(collected, full.items.map((item) => item.id), "翻页拼接必须与全量一次取回逐项相同");
  assert.equal(new Set(collected).size, collected.length, "不得出现同一条在两页里各出现一次");

  // total 必须描述**过滤后**的集合：筛成一个必然为空的子集时，不能还报全量条数
  assert.equal((await list({ keyword: "绝不可能命中的关键词-xyzzy" })).total, 0);
});

test("列表 6：游戏筛选项取自全部订单，与当前筛选无关", async () => {
  const all = await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) });
  const filtered = await list({ status: "paid", pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.deepEqual(
    filtered.games,
    all.games,
    "筛了状态之后筛选栏不能只剩一个选项——那正是「目录里新加了游戏但一单没有」那类错误的翻版",
  );
  assert.deepEqual([...all.games].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), all.games, "游戏名按中文顺序排序，顺序稳定可复现");
});

// ——————————————————————— 三、详情与 DTO 边界 ———————————————————————

test("详情 1：订单不存在返回 null，不抛错（口径由调用方决定：接口 404、页面 notFound）", async () => {
  assert.equal(await detail(""), null, "空 id 不该走到仓储");
  assert.equal(await detail("ord-根本不存在"), null);
});

test("详情 2：列表项 / 详情 / 派单摘要的 key 集合**精确相等**，客服看不到分账与平台净收入", async () => {
  const all = await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) });
  assert.ok(all.items.length > 0, "预置数据里必须有订单");

  assert.deepEqual(
    new Set(Object.keys(all.items[0])),
    new Set([
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
    ]),
    "列表项字段表就是边界：写成全集，以后给 Order 加字段时不会顺手漏出去",
  );

  // 找一张**有派单记录**的订单，把派单摘要也验一遍（历史订单可能没有派单记录）
  let withDispatch = null;
  for (const item of all.items) {
    const found = await detail(item.id);
    if (found && found.dispatch) {
      withDispatch = found;
      break;
    }
  }
  assert.ok(withDispatch, "预置数据里必须有带派单记录的订单，否则派单摘要这一段空转");

  assert.deepEqual(
    new Set(Object.keys(withDispatch.dispatch)),
    new Set([
      "state",
      "stateLabel",
      "exclusiveEnteredAt",
      "exclusiveDeadlineAt",
      "publicPoolEnteredAt",
      "publicDeadlineAt",
      "acceptedAt",
      "timedOutAt",
    ]),
    "派单摘要只回答「在哪等、等到什么时候、结果是什么」：两个 *CompanionId 与平台参数快照都不给",
  );

  assert.deepEqual(
    new Set(Object.keys(withDispatch)),
    new Set([
      // P0-11：这一单此刻可执行的两个处置动作。它回答的是「能不能」，不是「做过没有」——
      // 两个布尔值放在详情最外层，与下面的只读内容分开
      "allowedActions",
      "order",
      "user",
      "productCoverUrl",
      "gameName",
      "region",
      "unitPrice",
      "itemsAmount",
      "addonsAmount",
      "addons",
      "originalAmount",
      "couponDiscountAmount",
      "actualPaidAmount",
      "refundedAmount",
      "timeline",
      "dispatch",
      "refund",
      "complaints",
      "completion",
    ]),
  );

  // 订单页的用户摘要恰好四个键：昵称、头像与两串标识。
  // ⚠️ `displayId` 进的是**订单页自己的**摘要类型（`StaffOrderUserSummary`），
  // 不是共用的 `StaffUserSummary`——会话 / 退款 / 投诉 / 完成材料四处仍是三个键，
  // 那四处各自的「恰好三个键」断言分别在 `staffComplaints.test.mjs` 与
  // `staffRefunds.test.mjs` 里，它们没被改动，正是这次改动**没有**漫开的证据
  assert.deepEqual(
    new Set(Object.keys(withDispatch.user)),
    new Set(["id", "displayId", "nickname", "avatarUrl"]),
  );

  // 全集相等已经蕴含「没有多余字段」，这一句挡的是**嵌套**里漏出去的情况
  const serialized = JSON.stringify(withDispatch) + JSON.stringify(all.items[0]);
  for (const forbidden of [
    "clubNetIncome",
    "companionRateSnapshot",
    "companionBaseIncome",
    "platformIncome",
    "gameAccountId",
    "idempotencyKey",
  ]) {
    assert.equal(
      serialized.includes(`"${forbidden}"`),
      false,
      `${forbidden} 不得出现在客服响应里：用户权限表 §7.2 禁止客服查看分账比例与平台净收入`,
    );
  }
  assert.equal(
    /"userId"/.test(serialized),
    false,
    "内部用户主键不进任何 DTO——客服端认识的身份是 user.id（平台标识），不是 userId",
  );
});

test("详情 3：退款 / 投诉 / 完成材料「没有时」是 null / 空数组，不是 undefined", async () => {
  const all = await list({ pageSize: String(STAFF_MAX_PAGE_SIZE) });
  const fresh = await detail(all.items[0].id);
  assert.ok(fresh);

  assert.equal(fresh.refund, null, "没申请过退款是 null");
  assert.deepEqual(fresh.complaints, [], "「一条投诉都没有」是正常情况，用 null 只会让页面多出一条空值分支");
  assert.equal(fresh.completion, null);
  assert.equal(fresh.refundedAmount, 0);
});

// ——————————————————————— 四、读取路径上的惰性物化（本文件最重要的一组） ———————————————————————

test("物化 1：不显式调用清扫，客服详情与列表也必须把**已超时的派单**物化成退款", async () => {
  const order = await placeOrder();
  pinExpiredPublicDispatch(order.id, 30, 10);

  // 关键：下面两句都**不**显式调用 sweepExpiredDispatches。
  // 若读取路径把物化删掉、或把它挪到读仓储之后，这里拿到的就还是 paid / public。

  const found = await detail(order.id);
  assert.ok(found, "订单必须查得到");
  assert.equal(
    found.order.orderStatus,
    "refunded",
    "详情读路径必须把过期的公共池派单物化成超时退款——客服往往是直接按订单号打开这一页，列表可能根本没被访问过",
  );
  assert.equal(found.dispatch.state, "timed_out");
  assert.ok(found.dispatch.timedOutAt, "超时关闭的时刻必须写下来");

  // 列表另起一单，证明**两条读路径各自都挂着**（只挂一条是最容易漏的情况）
  const second = await placeOrder();
  pinExpiredPublicDispatch(second.id, 45, 10);

  const rows = await list({ keyword: second.orderNo });
  assert.equal(rows.items.length, 1);
  assert.equal(
    rows.items[0].status,
    "refunded",
    "列表读路径同样必须物化——否则客服会对着一条「公共池等待接单」的单去催一个已经不存在的接单，而实际上它按规则已经超时关闭了",
  );
});

test("物化 2：不显式调用清扫，客服详情与列表也必须把**到期的完成材料**物化成 completed", async () => {
  // 前置：一张 serving 单 + 一份「deadline 已经越过真实现在」的 pending 完成材料。
  // 提交时刻要拨到**真实 now 之前**——物化函数取的是真实 `new Date()`，
  // 只有 deadline 落在真实当前时刻的过去才会触发。
  const placed = await placeOrder();
  const dispatch = [...dispatchStore().dispatches.values()].find((entry) => entry.orderId === placed.id);
  assert.ok(dispatch);
  const acceptedAt = plusMinutes(new Date().toISOString(), -120);
  const accepted = await acceptDispatch(dispatch.id, { companionId: COMPANION_A, at: acceptedAt });
  assert.equal(accepted.kind, "ok", "这条用例需要一次成功的接单");

  const started = await startCompanionOrderTransaction({
    companionId: COMPANION_A,
    orderId: placed.id,
    at: plusMinutes(acceptedAt, 10),
  });
  assert.equal(started.kind, "ok", "这条用例需要一次成功的开始服务");

  const submitted = await submitCompletion({
    companionId: COMPANION_A,
    orderId: placed.id,
    summary: "已完成护航服务",
    evidence: [],
    at: plusMinutes(new Date().toISOString(), -30),
  });
  assert.equal(submitted.kind, "ok");
  assert.ok(
    Date.parse(submitted.autoApprovalDeadlineAt) <= Date.now(),
    "前置条件：deadline 必须在真实当前时刻之前，否则读取路径不会物化",
  );

  // 同样不显式调用 sweepCompletionAutoApprovals
  const found = await detail(placed.id);
  assert.ok(found);
  assert.equal(
    found.order.orderStatus,
    "completed",
    "详情读路径必须把过期的自动审核物化成 completed，否则客服会看到一份早该自动通过的完成材料还挂在「待审核」",
  );
  assert.equal(found.completion.status, "approved");
  // 审核来源不在客服摘要里（摘要只回答「到哪一步了」），因此直接读实体核对：
  // 自动通过不得伪装成人工审核——那是审计事实，不能只体现在界面上
  const submission = [...completionStore().submissions.values()].find(
    (entry) => entry.orderId === placed.id,
  );
  assert.ok(submission, "完成材料必须还在 store 里");
  assert.equal(submission.reviewSource, "system", "自动通过必须如实写成 system，不得伪装成人工审核");

  const rows = await list({ keyword: placed.orderNo });
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].status, "completed", "列表读路径同样必须物化");
});

// ——————————————————————— 五、结构门禁 ———————————————————————

test("门禁：客服订单服务不得出现任何处置用的 `*Transaction` 依赖（只有两个惰性物化）", () => {
  const source = stripComments(readSource(path.join(ROOT, "lib/services/staffOrders.ts")));
  const transactionImports = [
    ...source.matchAll(/from\s+"@\/lib\/data\/(\w*Transaction)"/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    [...new Set(transactionImports)].sort(),
    ["companionDispatchTransaction", "completionTransaction"],
    "P0-10 的服务层只做查询：换人（P0-11）、退款（P0-12/13）的伪事务一旦被 import 进来，就意味着这里出现了客服可触发的处置路径。新增一个 `*Transaction` 依赖必须是有意识的产品决定，不能在顺手重构里发生",
  );
});

test("门禁：订单详情没有第二个未接线的浏览器读路径", () => {
  const source = stripComments(readSource(path.join(ROOT, "lib/services/staffHttp.ts")));
  assert.equal(
    /export\s+(?:async\s+)?function\s+fetchStaffOrderDetail\b/.test(source),
    false,
    "详情页是 Server Component，直接调服务层。再留一个没有调用方的 fetchStaffOrderDetail 就是同一份数据的第二条读路径，它会先腐坏",
  );
  // 反例对照：会话详情**有**客户端调用方，因此它的 fetchStaffConversation 必须留着
  assert.ok(
    /fetchStaffConversation\b/.test(source),
    "对照：有客户端调用方的读函数必须保留（这条断言用于防止上面那条被误用成「删掉所有 fetch*」）",
  );
});

test("门禁：客服订单页面存在，且不引用 lib/data（页面拿不到 store）", () => {
  const pageFiles = collectFiles(path.join(ROOT, "app", "staff")).filter((file) =>
    /[\\/]orders[\\/].*\.tsx$/.test(file),
  );
  assert.ok(pageFiles.length > 0, "app/staff 下必须有订单相关的页面文件");

  for (const file of pageFiles) {
    const source = stripComments(readSource(file));
    assert.equal(
      /from\s+"@\/lib\/data/.test(source),
      false,
      `${path.relative(ROOT, file).replace(/\\/g, "/")} 不得引用 lib/data：页面直连 Mock 存储会绕过服务层的 DTO 裁剪与权限判断`,
    );
  }
});

// ——————————————————————— 六、HTTP 契约（需要真实服务） ———————————————————————

/**
 * 为什么这一组必须存在，而不是「服务层已经测过就够了」：
 *
 * 1. **权限是接口层的职责。** 服务层里没有一个 `staffId` 参数（这是刻意的，见
 *    `lib/services/staffOrders.ts`）——它假设「能调到我这里的人已经过了守卫」。
 *    因此「谁可以读」这条规则**只存在于 `app/api/staff/orders/**` 里**，
 *    服务层测试**原理上**覆盖不到它。
 * 2. `null → 404` 是**接口层**决定的映射（服务层返回 `null` 是它的接口约定，
 *    不是 HTTP 语义）。这条映射此前在全仓**没有任何覆盖**。
 * 3. 客服其余领域（会话 / 退款 / 投诉 / 完成材料 / 订单池）各自都有 HTTP 矩阵，
 *    只有订单这一块缺，缺的正是**唯一一处「全量查询」**——客服能读到任意用户的订单，
 *    这条边界的回归保护比别处更该有。
 *
 * 未设置 `APP_BASE_URL` 时整组跳过（与 `tests/staffComplaints.test.mjs` 同一套做法）。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过客服端订单 HTTP 用例";

/** seed 里真实存在、且不可能被任何 HTTP 用例删掉的一条订单。 */
const SEED_ORDER = "ord-seed-1001-01";

async function requestWithCookie(pathname, cookie, init) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  return { status: response.status, body: await response.text(), response };
}

async function staffLogin(staffId) {
  const response = await fetch(new URL("/api/staff/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ staffId }),
  });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

test("HTTP 身份矩阵：两个订单接口对非客服身份一律 401，护航/停用/已移除 403", { skip: SKIP_HTTP }, async () => {
  const endpoints = ["/api/staff/orders", `/api/staff/orders/${SEED_ORDER}`];

  for (const endpoint of endpoints) {
    // 匿名与另外两类身份 Cookie 永远是 401——客服守卫只读 `mock_staff_id`
    assert.equal((await requestWithCookie(endpoint, null)).status, 401, `${endpoint} 匿名应为 401`);
    assert.equal(
      (await requestWithCookie(endpoint, "mock_user_id=u-1001")).status,
      401,
      `${endpoint} 用户端 Cookie 应为 401`,
    );
    assert.equal(
      (await requestWithCookie(endpoint, "mock_admin_id=admin-1")).status,
      401,
      `${endpoint} 管理端 Cookie 应为 401`,
    );

    // 伪造客服 Cookie：把别的身份 id、或不存在的 id 塞进 `mock_staff_id`，查不到账号 → 401
    for (const forged of ["mock_staff_id=u-1001", "mock_staff_id=admin-1", "mock_staff_id=staff-999"]) {
      assert.equal(
        (await requestWithCookie(endpoint, forged)).status,
        401,
        `${endpoint} 的 ${forged} 不该通过`,
      );
    }
  }

  const login = await staffLogin("staff-1");
  if (login.status !== 200) {
    // 开关关闭：连真实客服 id 的伪造 Cookie 也进不来
    assert.equal(login.status, 404);
    for (const endpoint of endpoints) {
      assert.equal((await requestWithCookie(endpoint, "mock_staff_id=staff-1")).status, 401);
    }
    return;
  }

  const staffCookie = login.setCookie[0].split(";")[0];
  assert.equal((await requestWithCookie("/api/staff/orders?pageSize=1", staffCookie)).status, 200);

  // 护航 / 停用 / 已移除：记录查得到但进不来，403
  for (const id of ["staff-3", "staff-4", "staff-5"]) {
    for (const endpoint of endpoints) {
      const rejected = await requestWithCookie(endpoint, `mock_staff_id=${id}`);
      assert.equal(rejected.status, 403, `${endpoint} 的 ${id} 不该通过`);
    }
  }
});

test("HTTP 404：详情接口把服务层的 null 映射成 404，页面同样 404 而不是 200 空壳", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return; // 开关关闭，身份矩阵那条已经断言过
  const staffCookie = login.setCookie[0].split(";")[0];

  const api = await requestWithCookie("/api/staff/orders/ord-does-not-exist", staffCookie);
  assert.equal(api.status, 404, "不存在的订单号必须是 404，不能是 200 null");
  assert.deepEqual(
    JSON.parse(api.body),
    { error: { code: "NOT_FOUND", message: STAFF_ORDER_NOT_FOUND_MESSAGE } },
    "错误体必须复用权威文案：页面与接口说的是同一句话",
  );

  // 页面：`notFound()` 必须真的发出 404。详情目录之上**没有** loading 边界，
  // 否则外壳会先以 200 发出去，迟到的 notFound() 改不了状态码
  // （`tests/staff.test.mjs` 有一条「详情路由之上不得有 loading.tsx」的门禁钉着这件事）。
  const page = await requestWithCookie("/staff/orders/ord-does-not-exist", staffCookie);
  assert.equal(page.status, 404, "不存在的订单页面必须 404，不能是 200 的空白页");
});

test("HTTP 405：列表与详情两个地址只有 GET——写入口在**另外两个**地址上", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  const cookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  // ⚠️ P0-11 之后这句话不再是「客服没有写入口」（`release` / `replace` 就是写入口），
  //    而是「**读地址不许顺带变成写地址**」：列表与详情各只有一个 GET，
  //    把处置挂到详情上会造出一个既能读又能改的地址，而这两件事的风险等级完全不同
  for (const endpoint of ["/api/staff/orders", `/api/staff/orders/${SEED_ORDER}`]) {
    const anonymous = await requestWithCookie(endpoint, null, { method: "POST" });
    assert.equal(anonymous.status, 405, `${endpoint} 对 POST 应为 405（方法不存在）`);

    if (cookie) {
      const asStaff = await requestWithCookie(endpoint, cookie, { method: "POST" });
      assert.equal(asStaff.status, 405, `${endpoint} 对已登录客服也应为 405`);
    }
  }

  // 方法闸发生在路由匹配之后、处理函数之前：订单**不存在**也不会变成 404
  const missing = await requestWithCookie("/api/staff/orders/ord-does-not-exist", cookie, {
    method: "POST",
  });
  assert.equal(missing.status, 405, "方法不存在优先于订单不存在");
});

test("HTTP 400：非法筛选值直接 400，不静默回退（与页面的宽松模式刻意不同）", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const staffCookie = login.setCookie[0].split(";")[0];

  // 地址是用户随手可改的，接口是可被直接请求的——两者对非法输入该有不同的反应
  for (const query of ["status=NOPE", "game=NoSuchGame", "from=2026-09-10&to=2026-09-01"]) {
    const response = await requestWithCookie(`/api/staff/orders?${query}`, staffCookie);
    assert.equal(response.status, 400, `?${query} 应被接口层拒绝`);
  }

  // 越界分页不报错，收敛到边界（与业务筛选的严格程度不同是刻意的）
  const clamped = await requestWithCookie("/api/staff/orders?page=999999&pageSize=100000", staffCookie);
  assert.equal(clamped.status, 200, "分页越界应收敛，不是 400");
});

// ⚠️ 标题里**没有**「用户主键」（2026-09-25 更正）：这条用例自己就断言 `user` 摘要
// **含** `id`（见下面的键集合断言）。原先的标题与它验证的事实相反，会让人误以为
// 内部用户 id 已经被挡住——真正的口径是 P0-10 D4：
// 给客服的是**早就存在**的 `StaffUserSummary.id`（会话页一直在给），本轮未新增暴露面；
// 挡住的是这一列的下半部分：分账、平台收入、游戏账号、备注。
test("HTTP 200 与 DTO 边界：响应体里没有分账、平台收入、游戏账号、备注", { skip: SKIP_HTTP }, async () => {
  const login = await staffLogin("staff-1");
  if (login.status !== 200) return;
  const staffCookie = login.setCookie[0].split(";")[0];

  const list = await requestWithCookie("/api/staff/orders?pageSize=100", staffCookie);
  assert.equal(list.status, 200);
  const listJson = JSON.parse(list.body);
  assert.ok(Array.isArray(listJson.data.items), "成功信封是 { data }");
  assert.ok(listJson.data.items.length > 0, "seed 里应当有可查的订单");

  // 这条断言写在**响应体文本**上而不是解析后的对象上：只删字段不够，
  // 连字段名都不该出现在线上响应里。
  //
  // ⚠️ `displayId` 曾经在这张名单上，2026-09-25 移出（P0-10 整改）：
  // 名单里的注释引的是用户权限表 §7.2，而 §7.2 列的八条「不可以」里没有它，
  // §10 的口径是「客服只开放**履职需要**的信息」——用户资料页上那串 ID
  // 正是用户打电话来报的东西，客服拿它对人是履职需要。
  // 管理端订单 DTO 早就给了同一个字段（`AdminUserSummary.displayId`），
  // 把它挡在客服门外只会造成「客服搜不到用户念出来的那串 ID」。
  for (const forbidden of [
    "companionRateSnapshot",
    "companionBaseIncome",
    "platformIncome",
    "clubNetIncome",
    "gameAccountId",
    "idempotencyKey",
  ]) {
    assert.equal(
      list.body.includes(`"${forbidden}"`),
      false,
      `列表响应不该出现 ${forbidden}（用户权限表 §7.2 的数据最小化）`,
    );
  }

  const detail = await requestWithCookie(`/api/staff/orders/${SEED_ORDER}`, staffCookie);
  assert.equal(detail.status, 200, "seed 订单必须查得到——「全量查询」的含义就是不按客服过滤");
  const detailJson = JSON.parse(detail.body);
  assert.equal(detailJson.data.order.orderId, SEED_ORDER);
  // P0-11：`allowedActions` 是**服务端算好**的两个布尔值，前端不自己用订单状态推断。
  // 写成「恰好这两个键」而不是「不含某几个」——以后给它加 `canRefund` 这类字段时，
  // 会在这里先撞上一次（那是产品决定，不该在顺手重构里长出来）。
  assert.deepEqual(
    Object.keys(detailJson.data.allowedActions).sort(),
    ["canRelease", "canReplace"],
    "处置动作只有回池与换人两个：没有 canRefund —— 退款的入口不在订单详情上",
  );
  // 这一条 seed 单是 `paid`、且没人履约：两个动作都必须为 false。
  // ⚠️ 这是**接口层**的断言，服务层已有一条（`staffOrderActions.test.mjs`），
  //    两条都要有：服务层保证判据对，接口层保证这个判据真的随响应发出去
  assert.deepEqual(
    detailJson.data.allowedActions,
    { canRelease: false, canReplace: false },
    "已付款、无人接单的订单不提供任何处置动作",
  );
  assert.deepEqual(
    Object.keys(detailJson.data.user).sort(),
    ["avatarUrl", "displayId", "id", "nickname"],
    "订单页的用户摘要有四个字段：昵称、头像与两串标识（平台 ID 与内部 ID）",
  );

  // 派单摘要写**全集**：写成「不含某几个」挡不住以后给派单摘要加字段时顺手漏出去
  const dispatch = detailJson.data.dispatch;
  if (dispatch) {
    assert.deepEqual(
      Object.keys(dispatch).sort(),
      [
        "acceptedAt",
        "exclusiveDeadlineAt",
        "exclusiveEnteredAt",
        "publicDeadlineAt",
        "publicPoolEnteredAt",
        "state",
        "stateLabel",
        "timedOutAt",
      ],
      "派单摘要不得出现打手主键或平台配置快照（publicTimeoutMinutesSnapshot）",
    );
  }
});
