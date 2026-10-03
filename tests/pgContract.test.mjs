import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { pgFavoriteRepository } from "../lib/data/pg/favoriteRepository.ts";
import { pgSuggestionRepository } from "../lib/data/pg/suggestionRepository.ts";
import { mockFavoriteRepository } from "../lib/data/mockFavoriteRepository.ts";
import { mockSuggestionRepository } from "../lib/data/mockSuggestionRepository.ts";
import { resetAllMockStores } from "../lib/data/mockStore.ts";
import { favoriteSeed, REMOVED_PRODUCT_ID } from "../lib/mocks/fixtures/favoriteSeed.ts";
import { suggestionSeed } from "../lib/mocks/fixtures/suggestionSeed.ts";

/**
 * PROD-1A · **契约等价性**：Mock 与 PostgreSQL 在同一份数据上必须给出相同结果。
 *
 * ## 为什么这一组用例是竖切片的核心交付
 *
 * 「换实现不改上层」这句话很容易说，但很难证。真正要证的是：
 * **两个实现在同一份输入下的输出逐字段相同**——否则「切换数据源」只是把 bug
 * 从一个实现搬到另一个实现，而页面上看不出区别。
 *
 * 因此这里**不重复写两套断言**。做法是：把要观察的东西写成一段「快照函数」，
 * 拿同一个函数分别去问两个实现，然后 `deepEqual` 两份结果。
 * 断言因此是**对称**的——它不偏向任何一个实现，也不会出现「只给 Pg 写了断言」。
 *
 * ## 数据基线怎么保证一致
 *
 * Mock 建仓时读 `lib/mocks/fixtures/*`，Pg 走 `seedDatabase` 读**同一批常量**。
 * 两边因此装着同样的 16 条收藏与 3 条反馈，包括那些边界数据：
 * 已下架商品、已从数据源删除的商品（`REMOVED_PRODUCT_ID`）、另一个用户的收藏、
 * 三个状态的反馈。少了这一步，后面的「结果相同」什么也说明不了。
 *
 * ## 没配测试库时跳过
 *
 * 与 `pgFoundation.test.mjs` 同一套规则：没有 `TEST_DATABASE_URL` 就整体 `skip`。
 */

const TEST_URL = process.env.TEST_DATABASE_URL;
const SKIP = TEST_URL ? false : "需要 TEST_DATABASE_URL（.env 里的测试库连接串）";

if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const FAVORITES = { mock: mockFavoriteRepository, pg: pgFavoriteRepository };
const SUGGESTIONS = { mock: mockSuggestionRepository, pg: pgSuggestionRepository };

before(async () => {
  if (SKIP) return;
  await closePool();
  process.env.DATABASE_URL = TEST_URL;
  await migrate(getPgExecutor());
});

beforeEach(async () => {
  if (SKIP) return;
  // 两边都回到预置状态：Mock 换掉本进程的存储，Pg 清库重种
  resetAllMockStores();
  await resetDatabase(getPgExecutor());
  await seedDatabase(getPgExecutor());
});

after(async () => {
  if (SKIP) return;
  await closePool();
});

/**
 * 同一段观察逻辑，对**同一对**实现各跑一遍，然后比对。
 *
 * ⚠️ `pair` 必须显式传进来：早先这个函数把收藏的两个实现写死在函数体里，
 * 于是反馈那一格实际上拿收藏仓储去调 `querySuggestions`——两边一起报
 * `is not a function`，`deepEqual` 反而**通过**了。断言比对的是两个错误，
 * 比对得再认真也没有意义。这类「辅助函数悄悄固定了被测对象」的坑，
 * 会让整组对照退化成自我印证，所以接口成对传参、不设默认值。
 *
 * @param pair `{ mock, pg }` 两个实现
 */
async function assertSameObservation(pair, observe, label) {
  // 先确认两个实现暴露的是**同一组方法**。契约的第一步是「同一个形状」，
  // 形状不对时后面的结果比对没有意义。
  assert.deepEqual(
    Object.keys(pair.pg).sort(),
    Object.keys(pair.mock).sort(),
    `${label}：两个实现暴露的方法集合必须一致`,
  );

  const [fromMock, fromPg] = await Promise.all([observe(pair.mock), observe(pair.pg)]);
  assert.deepEqual(fromPg, fromMock, `${label}：Pg 与 Mock 的结果必须逐字段相同`);
  return fromMock;
}

// ————————————————————————— 读侧：同一份数据 → 同一个结果 —————————————————————————

