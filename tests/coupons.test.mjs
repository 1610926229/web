import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  COUPON_CLAIMED_LABEL,
  COUPON_DISABLED_REASON,
  COUPON_EXPIRED_REASON,
  COUPON_NOT_FOUND_MESSAGE,
  COUPON_NOT_STARTED_REASON,
  COUPON_PAGE_SIZE,
  COUPON_TAB_INVALID_MESSAGE,
  couponClaimability,
  couponDisplayStatus,
  isExpiredAt,
  mergeCouponPage,
  parseCouponListQuery,
} from "../lib/constants/coupons.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE } from "../lib/constants/writes.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { couponClaimSeed, couponSeed } from "../lib/mocks/fixtures/couponSeed.ts";
import { previewCheckout } from "../lib/services/checkout.ts";
import { claimCouponForUser, queryCouponsForUser } from "../lib/services/coupons.ts";

/**
 * 优惠券的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/coupons.ts`，
 * 因此「只能看到自己的券」「不能领的券领不了」「重复领取不产生第二条」
 * 「并发领取只产生一条」「伪造字段无效」「领券不改变结算金额」这些规则
 * 每次提交都会被重新验证，而不是一次性脚本。
 *
 * 时间一律显式钉死在 `NOW`：券的「可领取」与「已过期」都依赖当前时间，
 * 传真实时间的话用例会在某一天突然变红。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

const NOW = new Date("2026-09-13T12:00:00.000Z");
/** 有效期已过的那张券（种子里的 validTo 是 2026-08-31）。 */
const EXPIRED_COUPON = "cpn-mock-expired";
/** 平台停用的券。 */
const DISABLED_COUPON = "cpn-mock-disabled";
/** 还没到有效期的券。 */
const UPCOMING_COUPON = "cpn-mock-upcoming";
/** A 领过、B 没领过的券。 */
const CLAIMED_BY_A = "cpn-mock-new-user";
/** A 和 B 都没领过、且当前可领的券。 */
const OPEN_COUPON = "cpn-mock-no-threshold";

/** 结算试算要用的商品：目录里真实存在的可购买项（与 checkout 测试同一件）。 */
const PRODUCT = { productId: "p-400w", specId: "s-400w", specPrice: 2990, region: "手游" };

const SELECTION = {
  ...PRODUCT,
  quantity: 1,
  addonIds: [],
  gameAccountId: "moyu_test",
  remark: "",
  companionId: null,
};

