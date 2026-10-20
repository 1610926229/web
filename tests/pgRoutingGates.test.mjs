import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

/**
 * PROD-1E · Phase 7「运行期路由」的结构门禁。
 *
 * ## 这个文件守的是什么
 *
 * 本轮把所有事务门面改成「Mock 实现改名 + 同文件内薄门面」：
 *
 * ```ts
 * export async function sweepExpiredDispatches(at) {
 *   return isPostgresDataSourceEnabled() ? sweepExpiredDispatchesPg(at) : sweepExpiredDispatchesMock(at);
 * }
 * ```
 *
 * 判据 `isPostgresDataSourceEnabled()` 读 `DATA_SOURCE`，**调用时**求值。这套改动有两个
 * 别的测试都没在守、却最容易「看起来对」的缝：
 *
 * 1. **门面是否真的按 `DATA_SOURCE` 选后端**：把 postgres 分支删掉、或把 Mock 分支删掉、
 *    或把判据提到模块顶层冻成常量，都会让「半套数据源」的表现是页面正常、数字是错的，
 *    而没有任何一条业务测试会红——它们跑的本来就是 Mock 数据。
 * 2. **sweep 调用点有没有 `await`**：sweep 从同步变成返回 Promise 的门面后，
 *    漏一个 `await` 就是「先 sweep 再读」读到 sweep 之前的状态——**不报错，只给旧数据**。
 *
 * ## 为什么本文件不需要数据库、也不读 DATA_SOURCE
 *
 * 这里读的全是**源码文本**：不 import `lib/data/pg/executor.ts` / `pool.ts` 之类会连库的模块。
 * 因此它在 `pnpm test`（Mock 模式）下跑，也在 `pnpm test:pg` 下跑，两边都无副作用——
 * 文件名以 `pg` 开头，正好让两套命令都扫到它，而它本身不连任何库。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DATA = path.join(ROOT, "lib", "data");
const LIB_SERVICES = path.join(ROOT, "lib", "services");

/**
 * `lib/data/` 下的全部 `*Transaction.ts`（**不含** `pg/` 子目录）。
 *
 * ⚠️ 只取 `*Transaction.ts` 而不是所有 `.ts`：路由门面是本轮的产物，落在事务门面文件里；
 * `pg/config.ts`（判据的定义处）、`datasource.ts`（仓储路由，另一套机制）都不在这里面。
 */
function transactionFiles() {
  return collectFiles(LIB_DATA)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => path.basename(file).endsWith("Transaction.ts"))
    .filter((file) => !file.replace(/\\/g, "/").includes("/pg/"))
    .sort();
}

/**
 * 把一份（已 stripComments 的）源码切成「每个导出函数 → 它的体」。
 *
 * 返回 `{ name, start, end, body }`：`start` / `end` 是**函数声明**在源码里的字符区间
 * （从 `export` 到下一个导出声明的开头），`body` 是那段切片。
 *
 * ⚠️ 边界认 **任意** `export`（function / const / let / var / type），理由与
 * `tests/companionServing.test.mjs` 的 `functionBody` 相同：只认 `export async function`
 * 会让「下一个是同步导出」时切片过长，A 函数体内的字样替 B 函数背书。
 */
function exportedFunctionBodies(code) {
  const bodies = [];
  const declaration = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/g;
  for (const match of code.matchAll(declaration)) {
    const name = match[1];
    const start = match.index;
    const rest = code.slice(start + 1);
    const next = rest.search(/export\s+(?:async\s+)?(?:function|const|let|var|type)\s/);
    const end = next === -1 ? code.length : start + 1 + next;
    bodies.push({ name, start, end, body: code.slice(start, end) });
  }
  return bodies;
}

