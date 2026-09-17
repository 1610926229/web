import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  ADMIN_CATEGORY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_CATEGORY_NOT_FOUND_MESSAGE,
  ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE,
  ADMIN_CATEGORY_REMOVED_MESSAGE,
  CATEGORY_DUPLICATE_NAME_MESSAGE,
  CATEGORY_GAME_INVALID_MESSAGE,
  CATEGORY_GAME_REQUIRED_MESSAGE,
  CATEGORY_NAME_EMPTY_MESSAGE,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_TOO_LONG_MESSAGE,
  CATEGORY_SORT_ORDER_INVALID_MESSAGE,
  adminCategoryHasProductsMessage,
  adminCategoryStatus,
  categoryProfileFieldErrors,
  countAdminCategoryStates,
  hasCategoryProfileError,
  normalizeCategoryProfilePatch,
} from "../lib/constants/adminCategories.ts";
import {
  ADMIN_CATALOG_MAX_PAGE,
  ADMIN_CATALOG_MAX_PAGE_SIZE,
} from "../lib/constants/adminCatalog.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getCatalogRepository } from "../lib/data/catalogRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { categorySeed, productSeed } from "../lib/mocks/fixtures/catalogSeed.ts";
import { getGames, getProductDetail, queryProducts } from "../lib/services/catalog.ts";
import {
  createAdminCategory,
  getAdminCategoryDetail,
  queryAdminCategoryList,
  removeAdminCategory,
  resolveAdminCategoryListQuery,
  setAdminCategoryEnabled,
  updateAdminCategory,
} from "../lib/services/adminCategories.ts";
import {
  createAdminProduct,
  removeAdminProduct,
} from "../lib/services/adminProducts.ts";

/**
 * P8B：类目管理的持续测试。
 *
 * 断言的是**真实实现**：`lib/services/adminCategories.ts` 与真实的 Mock 仓储，
 * 不是复制一份逻辑再测一遍复制品。守的是 §类目规则 与 §API、权限与一致性：
 *
 * 1. **数据源只有一份**：后台改完之后，用户端分类导航读到的就是新值（无需同步动作）；
 * 2. **重名与「有商品不能删」在原子区段里判定**：这两条如果只放在服务层，
 *    两个同时到达的请求会各自读到「没有」然后都写进去；
 * 3. **停用 / 移除都不进用户端导航**，但停用与移除是两件事：停用可逆、移除是终态，
 *    而且「使用中」这个默认视图里**停用还在、移除不在**；
 * 4. **软删除可查**：移除之后后台用 `removal=removed` 仍然看得到它，详情也照常打开——
 *    返回 404 等于把软删除做成了「记录消失」；
 * 5. **审计恰好一次**：每次真实变更一条，重放与「什么都没改」都不写第二条，
 *    且快照里只有标量。
 *
 * ⚠️ 预置数据里**没有**空类目（六个类目下都有商品），也没有已移除的类目。
 * 「移除」相关的用例因此都**自己建一条**再移除，而不是借一个种子 id——
 * 借来的 id 一旦哪天有了商品，用例会以一种看起来毫不相干的方式失败。
 *
 * 需要真实服务的断言（HTTP 状态码、权限矩阵）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `adminCompanionManagement.test.mjs` 同一套做法。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P8B 类目的 HTTP 用例";

/** 执行操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置数据里的关键类目（见 `lib/mocks/fixtures/catalogSeed.ts`）。 */
const GAME_DELTA = "g-delta";
const GAME_VALORANT = "g-valorant";
const DELTA_LOSS = "c-loss"; // 亏本单：下面有 7 件未移除商品（含一件已下架）
const DELTA_OPENING = "c-opening"; // 开业特惠
const VALORANT_RANK = "c-v-rank"; // 无畏契约 / 排位护航

/**
 * 某个类目下**未移除**的商品数。
 *
 * 由种子现算，不写死数字：种子里加一件商品不该让这里变红，而口径变了才该变红。
 */
function seedProductCount(categoryId) {
  return productSeed.filter(
    (record) => record.categoryId === categoryId && record.removedAt === null,
  ).length;
}

