import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { resolveSource } from "./app-path.mjs";
import {
  CONSUMPTION_CALCULATION_NOTICE,
  CONSUMPTION_ORDER_STATUS,
  LEVEL_CONFIG_NOTICE,
  LEVEL_LOWEST_THRESHOLD_NOT_ZERO,
  LEVEL_THRESHOLD_DUPLICATED,
  LEVEL_THRESHOLD_NEGATIVE,
  LEVEL_THRESHOLD_NOT_INTEGER,
  LEVEL_UNAVAILABLE_EMPTY,
  LEVEL_UNAVAILABLE_INVALID,
  buildConsumptionLevelSummary,
  countEffectiveOrders,
  resolveConsumptionLevel,
  resolveLevelName,
  sortEnabledLevels,
  sumEffectiveSpend,
  validateLevelConfig,
} from "../lib/constants/levels.ts";
import { getLevelRepository } from "../lib/data/levelRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { levelSeed } from "../lib/mocks/fixtures/levelSeed.ts";
import { getMockSeedNow } from "../lib/mocks/fixtures/mockClock.ts";
import { buildRankingPeriodOrders, orderSeed } from "../lib/mocks/fixtures/orderSeed.ts";
import { getConsumptionLevelForUser } from "../lib/services/levels.ts";
import * as levelsHttp from "../lib/services/levelsHttp.ts";
import { formatYuan } from "../lib/utils/format.ts";

/**
 * 消费等级与权益的持续测试。
 *
 * 跑的是**真实实现**：真实的口径函数、真实的等级判定、真实的只读 Mock 仓储与
 * 真实的服务层。三条规则是本阶段的重点，每次提交都会被重新验证：
 *
 * 1. **统计口径只有一处**（`sumEffectiveSpend`）：只算已完成、已退款与进行中都不算、
 *    同一订单只算一次、金额取订单快照；
 * 2. **等级判定不猜**：配置为空或非法时**不生成默认等级**，如实说明不可用；
 * 3. **隐私边界**：DTO 里没有订单明细，接口只读会话里的 userId，
 *    客户端也没有任何写入入口。
 */

const USER_A = "u-1001";
const USER_B = "u-1002";

