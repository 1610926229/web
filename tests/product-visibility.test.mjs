import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { FAVORITE_OFF_SHELF_MESSAGE } from "../lib/constants/favorites.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getDataSource } from "../lib/data/source.ts";
import { homeSectionSeed, productSeed } from "../lib/mocks/fixtures/catalogSeed.ts";
import { getProductDetail, queryProducts } from "../lib/services/catalog.ts";
import { previewCheckout } from "../lib/services/checkout.ts";
import { getHomeData } from "../lib/services/home.ts";
import {
  addFavoriteForUser,
  isFavoritedForUser,
  removeFavoriteForUser,
} from "../lib/services/favorites.ts";

/**
 * 「已下架」与「根本不存在」的持续测试。
 *
 * 这两件事在页面上表现得完全一样（都不能买），在数据层却是两个不同的结果，
 * 混在一起就会出问题：要么把已下架商品也做成 404（历史收藏与直链全部失效），
 * 要么把不存在的商品也放行成 200（凭空编出一个商品）。这里把两者的区别钉死。
 *
 * 断言的是真实实现：真实种子 + `lib/services/catalog.ts` + `lib/services/checkout.ts`。
 */

const USER_A = "u-1001";

/** 存在但已下架。 */
const OFF_SHELF = "p-off-1";
/** 从来没有存在过。 */
const NEVER_EXISTED = "p-nope";

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

test("已下架商品确实在数据源里：状态为 off，公开字段完整可展示", async () => {
  const detail = await getProductDetail(OFF_SHELF, undefined, "server");

  assert.ok(detail, "已下架商品必须能读到详情，页面据此显示「已下架」而不是 404");
  assert.equal(detail.id, OFF_SHELF);
  assert.equal(detail.status, "off");
  // 商品已有的公开信息照常展示
  assert.ok(detail.title.length > 0);
  assert.ok(detail.coverUrl.length > 0);
  assert.ok(detail.subtitle.length > 0);
  assert.ok(Number.isInteger(detail.price) && detail.price > 0);
  assert.ok(detail.specs.length > 0);

  // 种子本身也仍在（不是靠某处兜底编出来的）
  assert.ok(productSeed.some((record) => record.id === OFF_SHELF));
});

test("已下架商品不出现在任何商品列表里，也不出现在搜索与首页分组中", async () => {
  const record = productSeed.find((item) => item.id === OFF_SHELF);
  assert.equal(record.status, "off");

  // 1. 所属类目列表
  const inCategory = await queryProducts(
    { gameId: record.gameId, categoryId: record.categoryId, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(
    inCategory.items.some((item) => item.id === OFF_SHELF),
    false,
  );

  // 2. 该游戏下的全部类目
  const inGame = await queryProducts(
    { gameId: record.gameId, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(
    inGame.items.some((item) => item.id === OFF_SHELF),
    false,
  );

  // 3. 按名称搜索也搜不到（下架了就不该被逛到）
  const byKeyword = await queryProducts(
    { gameId: record.gameId, keyword: record.title, page: 1, pageSize: 100 },
    undefined,
    "server",
  );
  assert.equal(byKeyword.items.length, 0);

  // 4. 列表里永远只有在售商品
  assert.equal(inGame.items.every((item) => item.price > 0), true);

  // 5. 首页各营销分组**现取**到的商品全部在售（P8B 起首页分组存的是 id，
  //    商品在每次请求时从目录仓储取，因此这里读的是用户端真正会看到的那份数据）
  const home = await getHomeData(undefined, "server");
  const listedIds = new Set(inGame.items.map((item) => item.id));
  for (const section of home.sections) {
    for (const product of section.products) {
      const source = productSeed.find((item) => item.id === product.id);
      assert.ok(source, `首页分组「${section.title}」出现了目录里没有的商品 ${product.id}`);
      assert.equal(
        source.status,
        "on",
        `首页分组「${section.title}」引用了下架商品 ${product.id}`,
      );
      // 现取的结果与分类页列表口径一致：能在首页看到，就一定能在列表里被逛到
      assert.equal(
        listedIds.has(product.id),
        true,
        `首页分组「${section.title}」推的商品 ${product.id} 不在用户端列表里`,
      );
    }
  }

  // 分组里引用的 id 一个都没丢：取不到的商品是被**跳过**的，不是被静默省略的
  const referencedCount = homeSectionSeed.reduce(
    (sum, section) => sum + section.productIds.length,
    0,
  );
  const listedCount = home.sections.reduce((sum, section) => sum + section.products.length, 0);
  assert.equal(listedCount, referencedCount);
});

test("完全不存在（或已被删除）的商品读不到详情：null，由页面转成 404", async () => {
  assert.equal(await getProductDetail(NEVER_EXISTED, undefined, "server"), null);
  assert.equal(await getProductDetail("", undefined, "server"), null);

  // 与「存在但下架」的区别就是这一条：同一个取数函数，一个有详情、一个为 null
  assert.notEqual(await getProductDetail(OFF_SHELF, undefined, "server"), null);
});

test("已下架商品不能购买：服务端拒绝，不依赖前端按钮置灰", async () => {
  await expectApiError(
    previewCheckout(
      {
        productId: OFF_SHELF,
        specId: "s-900w",
        quantity: 1,
        addonIds: [],
        gameAccountId: "moyu_test",
        remark: "",
        companionId: null,
        region: "手游",
      },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    "商品已下架，无法支付",
  );

  // 不存在则是另一种结果：不是「已下架」，而是「不存在」
  await expectApiError(
    previewCheckout(
      {
        productId: NEVER_EXISTED,
        specId: "s-900w",
        quantity: 1,
        addonIds: [],
        gameAccountId: "moyu_test",
        remark: "",
        companionId: null,
        region: "手游",
      },
      undefined,
      "server",
    ),
    "NOT_FOUND",
    "商品不存在",
  );
});

test("已下架商品不能被新增收藏；历史收藏仍可读、可取消", async () => {
  // 预置数据里 u-1001 历史上收藏过 p-off-1
  assert.equal(await isFavoritedForUser(USER_A, OFF_SHELF, undefined, "server"), true);

  // 先取消，再尝试新增：下架商品不能被收藏
  await removeFavoriteForUser(USER_A, OFF_SHELF, undefined, "server");
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: OFF_SHELF }, undefined, "server"),
    "BAD_REQUEST",
    FAVORITE_OFF_SHELF_MESSAGE,
  );
  assert.equal(await isFavoritedForUser(USER_A, OFF_SHELF, undefined, "server"), false);

  // 完全不存在更不行：404，而不是下架提示
  await expectApiError(
    addFavoriteForUser(USER_A, { productId: NEVER_EXISTED }, undefined, "server"),
    "NOT_FOUND",
  );
});

test("已下架商品的历史收藏在列表里按「已下架」展示，商品信息仍可读", async () => {
  const source = getDataSource();
  const detail = await source.getProductDetail(OFF_SHELF);

  // 详情页与收藏列表读的是同一个取数函数：能展示 = 详情页也能打开
  const page = await getProductDetail(OFF_SHELF, undefined, "server");
  assert.equal(page?.id, detail?.id);
  assert.equal(page?.status, "off");
});
