import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
// 本文件带 HTTP 用例：开跑前把**服务端**存储丢回预置，保证「从刚重启的服务出发」。理由见 tests/httpReset.mjs
import { resetServerStores } from "./httpReset.mjs";

import {
  ADMIN_COUPON_AMOUNT_MAX_FEN,
  ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE,
  ADMIN_COUPON_DISCOUNT_OVER_THRESHOLD_MESSAGE,
  ADMIN_COUPON_FIELD_LABELS,
  ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_COUPON_NAME_EMPTY_MESSAGE,
  ADMIN_COUPON_NAME_TOO_LONG_MESSAGE,
  ADMIN_COUPON_NOT_EDITABLE_MESSAGE,
  ADMIN_COUPON_NOT_FOUND_MESSAGE,
  ADMIN_COUPON_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COUPON_TEMPLATE_FORM_KEY,
  ADMIN_COUPON_TEMPLATE_FORM_LABEL,
  ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE,
  ADMIN_COUPON_VALID_FROM_INVALID_MESSAGE,
  ADMIN_COUPON_VALID_RANGE_INVALID_MESSAGE,
  ADMIN_COUPON_VALID_TO_INVALID_MESSAGE,
  adminCouponTemplateStatus,
  buildCouponTemplateListQuery,
  countAdminCouponTemplateStates,
  couponTemplateFieldErrors,
  formatCouponFenForInput,
  matchesCouponTemplateKeyword,
  normalizeCouponTemplatePatch,
  parseCouponYuanToFen,
  readAdminCouponEnabledFilter,
  toAdminCouponTemplateItem,
} from "../lib/constants/adminCoupons.ts";
import {
  COUPON_USE_DISABLED_REASON,
  buildThresholdCouponLabels,
  isComputableCouponForm,
} from "../lib/constants/coupons.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { couponStore } from "../lib/data/mockCouponRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { listCouponGrantOptions, grantCouponToUser } from "../lib/services/adminCoupons.ts";
// ⚠️ 只为「幂等键跨模块复用 → 冲突」那一条用例：要走 `takeCreateReplay` 的 `conflict` 分支，
// 必须让同一个键先被**另一个 targetType** 用掉，券模板模块内部做不到这件事。
import { createAdminCategory } from "../lib/services/adminCategories.ts";
import {
  createAdminCouponTemplate,
  getAdminCouponTemplateDetail,
  queryAdminCouponTemplateList,
  resolveCouponTemplateListQuery,
  setAdminCouponTemplateEnabled,
  updateAdminCouponTemplate,
} from "../lib/services/adminCouponTemplates.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { claimCouponForUser } from "../lib/services/coupons.ts";
import { getOrderDetailForUser } from "../lib/services/orders.ts";

/**
 * P1-6：管理端**优惠券模板管理**。
 *
 * ## 这个文件守的是「模板这一层」，不是「券的结算公式」
 *
 * 券不改变原价、不降低打手收益、平台承担成本、退款基数是实付——那些公式由
 * `tests/couponMoneyChain.test.mjs`（纯函数层）与 `tests/couponCheckoutChain.test.mjs`
 * （服务层 / 端到端）钉住，本文件**不复制它们**。
 *
 * 这里补的是「谁有权改模板、改了之后对**已有**的券与订单有没有影响」：
 *
 * | 块 | 裁定出处 | 用例 |
 * |---|---|---|
 * | 只允许满减券、文案由金额派生 | §1 / §3 | 2、5、6、13、14、15 |
 * | 金额与日期的校验：拒绝而不夹取 | §2 / §4 | 7 – 12 |
 * | 编辑不追溯 Claim / Order 快照与金额 | §4 | 17 – 20、25 |
 * | enabled 的两层含义（模板 vs 快照） | §5 | 21 – 24 |
 * | 不提供硬删除 | §6 | 26 |
 * | 与 P1-4 发券联动 | §7 | 27 – 30 |
 * | 权限 / 审计 / DTO | §权限 / §Audit | 31 – 36 |
 *
 * ## ⚠️ 全部走真实服务与真实 Mock 仓储
 *
 * 一处都没有把业务逻辑抄进测试：写操作走 `lib/services/adminCouponTemplates.ts`，
 * 结算侧走 `lib/services/checkout.ts` 与 `lib/services/coupons.ts`。
 * 「后台改完，前台立刻是新值」这件事只有走完整条链路才算被验证过。
 *
 * ## ⚠️ 时间被钉在数据层，不钉在业务层
 *
 * 结算侧（`previewCheckout` / `createPaymentRequest`）**没有 `now` 注入**，
 * 内部用 `new Date()`。因此凡是需要「一张仍在有效期内的券」的地方，
 * 都**在新建模板时**把有效期写成足够宽的两端（`WIDE_FROM` / `WIDE_TO`），
 * 而不是事后去改夹具——`validFrom` / `validTo` 本来就是接口能写的字段，
 * 用它们把时间钉死，测的才是真实路径。
 */

const ADMIN_ID = "admin-1";
/** 发券要校验用户存在，因此只能用种子里真有的账户（与 P1-4 发券测试同一取值）。 */
const SEEDED_USER = "u-1002";
/** 第二位真实用户（`lib/constants/mockUsers.ts`），用来验证「换个人领，计数跟着涨」。 */
const SECOND_USER = "u-1003";

/** 足够宽的两端：让结算侧的真实 `new Date()` 落在里面。 */
const WIDE_FROM = "2020-01-01T00:00:00.000Z";
const WIDE_TO = "2099-12-31T15:59:59.000Z";

/** 种子里已有的券（见 `lib/mocks/fixtures/couponSeed.ts`）。 */
const THRESHOLD_COUPON = "cpn-mock-new-user";
const DISCOUNT_COUPON = "cpn-mock-holiday";
const GIFT_COUPON = "cpn-mock-no-threshold";
const DISABLED_COUPON = "cpn-mock-disabled";

/** 结算试算要用的商品：目录里真实存在的可购买项。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", region: "手游" };
const UNIT_PRICE = 2990;
/** 幂等键跨模块冲突用例借用类目新建时用的游戏（`adminCategories.test.mjs` 同款取值）。 */
const GAME_DELTA = "g-delta";

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `p16-cpn-key-${process.pid}-${keySeq}`;
}

function params(input = {}) {
  return new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("coupon");
  resetMockStore("adminAudit");
  resetMockStore("payment");
});

// ——————————————————————————— 辅助 ———————————————————————————

/** 一份合法的券模板输入（整数分 / ISO 字符串），用例按需覆盖其中几项。 */
function couponInput(overrides = {}) {
  return {
    name: "测试满减券",
    thresholdAmount: 10_000,
    discountAmount: 1_000,
    validFrom: WIDE_FROM,
    validTo: WIDE_TO,
    enabled: true,
    ...overrides,
  };
}

function create(overrides = {}, key = uniqueKey()) {
  return createAdminCouponTemplate(ADMIN_ID, { idempotencyKey: key, ...couponInput(overrides) });
}

function update(id, overrides = {}, key = uniqueKey()) {
  return updateAdminCouponTemplate(id, ADMIN_ID, { idempotencyKey: key, ...couponInput(overrides) });
}

function setEnabled(id, enabled, key = uniqueKey()) {
  return setAdminCouponTemplateEnabled(id, enabled, ADMIN_ID, { idempotencyKey: key });
}

