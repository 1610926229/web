import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { getPgExecutor } from "../lib/data/pg/executor.ts";
import { migrate } from "../lib/data/pg/migrate.ts";
import { closePool } from "../lib/data/pg/pool.ts";
import { resetDatabase } from "../lib/data/pg/reset.ts";
import { seedDatabase } from "../lib/data/pg/seed.ts";
import { pgFavoriteRepository } from "../lib/data/pg/favoriteRepository.ts";
import { pgSuggestionRepository } from "../lib/data/pg/suggestionRepository.ts";
import { pgDispatchRepository } from "../lib/data/pg/dispatchRepository.ts";
import { pgCompanionRepository } from "../lib/data/pg/companionRepository.ts";
import { pgCompletionRepository } from "../lib/data/pg/completionRepository.ts";
import { pgEarningRepository } from "../lib/data/pg/earningRepository.ts";
import { pgNotificationRepository } from "../lib/data/pg/notificationRepository.ts";
import { pgPaymentRepository } from "../lib/data/pg/paymentRepository.ts";
import { pgCompanionAcceptRepository } from "../lib/data/pg/companionAcceptRepository.ts";
import { pgCompanionReleaseRepository } from "../lib/data/pg/companionReleaseRepository.ts";
import { pgCompanionServiceRepository } from "../lib/data/pg/companionServiceRepository.ts";
import { pgRefundRepository } from "../lib/data/pg/refundRepository.ts";
import { pgComplaintRepository } from "../lib/data/pg/complaintRepository.ts";
import { pgPlatformConfigRepository } from "../lib/data/pg/platformConfigRepository.ts";
import { pgCouponRepository } from "../lib/data/pg/couponRepository.ts";
import { mockFavoriteRepository } from "../lib/data/mockFavoriteRepository.ts";
import { mockSuggestionRepository } from "../lib/data/mockSuggestionRepository.ts";
import { mockDispatchRepository } from "../lib/data/mockDispatchRepository.ts";
import { mockCompanionAcceptRepository } from "../lib/data/mockCompanionAcceptRepository.ts";
import { mockCompanionReleaseRepository } from "../lib/data/mockCompanionReleaseRepository.ts";
import { mockCompanionServiceRepository } from "../lib/data/mockCompanionServiceRepository.ts";
import { mockRefundRepository } from "../lib/data/mockRefundRepository.ts";
import { mockComplaintRepository } from "../lib/data/mockComplaintRepository.ts";
import { mockPlatformConfigRepository } from "../lib/data/mockPlatformConfigRepository.ts";
import { mockCouponRepository } from "../lib/data/mockCouponRepository.ts";
import { mockCompanionRepository } from "../lib/data/mockCompanionRepository.ts";
import { mockCompletionRepository } from "../lib/data/mockCompletionRepository.ts";
import { mockEarningRepository } from "../lib/data/mockEarningRepository.ts";
import { mockNotificationRepository } from "../lib/data/mockNotificationRepository.ts";
import { mockPaymentRepository } from "../lib/data/mockPaymentRepository.ts";
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

/* ═══════════════ PROD-1B · W1 订单写闭包的仓储契约等价 ═══════════════ */

/**
 * W1 每一张表的 Mock 实现 ↔ Pg 实现。
 *
 * ⚠️ 这一组**只比读**。写路径不在仓储接口上：接单、完成材料、退款、收益冻结
 * 全部发生在事务里，它们的等价性由 `pgW1Transactions.test.mjs` 用真事务与并发证明，
 * 在仓储这一层再写一遍只会得到两份各自演进的断言。
 *
 * ⚠️ **顺序是唯一被允许的差异，而且必须显式归一化**。Mock 的列表读是「遍历 Map
 * 的插入顺序」，Pg 的列表读是 `ORDER BY`——两者在 SQL 里本来就没有同一个定义，
 * 实现里有意的取舍是「Pg 补一个稳定全序」。因此这里一律先 `byId()` 再比：
 * 断言的是**内容相同**，不是**先后相同**。若哪一天某张表的顺序也被要求一致，
 * 那应当是一条单独的、写明了排序口径的用例，而不是靠 deepEqual 顺带覆盖。
 */
const W1_PAIRS = {
  dispatch: { mock: mockDispatchRepository, pg: pgDispatchRepository },
  companion: { mock: mockCompanionRepository, pg: pgCompanionRepository },
  completion: { mock: mockCompletionRepository, pg: pgCompletionRepository },
  earning: { mock: mockEarningRepository, pg: pgEarningRepository },
  notification: { mock: mockNotificationRepository, pg: pgNotificationRepository },
  orders: { mock: mockPaymentRepository, pg: pgPaymentRepository },
  accept: { mock: mockCompanionAcceptRepository, pg: pgCompanionAcceptRepository },
  release: { mock: mockCompanionReleaseRepository, pg: pgCompanionReleaseRepository },
  service: { mock: mockCompanionServiceRepository, pg: pgCompanionServiceRepository },
  refund: { mock: mockRefundRepository, pg: pgRefundRepository },
  complaint: { mock: mockComplaintRepository, pg: pgComplaintRepository },
  platformConfig: { mock: mockPlatformConfigRepository, pg: pgPlatformConfigRepository },
  coupon: { mock: mockCouponRepository, pg: pgCouponRepository },
};

