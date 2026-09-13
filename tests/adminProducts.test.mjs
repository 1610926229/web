import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  ADMIN_CATALOG_MAX_PAGE,
  ADMIN_CATALOG_MAX_PAGE_SIZE,
} from "../lib/constants/adminCatalog.ts";
import {
  ADMIN_PRODUCT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
  ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_PRODUCT_REMOVED_MESSAGE,
  ADMIN_PRODUCT_UNKNOWN_SPEC_MESSAGE,
  ADMIN_PRODUCT_DUPLICATE_SPEC_ID_MESSAGE,
  DETAIL_IMAGE_MAX_COUNT,
  PRODUCT_COVER_INVALID_MESSAGE,
  PRODUCT_COVER_OPTIONS,
  PRODUCT_CATEGORY_INVALID_MESSAGE,
  PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE,
  PRODUCT_DETAIL_IMAGE_INVALID_MESSAGE,
  PRODUCT_DETAIL_IMAGE_TOO_MANY_MESSAGE,
  PRODUCT_GAME_INVALID_MESSAGE,
  PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  PRODUCT_TITLE_PRICE_MESSAGE,
  PRODUCT_TITLE_TOO_LONG_MESSAGE,
  PRODUCT_TITLE_MAX_LENGTH,
  PRODUCT_TITLE_EMPTY_MESSAGE,
  PRODUCT_SORT_ORDER_INVALID_MESSAGE,
  SPEC_NAME_DUPLICATE_MESSAGE,
  SPEC_PRICE_INVALID_MESSAGE,
  SPEC_SORT_ORDER_INVALID_MESSAGE,
  TAG_MAX_LENGTH,
  adminProductStatus,
  countAdminProductStates,
  firstProductProfileErrorField,
  formatPriceFenForInput,
  hasProductProfileError,
  normalizeProductProfilePatch,
  parsePriceYuanToFen,
  productProfileFieldErrors,
  productSpecErrors,
  productTitleContainsPrice,
} from "../lib/constants/adminProducts.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getCatalogRepository } from "../lib/data/catalogRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { productSeed } from "../lib/mocks/fixtures/catalogSeed.ts";
import { getProductDetail } from "../lib/services/catalog.ts";
import {
  createAdminProduct,
  getAdminProductDetail,
  getAdminProductFormOptions,
  queryAdminProductList,
  removeAdminProduct,
  resolveAdminProductListQuery,
  setAdminProductStatus,
  updateAdminProduct,
} from "../lib/services/adminProducts.ts";
import {
  confirmPaymentRequest,
  createPaymentRequest,
  getOrderForUser,
  previewCheckout,
} from "../lib/services/checkout.ts";
import { getGames } from "../lib/services/catalog.ts";

/**
 * P8B：商品与规格管理的持续测试。
 *
 * 守的是 §商品规则 / §规格规则 / §API、权限与一致性。这一份里最要紧的四条：
 *
 * 1. **金额只以整数分进实体**。表单输入的是元字符串，转换只发生在
 *    `parsePriceYuanToFen()` 一次；`1.005` / `1e3` / `-1` / `0` 一个都不能过，
 *    因为「先 parseFloat 再乘 100」会产生 100.49999999999999 这种值。
 * 2. **规格的身份是 id，不是数组下标**。订单快照里记的正是这个 id，
 *    按下标当身份，删掉中间一行就会让后面所有行错位。
 * 3. **上架、移除、改价都有明确的边界**：在架商品不能失去最后一个有效规格；
 *    改价只影响之后的试算与支付，**历史订单读的是快照**。
 * 4. **一次保存 = 一次原子写入**：商品与它的全部规格要么一起生效，要么一起不生效，
 *    不存在「价格改了、规格没改」的半完成状态。
 *
 * 需要真实服务的断言（HTTP 状态码、权限矩阵）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `adminCompanionManagement.test.mjs` 同一套做法。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P8B 商品的 HTTP 用例";

const ADMIN_ID = "admin-1";
const USER = "u-1001";

const GAME_DELTA = "g-delta";
const GAME_VALORANT = "g-valorant";
const DELTA_LOSS = "c-loss";
const DELTA_FUN = "c-fun";
const VALORANT_RANK = "c-v-rank";

/** 在架、有三个规格、价格 2990 分的预置商品。 */
const ON_SHELF = "p-400w";
const ON_SHELF_SPEC = "s-400w";
const ON_SHELF_PRICE = 2990;

/** 预置的已下架商品：直链要显示「已下架」而不是 404。 */
const OFF_SHELF = "p-off-1";
const OFF_SHELF_SPEC = "s-900w";

/** 封面地址刻意写错的调试商品，用来验证「当前值例外」。 */
const BROKEN_IMAGE = "p-debug-broken-image";

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `p8b-prod-key-${process.pid}-${keySeq}`;
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

/** 管理端列表：先按地址栏参数解析查询条件，再取数（页面与接口走同一条路径）。 */
async function adminProducts(input = {}, strict = false) {
  const search = params(input);
  const query = await resolveAdminProductListQuery(search, strict);
  return queryAdminProductList(query, search, "server");
}

function createProduct(overrides = {}, key = uniqueKey()) {
  return createAdminProduct(ADMIN_ID, { idempotencyKey: key, ...productInput(overrides) });
}

function auditsFor(targetId) {
  return getAdminAuditRepository().listAudits({ targetType: "product", targetId });
}

function spec(overrides = {}) {
  return {
    id: "",
    name: "标准档",
    priceYuan: "9.90",
    sortOrder: 10,
    enabled: true,
    removed: false,
    ...overrides,
  };
}

/** 一份合法的商品提交体（默认下架，避免每个用例都要先准备规格）。 */
function productInput(overrides = {}) {
  return {
    gameId: GAME_DELTA,
    categoryId: DELTA_FUN,
    title: "测试商品",
    subtitle: "",
    coverUrl: PRODUCT_COVER_OPTIONS[0],
    tags: [],
    detailText: "",
    detailImages: [],
    sortOrder: 10,
    recommended: false,
    status: "off",
    specs: [spec()],
    ...overrides,
  };
}

/** 服务端规格实体 → 表单规格行：价格回填成「元」文本，两位小数。 */
function toSpecInput(item) {
  return {
    id: item.id,
    name: item.name,
    priceYuan: formatPriceFenForInput(item.price),
    sortOrder: item.sortOrder,
    enabled: item.enabled,
    removed: item.removedAt !== null,
  };
}

/**
 * 一条已存在商品的**完整**提交体，取自服务端当前值。
 *
 * 编辑接口要的是整份资料（不是增量 patch），因此改一个字段也得把其余字段原样带上。
 * 这正是它该有的样子：一次保存 = 一次完整写入，不存在「只提交一半」的中间状态。
 */
async function productBodyFrom(id, overrides = {}) {
  const detail = await getAdminProductDetail(id, undefined, "server");
  assert.ok(detail, `预置商品 ${id} 应当存在`);

  return productInput({
    gameId: detail.gameId,
    categoryId: detail.categoryId ?? "",
    title: detail.title,
    subtitle: detail.subtitle,
    coverUrl: detail.coverUrl,
    tags: [...detail.tags],
    detailText: detail.detailText,
    detailImages: [...detail.detailImages],
    sortOrder: detail.sortOrder,
    recommended: detail.recommended,
    status: detail.status,
    specs: detail.specs.map(toSpecInput),
    ...overrides,
  });
}

beforeEach(() => {
  // 目录与审计一起重置：幂等键的账本就在审计仓储里（`findAuditByOperationId`），
  // 只重置目录会让上一个用例用过的键在这个用例里变成「重放」
  resetMockStore("catalog");
  resetMockStore("adminAudit");
});

// ——————————————————————— 列表：搜索 / 筛选 / 分页 ———————————————————————

test("列表默认只看「使用中」：已下架还在里面，已移除不在——两者不是同一件事", async () => {
  const data = await adminProducts({ pageSize: 50 });
  assert.equal(data.total, productSeed.length);

  // 已下架是「不在用户端列表里」，不是「不在后台」：它必须还在这一页上，
  // 否则运营没有任何入口把它重新上架
  const offShelf = data.items.find((item) => item.id === OFF_SHELF);
  assert.ok(offShelf);
  assert.equal(offShelf.status, "off");
  assert.equal(offShelf.removedAt, null);

  const removed = await adminProducts({ removal: "removed", pageSize: 50 });
  assert.deepEqual(removed.items, []);
  assert.equal(removed.total, 0);
});

test("筛选：游戏、类目、上下架、推荐、已移除各筛各的", async () => {
  const byGame = await adminProducts({ gameId: GAME_VALORANT, pageSize: 50 });
  assert.equal(byGame.items.every((item) => item.gameId === GAME_VALORANT), true);
  assert.equal(
    byGame.total,
    productSeed.filter((item) => item.gameId === GAME_VALORANT).length,
  );

  const byCategory = await adminProducts({ categoryId: DELTA_LOSS, pageSize: 50 });
  assert.equal(byCategory.items.every((item) => item.categoryId === DELTA_LOSS), true);
  assert.equal(
    byCategory.total,
    productSeed.filter((item) => item.categoryId === DELTA_LOSS).length,
  );

  // 已下架那一件只出现在 status=off 里
  const off = await adminProducts({ status: "off", pageSize: 50 });
  assert.deepEqual(
    off.items.map((item) => item.id),
    [OFF_SHELF],
  );
  const on = await adminProducts({ status: "on", pageSize: 50 });
  assert.equal(
    on.items.some((item) => item.id === OFF_SHELF),
    false,
  );
  assert.equal(on.total + off.total, productSeed.length);

  const recommended = await adminProducts({ recommended: "recommended", pageSize: 50 });
  assert.equal(recommended.items.every((item) => item.recommended), true);
  const normal = await adminProducts({ recommended: "normal", pageSize: 50 });
  assert.equal(
    normal.items.every((item) => item.recommended === false),
    true,
  );
  assert.equal(
    recommended.total + normal.total,
    productSeed.length,
    "「推荐」与「普通」互斥且穷尽：加起来正好是全部",
  );

  // 叠加筛选：游戏 + 类目 + 状态同时生效
  const stacked = await adminProducts({
    gameId: GAME_DELTA,
    categoryId: DELTA_LOSS,
    status: "on",
    pageSize: 50,
  });
  assert.equal(
    stacked.items.every(
      (item) =>
        item.gameId === GAME_DELTA && item.categoryId === DELTA_LOSS && item.status === "on",
    ),
    true,
  );
  assert.equal(stacked.total, byCategory.total - 1);
});