/** 管理端列表：从地址栏参数解析查询条件再取数（页面与接口走的是同一条路径）。 */
async function adminTemplates(input = {}, strict = false) {
  const search = params(input);
  const query = resolveCouponTemplateListQuery(search, strict);
  return queryAdminCouponTemplateList(query, search, "server");
}

function detail(id) {
  return getAdminCouponTemplateDetail(id, undefined, "server");
}

function auditsFor(couponId) {
  return getAdminAuditRepository().listAudits({ targetType: "coupon", targetId: couponId });
}

function templateOf(couponId) {
  return couponStore().coupons.get(couponId) ?? null;
}

function claimOf(claimId) {
  return couponStore().claims.get(claimId) ?? null;
}

/**
 * 等到墙上时钟**越过** `iso` 那一刻再返回。
 *
 * ⚠️ 建档 / 最后改动是毫秒精度的 `new Date().toISOString()`。一个测试里的
 * 「建一张、马上改一张」通常落在**同一毫秒**内，此时「时间戳刷新了没有」
 * 在观测上根本不可区分——直接断言 `updatedAt` 变了会变成一条随机失败的用例。
 *
 * 等的是一段真实时间，因此这条断言只在服务端**真的没刷新**时间戳时才失败。
 * 这也说明了一件重要的事：毫秒精度下「两次连续写入同一毫秒」无法从时间戳上看出来，
 * 判断有没有写只能靠审计与值本身。
 */
async function tickPast(iso) {
  const target = Date.parse(iso);
  while (Date.now() <= target) await new Promise((resolve) => setTimeout(resolve, 1));
}

function selection(overrides = {}) {
  return {
    productId: PRODUCT.productId,
    specId: PRODUCT.specId,
    quantity: 1,
    region: PRODUCT.region,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
    couponClaimId: null,
    ...overrides,
  };
}

function preview(overrides = {}, userId = SEEDED_USER) {
  return previewCheckout(selection(overrides), userId, undefined, "server");
}

/** 走完「下单 → 支付」，返回订单。 */
async function paidOrder(overrides = {}, userId = SEEDED_USER) {
  const created = await createPaymentRequest(
    { ...selection(overrides), idempotencyKey: uniqueKey() },
    userId,
  );
  const confirmed = await confirmPaymentRequest(created.request.id, "success", userId);
  assert.equal(confirmed.orderCreated, true, "前置：这张订单必须创建成功");
  return confirmed.order;
}

/**
 * 建一张「门槛 1 元、减 1 角」的满减券并让 `userId` 领到它。
 *
 * 门槛取 100 分（¥1.00）而商品是 ¥29.90：门槛一定过得去，用例就不必
 * 为了凑门槛改数量——数量一变，实付金额的断言就要跟着改。
 */
async function issueThresholdCoupon(userId = SEEDED_USER) {
  const { couponId } = await create({
    name: "P1-6 测试券",
    thresholdAmount: 100,
    discountAmount: 10,
  });
  const { claimId } = await claimCouponForUser(
    userId,
    couponId,
    { idempotencyKey: uniqueKey() },
    "server",
  );
  return { couponId, claimId };
}

// ═══════════════════════ 一、列表（cmd 第 1 项） ═══════════════════════

test("P1-6 列表：后台看得到全部模板（含已停用与历史券），角标三个数自洽", async () => {
  const page = await adminTemplates();

  // 种子 6 张：4 张满减（其中 1 张已过期、1 张未开始）+ 1 张折扣 + 1 张无门槛
  assert.deepEqual(page.counts, { all: 6, enabled: 5, disabled: 1 });
  assert.equal(
    page.counts.all,
    page.counts.enabled + page.counts.disabled,
    "「全部」必须等于「已启用 + 已停用」——§6 没有硬删除，不存在第三类",
  );
  assert.equal(page.total, page.counts.all, "角标与列表来自同一份全量数据");
  assert.equal(page.items.length, 6);

  // 已停用的那张确实在列表里：后台要能查看并重新启用它
  assert.ok(page.items.some((item) => item.id === DISABLED_COUPON));
});

test("P1-6 列表：关键词命中名称与 id，状态筛选与「全部」互斥且自洽", async () => {
  assert.equal((await adminTemplates({ keyword: "新人" })).total, 1);
  assert.equal((await adminTemplates({ keyword: THRESHOLD_COUPON })).total, 1);
  // id 是全量精确匹配，名称是包含匹配——两者都能找到同一张
  assert.equal((await adminTemplates({ keyword: "CPN-MOCK-NEW-USER" })).total, 1, "关键词不区分大小写");

  const enabled = await adminTemplates({ enabled: "enabled" });
  const disabled = await adminTemplates({ enabled: "disabled" });
  assert.equal(enabled.total, 5);
  assert.equal(disabled.total, 1);
  assert.equal(disabled.items[0].id, DISABLED_COUPON);
  // 角标是**全量**口径，不随筛选变化
  assert.deepEqual(disabled.counts, { all: 6, enabled: 5, disabled: 1 });

  assert.equal((await adminTemplates({ keyword: "不存在的券" })).total, 0);
});

test("P1-6 列表：分页按建档时间倒序，hasMore 与服务端一致", async () => {
  const first = await adminTemplates({ pageSize: 4 });
  assert.equal(first.items.length, 4);
  assert.equal(first.total, 6);
  assert.equal(first.hasMore, true);

  const second = await adminTemplates({ pageSize: 4, page: 2 });
  assert.equal(second.items.length, 2);
  assert.equal(second.hasMore, false);

  const ids = [...first.items, ...second.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 6, "两页合起来不重不漏");

  // 同一查询条件重复取数，两页都必须逐位一致。
  // ⚠️ 不能拿 `ids` 与「重新算一遍的同一表达式」比——那是恒真断言，永远红不了。
  // 种子里的 6 张建档时刻相同，此时靠 id 兜底保证顺序稳定。
  const againFirst = await adminTemplates({ pageSize: 4, page: 1 });
  const againSecond = await adminTemplates({ pageSize: 4, page: 2 });
  assert.deepEqual(
    [...againFirst.items, ...againSecond.items].map((item) => item.id),
    ids,
    "同一查询条件重复取数，顺序必须一致",
  );
});

test("P1-6 列表：接口严格模式拒绝非法筛选值，页面宽松模式收敛到默认", async () => {
  assert.throws(
    () => resolveCouponTemplateListQuery(params({ enabled: "gone" }), true),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      return true;
    },
  );

  // 页面：同一个坏参数收敛成「全部」，而不是整页报错
  const lenient = resolveCouponTemplateListQuery(params({ enabled: "gone" }), false);
  assert.equal(lenient.enabled, "");

  // 空关键词 / 缺省参数不报错
  assert.equal(readAdminCouponEnabledFilter(null), "");
  assert.equal(buildCouponTemplateListQuery({ params: params(), enabled: "" }).page, 1);
});

test("P1-6 列表：已停用的模板**照样能打开详情**，不是 404", async () => {
  const item = await detail(DISABLED_COUPON);
  assert.ok(item, "停用不是「记录消失」——§6 不肯做硬删除，详情就必须打得开");
  assert.equal(item.enabled, false);
  assert.equal(item.editable, false, "它是无门槛券（gift），不参与结算");

  assert.equal(await detail("cpn-nope"), null);
});