/**
 * 取某个导出函数的体（**带词边界**的精确定位）。
 *
 * ⚠️ 词边界是本文件的正例也自己证明过的东西：`sweepMaturedEarnings` 与
 * `sweepMaturedEarningsMock` 必须解析到两个不同的体，否则「门面是路由、Mock 是实现」
 * 这条判据本身就是错的。无词边界的 `indexOf("export function " + name)` 会把
 * `sweepMaturedEarnings` 前缀命中 `sweepMaturedEarningsMock`，于是「检查门面」
 * 实际看的是实现——恰好这两者都含 `isPostgresDataSourceEnabled()` 与否是**相反**的，
 * 碰上了就全错。
 */
function functionBody(code, name) {
  const fn = exportedFunctionBodies(code).find((entry) => entry.name === name);
  assert.ok(fn, `找不到 ${name}：结构约束无法判定`);
  return fn.body;
}

/**
 * 本文件自己的正例（也是 `functionBody` 的单元自检）。
 *
 * `earningTransaction.ts` 里 `sweepMaturedEarnings`（门面）与
 * `sweepMaturedEarningsMock`（Mock 实现）只有 `Mock` 后缀之差。门面体含
 * `isPostgresDataSourceEnabled()` 且**不含** Mock 实现的写原语 `applyEarningRelease`；
 * Mock 体正好相反。两个体必须不同。
 */
test("helper 正例：functionBody 对「同名 + Mock 后缀」对能解析到两个不同的体", () => {
  const code = stripComments(readSource(path.join(LIB_DATA, "earningTransaction.ts")));

  const facadeBody = functionBody(code, "sweepMaturedEarnings");
  const mockBody = functionBody(code, "sweepMaturedEarningsMock");

  assert.ok(facadeBody.includes("isPostgresDataSourceEnabled()"), "门面体必须落在路由门面上");
  assert.equal(facadeBody.includes("applyEarningRelease"), false, "门面体不得是 Mock 实现");
  assert.ok(mockBody.includes("applyEarningRelease"), "Mock 体必须落在实现上");
  assert.equal(mockBody.includes("isPostgresDataSourceEnabled()"), false, "Mock 体不得被当成门面");
  assert.notEqual(facadeBody, mockBody, "两个名字必须解析到不同的函数体");
});

/**
 * (A) 每个路由门面都必须是纯选择，不许夹带实现。
 *
 * 机械推导：扫 `lib/data/*Transaction.ts`（不含 pg/）里每个**导出函数**，凡函数体含
 * `isPostgresDataSourceEnabled()` 的就是一个路由门面，它必须同时满足——
 *
 * - 体内有 `<名字>Pg(` 调用：postgres 分支确实落到 Pg 实现（`/\b[A-Za-z0-9_]+Pg\(/`）；
 * - 体内有 `*Mock(` 调用：另一支落到 Mock 实现（**这是「不许静默回落到 Mock」的反面：
 *   也不许把 Mock 分支删掉**）；
 * - 体内没有 `await`：门面只做三选一，不做业务（有 `await` 说明它开始做业务了）。
 *
 * 然后与手写清单**完全一致**比对（不是「≥」）：新增一个路由必须改这份清单（故意的——
 * 加路由是一个要过脑子回答「它的 Pg 等价物在哪」的决定），删一个路由、或把某个 Pg
 * 函数改名，都会在这里变红。完全一致比「≥」强：它能同时抓住「少了一个」与
 * 「Pg 名被改错」两种退化。
 */

