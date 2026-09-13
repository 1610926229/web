import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMPANION_APPLICATION_EXISTS_MESSAGE,
  COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE,
  COMPANION_APPLICATION_REGION_INVALID_MESSAGE,
  COMPANION_APPLICATION_STATUS_LABELS,
  COMPANION_APPLICATION_TAG_INVALID_MESSAGE,
  buildCompanionApplicationTimeline,
  canWithdrawCompanionApplication,
} from "../lib/constants/companionApplications.ts";
import { EVIDENCE_PLACEHOLDER_URL } from "../lib/constants/evidence.ts";
import { IDEMPOTENCY_KEY_MISSING_MESSAGE } from "../lib/constants/writes.ts";
import { getCompanionApplicationRepository } from "../lib/data/companionApplicationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { companionSeed } from "../lib/mocks/fixtures/seed.ts";
import {
  createCompanionApplicationForUser,
  getMyCompanionApplicationDetail,
  getMyCompanionApplicationSummary,
  listCompanionApplicationGameOptions,
  withdrawCompanionApplicationForUser,
} from "../lib/services/companionApplications.ts";

/**
 * 护航入驻申请的持续测试。
 *
 * 跑的是**真实实现**：真实的内存仓储 + 真实的 `lib/services/companionApplications.ts`，
 * 因此「一个人最多一条」「身份 / 单号 / 状态 / 时间用户写不了」「撤销只改状态不删记录」
 * 这些规则每次提交都会被重新验证，而不是一次性检查。
 *
 * 五条边界必须由测试守住：
 *
 * 1. **用户能造出来的状态只有两种**：提交产生 `pending`，撤销产生 `withdrawn`；
 * 2. **审核与角色无关**：没有改状态接口，通过申请不会改用户角色、不会创建陪玩公开资料；
 * 3. **幂等不靠按钮禁用**：同一个幂等键重复到达返回第一次的结果，换键也写不进第二条；
 * 4. **不存在与不属于本人返回同一个 404**；
 * 5. **DTO 不含 userId**，摘要只有状态 / 单号 / 时间。
 */

const USER_FREE = "u-1001"; // 预置里故意没有申请
const USER_PENDING = "u-1002";
const USER_REVIEWING = "u-1003";
const USER_APPROVED = "u-1004";
const USER_REJECTED = "u-1005";
const USER_WITHDRAWN = "u-1006";
const USER_OTHER = "u-1008"; // 没有申请的另一个用户

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");

function uniqueKey() {
  return `key-${crypto.randomUUID().slice(0, 18)}`;
}

function validBody(overrides = {}) {
  return {
    displayName: "测试陪玩（占位）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["护航"],
    experience: "三角洲行动打了两年，机密单为主。（测试文案）",
    introduction: "晚上在线，周末全天可以打。（测试文案）",
    contactNote: "",
    evidence: [{ kind: "image", name: "level.png" }],
    idempotencyKey: uniqueKey(),
    ...overrides,
  };
}

/** 提交一条申请。默认自动生成幂等键，调用方可以显式覆盖（例如测缺键 / 复用键）。 */
function submit(userId, overrides = {}, now = FIXED_NOW) {
  return createCompanionApplicationForUser(userId, validBody(overrides), undefined, "server", now);
}