test("P1-6 列表：关键词匹配与状态口径是两个纯函数，不依赖页面", () => {
  assert.equal(matchesCouponTemplateKeyword({ name: "新人券", id: "cpn-1" }, ""), true);
  assert.equal(matchesCouponTemplateKeyword({ name: "新人券", id: "cpn-1" }, "CPN-1"), true);
  assert.equal(matchesCouponTemplateKeyword({ name: "新人券", id: "cpn-1" }, "老人"), false);

  assert.deepEqual(countAdminCouponTemplateStates([]), { all: 0, enabled: 0, disabled: 0 });
  assert.deepEqual(
    countAdminCouponTemplateStates([{ enabled: true }, { enabled: false }, { enabled: true }]),
    { all: 3, enabled: 2, disabled: 1 },
  );

  // 状态只有两个取值，**没有**「已过期」这一档：过期与启用是两个正交维度
  assert.deepEqual(adminCouponTemplateStatus({ enabled: true }).key, "enabled");
  assert.deepEqual(adminCouponTemplateStatus({ enabled: false }).key, "disabled");
  assert.ok(adminCouponTemplateStatus({ enabled: false }).description.length > 0);
});

// ═══════════════════════ 二、新建（cmd 第 2、12、13、15 项） ═══════════════════════

test("P1-6 新建：形态由服务端钉死为满减券，券面文案由两个金额派生", async () => {
  const { couponId, changed } = await create({
    name: "暑期专享",
    thresholdAmount: 20_000,
    discountAmount: 3_000,
  });
  assert.equal(changed, true);

  const record = templateOf(couponId);
  assert.ok(record, "新建的券必须落进仓储");
  assert.equal(record.formKey, ADMIN_COUPON_TEMPLATE_FORM_KEY);
  assert.equal(record.formLabel, ADMIN_COUPON_TEMPLATE_FORM_LABEL);
  assert.equal(record.thresholdAmount, 20_000);
  assert.equal(record.discountAmount, 3_000);

  // §3：文案不是业务真值，必须与金额一致——这里与服务端用的是同一个派生函数
  assert.deepEqual(
    { valueLabel: record.valueLabel, conditionLabel: record.conditionLabel },
    buildThresholdCouponLabels(20_000, 3_000),
  );
  assert.equal(record.valueLabel, "满 200 减 30");

  // 建档与更新时刻由服务端写，客户端没有位置传
  assert.equal(record.createdAt, record.updatedAt);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));

  // 用户端读的是同一份数据：新建的券立刻可领
  assert.equal(record.enabled, true);
});

test("P1-6 新建：客户端伪造 formKey / 文案 / id / 时间一律无效（§九）", async () => {
  const { couponId } = await createAdminCouponTemplate(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...couponInput({ name: "伪造尝试" }),
    // 下面这些**没有可传的位置**：形态、文案、主键、时间都由服务端决定
    formKey: "gift",
    formLabel: "无门槛券",
    valueLabel: "立减 999",
    conditionLabel: "随便用",
    id: "cpn-forged",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    thresholdAmount: 10_000,
    discountAmount: 1_000,
  });

  const record = templateOf(couponId);
  assert.equal(record.formKey, "threshold", "§1：只允许新建满减券");
  assert.equal(record.id, couponId);
  assert.notEqual(record.id, "cpn-forged");
  assert.equal(record.valueLabel, "满 100 减 10", "券面文案由金额派生，不接受客户端提交");
  assert.equal(record.conditionLabel, buildThresholdCouponLabels(10_000, 1_000).conditionLabel);
  // 建档与最后改动都是服务端当下写的，请求体里那两个 2000 年一个都没进去
  assert.notEqual(record.createdAt, "2000-01-01T00:00:00.000Z");
  assert.notEqual(record.updatedAt, "2000-01-01T00:00:00.000Z");
  assert.ok(
    Date.parse(record.createdAt) > Date.parse("2020-01-01T00:00:00.000Z"),
    "建档时间应当是刚刚",
  );
  assert.equal(templateOf("cpn-forged"), null);
});

test("P1-6 新建：金额非法一律 400 且**一个字节都不写**，不做夹取", async () => {
  const before = couponStore().coupons.size;
  const auditBefore = await getAdminAuditRepository().countAudits();

  const cases = [
    [0, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE],
    [-1, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE],
    [1.5, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE],
    [ADMIN_COUPON_AMOUNT_MAX_FEN + 1, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE],
    // 缺字段：`readInteger` 给 NaN，NaN 不是「合法的大于 0 的整数」
    [undefined, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE],
  ];

  for (const [thresholdAmount, message] of cases) {
    const body = { ...couponInput({ name: "非法门槛" }) };
    if (thresholdAmount === undefined) delete body.thresholdAmount;
    else body.thresholdAmount = thresholdAmount;

    await expectApiError(
      createAdminCouponTemplate(ADMIN_ID, { idempotencyKey: uniqueKey(), ...body }),
      "BAD_REQUEST",
      message,
    );
  }

  // 优惠金额非法（0 / 负数 / 小数），以及「优惠金额大于门槛」
  for (const [discountAmount, message] of [
    [0, ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE],
    [-100, ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE],
    [1.5, ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE],
    [10_001, ADMIN_COUPON_DISCOUNT_OVER_THRESHOLD_MESSAGE],
  ]) {
    await expectApiError(
      create({ name: "非法优惠", discountAmount }),
      "BAD_REQUEST",
      message,
    );
  }

  // 正好等于门槛是合法的（§4 原文是 `discount <= threshold`）
  const equal = await create({ name: "满减相等", thresholdAmount: 5_000, discountAmount: 5_000 });
  assert.ok(equal.couponId);

  assert.equal(couponStore().coupons.size, before + 1, "被拒的输入不该留下任何记录");
  assert.equal(
    await getAdminAuditRepository().countAudits(),
    auditBefore + 1,
    "只有那一次成功的新建写了审计",
  );
  assert.equal((await adminTemplates({ keyword: "非法" })).total, 0);
});