/** 造一条等级配置；只写需要断言的字段。 */
function level(id, name, thresholdAmount, extra = {}) {
  return {
    id,
    name,
    thresholdAmount,
    privileges: [],
    sortOrder: 0,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

/** 造一条订单；口径函数只读 id / status / totalAmount。 */
function order(id, status, totalAmount, userId = "u-x") {
  return { id, userId, status, totalAmount };
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** Mock 调试参数默认关闭；需要时显式打开，测完还原，避免影响别的测试文件。 */
const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「数据来自 X」不算引用 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

beforeEach(() => {
  resetMockStore("level");
  resetMockStore("payment");
});

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

test("口径：只统计已完成订单，退款与进行中的一分都不算", () => {
  assert.equal(CONSUMPTION_ORDER_STATUS, "completed");

  const orders = [
    order("o1", "completed", 1000),
    order("o2", "paid", 2000),
    order("o3", "accepted", 3000),
    order("o4", "serving", 4000),
    order("o5", "refunded", 5000),
  ];

  assert.equal(sumEffectiveSpend(orders), 1000);
  assert.equal(countEffectiveOrders(orders), 1);

  // 支付失败与取消的订单在用户端根本不存在（订单只在支付成功那一刻生成），
  // 但口径函数**不信任调用方已经筛过**，任何非 completed 状态都必须被跳过
  for (const status of ["failed", "cancelled", "pending"]) {
    assert.equal(sumEffectiveSpend([order("x", status, 9999)]), 0, `${status} 不该计入`);
  }
});

test("口径：金额取订单的服务端快照，同一订单只累计一次", () => {
  // 同一 id 出现两次（分页或去重没做好时可能发生）：只算一次
  const duplicated = [order("o1", "completed", 1200), order("o1", "completed", 1200)];
  assert.equal(sumEffectiveSpend(duplicated), 1200);
  assert.equal(countEffectiveOrders(duplicated), 1);

  // 金额是整数分，不做任何浮点换算
  assert.equal(sumEffectiveSpend([order("o2", "completed", 2990), order("o3", "completed", 1)]), 2991);

  // 空数组：金额是 0，不是 NaN
  assert.equal(sumEffectiveSpend([]), 0);
  assert.equal(Number.isInteger(sumEffectiveSpend([])), true);
});

test("等级判定：0 消费落在最低等级，正好到阈值即升级", () => {
  const levels = [level("lv-1", "普通", 0), level("lv-2", "高级", 30000), level("lv-3", "金牌", 60000)];

  // 0 消费：最低启用等级（阈值就是 0），因此任何金额都够得上
  const zero = resolveConsumptionLevel(0, levels);
  assert.equal(zero.ok, true);
  assert.equal(zero.state.currentLevel.name, "普通");
  assert.equal(zero.state.amountToNextLevel, 30000);
  assert.equal(zero.state.progressCurrentAmount, 0);
  assert.equal(zero.state.progressTargetAmount, 30000);
  assert.equal(zero.state.progressPercent, 0);

  // 正好等于阈值：已经达到该等级，而不是「差一分」
  const exact = resolveConsumptionLevel(30000, levels);
  assert.equal(exact.state.currentLevel.name, "高级");
  assert.equal(exact.state.nextLevel.name, "金牌");
  assert.equal(exact.state.amountToNextLevel, 30000);
  assert.equal(exact.state.progressPercent, 0);

  // 差一分：还在下一档门槛之外
  const justBelow = resolveConsumptionLevel(29999, levels);
  assert.equal(justBelow.state.currentLevel.name, "普通");
  assert.equal(justBelow.state.amountToNextLevel, 1);

  // 区间中间：进度按当前等级区间计算，不是按总额除以最高门槛
  const middle = resolveConsumptionLevel(45000, levels);
  assert.equal(middle.state.currentLevel.name, "高级");
  assert.equal(middle.state.progressCurrentAmount, 15000);
  assert.equal(middle.state.progressTargetAmount, 30000);
  assert.equal(middle.state.progressPercent, 50);
});

test("等级判定：超过最高阈值就是最高等级，不编造下一级与负差额", () => {
  const levels = [level("lv-1", "普通", 0), level("lv-2", "高级", 30000)];

  for (const spend of [30000, 123456, 99999999]) {
    const result = resolveConsumptionLevel(spend, levels);
    assert.equal(result.ok, true);
    assert.equal(result.state.currentLevel.name, "高级");
    assert.equal(result.state.nextLevel, null, "最高等级不该有下一等级");
    assert.equal(result.state.amountToNextLevel, null, "最高等级不该有升级差额");
    assert.equal(result.state.progressPercent, 100, "最高等级进度按满处理");
    assert.equal(result.state.progressTargetAmount, null);
    // 金额超过最高阈值是正常的（还会继续消费），不能被截断成阈值
    assert.equal(result.state.effectiveSpendAmount, spend);
  }
});

test("等级判定：异常输入不会产生 NaN / Infinity / 负值", () => {
  const levels = [level("lv-1", "普通", 0), level("lv-2", "高级", 30000)];

  for (const spend of [Number.NaN, Number.POSITIVE_INFINITY, -1, -99999, 0.5]) {
    const result = resolveConsumptionLevel(spend, levels);
    assert.equal(result.ok, true);
    assert.equal(Number.isFinite(result.state.progressPercent), true, `进度不是有限数：${spend}`);
    assert.ok(result.state.progressPercent >= 0 && result.state.progressPercent <= 100);
    assert.ok(result.state.amountToNextLevel === null || result.state.amountToNextLevel >= 0);
    assert.ok(Number.isInteger(result.state.effectiveSpendAmount));
    assert.ok(result.state.effectiveSpendAmount >= 0);
  }
});

test("没有启用等级：如实说明不可用，绝不生成一个默认等级", () => {
  const empty = resolveConsumptionLevel(50000, []);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, LEVEL_UNAVAILABLE_EMPTY);

  // 全部停用等同于没有配置
  const allDisabled = resolveConsumptionLevel(50000, [
    level("lv-1", "普通", 0, { enabled: false }),
    level("lv-2", "高级", 30000, { enabled: false }),
  ]);
  assert.equal(allDisabled.ok, false);
  assert.equal(allDisabled.reason, LEVEL_UNAVAILABLE_EMPTY);

  const summary = buildConsumptionLevelSummary(50000, []);
  assert.equal(summary.available, false);
  assert.equal(summary.unavailableReason, LEVEL_UNAVAILABLE_EMPTY);
  assert.equal(summary.currentLevel, null);
  assert.equal(summary.nextLevel, null);
  assert.equal(summary.amountToNextLevel, null);
  assert.deepEqual(summary.levels, []);
  // 关键：**没有**被塞进一个「普通等级」冒充成功
  assert.equal(summary.progressTargetAmount, null);
  // 但金额照常给出：它来自订单，与等级配置无关
  assert.equal(summary.effectiveSpendAmount, 50000);
});

test("配置非法：最低启用阈值大于 0 时不把最低等级派给用户", () => {
  const broken = [level("lv-1", "普通", 10000), level("lv-2", "高级", 30000)];

  // 只差 1 分也够不上最低等级 —— 合法配置下不可能发生，因此按配置异常处理
  const result = resolveConsumptionLevel(9999, broken);
  assert.equal(result.ok, false);
  assert.equal(result.reason, LEVEL_UNAVAILABLE_INVALID);

  // 够得上最低阈值时照常判定：配置「不规范」但不影响这次结果
  assert.equal(resolveConsumptionLevel(10000, broken).ok, true);

  const summary = buildConsumptionLevelSummary(9999, broken);
  assert.equal(summary.available, false);
  assert.equal(summary.unavailableReason, LEVEL_UNAVAILABLE_INVALID);
  assert.equal(summary.currentLevel, null);
});

test("只有一个启用等级时，它就是最高等级", () => {
  const levels = [level("lv-only", "唯一等级", 0)];
  const result = resolveConsumptionLevel(88888, levels);

  assert.equal(result.ok, true);
  assert.equal(result.state.currentLevel.name, "唯一等级");
  assert.equal(result.state.nextLevel, null);
  assert.equal(result.state.amountToNextLevel, null);
  assert.equal(result.state.progressPercent, 100);

  const summary = buildConsumptionLevelSummary(0, levels);
  assert.equal(summary.available, true);
  assert.equal(summary.levels.length, 1);
});

test("停用等级不参与判定，也不出现在「全部等级」里", () => {
  const levels = [
    level("lv-1", "普通", 0),
    level("lv-2", "高级", 30000),
    // 阈值与 lv-2 相同但已停用：既不触发「阈值重复」，也不参与判定
    level("lv-legacy", "旧版高级", 30000, { enabled: false, sortOrder: -1 }),
  ];

  const sorted = sortEnabledLevels(levels);
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["lv-1", "lv-2"],
  );

  const summary = buildConsumptionLevelSummary(50000, levels);
  assert.deepEqual(
    summary.levels.map((item) => item.id),
    ["lv-1", "lv-2"],
  );
  assert.equal(summary.currentLevel.name, "高级", "停用等级不该被选中");
});

test("排序：按阈值升序，阈值相同时用 sortOrder 与 id 兜底", () => {
  const shuffled = [
    level("lv-c", "丙", 60000, { sortOrder: 3 }),
    level("lv-a", "甲", 0, { sortOrder: 1 }),
    level("lv-b2", "乙二", 30000, { sortOrder: 5 }),
    level("lv-b1", "乙一", 30000, { sortOrder: 2 }),
  ];

  assert.deepEqual(
    sortEnabledLevels(shuffled).map((item) => item.id),
    ["lv-a", "lv-b1", "lv-b2", "lv-c"],
  );

  // 阈值与 sortOrder 都相同时按 id 升序：排序必须确定，否则「当前等级」会随数据顺序漂移
  const tied = [level("lv-z", "Z", 100, { sortOrder: 1 }), level("lv-a", "A", 100, { sortOrder: 1 })];
  assert.deepEqual(
    sortEnabledLevels(tied).map((item) => item.id),
    ["lv-a", "lv-z"],
  );

  // 排序不修改入参：配置是共享数据，排序不能有副作用
  const before = shuffled.map((item) => item.id);
  sortEnabledLevels(shuffled);
  assert.deepEqual(
    shuffled.map((item) => item.id),
    before,
  );
});

test("配置校验：非整数、负数、重复阈值与最低阈值不为 0 都能查出来", () => {
  assert.deepEqual(validateLevelConfig([level("lv-1", "普通", 0)]), []);

  const issues = validateLevelConfig([
    // 带一个合法的 0 阈值等级，否则「最低阈值不是 0」会额外报一条，
    // 把这条用例要验的「重复阈值」淹没掉
    level("lv-1", "普通", 0),
    level("lv-neg", "负值", -1),
    level("lv-float", "小数", 100.5),
    level("lv-dup-a", "重复甲", 500),
    level("lv-dup-b", "重复乙", 500),
  ]);
  const reasons = new Map(issues.map((issue) => [issue.levelId, issue.reason]));

  assert.equal(reasons.get("lv-neg"), LEVEL_THRESHOLD_NEGATIVE);
  assert.equal(reasons.get("lv-float"), LEVEL_THRESHOLD_NOT_INTEGER);
  // 重复只报后出现的那个，并在原因里带上先出现的那个（方便定位配置）
  assert.equal(reasons.has("lv-dup-a"), false, "先出现的阈值不算重复");
  assert.ok(reasons.get("lv-dup-b").startsWith(LEVEL_THRESHOLD_DUPLICATED));
  assert.ok(reasons.get("lv-dup-b").includes("lv-dup-a"));

  // 最低启用阈值不是 0：任何消费为 0 的用户都会够不上任何等级
  const notZero = validateLevelConfig([level("lv-1", "普通", 1), level("lv-2", "高级", 500)]);
  assert.deepEqual(notZero, [{ levelId: "lv-1", reason: LEVEL_LOWEST_THRESHOLD_NOT_ZERO }]);

  // 停用等级不参与校验：它的阈值重复、为负都不影响启用配置
  assert.deepEqual(
    validateLevelConfig([level("lv-1", "普通", 0), level("lv-off", "停用", -5, { enabled: false })]),
    [],
  );
});

test("等级名：配置不可用时返回空串，不编一个默认名字", () => {
  const levels = [level("lv-1", "普通", 0), level("lv-2", "高级", 30000)];

  assert.equal(resolveLevelName(0, levels), "普通");
  assert.equal(resolveLevelName(30000, levels), "高级");
  assert.equal(resolveLevelName(999999, levels), "高级");
  assert.equal(resolveLevelName(0, []), "", "没有等级配置时不该编出等级名");
});

test("服务层：只算当前用户自己的订单，金额与等级都由服务端给出", async () => {
  const a = await getConsumptionLevelForUser(USER_A, page(), "server");
  assert.equal(a.available, true);
  // 24060 = 既有种子 17460（2026-08 的两单）+ 周期榜预置的今日订单 6600
  // （`buildRankingPeriodOrders`，见 `orderSeed.ts`）。累计口径不受周期页签影响，
  // 因此这里与 `/rank?period=all` 的金额必然一致。
  assert.equal(a.effectiveSpendAmount, 24060);
  assert.equal(a.currentLevel.name, "普通老板");
  assert.equal(a.nextLevel.name, "高级老板");
  assert.equal(a.amountToNextLevel, 5940);
  assert.deepEqual(
    a.levels.map((item) => item.thresholdAmount),
    [0, 30000, 60000, 150000],
  );

  // 换一个用户，金额完全不同：归属来自会话传入的 userId，不是「全站订单」
  const b = await getConsumptionLevelForUser(USER_B, page(), "server");
  assert.equal(b.effectiveSpendAmount, 3990);
  assert.equal(b.currentLevel.name, "普通老板");

  // 服务端算出来的金额与口径函数对**同一批订单**的结果一致（口径只有一处实现）。
  // 这里必须用仓储建仓时的完整订单表：既有种子 + 相对时间构造的周期榜预置订单。
  const allOrders = [...orderSeed, ...buildRankingPeriodOrders(getMockSeedNow())];
  const expected = sumEffectiveSpend(allOrders.filter((item) => item.userId === USER_A));
  assert.equal(a.effectiveSpendAmount, expected);
});

test("服务层：正好达到阈值的用户落在该等级，等级配置里的边界能被真实数据覆盖", async () => {
  // u-1006 的有效消费正好 30000 分 = 「高级老板」阈值
  const exact = await getConsumptionLevelForUser("u-1006", page(), "server");
  assert.equal(exact.effectiveSpendAmount, 30000);
  assert.equal(exact.currentLevel.name, "高级老板");
  assert.equal(exact.amountToNextLevel, 30000);

  // 有订单但全在口径之外的用户：金额 0，落在最低等级
  const zero = await getConsumptionLevelForUser("u-1009", page(), "server");
  assert.equal(zero.effectiveSpendAmount, 0);
  assert.equal(zero.currentLevel.name, "普通老板");
  assert.equal(zero.amountToNextLevel, 30000);
  assert.equal(zero.progressPercent, 0);

  // 没有任何订单的用户与「有订单但为 0」在等级上表现一致
  const none = await getConsumptionLevelForUser("u-1010", page(), "server");
  assert.equal(none.effectiveSpendAmount, 0);
  assert.equal(none.currentLevel.name, "普通老板");

  // 超过最高阈值的用户：最高等级，没有下一等级
  const top = await getConsumptionLevelForUser("u-1004", page(), "server");
  assert.equal(top.currentLevel.name, "金牌老板");
  assert.equal(top.nextLevel.name, "至尊老板");
  assert.equal(top.amountToNextLevel, 34200);
});

test("服务层：?mockEmpty=levels 演示「等级配置暂不可用」，金额仍然照常给出", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  // `mockDelay=0`：本用例验的是空数据注入，不是延迟，别为 400ms 的模拟延迟白等
  const summary = await getConsumptionLevelForUser(
    USER_A,
    page({ mockEmpty: "levels", mockDelay: 0 }),
    "server",
  );

  assert.equal(summary.available, false);
  assert.equal(summary.unavailableReason, LEVEL_UNAVAILABLE_EMPTY);
  assert.equal(summary.currentLevel, null);
  assert.deepEqual(summary.levels, []);
  // 金额不依赖等级配置，藏起来反而像是数据丢了
  assert.equal(summary.effectiveSpendAmount, 24060);

  // 别的范围不受影响（这个参数不是「全局清空」）
  const untouched = await getConsumptionLevelForUser(
    USER_A,
    page({ mockEmpty: "agreements", mockDelay: 0 }),
    "server",
  );
  assert.equal(untouched.available, true);
});