test("搜索按标题匹配，搜不到就是 0 条（不退回全部）", async () => {
  const record = productSeed.find((item) => item.id === ON_SHELF);

  const hit = await adminProducts({ keyword: record.title, pageSize: 50 });
  assert.equal(
    hit.items.some((item) => item.id === ON_SHELF),
    true,
  );

  const miss = await adminProducts({ keyword: "不存在的商品标题", pageSize: 50 });
  assert.equal(miss.total, 0);
  assert.deepEqual(miss.items, []);
});

test("非法筛选值：接口 400（严格），页面收敛到默认值（宽松）", async () => {
  await expectApiError(
    resolveAdminProductListQuery(params({ status: "maybe" }), true),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveAdminProductListQuery(params({ recommended: "maybe" }), true),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveAdminProductListQuery(params({ removal: "gone" }), true),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveAdminProductListQuery(params({ gameId: "g-nope" }), true),
    "BAD_REQUEST",
    "筛选条件 gameId 不是有效的游戏",
  );
  await expectApiError(
    resolveAdminProductListQuery(params({ categoryId: "c-nope" }), true),
    "BAD_REQUEST",
    "筛选条件 categoryId 不是有效的类目",
  );

  const loose = await resolveAdminProductListQuery(
    params({ status: "maybe", recommended: "maybe", removal: "gone", gameId: "g-nope" }),
    false,
  );
  assert.equal(loose.status, "");
  assert.equal(loose.recommended, "");
  assert.equal(loose.removal, "active");
  assert.equal(loose.gameId, "");
});

test("分页：条数、hasMore 与越界页自洽，参数收敛到上限", async () => {
  const total = productSeed.length;
  const pages = Math.ceil(total / 10);

  const first = await adminProducts({ page: 1, pageSize: 10 });
  assert.equal(first.items.length, 10);
  assert.equal(first.total, total);
  assert.equal(first.hasMore, true);

  const last = await adminProducts({ page: pages, pageSize: 10 });
  assert.equal(last.items.length, total - (pages - 1) * 10);
  assert.equal(last.hasMore, false);

  const beyond = await adminProducts({ page: 99, pageSize: 10 });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);

  assert.equal((await adminProducts({ pageSize: 9999 })).pageSize, ADMIN_CATALOG_MAX_PAGE_SIZE);
  assert.equal((await adminProducts({ page: 0 })).page, 1);
  assert.equal((await adminProducts({ page: 10 ** 9 })).page, ADMIN_CATALOG_MAX_PAGE);
  assert.equal((await adminProducts({ page: "abc" })).page, 1);

  // 翻页不重不漏
  const seen = [];
  for (let page = 1; page <= pages; page += 1) {
    seen.push(...(await adminProducts({ page, pageSize: 10 })).items.map((item) => item.id));
  }
  assert.equal(new Set(seen).size, total);
});

test("角标：on / off / recommended / removed 互斥，四个加起来正好是 all", async () => {
  const data = await adminProducts({ pageSize: 50 });
  assert.deepEqual(data.counts, countAdminProductStates(productSeed));

  const { all, on, off, recommended, removed } = data.counts;
  assert.equal(all, productSeed.length);
  // 已下架的商品也算「使用中」，因此它不进 removed
  assert.equal(removed, 0);
  assert.equal(on + off, all - removed);
  assert.ok(recommended <= on + off);

  // 角标与筛选结果一致：数字和点进去看到的条数是同一个口径
  assert.equal((await adminProducts({ status: "on", pageSize: 50 })).total, on);
  assert.equal((await adminProducts({ status: "off", pageSize: 50 })).total, off);
  assert.equal((await adminProducts({ recommended: "recommended", pageSize: 50 })).total, recommended);
  assert.equal((await adminProducts({ removal: "removed", pageSize: 50 })).total, removed);
});

test("列表带出起售价、有效规格数与类目名；没有类目的商品类目名为空而不是崩掉", async () => {
  const data = await adminProducts({ keyword: "机密400万", pageSize: 50 });
  const row = data.items.find((item) => item.id === ON_SHELF);

  assert.equal(row.gameName, "三角洲行动");
  assert.equal(row.categoryName, "亏本单");
  assert.equal(row.priceFrom, ON_SHELF_PRICE, "起售价取有效规格里最低的那个");
  assert.equal(row.specCount, row.specs.length);
  assert.equal(row.effectiveSpecCount, row.specCount);
  // 后台要能看见并管理停用 / 已移除的规格，因此 specs 全量返回（与用户端 DTO 相反）
  assert.equal(row.specs.every((item) => "removedAt" in item), true);

  // 预置的调试商品没有类目：名称退回空串，而不是让整页渲染失败
  const orphan = (await adminProducts({ keyword: "调试用商品", pageSize: 50 })).items[0];
  assert.equal(orphan.id, BROKEN_IMAGE);
  assert.equal(orphan.categoryId, null);
  assert.equal(orphan.categoryName, "");
});

// ——————————————————————————— 新建 ———————————————————————————

test("新建商品：一次写入商品与全部规格，统计字段不由后台写入", async () => {
  const result = await createProduct({
    title: "新建商品甲",
    subtitle: "副标题",
    tags: ["热门"],
    detailText: "详情文字",
    detailImages: [PRODUCT_COVER_OPTIONS[1]],
    recommended: true,
    specs: [
      spec({ name: "一小时", priceYuan: "19.90", sortOrder: 10 }),
      spec({ name: "两小时", priceYuan: "35.50", sortOrder: 20 }),
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.status, "off");
  assert.equal(result.removedAt, null);
  assert.match(result.productId, /^p_/, "后台新建的 id 与预置数据的短 id 从取值域上分开");

  const detail = await getAdminProductDetail(result.productId, undefined, "server");
  assert.equal(detail.title, "新建商品甲");
  assert.equal(detail.subtitle, "副标题");
  assert.deepEqual(detail.tags, ["热门"]);
  assert.equal(detail.recommended, true);
  assert.equal(detail.effectiveSpecCount, 2);
  assert.equal(detail.specCount, 2);

  // 元 → 分：整数分落库，不出现浮点尾巴
  assert.deepEqual(
    detail.specs.map((item) => [item.name, item.price]),
    [
      ["一小时", 1990],
      ["两小时", 3550],
    ],
  );
  assert.equal(detail.specs.every((item) => Number.isInteger(item.price)), true);
  assert.equal(detail.specs.every((item) => item.id.startsWith("sp_")), true);
  assert.equal(detail.specs.every((item) => item.removedAt === null), true);

  // 销量与平台标签不由后台写入：新建时它们是初始值，而不是「客户端传什么就是什么」
  assert.equal(detail.monthlySales, 0);
  assert.equal(detail.gameTag, "");

  // 审计 before 为 null（新建时还不存在「更新前」）
  const audits = await auditsFor(result.productId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "product.create");
  assert.equal(audits[0].before, null);
  assert.equal(audits[0].after.title, "新建商品甲");
  assert.equal(audits[0].after.effectiveSpecCount, 2);
  assert.equal(audits[0].adminId, ADMIN_ID);
  // 快照里没有销量与平台标签：它们不是这次编辑改的东西
  assert.equal("monthlySales" in audits[0].after, false);
  assert.equal("gameTag" in audits[0].after, false);

  // 商品与规格是一次写入的：不存在「商品建好了但规格没进去」的中间状态
  assert.equal(detail.specs.length, 2);
});

test("新建时直接上架：状态生效，且要求至少一个有效规格", async () => {
  const result = await createProduct({
    title: "直接上架",
    status: "on",
    specs: [spec({ name: "档位", priceYuan: "9.90" })],
  });
  assert.equal(result.status, "on");

  // 一个新商品直接建到「上架却没有可用规格」是不允许的
  await expectApiError(
    createProduct({
      title: "上架没规格",
      status: "on",
      specs: [spec({ name: "档位", enabled: false })],
    }),
    "BAD_REQUEST",
    PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  );

  assert.equal((await adminProducts({ keyword: "上架没规格" })).total, 0);
  // 只有第一次新建的那条写了审计
  assert.equal((await getAdminAuditRepository().listAudits()).length, 1);
});

test("DTO 边界：客户端伪造的 id / 销量 / 平台标签 / 时间 / 移除状态一律没有入口", async () => {
  const result = await createAdminProduct(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...productInput({ title: "伪造测试", categoryId: DELTA_FUN }),
    // 下面这些在服务层**没有读取的位置**，不是「校验后被忽略」
    id: ON_SHELF,
    monthlySales: 99999,
    gameTag: "伪造标签",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    removedAt: "2020-01-01T00:00:00.000Z",
  });

  assert.notEqual(result.productId, ON_SHELF, "id 由服务端在原子区段里生成");
  assert.equal(result.removedAt, null);

  const detail = await getAdminProductDetail(result.productId, undefined, "server");
  assert.equal(detail.monthlySales, 0);
  assert.equal(detail.gameTag, "");
  assert.notEqual(detail.createdAt, "2020-01-01T00:00:00.000Z");

  // 预置的那条商品没有被覆盖
  assert.equal(
    (await getAdminProductDetail(ON_SHELF, undefined, "server")).monthlySales,
    productSeed.find((item) => item.id === ON_SHELF).monthlySales,
  );

  // 商品实体里没有库存与限购字段：本阶段不做这两件事，留一个「先填个 0」的字段
  // 只会让人以为它已经在生效
  assert.equal("stock" in detail, false);
  assert.equal("limitPerUser" in detail, false);
});

// ——————————————————————— 游戏与类目归属 ———————————————————————

test("类目必须属于所选游戏、且启用未移除，否则不能保存", async () => {
  // 类目存在，但属于另一个游戏
  await expectApiError(
    createProduct({ gameId: GAME_DELTA, categoryId: VALORANT_RANK }),
    "BAD_REQUEST",
    PRODUCT_CATEGORY_INVALID_MESSAGE,
  );

  await expectApiError(
    createProduct({ gameId: "g-nope" }),
    "BAD_REQUEST",
    PRODUCT_GAME_INVALID_MESSAGE,
  );

  // 停用的类目不能用于新建或编辑归属
  const { setAdminCategoryEnabled } = await import("../lib/services/adminCategories.ts");
  await setAdminCategoryEnabled(DELTA_FUN, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  await expectApiError(
    createProduct({ categoryId: DELTA_FUN }),
    "BAD_REQUEST",
    PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE,
  );

  // 已移除的类目同理
  const { createAdminCategory, removeAdminCategory } = await import(
    "../lib/services/adminCategories.ts"
  );
  const created = await createAdminCategory(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    gameId: GAME_DELTA,
    name: "待移除归属",
    sortOrder: 500,
    enabled: true,
  });
  await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() });
  await expectApiError(
    createProduct({ categoryId: created.categoryId }),
    "BAD_REQUEST",
    PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE,
  );

  assert.equal((await adminProducts({ keyword: "测试商品" })).total, 0);
});