test("P1-6 新建：有效期必须可解析且 validTo > validFrom", async () => {
  const before = couponStore().coupons.size;

  // 四种坏法对应三句不同的错话：缺哪个说哪个，两个都在才轮得到「顺序不对」
  for (const [overrides, message] of [
    [{ validFrom: "" }, ADMIN_COUPON_VALID_FROM_INVALID_MESSAGE],
    [{ validFrom: "不是时间" }, ADMIN_COUPON_VALID_FROM_INVALID_MESSAGE],
    [{ validTo: "" }, ADMIN_COUPON_VALID_TO_INVALID_MESSAGE],
    [{ validTo: "不是时间" }, ADMIN_COUPON_VALID_TO_INVALID_MESSAGE],
    [{ validFrom: WIDE_TO, validTo: WIDE_FROM }, ADMIN_COUPON_VALID_RANGE_INVALID_MESSAGE],
    [{ validFrom: WIDE_TO, validTo: WIDE_TO }, ADMIN_COUPON_VALID_RANGE_INVALID_MESSAGE],
  ]) {
    await expectApiError(create({ name: "非法有效期", ...overrides }), "BAD_REQUEST", message);
  }

  // 边界：结束比开始晚 1 秒是合法的
  const ok = await create({
    name: "边界有效期",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(
    templateOf(ok.couponId).validTo,
    "2026-01-01T00:00:01.000Z",
    "时间不做任何换算：接口收的就是 ISO 字符串",
  );

  assert.equal(couponStore().coupons.size, before + 1);
});

test("P1-6 新建：名称不能为空、不能超长（按字符数，不是字节数）", async () => {
  await expectApiError(create({ name: "" }), "BAD_REQUEST", ADMIN_COUPON_NAME_EMPTY_MESSAGE);
  await expectApiError(create({ name: "   " }), "BAD_REQUEST", ADMIN_COUPON_NAME_EMPTY_MESSAGE);
  await expectApiError(
    create({ name: "券".repeat(21) }),
    "BAD_REQUEST",
    ADMIN_COUPON_NAME_TOO_LONG_MESSAGE,
  );

  // 20 个中文恰好合法：上限是**字符数**，20 个汉字 = 60 字节
  const ok = await create({ name: "券".repeat(20) });
  assert.equal(templateOf(ok.couponId).name.length, 20);
});

test("P1-6 新建：幂等键——同键重放返回同一个 id，只建一条、只写一条审计", async () => {
  const key = uniqueKey();
  const [a, b] = await Promise.all([
    create({ name: "并发新建" }, key),
    create({ name: "并发新建" }, key),
  ]);

  assert.equal(a.couponId, b.couponId);
  assert.equal((await adminTemplates({ keyword: "并发新建" })).total, 1);
  assert.equal((await auditsFor(a.couponId)).length, 1, "两次并发只该留下一条审计");
  // 先到的那次写，后到的那次是重放——这个区分是幂等的全部意义
  assert.equal(a.changed, true);
  assert.equal(b.changed, false);

  // 重放返回的是**第一次那条记录**：同一个 id、同一个时间戳、没有第二次改动
  const replay = await create({ name: "并发新建" }, key);
  assert.equal(replay.couponId, a.couponId);
  assert.equal(replay.updatedAt, a.updatedAt);
  assert.equal(replay.changed, false, "重放没有改动任何东西");
  assert.equal(
    templateOf(a.couponId).name,
    "并发新建",
    "重放**不写入**请求体里的新值——第二次的名字即使不同也不会生效",
  );

  // ⚠️ 「重放」与「空保存」在写结果里都是 `changed: false`（DTO 只有这四个键），
  // 因此这个用例区分它们的办法是**看有没有第二条记录与第二条审计**，而不是看返回值。
  assert.equal(couponStore().coupons.size, 1 + 6, "种子里 6 张，加上这一次新建，一共 7 张");
});

test("P1-6 新建：幂等键缺失或非法 → 400，且零写入", async () => {
  for (const value of [undefined, "", "short", "有中文的键", "x".repeat(65)]) {
    const body = { ...couponInput({ name: "非法键" }) };
    if (value !== undefined) body.idempotencyKey = value;
    await expectApiError(
      createAdminCouponTemplate(ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }

  assert.equal((await adminTemplates({ keyword: "非法键" })).total, 0);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

test("P1-6 新建：幂等键被**另一类**操作先用过 → 400 冲突，而不是静默返回别人的记录", async () => {
  // ⚠️ 走到 `conflict` 分支**必须**换一个 targetType。看 `takeCreateReplay(actor, "coupon")`：
  //   · 同一个键、同一个类型、同一位操作者 → `replay`（200 + 第一次那条记录）
  //   · 类型不同 或 操作者不同             → `conflict`
  // 「同类型再来一次」是**重放**，属于上一条用例；这条要守的是「键被别的操作占了」。
  //
  // 于是借类目的新建把键用掉——**跨模块复用同一个键**，正是这条收窄要防的事。
  // 光测券模板这一个模块是测不出来的。
  const key = uniqueKey();
  await createAdminCategory(ADMIN_ID, {
    idempotencyKey: key,
    gameId: GAME_DELTA,
    name: "占位类目",
    sortOrder: 100,
    enabled: true,
  });

  await expectApiError(
    create({ name: "抢同一个键" }, key),
    "BAD_REQUEST",
    ADMIN_COUPON_OPERATION_CONFLICT_MESSAGE,
  );

  // 冲突的语义是「**什么都没做**」：既没有建出券，也没有留下审计。
  // 这条断言如果写成 `.catch(() => {})`，整条用例就永远不会红——那是在骗覆盖率。
  assert.equal((await adminTemplates({ keyword: "抢同一个键" })).total, 0);
  assert.equal(couponStore().coupons.size, 6, "种子里 6 张，冲突路径一张都不该多");
});

// ═══════════════════════ 三、编辑（cmd 第 3、7 项） ═══════════════════════

test("P1-6 编辑：改金额后券面文案跟着重新派生，建档时间不动", async () => {
  const { couponId } = await create({
    name: "改前面额",
    thresholdAmount: 10_000,
    discountAmount: 1_000,
  });
  const before = templateOf(couponId);
  // 让墙上时钟先跨过建档那一刻，`updatedAt` 的变化才是可观测的（见 `tickPast`）
  await tickPast(before.updatedAt);

  await update(couponId, {
    name: "改后面额",
    thresholdAmount: 30_000,
    discountAmount: 5_000,
  });

  const after = templateOf(couponId);
  assert.equal(after.name, "改后面额");
  assert.deepEqual(
    { valueLabel: after.valueLabel, conditionLabel: after.conditionLabel },
    buildThresholdCouponLabels(30_000, 5_000),
    "§3：文案必须由金额派生，改金额就必须跟着改文案",
  );
  assert.equal(after.createdAt, before.createdAt, "建档时间不是这次编辑的产物");
  assert.notEqual(after.updatedAt, before.updatedAt);
});

test("P1-6 编辑：什么都没改 → changed=false，不写审计、不刷新 updatedAt", async () => {
  const { couponId } = await create({ name: "一字不改" });
  const before = templateOf(couponId);
  const auditsBefore = (await auditsFor(couponId)).length;
  // 同上：不等这一刻过去，「时间戳没变」既可能是没写、也可能只是同一毫秒
  await tickPast(before.updatedAt);

  const result = await update(couponId, {
    name: "一字不改",
    thresholdAmount: 10_000,
    discountAmount: 1_000,
  });

  assert.equal(result.changed, false);
  assert.equal(templateOf(couponId).updatedAt, before.updatedAt, "「最后修改时间」不能被一次空保存改动");
  assert.equal((await auditsFor(couponId)).length, auditsBefore);

  // 名称只有首尾空格之差不算改动：写进记录的就是 trim 后的那一份
  const spaced = await update(couponId, {
    name: "  一字不改  ",
    thresholdAmount: 10_000,
    discountAmount: 1_000,
  });
  assert.equal(spaced.changed, false);
  assert.equal(templateOf(couponId).name, "一字不改");
});

test("P1-6 编辑：非满减券（折扣券 / 无门槛券）一律拒绝，记录一字不改", async () => {
  for (const id of [DISCOUNT_COUPON, GIFT_COUPON]) {
    const before = templateOf(id);
    await expectApiError(
      update(id, { name: "试图改历史券", thresholdAmount: 100, discountAmount: 10 }),
      "BAD_REQUEST",
      ADMIN_COUPON_NOT_EDITABLE_MESSAGE,
    );
    assert.deepEqual(templateOf(id), before, "被拒的编辑不该留下任何痕迹");
  }
});

test("P1-6 编辑：不存在的 id → 404，而不是建一张新的", async () => {
  const before = couponStore().coupons.size;
  await expectApiError(
    update("cpn-nope", { name: "幽灵券" }),
    "NOT_FOUND",
    ADMIN_COUPON_NOT_FOUND_MESSAGE,
  );
  assert.equal(couponStore().coupons.size, before);
});

test("P1-6 编辑：非法金额同样被拒（服务端自己判一次，不假设客户端判过）", async () => {
  const { couponId } = await create({ name: "编辑校验" });
  const before = templateOf(couponId);

  await expectApiError(
    update(couponId, { name: "编辑校验", thresholdAmount: -1 }),
    "BAD_REQUEST",
    ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE,
  );
  await expectApiError(
    update(couponId, { name: "编辑校验", discountAmount: 20_000 }),
    "BAD_REQUEST",
    ADMIN_COUPON_DISCOUNT_OVER_THRESHOLD_MESSAGE,
  );

  assert.deepEqual(templateOf(couponId), before);
});

// ═══════════════════════ 四、启用 / 停用（cmd 第 4 项，§5） ═══════════════════════

test("P1-6 停用：不删除任何 Claim，重复停用不写第二条审计", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();

  const first = await setEnabled(couponId, false);
  assert.equal(first.changed, true);
  assert.equal(first.enabled, false);
  assert.equal(templateOf(couponId).enabled, false);
  assert.ok(claimOf(claimId), "§5 / §6：停用不删除券——用户手里的那张还在");
  assert.equal(claimOf(claimId).status, "unused");

  const auditsAfterFirst = (await auditsFor(couponId)).length;
  const second = await setEnabled(couponId, false);
  assert.equal(second.changed, false, "已经是这个状态，不产生新的变更");
  assert.equal((await auditsFor(couponId)).length, auditsAfterFirst);
  assert.equal(second.enabled, false);
});

test("P1-6 启用：重新启用后 enabled=true，审计记的是 coupon.enable", async () => {
  const { couponId } = await create({ name: "先停后启", enabled: false });
  assert.equal(templateOf(couponId).enabled, false);

  const result = await setEnabled(couponId, true);
  assert.equal(result.changed, true);
  assert.equal(result.enabled, true);

  // 新建时就是停用状态，那一条 `coupon.create` 是建档不是启用——两个动作不该混为一谈
  const actions = (await auditsFor(couponId)).map((entry) => entry.action);
  assert.deepEqual(actions, ["coupon.create", "coupon.enable"]);
  assert.equal(actions.length, 2, "「建一张已停用的券」不该额外写一条停用审计");
});

test("P1-6 停用 / 启用：不存在的 id → 404", async () => {
  await expectApiError(setEnabled("cpn-nope", false), "NOT_FOUND", ADMIN_COUPON_NOT_FOUND_MESSAGE);
});

test("P1-6 停用 / 启用：幂等键缺失 → 400，且状态没被动过", async () => {
  const { couponId } = await issueThresholdCoupon();
  await expectApiError(
    setAdminCouponTemplateEnabled(couponId, false, ADMIN_ID, {}),
    "BAD_REQUEST",
    ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );
  assert.equal(templateOf(couponId).enabled, true);
});

test("P1-6 §6：没有硬删除——接口清单里不存在第五个 `remove` 地址", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..");
  const dir = path.join(root, "app", "api", "admin", "coupon-templates");

  const collect = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(current, entry.name);
      return entry.isDirectory() ? collect(full) : [full];
    });

  const routes = collect(dir)
    .filter((file) => file.endsWith("route.ts"))
    .map((file) => path.basename(path.dirname(file)))
    .sort();
  assert.deepEqual(routes, ["coupon-templates", "disable", "enable", "[id]"].sort());

  // 也不存在「改券面文案」的入口：`valueLabel` / `conditionLabel` 在写白名单里没有位置
  const source = readFileSync(path.join(root, "lib", "constants", "adminCoupons.ts"), "utf8");
  const patchBlock = source.slice(
    source.indexOf("export function normalizeCouponTemplatePatch"),
    source.indexOf("/* ───────────────── 表单原始文本"),
  );
  assert.equal(patchBlock.includes("valueLabel"), false, "文案不得进入写白名单");
  assert.equal(patchBlock.includes("formKey"), false, "形态不得进入写白名单");
});

// ═══════════════════════ 五、§5 结算语义（cmd 第 5、6 项） ═══════════════════════

test("P1-6 §5：停用后已领到手的券在结算页不可用（preview 报原因、下单 400）", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();

  // 前置：停用前这张券真的能用
  const usable = await preview({ couponClaimId: claimId });
  assert.equal(usable.coupon.applicable, true, "前置：停用前必须可用");
  assert.equal(usable.couponDiscountAmount, 10);

  await setEnabled(couponId, false);

  const draft = await preview({ couponClaimId: claimId });
  assert.equal(draft.coupon.applicable, false);
  assert.equal(draft.couponDiscountAmount, 0);
  assert.equal(draft.coupon.reason, COUPON_USE_DISABLED_REASON);
  assert.equal(draft.actualPaidAmount, draft.originalAmount, "不可用时按原价，不静默按 0 元成交");
  assert.equal(
    draft.availableCoupons.some((item) => item.claimId === claimId),
    false,
    "停用的券不该出现在可选列表里",
  );

  // 绕过界面直接下单同样被拒
  await assert.rejects(
    () => createPaymentRequest({ ...selection({ couponClaimId: claimId }), idempotencyKey: uniqueKey() }, SEEDED_USER),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, COUPON_USE_DISABLED_REASON);
      return true;
    },
  );
  assert.equal(claimOf(claimId).status, "unused", "被拒不得核销");
});