function withdraw(userId, id, now = FIXED_NOW) {
  return withdrawCompanionApplicationForUser(userId, id, undefined, "server", now);
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

beforeEach(() => {
  resetMockStore("companionApplication");
});

// ——————————————————————————— 读取 ———————————————————————————

test("没有申请是正常状态：摘要与详情都返回 null，不用 404 表达", async () => {
  assert.equal(await getMyCompanionApplicationSummary(USER_FREE, undefined, "server"), null);
  assert.equal(await getMyCompanionApplicationDetail(USER_FREE, undefined, "server"), null);
});

test("预置数据覆盖五种状态，摘要只带状态 / 单号 / 时间", async () => {
  const expected = {
    [USER_PENDING]: "pending",
    [USER_REVIEWING]: "reviewing",
    [USER_APPROVED]: "approved",
    [USER_REJECTED]: "rejected",
    [USER_WITHDRAWN]: "withdrawn",
  };

  for (const [userId, status] of Object.entries(expected)) {
    const summary = await getMyCompanionApplicationSummary(userId, undefined, "server");
    assert.equal(summary.status, status);
    assert.equal(summary.statusLabel, COMPANION_APPLICATION_STATUS_LABELS[status]);
    // 摘要的字段集合是确定的一份：表单内容与凭证不进这里
    assert.deepEqual(
      Object.keys(summary).sort(),
      ["applicationNo", "id", "status", "statusLabel", "submittedAt", "updatedAt"],
    );
  }

  // 「已撤销」有两条（一条有凭证、一条没有），凭证是选填
  const noEvidence = await getMyCompanionApplicationDetail("u-1007", undefined, "server");
  assert.deepEqual(noEvidence.evidence, []);
});

test("详情 DTO 不含 userId，凭证地址一律是占位图", async () => {
  const detail = await getMyCompanionApplicationDetail(USER_APPROVED, undefined, "server");

  assert.equal("userId" in detail, false, "详情 DTO 泄漏了 userId");
  assert.equal(detail.displayName.includes("占位"), true);
  assert.ok(detail.games.length > 0);
  // 游戏带名称：前端不用自己维护一份 id → 名称的映射
  assert.deepEqual(detail.games[0], { id: "g-delta", name: "三角洲行动" });

  for (const item of detail.evidence) {
    assert.equal(item.url, EVIDENCE_PLACEHOLDER_URL);
    assert.equal(item.url.startsWith("/mock/"), true);
  }

  // 权限由服务端给出，前端不拿状态自己推断
  assert.deepEqual(detail.allowedActions, { canWithdraw: false });
  assert.equal(
    (await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server")).allowedActions
      .canWithdraw,
    true,
  );
  for (const userId of [USER_REVIEWING, USER_APPROVED, USER_REJECTED, USER_WITHDRAWN]) {
    assert.equal(canWithdrawCompanionApplication((await getMyCompanionApplicationDetail(userId, undefined, "server")).status), false);
  }
});

test("时间轴只列已经发生的节点，不编造未来的审核时间", async () => {
  // 待查看：只有一个节点
  const pending = await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server");
  assert.deepEqual(
    pending.timeline.map((entry) => entry.key),
    ["pending"],
  );

  // 审核中：提交 + 开始查看两个节点
  const reviewing = await getMyCompanionApplicationDetail(USER_REVIEWING, undefined, "server");
  assert.deepEqual(
    reviewing.timeline.map((entry) => entry.key),
    ["pending", "reviewing"],
  );

  // 已通过：出结果的那一步把审核备注带上
  const approved = await getMyCompanionApplicationDetail(USER_APPROVED, undefined, "server");
  assert.deepEqual(
    approved.timeline.map((entry) => entry.key),
    ["pending", "approved"],
  );
  assert.equal(approved.timeline[1].note, approved.reviewNote);
  assert.equal(approved.reviewNote.length > 0, true);
  assert.equal(approved.reviewedAt, approved.timeline[1].at);

  // 没有结果的状态不带审核时间与审核备注
  for (const detail of [pending, reviewing]) {
    assert.equal(detail.reviewedAt, null);
    assert.equal(detail.reviewNote, "");
  }

  // 所有节点都已经发生，且按时间升序
  const all = [pending, reviewing, approved];
  for (const detail of all) {
    for (let index = 0; index < detail.timeline.length; index += 1) {
      assert.ok(detail.timeline[index].at <= new Date().toISOString(), "时间轴出现了未来的节点");
      if (index > 0) assert.ok(detail.timeline[index - 1].at <= detail.timeline[index].at);
    }
  }
});

test("表单选项来自真实游戏目录，大区跟着游戏走", async () => {
  const options = await listCompanionApplicationGameOptions();

  assert.deepEqual(
    options.map((game) => game.id),
    ["g-delta", "g-valorant"],
  );
  assert.deepEqual(options[0].regions, ["手游", "端游"]);
  assert.deepEqual(options[1].regions, ["端游"]);
});

// ——————————————————————————— 提交 ———————————————————————————

test("提交产生「待查看」，身份 / 单号 / 状态 / 时间一律由服务端写", async () => {
  const result = await submit(USER_FREE);

  assert.equal(result.created, true);
  assert.equal(result.status, "pending");
  assert.match(result.applicationNo, /^RA20260913\d{6}$/);

  const detail = await getMyCompanionApplicationDetail(USER_FREE, undefined, "server");
  assert.equal(detail.status, "pending");
  assert.equal(detail.reviewedAt, null);
  assert.equal(detail.reviewNote, "");
  assert.equal(detail.submittedAt, FIXED_NOW.toISOString());
  assert.equal(detail.updatedAt, FIXED_NOW.toISOString());
  assert.equal(detail.displayName, "测试陪玩（占位）");
  assert.equal(detail.contactNote, "");
  assert.deepEqual(detail.games, [{ id: "g-delta", name: "三角洲行动" }]);

  // 凭证的 id 与地址由服务端生成，客户端只提交了类型与文件名
  assert.equal(detail.evidence.length, 1);
  assert.equal(detail.evidence[0].name, "level.png");
  assert.equal(detail.evidence[0].url, EVIDENCE_PLACEHOLDER_URL);
  assert.equal(detail.evidence[0].id.startsWith("ev_"), true);
});

test("客户端伪造的用户 / 单号 / 状态 / 时间一律被忽略", async () => {
  const result = await submit(USER_FREE, {
    id: "ca-hack",
    applicationNo: "RA-HACK-0001",
    userId: USER_OTHER,
    status: "approved",
    reviewedAt: "2020-01-01T00:00:00.000Z",
    reviewNote: "已通过",
    submittedAt: "2020-01-01T00:00:00.000Z",
  });

  // 服务端生成的 id 与单号，不是请求体里那两个
  assert.notEqual(result.applicationId, "ca-hack");
  assert.notEqual(result.applicationNo, "RA-HACK-0001");
  assert.equal(result.status, "pending");

  const detail = await getMyCompanionApplicationDetail(USER_FREE, undefined, "server");
  assert.equal(detail.status, "pending");
  assert.equal(detail.reviewNote, "");
  assert.equal(detail.reviewedAt, null);
  assert.equal(detail.submittedAt, FIXED_NOW.toISOString());

  // 没有写到被别人冒名的那个人名下
  assert.equal(await getMyCompanionApplicationSummary(USER_OTHER, undefined, "server"), null);
});

test("幂等：同一个键重复提交只留一条，返回第一次的结果", async () => {
  const key = uniqueKey();
  const first = await submit(USER_FREE, { idempotencyKey: key });
  const again = await submit(USER_FREE, { idempotencyKey: key, displayName: "改过的昵称（占位）" });

  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.applicationId, first.applicationId);
  assert.equal(again.applicationNo, first.applicationNo);

  // 内容仍然是第一次那份：重试要的是「和上次一样的结果」
  const detail = await getMyCompanionApplicationDetail(USER_FREE, undefined, "server");
  assert.equal(detail.displayName, "测试陪玩（占位）");

  // 幂等键是「用户 + 键」作用域：同一个人换键提交会被「已有申请」挡住
  await expectApiError(submit(USER_FREE), "BAD_REQUEST", COMPANION_APPLICATION_EXISTS_MESSAGE);

  // 另一个用户用同一个键是另一条申请，互不影响
  const other = await submit(USER_OTHER, { idempotencyKey: key });
  assert.equal(other.created, true);
  assert.notEqual(other.applicationId, first.applicationId);
});

test("缺少或非法幂等键直接拒绝：没有键就无法防重", async () => {
  await expectApiError(
    createCompanionApplicationForUser(
      USER_FREE,
      validBody({ idempotencyKey: "" }),
      undefined,
      "server",
      FIXED_NOW,
    ),
    "BAD_REQUEST",
    IDEMPOTENCY_KEY_MISSING_MESSAGE,
  );
  await expectApiError(submit(USER_FREE, { idempotencyKey: "短" }), "BAD_REQUEST");

  assert.equal(await getMyCompanionApplicationSummary(USER_FREE, undefined, "server"), null);
});

test("已有申请（含预置的）不能被第二次提交覆盖", async () => {
  for (const userId of [
    USER_PENDING,
    USER_REVIEWING,
    USER_APPROVED,
    USER_REJECTED,
    USER_WITHDRAWN,
  ]) {
    await expectApiError(submit(userId), "BAD_REQUEST", COMPANION_APPLICATION_EXISTS_MESSAGE);
  }

  // 预置的那条原样还在，没有被新提交顶掉
  const detail = await getMyCompanionApplicationDetail(USER_APPROVED, undefined, "server");
  assert.equal(detail.status, "approved");
});

test("并发提交只会留下一条记录（不依赖按钮禁用）", async () => {
  // 同一个键的两个并发请求：两个都成功返回，但只有一次是「创建」
  const key = uniqueKey();
  const results = await Promise.all([
    submit(USER_FREE, { idempotencyKey: key }),
    submit(USER_FREE, { idempotencyKey: key }),
  ]);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(results[0].applicationId, results[1].applicationId);
  assert.equal(results[0].applicationNo, results[1].applicationNo);

  // 换一个键、换一个还没有申请的用户再并发一次：一个成功，另一个被「已有申请」挡住
  const keyB = uniqueKey();
  const keyC = uniqueKey();
  const settled = await Promise.allSettled([
    submit(USER_OTHER, { idempotencyKey: keyB }),
    submit(USER_OTHER, { idempotencyKey: keyC }),
  ]);
  assert.deepEqual(
    settled.map((item) => item.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    settled.find((item) => item.status === "rejected").reason.code,
    "BAD_REQUEST",
  );

  // 仓储里仍然只有一条：两个键只有一个能查到记录，另一个什么都没写进去
  const repository = getCompanionApplicationRepository();
  const byKeyB = await repository.findApplicationByKey(USER_OTHER, keyB);
  const byKeyC = await repository.findApplicationByKey(USER_OTHER, keyC);
  assert.equal([byKeyB, byKeyC].filter(Boolean).length, 1);
  assert.equal(
    (await repository.findApplicationByUser(USER_FREE)).id,
    results[0].applicationId,
  );
});

test("表单校验：空白 / 超长 / 无效游戏 / 大区不属于所选游戏 / 无效标签 / 凭证过多", async () => {
  const cases = [
    [{ displayName: "   " }, "请填写陪玩昵称"],
    [{ displayName: "占位".repeat(20) }, `陪玩昵称不能超过 20 个字符`],
    [{ gameIds: [] }, COMPANION_APPLICATION_GAME_REQUIRED_MESSAGE],
    [{ gameIds: ["g-not-exist"] }, "所选游戏不是有效游戏，请重新选择"],
    [{ gameIds: ["g-valorant"], regions: ["手游"] }, COMPANION_APPLICATION_REGION_INVALID_MESSAGE],
    [{ regions: [] }, "请至少选择一个可服务的大区"],
    [{ serviceTags: ["不存在的标签"] }, COMPANION_APPLICATION_TAG_INVALID_MESSAGE],
    [{ serviceTags: [] }, "请至少选择一个服务标签"],
    [{ experience: "  " }, "请填写经验说明"],
    [{ introduction: "" }, "请填写自我介绍"],
    [{ contactNote: "占位".repeat(30) }, "联系说明不能超过 50 个字符"],
    [
      {
        evidence: Array.from({ length: 5 }, (_, index) => ({
          kind: "image",
          name: `shot-${index}.png`,
        })),
      },
      "最多上传 4 个凭证",
    ],
  ];

  for (const [overrides, message] of cases) {
    await expectApiError(submit(USER_FREE, overrides), "BAD_REQUEST", message);
  }

  // 一条都没写进去
  assert.equal(await getMyCompanionApplicationSummary(USER_FREE, undefined, "server"), null);
});

test("重复项静默去重，去重后为空才报错", async () => {
  const result = await submit(USER_FREE, {
    gameIds: ["g-delta", "g-delta"],
    regions: ["手游", "手游"],
    serviceTags: ["护航", "护航"],
  });

  const detail = await getMyCompanionApplicationDetail(USER_FREE, undefined, "server");
  assert.deepEqual(detail.games, [{ id: "g-delta", name: "三角洲行动" }]);
  assert.deepEqual(detail.regions, ["手游"]);
  assert.deepEqual(detail.serviceTags, ["护航"]);
  assert.equal(result.created, true);
});

// ——————————————————————————— 撤销 ———————————————————————————

test("撤销只改状态：记录仍在，表单内容仍看得到，撤销键不能再提交", async () => {
  const before = await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server");

  const result = await withdraw(USER_PENDING, before.id, new Date("2026-09-14T09:00:00.000Z"));
  assert.equal(result.withdrawn, true);
  assert.equal(result.status, "withdrawn");

  const after = await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server");
  assert.equal(after.status, "withdrawn");
  assert.equal(after.updatedAt, "2026-09-14T09:00:00.000Z");
  assert.equal(after.allowedActions.canWithdraw, false);
  // 只改状态，不删记录：提交过的内容必须还能看到
  assert.equal(after.displayName, before.displayName);
  assert.equal(after.experience, before.experience);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(after.submittedAt, before.submittedAt);

  // 撤销也不产生审核时间与备注
  assert.equal(after.reviewedAt, null);
  assert.equal(after.reviewNote, "");

  // 撤销后仍然是一个人一条：不能再提交一份
  await expectApiError(submit(USER_PENDING), "BAD_REQUEST", COMPANION_APPLICATION_EXISTS_MESSAGE);
});

test("重复撤销是幂等的：返回同一条记录，不再产生第二次变更", async () => {
  const first = await withdraw(USER_PENDING, "ca-1002", new Date("2026-09-14T09:00:00.000Z"));
  const again = await withdraw(USER_PENDING, "ca-1002", new Date("2026-09-15T09:00:00.000Z"));

  assert.equal(first.withdrawn, true);
  assert.equal(again.withdrawn, false);
  assert.equal(again.applicationId, first.applicationId);
  assert.equal(again.status, "withdrawn");

  // 时间没有被第二次撤销改写
  const detail = await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server");
  assert.equal(detail.updatedAt, "2026-09-14T09:00:00.000Z");

  // 预置的「已撤销」同样是幂等成功，而不是错误
  const seeded = await withdraw(USER_WITHDRAWN, "ca-1006");
  assert.equal(seeded.withdrawn, false);
  assert.equal(seeded.status, "withdrawn");
});

test("只有「待查看」可以撤销，其余状态一律 400", async () => {
  const cases = [
    [USER_REVIEWING, "ca-1003", "审核中"],
    [USER_APPROVED, "ca-1004", "已通过"],
    [USER_REJECTED, "ca-1005", "未通过"],
  ];

  for (const [userId, id, label] of cases) {
    await expectApiError(withdraw(userId, id), "BAD_REQUEST", `当前状态为「${label}」，不能撤销`);
  }

  // 状态没有被改动
  assert.equal(
    (await getMyCompanionApplicationDetail(USER_APPROVED, undefined, "server")).status,
    "approved",
  );
});

test("不存在与不属于本人返回同一个 404：拿别人的 id 试探得不到信息", async () => {
  const missing = await withdraw(USER_FREE, "ca-not-exist").catch((error) => error);
  const someoneElse = await withdraw(USER_FREE, "ca-1002").catch((error) => error);
  const someoneElse2 = await withdraw(USER_OTHER, "ca-1002").catch((error) => error);

  for (const error of [missing, someoneElse, someoneElse2]) {
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.status, 404);
  }
  // 三种情况的对外表现完全相同
  assert.equal(missing.message, someoneElse.message);
  assert.equal(someoneElse.message, someoneElse2.message);

  // 别人的申请没有被改动
  assert.equal(
    (await getMyCompanionApplicationDetail(USER_PENDING, undefined, "server")).status,
    "pending",
  );
});

// ——————————————————————————— 审核与角色边界 ———————————————————————————

test("没有改状态的接口：只有提交与撤销两个 POST，没有 PATCH / PUT / DELETE", async () => {
  const routesRoot = fileURLToPath(new URL("../app/api/companion-applications", import.meta.url));
  const files = await readdir(routesRoot, { recursive: true, withFileTypes: true });
  const routeFiles = files
    .filter((entry) => entry.isFile() && entry.name === "route.ts")
    .map((entry) => join(entry.parentPath, entry.name));

  assert.equal(routeFiles.length, 2, "入驻申请接口只该有「提交」与「撤销」两个");

  for (const file of routeFiles) {
    const source = stripComments(await readFile(file, "utf8"));
    for (const method of ["PATCH", "PUT", "DELETE"]) {
      assert.equal(source.includes(`export async function ${method}`), false);
    }
  }
});

test("服务层没有任何把状态改成 reviewing / approved / rejected 的路径", async () => {
  const source = stripComments(
    await readFile(new URL("../lib/services/companionApplications.ts", import.meta.url), "utf8"),
  );

  // 这三个状态只可能来自预置数据（或将来后台的返回），用户端写不出来
  for (const status of ["reviewing", "approved", "rejected"]) {
    assert.equal(source.includes(`"${status}"`), false, `服务层出现了写死的状态：${status}`);
  }

  // 通过申请不改用户角色、不创建陪玩公开资料、不赋订单权限
  for (const forbidden of [
    "assignRole",
    "updateUser",
    /createCompanion\s*\(/,
    "companionRepository",
    "getCompanionRepository",
    "createOrder",
    "createPayment",
  ]) {
    if (typeof forbidden === "string") {
      assert.equal(source.includes(forbidden), false, `入驻申请服务触碰了业务数据：${forbidden}`);
    } else {
      assert.equal(forbidden.test(source), false, `入驻申请服务触碰了业务数据：${forbidden}`);
    }
  }

  // 申请内容也不会流进公开陪玩名单 / 数据源
  const companions = JSON.stringify(companionSeed);
  for (const field of ["experience", "introduction", "contactNote", "applicationNo"]) {
    assert.equal(companions.includes(`"${field}"`), false, `陪玩名单出现了申请字段：${field}`);
  }
  const companionService = await readFile(
    new URL("../lib/services/companions.ts", import.meta.url),
    "utf8",
  );
  assert.equal(companionService.includes("companionApplication"), false, "公开陪玩服务引用了入驻申请");
});

test("申请一律从「待查看」开始：预置里也不存在用户能造出的第三种状态", () => {
  const statuses = new Set(companionApplicationSeed.map((item) => item.status));
  assert.deepEqual([...statuses].sort(), [
    "approved",
    "pending",
    "rejected",
    "reviewing",
    "withdrawn",
  ]);

  // 每个状态都能对上时间轴的节点数：结果状态必须有审核时间，没结果的必须没有
  for (const application of companionApplicationSeed) {
    const timeline = buildCompanionApplicationTimeline(application);
    assert.ok(timeline.length >= 1);
    const settled = application.status === "approved" || application.status === "rejected";
    assert.equal(application.reviewedAt !== null, settled);
    assert.equal(application.reviewNote.length > 0, settled);
  }
});