let keySeq = 0;
/** 每个用例一个全新的幂等键：键与「这次意图」绑定，用例之间不能共用。 */
function uniqueKey() {
  keySeq += 1;
  return `p8b-cat-key-${process.pid}-${keySeq}`;
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

/** 管理端列表：从地址栏参数解析查询条件再取数（页面与接口走的是同一条路径）。 */
async function adminCategories(input = {}, strict = false) {
  const search = params(input);
  const query = await resolveAdminCategoryListQuery(search, strict);
  return queryAdminCategoryList(query, search, "server");
}

/** 一份合法的类目输入，用例按需覆盖其中几项。 */
function categoryInput(overrides = {}) {
  return {
    gameId: GAME_DELTA,
    name: "测试类目",
    sortOrder: 100,
    enabled: true,
    ...overrides,
  };
}

function createCategory(overrides = {}, key = uniqueKey()) {
  return createAdminCategory(ADMIN_ID, { idempotencyKey: key, ...categoryInput(overrides) });
}

function auditsFor(targetId) {
  return getAdminAuditRepository().listAudits({ targetType: "category", targetId });
}

/** 一件合法商品的提交体，用例按需覆盖。 */
function productInput(categoryId, overrides = {}) {
  return {
    gameId: GAME_DELTA,
    categoryId,
    title: "测试商品",
    subtitle: "",
    coverUrl: "/mock/product-cover-1.svg",
    tags: [],
    detailText: "",
    detailImages: [],
    sortOrder: 10,
    // 分账比例在接口上是百分比文本（与 priceYuan 同一条规则），必填
    companionRatePercent: "80",
    recommended: false,
    status: "off",
    specs: [
      { id: "", name: "标准档", priceYuan: "9.90", sortOrder: 10, enabled: true, removed: false },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  // 目录与审计一起重置：幂等键的账本就在审计仓储里（`findAuditByOperationId`），
  // 只重置目录会让上一个用例用过的键在这个用例里变成「重放」
  resetMockStore("catalog");
  resetMockStore("adminAudit");
});

// ——————————————————————— 列表：搜索 / 筛选 / 分页 ———————————————————————

test("列表默认只看「使用中」：停用还在里面，已移除不在——两者不是同一件事", async () => {
  const all = await adminCategories({ pageSize: 50 });
  assert.equal(all.total, categorySeed.length);

  // 预置数据里没有已移除的类目：一上来就摆几条，「已移除」筛选永远看不到空态
  const removed = await adminCategories({ removal: "removed", pageSize: 50 });
  assert.deepEqual(removed.items, []);
  assert.equal(removed.total, 0);

  const created = await createCategory({ name: "稍后移除" });
  await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() });

  // 移除之后：默认视图少一条，已移除视图多一条——同一个接口，两个视角
  const activeAfter = await adminCategories({ pageSize: 50 });
  assert.equal(activeAfter.total, categorySeed.length);
  assert.equal(
    activeAfter.items.some((item) => item.id === created.categoryId),
    false,
    "已移除的类目不能混在「使用中」里，否则看起来就像移除根本没生效",
  );

  const removedAfter = await adminCategories({ removal: "removed", pageSize: 50 });
  assert.equal(removedAfter.total, 1);
  assert.equal(removedAfter.items[0].id, created.categoryId);
});