test("P1-6 §5：重新启用后，同一张合法 Claim 可以再次使用", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  await setEnabled(couponId, false);
  await setEnabled(couponId, true);

  const draft = await preview({ couponClaimId: claimId });
  assert.equal(draft.coupon.applicable, true);
  assert.equal(draft.couponDiscountAmount, 10);
  assert.equal(
    draft.availableCoupons.some((item) => item.claimId === claimId),
    true,
    "启用后它重新出现在可选列表里",
  );

  // 并且真的能付掉——「能用」的最终判据是它走完支付
  const order = await paidOrder({ couponClaimId: claimId });
  assert.equal(order.couponDiscountAmount, 10);
  assert.equal(order.actualPaidAmount, UNIT_PRICE - 10);
  assert.equal(claimOf(claimId).status, "used");
});

test("P1-6 §5：停用不改历史订单，也不改已核销的 Claim", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  const order = await paidOrder({ couponClaimId: claimId });
  const snapshotBefore = { ...claimOf(claimId).snapshot };

  await setEnabled(couponId, false);

  const after = await getOrderDetailForUser(order.id, SEEDED_USER, undefined, "server");
  assert.deepEqual(after.coupon, order.coupon, "历史订单上的券快照是历史事实");
  assert.equal(after.couponDiscountAmount, order.couponDiscountAmount);
  assert.equal(after.actualPaidAmount, order.actualPaidAmount);
  assert.deepEqual(claimOf(claimId).snapshot, snapshotBefore);
});

// ═══════════════════════ 六、§4 不追溯（cmd 第 7、8、18 项） ═══════════════════════

test("P1-6 §4：编辑模板不追溯已领 Claim 的快照（那张券「是什么」在领取时就定了）", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  const snapshotBefore = { ...claimOf(claimId).snapshot };

  await update(couponId, {
    name: "改到面目全非",
    thresholdAmount: 999_999,
    discountAmount: 888_888,
    validTo: "2099-01-01T00:00:00.000Z",
  });

  assert.deepEqual(claimOf(claimId).snapshot, snapshotBefore, "快照是领取那一刻的券面，不跟着模板走");

  // 券仍然按**快照**里的门槛与面额判定：门槛 100 分，这一单 2990 分，因此可抵 10 分
  const draft = await preview({ couponClaimId: claimId });
  assert.equal(draft.coupon.applicable, true);
  assert.equal(draft.couponDiscountAmount, 10, "抵扣额取自快照，不是被改后的 8888.88 元");
});