/** 文件 → 门面名 → Pg 函数名。2026-10-11 PROD-1E 收尾时数出 53 个路由门面。 */
const EXPECTED_FACADES = {
  "lib/data/adminAgreementTransaction.ts": [
    ["setAgreementEnabled", "setAgreementEnabledPg"],
    ["updateAgreement", "updateAgreementPg"],
  ],
  "lib/data/adminCatalogTransaction.ts": [
    ["createCategory", "createCategoryPg"],
    ["createProduct", "createProductPg"],
    ["removeCategory", "removeCategoryPg"],
    ["removeProduct", "removeProductPg"],
    ["setCategoryEnabled", "setCategoryEnabledPg"],
    ["setProductStatus", "setProductStatusPg"],
    ["updateCategory", "updateCategoryPg"],
    ["updateProduct", "updateProductPg"],
  ],
  "lib/data/adminCompanionTransaction.ts": [
    ["approveCompanionApplication", "approveCompanionApplicationPg"],
    ["rejectCompanionApplication", "rejectCompanionApplicationPg"],
    ["removeCompanion", "removeCompanionPg"],
    ["setCompanionFlags", "setCompanionFlagsPg"],
    ["startReviewCompanionApplication", "startReviewCompanionApplicationPg"],
    ["updateCompanionProfile", "updateCompanionProfilePg"],
  ],
  "lib/data/adminComplaintTransaction.ts": [
    ["applyAdminComplaintIntent", "applyAdminComplaintIntentPg"],
  ],
  "lib/data/adminContentTransaction.ts": [
    ["createAnnouncement", "createAnnouncementPg"],
    ["createBanner", "createBannerPg"],
    ["createQuickEntry", "createQuickEntryPg"],
    ["removeAnnouncement", "removeAnnouncementPg"],
    ["removeBanner", "removeBannerPg"],
    ["removeQuickEntry", "removeQuickEntryPg"],
    ["setAnnouncementEnabled", "setAnnouncementEnabledPg"],
    ["setBannerEnabled", "setBannerEnabledPg"],
    ["setQuickEntryEnabled", "setQuickEntryEnabledPg"],
    ["updateAnnouncement", "updateAnnouncementPg"],
    ["updateBanner", "updateBannerPg"],
    ["updateQuickEntry", "updateQuickEntryPg"],
  ],
  "lib/data/adminPlatformConfigTransaction.ts": [
    ["updatePlatformConfig", "updatePlatformConfigPg"],
  ],
  "lib/data/adminRefundTransaction.ts": [
    ["approveRefund", "approveRefundPg"],
    ["rejectRefund", "rejectRefundPg"],
    ["startReviewRefund", "startReviewRefundPg"],
  ],
  "lib/data/adminReviewTransaction.ts": [
    ["moderateReview", "moderateReviewPg"],
  ],
  "lib/data/adminStaffTransaction.ts": [
    ["createStaffAccount", "createStaffAccountPg"],
    ["removeStaffAccount", "removeStaffAccountPg"],
    ["setStaffEnabled", "setStaffEnabledPg"],
    ["updateStaffProfile", "updateStaffProfilePg"],
  ],
  "lib/data/companionDispatchTransaction.ts": [
    ["acceptDispatch", "acceptDispatchPg"],
    ["sweepExpiredDispatches", "sweepExpiredDispatchesPg"],
  ],
  "lib/data/companionOrderTransaction.ts": [
    // PROD-4：客服给还没人接的单指派护航。它与回池 / 换人是三个门面，
    // 前置状态不同、审计动作名不同，因此不能合成一个入口。
    ["assignOrderCompanionByStaff", "assignOrderCompanionByStaffPg"],
    ["cancelAcceptedOrder", "cancelAcceptedOrderPg"],
    ["releaseOrderByStaff", "releaseOrderByStaffPg"],
    ["replaceOrderCompanionByStaff", "replaceOrderCompanionByStaffPg"],
    ["startCompanionOrder", "startCompanionOrderPg"],
  ],
  "lib/data/completionTransaction.ts": [
    ["approveCompletion", "approveCompletionPg"],
    ["rejectCompletion", "rejectCompletionPg"],
    ["submitCompletion", "submitCompletionPg"],
    ["sweepCompletionAutoApprovals", "sweepCompletionAutoApprovalsPg"],
  ],
  "lib/data/couponTemplateTransaction.ts": [
    ["createCouponTemplate", "createCouponTemplatePg"],
    ["setCouponTemplateEnabled", "setCouponTemplateEnabledPg"],
    ["updateCouponTemplate", "updateCouponTemplatePg"],
  ],
  "lib/data/directRefundTransaction.ts": [
    ["directRefundOrder", "directRefundOrderPg"],
  ],
  "lib/data/earningTransaction.ts": [
    ["sweepMaturedEarnings", "sweepMaturedEarningsPg"],
  ],
};