/** 按 `id` 归一化顺序：`byId(list)[0]` 因此在两个实现里选中同一条。 */
function byId(items) {
  return byIdField(items, "id");
}

/**
 * 按任意字段归一化顺序。
 *
 * ⚠️ 派生事件（`DerivedAcceptEvent` / `DerivedServiceEvent`）**没有 `id`**——
 * 它们的身份是派单记录派生的。对它们用 `byId` 会拿 `undefined` 去比较，
 * 排序退化成「碰运气稳定」，于是两侧的顺序差被读成内容差。
 */
function byIdField(items, key) {
  return [...items].sort((a, b) => {
    const left = String(a[key]);
    const right = String(b[key]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

test("派单读侧等价：开放派单全量、按订单查、查不到", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.dispatch,
    async (repo) => {
      const open = byId(await repo.listOpenDispatches());
      return {
        open,
        // 用两边的**同一张**单去查：先归一化再取第一条，选中的 id 才必然相同
        found: open[0] ? await repo.findDispatchByOrderId(open[0].orderId) : null,
        missing: await repo.findDispatchByOrderId("ord-does-not-exist"),
      };
    },
    "派单读侧",
  );

  assert.ok(observed.open.length > 0, "预置数据里应当有开放中的派单");
  assert.equal(observed.missing, null);
  assert.equal(observed.found.id, observed.open[0].id);
});

test("护航读侧等价：全量、按 id、按用户、公开列表与后台列表", { skip: SKIP }, async () => {
  await assertSameObservation(
    W1_PAIRS.companion,
    async (repo) => ({
      all: byId(await repo.listCompanions()),
      forAdmin: byId(await repo.listCompanionsForAdmin()),
      byId: await repo.findCompanionById("cp-1"),
      missing: await repo.findCompanionById("cp-does-not-exist"),
      // 关联了用户账号的那一位；没有关联的（`user_id` 为空）必须查不到
      byUser: await repo.findCompanionByUser("u-1022"),
      byUserWithoutAccount: await repo.findCompanionByUser("u-9999"),
      // 公开列表：下架与已移除都不出现。
      // ⚠️ `availability` 用 `"all"` 而不是 `""`：公开页的服务层永远传
      // `availability ?? "all"`（`lib/services/companions.ts:69`），`""` 在公开路径上
      // **不可达**；而 Mock 把 `""` 当成「只看不可用」——见下面那条「已知差异」用例。
      listed: byId(
        await repo.queryCompanions({
          keyword: "",
          gameId: "",
          enabled: "",
          availability: "all",
          removal: "active",
        }),
      ),
      keywordHit: byId(
        await repo.queryCompanions({
          keyword: "机",
          gameId: "",
          enabled: "",
          availability: "all",
          removal: "active",
        }),
      ),
      adminFiltered: byId(
        await repo.queryCompanionsForAdmin({
          keyword: "",
          gameId: "",
          enabled: "",
          availability: "",
          removal: "active",
        }),
      ),
    }),
    "护航读侧",
  );
});

test("完成材料与收益读侧等价：按订单 / 按 id / 按护航 / 全量", { skip: SKIP }, async () => {
  await assertSameObservation(
    W1_PAIRS.completion,
    async (repo) => {
      // 从订单侧拿一个稳定的 id，而不是写死一个可能在种子里不存在的材料 id
      const orders = byId(await W1_PAIRS.dispatch.pg.listOpenDispatches());
      const orderId = orders[0]?.orderId ?? "ord-seed-1001-01";
      return {
        byOrder: await repo.findLatestCompletionByOrderId(orderId),
        missing: await repo.findCompletionById("cs-does-not-exist"),
        forStaff: byId(
          await repo.listCompletionsForStaff({ status: "", keyword: "", companionId: "" }),
        ),
      };
    },
    "完成材料读侧",
  );

  await assertSameObservation(
    W1_PAIRS.earning,
    async (repo) => {
      const all = byId(await repo.listAllEarnings());
      return {
        all,
        forCompanion: byId(await repo.listEarningsForCompanion(all[0]?.companionId ?? "cp-1")),
        byOrder: all[0] ? await repo.findEarningByOrderId(all[0].orderId) : null,
        missing: await repo.findEarningByOrderId("ord-does-not-exist"),
        adjustments: all[0] ? await repo.listAdjustmentsForEarning(all[0].id) : [],
      };
    },
    "收益读侧",
  );
});

test("通知读侧等价：按用户全量、按 id 查、查不到", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.notification,
    async (repo) => {
      const list = byId(await repo.listNotifications("u-1001"));
      return {
        list,
        byId: list[0] ? await repo.findNotificationById(list[0].id) : null,
        missing: await repo.findNotificationById("ntf-does-not-exist"),
        emptyUser: await repo.listNotifications("u-nobody"),
      };
    },
    "通知读侧",
  );

  assert.ok(observed.list.length > 0, "预置数据里 u-1001 应当有通知");
  assert.equal(observed.missing, null);
  assert.deepEqual(observed.emptyUser, []);
});