test("P1-6 §4：编辑模板不追溯历史订单的券快照、实付与抵扣额", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  const order = await paidOrder({ couponClaimId: claimId });

  await update(couponId, {
    thresholdAmount: 500_000,
    discountAmount: 100_000,
  });

  const after = await getOrderDetailForUser(order.id, SEEDED_USER, undefined, "server");
  assert.deepEqual(after.coupon, order.coupon);
  assert.equal(after.couponDiscountAmount, 10);
  assert.equal(after.actualPaidAmount, UNIT_PRICE - 10);
  assert.equal(after.originalAmount, UNIT_PRICE);
});

test("P1-6 §4：改金额不影响订单的分账基数与打手收益", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  const order = await paidOrder({ couponClaimId: claimId });

  await update(couponId, { discountAmount: 2_500 });

  const after = await getOrderDetailForUser(order.id, SEEDED_USER, undefined, "server");
  assert.equal(
    after.companionBaseIncome,
    order.companionBaseIncome,
    "分给打手的钱在下单那一刻就定了，事后改券面额不该动它",
  );
  assert.equal(after.actualPaidAmount, order.actualPaidAmount, "分账基数是实付，与券面额无关");
  // 平台净收入连字段都不该出现在用户端 DTO 里——这里顺手复核一次
  assert.equal("clubNetIncome" in after, false);
});

// ═══════════════════════ 七、§7 与发券联动（cmd 第 9、10 项） ═══════════════════════

test("P1-6 §7：停用的模板不在可发放列表里，也不能被发放", async () => {
  const { couponId } = await create({ name: "待停用券" });
  assert.ok((await listCouponGrantOptions(undefined, "server")).some((o) => o.id === couponId));

  await setEnabled(couponId, false);

  assert.equal(
    (await listCouponGrantOptions(undefined, "server")).some((o) => o.id === couponId),
    false,
    "停用的模板不该出现在可发放列表里",
  );
  await assert.rejects(
    () =>
      grantCouponToUser(
        ADMIN_ID,
        { idempotencyKey: uniqueKey(), userId: SEEDED_USER, couponId },
        "server",
      ),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      return true;
    },
  );

  // 种子里那张已停用的券同样发不出去
  assert.equal(
    (await listCouponGrantOptions(undefined, "server")).some((o) => o.id === DISABLED_COUPON),
    false,
  );
});

test("P1-6 §1 / §7：历史折扣券与无门槛券既不进可选列表，也发不出去", async () => {
  const options = await listCouponGrantOptions(undefined, "server");

  for (const id of [DISCOUNT_COUPON, GIFT_COUPON]) {
    assert.equal(
      options.some((option) => option.id === id),
      false,
      "不参与结算的券发出去也核销不了，因此不该出现在发放列表里",
    );
    await assert.rejects(
      () =>
        grantCouponToUser(
          ADMIN_ID,
          { idempotencyKey: uniqueKey(), userId: SEEDED_USER, couponId: id },
          "server",
        ),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        return true;
      },
    );
  }

  // 列表里剩下的每一张都必须是满减券：可发放 = 已启用 ∧ 参与结算
  assert.ok(options.length > 0, "前置：至少要有一张可发放的券，否则这条断言是空的");
  for (const option of options) {
    const record = templateOf(option.id);
    assert.equal(record.enabled, true, `${option.id} 已停用却出现在可发放列表里`);
    assert.equal(record.formKey, "threshold", `${option.id} 不参与结算却出现在可发放列表里`);
    assert.equal(isComputableCouponForm(record.formKey), true);
  }
});

test("P1-6 §1：历史 discount / gift 券不会误进结算可选列表（cmd 第 14 项）", async () => {
  // 这两张券在种子里是**启用状态**的，因此「不进列表」不是因为被停用，而是因为形态
  assert.equal(templateOf(DISCOUNT_COUPON).enabled, true);
  assert.equal(templateOf(GIFT_COUPON).enabled, true);

  const draft = await preview();
  for (const item of draft.availableCoupons) {
    const template = templateOf(item.couponId);
    assert.equal(
      isComputableCouponForm(template.formKey),
      true,
      `${item.couponId}（${template.formKey}）不该出现在结算可选列表里`,
    );
  }
  assert.equal(
    draft.availableCoupons.some((item) => item.couponId === DISCOUNT_COUPON),
    false,
  );
  assert.equal(
    draft.availableCoupons.some((item) => item.couponId === GIFT_COUPON),
    false,
  );
  // ⚠️ 这里原本还有一条 `assert.equal(COUPON_USE_UNSUPPORTED_REASON.length > 0, true)`。
  // 那是对常量的恒真判断，不保护任何不变量，已删除；`COUPON_USE_UNSUPPORTED_REASON`
  // 在结算侧的真实用途由 `couponCheckoutChain.test.mjs` 覆盖。
});

test("P1-6 §7：发放快照取的是**发放那一刻**的模板，之后改模板不追溯", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  const snapshotAtGrant = { ...claimOf(claimId).snapshot };
  assert.equal(snapshotAtGrant.name, "P1-6 测试券");
  assert.equal(snapshotAtGrant.thresholdAmount, 100);

  // 后台改了模板：名称、门槛、面额、有效期全变
  await update(couponId, {
    name: "改名换面额",
    thresholdAmount: 800,
    discountAmount: 300,
    validTo: "2099-06-30T15:59:59.000Z",
  });

  assert.deepEqual(claimOf(claimId).snapshot, snapshotAtGrant, "已发出去的券沿用发放那一刻的券面");

  // 新发的那一张才用新值——两张券落在同一份记录表里，各自的快照互不影响
  const granted = await grantCouponToUser(
    ADMIN_ID,
    { idempotencyKey: uniqueKey(), userId: SEEDED_USER, couponId },
    "server",
  );
  const fresh = claimOf(granted.claimId);
  assert.equal(fresh.snapshot.name, "改名换面额");
  assert.equal(fresh.snapshot.thresholdAmount, 800);
  assert.equal(fresh.snapshot.discountAmount, 300);
  assert.deepEqual(
    claimOf(claimId).snapshot,
    snapshotAtGrant,
    "发第二张不该把第一张的快照一起改掉",
  );
});

// ═══════════════════════ 八、DTO 与纯函数（cmd 第 12、15 项） ═══════════════════════

test("P1-6 DTO：列表项、列表结果与写结果的键集合精确（cmd 第 15 项）", async () => {
  const page = await adminTemplates({ pageSize: 1 });
  const [item] = page.items;

  assert.deepEqual(Object.keys(item).sort(), [
    "claimCount",
    "conditionLabel",
    "createdAt",
    "discountAmount",
    "editable",
    "enabled",
    "formKey",
    "formLabel",
    "id",
    "name",
    "thresholdAmount",
    "updatedAt",
    "validFrom",
    "validTo",
    "valueLabel",
  ]);
  assert.deepEqual(Object.keys(page).sort(), [
    "counts",
    "hasMore",
    "items",
    "notice",
    "page",
    "pageSize",
    "total",
  ]);
  assert.deepEqual(Object.keys(page.counts).sort(), ["all", "disabled", "enabled"]);

  const created = await create({ name: "写结果键" });
  assert.deepEqual(Object.keys(created).sort(), ["changed", "couponId", "enabled", "updatedAt"]);
  // 写成功的返回**不含**整条实体：界面据此就地更新那一行，不重拉整页
  assert.equal("thresholdAmount" in created, false);
  assert.equal("valueLabel" in created, false);
});

