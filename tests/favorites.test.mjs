import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  FAVORITE_MAX_PAGE_SIZE,
  FAVORITE_OFF_SHELF_MESSAGE,
  FAVORITE_PAGE_SIZE,
  FAVORITE_PRODUCT_NOT_FOUND_MESSAGE,
  FAVORITE_PRODUCT_REQUIRED_MESSAGE,
  FAVORITE_STATE_LABELS,
  mergeFavoritePage,
  parseFavoriteListQuery,
} from "../lib/constants/favorites.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { favoriteSeed, REMOVED_PRODUCT_ID } from "../lib/mocks/fixtures/favoriteSeed.ts";
import {
  addFavoriteForUser,
  isFavoritedForUser,
  queryFavoritesForUser,
  removeFavoriteForUser,
} from "../lib/services/favorites.ts";

/**
 * 商品收藏的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/favorites.ts`，
 * 因此「收藏幂等」「取消幂等」「用户隔离」「下架不能新增收藏」「商品被删除也能安全展示」
 * 「分页不重复」这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * 每个用例开始前重建收藏 store（拿到干净的预置数据）。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 在售、且**没有被 u-1001 预置收藏**的商品：用来做新增收藏的干净对象（它属于 u-1002）。 */
const FREE_PRODUCT = "p-vr-1";
/** 已下架、且已被 u-1001 收藏过的商品。 */
const OFF_SHELF_PRODUCT = "p-off-1";
/** 商品已从数据源删除，收藏记录仍在。 */
const MISSING_PRODUCT = REMOVED_PRODUCT_ID;

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

async function list(userId, params = page()) {
  return queryFavoritesForUser(userId, params, "server");
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("favorite");
});

test("列表只包含当前用户的收藏，按最近收藏时间倒序", async () => {
  const result = await list(USER_A);

  // 预置 14 条 > 一页，第一页满页且还有更多
  assert.equal(result.items.length, FAVORITE_PAGE_SIZE);
  assert.equal(result.total, 14);
  assert.equal(result.page, 1);
  assert.equal(result.hasMore, true);

  // 时间严格非递增（倒序），且都是 u-1001 的记录
  for (let index = 1; index < result.items.length; index += 1) {
    const previous = result.items[index - 1].createdAt;
    const current = result.items[index].createdAt;
    assert.ok(previous >= current, `第 ${index} 项顺序不对：${previous} < ${current}`);
  }

  // B 的列表里没有 A 的商品，A 的列表里也没有 B 的
  const otherIds = new Set(favoriteSeed.filter((f) => f.userId === USER_B).map((f) => f.productId));
  for (const item of result.items) {
    assert.equal(otherIds.has(item.productId), false);
  }
  const other = await list(USER_B);
  assert.equal(other.total, 2);
  assert.deepEqual(
    other.items.map((item) => item.productId).sort(),
    ["p-vr-1", "p-vt-1"],
  );
});

test("收藏同一商品是幂等的：不产生第二条记录", async () => {
  const first = await addFavoriteForUser(USER_A, { productId: FREE_PRODUCT }, undefined, "server");
  const second = await addFavoriteForUser(USER_A, { productId: FREE_PRODUCT }, undefined, "server");

  assert.equal(first.created, true);
  assert.equal(first.favorited, true);
  assert.equal(second.created, false);
  assert.equal(second.favorited, true);

  // 记录数只增加一次
  const result = await list(USER_A);
  assert.equal(result.total, 15);
  assert.equal(result.items.filter((item) => item.productId === FREE_PRODUCT).length, 1);

  // 详情页读到的状态也是已收藏
  assert.equal(await isFavoritedForUser(USER_A, FREE_PRODUCT, undefined, "server"), true);
});

test("取消收藏是幂等的：没收藏过也返回成功", async () => {
  const first = await removeFavoriteForUser(USER_A, OFF_SHELF_PRODUCT, undefined, "server");
  const second = await removeFavoriteForUser(USER_A, OFF_SHELF_PRODUCT, undefined, "server");

  assert.equal(first.favorited, false);
  assert.equal(first.created, true);
  assert.equal(second.favorited, false);
  assert.equal(second.created, false);

  // 商品已从收藏里消失，记录数相应减少
  const result = await list(USER_A);
  assert.equal(result.total, 13);
  assert.equal(result.items.some((item) => item.productId === OFF_SHELF_PRODUCT), false);

  // 完全没收藏过的商品：同样安全
  const untouched = await removeFavoriteForUser(USER_A, "p-never-added", undefined, "server");
  assert.equal(untouched.created, false);
  assert.equal((await list(USER_A)).total, 13);
});