test("订单读侧等价：按 id、按用户、按履约护航、全量与后台筛选", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.orders,
    async (repo) => {
      const all = byId(await repo.listAllOrders());
      const first = all[0] ?? null;
      const serving = all.find((order) => order.status === "serving") ?? null;
      return {
        // 38 个字段逐字段比：这一格是 `w1Rows.ORDER_COLUMNS` 与 Mock 的唯一对照
        all,
        byId: first ? await repo.findOrderById(first.id) : null,
        missing: await repo.findOrderById("ord-does-not-exist"),
        byUser: first ? byId(await repo.listOrdersByUser(first.userId)) : [],
        byCompanion: serving ? byId(await repo.queryOrdersByCompanion(serving.actualCompanionId)) : [],
        adminFiltered: byId(
          await repo.queryOrdersForAdmin({
            status: null,
            gameName: "",
            userKeyword: "",
            from: "",
            to: "",
          }),
        ),
      };
    },
    "订单读侧",
  );

  assert.ok(observed.all.length > 0, "预置数据里应当有订单");
  assert.equal(observed.missing, null);
  assert.equal(typeof observed.all[0].actualPaidAmount, "number");
});

/**
 * **已知差异（登记，不修）**
 *
 * `queryCompanions({ availability: "" })` 两个实现给出的答案不同：
 *
 * | 实现 | `""` 的含义 |
 * |---|---|
 * | Mock | 落到 `availability === "available" ? … : !available` 的末枝 → **只看不可用** |
 * | Pg | 既不是 `"available"` 也不是 `"unavailable"` → **不加条件**（等于全部） |
 *
 * 这**不是** Pg 实现擅自改了规则，而是：`""` 在公开列表这条路径上**根本不可达**——
 * `lib/services/companions.ts:69` 永远传 `availability ?? "all"`。Mock 的末枝因此是
 * 一段只对「有人绕过服务层直接调仓储」才生效的行为。
 *
 * 按 Hard Rule 2「发现旧逻辑疑似有问题：登记，不擅自改」，本轮：
 * - **不改 Mock**（它是冻结的参照）；
 * - **不为对齐去掉 Pg 的合理行为**（把不可达输入按「全部」解释，比按「只看不可用」更符合
 *   这一层的字面意思）；
 * - **把这个差异写成一条断言**，而不是只写在交付文档里——文档会漂，测试不会。
 *   将来若有人把某一边改成另一边，这条用例会红，提醒他回来读这段注释并更新登记。
 */
test("已知差异：queryCompanions 传空 availability 时两侧口径不同（登记，不修）", { skip: SKIP }, async () => {
  const query = {
    keyword: "",
    gameId: "",
    enabled: "",
    availability: "",
    removal: "active",
  };

  const fromMock = await W1_PAIRS.companion.mock.queryCompanions(query);
  const fromPg = await W1_PAIRS.companion.pg.queryCompanions(query);

  // 「全部」这一侧本身已被上一条用例证明等价，因此可以拿它当**全集**来看这两支的差别
  const all = await W1_PAIRS.companion.pg.queryCompanions({ ...query, availability: "all" });
  const onlyUnavailable = all.filter((companion) => companion.available === false);

  assert.ok(onlyUnavailable.length > 0, "预置里应当有「休息中」的护航，否则这条差异无从观察");
  assert.deepEqual(byId(fromMock), byId(onlyUnavailable), "Mock 把空 availability 读成「只看不可用」");
  assert.deepEqual(byId(fromPg), byId(all), "Pg 把空 availability 读成「不加条件」，等价于 all");
});

test("接单 / 释放 / 服务事件读侧等价：全量与历史推导", { skip: SKIP }, async () => {
  await assertSameObservation(
    W1_PAIRS.accept,
    async (repo) => {
      const events = byId(await repo.listAcceptEvents());
      return {
        events,
        // 历史推导：`dispatch_records` 上已有 `accepted_at`、但事件表里没有对应行的那些
        // ⚠️ 派生事件没有 `id`，身份在 `dispatchId` 上
        legacy: byIdField(await repo.listLegacyAcceptEvents(), "dispatchId"),
      };
    },
    "接单事件读侧",
  );

  await assertSameObservation(
    W1_PAIRS.release,
    async (repo) => {
      const orderId = (await W1_PAIRS.orders.pg.listAllOrders())[0]?.id ?? "ord-seed-1001-01";
      return {
        byOrder: await repo.listReleasesByOrderId(orderId),
        byMissingOrder: await repo.listReleasesByOrderId("ord-does-not-exist"),
      };
    },
    "释放记录读侧",
  );

  await assertSameObservation(
    W1_PAIRS.service,
    async (repo) => ({
      events: byId(await repo.listServiceEvents()),
      // 派生事件同样没有 `id`：用 `orderId` 归一化
      legacy: byIdField(await repo.listLegacyServiceEvents(), "orderId"),
    }),
    "服务事件读侧",
  );
});

