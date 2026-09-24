import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import {
  COMPANION_AVAILABILITY_INVALID_MESSAGE,
  COMPANION_DETAIL_REVIEW_LIMIT,
  COMPANION_DETAIL_DISABLED_NOTICE,
  COMPANION_GAME_INVALID_MESSAGE,
  COMPANION_INTRO_BRIEF_LENGTH,
  COMPANION_SELECTION_NOTICE,
  normalizeCompanionAvailability,
  normalizeCompanionGameId,
  toCompanionDetail,
  toCompanionListItem,
} from "../lib/constants/companions.ts";
import { companionSeed } from "../lib/mocks/fixtures/seed.ts";
import {
  getCompanionDetail,
  listCompanionGameOptions,
  queryCompanionPage,
  resolveCompanionListQuery,
} from "../lib/services/companions.ts";

/**
 * 公开陪玩列表与陪玩详情的持续测试。
 *
 * 跑的是**真实实现**：真实的数据源 + 真实的 `lib/services/companions.ts`，
 * 因此「下架的陪玩不进列表」「不可用的陪玩仍然在列表里并给出原因」「详情页没有任何
 * 下单能力」这些规则每次提交都会被重新验证，而不是一次性检查。
 *
 * 四条边界必须由测试守住：
 *
 * 1. **只读且游客可见**：服务层没有写方法，也没有任何「查谁的」参数；
 * 2. **筛选契约是明确的**：接口侧非法枚举抛 400，页面侧规范化到默认值——
 *    两处口径不同是有意的，不能悄悄合并成一种；
 * 3. **DTO 显式挑字段**：内部字段（排序权重、上架开关、结算页等级标签、评价明细）
 *    一律不出现在公开响应里；
 * 4. **选择不产生任何业务结果**：没有订单、没有支付请求、没有陪玩关系仓储。
 */

const SERVICE_SOURCE_URL = new URL("../lib/services/companions.ts", import.meta.url);
const HTTP_SOURCE_URL = new URL("../lib/services/companionsHttp.ts", import.meta.url);

const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 走一遍「解析查询条件 → 取数」，与页面/接口的调用方式一致。 */
async function query(params = {}, { strict = false, surface = "server" } = {}) {
  const search = page(params);
  const resolved = await resolveCompanionListQuery(search, strict);
  return queryCompanionPage(resolved, search, surface);
}

async function detail(id, params = {}, surface = "server") {
  return getCompanionDetail(id, page(params), surface);
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

// ——————————————————————————— 名单与筛选 ———————————————————————————

test("只读且游客可见：服务层没有「查谁的」参数，也没有任何写方法", async () => {
  const source = stripComments(await readFile(SERVICE_SOURCE_URL, "utf8"));
  const http = stripComments(await readFile(HTTP_SOURCE_URL, "utf8"));

  // 没有会话依赖：陪玩名单是浏览型内容，游客直接能看
  for (const forbidden of ["getSessionUser", "requireUser", "cookies(", "@/lib/auth"]) {
    assert.equal(source.includes(forbidden), false, `陪玩服务不该依赖会话：${forbidden}`);
  }

  // 没有任何写入口：不创建订单、不创建支付请求、不写陪玩关系
  for (const forbidden of ["createOrder", "createPayment", "localStorage", "method: \"POST\""]) {
    assert.equal(source.includes(forbidden), false, `陪玩服务出现了写操作：${forbidden}`);
    assert.equal(http.includes(forbidden), false, `陪玩 HTTP 客户端出现了写操作：${forbidden}`);
  }

  // 浏览器端请求里也没有用户标识，只有筛选与分页
  assert.equal(http.includes("userId"), false, "公开列表请求不该带用户标识");

  // 不带任何登录信息也能取到数据
  const result = await query();
  assert.ok(result.total > 0);
  assert.ok((await listCompanionGameOptions()).length > 0);
});

test("列表只含在架陪玩，排序稳定，分页不重不漏", async () => {
  const all = await query({ pageSize: 50 });

  // cp-7 已下架：不进公开列表
  assert.equal(all.items.some((item) => item.id === "cp-7"), false, "下架陪玩不该进列表");

  // 顺序 = 数据里的排序权重，逐条对齐（不是「大概有序」）
  const expected = companionSeed
    .filter((companion) => companion.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((companion) => companion.id);
  assert.deepEqual(
    all.items.map((item) => item.id),
    expected,
  );
  assert.equal(all.total, expected.length);
  assert.equal(all.hasMore, false);

  // 分页：逐页翻到底，拼起来应当与一次性取出的顺序完全一致，且没有重复。
  //
  // ⚠️ 页数由**数据**决定，不写死「三页」。DEV-1 往种子里补了两位在架陪玩之后，
  // 写死的三页断言立刻变红——而它红的原因与「分页对不对」毫无关系，
  // 只是在说「列表恰好是 8 条」。这种断言会在每次加数据时误报，掩盖真正的回归。
  const pageSize = 3;
  const collected = [];
  let pageNumber = 1;
  let hasMore = true;
  while (hasMore) {
    const one = await query({ pageSize, page: pageNumber });
    collected.push(...one.items.map((item) => item.id));
    hasMore = one.hasMore;

    // 「还有下一页」必须与实际剩余条数一致：否则翻页入口会凭空停住（少）或多出一页空白（多）
    assert.equal(
      hasMore,
      collected.length < expected.length,
      `第 ${pageNumber} 页的 hasMore 与实际剩余条数对不上`,
    );

    pageNumber += 1;
    assert.ok(pageNumber < 100, "分页没有终止：hasMore 一直是 true");
  }
  // 取完最后还是不满一页时，也必须停下来——否则最后一页会被重复取一次
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected).size, collected.length, "分页出现了重复的陪玩");
});