test("已下架商品不能新增收藏；已收藏的下架商品仍能安全展示", async () => {
  // 1. 已下架 + 尚未收藏 → 400
  await removeFavoriteForUser(USER_A, OFF_SHELF_PRODUCT, undefined, "server");
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: OFF_SHELF_PRODUCT }, undefined, "server"),
    "BAD_REQUEST",
    FAVORITE_OFF_SHELF_MESSAGE,
  );
  assert.equal(await isFavoritedForUser(USER_A, OFF_SHELF_PRODUCT, undefined, "server"), false);

  // 2. 已收藏的下架商品：列表里仍能取到，状态是「已下架」且商品信息完整可展示
  //    （用最大页长一次取全：这条记录排在第 13 位，默认页长取不到它）
  resetMockStore("favorite");
  const result = await list(USER_A, page({ pageSize: FAVORITE_MAX_PAGE_SIZE }));
  assert.equal(result.items.length, 14);
  const offShelf = result.items.find((item) => item.productId === OFF_SHELF_PRODUCT);
  assert.ok(offShelf, "预置的已下架收藏必须还在列表里");
  assert.equal(offShelf.state, "off_shelf");
  assert.equal(offShelf.stateLabel, FAVORITE_STATE_LABELS.off_shelf);
  assert.equal(offShelf.product.id, OFF_SHELF_PRODUCT);
  assert.ok(offShelf.product.title);
  assert.ok(Number.isInteger(offShelf.product.price));

  // 3. 下架商品**可以**被取消收藏（清数据是安全的）
  const removed = await removeFavoriteForUser(USER_A, OFF_SHELF_PRODUCT, undefined, "server");
  assert.equal(removed.favorited, false);
});

test("商品已不存在时列表不崩溃：状态为 missing 且商品字段为空", async () => {
  const result = await list(USER_A, page({ pageSize: FAVORITE_MAX_PAGE_SIZE }));
  const missing = result.items.find((item) => item.productId === MISSING_PRODUCT);

  assert.ok(missing, "预置的「商品已删除」收藏必须还能取到");
  assert.equal(missing.state, "missing");
  assert.equal(missing.stateLabel, FAVORITE_STATE_LABELS.missing);
  assert.equal(missing.product, null);
  // 记录本身还在，用户能把它移除
  assert.ok(missing.id);
  assert.ok(missing.createdAt);

  // 其他项不受这条脏数据影响
  assert.ok(result.items.some((item) => item.state === "available"));
});

test("商品不存在不能新增收藏：404，且不产生记录", async () => {
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: MISSING_PRODUCT }, undefined, "server"),
    "NOT_FOUND",
    FAVORITE_PRODUCT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: "p-not-exist-at-all" }, undefined, "server"),
    "NOT_FOUND",
    FAVORITE_PRODUCT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    addFavoriteForUser(USER_A, {}, undefined, "server"),
    "BAD_REQUEST",
    FAVORITE_PRODUCT_REQUIRED_MESSAGE,
  );
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: "   " }, undefined, "server"),
    "BAD_REQUEST",
    FAVORITE_PRODUCT_REQUIRED_MESSAGE,
  );

  assert.equal((await list(USER_A)).total, 14);
});