test("服务层：?mockError=1 抛错而不是返回一份假数据", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  await assert.rejects(
    () => getConsumptionLevelForUser(USER_A, page({ mockError: "1", mockDelay: 0 }), "server"),
    (error) => {
      assert.equal(error.code, "SERVER_ERROR");
      return true;
    },
  );

  // 关掉开关后同样的参数不再生效：调试注入不能带进正式环境
  process.env.ENABLE_MOCK_DEBUG = "false";
  const normal = await getConsumptionLevelForUser(USER_A, page({ mockError: "1" }), "server");
  assert.equal(normal.available, true);
});

test("DTO 只有约定的字段：没有订单、游戏 ID、备注与退款原因", async () => {
  const summary = await getConsumptionLevelForUser(USER_A, page(), "server");

  assert.deepEqual(Object.keys(summary).sort(), [
    "amountToNextLevel",
    "available",
    "calculationNotice",
    "configNotice",
    "currentLevel",
    "effectiveSpendAmount",
    "levels",
    "nextLevel",
    "progressCurrentAmount",
    "progressPercent",
    "progressTargetAmount",
    "unavailableReason",
  ]);

  // 等级条目里没有 enabled / createdAt / updatedAt 这类配置字段
  assert.deepEqual(Object.keys(summary.currentLevel).sort(), [
    "id",
    "name",
    "privileges",
    "sortOrder",
    "thresholdAmount",
  ]);

  // 任何一层都不该顺着字段名漏出订单信息
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["orderId", "orderNo", "gameAccountId", "remark", "refundReason", "totalAmount"]) {
    assert.equal(serialized.includes(forbidden), false, `DTO 不该出现 ${forbidden}`);
  }
});