test("停用的类目仍在默认视图里（使用中 = 未移除，不是「启用中」）", async () => {
  await setAdminCategoryEnabled(DELTA_OPENING, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const active = await adminCategories({ pageSize: 50 });
  const row = active.items.find((item) => item.id === DELTA_OPENING);
  assert.ok(row, "停用不是移除，它仍然是一条使用中的记录");
  assert.equal(row.enabled, false);

  // enabled 筛选才把两者分开
  const disabled = await adminCategories({ enabled: "disabled", pageSize: 50 });
  assert.deepEqual(
    disabled.items.map((item) => item.id),
    [DELTA_OPENING],
  );

  const enabled = await adminCategories({ enabled: "enabled", pageSize: 50 });
  assert.equal(
    enabled.items.some((item) => item.id === DELTA_OPENING),
    false,
  );
});

test("搜索按名称匹配，首尾空格不把结果搜没", async () => {
  const hit = await adminCategories({ keyword: "亏本", pageSize: 50 });
  assert.deepEqual(
    hit.items.map((item) => item.id),
    [DELTA_LOSS],
  );

  const padded = await adminCategories({ keyword: "  亏本  ", pageSize: 50 });
  assert.deepEqual(
    padded.items.map((item) => item.id),
    [DELTA_LOSS],
  );

  // 搜不到就是 0 条（不是退回全部）——退回全部会让人以为「搜到了很多」
  const miss = await adminCategories({ keyword: "不存在的类目名", pageSize: 50 });
  assert.equal(miss.total, 0);
  assert.deepEqual(miss.items, []);
});

test("筛选按游戏隔离，且与搜索叠加生效", async () => {
  const delta = await adminCategories({ gameId: GAME_DELTA, pageSize: 50 });
  assert.equal(delta.items.every((item) => item.gameId === GAME_DELTA), true);
  assert.equal(
    delta.total,
    categorySeed.filter((item) => item.gameId === GAME_DELTA).length,
  );

  const valorant = await adminCategories({ gameId: GAME_VALORANT, pageSize: 50 });
  assert.deepEqual(
    valorant.items.map((item) => item.id),
    [VALORANT_RANK, "c-v-train"],
    "列表按排序值升序：游戏内的展示顺序就是它在用户端导航里的顺序",
  );

  // 叠加：搜「排位」在三角洲下没有结果，在无畏契约下有
  assert.equal((await adminCategories({ gameId: GAME_DELTA, keyword: "排位" })).total, 0);
  assert.equal((await adminCategories({ gameId: GAME_VALORANT, keyword: "排位" })).total, 1);
});

test("非法筛选值：接口 400（严格），页面收敛到默认值（宽松）", async () => {
  // 接口调用的 strict 模式：宁可报错，也不静默当成「全部」——
  // 调用方会拿着一个自己不知道筛了什么的结果继续往下用
  await expectApiError(
    resolveAdminCategoryListQuery(params({ removal: "gone" }), true),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveAdminCategoryListQuery(params({ enabled: "maybe" }), true),
    "BAD_REQUEST",
  );
  await expectApiError(
    resolveAdminCategoryListQuery(params({ gameId: "g-nope" }), true),
    "BAD_REQUEST",
  );

  // 页面用的宽松模式：地址栏被手改坏了，收敛到默认筛选而不是整页报错
  const loose = await resolveAdminCategoryListQuery(
    params({ removal: "gone", enabled: "maybe", gameId: "g-nope" }),
    false,
  );
  assert.equal(loose.removal, "active");
  assert.equal(loose.enabled, "");
  assert.equal(loose.gameId, "", "不存在的游戏 id 收敛成「不限」，而不是留一个筛不出东西的条件");
});

test("分页：条数、hasMore 与越界页都自洽", async () => {
  const total = categorySeed.length;
  const pages = Math.ceil(total / 2);

  const first = await adminCategories({ page: 1, pageSize: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.total, total);
  assert.equal(first.hasMore, true);

  const last = await adminCategories({ page: pages, pageSize: 2 });
  assert.equal(last.items.length, total - (pages - 1) * 2);
  assert.equal(last.hasMore, false, `${total} 条按每页 2 条正好 ${pages} 页`);

  // 越界页返回空列表而不是报错：翻到最后一页之后点「下一页」是个正常动作
  const beyond = await adminCategories({ page: 99, pageSize: 2 });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.hasMore, false);

  // 分页参数被规范化到上限与下界，不会因为一个手改的地址把整张表拖出来
  assert.equal((await adminCategories({ pageSize: 9999 })).pageSize, ADMIN_CATALOG_MAX_PAGE_SIZE);
  assert.equal((await adminCategories({ page: 0 })).page, 1);
  assert.equal((await adminCategories({ page: 10 ** 9 })).page, ADMIN_CATALOG_MAX_PAGE);
  assert.equal((await adminCategories({ page: "abc" })).page, 1);

  // 翻页不重不漏：几页拼起来正好是全部记录
  const seen = [];
  for (let page = 1; page <= pages; page += 1) {
    seen.push(...(await adminCategories({ page, pageSize: 2 })).items.map((item) => item.id));
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
});

test("角标：all 含已移除，enabled / disabled 只数使用中的", async () => {
  const before = await adminCategories({ pageSize: 50 });
  assert.deepEqual(before.counts, countAdminCategoryStates(categorySeed));

  await setAdminCategoryEnabled(DELTA_OPENING, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const created = await createCategory({ name: "角标用" });
  await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const after = await adminCategories({ pageSize: 50 });
  assert.deepEqual(after.counts, {
    all: categorySeed.length + 1,
    enabled: categorySeed.length - 1,
    disabled: 1,
    removed: 1,
  });
  // 已移除的那条**不**计入 disabled：点「已停用」角标看到的是另一批记录
  assert.equal(after.counts.enabled + after.counts.disabled + after.counts.removed, after.counts.all);
});

test("列表每行带「下面还有几件未移除的商品」，下架的也算（它只是下架）", async () => {
  const data = await adminCategories({ keyword: "亏本", pageSize: 50 });
  const row = data.items[0];
  assert.equal(row.productCount, seedProductCount(DELTA_LOSS));
  assert.equal(row.productCount, await getCatalogRepository().countProductsInCategory(DELTA_LOSS));

  // 用户端列表不含下架商品，而后台的商品数**含**下架（未移除）：
  // 差的那一件就是 p-off-1——它不能卖，但仍然占着这个类目
  const inCategory = await queryProducts(
    { gameId: GAME_DELTA, categoryId: DELTA_LOSS, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(inCategory.total, row.productCount - 1);
  assert.equal(
    inCategory.items.some((item) => item.status === "off" || item.id === "p-off-1"),
    false,
    "用户端列表里一件下架商品都不该有",
  );
});

// ——————————————————————————— 新建与编辑 ———————————————————————————

test("新建类目：字段落库、审计 before 为 null、id 用后台前缀", async () => {
  const result = await createCategory({ name: "新类目甲", sortOrder: 55 });

  assert.equal(result.changed, true);
  assert.equal(result.removedAt, null);
  assert.match(result.categoryId, /^c_/, "后台新建的 id 与预置数据的短 id 从取值域上分开");

  const detail = await getAdminCategoryDetail(result.categoryId, undefined, "server");
  assert.equal(detail.name, "新类目甲");
  assert.equal(detail.gameId, GAME_DELTA);
  assert.equal(detail.sortOrder, 55);
  assert.equal(detail.enabled, true);
  assert.equal(detail.removedAt, null);
  assert.equal(detail.productCount, 0);
  assert.equal(detail.gameName, "三角洲行动", "列表与详情给的是游戏名，不是游戏 id");
  assert.ok(detail.createdAt.length > 0 && detail.updatedAt.length > 0);

  const audits = await auditsFor(result.categoryId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "category.create");
  assert.equal(audits[0].before, null, "新建时还不存在「更新前」，before 就是 null");
  assert.equal(audits[0].after.name, "新类目甲");
  assert.equal(audits[0].actorId, ADMIN_ID);
});

test("DTO 边界：客户端伪造的 id / 时间 / 移除状态一律没有入口", async () => {
  const result = await createAdminCategory(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...categoryInput({ name: "伪造测试" }),
    // 下面这些在服务层**没有读取的位置**，不是「校验后被忽略」
    id: DELTA_LOSS,
    removedAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    productCount: 999,
  });

  assert.notEqual(result.categoryId, DELTA_LOSS, "id 由服务端在原子区段里生成");
  assert.equal(result.removedAt, null);

  const detail = await getAdminCategoryDetail(result.categoryId, undefined, "server");
  assert.notEqual(detail.createdAt, "2020-01-01T00:00:00.000Z");
  assert.equal(detail.productCount, 0);

  // 预置的那条类目没有被覆盖
  const untouched = await getAdminCategoryDetail(DELTA_LOSS, undefined, "server");
  assert.equal(untouched.name, "亏本单");
});

test("编辑类目：改名与改排序记 category.update，取消启用勾选记 category.disable", async () => {
  const before = await getAdminCategoryDetail(DELTA_OPENING, undefined, "server");

  const renamed = await updateAdminCategory(DELTA_OPENING, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...categoryInput({ name: "开业特惠（改）", sortOrder: 25 }),
  });
  assert.equal(renamed.changed, true);

  const after = await getAdminCategoryDetail(DELTA_OPENING, undefined, "server");
  assert.equal(after.name, "开业特惠（改）");
  assert.equal(after.sortOrder, 25);
  assert.equal(after.gameId, before.gameId);
  assert.equal(after.enabled, before.enabled, "这次提交的启用状态与原来一样，因此它没被改");
  assert.equal(after.createdAt, before.createdAt, "createdAt 不是可编辑字段");
  assert.notEqual(after.updatedAt, before.updatedAt, "改完要留下新的更新时间");

  // 同一个接口把启用勾去掉 → 审计记的是「停用类目」，不是「编辑类目」。
  // 审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」。
  await updateAdminCategory(DELTA_OPENING, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...categoryInput({ name: "开业特惠（改）", sortOrder: 25, enabled: false }),
  });
  assert.equal(
    (await getAdminCategoryDetail(DELTA_OPENING, undefined, "server")).enabled,
    false,
  );

  const audits = await auditsFor(DELTA_OPENING);
  assert.deepEqual(
    audits.map((entry) => entry.action).sort(),
    ["category.disable", "category.update"],
  );

  // 审计快照只允许标量：一个字段忘了裁剪，也不可能把对象整个塞进来
  for (const entry of audits) {
    for (const snapshot of [entry.before, entry.after]) {
      for (const value of Object.values(snapshot)) {
        assert.equal(
          value === null || ["string", "number", "boolean"].includes(typeof value),
          true,
        );
      }
    }
  }
  const disable = audits.find((entry) => entry.action === "category.disable");
  assert.equal(disable.before.name, "开业特惠（改）");
  assert.equal(disable.before.enabled, true);
  assert.equal(disable.after.enabled, false);
  assert.equal(disable.actorId, ADMIN_ID);
});

test("编辑可以改所属游戏：类目换游戏后，两边导航各自读到的就是新归属", async () => {
  const created = await createCategory({ gameId: GAME_DELTA, name: "换游戏测试" });

  await updateAdminCategory(created.categoryId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...categoryInput({ gameId: GAME_VALORANT, name: "换游戏测试" }),
  });

  const games = await getGames();
  assert.equal(
    games
      .find((game) => game.id === GAME_DELTA)
      .categories.some((item) => item.id === created.categoryId),
    false,
  );
  assert.equal(
    games
      .find((game) => game.id === GAME_VALORANT)
      .categories.some((item) => item.id === created.categoryId),
    true,
  );

  // 换游戏让原游戏下的排序位置空出来，但那条类目只剩一个归属
  const detail = await getAdminCategoryDetail(created.categoryId, undefined, "server");
  assert.equal(detail.gameId, GAME_VALORANT);
  assert.equal(detail.gameName, "无畏契约");
});

test("没有任何改动时保存：不写数据、也不写审计", async () => {
  const before = await getAdminCategoryDetail(DELTA_LOSS, undefined, "server");
  const result = await updateAdminCategory(DELTA_LOSS, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...categoryInput({
      name: before.name,
      sortOrder: before.sortOrder,
      enabled: before.enabled,
    }),
  });

  assert.equal(result.changed, false);
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "category" })).length,
    0,
    "一次没有内容的保存不该在审计里留下「改了什么」看不出来的记录",
  );
});