test("上架校验发生在原子区段里：类目中途被停用，上架同样被拒", async () => {
  const created = await createProduct({
    title: "类目停用后上架",
    categoryId: DELTA_FUN,
    status: "off",
  });

  const { setAdminCategoryEnabled } = await import("../lib/services/adminCategories.ts");
  await setAdminCategoryEnabled(DELTA_FUN, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  await expectApiError(
    setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    PRODUCT_CATEGORY_UNAVAILABLE_MESSAGE,
  );
  assert.equal(
    (await getAdminProductDetail(created.productId, undefined, "server")).status,
    "off",
    "被拒绝的上架没有把状态改坏",
  );

  // 下架不需要类目可用：一件挂在停用类目下的商品要能收拾走
  const { setAdminCategoryEnabled: enable } = await import("../lib/services/adminCategories.ts");
  await enable(DELTA_FUN, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  await setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() });
  await setAdminCategoryEnabled(DELTA_FUN, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(
    (
      await setAdminProductStatus(created.productId, "off", ADMIN_ID, {
        idempotencyKey: uniqueKey(),
      })
    ).changed,
    true,
  );
});

// ——————————————————————— 图片白名单 ———————————————————————

test("封面与详情图只能选白名单里的图，任意地址一律拒绝", async () => {
  for (const bad of [
    "https://example.com/a.png",
    "C:\\Users\\me\\a.png",
    "/mock/this-image-does-not-exist.svg",
    "/uploads/a.png",
    "javascript:alert(1)",
  ]) {
    await expectApiError(
      createProduct({ coverUrl: bad }),
      "BAD_REQUEST",
      PRODUCT_COVER_INVALID_MESSAGE,
    );
  }

  await expectApiError(
    createProduct({ detailImages: ["https://example.com/a.png"] }),
    "BAD_REQUEST",
    PRODUCT_DETAIL_IMAGE_INVALID_MESSAGE,
  );

  assert.equal((await adminProducts({ keyword: "测试商品" })).total, 0);
});

test("详情图最多六张，超出的部分被拒而不是被静默截断", async () => {
  await expectApiError(
    createProduct({
      detailImages: Array.from(
        { length: DETAIL_IMAGE_MAX_COUNT + 1 },
        (_, index) => PRODUCT_COVER_OPTIONS[index % PRODUCT_COVER_OPTIONS.length],
      ),
    }),
    "BAD_REQUEST",
    PRODUCT_DETAIL_IMAGE_TOO_MANY_MESSAGE,
  );

  // 正好六张是可以的（边界值本身合法）
  const ok = await createProduct({
    title: "六张详情图",
    detailImages: Array.from({ length: DETAIL_IMAGE_MAX_COUNT }, (_, index) =>
      PRODUCT_COVER_OPTIONS[index % PRODUCT_COVER_OPTIONS.length],
    ),
  });
  assert.equal(
    (await getAdminProductDetail(ok.productId, undefined, "server")).detailImages.length,
    DETAIL_IMAGE_MAX_COUNT,
  );
});

test("当前封面例外：封面写错的调试商品能改标题，但换一张白名单外的图仍被拒", async () => {
  const body = await productBodyFrom(BROKEN_IMAGE, { categoryId: DELTA_FUN });

  // 保留那条写错的旧封面是允许的：不然它连标题都改不动，
  // 而「只想改个标题却被迫先换一张图」是个说不通的规则
  const saved = await updateAdminProduct(BROKEN_IMAGE, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...body,
    title: "调试用商品（已改名）",
  });
  assert.equal(saved.changed, true);
  assert.equal(
    (await getAdminProductDetail(BROKEN_IMAGE, undefined, "server")).coverUrl,
    productSeed.find((item) => item.id === BROKEN_IMAGE).coverUrl,
  );

  // 但换成另一张白名单外的图不行
  await expectApiError(
    updateAdminProduct(BROKEN_IMAGE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...body,
      title: "调试用商品（已改名）",
      coverUrl: "https://example.com/a.png",
    }),
    "BAD_REQUEST",
    PRODUCT_COVER_INVALID_MESSAGE,
  );

  // ⚠️ 这份「当前值」取自服务端读到的记录，而不是请求体：
  // 客户端把任意地址塞进 currentCoverUrl 也不会被采纳
  await expectApiError(
    updateAdminProduct(BROKEN_IMAGE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...body,
      title: "调试用商品（已改名）",
      coverUrl: "https://example.com/a.png",
      currentCoverUrl: "https://example.com/a.png",
    }),
    "BAD_REQUEST",
    PRODUCT_COVER_INVALID_MESSAGE,
  );
});

// ——————————————————————————— 标题 ———————————————————————————

test("标题不得包含价格前缀，且不能用 maxLength 静默截断", async () => {
  for (const title of [
    "机密400万 9.9元",
    "9.9元起 机密400万",
    "机密400万 ¥9.9",
    "机密400万 30块钱",
    "$9.9 机密单",
  ]) {
    await expectApiError(
      createProduct({ title }),
      "BAD_REQUEST",
      PRODUCT_TITLE_PRICE_MESSAGE,
    );
  }

  // 判定刻意只认「货币符号」与「数字 + 元 / 块」，不认「标题里有数字」：
  // 「机密400万」是一个完全合理的产品名（「万」在这里是数量单位，不是钱），
  // 把它拦下来会比漏掉几个变体更让人困惑
  assert.equal(productTitleContainsPrice("机密400万"), false);
  assert.equal(productTitleContainsPrice("特价9.9"), false);
  assert.equal(productTitleContainsPrice("机密400万 9.9元"), true);
  assert.equal((await createProduct({ title: "特价9.9 机密单" })).changed, true);

  // 超长标题报错，而不是被截成 30 个字悄悄存下来
  await expectApiError(
    createProduct({ title: "标".repeat(PRODUCT_TITLE_MAX_LENGTH + 1) }),
    "BAD_REQUEST",
    PRODUCT_TITLE_TOO_LONG_MESSAGE,
  );
  // 边界值本身合法
  assert.equal(
    (
      await createProduct({ title: "标".repeat(PRODUCT_TITLE_MAX_LENGTH) })
    ).changed,
    true,
  );

  // 标签也有上限与去重规则
  await expectApiError(
    createProduct({ tags: ["超".repeat(TAG_MAX_LENGTH + 1)] }),
    "BAD_REQUEST",
  );
  await expectApiError(createProduct({ tags: ["热门", "热门"] }), "BAD_REQUEST");
});

// ——————————————————————— 规格：名称 / 金额 / 身份 ———————————————————————

/**
 * 每一个合法写法 → 应当落库的整数分。
 *
 * 第一列是**界面上真正会被敲出来的东西**，不是构造出来的边界值：
 * 人工验收就是在新建商品的单价框里填了 `10`，被判成非法、商品建不出来。
 */
const LEGAL_PRICES = [
  ["0.01", 1],
  ["0.1", 10],
  ["0.10", 10],
  ["1", 100],
  ["1.0", 100],
  ["1.00", 100],
  ["10", 1000], // 人工验收填的就是这个
  ["10.5", 1050],
  ["10.50", 1050],
  ["9.90", 990],
  ["29.9", 2990],
  ["100", 10000],
  ["99999.99", 9999999], // 上限本身是合法的
];

/**
 * 每一个必须被拒的写法，分三类：
 * 不构成数字的、构成数字但形状不合规的（小数位 / 上限 / 零 / 负号）、
 * 以及**根本不是字符串**的——最后一类防的是「用 JS 数字绕过字符串规则」，
 * `0.1 + 0.2` 一旦被当成价格，就会变成一个谁也没敲过的金额。
 */
const ILLEGAL_PRICES = [
  "", "   ", "\t", // 空 / 只有空白
  "0", "0.00", "0.0", // 必须大于 0
  "-1", "-0.01", "-10.00", "+1", "--1", "1-", // 负号与正号
  "1.005", "0.001", "10.123", "99999.999", // 超过两位小数
  "100000", "100000.00", "999999.99", // 超过 99999.99 元
  "1e3", "1E3", "1e-3", "0x10", "0b10", // 科学计数法 / 其它进制
  "Infinity", "-Infinity", "NaN", "null", "undefined", // 特殊值文本
  "9.9.9", "1.2.3", "10.", ".5", "10..5", // 结构不对
  "1,000", "9,90", "1 0", // 千分位与空格分隔
  "１０", "９.９０", "10。5", // 全角数字 / 全角小数点
  "￥10", "¥10", "$10", "10元", "10分", // 货币符号与单位
  "abc", "十", "10a", "a10", // 不是数字
];

/** 非字符串输入：它们不能因为「长得像价格」就被接受。 */
const NON_STRING_PRICES = [
  10,
  0.5,
  1,
  1000,
  -1,
  Number.NaN,
  Infinity,
  null,
  undefined,
  true,
  ["10"],
  { toString: () => "10" },
];

test("金额转换：合法的元写法逐一落成整数分（含人工验收填的 10 元 = 1000 分）", () => {
  for (const [text, fen] of LEGAL_PRICES) {
    const parsed = parsePriceYuanToFen(text);
    assert.equal(parsed, fen, `${JSON.stringify(text)} 应当解析成 ${fen} 分`);
    // 结果必须是整数分：不允许出现 100.49999999999999 这样的浮点尾巴
    assert.equal(Number.isInteger(parsed), true, `${text} 应当落成整数分`);
  }

  // 首尾空白由解析自己 trim——界面不做预处理，服务端也不该因为多一个空格就拒收
  assert.equal(parsePriceYuanToFen(" 10 "), 1000);
  assert.equal(parsePriceYuanToFen("\t10\n"), 1000);
  assert.equal(parsePriceYuanToFen(" 0.01 "), 1);
  assert.equal(parsePriceYuanToFen(" 99999.99 "), 9999999);

  // 前导零维持原有口径：这一轮既不扩大格式，也不顺手收紧
  assert.equal(parsePriceYuanToFen("09.90"), 990);
  assert.equal(parsePriceYuanToFen("007"), 700);
  assert.equal(parsePriceYuanToFen("0.5"), 50);
  assert.equal(parsePriceYuanToFen("00.01"), 1);
});