test("关键词命中昵称 / 自我介绍 / 服务标签三处", async () => {
  // 昵称
  const byName = await query({ keyword: "老K" });
  assert.deepEqual(
    byName.items.map((item) => item.id),
    ["cp-3"],
  );

  // 自我介绍（「机密单」只出现在正文里，不在任何昵称或标签里）
  const byIntro = await query({ keyword: "机密单" });
  const ids = byIntro.items.map((item) => item.id);
  assert.ok(ids.includes("cp-1"));
  for (const id of ids) {
    const companion = companionSeed.find((item) => item.id === id);
    assert.equal(companion.intro.includes("机密单"), true, `${id} 不该被这条关键词命中`);
  }

  // 服务标签
  const byTag = await query({ keyword: "新手带打" });
  assert.ok(byTag.items.length > 0);
  for (const item of byTag.items) {
    assert.equal(item.serviceTags.includes("新手带打"), true, `${item.id} 不该被标签命中`);
  }

  // 大小写不敏感（标签与昵称都可能出现英文）
  assert.equal((await query({ keyword: "老k" })).items.length, (await query({ keyword: "老K" })).items.length);

  // 空关键词 = 不搜索，与不传一致
  assert.deepEqual(
    (await query({ keyword: "   " })).items.map((item) => item.id),
    (await query()).items.map((item) => item.id),
  );
});

test("游戏与可用状态筛选可以组合，且只在真实取值上生效", async () => {
  const options = await listCompanionGameOptions();
  // 筛选栏的游戏来自真实数据，不在页面里写死第二份名单
  assert.deepEqual(
    options.map((game) => game.id).sort(),
    ["g-delta", "g-valorant"],
  );
  for (const game of options) {
    const filtered = await query({ gameId: game.id, pageSize: 50 });
    assert.ok(filtered.items.length > 0, `${game.id} 应当至少有一位陪玩`);
    for (const item of filtered.items) {
      assert.equal(
        item.games.some((tag) => tag.id === game.id),
        true,
        `${item.id} 不属于 ${game.id}`,
      );
    }
  }

  // 可用 / 暂不可用：cp-4（休息中）与 cp-6（已排满）在后者里
  const available = await query({ availability: "available", pageSize: 50 });
  assert.ok(available.items.every((item) => item.available));
  const unavailable = await query({ availability: "unavailable", pageSize: 50 });
  assert.deepEqual(
    unavailable.items.map((item) => item.id),
    ["cp-4", "cp-6"],
  );

  // 组合：g-valorant 里暂不可用的只有 cp-6
  const combo = await query({ gameId: "g-valorant", availability: "unavailable" });
  assert.deepEqual(
    combo.items.map((item) => item.id),
    ["cp-6"],
  );

  // 筛不出结果时是空列表，不是错误
  const none = await query({ keyword: "不存在的陪玩关键词" });
  assert.deepEqual(none.items, []);
  assert.equal(none.total, 0);
  assert.equal(none.hasMore, false);
});