// ——————————————————————————— 字段规则 ———————————————————————————

test("字段规则：名称必填 / 超长、游戏必须真实存在、排序必须是区间内的整数", () => {
  const games = [
    { id: GAME_DELTA, name: "三角洲行动" },
    { id: GAME_VALORANT, name: "无畏契约" },
  ];
  const base = { gameId: GAME_DELTA, name: "甲", sortOrder: 10, enabled: true };

  assert.equal(
    categoryProfileFieldErrors({ ...base, name: "   " }, games).name,
    CATEGORY_NAME_EMPTY_MESSAGE,
  );
  assert.equal(
    categoryProfileFieldErrors({ ...base, name: "名".repeat(CATEGORY_NAME_MAX_LENGTH + 1) }, games)
      .name,
    CATEGORY_NAME_TOO_LONG_MESSAGE,
  );
  // 边界值本身合法
  assert.equal(
    categoryProfileFieldErrors({ ...base, name: "名".repeat(CATEGORY_NAME_MAX_LENGTH) }, games).name,
    null,
  );

  assert.equal(
    categoryProfileFieldErrors({ ...base, gameId: "" }, games).gameId,
    CATEGORY_GAME_REQUIRED_MESSAGE,
  );
  assert.equal(
    categoryProfileFieldErrors({ ...base, gameId: "g-nope" }, games).gameId,
    CATEGORY_GAME_INVALID_MESSAGE,
  );

  // 空串与 NaN（界面没填）都必须是「排序不合法」，不能静默当成 0
  for (const sortOrder of [Number.NaN, -1, 10000, 1.5]) {
    const errors = categoryProfileFieldErrors({ ...base, sortOrder }, games);
    assert.equal(errors.sortOrder, CATEGORY_SORT_ORDER_INVALID_MESSAGE, `sortOrder=${sortOrder}`);
    assert.equal(hasCategoryProfileError(errors), true);
    assert.equal(
      normalizeCategoryProfilePatch({ ...base, sortOrder }, games),
      null,
      "校验没过时不能给出一个可以直接写入的 patch",
    );
  }

  // 边界值 0 与上限合法；合法输入给出规范化后的值（名称去掉首尾空格）
  assert.deepEqual(
    normalizeCategoryProfilePatch(
      { gameId: GAME_DELTA, name: "  甲  ", sortOrder: 0, enabled: false },
      games,
    ),
    { gameId: GAME_DELTA, name: "甲", sortOrder: 0, enabled: false },
  );
  assert.equal(
    categoryProfileFieldErrors({ ...base, sortOrder: 9999 }, games).sortOrder,
    null,
  );
});