test("退款读侧等价：按 id / 按幂等键 / 按订单 / 后台筛选", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.refund,
    async (repo) => {
      const admin = byId(await repo.queryRefundsForAdmin({ statuses: null }));
      const first = admin[0] ?? null;
      return {
        admin,
        open: byId(await repo.queryRefundsForAdmin({ statuses: ["pending", "reviewing"] })),
        byId: first ? await repo.findRefundById(first.id) : null,
        // 预置退款**按任何幂等键都查不到**（Mock 不往索引里放、Pg 存 NULL）
        byKey: await repo.findRefundByKey("u-1001", "从来没有用过的键"),
        byOrder: first ? await repo.findRefundByOrderId(first.orderId) : null,
        listByOrder: first ? await repo.listRefundsByOrderId(first.orderId) : [],
        byMissingOrder: await repo.findRefundByOrderId("ord-does-not-exist"),
        missing: await repo.findRefundById("rf-does-not-exist"),
      };
    },
    "退款读侧",
  );

  assert.ok(observed.admin.length > 0, "预置数据里应当有退款申请");
  assert.equal(observed.byKey, null);
  assert.equal(observed.missing, null);
  assert.ok(observed.open.length <= observed.admin.length);
});

test("投诉读侧等价：分页、按 id / 幂等键 / 订单、后台筛选与订单统计", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.complaint,
    async (repo) => {
      const admin = byId(await repo.queryComplaintsForAdmin({ statuses: null, type: null }));
      const first = admin[0] ?? null;
      return {
        admin,
        open: byId(await repo.queryComplaintsForAdmin({ statuses: ["pending", "processing"], type: null })),
        // 分页口径：越界页的 items 为空、但 total 与 hasMore 仍要一致
        page1: await repo.queryComplaints({ userId: "u-1001", status: null, page: 1, pageSize: 3 }),
        beyond: await repo.queryComplaints({ userId: "u-1001", status: null, page: 99, pageSize: 3 }),
        noComplaints: await repo.queryComplaints({ userId: "u-nobody", status: null, page: 1, pageSize: 3 }),
        byId: first ? await repo.findComplaintById(first.id) : null,
        byKey: await repo.findComplaintByKey("u-1001", "从来没有用过的键"),
        byOrder: first ? await repo.listComplaintsByOrderId(first.orderId ?? "ord-does-not-exist") : [],
        stats: first ? await repo.summarizeComplaintsByOrder(first.orderId ?? "ord-does-not-exist") : null,
        missing: await repo.findComplaintById("cm-does-not-exist"),
      };
    },
    "投诉读侧",
  );

  assert.ok(observed.admin.length > 0, "预置数据里应当有投诉");
  assert.ok(observed.byId, "后台列表里的第一条按 id 必须查得到");
  assert.equal(observed.missing, null);
  assert.equal(observed.byKey, null);
  assert.equal(observed.beyond.items.length, 0);
  assert.equal(observed.beyond.total, observed.page1.total);
});

test("平台参数与优惠券读侧等价：配置整体、我的券、券模板、计数", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.platformConfig,
    async (repo) => ({ config: await repo.getConfig() }),
    "平台参数读侧",
  );
  // 平台参数是**一个整体**：任何一个字段漂了，页面上的金额与超时就会跟着漂
  assert.ok(Object.keys(observed.config).length > 0, "平台参数不应当是空对象");

  await assertSameObservation(
    W1_PAIRS.coupon,
    async (repo) => {
      const owned = await repo.queryOwnedCoupons({ userId: "u-1001", page: 1, pageSize: 10 });
      const templates = await repo.listCouponTemplates();
      const firstOwned = byId(owned.items)[0] ?? null;
      const firstTemplate = byId(templates)[0] ?? null;
      return {
        owned,
        ownedBeyond: await repo.queryOwnedCoupons({ userId: "u-1001", page: 99, pageSize: 10 }),
        ownedEmptyUser: await repo.queryOwnedCoupons({ userId: "u-nobody", page: 1, pageSize: 10 }),
        countOwned: await repo.countOwnedCoupons("u-1001"),
        countOwnedEmpty: await repo.countOwnedCoupons("u-nobody"),
        templates: byId(await repo.queryCoupons({ userId: "u-1001", page: 1, pageSize: 50 }).then((r) => r.items)),
        allTemplates: byId(templates),
        templateById: firstTemplate ? await repo.findCouponById(firstTemplate.id) : null,
        // 幂等键与「业务唯一键」是两道不同的索引，这里各查一次
        claimByCoupon: firstOwned ? await repo.findClaim("u-1001", firstOwned.couponId) : null,
        claimById: firstOwned ? await repo.findClaimById("u-1001", firstOwned.id) : null,
        countClaims: firstTemplate ? await repo.countClaimsByCoupon(firstTemplate.id) : 0,
        missingCoupon: await repo.findCouponById("cpn-does-not-exist"),
      };
    },
    "优惠券读侧",
  );
});

/* ═══════════ PROD-1B · W1 写侧契约等价（B1/B2/B3 的回归护栏） ═══════════ */

