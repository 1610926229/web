import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { adminAuditRepositoryBacking, getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { adminRepositoryBacking, getAdminRepository } from "../lib/data/adminRepository.ts";
import { agreementRepositoryBacking, getAgreementRepository } from "../lib/data/agreementRepository.ts";
import { catalogRepositoryBacking, getCatalogRepository } from "../lib/data/catalogRepository.ts";
import { companionAcceptRepositoryBacking, getCompanionAcceptRepository } from "../lib/data/companionAcceptRepository.ts";
import { companionApplicationRepositoryBacking, getCompanionApplicationRepository } from "../lib/data/companionApplicationRepository.ts";
import { companionReleaseRepositoryBacking, getCompanionReleaseRepository } from "../lib/data/companionReleaseRepository.ts";
import { companionRepositoryBacking, getCompanionRepository } from "../lib/data/companionRepository.ts";
import { companionServiceRepositoryBacking, getCompanionServiceRepository } from "../lib/data/companionServiceRepository.ts";
import { complaintRepositoryBacking, getComplaintRepository } from "../lib/data/complaintRepository.ts";
import { completionRepositoryBacking, getCompletionRepository } from "../lib/data/completionRepository.ts";
import { contentRepositoryBacking, getContentRepository } from "../lib/data/contentRepository.ts";
import { couponRepositoryBacking, getCouponRepository } from "../lib/data/couponRepository.ts";
import { dispatchRepositoryBacking, getDispatchRepository } from "../lib/data/dispatchRepository.ts";
import { earningRepositoryBacking, getEarningRepository } from "../lib/data/earningRepository.ts";
import { favoriteRepositoryBacking, getFavoriteRepository } from "../lib/data/favoriteRepository.ts";
import { levelRepositoryBacking, getLevelRepository } from "../lib/data/levelRepository.ts";
import { messageRepositoryBacking, getMessageRepository } from "../lib/data/messageRepository.ts";
import { notificationRepositoryBacking, getNotificationRepository } from "../lib/data/notificationRepository.ts";
import { paymentRepositoryBacking, getPaymentRepository } from "../lib/data/paymentRepository.ts";
import { platformConfigRepositoryBacking, getPlatformConfigRepository } from "../lib/data/platformConfigRepository.ts";
import { qualificationRepositoryBacking, getQualificationRepository } from "../lib/data/qualificationRepository.ts";
import { refundRepositoryBacking, getRefundRepository } from "../lib/data/refundRepository.ts";
import { reviewRepositoryBacking, getReviewRepository } from "../lib/data/reviewRepository.ts";
import { staffRepositoryBacking, getStaffRepository } from "../lib/data/staffRepository.ts";
import { suggestionRepositoryBacking, getSuggestionRepository } from "../lib/data/suggestionRepository.ts";
import { tipRepositoryBacking, getTipRepository } from "../lib/data/tipRepository.ts";
import { userRepositoryBacking, getUserRepository } from "../lib/data/userRepository.ts";
import {
  assertAllRepositoriesWired,
  CORE_REPOSITORY_COUNT,
  MissingPgImplementationError,
  pickRepository,
} from "../lib/data/datasource.ts";
import { assertRepositoriesReadyOnce, resetRepositoriesReadyAssertion } from "../lib/data/runtime.ts";
import { getDataSource } from "../lib/data/source.ts";

/**
 * PROD-1E · **数据源激活**的回归测试（**不需要数据库**）。
 *
 * ## 这个文件要证明的那句话
 *
 * > 「`DATA_SOURCE=postgres` 时，28 个核心仓储**没有一个**会悄悄回落到 Mock。」
 *
 * 这是全轮最容易被「看起来对」蒙过去的一条：半套数据源（订单在库里、排行榜读进程内假数据）
 * 的表现不是报错，而是**页面一切正常、数字是错的**。因此它不能只靠代码评审，
 * 必须有一条能在 CI 里跑的断言。
 *
 * ## 为什么不需要数据库
 *
 * 这一层要证的是「**选谁**」，不是「选中的那个跑得对不对」。对象身份比较
 * （`getXxxRepository() === backing.pg`）在连库之前就能完成，也不该连库——
 * 一旦需要数据库，这条保护就只能在有人配好库时才生效。
 *
 * ## 与 `pnpm test:pg` 的分工
 *
 * 本文件在 Mock 模式下运行（`pnpm test`），只翻转 `process.env.DATA_SOURCE` 这一个开关。
 * 「Pg 实现的行为与 Mock 等价」「事务真的在一个 `BEGIN…COMMIT` 里」由
 * `tests/pg*.test.mjs` 打真库证明——那是另一件事，两边不互相替代。
 *
 * ## 清单（28 条）不会自己更新，这是刻意的
 *
 * 新增第 29 个仓储时这里要加一行——漏掉的话，`CORE_REPOSITORY_COUNT` 那条会先炸，
 * 因为 `lib/data/runtime.ts` 的清单与常量必须一起改。
 */

/** 28 个核心仓储的（域、访问器、backing）三元组。域名与 `backing.name` 必须一致。 */
const CORE_ACCESSORS = [
  ["adminAudit", getAdminAuditRepository, adminAuditRepositoryBacking],
  ["admin", getAdminRepository, adminRepositoryBacking],
  ["agreement", getAgreementRepository, agreementRepositoryBacking],
  ["catalog", getCatalogRepository, catalogRepositoryBacking],
  ["companionAccept", getCompanionAcceptRepository, companionAcceptRepositoryBacking],
  ["companionApplication", getCompanionApplicationRepository, companionApplicationRepositoryBacking],
  ["companionRelease", getCompanionReleaseRepository, companionReleaseRepositoryBacking],
  ["companion", getCompanionRepository, companionRepositoryBacking],
  ["companionService", getCompanionServiceRepository, companionServiceRepositoryBacking],
  ["complaint", getComplaintRepository, complaintRepositoryBacking],
  ["completion", getCompletionRepository, completionRepositoryBacking],
  ["content", getContentRepository, contentRepositoryBacking],
  ["coupon", getCouponRepository, couponRepositoryBacking],
  ["dispatch", getDispatchRepository, dispatchRepositoryBacking],
  ["earning", getEarningRepository, earningRepositoryBacking],
  ["favorite", getFavoriteRepository, favoriteRepositoryBacking],
  ["level", getLevelRepository, levelRepositoryBacking],
  ["message", getMessageRepository, messageRepositoryBacking],
  ["notification", getNotificationRepository, notificationRepositoryBacking],
  ["payment", getPaymentRepository, paymentRepositoryBacking],
  ["platformConfig", getPlatformConfigRepository, platformConfigRepositoryBacking],
  ["qualification", getQualificationRepository, qualificationRepositoryBacking],
  ["refund", getRefundRepository, refundRepositoryBacking],
  ["review", getReviewRepository, reviewRepositoryBacking],
  ["staff", getStaffRepository, staffRepositoryBacking],
  ["suggestion", getSuggestionRepository, suggestionRepositoryBacking],
  ["tip", getTipRepository, tipRepositoryBacking],
  ["user", getUserRepository, userRepositoryBacking],
];

/**
 * 把 `DATA_SOURCE` 设成指定值跑 `body`，跑完**无论成功失败**都恢复成原值。
 *
 * ⚠️ 必须恢复：`assertRepositoriesReadyOnce` 的 memoize 与 `getDataSource()` 都读这个环境变量，
 * 一次泄漏就会让同进程后续用例全部跑在另一个数据源上——而它们多半不会报错，
 * 只会得出别的结论。同时把 memoize 复位，免得「第一次调用」的结论被上一个用例钉住。
 */
function withDataSource(value, body) {
  const had = Object.hasOwn(process.env, "DATA_SOURCE");
  const previous = process.env["DATA_SOURCE"];
  if (value === undefined) delete process.env["DATA_SOURCE"];
  else process.env["DATA_SOURCE"] = value;
  resetRepositoriesReadyAssertion();
  try {
    return body();
  } finally {
    if (had) process.env["DATA_SOURCE"] = previous;
    else delete process.env["DATA_SOURCE"];
    resetRepositoriesReadyAssertion();
  }
}

afterEach(() => {
  // 兜底：任何用例中途抛出都不会把开关留在打开状态。
  delete process.env["DATA_SOURCE"];
  resetRepositoriesReadyAssertion();
});

test("清单自描述：28 条，域名互不重复，且每条都自带 name", () => {
  assert.equal(CORE_ACCESSORS.length, CORE_REPOSITORY_COUNT, "本文件的清单必须与 CORE_REPOSITORY_COUNT 一致");
  const names = CORE_ACCESSORS.map(([, , backing]) => backing.name);
  assert.equal(new Set(names).size, names.length, "backing.name 不该重复");
  for (const [domain, , backing] of CORE_ACCESSORS) {
    assert.equal(backing.name, domain, `backing.name 应等于域名（${domain}）`);
  }
});

test("每个核心仓储都有 Pg 实现（`backing.pg !== null`）", () => {
  const missing = CORE_ACCESSORS.filter(([, , backing]) => backing.pg === null).map(
    ([domain]) => domain,
  );
  assert.deepEqual(missing, [], `以下仓储还没有 Pg 实现：${missing.join("、")}`);
});

test("DATA_SOURCE=postgres：每个访问器都返回 Pg 实现，一个都不回落到 Mock", () => {
  withDataSource("postgres", () => {
    for (const [domain, get, backing] of CORE_ACCESSORS) {
      const picked = get();
      assert.notEqual(picked, backing.mock, `仓储「${domain}」在 postgres 模式下回落到 Mock`);
      assert.equal(picked, backing.pg, `仓储「${domain}」没有返回它的 Pg 实现`);
    }
  });
});

test("DATA_SOURCE 未设置：每个访问器都返回 Mock（迁移策略的默认值）", () => {
  withDataSource(undefined, () => {
    for (const [domain, get, backing] of CORE_ACCESSORS) {
      assert.equal(get(), backing.mock, `仓储「${domain}」在未设置 DATA_SOURCE 时不是 Mock`);
    }
  });
});

test("DATA_SOURCE=mock：显式写 mock 与不写等价，仍然全部返回 Mock", () => {
  withDataSource("mock", () => {
    for (const [domain, get, backing] of CORE_ACCESSORS) {
      assert.equal(get(), backing.mock, `仓储「${domain}」在 DATA_SOURCE=mock 时不是 Mock`);
    }
  });
});

test("fail-fast：postgres 模式下取用一个没有 Pg 实现的仓储会抛错，而不是返回 Mock", () => {
  withDataSource("postgres", () => {
    const stub = { name: "还没迁的域", mock: { id: "mock" }, pg: null };
    assert.throws(
      () => pickRepository(stub),
      (error) => {
        assert.ok(error instanceof MissingPgImplementationError);
        assert.equal(error.repositoryName, "还没迁的域");
        assert.match(error.message, /没有 Pg 实现/);
        return true;
      },
    );
  });
});

test("Mock 模式下 `pg: null` 是合法状态：照常返回 Mock，不抛错", () => {
  withDataSource(undefined, () => {
    const stub = { name: "还没迁的域", mock: { id: "mock" }, pg: null };
    assert.equal(pickRepository(stub), stub.mock);
  });
});

test("`assertAllRepositoriesWired` 一次报出**全部**缺实现的域，而不是第一个就停", () => {
  withDataSource("postgres", () => {
    const backings = [
      { name: "a", mock: {}, pg: {} },
      { name: "b", mock: {}, pg: null },
      { name: "c", mock: {}, pg: null },
    ];
    assert.throws(
      () => assertAllRepositoriesWired(backings),
      (error) => {
        assert.match(error.message, /b、c/, "应当同时列出 b 与 c");
        assert.doesNotMatch(error.message, /a[、，]/, "有实现的 a 不该出现在缺实现清单里");
        return true;
      },
    );
  });
});

test("`assertAllRepositoriesWired` 在 Mock 模式下是空操作（清单有缺也不抛）", () => {
  withDataSource(undefined, () => {
    assertAllRepositoriesWired([{ name: "a", mock: {}, pg: null }]);
  });
});

test("清单条数与 CORE_REPOSITORY_COUNT 不符时抛错（漏登记一行的兜底）", () => {
  withDataSource("postgres", () => {
    const backings = Array.from({ length: CORE_REPOSITORY_COUNT - 1 }, (_, index) => ({
      name: `r${index}`,
      mock: {},
      pg: {},
    }));
    assert.throws(
      () => assertAllRepositoriesWired(backings),
      /CORE_REPOSITORY_COUNT/,
    );
  });
});

test("`assertRepositoriesReadyOnce` 幂等：重复调用不抛错，且 `getDataSource()` 真的会走它", () => {
  withDataSource("postgres", () => {
    assert.doesNotThrow(() => assertRepositoriesReadyOnce());
    assert.doesNotThrow(() => assertRepositoriesReadyOnce());
    // Server Component 那条路径不经过单个访问器，自检必须挂在 `getDataSource()` 上。
    assert.doesNotThrow(() => getDataSource());
  });
});

test("真实清单（lib/data/runtime.ts 里那一份）在 postgres 模式下通过自检", () => {
  withDataSource("postgres", () => {
    assert.doesNotThrow(() => assertRepositoriesReadyOnce());
  });
});