test("接口层同样拦非法输入：报的是**第一条**错误的原话", async () => {
  await expectApiError(
    createAdminCategory(ADMIN_ID, { idempotencyKey: uniqueKey(), ...categoryInput({ name: "" }) }),
    "BAD_REQUEST",
    CATEGORY_NAME_EMPTY_MESSAGE,
  );
  await expectApiError(
    createAdminCategory(ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...categoryInput({ gameId: "g-nope" }),
    }),
    "BAD_REQUEST",
    CATEGORY_GAME_INVALID_MESSAGE,
  );
  await expectApiError(
    createAdminCategory(ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...categoryInput({ sortOrder: "abc" }),
    }),
    "BAD_REQUEST",
    CATEGORY_SORT_ORDER_INVALID_MESSAGE,
  );
  // 排序整个没传（缺省 NaN）也要报错，而不是当成 0
  await expectApiError(
    createAdminCategory(ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      gameId: GAME_DELTA,
      name: "没有排序",
      enabled: true,
    }),
    "BAD_REQUEST",
    CATEGORY_SORT_ORDER_INVALID_MESSAGE,
  );

  assert.equal((await adminCategories({ keyword: "没有排序" })).total, 0);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 0);
});

// ——————————————————————————— 重名 ———————————————————————————

test("同一游戏内不能重名；不同游戏、以及已移除的同名可以复用", async () => {
  await expectApiError(
    createCategory({ name: "亏本单" }),
    "BAD_REQUEST",
    CATEGORY_DUPLICATE_NAME_MESSAGE,
  );

  // 换个游戏就是合法的——重名的判定范围是「同一游戏内」
  const otherGame = await createCategory({ gameId: GAME_VALORANT, name: "亏本单" });
  assert.equal(otherGame.changed, true);

  // 停用**不**释放这个名字：停用的类目还在，随时可能启用回来
  await setAdminCategoryEnabled(DELTA_OPENING, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  await expectApiError(
    createCategory({ name: "开业特惠" }),
    "BAD_REQUEST",
    CATEGORY_DUPLICATE_NAME_MESSAGE,
  );

  // 移除才释放：一条已移除的类目不再占用名字
  const created = await createCategory({ name: "稍后复用" });
  await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal((await createCategory({ name: "稍后复用" })).changed, true);

  // 编辑到同名同样被拒（不只是新建时才查），而且**改自己那条**不算重名
  await expectApiError(
    updateAdminCategory(DELTA_OPENING, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...categoryInput({ name: "亏本单" }),
    }),
    "BAD_REQUEST",
    CATEGORY_DUPLICATE_NAME_MESSAGE,
  );
  assert.equal(
    (
      await updateAdminCategory(DELTA_OPENING, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        ...categoryInput({ name: "开业特惠", sortOrder: 21 }),
      })
    ).changed,
    true,
    "与自己同名不算重名：判定时要排除自己这条",
  );
});

test("重名判定发生在原子区段里：两个并发的新建请求只有一个能成立", async () => {
  // 两个请求带着**不同的幂等键**同时到达：它们不是同一次重试，是两次真实意图
  const results = await Promise.allSettled([
    createCategory({ name: "并发同名" }, uniqueKey()),
    createCategory({ name: "并发同名" }, uniqueKey()),
  ]);

  const fulfilled = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1, "只应当有一条被建出来");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.message, CATEGORY_DUPLICATE_NAME_MESSAGE);

  assert.equal((await adminCategories({ keyword: "并发同名" })).total, 1, "仓储里也只有一条");
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "category" })).length,
    1,
    "失败的那次不该留下审计",
  );
});

// ——————————————————————————— 停用 / 移除 ———————————————————————————