test("P1-6 DTO：非满减券的金额必须是 null 而不是 0（那是「不参与结算」的唯一标记）", async () => {
  const item = await detail(GIFT_COUPON);
  assert.equal(item.thresholdAmount, null);
  assert.equal(item.discountAmount, null);
  assert.equal(item.editable, false);

  const threshold = await detail(THRESHOLD_COUPON);
  assert.equal(threshold.editable, true, "满减券可编辑");

  // `editable` 由服务端算好；页面照着用，不自己再判一次 formKey
  assert.equal(toAdminCouponTemplateItem({ ...templateOf(GIFT_COUPON) }, 0).editable, false);
});

test("P1-6 DTO：已领取张数来自真实领取记录，不是写死的 0", async () => {
  const { couponId, claimId } = await issueThresholdCoupon();
  assert.ok(claimId);

  const item = await detail(couponId);
  assert.equal(item.claimCount, 1);

  // 再领一张（换个人）：数字必须跟着涨。
  // ⚠️ 领的必须是同一张 `couponId`、换的必须是**用户**——第一参数是 userId。
  // 原先这里把券 id 当 userId 传了进去、又断了另一张券的 count，等于什么都没验，
  // 还顺手在 store 里留下一条「券 id 当用户 id」的脏领取记录。
  await claimCouponForUser(
    SECOND_USER,
    couponId,
    { idempotencyKey: uniqueKey() },
    "server",
  );
  assert.equal((await detail(couponId)).claimCount, 2);

  // ⚠️ 人数是「提示」不是闸：领过多少张都不构成拒绝停用的理由
  const stopped = await setEnabled(couponId, false);
  assert.equal(stopped.changed, true);
});

// ═══════════════════════ 九、字段规则（纯函数层） ═══════════════════════

test("P1-6 字段规则：元 ⇄ 分只走字符串解析，不产生浮点中间值", () => {
  assert.equal(parseCouponYuanToFen("100"), 10_000);
  assert.equal(parseCouponYuanToFen("100.5"), 10_050);
  assert.equal(parseCouponYuanToFen("100.05"), 10_005);
  assert.equal(parseCouponYuanToFen("  100  "), 10_000);

  // 不合法的一律 null：调用方给什么文案由那边的校验决定
  for (const raw of [
    "",
    "0",
    "-1",
    "0.00",
    "1e3",
    "0x10",
    "+1",
    "1,000",
    "１００",
    "1.005",
    "100.555",
    "abc",
    "99999.99.",
  ]) {
    assert.equal(parseCouponYuanToFen(raw), null, `${raw} 不该被解析成金额`);
  }

  // 上限：99999.99 元可以，再多一分不行
  assert.equal(parseCouponYuanToFen("99999.99"), ADMIN_COUPON_AMOUNT_MAX_FEN);
  assert.equal(parseCouponYuanToFen("100000"), null);
  // 非字符串一律不合法，**不是**先 String() 再解析
  assert.equal(parseCouponYuanToFen(10), null);
  assert.equal(parseCouponYuanToFen(null), null);

  // 写进输入框的文本必须能原样解析回来——这是「打开编辑页保存却不该改动」的前提
  for (const fen of [10_000, 10_050, 10_005, 1, 99, ADMIN_COUPON_AMOUNT_MAX_FEN]) {
    const text = formatCouponFenForInput(fen);
    assert.equal(parseCouponYuanToFen(text), fen, `${fen} 分写成「${text}」后应当能解析回同一个数`);
  }
  assert.equal(formatCouponFenForInput(10_000), "100", "整元不带小数点");
  assert.equal(formatCouponFenForInput(10_050), "100.50", "非整元补足两位");
  assert.equal(formatCouponFenForInput(10_005), "100.05");
  assert.equal(formatCouponFenForInput(null), "", "记录里没有金额 → 空输入框，不是 0");
});

test("P1-6 字段规则：逐字段错误按页面顺序给出，第一条错即最靠上的那条", async () => {
  const errors = couponTemplateFieldErrors({
    name: "",
    thresholdAmount: Number.NaN,
    discountAmount: 1.5,
    validFrom: "",
    validTo: "不是时间",
    enabled: true,
  });

  assert.equal(errors.name, ADMIN_COUPON_NAME_EMPTY_MESSAGE);
  assert.equal(errors.thresholdAmount, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE);
  assert.equal(errors.discountAmount, ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE);
  assert.equal(errors.validFrom.length > 0, true);
  assert.equal(errors.validTo.length > 0, true);
  assert.deepEqual(Object.keys(ADMIN_COUPON_FIELD_LABELS), [
    "name",
    "thresholdAmount",
    "discountAmount",
    "validFrom",
    "validTo",
    "enabled",
  ]);

  // 门槛本身不合法时**不再**报「优惠金额大于门槛」：第二条没有意义
  const onlyThreshold = couponTemplateFieldErrors({
    name: "券",
    thresholdAmount: Number.NaN,
    discountAmount: 999_999,
    validFrom: WIDE_FROM,
    validTo: WIDE_TO,
    enabled: true,
  });
  assert.equal(onlyThreshold.thresholdAmount, ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE);
  assert.equal(onlyThreshold.discountAmount, null);

  // 非法就是非法：归一化函数返回 null，不做夹取
  assert.equal(
    normalizeCouponTemplatePatch({
      name: "券",
      thresholdAmount: -1,
      discountAmount: 1,
      validFrom: WIDE_FROM,
      validTo: WIDE_TO,
      enabled: true,
    }),
    null,
  );
});

test("P1-6 字段规则：启用状态只影响「这次是什么动作」，不影响字段校验", async () => {
  // `enabled` 没有错误位：它能失败的方式只有「不是布尔」，而 `readBoolean` 已经收敛了
  const errors = couponTemplateFieldErrors({
    name: "券",
    thresholdAmount: 100,
    discountAmount: 10,
    validFrom: WIDE_FROM,
    validTo: WIDE_TO,
    enabled: false,
  });
  assert.equal(errors.enabled, null);
  assert.ok(normalizeCouponTemplatePatch({
    name: "券",
    thresholdAmount: 100,
    discountAmount: 10,
    validFrom: WIDE_FROM,
    validTo: WIDE_TO,
    enabled: false,
  }));
});

// ═══════════════════════ 十、审计（cmd 第 17 项） ═══════════════════════

test("P1-6 审计：create / update / enable / disable 各写一条，且快照只含标量", async () => {
  const { couponId } = await create({ name: "审计全流程" });
  await update(couponId, { name: "审计改名" });
  await setEnabled(couponId, false);
  await setEnabled(couponId, true);

  const audits = await auditsFor(couponId);
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ["coupon.create", "coupon.update", "coupon.disable", "coupon.enable"],
  );
  for (const entry of audits) {
    assert.equal(entry.targetType, "coupon");
    assert.equal(entry.targetId, couponId);
    assert.equal(entry.actorId, ADMIN_ID);
    for (const value of Object.values({ ...entry.before, ...entry.after })) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `审计快照只能是标量，收到 ${typeof value}`,
      );
    }
  }

  // 快照挑字段：文案与建档时间**不进去**——它们不是「这次改了什么」
  const after = audits[1].after;
  assert.equal("valueLabel" in after, false, "文案由金额派生，记进审计是噪声");
  assert.equal("conditionLabel" in after, false);
  assert.equal("createdAt" in after, false);
  assert.equal(after.name, "审计改名");
  assert.equal(after.thresholdAmount, 10_000);

  // 新建的 before 是 null：新建之前不存在这条记录
  assert.equal(audits[0].before, null);
});