/**
 * ## 为什么读侧等价之外还必须有一组写侧用例
 *
 * 上面那一大组只比**读**：两个实现拿同一份种子数据答同一个查询。
 * 它有一个结构性盲区——**种子的每一行当初就是按「列清单」写进去的**，
 * 因此「`INSERT` 的列名顺序」与「取值数组的顺序」一旦错位，读侧照样能通过：
 * 两边读的都是各自已经写好的种子行，错位的那条 SQL 根本没被这条用例执行到。
 *
 * PROD-1B 交付时真的踩到了这一点：`refundRepository` / `complaintRepository` 把
 * 幂等键写进了 `created_at` 的位置，`companionRepository` 按**建表 DDL 的列序**
 * 而不是**列清单**的列序取值。后果不是编译错，而是 PG 运行时 `22007` / `42804`——
 * **只有在真写一次时才会暴露**，而当时的用例一条都没写。
 *
 * 因此这一组的纪律是：**每个仓储都要真的写一行进去、再读回来**。
 * 断言仍然是对称的（同一段观察函数分别喂给两个实现，然后逐字段比），
 * 与读侧用的是同一个 `assertSameObservation`。
 *
 * ⚠️ 两个实现之间**本来就会不同**的两类值必须先归一化再比，理由写在这里：
 *
 * 1. **由仓储生成的 id 与创建时间**（`createNotification`）：Mock 用
 *    `newNotificationId()` + 进程墙钟，Pg 用 `crypto.randomUUID()` + 数据库 `now()`，
 *    两者不可能相等（也不应该相等——它由实现自己决定，不在契约里）；
 * 2. **确认支付时刻**（`confirmPaymentRequest`）：同理，Mock 取进程墙钟、Pg 取 `now()`。
 *
 * 这两处**不是**在放水：归一化后仍然断言「形状 + 输入是否逐字段落到记录上」，
 * 而真正属于契约的字段（金额、状态、快照、外键、幂等命中后返回哪一条）一个都没被抹掉。
 * 反过来，若把这两类值原样拿来比，用例会变成一条**必然失败**的断言，
 * 那比不写更糟——它会训练后来的人看见红就改断言。
 */

/** 写侧用的固定时刻。**不能取 `now()`**：两个实现必须收到同一份输入。 */
const WRITE_AT = "2026-10-05T02:00:00.000Z";
const WRITE_AT_2 = "2026-10-05T03:00:00.000Z";

test("护航写侧等价：创建（一人一条）→ 编辑 → 软移除（幂等）", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.companion,
    async (repo) => {
      // 以种子里的 cp-1 为模板造一条**全新用户**的护航：字段完整、且不与种子冲突
      const template = await repo.findCompanionById("cp-1");
      const fresh = {
        ...template,
        id: "cp-w-new",
        userId: "u-w-new",
        applicationId: "app-w-new",
        removedAt: null,
        displayName: "写侧对照（Mock）",
        enabled: true,
        available: true,
      };

      const created = await repo.createCompanion(fresh);
      // 同一用户再建一次：一人一条有效护航 → already-linked，且**不写第二条**
      const duplicate = await repo.createCompanion({ ...fresh, id: "cp-w-new-2" });

      const patch = {
        displayName: "写侧对照·已改（Mock）",
        avatarUrl: fresh.avatarUrl,
        intro: fresh.intro,
        gameIds: fresh.gameIds,
        regions: fresh.regions,
        serviceTags: fresh.serviceTags,
        enabled: false,
        available: false,
        unavailableReason: "写侧对照",
        sortOrder: fresh.sortOrder + 7,
      };
      const updated = await repo.updateCompanion("cp-w-new", patch);
      const updatedMissing = await repo.updateCompanion("cp-does-not-exist", patch);

      const removed = await repo.markCompanionRemoved("cp-w-new", WRITE_AT);
      // 幂等：再移除一次**不刷新时间戳**，previous 与 updated 逐字段相同
      const removedAgain = await repo.markCompanionRemoved("cp-w-new", WRITE_AT_2);
      const removedMissing = await repo.markCompanionRemoved("cp-does-not-exist", WRITE_AT);

      return {
        created,
        duplicate,
        updated,
        updatedMissing,
        removed,
        removedAgain,
        removedMissing,
        afterRemove: await repo.findCompanionById("cp-w-new"),
        activeByUser: await repo.findCompanionByUser("u-w-new"),
      };
    },
    "护航写侧",
  );

  assert.equal(observed.created.kind, "created");
  assert.equal(observed.duplicate.kind, "already-linked");
  assert.equal(observed.duplicate.companion.id, "cp-w-new", "第二次创建必须复用同一条，而不是新建");
  assert.equal(observed.updated.previous.enabled, true);
  assert.equal(observed.updated.updated.enabled, false);
  assert.equal(observed.updatedMissing, null);
  assert.equal(observed.removed.updated.removedAt, WRITE_AT);
  assert.deepEqual(observed.removedAgain.previous, observed.removedAgain.updated, "重复移除必须幂等");
  assert.equal(observed.removedAgain.updated.removedAt, WRITE_AT, "幂等移除不得刷新时间戳");
  assert.equal(observed.removedMissing, null);
  assert.equal(observed.activeByUser, null, "移除之后按用户查有效护航必须查不到");
});