test("停用类目：用户端导航里没有它，但记录与商品归属都还在", async () => {
  const before = await getGames();
  assert.equal(
    before
      .find((game) => game.id === GAME_DELTA)
      .categories.some((item) => item.id === DELTA_LOSS),
    true,
  );

  await setAdminCategoryEnabled(DELTA_LOSS, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const after = await getGames();
  assert.equal(
    after
      .find((game) => game.id === GAME_DELTA)
      .categories.some((item) => item.id === DELTA_LOSS),
    false,
    "停用之后用户端导航读到的就是新值，不需要任何同步动作",
  );

  // 记录还在，商品归属也还在（这就是「停用」与「移除」的区别）
  const detail = await getAdminCategoryDetail(DELTA_LOSS, undefined, "server");
  assert.equal(detail.enabled, false);
  assert.equal(detail.removedAt, null);
  assert.equal(detail.productCount, seedProductCount(DELTA_LOSS));

  const audits = await auditsFor(DELTA_LOSS);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "category.disable");

  // 再停用一次：没有新的变更，也不该再写一条审计
  const again = await setAdminCategoryEnabled(DELTA_LOSS, false, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(again.changed, false);
  assert.equal((await auditsFor(DELTA_LOSS)).length, 1);

  // 启用回来是可逆的
  await setAdminCategoryEnabled(DELTA_LOSS, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(
    (await getGames())
      .find((game) => game.id === GAME_DELTA)
      .categories.some((item) => item.id === DELTA_LOSS),
    true,
  );
  assert.deepEqual(
    (await auditsFor(DELTA_LOSS)).map((entry) => entry.action),
    ["category.disable", "category.enable"],
  );
});

test("有未移除商品的类目不能移除，且**不级联删除商品**", async () => {
  const count = await getCatalogRepository().countProductsInCategory(DELTA_LOSS);
  assert.ok(count > 0, "预置数据里这个类目下有商品，否则这个用例证明不了什么");

  await expectApiError(
    removeAdminCategory(DELTA_LOSS, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    adminCategoryHasProductsMessage(count),
  );

  // 类目与它下面的商品都原封不动
  const detail = await getAdminCategoryDetail(DELTA_LOSS, undefined, "server");
  assert.equal(detail.removedAt, null);
  assert.equal(detail.productCount, count);
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "category" })).length,
    0,
    "被拒绝的操作不该留下审计",
  );

  const products = await queryProducts(
    { gameId: GAME_DELTA, categoryId: DELTA_LOSS, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.ok(products.items.length > 0, "商品必须还在架，不能被静默下架");
});

test("类目下只剩已移除商品时就可以移除了（软删除的商品不锁死类目）", async () => {
  const repo = getCatalogRepository();
  const created = await createCategory({ name: "清空后移除" });

  // 建两件商品，再全部移除：类目应当随之解锁
  const made = [];
  for (const title of ["清空测试一", "清空测试二"]) {
    const product = await createAdminProduct(ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...productInput(created.categoryId, { title, categoryId: created.categoryId }),
    });
    made.push(product.productId);
  }

  assert.equal(await repo.countProductsInCategory(created.categoryId), 2);
  await expectApiError(
    removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    adminCategoryHasProductsMessage(2),
  );

  for (const id of made) {
    await removeAdminProduct(id, ADMIN_ID, { idempotencyKey: uniqueKey() });
  }

  // 已移除的商品在用户端本来就不可见，让它们把类目锁死说不通
  assert.equal(await repo.countProductsInCategory(created.categoryId), 0);
  assert.equal(
    (await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() }))
      .changed,
    true,
  );

  // 两边都是软删除：商品记录仍然在，只是用户端取不到
  const detail = await getAdminCategoryDetail(created.categoryId, undefined, "server");
  assert.notEqual(detail.removedAt, null);
  assert.equal(detail.productCount, 0, "列表上的商品数只数未移除的");
  for (const id of made) {
    assert.ok(await repo.findProductForAdmin(id));
    assert.equal(await repo.findProductById(id), null, "用户端已经看不到它了");
  }
});

test("移除类目：用户端导航消失、后台仍可查、不能再编辑或停用", async () => {
  const created = await createCategory({ name: "待移除类目" });
  const result = await removeAdminCategory(created.categoryId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true);
  assert.notEqual(result.removedAt, null);

  const games = await getGames();
  for (const game of games) {
    assert.equal(
      game.categories.some((item) => item.id === created.categoryId),
      false,
      "已移除的类目不在用户端导航里",
    );
  }

  // 后台仍然查得到：软删除不是「记录消失」
  const detail = await getAdminCategoryDetail(created.categoryId, undefined, "server");
  assert.equal(detail.id, created.categoryId);
  assert.notEqual(detail.removedAt, null);
  assert.deepEqual(adminCategoryStatus(detail), {
    key: "removed",
    label: "已移除",
    description: "用户端不可见，商品归属仍可追溯",
  });

  // 但不能再编辑、不能改状态
  await expectApiError(
    updateAdminCategory(created.categoryId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...categoryInput({ name: "改名试试" }),
    }),
    "BAD_REQUEST",
    ADMIN_CATEGORY_REMOVED_MESSAGE,
  );
  await expectApiError(
    setAdminCategoryEnabled(created.categoryId, true, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    ADMIN_CATEGORY_REMOVED_MESSAGE,
  );

  // 移除是幂等的：再来一次不刷新时间戳，也不多写一条审计
  const stamp = detail.removedAt;
  assert.equal(
    (await removeAdminCategory(created.categoryId, ADMIN_ID, { idempotencyKey: uniqueKey() }))
      .changed,
    false,
  );
  assert.equal(
    (await getAdminCategoryDetail(created.categoryId, undefined, "server")).removedAt,
    stamp,
  );

  // 两次重放都没有写审计：这条记录一共就两条——建它的那条，和移除它的那条
  const audits = await auditsFor(created.categoryId);
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ["category.create", "category.remove"],
  );
  assert.equal(audits[1].after.removedAt, stamp);
});