test("仓储与浏览器端服务都只有读取入口：等级与金额不接受任何写入", async () => {
  const repository = getLevelRepository();
  assert.deepEqual(Object.keys(repository).sort(), ["listLevels"]);
  for (const name of Object.keys(repository)) {
    assert.equal(/create|update|save|write|set/i.test(name), false, `仓储不该有写方法：${name}`);
  }

  // 浏览器端只有一个读函数
  assert.deepEqual(Object.keys(levelsHttp).sort(), ["fetchConsumptionLevel"]);

  // 接口只有 GET
  const routeSource = readFileSync("app/api/me/consumption-level/route.ts", "utf8");
  assert.match(routeSource, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(routeSource),
      false,
      `消费等级接口不该出现 ${method}`,
    );
  }
  // 接口必须要求登录，且身份只来自会话
  assert.ok(routeSource.includes("requireUser"), "消费等级接口必须要求登录");
  assert.equal(/searchParams\.get\("userId"\)|body\.userId/.test(routeSource), false);
});

test("种子配置自洽：最低启用阈值为 0、无重复、无负数，并刻意含一个停用等级", () => {
  assert.deepEqual(validateLevelConfig(levelSeed), []);

  const enabled = sortEnabledLevels(levelSeed);
  assert.ok(enabled.length >= 2, "至少要能排出「当前等级 + 下一等级」");
  assert.equal(enabled[0].thresholdAmount, 0, "最低启用等级的阈值必须是 0");

  // 停用等级确实存在：这条规则要有真实数据可验，而不是只在测试里造一个对象
  assert.ok(levelSeed.some((item) => !item.enabled));
  assert.equal(enabled.some((item) => !item.enabled), false);

  // 权益只有名称与说明两个字段：没有任何可执行的折扣率、次数或金额
  for (const item of levelSeed) {
    for (const privilege of item.privileges) {
      assert.deepEqual(Object.keys(privilege).sort(), ["description", "id", "label"]);
      for (const key of Object.keys(privilege)) {
        assert.equal(/rate|discount|amount|count|times|cash|rebate/i.test(key), false);
      }
    }
    assert.equal(Number.isInteger(item.thresholdAmount), true);
  }

  // 四种金额展示：两位小数、没有 k/w 缩写
  assert.equal(formatYuan(0), "0.00");
  assert.equal(formatYuan(2990), "29.90");
  assert.equal(formatYuan(102900), "1029.00");
  assert.equal(formatYuan(17460), "174.60");
});