test("投诉写侧等价：幂等创建 → 同键重放 → 换键是另一条", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.complaint,
    async (repo) => {
      const template = await repo.findComplaintById("cmp-seed-1001-01");
      const fresh = {
        ...template,
        id: "cmp-w-1",
        complaintNo: "W-CMP-1",
        userId: "u-w-cmp",
        // 造一条**不关联订单**的投诉：它同时覆盖 order_id / order_no 都为 NULL 的写入
        orderId: null,
        orderNo: null,
        status: "pending",
        createdAt: WRITE_AT,
        updatedAt: WRITE_AT,
        processingAt: null,
        handledAt: null,
        handledById: null,
        handledByRole: null,
        handledByName: null,
        result: "",
      };

      const first = await repo.createComplaint(fresh, "w-cmp-key-1");
      // 同键重放：必须返回**第一条**，且不新建（换了个 id 也不认）
      const replay = await repo.createComplaint({ ...fresh, id: "cmp-w-1-b" }, "w-cmp-key-1");
      // 换键：是另一次提交，必须真的写出第二条
      const other = await repo.createComplaint(
        { ...fresh, id: "cmp-w-2", complaintNo: "W-CMP-2" },
        "w-cmp-key-2",
      );

      return {
        first,
        replay,
        other,
        byKey: await repo.findComplaintByKey("u-w-cmp", "w-cmp-key-1"),
        byKeyUnknown: await repo.findComplaintByKey("u-w-cmp", "从来没有用过的键"),
      };
    },
    "投诉写侧",
  );

  assert.equal(observed.first.created, true);
  assert.equal(observed.first.complaint.createdAt, WRITE_AT, "创建时间必须原样落库（错位会在这里暴露）");
  assert.equal(observed.replay.created, false);
  assert.equal(observed.replay.complaint.id, "cmp-w-1", "同键重放必须返回第一条");
  assert.equal(observed.other.created, true);
  assert.equal(observed.other.complaint.id, "cmp-w-2");
  assert.equal(observed.byKey.id, "cmp-w-1");
  assert.equal(observed.byKeyUnknown, null);
});

test("优惠券写侧等价：自己领（一人一券）与管理员发放（不受一人一券）", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.coupon,
    async (repo) => {
      // 以一条真实领取记录为模板：`snapshot` 等字段完整，不必手写十几个券面字段
      const template = await repo.findClaim("u-1001", "cpn-mock-holiday");
      const base = {
        ...template,
        couponId: "cpn-mock-holiday",
        status: "unused",
        source: "self_claim",
        claimedAt: WRITE_AT,
        usedAt: null,
        grantedByAdminId: null,
      };

      const selfClaim = { ...base, id: "claim-w-self-1", userId: "u-w-coupon" };
      const first = await repo.createClaim(selfClaim, "w-claim-key-1");
      // 同键重放
      const replay = await repo.createClaim({ ...selfClaim, id: "claim-w-self-1-b" }, "w-claim-key-1");
      // **换键但同「用户 + 券」**：业务唯一键（一人一券）必须挡住，返回第一条
      const sameCoupon = await repo.createClaim(
        { ...selfClaim, id: "claim-w-self-2" },
        "w-claim-key-2",
      );

      // 管理员发放：**不受**「一人一券」约束，因此同「用户 + 券」也能再写一条
      const grant = await repo.createGrant(
        { ...base, id: "claim-w-grant-1", userId: "u-w-coupon", source: "admin_grant", grantedByAdminId: "admin-w-1" },
        "w-grant-key-1",
      );
      const grantReplay = await repo.createGrant(
        { ...base, id: "claim-w-grant-1-b", userId: "u-w-coupon", source: "admin_grant", grantedByAdminId: "admin-w-1" },
        "w-grant-key-1",
      );

      return {
        first,
        replay,
        sameCoupon,
        grant,
        grantReplay,
        // `findClaim` 是「一人一券」索引的读取侧：发放**不写**那条索引，因此它只看得见自己领的那条
        selfClaimByCoupon: await repo.findClaim("u-w-coupon", "cpn-mock-holiday"),
        grantById: await repo.findClaimById("u-w-coupon", "claim-w-grant-1"),
        count: await repo.countClaimsByCoupon("cpn-mock-holiday"),
      };
    },
    "优惠券写侧",
  );

  assert.equal(observed.first.created, true);
  assert.equal(observed.first.claim.claimedAt, WRITE_AT, "领取时间必须原样落库（错位会在这里暴露）");
  assert.equal(observed.first.claim.source, "self_claim");
  assert.equal(observed.replay.created, false);
  assert.equal(observed.replay.claim.id, "claim-w-self-1");
  assert.equal(observed.sameCoupon.created, false, "一人一券：换幂等键也挡");
  assert.equal(observed.sameCoupon.claim.id, "claim-w-self-1");
  assert.equal(observed.grant.created, true, "发放不受一人一券约束，必须能写进去");
  assert.equal(observed.grant.claim.source, "admin_grant");
  assert.equal(observed.grantReplay.created, false);
  assert.equal(observed.selfClaimByCoupon.id, "claim-w-self-1", "发放不得挤掉自己领的那条索引");
  assert.equal(observed.grantById.id, "claim-w-grant-1");
});