let keySeq = 0;
function uniqueKey() {
  keySeq += 1;
  return `coupon-test-key-${process.pid}-${keySeq}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function list(userId, params = page({ tab: "owned" }), now = NOW) {
  return queryCouponsForUser(userId, params, "server", now);
}

function claim(userId, couponId, body = { idempotencyKey: uniqueKey() }, now = NOW) {
  return claimCouponForUser(userId, couponId, body, "server", undefined, now);
}

function owned(userId, params = {}) {
  return list(userId, page({ tab: "owned", ...params }));
}

function claimable(userId, params = {}, now = NOW) {
  return list(userId, page({ tab: "claimable", ...params }), now);
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
});

test("我的优惠券只包含当前用户的领取记录，且按领取时间倒序", async () => {
  const result = await owned(USER_A);

  assert.equal(result.tab, "owned");
  assert.equal(result.total, 3);
  assert.equal(result.page, 1);
  assert.equal(result.hasMore, false);

  // 全是 u-1001 的记录，顺序严格非递增
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].claimedAt >= result.items[index].claimedAt);
  }
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["claim-seed-1001-01", "claim-seed-1001-02", "claim-seed-1001-03"],
  );

  // B 什么都没领过：空态不需要额外的调试开关就能看到
  const other = await owned(USER_B);
  assert.equal(other.total, 0);
  assert.deepEqual(other.items, []);
});

test("领取记录的状态由时间推导：未使用 / 已使用 / 已过期", async () => {
  const result = await owned(USER_A);
  const byCoupon = new Map(result.items.map((item) => [item.couponId, item]));

  // 记录里只存「未使用」，但券已经过期 → 展示状态是「已过期」
  assert.equal(byCoupon.get("cpn-mock-expired").status, "expired");
  assert.equal(byCoupon.get("cpn-mock-expired").statusLabel, "已过期");
  // 真的用掉了才是「已使用」
  assert.equal(byCoupon.get("cpn-mock-holiday").status, "used");
  assert.ok(byCoupon.get("cpn-mock-holiday").usedAt);
  // 有效期内、没用掉 = 未使用
  assert.equal(byCoupon.get("cpn-mock-new-user").status, "unused");
});

test("领券中心：只能领有效期内的启用券，其余都给得出原因", async () => {
  // 用一张都没领过的 B 看「不可领取」的三个原因，避免和「已领取」混在一起
  const result = await claimable(USER_B);
  const byId = new Map(result.items.map((item) => [item.id, item]));

  // 平台停用
  assert.equal(byId.get(DISABLED_COUPON).claimable, false);
  assert.equal(byId.get(DISABLED_COUPON).reason, COUPON_DISABLED_REASON);
  // 已过有效期
  assert.equal(byId.get(EXPIRED_COUPON).claimable, false);
  assert.equal(byId.get(EXPIRED_COUPON).reason, COUPON_EXPIRED_REASON);
  // 尚未开始
  assert.equal(byId.get(UPCOMING_COUPON).claimable, false);
  assert.equal(byId.get(UPCOMING_COUPON).reason, COUPON_NOT_STARTED_REASON);

  // 有效期内、已启用的三张都能领
  for (const id of [CLAIMED_BY_A, "cpn-mock-holiday", OPEN_COUPON]) {
    assert.equal(byId.get(id).claimed, false);
    assert.equal(byId.get(id).claimable, true);
    assert.equal(byId.get(id).reason, "");
  }
  assert.deepEqual(result.counts, { owned: 0, claimable: 3 });

  // A 已经领过的券：显示「已领取」，而不是再给一次领取入口
  const forA = await claimable(USER_A);
  const aById = new Map(forA.items.map((item) => [item.id, item]));
  assert.equal(aById.get(CLAIMED_BY_A).claimed, true);
  assert.equal(aById.get(CLAIMED_BY_A).claimable, false);
  assert.equal(aById.get(CLAIMED_BY_A).reason, COUPON_CLAIMED_LABEL);
  // 连已过期的券也是「已领取」：手里那张记录比券现在能不能领更重要
  assert.equal(aById.get(EXPIRED_COUPON).reason, COUPON_CLAIMED_LABEL);

  // 角标就是服务端算出来的数量：A 可领 1 张（无门槛券）、已拥有 3 张
  assert.deepEqual(forA.counts, { owned: 3, claimable: 1 });
});

test("角标随领取实时变化：领一张后「可领取」减一、「已拥有」加一", async () => {
  const before = await claimable(USER_A);
  assert.deepEqual(before.counts, { owned: 3, claimable: 1 });

  await claim(USER_A, OPEN_COUPON);

  const after = await claimable(USER_A);
  assert.deepEqual(after.counts, { owned: 4, claimable: 0 });
  // 领完的券在领券中心变成「已领取」，因此不会出现同一张券领两次的入口
  const card = after.items.find((item) => item.id === OPEN_COUPON);
  assert.equal(card.claimed, true);
  assert.equal(card.claimable, false);

  const mine = await owned(USER_A);
  assert.equal(mine.total, 4);
  assert.equal(mine.items[0].couponId, OPEN_COUPON);
  assert.equal(mine.items[0].status, "unused");
});

test("重复领取不产生第二条记录，且返回第一次的结果", async () => {
  const first = await claim(USER_A, OPEN_COUPON);
  assert.equal(first.created, true);
  assert.equal(first.couponId, OPEN_COUPON);

  // 换一个幂等键重试：真正兜底的是「用户 + 券」唯一键
  const second = await claim(USER_A, OPEN_COUPON);
  assert.equal(second.created, false);
  assert.equal(second.claimId, first.claimId);

  // 同一个幂等键再发一次：同样命中
  const key = uniqueKey();
  const third = await claim(USER_A, OPEN_COUPON, { idempotencyKey: key });
  const fourth = await claim(USER_A, OPEN_COUPON, { idempotencyKey: key });
  assert.equal(third.claimId, first.claimId);
  assert.equal(fourth.claimId, first.claimId);

  const mine = await owned(USER_A);
  assert.equal(mine.total, 4);
  assert.equal(mine.items.filter((item) => item.couponId === OPEN_COUPON).length, 1);
});

test("并发领取只写入一条记录", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () => claim(USER_A, OPEN_COUPON)),
  );

  const ids = new Set(results.map((result) => result.claimId));
  assert.equal(ids.size, 1, "并发领取必须收敛到同一条记录");
  assert.equal(results.filter((result) => result.created).length, 1, "只能有一次真正创建");

  const mine = await owned(USER_A);
  assert.equal(mine.total, 4);
  assert.equal(mine.items.filter((item) => item.couponId === OPEN_COUPON).length, 1);
});

test("停用 / 已过期 / 未开始的券一律领不了，且不留下记录", async () => {
  await expectApiError(claim(USER_B, DISABLED_COUPON), "BAD_REQUEST", COUPON_DISABLED_REASON);
  await expectApiError(claim(USER_B, EXPIRED_COUPON), "BAD_REQUEST", COUPON_EXPIRED_REASON);
  await expectApiError(claim(USER_B, UPCOMING_COUPON), "BAD_REQUEST", COUPON_NOT_STARTED_REASON);

  // 一张都没领成功
  const mine = await owned(USER_B);
  assert.equal(mine.total, 0);

  // 已经持有记录的券重复领取时返回已有记录而不是报「已过期」：
  // 重试要的是「和上次一样的结果」，不是按现在的状态重新判一遍
  const repeat = await claim(USER_A, EXPIRED_COUPON);
  assert.equal(repeat.created, false);
  assert.equal(repeat.claimId, "claim-seed-1001-03");
  assert.equal((await owned(USER_A)).total, 3);

  // 时间推到活动开始之后，同一张券就能领了（判定看的是有效期，不是一次性开关）
  const later = new Date("2026-11-15T12:00:00.000Z");
  const claimedLater = await claim(USER_A, UPCOMING_COUPON, { idempotencyKey: uniqueKey() }, later);
  assert.equal(claimedLater.created, true);
});

test("券不存在时 404，且与「不属于当前用户」表现一致", async () => {
  await expectApiError(
    claim(USER_A, "cpn-not-exist"),
    "NOT_FOUND",
    COUPON_NOT_FOUND_MESSAGE,
  );
  // 别人的领取记录 id 也不是可用的入参：领取只认券 id，且只写自己的记录
  await expectApiError(claim(USER_B, "cpn-not-exist"), "NOT_FOUND", COUPON_NOT_FOUND_MESSAGE);
  assert.equal((await owned(USER_A)).total, 3);
});

test("缺少幂等键直接拒绝", async () => {
  await expectApiError(claim(USER_A, OPEN_COUPON, {}), "BAD_REQUEST", IDEMPOTENCY_KEY_MISSING_MESSAGE);
  await expectApiError(
    claim(USER_A, OPEN_COUPON, { idempotencyKey: "short" }),
    "BAD_REQUEST",
    IDEMPOTENCY_KEY_MISSING_MESSAGE,
  );
  assert.equal((await owned(USER_A)).total, 3);
});

test("客户端伪造的 userId / status / claimedAt 一概无效", async () => {
  const result = await claim(USER_A, OPEN_COUPON, {
    idempotencyKey: uniqueKey(),
    // 全是客户端不该能决定的东西
    userId: USER_B,
    status: "used",
    claimedAt: "2000-01-01T00:00:00.000Z",
    usedAt: "2000-01-02T00:00:00.000Z",
    snapshot: { name: "伪造的券名" },
  });

  const mine = await owned(USER_A);
  const created = mine.items.find((item) => item.id === result.claimId);

  // 记录落在 A 名下，状态是「未使用」，领取时间是服务端写的时间
  assert.ok(created);
  assert.equal(created.status, "unused");
  assert.equal(created.usedAt, null);
  assert.equal(created.claimedAt, NOW.toISOString());
  assert.notEqual(created.name, "伪造的券名");

  // B 名下没有多出任何记录
  assert.equal((await owned(USER_B)).total, 0);
});

test("用户隔离：A 与 B 的领取互不影响", async () => {
  await claim(USER_A, OPEN_COUPON);
  await claim(USER_B, OPEN_COUPON);

  const a = await owned(USER_A);
  const b = await owned(USER_B);

  assert.equal(a.total, 4);
  assert.equal(b.total, 1);
  assert.equal(b.items[0].couponId, OPEN_COUPON);

  // 记录 id 从不交叉
  const aIds = new Set(a.items.map((item) => item.id));
  for (const item of b.items) assert.equal(aIds.has(item.id), false);
  assert.equal(aIds.has("claim-seed-1001-01"), true);
});

test("领取优惠券不改变结算试算金额", async () => {
  const before = await previewCheckout(SELECTION, undefined, "server");
  const totalBefore = before.totalAmount;

  await claim(USER_A, OPEN_COUPON);

  const after = await previewCheckout(SELECTION, undefined, "server");

  // 试算结果逐字段相同：优惠券本阶段不参与结算，领了券也不会便宜
  assert.deepEqual(after, before);
  assert.equal(after.totalAmount, totalBefore);
  assert.ok(Number.isInteger(after.totalAmount));

  // 试算结果里不存在任何「券」的痕迹
  const keys = Object.keys(after).join(",");
  assert.equal(/coupon/i.test(keys), false, `试算结果不该出现券字段：${keys}`);
});

test("列表 DTO 不含 userId、快照与内部字段", async () => {
  const mine = await owned(USER_A);
  const item = mine.items[0];

  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "claimedAt",
      "conditionLabel",
      "couponId",
      "formLabel",
      "id",
      "name",
      "status",
      "statusLabel",
      "usedAt",
      "validFrom",
      "validTo",
      "valueLabel",
    ],
  );
  assert.equal("userId" in item, false);
  assert.equal("snapshot" in item, false);
  assert.equal("enabled" in item, false);

  const center = await claimable(USER_A);
  assert.deepEqual(
    Object.keys(center.items[0]).sort(),
    [
      "claimable",
      "claimed",
      "conditionLabel",
      "formLabel",
      "id",
      "name",
      "reason",
      "validFrom",
      "validTo",
      "valueLabel",
    ],
  );

  // 页面拿到的分页结果形状固定：两个角标始终随每一页一起返回
  assert.deepEqual(Object.keys(mine).sort(), [
    "counts",
    "hasMore",
    "items",
    "page",
    "pageSize",
    "tab",
    "total",
  ]);
});

test("分页稳定不重复：两页拼起来正好是全部记录", async () => {
  // 先领够两页的数据
  for (const coupon of couponSeed) {
    if (coupon.id === DISABLED_COUPON || coupon.id === EXPIRED_COUPON) continue;
    try {
      await claim(USER_B, coupon.id);
    } catch {
      // 尚未开始的券领不到，这里只关心记录条数
    }
  }

  const total = (await owned(USER_B)).total;
  assert.ok(total >= 3);

  const seen = new Set();
  for (let pageIndex = 1; pageIndex <= 3; pageIndex += 1) {
    const result = await owned(USER_B, { page: pageIndex, pageSize: 2 });
    for (const item of result.items) {
      assert.equal(seen.has(item.id), false, `${item.id} 在分页里重复出现`);
      seen.add(item.id);
    }
  }
  assert.equal(seen.size, total);

  // 重复取同一页再合并：去重后条数不变（「加载更多」连点两次的兜底）
  const first = await owned(USER_B, { pageSize: COUPON_PAGE_SIZE });
  const merged = mergeCouponPage(first, first);
  assert.equal(merged.items.length, first.items.length);
  assert.equal(merged.counts.owned, first.counts.owned);
  assert.equal(merged.tab, "owned");
});

test("查询规则的纯函数：Tab 非法失败、分页收敛到安全范围", async () => {
  const fallback = parseCouponListQuery(page());
  assert.equal(fallback.ok, true);
  assert.equal(fallback.query.tab, "owned");
  assert.equal(fallback.query.page, 1);
  assert.equal(fallback.query.pageSize, COUPON_PAGE_SIZE);

  assert.equal(parseCouponListQuery(page({ tab: "claimable" })).query.tab, "claimable");
  assert.equal(parseCouponListQuery(page({ pageSize: 999 })).query.pageSize, 20);
  assert.equal(parseCouponListQuery(page({ page: "abc" })).query.page, 1);

  const invalid = parseCouponListQuery(page({ tab: "all" }));
  assert.equal(invalid.ok, false);

  // 接口层：Tab 写错直接 400（不静默回退成「已拥有」）
  await expectApiError(list(USER_A, page({ tab: "all" })), "BAD_REQUEST", COUPON_TAB_INVALID_MESSAGE);
});

test("可领取判定与过期判定的边界", () => {
  const coupon = couponSeed.find((item) => item.id === CLAIMED_BY_A);

  // 有效期最后时刻仍算有效，之后算过期
  assert.equal(isExpiredAt("2026-12-31T15:59:59.000Z", NOW), false);
  assert.equal(isExpiredAt("2026-09-13T11:59:59.000Z", NOW), true);
  // 时间串坏掉时按「已过期」处理：宁可不能领，也不要放进一批无效的券
  assert.equal(isExpiredAt("not-a-date", NOW), true);

  assert.deepEqual(couponClaimability(coupon, NOW), { claimable: true, reason: "" });
  // 停用优先于其他原因
  assert.deepEqual(couponClaimability({ ...coupon, enabled: false, validTo: "2020-01-01T00:00:00.000Z" }, NOW), {
    claimable: false,
    reason: COUPON_DISABLED_REASON,
  });

  const claim = couponClaimSeed.find((item) => item.id === "claim-seed-1001-02");
  assert.equal(couponDisplayStatus(claim, NOW), "used");
  // 已使用的券即使过了有效期也显示「已使用」（用户实际用过，比过期更准确）
  assert.equal(couponDisplayStatus(claim, new Date("2030-01-01T00:00:00.000Z")), "used");
  assert.equal(
    couponDisplayStatus({ ...claim, status: "unused" }, new Date("2030-01-01T00:00:00.000Z")),
    "expired",
  );
});

test("券面数据是 Mock 文案，且不参与任何金额计算", () => {
  for (const coupon of couponSeed) {
    assert.ok(coupon.name.includes("Mock"), `${coupon.id} 的名字必须标明 Mock`);
  }
  // 券的字段里没有任何「可参与运算的金额」：值是展示文案
  for (const coupon of couponSeed) {
    assert.equal(Number.isInteger(Number(coupon.valueLabel)), false);
  }
});