test("用户隔离：A 与 B 的收藏完全分开", async () => {
  // 预置数据里 p-vt-1 只属于 B：A 从来没收藏过它
  assert.equal(await isFavoritedForUser(USER_A, "p-vt-1", undefined, "server"), false);
  assert.equal(await isFavoritedForUser(USER_B, "p-vt-1", undefined, "server"), true);
  // p-400w 反过来只属于 A
  assert.equal(await isFavoritedForUser(USER_A, "p-400w", undefined, "server"), true);
  assert.equal(await isFavoritedForUser(USER_B, "p-400w", undefined, "server"), false);

  // A 收藏一件 B 已经收藏的商品：同一商品在两个用户下各有一条记录，互不干扰
  await addFavoriteForUser(USER_A, { productId: "p-vt-1" }, undefined, "server");
  // B 收藏一件 A 已经收藏的商品
  await addFavoriteForUser(USER_B, { productId: "p-400w" }, undefined, "server");

  const a = await list(USER_A);
  const b = await list(USER_B);
  assert.equal(a.total, 15);
  assert.equal(b.total, 3);

  // 记录 id 从不交叉：谁的收藏只出现在谁的列表里
  const aIds = new Set(a.items.map((item) => item.id));
  const bIds = new Set(b.items.map((item) => item.id));
  for (const id of bIds) assert.equal(aIds.has(id), false, `${id} 不应出现在 A 的列表里`);
  assert.equal(aIds.has("fav-1002-01"), false);
  assert.equal(bIds.has("fav-1001-01"), false);

  // 取消 A 的收藏不动 B 的
  await removeFavoriteForUser(USER_A, "p-400w", undefined, "server");
  assert.equal(await isFavoritedForUser(USER_A, "p-400w", undefined, "server"), false);
  assert.equal(await isFavoritedForUser(USER_B, "p-400w", undefined, "server"), true);
  assert.equal((await list(USER_B)).total, 3);
});

test("分页不重复、不遗漏：两页拼起来正好是全部收藏", async () => {
  const first = await list(USER_A, page({ pageSize: FAVORITE_PAGE_SIZE }));
  const second = await list(USER_A, page({ page: 2, pageSize: FAVORITE_PAGE_SIZE }));

  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 4);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);

  const ids = [...first.items, ...second.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 14);

  // 两页拼起来正好等于「按收藏时间倒序」的全部记录，顺序也一致
  const expected = favoriteSeed
    .filter((favorite) => favorite.userId === USER_A)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((favorite) => favorite.id);
  assert.deepEqual(ids, expected);

  // 重复取同一页合并：去重后条数不变（「加载更多」连点两次的兜底）
  const merged = mergeFavoritePage(first, first);
  assert.equal(merged.items.length, 10);
  assert.equal(merged.hasMore, true);

  // 越界页码规范化：不是数字 / 0 / 负数 / 超大值都不会抛错
  for (const raw of ["abc", "0", "-3", "99999", ""]) {
    const result = await list(USER_A, page({ page: raw }));
    assert.ok(result.page >= 1);
    assert.ok(Array.isArray(result.items));
  }
});

test("列表项 DTO 不含交易快照之外的隐私字段，也不含商品状态原文", async () => {
  const result = await list(USER_A);
  const item = result.items.find((row) => row.state === "available");

  assert.deepEqual(
    Object.keys(item).sort(),
    ["createdAt", "id", "product", "productId", "state", "stateLabel"],
  );
  assert.deepEqual(
    Object.keys(item.product).sort(),
    ["coverUrl", "id", "price", "subtitle", "title"],
  );
  // 状态只以 state / stateLabel 表达，不把商品表的 status 原文透出去
  assert.equal("status" in item, false);
  assert.equal("userId" in item, false);
});

test("收藏记录只存商品引用，没有交易快照", () => {
  for (const favorite of favoriteSeed) {
    assert.deepEqual(Object.keys(favorite).sort(), ["createdAt", "id", "productId", "userId"]);
  }
  // 预置数据里四种情况都存在，页面才能被完整验收
  const productIds = new Set(favoriteSeed.map((f) => f.productId));
  assert.ok(productIds.has(OFF_SHELF_PRODUCT));
  assert.ok(productIds.has(MISSING_PRODUCT));
});

test("纯规则函数：分页解析收敛到安全范围", () => {
  const fallback = parseFavoriteListQuery(page());
  assert.equal(fallback.page, 1);
  assert.equal(fallback.pageSize, FAVORITE_PAGE_SIZE);

  assert.equal(parseFavoriteListQuery(page({ pageSize: 999 })).pageSize, FAVORITE_MAX_PAGE_SIZE);
  assert.equal(parseFavoriteListQuery(page({ pageSize: -1 })).pageSize, FAVORITE_PAGE_SIZE);
  assert.equal(parseFavoriteListQuery(page({ page: "abc" })).page, 1);
});