test("P1-6 审计：失败与空保存都不写审计，重放也不写第二条", async () => {
  const auditBefore = await getAdminAuditRepository().countAudits();

  await create({ name: "非法门槛券", thresholdAmount: -1 }).catch(() => {});
  const { couponId } = await create({ name: "审计计数" });
  const afterCreate = await getAdminAuditRepository().countAudits();
  assert.equal(afterCreate, auditBefore + 1);

  await update(couponId, { name: "审计计数" });
  await setEnabled(couponId, true);
  await setEnabled(couponId, true);
  const key = uniqueKey();
  await update(couponId, { name: "审计计数" }, key);
  await update(couponId, { name: "审计计数" }, key);

  assert.equal(
    await getAdminAuditRepository().countAudits(),
    afterCreate,
    "空保存、已是该状态、重放——三种都不该产生新的审计",
  );
});

// ═══════════════════════ 十一、HTTP：权限矩阵（cmd 第 16 项） ═══════════════════════

const BASE = process.env.APP_BASE_URL;

// ⚠️ 必须在**发起任何请求之前**执行——这一行加上 --test-concurrency=1，才是「本文件的断言读到的是预置状态」的保证。
await resetServerStores();
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P1-6 券模板的 HTTP 用例";

async function requestWithCookie(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function mockLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

async function sendWithCookie(method, pathname, body, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
  return { status: response.status, body: await response.text() };
}

/**
 * 四条券模板写接口。请求体**故意不带幂等键**（不是漏了）：
 * 被拒身份拿到 401 / 403、管理者拿到「幂等键缺失」的 400，
 * 这本身就证明 `requireAdmin()` 排在解析入参之前；而这一轮用例一个字节都不写。
 */
function writeCases() {
  const body = JSON.stringify({});
  return [
    ["POST", "/api/admin/coupon-templates", body],
    ["PATCH", `/api/admin/coupon-templates/${THRESHOLD_COUPON}`, body],
    ["POST", `/api/admin/coupon-templates/${THRESHOLD_COUPON}/enable`, body],
    ["POST", `/api/admin/coupon-templates/${THRESHOLD_COUPON}/disable`, body],
  ];
}

test("P1-6 券模板接口权限矩阵：匿名 401，无权限身份 403，管理者走到业务校验", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  const adminCookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  const readPaths = [
    "/api/admin/coupon-templates",
    `/api/admin/coupon-templates/${THRESHOLD_COUPON}`,
  ];
  const writes = writeCases();

  // ① 匿名：读与写都是 401。**读也是 401**——模板里有停用中的券与历史券，
  //    与用户端「只看得见可领的那些」不是同一个视野
  for (const pathname of readPaths) {
    assert.equal((await requestWithCookie(pathname, null)).status, 401, `${pathname} 匿名应当 401`);
  }
  for (const [method, pathname, body] of writes) {
    assert.equal(
      (await sendWithCookie(method, pathname, body, null)).status,
      401,
      `${pathname} 匿名应当 401`,
    );
  }

  // ② 普通用户的 Cookie 换不来管理权限（哪怕 id 长得像管理者）
  for (const cookie of ["mock_user_id=u-1001", "mock_user_id=admin-1"]) {
    assert.equal((await requestWithCookie(readPaths[0], cookie)).status, 401);
    assert.equal((await sendWithCookie("POST", writes[0][1], writes[0][2], cookie)).status, 401);
  }

  if (!adminCookie) {
    for (const id of ["admin-2", "admin-3", "admin-4"]) {
      assert.equal((await requestWithCookie(readPaths[0], `mock_admin_id=${id}`)).status, 401);
    }
    return;
  }

  // ③ 有会话但没权限：客服、护航、被停用的管理员——读与写都 403
  const messages = new Set();
  for (const id of ["admin-2", "admin-3", "admin-4"]) {
    for (const pathname of readPaths) {
      const { status, body } = await requestWithCookie(pathname, `mock_admin_id=${id}`);
      assert.equal(status, 403, `无权身份不该读 ${pathname}`);
      messages.add(JSON.parse(body).error.message);
    }
    for (const [method, pathname, body] of writes) {
      const result = await sendWithCookie(method, pathname, body, `mock_admin_id=${id}`);
      assert.equal(result.status, 403, `无权身份不该写 ${pathname}`);
      messages.add(JSON.parse(result.body).error.message);
    }
  }
  assert.equal(messages.size, 1, `拒绝文案应当只有一句：${[...messages].join(" / ")}`);

  // ④ 管理员：读 200；写则**穿过了权限层**——错在缺幂等键（400），不是被挡在门外
  for (const pathname of readPaths) {
    assert.equal((await requestWithCookie(pathname, adminCookie)).status, 200);
  }
  for (const [method, pathname, body] of writes) {
    const result = await sendWithCookie(method, pathname, body, adminCookie);
    assert.equal(result.status, 400, `${pathname} 管理者应当走到业务校验`);
    assert.equal(JSON.parse(result.body).error.code, "BAD_REQUEST");
    assert.equal("data" in JSON.parse(result.body), false);
  }

  // 不存在的对象：对管理者是 404（GET 与 PATCH 都是），对被拒身份仍然是 403
  assert.equal((await requestWithCookie("/api/admin/coupon-templates/cpn-nope", adminCookie)).status, 404);
  assert.equal(
    (await sendWithCookie("PATCH", "/api/admin/coupon-templates/cpn-nope", "{}", adminCookie)).status,
    400,
    "缺幂等键先于「对象存不存在」被拒——权限与入参的顺序是有意的",
  );
  assert.equal(
    (await requestWithCookie("/api/admin/coupon-templates/cpn-nope", "mock_admin_id=admin-2")).status,
    403,
  );

  // 非法筛选值：接口是严格模式（页面走的是宽松模式，见前面那条用例）
  assert.equal(
    (await requestWithCookie("/api/admin/coupon-templates?enabled=gone", adminCookie)).status,
    400,
  );
});

test("P1-6 券模板接口端到端：建一张 → 改它 → 停用它，用户端每一步都读得到", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];

  const key = uniqueKey();
  const created = await sendWithCookie(
    "POST",
    "/api/admin/coupon-templates",
    JSON.stringify({
      idempotencyKey: key,
      name: "HTTP 端到端券",
      thresholdAmount: 5_000,
      discountAmount: 500,
      validFrom: WIDE_FROM,
      validTo: WIDE_TO,
      enabled: true,
    }),
    adminCookie,
  );
  assert.equal(created.status, 200);
  const couponId = JSON.parse(created.body).data.couponId;

  // 列表里立刻看得到它
  const listed = JSON.parse(
    (await requestWithCookie(`/api/admin/coupon-templates?keyword=${couponId}`, adminCookie)).body,
  ).data;
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].valueLabel, "满 50 减 5", "券面文案由服务端按金额派生");

  // 停用它
  const disabled = await sendWithCookie(
    "POST",
    `/api/admin/coupon-templates/${couponId}/disable`,
    JSON.stringify({ idempotencyKey: uniqueKey() }),
    adminCookie,
  );
  assert.equal(disabled.status, 200);
  assert.equal(JSON.parse(disabled.body).data.enabled, false);

  // 详情仍然打得开（停用不是记录消失）
  const detailResponse = await requestWithCookie(
    `/api/admin/coupon-templates/${couponId}`,
    adminCookie,
  );
  assert.equal(detailResponse.status, 200);
  assert.equal(JSON.parse(detailResponse.body).data.enabled, false);
});