test("不存在的类目：详情返回 null（页面转 404），写操作 404", async () => {
  assert.equal(await getAdminCategoryDetail("c-nope", undefined, "server"), null);
  assert.equal(await getAdminCategoryDetail("", undefined, "server"), null);

  await expectApiError(
    updateAdminCategory("c-nope", ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...categoryInput(),
    }),
    "NOT_FOUND",
    ADMIN_CATEGORY_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    setAdminCategoryEnabled("c-nope", false, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_CATEGORY_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    removeAdminCategory("c-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_CATEGORY_NOT_FOUND_MESSAGE,
  );
});

// ——————————————————————— 失效类目与用户端 ———————————————————————

test("失效类目：停用后它下面的商品从用户端列表消失，但详情直链仍然打得开", async () => {
  const sample = productSeed.find(
    (record) => record.categoryId === DELTA_LOSS && record.status === "on",
  );
  assert.ok(sample, "需要一个在架商品，否则这个用例证明不了什么");

  // 停用之前：商品在用户端列表里能被逛到
  const before = await queryProducts(
    { gameId: GAME_DELTA, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(
    before.items.some((item) => item.id === sample.id),
    true,
  );

  await setAdminCategoryEnabled(DELTA_LOSS, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  // 停用之后：列表与搜索都找不到了——「导航里没有这个类目，但搜索能搜到它下面的商品」
  // 是自相矛盾的状态，因此这条过滤在数据层
  const after = await queryProducts(
    { gameId: GAME_DELTA, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(
    after.items.some((item) => item.id === sample.id),
    false,
  );
  assert.equal(
    (
      await queryProducts(
        { gameId: GAME_DELTA, keyword: sample.title, page: 1, pageSize: 100 },
        undefined,
        "server",
      )
    ).items.length,
    0,
  );

  // 但商品本身没有下架，历史收藏与直链仍然要能打开它：
  //「类目被停用」不该把一件还在卖的商品变成 404
  const detail = await getProductDetail(sample.id, undefined, "server");
  assert.ok(detail, "商品仍然可直达");
  assert.equal(detail.status, "on");

  // 启用回来之后列表恢复——停用是可逆的，不是一次性的
  await setAdminCategoryEnabled(DELTA_LOSS, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const restored = await queryProducts(
    { gameId: GAME_DELTA, categoryId: DELTA_LOSS, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.ok(restored.items.some((item) => item.id === sample.id));
});

test("失效类目深链安全回落：?categoryId=<已停用> 当作空结果，不是整页报错", async () => {
  await setAdminCategoryEnabled(DELTA_LOSS, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  // 用户端拿着一个已经失效的类目 id 打开分类页：返回空列表（页面渲染空态），
  // 而不是 500，也不是把全部商品当成「这个类目的商品」列出来
  const result = await queryProducts(
    { gameId: GAME_DELTA, categoryId: DELTA_LOSS, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);

  // 完全不存在的类目 id 同理
  const unknown = await queryProducts(
    { gameId: GAME_DELTA, categoryId: "c-nope", page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.deepEqual(unknown.items, []);
});

// ——————————————————————————— 幂等 ———————————————————————————

test("幂等：同一个键重复到达只建一条、只写一条审计，返回的是第一次的结果", async () => {
  const key = uniqueKey();
  const first = await createCategory({ name: "幂等测试" }, key);
  // 第二次的请求体故意不一样：重放必须返回**第一次**的结果，而不是按新请求体再建一条
  const second = await createCategory({ name: "幂等测试重放" }, key);

  assert.equal(second.categoryId, first.categoryId, "重放返回第一次建出来的那条记录");
  assert.equal(second.changed, false);

  const stored = await getAdminCategoryDetail(first.categoryId, undefined, "server");
  assert.equal(stored.name, "幂等测试", "重放不该按新请求体改写已经建好的记录");

  assert.equal((await adminCategories({ keyword: "幂等测试" })).total, 1);
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "category" })).length,
    1,
  );
});

test("幂等键被别的对象用过：报冲突而不是安静重放", async () => {
  const key = uniqueKey();
  await setAdminCategoryEnabled(DELTA_OPENING, false, ADMIN_ID, { idempotencyKey: key });

  // 同一个键去改另一个类目、或去走另一类写操作：安静重放会返回另一个对象的结果，
  // 比报错危险得多
  await expectApiError(
    setAdminCategoryEnabled(DELTA_LOSS, false, ADMIN_ID, { idempotencyKey: key }),
    "BAD_REQUEST",
    ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE,
  );
  await expectApiError(
    updateAdminCategory(DELTA_LOSS, ADMIN_ID, {
      idempotencyKey: key,
      ...categoryInput({ name: "亏本单改" }),
    }),
    "BAD_REQUEST",
    ADMIN_CATEGORY_OPERATION_CONFLICT_MESSAGE,
  );

  // 冲突没有产生任何副作用
  assert.equal(
    (await getAdminCategoryDetail(DELTA_LOSS, undefined, "server")).name,
    "亏本单",
  );
});

test("幂等键非法或缺失：400，且任何数据都没被写", async () => {
  for (const value of [undefined, "", "short", "有中文的键", "x".repeat(65)]) {
    const body = { ...categoryInput({ name: "非法键" }) };
    if (value !== undefined) body.idempotencyKey = value;
    await expectApiError(
      createAdminCategory(ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_CATEGORY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }

  assert.equal((await adminCategories({ keyword: "非法键" })).total, 0);
  assert.equal((await getAdminAuditRepository().listAudits()).length, 0);
});

test("并发：同一次意图的两个请求（同一个键）不会建出两条", async () => {
  const key = uniqueKey();
  const [a, b] = await Promise.all([
    createCategory({ name: "并发幂等" }, key),
    createCategory({ name: "并发幂等" }, key),
  ]);

  assert.equal(a.categoryId, b.categoryId);
  assert.equal((await adminCategories({ keyword: "并发幂等" })).total, 1);
  assert.equal(
    (await getAdminAuditRepository().listAudits({ targetType: "category" })).length,
    1,
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
 * 五条类目写接口。请求体**故意不带幂等键**（不是漏了），理由与 P8A 的权限矩阵一致：
 * 被拒身份拿到 401 / 403、管理者拿到「幂等键缺失」的 400，
 * 这本身就证明 `requireAdmin()` 排在解析入参之前；而这一轮用例一个字节都不写。
 */
function writeCases() {
  const body = JSON.stringify({});
  return [
    ["POST", "/api/admin/categories", body],
    ["PATCH", `/api/admin/categories/${DELTA_OPENING}`, body],
    ["POST", `/api/admin/categories/${DELTA_OPENING}/enable`, body],
    ["POST", `/api/admin/categories/${DELTA_OPENING}/disable`, body],
    ["POST", `/api/admin/categories/${DELTA_OPENING}/remove`, body],
  ];
}

test("类目接口权限矩阵：匿名 401，客服 / 护航 / 停用管理员 403，管理者走到业务校验", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  const adminCookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  const readPaths = ["/api/admin/categories", `/api/admin/categories/${DELTA_OPENING}`];
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
    // 开关关闭：`getSessionAdmin()` 一律返回 null，这三种身份连「有会话但没权限」都不存在，
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
  assert.equal((await requestWithCookie("/api/admin/categories/c-nope", adminCookie)).status, 404);
  assert.equal(
    (await requestWithCookie("/api/admin/categories/c-nope", "mock_admin_id=admin-2")).status,
    403,
  );

  // 非法筛选值：接口是严格模式
  assert.equal(
    (await requestWithCookie("/api/admin/categories?removal=gone", adminCookie)).status,
    400,
  );
  assert.equal(
    (await requestWithCookie("/api/admin/categories?gameId=g-nope", adminCookie)).status,
    400,
  );
});

test("类目写接口端到端：改完之后详情立刻是新名字，用户端读的仍是同一份数据", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];

  // 每次从服务端当前值出发，重复跑同一台服务也不会留下不一致
  const current = JSON.parse(
    (await requestWithCookie(`/api/admin/categories/${DELTA_OPENING}`, adminCookie)).body,
  ).data;
  const suffix = "（改名）";
  const nextName = current.name.endsWith(suffix)
    ? current.name.slice(0, -suffix.length)
    : `${current.name}${suffix}`;

  const saved = await sendWithCookie(
    "PATCH",
    `/api/admin/categories/${DELTA_OPENING}`,
    JSON.stringify({
      idempotencyKey: `p8b-http-category-${Date.now()}`,
      gameId: current.gameId,
      name: nextName,
      sortOrder: current.sortOrder,
      enabled: current.enabled,
    }),
    adminCookie,
  );
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).data.changed, true);

  const after = JSON.parse(
    (await requestWithCookie(`/api/admin/categories/${DELTA_OPENING}`, adminCookie)).body,
  ).data;
  assert.equal(after.name, nextName);
  assert.equal(after.gameId, current.gameId);

  // 用户端读的仍是同一份数据：分类列表接口照常返回，且这个类目下的商品还在
  // （改名不该改变归属，也不该让它下面的商品消失）
  const publicList = await requestWithCookie(
    `/api/catalog/products?gameId=${current.gameId}&categoryId=${DELTA_OPENING}&pageSize=50`,
    null,
  );
  assert.equal(publicList.status, 200);
  assert.ok(JSON.parse(publicList.body).data.items.length > 0);

  // 改回去，让这轮用例对服务端状态保持无副作用
  const restored = await sendWithCookie(
    "PATCH",
    `/api/admin/categories/${DELTA_OPENING}`,
    JSON.stringify({
      idempotencyKey: `p8b-http-category-restore-${Date.now()}`,
      gameId: current.gameId,
      name: current.name,
      sortOrder: current.sortOrder,
      enabled: current.enabled,
    }),
    adminCookie,
  );
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.body).data.changed, true);
});

test("ENABLE_MOCK_ADMIN=false 时类目接口完全关闭：登录 404，伪造 Cookie 无效", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status === 200) return; // 本次跑的服务开着开关，由「关掉开关再跑一次」覆盖

  assert.equal(login.status, 404);
  assert.equal(login.setCookie.length, 0);

  for (const pathname of ["/api/admin/categories", `/api/admin/categories/${DELTA_OPENING}`]) {
    assert.equal((await requestWithCookie(pathname, "mock_admin_id=admin-1")).status, 401);
  }
  for (const [method, pathname, body] of writeCases()) {
    assert.equal(
      (await sendWithCookie(method, pathname, body, "mock_admin_id=admin-1")).status,
      401,
    );
  }

  // 用户端完全不受影响
  assert.equal((await requestWithCookie(`/api/catalog/products?gameId=${GAME_DELTA}`, null)).status, 200);
});