test("枚举契约：接口侧非法值抛 400，页面侧规范化到默认值", async () => {
  // 接口（严格）：调用方拿着「不知道筛了什么」的列表继续往下用，比报错难查得多
  await expectApiError(
    resolveCompanionListQuery(page({ availability: "online" }), true),
    "BAD_REQUEST",
    COMPANION_AVAILABILITY_INVALID_MESSAGE,
  );
  await expectApiError(
    resolveCompanionListQuery(page({ gameId: "g-not-exist" }), true),
    "BAD_REQUEST",
    COMPANION_GAME_INVALID_MESSAGE,
  );

  // 页面（宽松）：手改坏了的地址不该变成错误页
  assert.equal(normalizeCompanionAvailability("online"), "all");
  assert.equal(normalizeCompanionAvailability(null), "all");
  assert.equal(normalizeCompanionAvailability(""), "all");
  assert.equal(normalizeCompanionGameId("g-not-exist", ["g-delta"]), "");
  assert.equal(normalizeCompanionGameId(null, ["g-delta"]), "");

  const normalized = await resolveCompanionListQuery(
    page({ availability: "online", gameId: "g-not-exist" }),
    false,
  );
  assert.equal(normalized.availability, "all");
  assert.equal(normalized.gameId, "");

  // 分页参数是另一套口径：夹紧而不是报错（与订单 / 反馈列表一致）
  const clamped = await resolveCompanionListQuery(page({ page: "-3", pageSize: "999" }), true);
  assert.equal(clamped.page, 1);
  assert.equal(clamped.pageSize, 20);
});

// ——————————————————————————— 详情 ———————————————————————————

test("不可用的陪玩仍然在列表里并给出具体原因；下架的只能直链看只读资料", async () => {
  const list = await query({ availability: "unavailable", pageSize: 50 });
  const resting = list.items.find((item) => item.id === "cp-4");

  assert.ok(resting, "在架但暂不可用的陪玩不该从列表里消失");
  assert.equal(resting.available, false);
  // 必须给出具体原因，不能只把按钮置灰
  assert.ok(resting.unavailableReason.length > 0);
  assert.equal(resting.unavailableReason.includes("休息"), true);

  // 详情仍然可以打开：说明为什么不能选，而不是 404
  const detailDto = await detail("cp-4");
  assert.ok(detailDto);
  assert.equal(detailDto.selectable, false);
  assert.equal(detailDto.unavailableReason, resting.unavailableReason);

  // 下架：不在列表里，但直链详情有资料，且明确说明没有选择入口
  assert.equal((await query({ pageSize: 50 })).items.some((item) => item.id === "cp-7"), false);
  const disabled = await detail("cp-7");
  assert.ok(disabled);
  assert.equal(disabled.selectable, false);
  // 「下架」与「在架但暂不可用」的 available 都是 false，只能靠 listed 区分
  assert.equal(disabled.listed, false);
  assert.equal(detailDto.listed, true);
  assert.equal(COMPANION_DETAIL_DISABLED_NOTICE.includes("没有选择或下单入口"), true);

  // 真正不存在的 id 返回 null，由页面 notFound()
  assert.equal(await detail("cp-not-exist"), null);
});

test("详情 DTO：完整自我介绍、有限的评价摘要、selectable 由服务端算", async () => {
  const dto = await detail("cp-9");
  const entity = companionSeed.find((item) => item.id === "cp-9");

  assert.ok(dto);
  // 详情给完整自我介绍，列表给截断摘要——两者的差别只在这里
  assert.equal(dto.intro, entity.intro);
  const listItem = toCompanionListItem(entity, {});
  assert.ok(listItem.introBrief.length <= COMPANION_INTRO_BRIEF_LENGTH + 1);
  assert.equal(listItem.introBrief.endsWith("…"), true);
  assert.equal("intro" in listItem, false, "列表项不该带完整自我介绍");

  // 评价只展示前若干条，并说明还有更多
  assert.equal(dto.reviews.length, COMPANION_DETAIL_REVIEW_LIMIT);
  assert.equal(entity.reviews.length > COMPANION_DETAIL_REVIEW_LIMIT, true);
  assert.equal(dto.reviewsTruncated, true);

  // 没有评价的陪玩：评分是 null（不拿 0 分冒充「暂无评分」）
  const fresh = await detail("cp-8");
  assert.equal(fresh.rating, null);
  assert.equal(fresh.reviewCount, 0);
  assert.deepEqual(fresh.reviews, []);
  assert.equal(fresh.reviewsTruncated, false);

  // selectable 由服务端算好：在架 + 当前可用
  assert.equal((await detail("cp-1")).selectable, true);
  assert.equal((await detail("cp-4")).selectable, false);
});