test("金额转换：非法写法一律拒绝，非字符串也不能绕过字符串规则", () => {
  for (const bad of ILLEGAL_PRICES) {
    assert.equal(parsePriceYuanToFen(bad), null, `${JSON.stringify(bad)} 不该被解析成一个金额`);
  }

  for (const value of NON_STRING_PRICES) {
    assert.equal(
      parsePriceYuanToFen(value),
      null,
      `${typeof value}（${String(value)}）不是字符串，不能当价格`,
    );
  }

  // 数字 10 与字符串 "10" 只差一对引号，但不能被同等接受——
  // 否则 `parseFloat` 那条老路又回来了
  assert.equal(parsePriceYuanToFen(10), null);
  assert.equal(parsePriceYuanToFen("10"), 1000);

  // 整数分 → 表单回填字符串，**始终**两位小数
  assert.equal(formatPriceFenForInput(1000), "10.00");
  assert.equal(formatPriceFenForInput(1), "0.01");
  assert.equal(formatPriceFenForInput(1050), "10.50");
  assert.equal(formatPriceFenForInput(990), "9.90");
  assert.equal(formatPriceFenForInput(10000), "100.00");
  assert.equal(formatPriceFenForInput(9999999), "99999.99");
});

test("界面产物就是服务端读的那份 JSON：规格行带的是 priceYuan 元文本，不是分", async () => {
  const options = await getAdminProductFormOptions();
  const context = {
    games: options.games,
    categories: options.categories,
    currentCoverUrl: "",
    currentDetailImages: [],
  };

  // 表单在单价框里敲下 `10` 时的原始输入
  const input = productInput({ specs: [spec({ priceYuan: "10" })] });
  const wire = normalizeProductProfilePatch(input, context);
  assert.ok(wire, "合法输入必须能归一化");

  // ① 线格式的规格行**只有**这六个键，金额那个键叫 priceYuan
  assert.deepEqual(
    Object.keys(wire.specs[0]).sort(),
    ["enabled", "id", "name", "priceYuan", "removed", "sortOrder"],
    "规格行的线上形状只能是这六个键",
  );
  assert.equal(wire.specs[0].priceYuan, "10", "客户端只能表达「元」");
  assert.equal("price" in wire.specs[0], false, "客户端没有传「分」的通道");

  // ② 这份产物原样发给服务端（`AdminProductForm.save()` 就是这么发的），
  //    服务端必须读得懂。这一步曾经断掉：类型给的是 price（分），接口读的是 priceYuan，
  //    缺掉的键被 `readTrimmedString()` 兜成空串，于是 `10` 元被判成非法单价。
  const result = await createAdminProduct(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...wire,
  });
  assert.equal(result.changed, true, "表单产物必须能建出商品");

  const detail = await getAdminProductDetail(result.productId, undefined, "server");
  assert.equal(detail.specs.length, 1);
  assert.equal(detail.specs[0].price, 1000, "界面填的 10 元必须落成 1000 分");
  assert.equal(formatPriceFenForInput(detail.specs[0].price), "10.00");

  // ③ 归一化只去空白，不解析金额
  const padded = normalizeProductProfilePatch(
    productInput({ specs: [spec({ priceYuan: " 10 " })] }),
    context,
  );
  assert.equal(padded.specs[0].priceYuan, "10");
  assert.equal("price" in padded.specs[0], false);

  // ④ 非法金额在**界面这一层**就被拦下（与服务端同一份规则），`save()` 根本发不出请求
  for (const bad of ["1.005", "1e3", "0", "-1", "100000", "", "￥10"]) {
    assert.equal(
      normalizeProductProfilePatch(productInput({ specs: [spec({ priceYuan: bad })] }), context),
      null,
      `${JSON.stringify(bad)} 应当在提交前就被拦下`,
    );
  }

  // ⑤ 逐行定位：三个规格里只有第二行价格写错时，报错落在第二行的价格字段上
  const threeSpecs = [
    { id: "", name: "第一档", priceYuan: "10", sortOrder: 10, enabled: true, removed: false },
    { id: "", name: "第二档", priceYuan: "1.005", sortOrder: 20, enabled: true, removed: false },
    { id: "", name: "第三档", priceYuan: "20", sortOrder: 30, enabled: true, removed: false },
  ];
  const rows = productSpecErrors(threeSpecs);
  assert.deepEqual(rows.rows[0], { name: null, price: null, sortOrder: null });
  assert.equal(rows.rows[1].price, SPEC_PRICE_INVALID_MESSAGE, "错误要落在写错的那一行");
  assert.equal(rows.rows[1].name, null, "同一行里没写错的字段不带错误");
  assert.deepEqual(rows.rows[2], { name: null, price: null, sortOrder: null });
  assert.equal(rows.group, null, "这不是「规格名重复」，整组错误另有一条");

  // 整组也要算错，否则表单会「校验通过」并把兜底值写进实体
  const grouped = productProfileFieldErrors(
    productInput({ status: "on", specs: threeSpecs }),
    context,
  );
  assert.equal(grouped.specs, SPEC_PRICE_INVALID_MESSAGE);
  assert.equal(hasProductProfileError(grouped), true);
  // 行级错误不是字段级错误的键，`firstProductProfileErrorField()` 聚焦不到具体某一行，
  // 因此表单还必须按行渲染 `productSpecErrors().rows[i].price`
  assert.equal(firstProductProfileErrorField(grouped), "specs");

  // 把第二行改对，整组就不再报错
  const fixed = threeSpecs.map((row, index) => (index === 1 ? { ...row, priceYuan: "15" } : row));
  assert.equal(
    productProfileFieldErrors(productInput({ status: "on", specs: fixed }), context).specs,
    null,
  );
});

test("规格金额经接口同样严格转换：非法输入报单价错误，不写任何数据", async () => {
  for (const priceYuan of ILLEGAL_PRICES) {
    await expectApiError(
      createProduct({ specs: [spec({ priceYuan })] }),
      "BAD_REQUEST",
      SPEC_PRICE_INVALID_MESSAGE,
    );
  }
  // 非字符串进不来：接口层把它读成空串，结论仍然是「单价非法」
  for (const priceYuan of [10, 0.5, null, true, ["10"]]) {
    await expectApiError(
      createProduct({ specs: [spec({ priceYuan })] }),
      "BAD_REQUEST",
      SPEC_PRICE_INVALID_MESSAGE,
    );
  }

  assert.equal((await adminProducts({ keyword: "测试商品" })).total, 0);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 0);
});

test("每个合法写法都能建出商品并落成整数分；编辑改价走同一条转换", async () => {
  for (const [text, fen] of LEGAL_PRICES) {
    const created = await createProduct({
      title: `价格 ${text}`,
      specs: [spec({ name: "标准档", priceYuan: text })],
    });
    assert.equal(created.changed, true, `${JSON.stringify(text)} 应当能建出商品`);

    const detail = await getAdminProductDetail(created.productId, undefined, "server");
    assert.equal(detail.specs.length, 1);
    assert.equal(detail.specs[0].price, fen, `新建：${text} 应当落成 ${fen} 分`);
    assert.equal(Number.isInteger(detail.specs[0].price), true);
    // 金额展示始终两位小数
    assert.match(formatPriceFenForInput(detail.specs[0].price), /^\d+\.\d{2}$/);
  }

  // 编辑：把一条已有规格从别的价格改成 `10`，成功且**规格 id 不变**
  const target = ON_SHELF;
  const before = await getAdminProductDetail(target, undefined, "server");
  const original = before.specs.find((item) => item.id === ON_SHELF_SPEC);
  assert.ok(original, `预置商品 ${target} 应当有规格 ${ON_SHELF_SPEC}`);
  assert.notEqual(original.price, 1000, "这条规格原本不是 10 元，改动才有意义");

  const withPrice = (priceYuan) =>
    before.specs.map((item) =>
      item.id === ON_SHELF_SPEC ? { ...toSpecInput(item), priceYuan } : toSpecInput(item),
    );

  const saved = await updateAdminProduct(target, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(target, { specs: withPrice("10") })),
  });
  assert.equal(saved.changed, true);

  const after = await getAdminProductDetail(target, undefined, "server");
  const edited = after.specs.find((item) => item.id === ON_SHELF_SPEC);
  assert.equal(edited.price, 1000, "编辑：10 元应当落成 1000 分");
  // 身份不变：订单快照里记的就是这个 id，改价不能把它换成另一条
  assert.deepEqual(
    after.specs.map((item) => item.id),
    before.specs.map((item) => item.id),
  );
  assert.equal(after.specCount, before.specCount, "改价不新增也不删除规格");
  // 只有被改的那一条价格变了，其余规格逐条未动（三个规格价格互不相同，
  // 因此不能按「还有几条是原价」来数，必须按 id 逐条对）
  for (const item of before.specs) {
    const now = after.specs.find((row) => row.id === item.id);
    assert.equal(
      now.price,
      item.id === ON_SHELF_SPEC ? 1000 : item.price,
      `规格 ${item.id} 的价格变化不符合预期`,
    );
  }
  assert.equal(original.price, ON_SHELF_PRICE);

  // 编辑路径上的非法金额同样 400，且不改动已存的值
  await expectApiError(
    updateAdminProduct(target, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...(await productBodyFrom(target, { specs: withPrice("1.005") })),
    }),
    "BAD_REQUEST",
    SPEC_PRICE_INVALID_MESSAGE,
  );
  const untouched = await getAdminProductDetail(target, undefined, "server");
  assert.equal(untouched.specs.find((item) => item.id === ON_SHELF_SPEC).price, 1000);
});

test("有效规格名不能重复；停用或已移除的规格可以重名", () => {
  // 重名是**逐行**错误：页面要能把 `aria-invalid` 落到具体那一行的输入框上，
  // 而整组错误只说得出「规格这一组有问题」。重复出现的每一行都要标出来。
  const duplicated = productSpecErrors([
    spec({ name: "档位" }),
    spec({ name: "档位", sortOrder: 20 }),
  ]);
  assert.equal(duplicated.rows[0].name, SPEC_NAME_DUPLICATE_MESSAGE);
  assert.equal(duplicated.rows[1].name, SPEC_NAME_DUPLICATE_MESSAGE);
  assert.equal(duplicated.group, null, "它不该同时被当成整组错误——那是另一类问题");

  // 一条停用或已移除的规格不在可选集合里，留着同名的名字是安全的：
  // 强行要求改名会让「先停用、回头再启用」这条正常操作走不通
  for (const [label, overrides] of [
    ["停用", { enabled: false }],
    ["已移除", { removed: true }],
  ]) {
    const result = productSpecErrors([spec({ name: "档位" }), spec({ name: "档位", ...overrides })]);
    assert.equal(result.rows[0].name, null, `一条${label}的同名规格不该让在用的那一行报错`);
    assert.equal(result.rows[1].name, null, `${label}的规格自己也不报重名`);
  }

  // 接口层：同名有效规格被拒
  return expectApiError(
    createProduct({ specs: [spec({ name: "同一档" }), spec({ name: "同一档", sortOrder: 20 })] }),
    "BAD_REQUEST",
    SPEC_NAME_DUPLICATE_MESSAGE,
  );
});