function scanFacades() {
  const found = [];
  for (const file of transactionFiles()) {
    const code = stripComments(readSource(file));
    for (const fn of exportedFunctionBodies(code)) {
      if (!fn.body.includes("isPostgresDataSourceEnabled()")) continue;

      const pgMatch = /\b([A-Za-z0-9_]+Pg)\(/.exec(fn.body);
      assert.ok(
        pgMatch,
        `${file} 的 ${fn.name} 是路由门面（含判据）却没有 *Pg( 调用：postgres 分支被删了`,
      );
      assert.ok(
        /\b[A-Za-z0-9_]+Mock\(/.test(fn.body),
        `${file} 的 ${fn.name} 缺 *Mock( 调用：把 Mock 分支删掉同样是静默回落`,
      );
      assert.equal(
        /\bawait\b/.test(fn.body),
        false,
        `${file} 的 ${fn.name} 门面里出现了 await：门面只做三选一，不做业务`,
      );

      found.push({
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        name: fn.name,
        pg: pgMatch[1],
      });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

test("(A) 结构门禁：每个路由门面都是纯选择，且与手写清单完全一致", () => {
  const found = scanFacades();

  const expected = Object.entries(EXPECTED_FACADES)
    .flatMap(([file, pairs]) => pairs.map(([name, pg]) => ({ file, name, pg })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  assert.deepEqual(
    found,
    expected,
    "路由门面清单与手写清单不一致：新增/删除路由、或改错 Pg 函数名都要先过这里",
  );
});

/**
 * (B) 「刻意不路由」的同步原语：不许被接线，也不许变 async。
 *
 * 这些是 Mock 伪事务原子区段里被**同步**调用的原语，Pg 侧有内嵌等价物
 * （`w1Transactions.ts` / `adminAuditTransactions.ts` 里，随调用方事务一起走）。
 * 接上线会造出「Repository 走 Pg、Transaction 走 Mock」的半事务——同一个请求里
 * 一半事实落库、一半事实留在进程内，那正是 Phase 5 明令禁止的状态。
 *
 * ## 清单范围（说清楚，免得读者以为它是「全仓自动发现」）
 *
 * 本清单是 `02-decisions.md` **D6 那张表**与**同类同步原语**的并集：
 *
 * - D6 表里的 5 个模块：`checkoutCommitTransaction`（`commitMockCheckoutParticipants`）·
 *   `couponRedemptionTransaction`（`redeemCouponClaimForOrder` / `restoreCouponClaimForOrder`）·
 *   `orderBlocking`（`readOrderBlockingFacts`）· `earningTransaction`（`settleOrderCompletion`）·
 *   `companionDispatchTransaction`（`createDispatchForOrder`）；
 * - 同一类但 D6 表未逐一列出的 3 个：`completionTransaction` 的两个作废判据 ·
 *   `companionOrderTransaction.releaseOrdersForCompanion`——它们同样只被别的伪事务在
 *   原子区段里同步调用，因此适用同一条裁定。
 *
 * ⚠️ `orderBlocking.ts` **不是** `*Transaction.ts`，本清单按文件名直接读取，与扫描域无关。
 * 其余「不属于本清单」的同步函数若被接线，另有两条兜底：门禁 (A) 会因它含判据却不在
 * `EXPECTED_FACADES` 里而红；`couponCheckoutChain` 的按函数体 `\bawait\b` 检查会兜住
 * 「偷偷改成 async」。
 *
 * 这条门禁的价值：将来有人"顺手"把这个 GAP 补上，必须先把这条测试改掉——
 * 那时他会看到下面这段理由，而不是在一条绿色测试的掩护下静默改线。
 */
const NOT_ROUTED_SYNC_PRIMITIVES = [
  // 结账参与者：被 mockPaymentRepository 的确认支付原子区段**同步**调用；
  // Pg 侧在 pg/paymentRepository.ts 的同一个 BEGIN…COMMIT 里内嵌完成。
  ["checkoutCommitTransaction.ts", "commitMockCheckoutParticipants"],
  // 券的核销与退回：被结账、管理端退款、派单超时、直接退款四条伪事务在原子区段内调用；
  // Pg 侧是 `redeemCouponClaimForOrderTx` / `restoreCouponClaimForOrderTx`。
  ["couponRedemptionTransaction.ts", "redeemCouponClaimForOrder"],
  ["couponRedemptionTransaction.ts", "restoreCouponClaimForOrder"],
  // 读订单阻塞事实：被两个 sweep 的原子区段调用；Pg 侧是 `readOrderBlockingFacts(tx)`。
  ["orderBlocking.ts", "readOrderBlockingFacts"],
  // 收益结算：被 completionTransaction 的 Mock 完成路径（人工通过 / 到期自动通过）
  // 在原子区段内调用；Pg 侧结算 `settleOrderCompletionTx` 已内嵌在 approveCompletionPg /
  // sweepCompletionAutoApprovalsPg 里，不单独导出。
  ["earningTransaction.ts", "settleOrderCompletion"],
  // 作废 pending 完成材料：被 companionOrderTransaction 的 Mock 释放路径在原子区段内调用；
  // Pg 侧同一件事内嵌在 releaseCurrentAssignmentTx 里。
  ["completionTransaction.ts", "invalidatePendingCompletionForOrder"],
  ["completionTransaction.ts", "canInvalidatePendingCompletionForOrder"],
  // 建派单：被 checkout 的 Mock 结账事务在无 await 原子区段内调用；
  // Pg 侧建派单在 pg/paymentRepository.ts 的同一个 BEGIN…COMMIT 里完成。
  ["companionDispatchTransaction.ts", "createDispatchForOrder"],
  // 封禁回池：被 setCompanionFlags 的原子区段**同步**调用，改成 async 就等于把
  // 原子性交给「调用方记得不要 await」这条口头约定。
  ["companionOrderTransaction.ts", "releaseOrdersForCompanion"],
];

test("(B) 刻意不路由的同步原语：不是 async、不含判据、不调 *Pg(", () => {
  for (const [file, name] of NOT_ROUTED_SYNC_PRIMITIVES) {
    const code = stripComments(readSource(path.join(LIB_DATA, file)));
    const body = functionBody(code, name);

    // ⚠️ 这条不是形式主义：下面三条都是**否定式**断言，若名字写错（或函数被改名）导致
    //    `functionBody` 返回空串，它们会**全部真空通过**——清单看起来还在守，其实一个字符
    //    都没检查。先钉住「这个函数确实被解析出来了」，否定式断言才有意义。
    assert.notEqual(
      body.trim(),
      "",
      `${file} 里解析不到 ${name}：名字写错或函数被改名，下面的否定式断言会真空通过`,
    );

    assert.equal(
      /^export\s+async\s+function\b/.test(body.trimStart()),
      false,
      `${name} 必须是同步导出：它跑在另一个原子区段里，async 会把原子性交给调用方的自觉`,
    );
    assert.equal(
      body.includes("isPostgresDataSourceEnabled()"),
      false,
      `${name} 不得被接进路由：接上线会造出「Repository 走 Pg、Transaction 走 Mock」的半事务`,
    );
    assert.equal(
      /\b[A-Za-z0-9_]+Pg\(/.test(body),
      false,
      `${name} 不得调用 Pg 实现：它的 Pg 等价物内嵌在调用方事务里，不经过这里`,
    );
  }
});

/**
 * (C) 门面必须在**调用时**求值，不许把判据提到模块顶层。
 *
 * `DATA_SOURCE` 是运行时可变的（测试与本地开发都会在同一进程里翻转它），
 * 顶层的 `const USE_PG = isPostgresDataSourceEnabled()` 会把「进程启动时是什么」冻住。
 * 判据的**每一次**出现都必须落在某个导出函数体内——「函数体覆盖的全部字符区间
 * 是否覆盖了每一处出现」就是这条判据。
 */
test("(C) isPostgresDataSourceEnabled() 的每一次出现都在某个导出函数体内", () => {
  let total = 0;
  for (const file of transactionFiles()) {
    const code = stripComments(readSource(file));
    const ranges = exportedFunctionBodies(code).map((fn) => [fn.start, fn.end]);

    for (const match of code.matchAll(/isPostgresDataSourceEnabled\(\)/g)) {
      total += 1;
      const inside = ranges.some(([start, end]) => match.index >= start && match.index < end);
      assert.ok(
        inside,
        `${file} 第 ${match.index} 处的 isPostgresDataSourceEnabled() 不在任何导出函数体内：判据被提到了模块顶层`,
      );
    }
  }
  assert.ok(
    total > 0,
    "正例：扫描必须命中 isPostgresDataSourceEnabled()，否则上面的断言是在对空集说话",
  );
});

/**
 * (D) 三个 sweep 的读取路径调用点必须 `await`。
 *
 * sweep 已经从同步变成返回 Promise 的门面，漏一个 `await` 就是「先 sweep 再读」读到
 * sweep 之前的状态——**这个 bug 不会报错，只会给出旧数据**（页面正常、数据是旧的）。
 *
 * 扫描范围：`lib/services/**` 与 `lib/data/**`（不含 pg/）的 `.ts`。定义处除外——
 * 先 `stripComments` 去掉注释（注释里的「调用同一个 sweepMaturedEarnings()」不算调用），
 * 再用「调用名紧跟前一个字符必须是 `(`」区分调用点与 import 行（import 没有 `(`），
 * 再用「紧挨的前文以 `function ` 结尾」排除定义处。
 */
const SWEEP_NAMES = ["sweepExpiredDispatches", "sweepCompletionAutoApprovals", "sweepMaturedEarnings"];

test("(D) 三个 sweep 的读取路径调用点必须紧跟 await", () => {
  const files = [
    ...collectFiles(LIB_SERVICES),
    ...collectFiles(LIB_DATA),
  ]
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.replace(/\\/g, "/").includes("/pg/"))
    .sort();

  const hits = [];
  for (const file of files) {
    const code = stripComments(readSource(file));
    for (const name of SWEEP_NAMES) {
      const re = new RegExp(`${name}\\(`, "g");
      for (const match of code.matchAll(re)) {
        const prefix = code.slice(0, match.index);
        if (/function\s+$/.test(prefix)) continue; // 定义处（export async function sweepXxx(...)）
        hits.push({
          file: path.relative(ROOT, file).replace(/\\/g, "/"),
          name,
          awaited: /await\s+$/.test(prefix),
        });
      }
    }
  }

  // 正例：扫描确实读到了文件、且命中数 > 0，而且三个名字都各至少有一个调用点——
  // 否则「每个调用点都 await」是对空集说话（假绿）。
  assert.ok(hits.length > 0, "正例：扫描必须命中至少一个 sweep 调用点");
  for (const name of SWEEP_NAMES) {
    assert.ok(
      hits.some((hit) => hit.name === name),
      `正例：扫描必须命中 ${name} 的调用点，否则该名字的检查是空转`,
    );
  }

  for (const hit of hits) {
    assert.equal(
      hit.awaited,
      true,
      `${hit.file} 的 ${hit.name}( 调用点没有 await：sweep 已变成返回 Promise 的门面，漏 await 会读到 sweep 之前的旧状态`,
    );
  }
});