test("公开 DTO 显式挑字段：内部字段与身份字段一律不外泄", async () => {
  const listItem = (await query()).items[0];
  const dto = await detail("cp-1");

  const internalFields = [
    "sortOrder",
    "enabled",
    "rankLabel",
    "userId",
    "openId",
    "unionId",
    "phone",
    "contactNote",
    "orderIds",
    "settlementUrl",
  ];

  for (const item of [listItem, dto]) {
    for (const field of internalFields) {
      assert.equal(field in item, false, `公开 DTO 泄漏了内部字段：${field}`);
    }
  }

  // 列表 DTO 不带评价正文，详情 DTO 的评价摘要只有四项
  assert.equal("reviews" in listItem, false);
  assert.deepEqual(
    Object.keys(dto.reviews[0]).sort(),
    ["content", "createdAt", "id", "nickname", "rating"],
  );

  // DTO 的字段集合是确定的一份，多一个少一个都会在这里被发现
  assert.deepEqual(
    Object.keys(listItem).sort(),
    [
      "available",
      "avatarUrl",
      "completedOrderCount",
      "displayName",
      "games",
      "id",
      "introBrief",
      "rating",
      "regions",
      "reviewCount",
      "serviceTags",
      "tipsCount",
      "unavailableReason",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(toCompanionDetail(companionSeed[0], {})).sort(),
    [
      "available",
      "avatarUrl",
      "completedOrderCount",
      "displayName",
      "games",
      "id",
      "intro",
      // 列表项不该有、详情才有的两项：完整自我介绍与「是否在公开名单里」
      "listed",
      "rating",
      "regions",
      "reviewCount",
      "reviews",
      "reviewsTruncated",
      "selectable",
      "serviceTags",
      "tipsCount",
      "unavailableReason",
    ].sort(),
  );

  // 游戏标签带名称，前端不用自己维护一份 id → 名称的映射
  assert.deepEqual(listItem.games[0], { id: "g-delta", name: "三角洲行动" });
});

test("选择说明只解释规则未定，不声称已经预约 / 锁定 / 分配", () => {
  for (const forbidden of ["已预约", "已锁定", "已分配", "预约成功", "下单成功"]) {
    assert.equal(
      COMPANION_SELECTION_NOTICE.includes(forbidden),
      false,
      `选择说明出现了未确认的结论：${forbidden}`,
    );
  }
  assert.equal(COMPANION_SELECTION_NOTICE.includes("待确认"), true);
  assert.equal(COMPANION_SELECTION_NOTICE.includes("不会创建订单"), true);
});

// ——————————————————————————— 调试开关 ———————————————————————————

test("?mockEmpty=companions 只在调试开关打开时生效，且空名单不是错误", async () => {
  // 开关关闭：参数完全不生效
  process.env.ENABLE_MOCK_DEBUG = "false";
  const ignored = await query({ mockEmpty: "companions", mockDelay: 0 });
  assert.ok(ignored.total > 0, "调试关闭时不该清空名单");

  process.env.ENABLE_MOCK_DEBUG = "true";
  const emptied = await query({ mockEmpty: "companions", mockDelay: 0 });
  assert.deepEqual(emptied.items, []);
  assert.equal(emptied.total, 0);
  assert.equal(emptied.hasMore, false);

  // 别的范围不影响陪玩名单
  const other = await query({ mockEmpty: "rankings", mockDelay: 0 });
  assert.ok(other.total > 0);

  // ?mockEmpty=all 是「全部范围」，包含陪玩
  assert.equal((await query({ mockEmpty: "all", mockDelay: 0 })).total, 0);

  // 故障注入：?mockError=1 两侧都抛，?mockError=api 只影响浏览器端请求
  process.env.ENABLE_MOCK_DEBUG = "true";
  await expectApiError(query({ mockError: "1", mockDelay: 0 }), "SERVER_ERROR");
  await expectApiError(query({ mockError: "api", mockDelay: 0 }, { surface: "http" }), "SERVER_ERROR");
  assert.ok((await query({ mockError: "api", mockDelay: 0 }, { surface: "server" })).total > 0);
});