test("规格排序必须是区间内的整数，缺省（NaN）也报错而不是当成 0", async () => {
  await expectApiError(
    createProduct({ specs: [spec({ sortOrder: Number.NaN })] }),
    "BAD_REQUEST",
    SPEC_SORT_ORDER_INVALID_MESSAGE,
  );

  await expectApiError(
    createProduct({ specs: [spec({ sortOrder: -1 })] }),
    "BAD_REQUEST",
    SPEC_SORT_ORDER_INVALID_MESSAGE,
  );
});

test("规格身份是 id：改价、改名、排序都不换 id，订单快照里的那个 id 始终指得回同一条", async () => {
  const created = await createProduct({
    title: "改价不换 id",
    specs: [
      spec({ name: "一小时", priceYuan: "19.90", sortOrder: 10 }),
      spec({ name: "两小时", priceYuan: "35.50", sortOrder: 20 }),
    ],
  });

  const before = await getAdminProductDetail(created.productId, undefined, "server");
  const ids = before.specs.map((item) => item.id).sort();

  // 改价 + 改名 + 调排序，并把两行的顺序倒过来提交：
  // id 一个都不该变（数组顺序在这里没有含义，展示顺序由 sortOrder 决定）
  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId)),
    specs: [
      { id: before.specs[1].id, name: "两小时（调价）", priceYuan: "39.90", sortOrder: 5, enabled: true, removed: false },
      { id: before.specs[0].id, name: "一小时", priceYuan: "19.90", sortOrder: 8, enabled: true, removed: false },
    ],
  });

  const after = await getAdminProductDetail(created.productId, undefined, "server");
  assert.deepEqual(after.specs.map((item) => item.id).sort(), ids);
  assert.deepEqual(
    after.specs.map((item) => [item.name, item.price, item.sortOrder]).sort(),
    [
      ["一小时", 1990, 8],
      ["两小时（调价）", 3990, 5],
    ],
  );

  // 陌生 id 被拒：把一个手误的 id 当成新规格收下，会悄悄多出一条重复规格
  await expectApiError(
    updateAdminProduct(created.productId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...(await productBodyFrom(created.productId)),
      specs: [{ id: "sp_nope", name: "陌生", priceYuan: "1.00", sortOrder: 1, enabled: true, removed: false }],
    }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_UNKNOWN_SPEC_MESSAGE,
  );

  // 同一个 id 出现两次同样被拒
  await expectApiError(
    updateAdminProduct(created.productId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...(await productBodyFrom(created.productId)),
      specs: [
        { id: ids[0], name: "甲", priceYuan: "1.00", sortOrder: 1, enabled: true, removed: false },
        { id: ids[0], name: "乙", priceYuan: "2.00", sortOrder: 2, enabled: true, removed: false },
      ],
    }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_DUPLICATE_SPEC_ID_MESSAGE,
  );
});

test("上架商品不能失去最后一个有效规格：改资料与上架两条路径都拦", async () => {
  // ① 保存一份会把有效规格清零的资料
  await expectApiError(
    updateAdminProduct(ON_SHELF, ADMIN_ID, {
      ...(await productBodyFrom(ON_SHELF, {
        specs: (await getAdminProductDetail(ON_SHELF, undefined, "server")).specs.map((item) =>
          spec({
            id: item.id,
            name: item.name,
            priceYuan: formatPriceFenForInput(item.price),
            sortOrder: item.sortOrder,
            enabled: false,
          }),
        ),
      })),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
    PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  );

  // 被拒绝的保存没有改坏任何东西
  const untouched = await getAdminProductDetail(ON_SHELF, undefined, "server");
  assert.equal(untouched.status, "on");
  assert.equal(untouched.effectiveSpecCount, 3);

  // ② 下架之后把最后一个规格停用是合法的（下架商品允许没有有效规格），
  //    但这时再想上架就必须先补一条
  const created = await createProduct({
    title: "最后规格保护",
    specs: [spec({ name: "唯一档", priceYuan: "1.00" })],
  });
  await setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() });

  const single = (await getAdminProductDetail(created.productId, undefined, "server")).specs[0];
  await setAdminProductStatus(created.productId, "off", ADMIN_ID, { idempotencyKey: uniqueKey() });
  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId, { status: "off" })),
    specs: [
      {
        id: single.id,
        name: "唯一档",
        priceYuan: "1.00",
        sortOrder: 10,
        enabled: false,
        removed: false,
      },
    ],
  });
  assert.equal(
    (await getAdminProductDetail(created.productId, undefined, "server")).effectiveSpecCount,
    0,
  );

  await expectApiError(
    setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    PRODUCT_NO_EFFECTIVE_SPEC_MESSAGE,
  );

  // 已下架商品允许没有有效规格，因此「保存它」本身不该被拦
  assert.equal(
    (
      await updateAdminProduct(created.productId, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        ...(await productBodyFrom(created.productId, {
          status: "off",
          subtitle: "已下架待补规格",
        })),
      })
    ).changed,
    true,
  );
});

test("已移除的规格保留原始移除时间，重复保存不刷新它", async () => {
  const created = await createProduct({
    title: "移除时间",
    specs: [
      spec({ name: "保留", priceYuan: "1.00", sortOrder: 10 }),
      spec({ name: "待移除", priceYuan: "2.00", sortOrder: 20 }),
    ],
  });

  const before = await getAdminProductDetail(created.productId, undefined, "server");
  const victim = before.specs.find((item) => item.name === "待移除");

  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId)),
    specs: before.specs.map((item) => ({
      id: item.id,
      name: item.name,
      priceYuan: formatPriceFenForInput(item.price),
      sortOrder: item.sortOrder,
      enabled: item.enabled,
      removed: item.id === victim.id,
    })),
  });

  const removedAt = (await getAdminProductDetail(created.productId, undefined, "server")).specs
    .find((item) => item.id === victim.id).removedAt;
  assert.notEqual(removedAt, null);

  // 再保存一次（改个副标题），已移除的规格不该被刷新成一个更晚的时间
  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId, { subtitle: "再来一次" })),
  });

  const after = await getAdminProductDetail(created.productId, undefined, "server");
  assert.equal(after.specs.find((item) => item.id === victim.id).removedAt, removedAt);
  assert.equal(after.effectiveSpecCount, 1, "已移除的规格不计入有效规格");
  assert.equal(after.specCount, 2, "但它仍然在记录里（订单快照里记着它的 id）");
});

// ——————————————————————————— 上下架 ———————————————————————————

test("上下架：状态变化记 product.publish / product.unpublish，重复操作不写第二条审计", async () => {
  const created = await createProduct({
    title: "上下架测试",
    status: "off",
    specs: [spec({ name: "档位", priceYuan: "9.90" })],
  });

  const published = await setAdminProductStatus(created.productId, "on", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(published.changed, true);
  assert.equal(published.status, "on");

  // 重复上架：状态没变，不写数据也不写审计，而且**不是错误**
  const again = await setAdminProductStatus(created.productId, "on", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(again.changed, false);
  assert.equal(again.status, "on");

  const unpublished = await setAdminProductStatus(created.productId, "off", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(unpublished.status, "off");

  assert.deepEqual(
    (await auditsFor(created.productId)).map((entry) => entry.action),
    ["product.create", "product.publish", "product.unpublish"],
  );

  // 窄写入只改状态：标题与规格一个都没动
  const detail = await getAdminProductDetail(created.productId, undefined, "server");
  assert.equal(detail.title, "上下架测试");
  assert.equal(detail.effectiveSpecCount, 1);
});

test("编辑时一并改上下架状态：审计记的是状态变化，不是「编辑商品」", async () => {
  const created = await createProduct({ title: "保存并下架", status: "on" });

  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId, { status: "off" })),
  });

  assert.deepEqual(
    (await auditsFor(created.productId)).map((entry) => entry.action),
    ["product.create", "product.unpublish"],
  );

  // 状态没变但改了别的字段 → 这才是 product.update
  await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId, { title: "保存并下架（改名）" })),
  });
  assert.deepEqual(
    (await auditsFor(created.productId)).map((entry) => entry.action),
    ["product.create", "product.unpublish", "product.update"],
  );

  // 什么都没改 → 不写数据、不写审计
  const noop = await updateAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(created.productId)),
  });
  assert.equal(noop.changed, false);
  assert.equal((await auditsFor(created.productId)).length, 3);
});

// ——————————————————————— 软删除与用户端 ———————————————————————

test("移除商品：用户端直链 404，后台仍可查、可以筛、但不能再编辑或上下架", async () => {
  const created = await createProduct({ title: "待移除商品", status: "on" });

  const result = await removeAdminProduct(created.productId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true);
  assert.notEqual(result.removedAt, null);

  // 用户端：列表里没有、直链也是 404（与「已下架」不同，已下架的直链是能打开的）
  assert.equal(await getProductDetail(created.productId, undefined, "server"), null);
  assert.equal(await getCatalogRepository().findProductById(created.productId), null);
  const publicList = await adminProducts({ removal: "removed", pageSize: 50 });
  assert.equal(
    publicList.items.some((item) => item.id === created.productId),
    true,
  );

  // 后台：默认视图里没有它，已移除视图里有，详情照常打开
  assert.equal(
    (await adminProducts({ pageSize: 50 })).items.some((item) => item.id === created.productId),
    false,
  );
  const detail = await getAdminProductDetail(created.productId, undefined, "server");
  assert.equal(detail.id, created.productId);
  assert.deepEqual(adminProductStatus(detail), {
    key: "removed",
    label: "已移除",
    description: "用户端不可见（直链也是 404），历史订单保留",
  });

  // 不能再编辑、不能再上下架
  await expectApiError(
    updateAdminProduct(created.productId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...(await productBodyFrom(created.productId)),
      title: "改名试试",
    }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_REMOVED_MESSAGE,
  );
  await expectApiError(
    setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_REMOVED_MESSAGE,
  );

  // 移除是幂等的：不刷新时间戳，也不多写一条审计
  const stamp = detail.removedAt;
  assert.equal(
    (
      await removeAdminProduct(created.productId, ADMIN_ID, { idempotencyKey: uniqueKey() })
    ).changed,
    false,
  );
  assert.equal(
    (await getAdminProductDetail(created.productId, undefined, "server")).removedAt,
    stamp,
  );
  // 新建时就直接上架，只记一条 `product.create`：那次提交就是「建了它」，
  // 而不是「建了它、又单独上架了一次」——审计记的是发生过的操作，不是状态的迁移次数
  assert.deepEqual(
    (await auditsFor(created.productId)).map((entry) => entry.action),
    ["product.create", "product.remove"],
  );

  // 记录**没有**被物理删除：它是软删除，历史订单与收藏还要指得到它
  assert.ok(await getCatalogRepository().findProductForAdmin(created.productId));
});