test("页面必须标注 Mock 配置与统计口径，且不直接引用 lib/mocks", () => {
  assert.ok(LEVEL_CONFIG_NOTICE.includes("Mock"));
  assert.ok(CONSUMPTION_CALCULATION_NOTICE.includes("已完成"));
  assert.ok(CONSUMPTION_CALCULATION_NOTICE.includes("退款"));

  // 页面与客户端组件都不得引用 Mock 种子：否则 Mock 层会被打进浏览器产物
  for (const file of [
    "app/rights/page.tsx",
    "components/rights/LevelSummaryCard.tsx",
    "components/rights/LevelListView.tsx",
    "components/rights/PrivilegeList.tsx",
    "components/rights/LevelProgress.tsx",
    "components/mine/LevelSummaryPanel.tsx",
  ]) {
    // 先去掉注释：注释里写一句「数据来自 lib/mocks/fixtures/...」不算引用
    const code = stripComments(readFileSync(resolveSource(file), "utf8"));
    assert.equal(code.includes("lib/mocks"), false, `${file} 不该引用 lib/mocks`);
    assert.equal(code.includes("lib/data/"), false, `${file} 不该直接引用 lib/data`);
  }

  // 「页面组件不得遍历订单算金额」：页面与服务端组件里不出现订单集合的求和/筛选
  const rightsPage = readFileSync(resolveSource("app/rights/page.tsx"), "utf8");
  assert.equal(rightsPage.includes("sumEffectiveSpend"), false, "页面不得自己算消费金额");
  assert.equal(/\.filter\(/.test(rightsPage), false, "页面不得自己筛订单");
});