test("收藏的每一个读法都给出相同结果：分页、越界页、空用户、单条、已删除商品", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    FAVORITES,
    async (repo) => ({
      page1: await repo.queryFavorites({ userId: "u-1001", page: 1, pageSize: 10 }),
      page2: await repo.queryFavorites({ userId: "u-1001", page: 2, pageSize: 10 }),
      // 越界页：items 为空，但 total 与 hasMore 仍要正确——这一格最容易两边不一致
      beyond: await repo.queryFavorites({ userId: "u-1001", page: 99, pageSize: 10 }),
      // 整除边界的下一格
      thirdPage: await repo.queryFavorites({ userId: "u-1001", page: 3, pageSize: 7 }),
      otherUser: await repo.queryFavorites({ userId: "u-1002", page: 1, pageSize: 10 }),
      // 一条收藏都没有的用户：空态两侧必须一样
      noFavorites: await repo.queryFavorites({ userId: "u-nobody", page: 1, pageSize: 10 }),
      found: await repo.findFavorite("u-1001", "p-400w"),
      notFound: await repo.findFavorite("u-1001", "p-does-not-exist"),
      // 商品已从数据源删除，但收藏记录还在（`FavoriteState` 的 missing 场景）
      danglingProduct: await repo.findFavorite("u-1001", REMOVED_PRODUCT_ID),
    }),
    "收藏读侧",
  );

  // 顺手把「预置数据的形状」钉住：数字对不上时说明种子或迁移哪边漏了数据
  assert.equal(observed.page1.total, favoriteSeed.filter((f) => f.userId === "u-1001").length);
  assert.equal(observed.page1.items.length, 10);
  assert.equal(observed.page1.hasMore, true);
  assert.equal(observed.page2.items.length, 4);
  assert.equal(observed.beyond.items.length, 0);
  assert.equal(observed.beyond.total, observed.page1.total);
  assert.equal(observed.noFavorites.total, 0);
  assert.ok(observed.danglingProduct, "已删除商品的收藏记录两边都必须还在");
});

test("反馈的每一个读法都给出相同结果：分页、三个状态、按幂等键查空", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    SUGGESTIONS,
    async (repo) => ({
      page1: await repo.querySuggestions({ userId: "u-1001", page: 1, pageSize: 10 }),
      beyond: await repo.querySuggestions({ userId: "u-1001", page: 5, pageSize: 10 }),
      noSuggestions: await repo.querySuggestions({ userId: "u-nobody", page: 1, pageSize: 10 }),
      // 预置数据没有幂等键：两个实现都必须查不到（Mock 不往索引里放，Pg 存 NULL）
      bySeedId: await repo.findSuggestionByKey(suggestionSeed[0].userId, suggestionSeed[0].id),
      byUnknownKey: await repo.findSuggestionByKey("u-1001", "从来没有用过的键"),
    }),
    "反馈读侧",
  );

  assert.equal(observed.page1.total, suggestionSeed.filter((s) => s.userId === "u-1001").length);
  assert.equal(observed.bySeedId, null);
  assert.equal(observed.byUnknownKey, null);

  // 凭证是 jsonb / 内存数组两种完全不同的载体，读出来必须一模一样
  const withEvidence = observed.page1.items.find((item) => item.evidence.length > 0);
  assert.ok(withEvidence, "预置里应当有一条带凭证的反馈");
  assert.equal(typeof withEvidence.evidence[0].url, "string");
});

// ————————————————————————— 排序：完全确定，分页不重不漏 —————————————————————————

test("收藏排序完全确定：逐页拼起来等于整体，且没有重复 id", { skip: SKIP }, async () => {
  const all = [];

  for (const name of ["mock", "pg"]) {
    const repo = FAVORITES[name];
    const collected = [];

    // 每页 3 条，一路翻到底——分页边界把排序里所有「时间相同」的位置都压过一遍
    for (let page = 1; page <= 10; page += 1) {
      const result = await repo.queryFavorites({ userId: "u-1001", page, pageSize: 3 });
      collected.push(...result.items);
      if (!result.hasMore) break;
    }

    const ids = collected.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, `${name}：分页出现了重复条目`);
    assert.equal(collected.length, favoriteSeed.filter((f) => f.userId === "u-1001").length);

    // 时间倒序：翻页拼起来之后整体仍然有序
    const timestamps = collected.map((item) => item.createdAt);
    assert.deepEqual(timestamps, [...timestamps].sort().reverse(), `${name}：拼起来不是时间倒序`);

    all.push(collected);
  }

  assert.deepEqual(all[0], all[1], "两个实现在同一份数据上的顺序必须完全一致");
});