test("下架商品的直链继续显示「已下架」：重新上架再下架之后也还是它", async () => {
  // 预置的已下架商品
  const seeded = await getProductDetail(OFF_SHELF, undefined, "server");
  assert.ok(seeded, "下架商品的直链不能是 404");
  assert.equal(seeded.status, "off");

  // 页面能打开，但**买不了**：服务端拒绝，不依赖前端按钮置灰
  await expectApiError(
    previewCheckout(
      {
        productId: OFF_SHELF,
        specId: OFF_SHELF_SPEC,
        quantity: 1,
        region: "手游",
        addonIds: [],
        gameAccountId: "moyu_test",
        remark: "",
        companionId: null,
      },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    "商品已下架，无法支付",
  );

  // 后台把它上架，再下架：直链回到「已下架」，而不是 404
  await setAdminProductStatus(OFF_SHELF, "on", ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal((await getProductDetail(OFF_SHELF, undefined, "server")).status, "on");

  await setAdminProductStatus(OFF_SHELF, "off", ADMIN_ID, { idempotencyKey: uniqueKey() });
  const back = await getProductDetail(OFF_SHELF, undefined, "server");
  assert.ok(back);
  assert.equal(back.status, "off");

  // 下架的与不存在的仍然是两种结果
  assert.equal(await getProductDetail("p-nope", undefined, "server"), null);
});

test("不存在的商品：详情返回 null（页面转 404），写操作 404", async () => {
  assert.equal(await getAdminProductDetail("p-nope", undefined, "server"), null);
  assert.equal(await getAdminProductDetail("", undefined, "server"), null);

  await expectApiError(
    updateAdminProduct("p-nope", ADMIN_ID, { idempotencyKey: uniqueKey(), ...productInput() }),
    "NOT_FOUND",
    ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    setAdminProductStatus("p-nope", "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    removeAdminProduct("p-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_PRODUCT_NOT_FOUND_MESSAGE,
  );
});

// ——————————————————————— 改价与历史订单 ———————————————————————

test("改价只影响之后的试算与支付，历史订单读的是下单那一刻的快照", async () => {
  const selection = {
    productId: ON_SHELF,
    specId: ON_SHELF_SPEC,
    quantity: 1,
    region: "手游",
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
  };

  // ① 先按原价下单并支付成功
  const { request } = await createPaymentRequest(
    { idempotencyKey: uniqueKey(), ...selection },
    USER,
  );
  const confirmed = await confirmPaymentRequest(request.id, "success", USER);
  assert.equal(confirmed.ok, true);
  const order = confirmed.order;
  assert.ok(order, "支付成功应当生成订单");
  assert.equal(order.unitPrice, ON_SHELF_PRICE);
  assert.equal(order.totalAmount, ON_SHELF_PRICE);

  // ② 后台改价
  const detail = await getAdminProductDetail(ON_SHELF, undefined, "server");
  await updateAdminProduct(ON_SHELF, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...(await productBodyFrom(ON_SHELF)),
    specs: detail.specs.map((item) => ({
      id: item.id,
      name: item.name,
      priceYuan:
        item.id === ON_SHELF_SPEC ? "39.90" : formatPriceFenForInput(item.price),
      sortOrder: item.sortOrder,
      enabled: item.enabled,
      removed: item.removedAt !== null,
    })),
  });

  // ③ 之后的试算用新价
  const preview = await previewCheckout(selection, undefined, "server");
  assert.equal(preview.spec.price, 3990);
  assert.equal(preview.totalAmount, 3990);

  // ④ 历史订单一点都没变：它读的是快照，不是商品当前值
  const persisted = await getOrderForUser(order.id, USER);
  assert.equal(persisted.unitPrice, ON_SHELF_PRICE);
  assert.equal(persisted.totalAmount, ON_SHELF_PRICE);
  assert.equal(persisted.specName, order.specName);
  assert.equal(persisted.productTitle, detail.title);
});

test("改图、改名、下架之后，历史订单的展示信息仍然是下单那一刻的抄本", async () => {
  const order = (
    await confirmPaymentRequest(
      (
        await createPaymentRequest(
          {
            idempotencyKey: uniqueKey(),
            productId: ON_SHELF,
            specId: ON_SHELF_SPEC,
            quantity: 1,
            region: "手游",
            addonIds: [],
            gameAccountId: "moyu_test",
            remark: "",
            companionId: null,
          },
          USER,
        )
      ).request.id,
      "success",
      USER,
    )
  ).order;

  const body = await productBodyFrom(ON_SHELF);
  await updateAdminProduct(ON_SHELF, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...body,
    title: "机密400万（改名）",
    coverUrl: PRODUCT_COVER_OPTIONS[1],
    status: "off",
  });

  const persisted = await getOrderForUser(order.id, USER);
  assert.equal(persisted.productTitle, order.productTitle);
  assert.equal(persisted.productCoverUrl, order.productCoverUrl);
  assert.notEqual(persisted.productTitle, "机密400万（改名）");

  // 用户端已经看不到它了（下架），但订单还是完整的
  assert.equal(
    (await getProductDetail(ON_SHELF, undefined, "server")).status,
    "off",
  );
});

// ——————————————————————————— 幂等与并发 ———————————————————————————

test("幂等：同一个键重复到达只建一条、只写一条审计，返回的是第一次的结果", async () => {
  const key = uniqueKey();
  const first = await createProduct({ title: "幂等商品" }, key);
  const second = await createProduct({ title: "幂等商品（第二次的名字不一样）" }, key);

  assert.equal(second.productId, first.productId);
  assert.equal(second.changed, false);
  assert.equal(
    (await getAdminProductDetail(first.productId, undefined, "server")).title,
    "幂等商品",
    "重放不该按新请求体改写已经建好的记录",
  );

  assert.equal((await adminProducts({ keyword: "幂等商品" })).total, 1);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 1);
});