test("通知写侧等价：创建 → 标记已读（幂等）→ 归属校验", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.notification,
    async (repo) => {
      const input = {
        userId: "u-1001",
        kind: "system",
        title: "写侧对照（Mock）",
        summary: "一行摘要",
        body: "展开后的正文，用来验证长文本不做任何截断。",
        // 为 null 表示「只能在本页展开阅读」：这条分支与带 href 的写法必须都成立
        href: null,
      };

      const created = await repo.createNotification(input);
      const found = await repo.findNotificationById(created.id);

      // 已读：种子里的未读通知（两侧 id 相同，因此这四个结果可以逐字段比）
      const read = await repo.markNotificationRead("nt-seed-1001-04", "u-1001", WRITE_AT);
      // 幂等：已经读过再标一次，**不刷新**已读时间
      const readAgain = await repo.markNotificationRead("nt-seed-1001-04", "u-1001", WRITE_AT_2);
      // 归属校验：别人标不到（对外是 404），不存在的 id 同样
      const stolen = await repo.markNotificationRead("nt-seed-1001-04", "u-1002", WRITE_AT);
      const missing = await repo.markNotificationRead("nt-does-not-exist", "u-1001", WRITE_AT);

      return {
        // id 与 createdAt 由仓储生成：两个实现**必然**给出不同的值，
        // 因此归一化成占位符，只比「形状 + 输入是否逐字段落到记录上」
        created: { ...created, id: "<生成的 id>", createdAt: "<生成的创建时间>" },
        found: found && { ...found, id: "<生成的 id>", createdAt: "<生成的创建时间>" },
        idShape: /^nt_[0-9a-f-]{20,}$/.test(created.id),
        foundSameRow: found ? found.id === created.id : false,
        createdUnread: created.readAt === null,
        read,
        readAgain,
        stolen,
        missing,
      };
    },
    "通知写侧",
  );

  assert.equal(observed.idShape, true, "新建通知的 id 形状必须与 Mock 一致（nt_ 前缀）");
  assert.equal(observed.foundSameRow, true);
  assert.equal(observed.createdUnread, true, "新建通知必须是未读的");
  assert.equal(observed.read.readAt, WRITE_AT);
  assert.equal(observed.readAgain.readAt, WRITE_AT, "重复标记不得刷新已读时间");
  assert.equal(observed.stolen, null, "别人的通知标不到（对外 404）");
  assert.equal(observed.missing, null);
});

test("支付请求写侧等价：创建（幂等）→ 确认成功只建一次订单 → 重复确认不建第二个", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.orders,
    async (repo) => {
      // 订单以种子里的真实订单为模板：字段完整，且一定满足 `orders` 表那几条金额恒等式 CHECK
      const template = await repo.findOrderById("ord-seed-1001-02");

      const request = {
        id: "pr-w-1",
        userId: "u-w-pay",
        idempotencyKey: "w-pay-key-1",
        status: "pending",
        productId: template.productId,
        specId: template.specId,
        quantity: 1,
        region: template.region,
        addonIds: [],
        gameAccountId: "acc-w-1",
        remark: "写侧对照",
        companionId: null,
        couponClaimId: null,
        createdAt: WRITE_AT,
        confirmedAt: null,
        itemsAmount: 10_000,
        addonsAmount: 0,
        totalAmount: 10_000,
        couponDiscountAmount: 0,
        actualPaidAmount: 10_000,
        companionRateSnapshot: 8_000,
        coupon: null,
        orderId: null,
        snapshot: {
          productTitle: template.productTitle,
          productCoverUrl: template.productCoverUrl,
          specName: template.specName,
          unitPrice: 10_000,
          gameName: template.gameName,
          addons: [],
          companion: null,
        },
      };

      // 支付成功生成的订单。金额必须自洽：
      // original(10000) − coupon(0) = actual(10000) = base(8000) + net(2000)，
      // 且 base = original × rate / 10000 —— 错一项都会被 `orders` 的 CHECK 挡回来。
      const order = {
        ...template,
        id: "ord-w-pay-1",
        orderNo: "W-PAY-1",
        userId: "u-w-pay",
        status: "paid",
        unitPrice: 10_000,
        quantity: 1,
        itemsAmount: 10_000,
        addonsAmount: 0,
        totalAmount: 10_000,
        originalAmount: 10_000,
        couponDiscountAmount: 0,
        actualPaidAmount: 10_000,
        companionRateSnapshot: 8_000,
        companionBaseIncome: 8_000,
        clubNetIncome: 2_000,
        refundedAmount: 0,
        coupon: null,
      };
      const buildOrder = () => order;

      const first = await repo.createPaymentRequest(request);
      // 同「用户 + 幂等键」重放：必须返回**第一条**，不新建（连 id 都换成新的也不认）
      const replay = await repo.createPaymentRequest({ ...request, id: "pr-w-1-b" });

      const confirmed = await repo.confirmPaymentRequest("pr-w-1", "success", buildOrder);
      // 重复确认：原样返回既有结果、**不再生成第二个订单**
      const confirmedAgain = await repo.confirmPaymentRequest("pr-w-1", "success", buildOrder);
      const confirmedMissing = await repo.confirmPaymentRequest("pr-does-not-exist", "success", buildOrder);

      // `confirmedAt` 由**时钟**给出（Mock 取进程墙钟、Pg 取数据库 `now()`），必然不同。
      // 归一化成占位符，其余字段一个不动：金额、状态、orderId、快照都还在比。
      const normalizeRequest = (request) =>
        request && {
          ...request,
          confirmedAt: request.confirmedAt === null ? null : "<确认时刻>",
        };
      const normalize = (value) =>
        value && { ...value, request: normalizeRequest(value.request) };

      return {
        first: normalize(first),
        replay: normalize(replay),
        createdAtEcho: first.request.createdAt === WRITE_AT,
        confirmed: normalize(confirmed),
        confirmedAgain: normalize(confirmedAgain),
        confirmedMissing,
        // ⚠️ `findPaymentRequestByKey` 返回的是**裸请求**，不是 `{ request }` 包装；
        //    与上面三个返回值形状不同，因此这里用另一个归一化函数。
        byKey: normalizeRequest(await repo.findPaymentRequestByKey("u-w-pay", "w-pay-key-1")),
        orderAfter: await repo.findOrderById("ord-w-pay-1"),
      };
    },
    "支付写侧",
  );

  assert.equal(observed.createdAtEcho, true, "创建时间必须原样落库（错位会在这里暴露）");
  assert.equal(observed.first.created, true);
  assert.equal(observed.replay.created, false);
  assert.equal(observed.replay.request.id, "pr-w-1", "同键重放必须返回第一条");
  assert.equal(observed.confirmed.orderCreated, true);
  assert.equal(observed.confirmed.request.status, "success");
  assert.equal(observed.confirmed.request.orderId, "ord-w-pay-1");
  assert.equal(observed.confirmed.order.id, "ord-w-pay-1");
  assert.equal(observed.confirmedAgain.orderCreated, false, "重复确认不得再建一个订单");
  assert.equal(observed.confirmedAgain.order.id, "ord-w-pay-1");
  assert.equal(observed.confirmedMissing, null);
  assert.equal(observed.orderAfter.status, "paid");
});