// ————————————————————————— 写侧：幂等语义逐字段一致 —————————————————————————

test("收藏的写入语义一致：新增 → 幂等命中 → 取消 → 再取消 → 重新新增", { skip: SKIP }, async () => {
  const sequence = async (repo) => ({
    first: await repo.addFavorite({
      id: "fav-contract-1",
      userId: "u-contract",
      productId: "p-contract",
      createdAt: "2026-10-01T00:00:00.000Z",
    }),
    // 同「用户 + 商品」，换一个 id、换一个时间：两个实现都必须返回**第一条**
    replay: await repo.addFavorite({
      id: "fav-contract-2",
      userId: "u-contract",
      productId: "p-contract",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    removed: await repo.removeFavorite("u-contract", "p-contract"),
    // 取消一个已经不存在的：幂等，不报错
    removedAgain: await repo.removeFavorite("u-contract", "p-contract"),
    // 键空出来之后可以重新新增
    reAdded: await repo.addFavorite({
      id: "fav-contract-3",
      userId: "u-contract",
      productId: "p-contract",
      createdAt: "2026-10-03T00:00:00.000Z",
    }),
  });

  const fromMock = await sequence(FAVORITES.mock);
  const fromPg = await sequence(FAVORITES.pg);

  assert.deepEqual(fromPg, fromMock, "写入路径的每一步返回值都必须相同");
  assert.equal(fromMock.first.created, true);
  assert.equal(fromMock.replay.created, false);
  assert.equal(fromMock.replay.favorite.id, "fav-contract-1", "幂等命中返回的是既有那条");
  assert.deepEqual(fromMock.removedAgain, { removed: false });
  assert.equal(fromMock.reAdded.created, true);
});

test("反馈的写入语义一致：新建 → 同键重放 → 换键是另一条", { skip: SKIP }, async () => {
  const build = (id, content) => ({
    id,
    userId: "u-contract",
    typeKey: "other",
    typeLabel: "其他",
    content,
    contact: "",
    evidence: [],
    status: "submitted",
    reply: "",
    repliedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  });

  const sequence = async (repo) => ({
    first: await repo.createSuggestion(build("sug-contract-1", "第一次提交"), "key-contract"),
    // 同一个幂等键、内容不同：必须返回第一次的结果，而不是新建一条
    replay: await repo.createSuggestion(build("sug-contract-2", "重试时的内容"), "key-contract"),
    // 换一个键：本来就应该是一条新记录
    another: await repo.createSuggestion(build("sug-contract-3", "另一件事"), "key-other"),
    lookup: await repo.findSuggestionByKey("u-contract", "key-contract"),
  });

  const fromMock = await sequence(SUGGESTIONS.mock);
  const fromPg = await sequence(SUGGESTIONS.pg);

  assert.deepEqual(fromPg, fromMock, "反馈写入路径的每一步返回值都必须相同");
  assert.equal(fromMock.first.created, true);
  assert.equal(fromMock.replay.created, false);
  assert.equal(fromMock.replay.suggestion.id, "sug-contract-1");
  assert.equal(fromMock.replay.suggestion.content, "第一次提交");
  assert.equal(fromMock.another.created, true);
  assert.equal(fromMock.lookup.id, "sug-contract-1");
});

// ————————————————————————— 契约测试本身要能发现分歧 —————————————————————————

test("这组对照是有分辨力的：把 Pg 的页大小改掉，比对立刻失败", { skip: SKIP }, async () => {
  // 一条**反向**用例。没有它，「两个实现结果相同」有可能只是因为断言太松、
  // 或者两边都被同一个 bug 影响。这里人为制造一处分歧，确认对照确实会红。
  const distorted = {
    ...FAVORITES.pg,
    queryFavorites: async (query) =>
      FAVORITES.pg.queryFavorites({ ...query, pageSize: query.pageSize + 1 }),
  };

  const observeBoth = async (repo) => repo.queryFavorites({ userId: "u-1001", page: 1, pageSize: 5 });

  assert.deepEqual(
    await observeBoth(FAVORITES.mock),
    await observeBoth(FAVORITES.pg),
    "正常情况下两者一致",
  );

  await assert.rejects(
    async () => {
      assert.deepEqual(await observeBoth(FAVORITES.mock), await observeBoth(distorted));
    },
    (error) => {
      assert.ok(error instanceof assert.AssertionError, "制造出的分歧必须被断言抓住");
      return true;
    },
  );
});