test("幂等键被别的对象或别的操作用过：报冲突而不是安静重放", async () => {
  const key = uniqueKey();
  await setAdminProductStatus(OFF_SHELF, "on", ADMIN_ID, { idempotencyKey: key });

  await expectApiError(
    setAdminProductStatus(ON_SHELF, "off", ADMIN_ID, { idempotencyKey: key }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE,
  );
  await expectApiError(
    updateAdminProduct(ON_SHELF, ADMIN_ID, {
      idempotencyKey: key,
      ...productInput({ title: "换一个操作" }),
    }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE,
  );
  await expectApiError(
    removeAdminProduct(ON_SHELF, ADMIN_ID, { idempotencyKey: key }),
    "BAD_REQUEST",
    ADMIN_PRODUCT_OPERATION_CONFLICT_MESSAGE,
  );

  // 冲突没有产生任何副作用
  assert.equal(
    (await getAdminProductDetail(ON_SHELF, undefined, "server")).title,
    "机密400万",
  );
  assert.equal((await auditsFor(ON_SHELF)).length, 0);
});

test("幂等键非法或缺失：400，且任何数据都没被写", async () => {
  for (const value of [undefined, "", "short", "有中文的键", "x".repeat(65)]) {
    const body = { ...productInput({ title: "非法键" }) };
    if (value !== undefined) body.idempotencyKey = value;
    await expectApiError(
      createAdminProduct(ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_PRODUCT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }

  assert.equal((await adminProducts({ keyword: "非法键" })).total, 0);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 0);
});

test("并发：同一次意图的两个请求（同一个键）不会建出两条", async () => {
  const key = uniqueKey();
  const [a, b] = await Promise.all([
    createProduct({ title: "并发幂等" }, key),
    createProduct({ title: "并发幂等" }, key),
  ]);

  assert.equal(a.productId, b.productId);
  assert.equal((await adminProducts({ keyword: "并发幂等" })).total, 1);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 1);
});

test("并发：两次不同的上架请求不会写出两条审计，也不会让状态对不上", async () => {
  const created = await createProduct({ title: "并发上架", status: "off" });
  const results = await Promise.allSettled([
    setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    setAdminProductStatus(created.productId, "on", ADMIN_ID, { idempotencyKey: uniqueKey() }),
  ]);

  assert.equal(results.every((item) => item.status === "fulfilled"), true);
  const changed = results.filter((item) => item.value.changed);
  assert.equal(changed.length, 1, "只有一次是真实的变更，另一次看到状态已经是 on 了");
  assert.equal(
    (await getAdminProductDetail(created.productId, undefined, "server")).status,
    "on",
  );
  assert.deepEqual(
    (await auditsFor(created.productId)).map((entry) => entry.action),
    ["product.create", "product.publish"],
  );
});

// ——————————————————— 字段级错误与「第一条错误」 ———————————————————

test("字段级错误逐项给出，且「第一条」按页面上的字段顺序取", async () => {
  const options = await getAdminProductFormOptions();
  const context = {
    games: options.games,
    categories: options.categories,
    currentCoverUrl: "",
    currentDetailImages: [],
  };

  const errors = productProfileFieldErrors(
    {
      ...productInput({
        gameId: "g-nope",
        categoryId: "c-nope",
        title: "",
        coverUrl: "https://example.com/a.png",
        sortOrder: Number.NaN,
      }),
    },
    context,
  );

  // 每个字段拿到的是**自己那一条**，而不是一句笼统的「资料有问题」：
  // 页面据此把 `aria-invalid` / `aria-describedby` 落到具体输入框上
  assert.equal(errors.gameId, PRODUCT_GAME_INVALID_MESSAGE);
  assert.equal(errors.categoryId, PRODUCT_CATEGORY_INVALID_MESSAGE);
  assert.equal(errors.title, PRODUCT_TITLE_EMPTY_MESSAGE);
  assert.equal(errors.coverUrl, PRODUCT_COVER_INVALID_MESSAGE);
  assert.equal(errors.sortOrder, PRODUCT_SORT_ORDER_INVALID_MESSAGE);
  assert.equal(errors.subtitle, null, "没填错的字段不带错误");

  // 首错聚焦：顺序就是页面上的字段顺序（最靠上的那条先被聚焦）
  assert.equal(firstProductProfileErrorField(errors), "gameId");

  // 把靠上的字段逐个修好，第一个错误就往下走
  assert.equal(
    firstProductProfileErrorField(productProfileFieldErrors({ ...productInput({ title: "" }) }, context)),
    "title",
  );
  assert.equal(
    firstProductProfileErrorField(
      productProfileFieldErrors({ ...productInput({ coverUrl: "https://example.com/a.png" }) }, context),
    ),
    "coverUrl",
  );
  // 全部合法时没有「第一条错误」——页面据此允许提交
  assert.equal(
    firstProductProfileErrorField(productProfileFieldErrors(productInput(), context)),
    null,
  );
});

// ——————————————————————————— 表单选项 ———————————————————————————

test("表单选项来自真实目录：图片只给白名单，类目带归属与可用性", async () => {
  const options = await getAdminProductFormOptions();

  assert.deepEqual(options.coverOptions, [...PRODUCT_COVER_OPTIONS]);
  for (const url of options.coverOptions) {
    assert.equal(url.startsWith("/mock/"), true, "只给 public/mock 下的本地占位图");
  }
  assert.equal(options.detailImageOptions.length, PRODUCT_COVER_OPTIONS.length + 3);

  // 游戏选项与用户端读的是同一份目录
  const games = await getGames();
  assert.deepEqual(
    options.games.map((item) => item.id),
    games.map((item) => item.id),
  );

  // 类目选项含停用与已移除：否则带着一个已停用类目打开列表页，
  // 筛选器会显示「全部类目」却只列出几条商品
  assert.equal(options.categories.some((item) => item.removedAt !== null), false);
  assert.equal(
    options.categories.every((item) => typeof item.gameId === "string" && "enabled" in item),
    true,
  );
});

// ——————————————————————————— 真实服务（HTTP） ———————————————————————————

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
 * 五条商品写接口。请求体**故意不带幂等键**，理由与 P8A 的权限矩阵一致：
 * 被拒身份拿到 401 / 403、管理者拿到「幂等键缺失」的 400，这本身就证明
 * `requireAdmin()` 排在解析入参之前；而这一轮用例一个字节都不写。
 */
/**
 * 服务端详情 → 完整的商品写请求体（编辑接口收的是整份资料，不是增量）。
 *
 * ⚠️ 这里**必须**用 `priceYuan` 传价格：界面发给服务端的就是这个键。
 * 之前这份用例是手工拼的、恰好拼对了，而真实表单拼的是 `price`（分），
 * 于是「单测全绿、人工验收一填 10 元就报错」。现在这条路径由共享函数固定下来。
 */
async function httpProductBodyFrom(id, cookie, overrides = {}) {
  const detail = JSON.parse((await requestWithCookie(`/api/admin/products/${id}`, cookie)).body).data;

  return {
    gameId: detail.gameId,
    categoryId: detail.categoryId ?? "",
    title: detail.title,
    subtitle: detail.subtitle,
    coverUrl: detail.coverUrl,
    tags: [...detail.tags],
    detailText: detail.detailText,
    detailImages: [...detail.detailImages],
    sortOrder: detail.sortOrder,
    recommended: detail.recommended,
    status: detail.status,
    specs: detail.specs.map(toSpecInput),
    ...overrides,
  };
}

function writeCases() {
  const body = JSON.stringify({});
  return [
    ["POST", "/api/admin/products", body],
    ["PATCH", `/api/admin/products/${OFF_SHELF}`, body],
    ["POST", `/api/admin/products/${OFF_SHELF}/publish`, body],
    ["POST", `/api/admin/products/${OFF_SHELF}/unpublish`, body],
    ["POST", `/api/admin/products/${OFF_SHELF}/remove`, body],
  ];
}

test("商品接口权限矩阵：匿名 401，客服 / 护航 / 停用管理员 403，管理者走到业务校验", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  const adminCookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  const readPaths = ["/api/admin/products", `/api/admin/products/${OFF_SHELF}`];
  const writes = writeCases();

  // ① 匿名：读与写都是 401
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
    // 开关关闭：`getSessionAdmin()` 一律返回 null，这几种身份连「有会话但没权限」都不存在，
    // 全部按未登录处理（401）。这是设计如此，不是漏判。
    for (const id of ["admin-2", "admin-3", "admin-4"]) {
      assert.equal((await requestWithCookie(readPaths[0], `mock_admin_id=${id}`)).status, 401);
    }
    return;
  }

  // ③ 有会话但没权限：客服、护航、被停用的管理员
  const messages = new Set();
  for (const id of ["admin-2", "admin-3", "admin-4"]) {
    for (const pathname of readPaths) {
      const { status, body } = await requestWithCookie(pathname, `mock_admin_id=${id}`);
      assert.equal(status, 403, `无权身份不该读 ${pathname}`);
      assert.ok(body.includes("FORBIDDEN"));
      messages.add(JSON.parse(body).error.message);
    }
    for (const [method, pathname, body] of writes) {
      const result = await sendWithCookie(method, pathname, body, `mock_admin_id=${id}`);
      assert.equal(result.status, 403, `无权身份不该写 ${pathname}`);
      messages.add(JSON.parse(result.body).error.message);
    }
  }
  // 三种被拒身份 + 读与写，错误文本完全一致：不区分「角色不对」与「账号被停用」，
  // 也不区分「对象不存在」与「无权访问」——那等于给出一个可以探测账号状态的接口
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

  // 不存在的对象：对管理者是 404，对被拒身份仍然是 403（连「存不存在」都不回答）
  assert.equal((await requestWithCookie("/api/admin/products/p-nope", adminCookie)).status, 404);
  assert.equal(
    (await requestWithCookie("/api/admin/products/p-nope", "mock_admin_id=admin-2")).status,
    403,
  );

  // 非法筛选值：接口是严格模式
  assert.equal(
    (await requestWithCookie("/api/admin/products?status=maybe", adminCookie)).status,
    400,
  );
  assert.equal(
    (await requestWithCookie("/api/admin/products?gameId=g-nope", adminCookie)).status,
    400,
  );
});

test("商品接口端到端：改完标题后用户端读到的就是新标题，提交里带的是元文本而不是分", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];

  const original = JSON.parse(
    (await requestWithCookie(`/api/admin/products/${ON_SHELF}`, adminCookie)).body,
  ).data;
  const suffix = "（改名）";
  const nextTitle = original.title.endsWith(suffix)
    ? original.title.slice(0, -suffix.length)
    : `${original.title}${suffix}`;

  const saved = await sendWithCookie(
    "PATCH",
    `/api/admin/products/${ON_SHELF}`,
    JSON.stringify({
      idempotencyKey: `p8b-http-product-${Date.now()}`,
      ...(await httpProductBodyFrom(ON_SHELF, adminCookie, { title: nextTitle })),
      // 伪造统计字段：请求体里有，但服务端没有读取它的位置
      monthlySales: 99999,
      gameTag: "伪造",
    }),
    adminCookie,
  );
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).data.changed, true);

  // 用户端读的是同一份数据：列表里的标题就是新标题
  const publicList = await requestWithCookie(
    `/api/catalog/products?gameId=${original.gameId}&categoryId=${original.categoryId}&pageSize=50`,
    null,
  );
  assert.equal(publicList.status, 200);
  const listed = JSON.parse(publicList.body).data.items.find((item) => item.id === ON_SHELF);
  assert.equal(listed.title, nextTitle);

  // 统计字段没有被伪造的值污染
  const afterDetail = JSON.parse(
    (await requestWithCookie(`/api/admin/products/${ON_SHELF}`, adminCookie)).body,
  ).data;
  assert.equal(afterDetail.monthlySales, original.monthlySales);
  assert.equal(afterDetail.gameTag, original.gameTag);

  // 改回去，让这轮用例对服务端状态保持无副作用
  const restored = await sendWithCookie(
    "PATCH",
    `/api/admin/products/${ON_SHELF}`,
    JSON.stringify({
      idempotencyKey: `p8b-http-product-restore-${Date.now()}`,
      ...(await httpProductBodyFrom(ON_SHELF, adminCookie, { title: original.title })),
    }),
    adminCookie,
  );
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).data.changed, true);
});

test("商品直链在 HTTP 层的表现：已下架 200 且页面标注已下架，已移除 404", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();

  // 已下架：直链打开的是商品页（不是 404），页面文案里有「已下架」
  const offShelf = await requestWithCookie(`/product/${OFF_SHELF}`, null);
  assert.equal(offShelf.status, 200);
  assert.ok(offShelf.body.includes("已下架"), "下架商品直链要明确说明「已下架」");

  // 已移除（由管理员移除之后）：用户端直链 404
  if (login.status === 200) {
    const adminCookie = login.setCookie[0].split(";")[0];
    const detail = JSON.parse(
      (await requestWithCookie(`/api/admin/products/${BROKEN_IMAGE}`, adminCookie)).body,
    ).data;
    // 只在这条商品还在「使用中」时动手，避免重复跑时把状态改坏
    if (detail.removedAt === null) {
      const removed = await sendWithCookie(
        "POST",
        `/api/admin/products/${BROKEN_IMAGE}/remove`,
        JSON.stringify({ idempotencyKey: `p8b-http-remove-${Date.now()}` }),
        adminCookie,
      );
      assert.equal(removed.status, 200);
      assert.equal((await requestWithCookie(`/product/${BROKEN_IMAGE}`, null)).status, 404);

      // 后台仍然查得到它（软删除不是「记录消失」）
      assert.equal(
        (await requestWithCookie(`/api/admin/products/${BROKEN_IMAGE}`, adminCookie)).status,
        200,
      );
    }
  }
});

test("ENABLE_MOCK_ADMIN=false 时商品接口完全关闭：登录 404，伪造 Cookie 无效", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status === 200) return; // 本次跑的服务开着开关，由「关掉开关再跑一次」覆盖

  assert.equal(login.status, 404);
  assert.equal(login.setCookie.length, 0);

  for (const pathname of ["/api/admin/products", `/api/admin/products/${OFF_SHELF}`]) {
    assert.equal((await requestWithCookie(pathname, "mock_admin_id=admin-1")).status, 401);
  }
  for (const [method, pathname, body] of writeCases()) {
    assert.equal(
      (await sendWithCookie(method, pathname, body, "mock_admin_id=admin-1")).status,
      401,
    );
  }

  // 用户端完全不受影响
  assert.equal(
    (await requestWithCookie(`/api/catalog/products?gameId=${GAME_DELTA}`, null)).status,
    200,
  );
  assert.equal((await requestWithCookie(`/product/${OFF_SHELF}`, null)).status, 200);
});

// ————————————————— 单价 10 元：人工验收发现的阻塞缺陷 —————————————————

/** 起一个模拟用户会话，返回 Cookie。 */
async function mockUserLogin(userId) {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const setCookie = response.headers.getSetCookie();
  return response.status === 200 && setCookie.length > 0 ? setCookie[0].split(";")[0] : null;
}

/**
 * 建一件商品，价格由调用方给，**请求体走真实的表单产物形状**。
 *
 * 与人工验收的路径一致：`normalizeProductProfilePatch()` 出来什么就发什么。
 */
async function postProductFromForm(adminCookie, priceYuan, stamp, status = "on") {
  const options = await getAdminProductFormOptions();
  const wire = normalizeProductProfilePatch(
    productInput({
      title: `十元商品 ${stamp}`,
      status,
      specs: [spec({ name: "标准档", priceYuan })],
    }),
    {
      games: options.games,
      categories: options.categories,
      currentCoverUrl: "",
      currentDetailImages: [],
    },
  );
  assert.ok(wire, `表单产物必须合法：${priceYuan}`);

  const response = await sendWithCookie(
    "POST",
    "/api/admin/products",
    JSON.stringify({ idempotencyKey: `p8b-http-ten-${stamp}-${priceYuan}`, ...wire }),
    adminCookie,
  );
  return { response, wire };
}