test("退款写侧等价：幂等创建 → 一单一退 → 撤销 → 重复撤销 / 越权撤销", { skip: SKIP }, async () => {
  const observed = await assertSameObservation(
    W1_PAIRS.refund,
    async (repo) => {
      // 以一条 pending 的预置申请为模板：reviewingAt / reviewedAt / decision 等
      // 「未决策」字段本来就都是 null，不必手写一遍状态机
      const template = await repo.findRefundById("rf-seed-1001-01");
      const fresh = {
        ...template,
        id: "rf-w-1",
        refundNo: "W-RF-1",
        orderId: "ord-seed-1001-02",
        userId: "u-1001",
        createdAt: WRITE_AT,
        updatedAt: WRITE_AT,
      };

      const created = await repo.createRefundRequest(fresh, "w-rf-key-1");
      // 同键重放：返回第一条
      const replay = await repo.createRefundRequest({ ...fresh, id: "rf-w-1-b" }, "w-rf-key-1");
      // 换键但**同一订单**：P0-15「一单一条，永久」必须挡住，`existing` 指向已存在的那条
      const blocked = await repo.createRefundRequest(
        { ...fresh, id: "rf-w-2", refundNo: "W-RF-2" },
        "w-rf-key-2",
      );

      const cancelled = await repo.cancelRefund("rf-w-1", "u-1001", WRITE_AT_2);
      // 撤销后状态已不是 pending：再撤一次是 not_cancellable，不是 not_found
      const cancelTwice = await repo.cancelRefund("rf-w-1", "u-1001", WRITE_AT_2);
      // 别人的申请：不存在与不属于你表现完全一致，都是 not_found
      const cancelNotMine = await repo.cancelRefund("rf-w-1", "u-1002", WRITE_AT_2);
      const cancelMissing = await repo.cancelRefund("rf-w-does-not-exist", "u-1001", WRITE_AT_2);

      return {
        created,
        replay,
        blocked,
        cancelled,
        cancelTwice,
        cancelNotMine,
        cancelMissing,
        byKey: await repo.findRefundByKey("u-1001", "w-rf-key-1"),
        byOrder: await repo.findRefundByOrderId("ord-seed-1001-02"),
      };
    },
    "退款写侧",
  );

  assert.equal(observed.created.ok, true);
  assert.equal(observed.created.created, true);
  assert.equal(observed.created.refund.createdAt, WRITE_AT, "申请时间必须原样落库（错位会在这里暴露）");
  assert.equal(observed.replay.ok, true);
  assert.equal(observed.replay.created, false);
  assert.equal(observed.replay.refund.id, "rf-w-1", "同键重放必须返回第一条");
  assert.equal(observed.blocked.ok, false);
  assert.equal(observed.blocked.reason, "order_already_has_refund");
  assert.equal(observed.blocked.existing.id, "rf-w-1");
  assert.equal(observed.cancelled.ok, true);
  assert.equal(observed.cancelled.refund.status, "cancelled");
  assert.equal(observed.cancelled.refund.cancelledAt, WRITE_AT_2);
  assert.equal(observed.cancelTwice.ok, false);
  assert.equal(observed.cancelTwice.reason, "not_cancellable");
  assert.equal(observed.cancelNotMine.reason, "not_found", "别人的申请与不存在的表现必须一致");
  assert.equal(observed.cancelMissing.reason, "not_found");
  assert.equal(observed.byKey.id, "rf-w-1");
  assert.equal(observed.byOrder.id, "rf-w-1");
});