test("单价 10 元的 HTTP 全链路：建得出来、读得到 1000 分、展示两位小数", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];
  const stamp = Date.now();

  // 请求体就是表单归一化后的产物：规格行带的是 priceYuan 元文本。
  // 人工验收正是在这一步填了 `10` 却被判成非法，商品建不出来。
  const { response: created } = await postProductFromForm(adminCookie, "10", stamp);

  // ① 管理端新建一件单价 10 元的单规格商品：成功
  assert.equal(created.status, 200, created.body);
  const productId = JSON.parse(created.body).data.productId;
  assert.match(productId, /^p_/, "后台新建的 id 与预置数据分处两个取值域");

  const adminDetail = async () =>
    JSON.parse((await requestWithCookie(`/api/admin/products/${productId}`, adminCookie)).body).data;

  const detail = await adminDetail();
  // ② 读到的就是整数 1000 分（这一层读的是目录仓储）
  assert.equal(detail.specs.length, 1);
  assert.equal(detail.specs[0].price, 1000, "10 元必须落成 1000 分");
  assert.equal(Number.isInteger(detail.specs[0].price), true);
  // ③ 后台按两位小数展示（表单回填用的就是这个函数）
  assert.equal(formatPriceFenForInput(detail.specs[0].price), "10.00");

  // ④ 用户端商品详情页显示 10.00
  const userPage = await requestWithCookie(`/product/${productId}`, null);
  assert.equal(userPage.status, 200);
  assert.ok(userPage.body.includes("10.00"), "用户端详情页要显示 10.00");
  assert.ok(userPage.body.includes("十元商品"), "用户端详情页显示的是这件商品");

  // ⑥ 编辑既有规格：先改成 20 元、再改回 10 元，两次都成功且**规格 id 不变**
  const specId = detail.specs[0].id;
  const specRow = (priceYuan) => ({ ...toSpecInput(detail.specs[0]), priceYuan });

  for (const [priceYuan, fen] of [
    ["20", 2000],
    ["10", 1000],
  ]) {
    const saved = await sendWithCookie(
      "PATCH",
      `/api/admin/products/${productId}`,
      JSON.stringify({
        idempotencyKey: `p8b-http-edit-${stamp}-${priceYuan}`,
        ...(await httpProductBodyFrom(productId, adminCookie, { specs: [specRow(priceYuan)] })),
      }),
      adminCookie,
    );
    assert.equal(saved.status, 200, saved.body);
    assert.equal(JSON.parse(saved.body).data.changed, true);

    const after = await adminDetail();
    assert.equal(after.specs.length, 1);
    assert.equal(after.specs[0].id, specId, "改价不能把规格换成另一条");
    assert.equal(after.specs[0].price, fen, `改成 ${priceYuan} 元应当落成 ${fen} 分`);
  }

  // ⑦ 匿名与普通用户仍然调不动管理接口
  for (const cookie of [null, "mock_user_id=u-1001", "mock_admin_id=admin-2"]) {
    const read = await requestWithCookie("/api/admin/products", cookie);
    assert.ok([401, 403].includes(read.status), `期望 401/403，实际 ${read.status}`);
    const write = await sendWithCookie(
      "POST",
      "/api/admin/products",
      JSON.stringify({ idempotencyKey: `p8b-http-denied-${stamp}` }),
      cookie,
    );
    assert.ok([401, 403].includes(write.status), `期望 401/403，实际 ${write.status}`);
  }

  // ⑧ 非法单价仍然 400，且什么也没写进去
  //
  // 这里**绕过界面**直接发原始请求体：界面的校验只是「提前告诉用户」，
  // 服务端才是最终权威。一个不经过表单的调用方（将来的真实客户端、脚本、
  // 或者被人改过的页面）同样必须被挡住。
  for (const bad of ["1.005", "1e3", "0", "-1", "100000"]) {
    const rejected = await sendWithCookie(
      "POST",
      "/api/admin/products",
      JSON.stringify({
        // 幂等键只收 [A-Za-z0-9_-]，非法单价里的 `.` 与 `-` 要换掉，
        // 否则请求会先倒在「幂等键非法」上，测不到单价那一条
        idempotencyKey: `p8b-http-bad-${stamp}-${bad.replace(/[^A-Za-z0-9]/g, "x")}`,
        ...productInput({
          title: `十元商品 ${stamp}-bad`,
          status: "on",
          specs: [spec({ priceYuan: bad })],
        }),
      }),
      adminCookie,
    );
    assert.equal(rejected.status, 400, `${bad} 应当被拒`);
    assert.equal(
      JSON.parse(rejected.body).error.message,
      SPEC_PRICE_INVALID_MESSAGE,
      `${bad} 应当报单价错误`,
    );
  }

  // 界面这一层同样会拦下它们：`save()` 根本不会发出这个请求
  {
    const formOptions = await getAdminProductFormOptions();
    for (const bad of ["1.005", "1e3", "0", "-1", "100000"]) {
      assert.equal(
        normalizeProductProfilePatch(productInput({ specs: [spec({ priceYuan: bad })] }), {
          games: formOptions.games,
          categories: formOptions.categories,
          currentCoverUrl: "",
          currentDetailImages: [],
        }),
        null,
        `界面也应当拦下 ${bad}`,
      );
    }
  }
  const listed = JSON.parse(
    (await requestWithCookie(
      `/api/admin/products?keyword=${encodeURIComponent(`十元商品 ${stamp}-bad`)}`,
      adminCookie,
    )).body,
  ).data;
  assert.equal(listed.total, 0, "被拒的提交一件商品都不该留下");

  // ⑨ 同一个合法的创建请求重试：只建一条。
  //    两次的标题与幂等键完全相同（`postProductFromForm` 由 stamp 派生），
  //    因此第二次到的就是「同一个意图的重复到达」。
  const idemStamp = `${stamp}-idem`;
  const first = await postProductFromForm(adminCookie, "10", idemStamp);
  const second = await postProductFromForm(adminCookie, "10", idemStamp);
  assert.equal(first.response.status, 200, first.response.body);
  assert.equal(second.response.status, 200, second.response.body);
  assert.equal(
    JSON.parse(second.response.body).data.productId,
    JSON.parse(first.response.body).data.productId,
    "重放返回的必须是第一次那条",
  );
  assert.equal(JSON.parse(second.response.body).data.changed, false, "重放不是一次新变更");

  const idempotent = JSON.parse(
    (await requestWithCookie(
      `/api/admin/products?keyword=${encodeURIComponent(`十元商品 ${idemStamp}`)}`,
      adminCookie,
    )).body,
  ).data;
  assert.equal(idempotent.total, 1, "同一个键重试不该建出第二条");
});

test("结算试算按分算、历史订单读的是下单快照：改价之后仍然不变", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];
  const userCookie = await mockUserLogin(USER);
  assert.ok(userCookie, "模拟用户登录应当拿到会话");

  const stamp = Date.now();
  const { response: created } = await postProductFromForm(adminCookie, "10", `${stamp}-buy`);
  assert.equal(created.status, 200, created.body);
  const productId = JSON.parse(created.body).data.productId;

  const detail = JSON.parse(
    (await requestWithCookie(`/api/admin/products/${productId}`, adminCookie)).body,
  ).data;
  const specId = detail.specs[0].id;

  const selection = {
    productId,
    specId,
    quantity: 2,
    region: "手游",
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId: null,
  };

  // ⑤ P4 结算试算：金额按服务端的整数分算，而不是界面上那两个字符
  const preview = await sendWithCookie(
    "POST",
    "/api/orders/preview",
    JSON.stringify(selection),
    userCookie,
  );
  assert.equal(preview.status, 200, preview.body);
  const quoted = JSON.parse(preview.body).data;
  assert.equal(quoted.spec.price, 1000, "试算读到的单价是 1000 分");
  assert.equal(quoted.itemsAmount, 2000, "单价 × 数量按分计算");
  assert.equal(quoted.totalAmount, 2000);

  // ⑩ 下单 → 改价 → 历史订单不变
  const pay = await sendWithCookie(
    "POST",
    "/api/orders/pay",
    JSON.stringify({ idempotencyKey: `p8b-http-pay-${stamp}`, ...selection, quantity: 1 }),
    userCookie,
  );
  assert.equal(pay.status, 200, pay.body);
  const paymentRequestId = JSON.parse(pay.body).data.id;

  const confirm = await sendWithCookie(
    "POST",
    "/api/payments/mock-confirm",
    JSON.stringify({ paymentRequestId, result: "success" }),
    userCookie,
  );
  assert.equal(confirm.status, 200, confirm.body);
  const orderId = JSON.parse(confirm.body).data.orderId;

  const orderBefore = JSON.parse(
    (await requestWithCookie(`/api/orders/${orderId}`, userCookie)).body,
  ).data;
  assert.equal(orderBefore.unitPrice, 1000, "下单时单价是 1000 分");
  assert.equal(orderBefore.itemsAmount, 1000);

  // 改价：10 元 → 30 元
  const saved = await sendWithCookie(
    "PATCH",
    `/api/admin/products/${productId}`,
    JSON.stringify({
      idempotencyKey: `p8b-http-reprice-${stamp}`,
      ...(await httpProductBodyFrom(productId, adminCookie, {
        specs: [{ ...toSpecInput(detail.specs[0]), priceYuan: "30" }],
      })),
    }),
    adminCookie,
  );
  assert.equal(saved.status, 200, saved.body);

  // 商品自己的价格确实变了
  const after = JSON.parse(
    (await requestWithCookie(`/api/admin/products/${productId}`, adminCookie)).body,
  ).data;
  assert.equal(after.specs[0].price, 3000);
  assert.equal(after.specs[0].id, specId);

  // 历史订单读的仍是下单那一刻的抄本
  const orderAfter = JSON.parse(
    (await requestWithCookie(`/api/orders/${orderId}`, userCookie)).body,
  ).data;
  assert.equal(orderAfter.unitPrice, 1000, "历史订单的单价是下单快照，不随商品改价而变");
  assert.equal(orderAfter.itemsAmount, 1000);
  assert.equal(orderAfter.specName, "标准档");
  assert.equal(orderAfter.totalAmount, orderBefore.totalAmount);

  // 用户端商品详情页显示的是**新**价，说明改价确实生效了（不是两处都读的旧值）
  const page = await requestWithCookie(`/product/${productId}`, null);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("30.00"), "用户端详情页应当显示改后的 30.00");
});
