import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  ADMIN_APPLICATION_TRANSITIONS,
  ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  ADMIN_REVIEW_NOTE_MAX_LENGTH,
  ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  adminApplicationAllowedActions,
  canTransitionCompanionApplication,
  normalizeAdminReviewNote,
} from "../lib/constants/adminApplications.ts";
import {
  ADMIN_COMPANION_DISABLED_MESSAGE,
  ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_COMPANION_NOT_FOUND_MESSAGE,
  ADMIN_COMPANION_OPERATION_CONFLICT_MESSAGE,
  ADMIN_COMPANION_REMOVED_MESSAGE,
  COMPANION_AVATAR_OPTIONS,
  COMPANION_PROFILE_REASON_MAX_LENGTH,
  COMPANION_PROFILE_REASON_REQUIRED_MESSAGE,
  COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE,
  COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE,
  NEW_COMPANION_UNAVAILABLE_REASON,
  adminCompanionStatus,
  normalizeCompanionReason,
} from "../lib/constants/adminCompanions.ts";
import { COMPANION_APPLICATION_STATUS_LABELS } from "../lib/constants/companionApplications.ts";
import { isCompanionListed } from "../lib/constants/companions.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getCompanionApplicationRepository } from "../lib/data/companionApplicationRepository.ts";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { createCompanionRecord } from "../lib/data/mockCompanionRepository.ts";
import { grantQualificationRecord } from "../lib/data/mockQualificationRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getQualificationRepository } from "../lib/data/qualificationRepository.ts";
import { getDataSource } from "../lib/data/source.ts";
import { companionApplicationSeed } from "../lib/mocks/fixtures/companionApplicationSeed.ts";
import { companionSeed, userSeed } from "../lib/mocks/fixtures/seed.ts";
import { getConsumptionRanking } from "../lib/services/rankings.ts";
import { createPaymentRequest, getCompanions, previewCheckout } from "../lib/services/checkout.ts";
import {
  getCompanionDetail,
  queryCompanionPage,
  resolveCompanionListQuery,
} from "../lib/services/companions.ts";
import {
  approveAdminApplication,
  getAdminApplicationDetail,
  queryAdminApplicationList,
  rejectAdminApplication,
  resolveAdminApplicationListQuery,
  startReviewAdminApplication,
} from "../lib/services/adminCompanionApplications.ts";
import {
  getAdminCompanionDetail,
  queryAdminCompanionList,
  removeAdminCompanion,
  resolveAdminCompanionListQuery,
  setAdminCompanionFlags,
  updateAdminCompanion,
} from "../lib/services/adminCompanions.ts";

/**
 * P8A：入驻审核 + 护航管理。
 *
 * 断言的是**真实实现**：`lib/services/*` 与真实的 Mock 仓储（与 `admin.test.mjs`
 * 里的概览测试同一套做法），不是复制一份逻辑再测一遍复制品。
 *
 * 这里守的是 §六 ~ §十二 里那些「只有真跑起来才看得见」的保证：
 *
 * 1. **状态机只有一处**：非法迁移被拒、终态没有出边、`allowedActions` 从迁移表推导；
 * 2. **通过的语义**：改状态 + 发资格 + 建（或关联）护航 + 写审计，四件事一起成立，
 *    失败不留半成品；拒绝**不产生护航**；一位用户最多一条有效护航；
 * 3. **数据源只有一份**：后台改完，用户端列表 / 详情 / 结算立刻是新值；
 * 4. **审计与幂等**：每项写操作有且只有一条审计，重复提交不产生第二条，
 *    审计里不出现 Cookie、凭据与凭证文件名；
 * 5. **统计不可改**：白名单之外的字段（评分 / 完成单数 / 关联用户）怎么传都无效。
 *
 * 需要真实服务的断言（HTTP 状态码、权限矩阵、开关）走 `APP_BASE_URL`，
 * 未提供地址时整组跳过——与 `admin.test.mjs` / `http-smoke.test.mjs` 同一套做法。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 P8A 的 HTTP 用例";

/** 执行操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置数据里的几个关键对象。 */
const PENDING_APPLICATION = "ca-1002"; // u-1002 待查看
const REVIEWING_APPLICATION = "ca-1003"; // u-1003 审核中
const APPROVED_APPLICATION = "ca-1004"; // u-1004 已通过
const REJECTED_APPLICATION = "ca-1005"; // u-1005 未通过
const WITHDRAWN_APPLICATION = "ca-1006"; // u-1006 已撤销

let keySeq = 0;
/** 每个用例一个全新的幂等键：键与「这次意图」绑定，用例之间不能共用。 */
function uniqueKey() {
  keySeq += 1;
  return `p8a-test-key-${process.pid}-${keySeq}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 管理端列表：从地址栏参数解析出查询条件，再取数（页面与接口走的是同一条路径）。 */
async function adminApplications(params = {}) {
  const search = page(params);
  const query = await resolveAdminApplicationListQuery(search, false);
  return queryAdminApplicationList(query, search, "server");
}

async function adminCompanions(params = {}) {
  const search = page(params);
  const query = await resolveAdminCompanionListQuery(search, false);
  return queryAdminCompanionList(query, search, "server");
}

async function publicCompanions(params = {}) {
  const search = page(params);
  const query = await resolveCompanionListQuery(search, false);
  return queryCompanionPage(query, search, "server");
}

/** 结算页的陪玩选择：一份真实存在的商品 + 指定的陪玩。 */
function checkoutSelection(companionId) {
  return {
    productId: "p-400w",
    specId: "s-400w",
    region: "手游",
    quantity: 1,
    addonIds: [],
    gameAccountId: "moyu_test",
    remark: "",
    companionId,
  };
}

beforeEach(() => {
  resetMockStore("companionApplication");
  resetMockStore("companion");
  resetMockStore("qualification");
  resetMockStore("adminAudit");
});

// ——————————————————————————— §六 状态机 ———————————————————————————

test("合法迁移只有这几条：待查看可开始/通过/拒绝，审核中只能出结果，终态无出边", () => {
  assert.deepEqual(ADMIN_APPLICATION_TRANSITIONS, {
    pending: ["reviewing", "approved", "rejected"],
    reviewing: ["approved", "rejected"],
    approved: [],
    rejected: [],
    withdrawn: [],
  });

  for (const [from, targets] of Object.entries(ADMIN_APPLICATION_TRANSITIONS)) {
    // `from === to` 不是迁移：再点一次「通过」不该被当成合法操作
    assert.equal(canTransitionCompanionApplication(from, from), false, `${from} → ${from}`);
    for (const to of targets) {
      assert.equal(canTransitionCompanionApplication(from, to), true, `${from} → ${to}`);
    }
  }

  // 终态没有任何出边，包括「撤销」（用户自己的动作，后台改不了）
  for (const terminal of ["approved", "rejected", "withdrawn"]) {
    assert.deepEqual(ADMIN_APPLICATION_TRANSITIONS[terminal], []);
  }
});

test("可执行动作由迁移表推导：终态三个动作全为 false，没有第二条规则", () => {
  assert.deepEqual(adminApplicationAllowedActions("pending"), {
    canStartReview: true,
    canApprove: true,
    canReject: true,
  });
  assert.deepEqual(adminApplicationAllowedActions("reviewing"), {
    canStartReview: false,
    canApprove: true,
    canReject: true,
  });
  for (const terminal of ["approved", "rejected", "withdrawn"]) {
    assert.deepEqual(adminApplicationAllowedActions(terminal), {
      canStartReview: false,
      canApprove: false,
      canReject: false,
    });
  }
});

test("开始审核只改状态：不建护航、不发资格、不写审核时间", async () => {
  const before = await getCompanionRepository().listCompanionsForAdmin();
  const result = await startReviewAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  assert.equal(result.status, "reviewing");
  assert.equal(result.statusLabel, COMPANION_APPLICATION_STATUS_LABELS.reviewing);
  assert.equal(result.changed, true);
  // 开始审核不是「结果」，因此没有审核时间；也没有护航 id 可以给
  assert.equal(result.reviewedAt, null);
  assert.equal(result.companionId, undefined);

  const application = await getCompanionApplicationRepository().findApplicationById(
    PENDING_APPLICATION,
  );
  assert.equal(application.status, "reviewing");
  assert.equal(application.reviewedAt, null);

  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    before.length,
    "开始审核不该产生护航资料",
  );
  assert.deepEqual(await getQualificationRepository().listQualifications(), []);
});

test("非法迁移被拒，且什么都没留下：状态、护航、资格、审计都不变", async () => {
  const auditBefore = await getAdminAuditRepository().countAudits();

  // 已通过的申请不能再通过，也不能被拒绝
  for (const call of [
    () => approveAdminApplication(APPROVED_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    () => rejectAdminApplication(APPROVED_APPLICATION, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      reviewNote: "试试看",
    }),
    () => startReviewAdminApplication(APPROVED_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() }),
  ]) {
    await assert.rejects(call(), (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      // 提示里带上当前状态：「当前状态是『已通过』，不能执行这个操作」
      assert.ok(error.message.includes(COMPANION_APPLICATION_STATUS_LABELS.approved));
      return true;
    });
  }

  // 已撤销（用户自己撤的）同样是终态
  await expectApiError(
    approveAdminApplication(WITHDRAWN_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
  );

  // 不存在的申请是 404，与「状态不对」区分开
  await expectApiError(
    approveAdminApplication("ca-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    "入驻申请不存在",
  );

  const application = await getCompanionApplicationRepository().findApplicationById(
    APPROVED_APPLICATION,
  );
  assert.equal(application.status, "approved");
  assert.deepEqual(await getQualificationRepository().listQualifications(), []);
  assert.equal(await getAdminAuditRepository().countAudits(), auditBefore, "失败的操作不该写审计");
});

test("拒绝必须有审核意见：空、纯空格、超长都被拒", async () => {
  for (const raw of ["", "   ", "\n\t"]) {
    await expectApiError(
      rejectAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        reviewNote: raw,
      }),
      "BAD_REQUEST",
      ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
    );
  }

  // 长度规则由 `normalizeAdminReviewNote()` 唯一定义；界面没有 maxLength，
  // 因此超长必须在这里被明确拒绝，而不是被静默截断
  const tooLong = "截".repeat(ADMIN_REVIEW_NOTE_MAX_LENGTH + 1);
  await expectApiError(
    rejectAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      reviewNote: tooLong,
    }),
    "BAD_REQUEST",
    ADMIN_REVIEW_NOTE_TOO_LONG_MESSAGE,
  );
  assert.deepEqual(normalizeAdminReviewNote("  "), {
    ok: false,
    message: ADMIN_REVIEW_NOTE_EMPTY_MESSAGE,
  });

  // 失败的拒绝什么也没留下
  assert.equal(
    (await getCompanionApplicationRepository().findApplicationById(PENDING_APPLICATION)).status,
    "pending",
  );
});

test("拒绝不产生护航、也不发资格，只写审核意见与一条审计", async () => {
  const note = "这次提交的截图与当前段位对不上，等资料齐全后再看。";
  const result = await rejectAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    reviewNote: note,
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reviewedAt !== null, true, "出结果的状态必须有审核时间");
  assert.equal(result.companionId, undefined, "拒绝不该给出护航 id");

  // 拒绝这条路径不产生任何护航数据：名单没多、资格一条没有
  assert.deepEqual(await getQualificationRepository().listQualifications(), []);
  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    companionSeed.length,
    "拒绝不该改动护航名单",
  );
  assert.equal(await getCompanionRepository().findCompanionByUser("u-1002"), null);

  const application = await getCompanionApplicationRepository().findApplicationById(
    PENDING_APPLICATION,
  );
  assert.equal(application.reviewNote, note, "审核意见要真的写进记录");

  const audits = await getAdminAuditRepository().listAudits({ targetId: PENDING_APPLICATION });
  assert.equal(audits.length, 1, "一次拒绝只写一条审计");
  assert.equal(audits[0].action, "application.reject");
  assert.equal(audits[0].before.status, "pending");
  assert.equal(audits[0].after.status, "rejected");
});

test("伪造审核人、状态与时间都无效：这三个值一律由服务端给", async () => {
  const result = await approveAdminApplication(REVIEWING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    // 下面这些字段在入参里没有位置——服务层只读幂等键
    adminId: "admin-999",
    actorId: "admin-999",
    actorRole: "customer_service",
    actorName: "伪造的操作者",
    reviewerId: "admin-999",
    status: "rejected",
    reviewedAt: "1999-01-01T00:00:00.000Z",
    companionId: "cp-1",
    role: "admin",
    sortOrder: 999999,
  });

  const application = await getCompanionApplicationRepository().findApplicationById(
    REVIEWING_APPLICATION,
  );
  // 状态由状态机决定，不由请求体决定
  assert.equal(application.status, "approved");
  assert.equal(result.status, "approved");

  // 审核时间是服务端时间，不是请求体里那个 1999 年
  assert.notEqual(application.reviewedAt, "1999-01-01T00:00:00.000Z");
  assert.ok(Date.parse(application.reviewedAt) > Date.parse("2020-01-01T00:00:00.000Z"));

  // 审核人是会话里的管理员，不是请求体里的
  const audit = await getAdminAuditRepository().findAuditByOperationId(result?.operationId ?? "");
  assert.equal(audit, null, "接口结果里不该出现 operationId（审计只存在于服务端仓储）");
  const [entry] = await getAdminAuditRepository().listAudits({
    action: "application.approve",
    targetId: REVIEWING_APPLICATION,
  });
  assert.equal(entry.actorId, ADMIN_ID, "审核人必须来自会话");

  // 新建的护航用的是自己的 id，不是请求体里塞的 cp-1
  assert.notEqual(result.companionId, "cp-1");
  assert.equal((await getCompanionRepository().findCompanionById("cp-1")).userId, null);
});

// ——————————————————————————— §七 审核通过的语义 ———————————————————————————

test("通过 = 四件事同时成立：改状态、发资格、建护航、写审计", async () => {
  const application = await getCompanionApplicationRepository().findApplicationById(
    PENDING_APPLICATION,
  );
  const result = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  // ① 状态
  const approved = await getCompanionApplicationRepository().findApplicationById(
    PENDING_APPLICATION,
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.reviewedAt, result.reviewedAt);

  // ② 资格：一条**附加**记录，用户本身没有被改写
  const qualification = await getQualificationRepository().findQualification(application.userId, "companion");
  assert.ok(qualification, "通过后必须有护航资格");
  assert.equal(qualification.userId, application.userId);
  assert.equal(qualification.applicationId, PENDING_APPLICATION);
  assert.equal(qualification.companionId, result.companionId);
  assert.equal(qualification.grantedByAdminId, ADMIN_ID);
  // 资格发放时间与审核时间是同一个瞬间：同一次写入里取的一个 now
  assert.equal(qualification.grantedAt, approved.reviewedAt);

  // ③ 护航：字段来自申请，统计从零开始
  const companion = await getCompanionRepository().findCompanionById(result.companionId);
  assert.ok(companion, "通过后必须建出护航资料");
  assert.equal(companion.userId, application.userId);
  assert.equal(companion.applicationId, application.id);
  assert.equal(companion.displayName, application.displayName);
  assert.equal(companion.intro, application.introduction);
  assert.deepEqual(companion.gameIds, application.gameIds);
  assert.deepEqual(companion.regions, application.regions);
  assert.deepEqual(companion.serviceTags, application.serviceTags);

  assert.equal(companion.enabled, true);
  assert.equal(companion.available, false);
  assert.equal(companion.unavailableReason, NEW_COMPANION_UNAVAILABLE_REASON);
  assert.equal(companion.removedAt, null);
  assert.equal(companion.rating, null, "新护航没有评分：null 与 0 分是两件事");
  assert.equal(companion.completedOrderCount, 0);
  assert.equal(companion.reviewCount, 0);
  assert.equal(companion.tipsCount, 0);
  assert.deepEqual(companion.reviews, []);
  assert.equal(companion.avatarUrl, COMPANION_AVATAR_OPTIONS[0]);

  // 新 id 不能与预置记录撞车
  assert.ok(companion.id.startsWith("cp_"), `新护航 id 应当与预置的 cp-N 分开：${companion.id}`);
  assert.equal(
    companionSeed.some((seed) => seed.id === companion.id),
    false,
  );
  assert.equal(
    companionSeed.some((seed) => seed.sortOrder === companion.sortOrder),
    false,
    "展示排序要与预置记录错开，否则列表顺序不确定",
  );

  // ④ 审计：一条，且指向这份申请
  const audits = await getAdminAuditRepository().listAudits({ targetId: PENDING_APPLICATION });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "application.approve");
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].targetType, "companionApplication");
  assert.equal(audits[0].before.status, "pending");
  assert.equal(audits[0].after.status, "approved");
});

test("通过不覆盖老板身份：用户记录一个字都不变，消费功能照常", async () => {
  const userId = companionApplicationSeed.find((item) => item.id === PENDING_APPLICATION).userId;
  const before = await getDataSource().findUserById(userId);
  const rankingBefore = await getConsumptionRanking(null, new URLSearchParams(), "server");

  await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const after = await getDataSource().findUserById(userId);
  assert.deepEqual(after, before, "通过审核不该改写用户记录（多角色靠附加的资格记录）");
  // 用户记录里没有角色字段：这条保证在类型上就成立，这里再确认一次数据本身
  assert.equal(Object.keys(after).some((key) => /role/i.test(key)), false);

  // 周期排行榜的口径是**消费**，与平台侧资格无关：新身份不该让谁上榜
  const rankingAfter = await getConsumptionRanking(null, new URLSearchParams(), "server");
  assert.deepEqual(
    rankingAfter.items.map((item) => item.userId),
    rankingBefore.items.map((item) => item.userId),
  );
  assert.equal(rankingAfter.total, rankingBefore.total);
});

test("一位用户最多一条有效护航：已经有资料时通过只是「关联」，不再新建", async () => {
  const userId = "u-1002";

  // 造出「这位用户已经有一条有效护航资料」的局面：这道防线不能靠「一位用户只能提交一份申请」
  // 那条规则顺带实现——真实上线后，平台侧可能先有资料、后有申请。
  // 这里直接用写入器（伪事务内部用的就是这两个函数），再走一遍完整的审核通过。
  const existingCompanion = {
    ...companionSeed[0],
    id: "cp_already_linked",
    userId,
    applicationId: null,
    displayName: "平台早期资料（占位）",
  };
  createCompanionRecord(existingCompanion);
  grantQualificationRecord({
    userId,
    role: "companion",
    companionId: existingCompanion.id,
    applicationId: "ca-old",
    grantedAt: "2026-01-01T00:00:00.000Z",
    grantedByAdminId: "admin-0",
  });

  const result = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  // 关联到已有资料，而不是新建第二条
  assert.equal(result.companionId, existingCompanion.id);
  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    companionSeed.length + 1,
    "名单只该多出那一条人工造出来的资料",
  );

  const linked = await getCompanionRepository().findCompanionByUser(userId);
  assert.equal(linked.id, existingCompanion.id);
  // 复用不是覆盖：旧资料原样保留，昵称没有被新申请改写
  assert.equal(linked.displayName, "平台早期资料（占位）");

  // 资格也不重复发放：「谁在什么时候批的」仍然指向第一次
  const qualifications = await getQualificationRepository().listQualificationsByUser(userId);
  assert.equal(qualifications.length, 1);
  assert.equal(qualifications[0].applicationId, "ca-old");
  assert.equal(qualifications[0].grantedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(qualifications[0].grantedByAdminId, "admin-0");

  // 索引是唯一的落点：同一位用户再创建第二次会被挡住，而不是靠昵称去猜
  const again = createCompanionRecord({ ...existingCompanion, id: "cp_second_attempt" });
  assert.equal(again.kind, "already-linked");
  assert.equal(again.companion.id, existingCompanion.id);
  assert.equal(await getCompanionRepository().findCompanionById("cp_second_attempt"), null);
});

test("不用昵称关联：两位申请人同名，各自建出各自的护航", async () => {
  const first = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  await getCompanionApplicationRepository().createApplication(
    {
      ...companionApplicationSeed[1],
      id: "ca-p8a-same-name",
      applicationNo: "RA-P8A-0002",
      userId: "u-9001",
      status: "pending",
      displayName: "老板B（占位）", // 与上一份申请同名
    },
    uniqueKey(),
  );

  const second = await approveAdminApplication("ca-p8a-same-name", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  assert.notEqual(second.companionId, first.companionId, "同名不该被当成同一个人");
  assert.equal((await getCompanionRepository().findCompanionById(second.companionId)).userId, "u-9001");
});

test("重复通过：同一个幂等键第二次到达是重放，三样数据都只有一份", async () => {
  const key = uniqueKey();
  const first = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: key });
  const second = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: key });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false, "第二次不该再写一次数据");
  assert.equal(second.companionId, first.companionId, "重放要能找回当时那条护航资料");

  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    companionSeed.length + 1,
  );
  assert.equal((await getQualificationRepository().listQualifications()).length, 1);
  assert.equal((await getAdminAuditRepository().listAudits({ targetId: PENDING_APPLICATION })).length, 1);
  assert.equal(await getAdminAuditRepository().countAudits(), 1, "重复请求不该产生第二条审计");
});

test("并发通过：同键两个请求都成功且只写一份；不同键则第二个被状态机挡住", async () => {
  // ① 同一个幂等键并发到达（网络重试的真实样子）
  const shared = uniqueKey();
  const settled = await Promise.allSettled([
    approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: shared }),
    approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: shared }),
  ]);
  assert.deepEqual(settled.map((item) => item.status), ["fulfilled", "fulfilled"]);
  assert.equal(
    settled.filter((item) => item.value.changed).length,
    1,
    "两次里只有一次真的改了数据",
  );
  assert.equal(settled[0].value.companionId, settled[1].value.companionId);

  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    companionSeed.length + 1,
  );
  assert.equal((await getQualificationRepository().listQualifications()).length, 1);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  // ② 两个不同的幂等键并发到达（两位管理员同时点了「通过」）
  resetMockStore("companionApplication");
  resetMockStore("companion");
  resetMockStore("qualification");
  resetMockStore("adminAudit");

  const raced = await Promise.allSettled([
    approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    approveAdminApplication(PENDING_APPLICATION, "admin-9", { idempotencyKey: uniqueKey() }),
  ]);
  assert.deepEqual(raced.map((item) => item.status), ["fulfilled", "rejected"]);
  assert.equal(raced[1].reason.code, "BAD_REQUEST", "后到的那次应当被状态机挡住");

  assert.equal(
    (await getCompanionRepository().listCompanionsForAdmin()).length,
    companionSeed.length + 1,
  );
  assert.equal((await getQualificationRepository().listQualifications()).length, 1);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

test("幂等键缺失或复用到别的对象：一个 400，一个明确的「键已被使用」", async () => {
  await expectApiError(
    approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, {}),
    "BAD_REQUEST",
    ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );
  await expectApiError(
    approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: "短" }),
    "BAD_REQUEST",
    ADMIN_COMPANION_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );

  const key = uniqueKey();
  await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: key });
  // 同一个键换个对象：安静重放会返回另一个对象的操作结果，比报错危险得多
  await expectApiError(
    startReviewAdminApplication(REVIEWING_APPLICATION, ADMIN_ID, { idempotencyKey: key }),
    "BAD_REQUEST",
    ADMIN_COMPANION_OPERATION_CONFLICT_MESSAGE,
  );
});

// ——————————————————————————— §六 DTO 边界 ———————————————————————————

test("申请列表 DTO 不带正文、联系方式、凭证与审核意见", async () => {
  const data = await adminApplications({ status: "all" });
  assert.ok(data.items.length >= companionApplicationSeed.length);
  assert.deepEqual(
    Object.keys(data.items[0]).sort(),
    [
      "applicationNo",
      "displayName",
      "games",
      "id",
      "regions",
      "reviewedAt",
      "serviceTags",
      "status",
      "statusLabel",
      "submittedAt",
      "updatedAt",
    ],
    "列表项的字段就是这些：正文与凭证只在详情里",
  );

  for (const item of data.items) {
    for (const forbidden of [
      "experience",
      "introduction",
      "contactNote",
      "evidence",
      "reviewNote",
      "applicant",
      "timeline",
      "allowedActions",
      "userId",
    ]) {
      assert.equal(forbidden in item, false, `列表项不该带 ${forbidden}`);
    }
  }

  // 详情在列表项之上补齐正文、凭证、申请人摘要、时间轴与**服务端判定好的动作**
  const pending = await getAdminApplicationDetail(PENDING_APPLICATION, undefined, "server");
  assert.ok(pending.contactNote.length > 0, "这份申请填了联系说明");
  assert.ok(pending.evidence.length > 0, "这份申请带了凭证");
  assert.equal(pending.applicant.userId, "u-1002");
  assert.equal(pending.applicant.linkedCompanionId, null, "还没通过时没有关联护航");
  assert.equal(pending.applicant.hasCompanionQualification, false);
  assert.deepEqual(pending.allowedActions, adminApplicationAllowedActions("pending"));
  assert.ok(pending.timeline.length > 0);

  const rejected = await getAdminApplicationDetail(REJECTED_APPLICATION, undefined, "server");
  assert.ok(rejected.reviewNote.length > 0, "未通过的申请有审核意见");
  assert.deepEqual(rejected.allowedActions, adminApplicationAllowedActions("rejected"));
  assert.equal(rejected.applicant.userId, "u-1005");
});

test("管理端护航列表包含停用与已移除的记录，用户端列表两样都不出现", async () => {
  const admin = await adminCompanions({ removal: "active" });
  assert.equal(admin.total, companionSeed.length, "后台看的是同一份名单的完整版");

  const publicList = await publicCompanions();
  const publicIds = new Set(publicList.items.map((item) => item.id));
  assert.equal(publicIds.has("cp-7"), false, "已停用的记录不该出现在用户端列表");

  const disabled = await adminCompanions({ state: "disabled" });
  assert.deepEqual(disabled.items.map((item) => item.id), ["cp-7"]);

  const unavailable = await adminCompanions({ state: "unavailable" });
  assert.deepEqual(
    unavailable.items.map((item) => item.id).sort(),
    ["cp-4", "cp-6"],
    "暂不可接单 = 已启用但不可接单，不含已停用的那条",
  );

  // 统计是只读的展示值，DTO 里带着，但改不动（下面另有用例）
  assert.equal(typeof admin.items[0].rating === "number" || admin.items[0].rating === null, true);
  assert.deepEqual(admin.counts, {
    enabled: companionSeed.filter((item) => item.enabled).length,
    disabled: companionSeed.filter((item) => !item.enabled).length,
    unavailable: companionSeed.filter((item) => item.enabled && !item.available).length,
    total: companionSeed.length,
  });
});

test("搜索、筛选与分页：关键字与游戏都真的改变结果，非法值在接口侧报错", async () => {
  const all = await adminApplications({ status: "all", pageSize: 50 });
  assert.equal(all.total, companionApplicationSeed.length);
  assert.deepEqual(
    all.items.map((item) => item.submittedAt),
    [...all.items.map((item) => item.submittedAt)].sort().reverse(),
    "默认排序是提交时间倒序",
  );

  // 关键字命中申请编号与昵称
  const byNo = await adminApplications({ status: "all", keyword: "RA-MOCK-0005" });
  assert.deepEqual(byNo.items.map((item) => item.id), [REJECTED_APPLICATION]);
  const byName = await adminApplications({ status: "all", keyword: "老板B" });
  assert.ok(byName.items.some((item) => item.id === PENDING_APPLICATION));
  assert.equal(byName.items.some((item) => item.id === REJECTED_APPLICATION), false);

  // 按状态筛选
  const reviewing = await adminApplications({ status: "reviewing" });
  assert.deepEqual(reviewing.items.map((item) => item.id), [REVIEWING_APPLICATION]);

  // 分页：第一页只有指定条数，且与第二页不重叠
  const first = await adminApplications({ status: "all", pageSize: 2, page: 1 });
  const second = await adminApplications({ status: "all", pageSize: 2, page: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(
    first.items.some((item) => second.items.some((other) => other.id === item.id)),
    false,
    "翻页不该重复出现同一条",
  );

  // 接口（strict）对非法枚举报错，页面（宽松）收敛到默认值
  await expectApiError(resolveAdminApplicationListQuery(page({ status: "nope" }), true), "BAD_REQUEST");
  assert.equal((await resolveAdminApplicationListQuery(page({ status: "nope" }), false)).status, "pending");
  await expectApiError(resolveAdminCompanionListQuery(page({ state: "nope" }), true), "BAD_REQUEST");
  await expectApiError(resolveAdminCompanionListQuery(page({ removal: "nope" }), true), "BAD_REQUEST");
  const fallback = await resolveAdminCompanionListQuery(page({ state: "nope", removal: "nope" }), false);
  assert.equal(fallback.state, "all");
  assert.equal(fallback.removal, "active");
});

test("护航详情读得到已停用与已移除的记录：那是「有记录的状态」，不是 404", async () => {
  const disabled = await getAdminCompanionDetail("cp-7", undefined, "server");
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.removedAt, null);
  assert.equal(adminCompanionStatus(disabled).key, "disabled");

  await removeAdminCompanion("cp-9", ADMIN_ID, { idempotencyKey: uniqueKey() });
  const removed = await getAdminCompanionDetail("cp-9", undefined, "server");
  assert.ok(removed, "已移除的记录后台仍然要能打开");
  assert.equal(removed.removedAt !== null, true);
  assert.equal(adminCompanionStatus(removed).key, "removed");

  // 真的不存在才是 null（页面据此 404）
  assert.equal(await getAdminCompanionDetail("cp-nope", undefined, "server"), null);
});

// ——————————————————————————— §八 护航管理 ———————————————————————————

/** 一份合法的编辑入参，字段全部取自 cp-1 的当前值。 */
function profilePatch(overrides = {}) {
  return {
    displayName: "阿泽（占位）",
    avatarUrl: COMPANION_AVATAR_OPTIONS[0],
    intro: "三角洲行动机密单常驻，主打稳扎稳打。",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["护航"],
    enabled: true,
    available: true,
    unavailableReason: "",
    sortOrder: 10,
    ...overrides,
  };
}

test("编辑立刻反映到前台：后台、用户端列表、详情页、结算页读的是同一份数据", async () => {
  await updateAdminCompanion("cp-1", ADMIN_ID, {
    ...profilePatch({ displayName: "改过的名字（占位）" }),
    idempotencyKey: uniqueKey(),
  });

  const fromAdmin = await getAdminCompanionDetail("cp-1", undefined, "server");
  assert.equal(fromAdmin.displayName, "改过的名字（占位）");

  const fromPublicList = await publicCompanions({ keyword: "改过的名字" });
  assert.deepEqual(fromPublicList.items.map((item) => item.id), ["cp-1"]);

  const fromDetail = await getCompanionDetail("cp-1", undefined, "server");
  assert.equal(fromDetail.displayName, "改过的名字（占位）");

  const fromCheckout = (await getCompanions()).find((item) => item.id === "cp-1");
  assert.equal(fromCheckout.displayName, "改过的名字（占位）");

  // 结算页真的能用这条记录下单（可接单时）：试算通过，且正式下单把它写进快照
  await previewCheckout(checkoutSelection("cp-1"), undefined, "server");
  const { request } = await createPaymentRequest(
    { ...checkoutSelection("cp-1"), idempotencyKey: uniqueKey() },
    "u-1001",
  );
  assert.equal(request.companionId, "cp-1");
  // 快照里存的是**下单当时**的昵称：后台再改名不会改写已经存在的支付请求
  assert.equal(request.snapshot.companion.name, "改过的名字（占位）");
});

test("编辑白名单之外的字段怎么传都无效：统计、关联用户、评分只读", async () => {
  const before = await getCompanionRepository().findCompanionById("cp-1");

  await updateAdminCompanion("cp-1", ADMIN_ID, {
    ...profilePatch({ displayName: "白名单测试（占位）" }),
    idempotencyKey: uniqueKey(),
    // 下面这些字段在入参类型里就没有位置
    rating: 5,
    completedOrderCount: 99999,
    reviewCount: 88888,
    tipsCount: 77777,
    userId: "u-1001",
    linkedUserId: "u-1001",
    applicationId: "ca-1002",
    removedAt: "2020-01-01T00:00:00.000Z",
    id: "cp-hacked",
    reviews: [],
  });

  const after = await getCompanionRepository().findCompanionById("cp-1");
  assert.equal(after.displayName, "白名单测试（占位）", "白名单内的字段要生效");
  assert.equal(after.rating, before.rating);
  assert.equal(after.completedOrderCount, before.completedOrderCount);
  assert.equal(after.reviewCount, before.reviewCount);
  assert.equal(after.tipsCount, before.tipsCount);
  assert.equal(after.userId, before.userId);
  assert.equal(after.applicationId, before.applicationId);
  assert.equal(after.removedAt, before.removedAt);
  assert.equal(after.id, "cp-1");
  assert.deepEqual(after.reviews, before.reviews);
});

test("游戏与大区必须匹配：不属于所选游戏的大区被拒", async () => {
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...profilePatch({ regions: ["美服"] }),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
  );

  // 大区必须是真实存在的取值，不是「随便写一个不是空的」
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...profilePatch({ gameIds: ["g-nope"] }),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
  );
});

test("停用强制不可接单；不可接单必须有原因；超长原因不被静默截断", async () => {
  // enabled=false 时 available 会被强制归零，原因保留
  const disabled = await updateAdminCompanion("cp-1", ADMIN_ID, {
    ...profilePatch({ enabled: false, available: true, unavailableReason: "资料待完善" }),
    idempotencyKey: uniqueKey(),
  });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.available, false, "下架的记录不可能正在接单");

  // 恢复启用但不可接单：必须给出原因
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...profilePatch({ enabled: true, available: false, unavailableReason: "   " }),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
    COMPANION_PROFILE_REASON_REQUIRED_MESSAGE,
  );

  const tooLong = "忙".repeat(COMPANION_PROFILE_REASON_MAX_LENGTH + 1);
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...profilePatch({ enabled: true, available: false, unavailableReason: tooLong }),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
    COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE,
  );

  // 与界面共用同一个函数：界面不会替人截断，因此服务端必须能说出「超了几个字」
  assert.equal(normalizeCompanionReason(tooLong).message, COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE);
  assert.deepEqual(normalizeCompanionReason("  休息中  "), { ok: true, value: "休息中" });
});

test("展示排序只能是范围内的整数：空、非数字、越界都被拒，不会静默变成 0", async () => {
  for (const sortOrder of [Number.NaN, 3.5, -1, 100000]) {
    await expectApiError(
      updateAdminCompanion("cp-1", ADMIN_ID, {
        ...profilePatch({ sortOrder }),
        idempotencyKey: uniqueKey(),
      }),
      "BAD_REQUEST",
      COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE,
    );
  }

  // 少传这个字段同样按错误处理：它不是「可有可无」，少了就说不出排第几
  const { sortOrder, ...withoutSortOrder } = profilePatch();
  assert.equal(sortOrder, 10);
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...withoutSortOrder,
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
    COMPANION_PROFILE_SORT_ORDER_INVALID_MESSAGE,
  );
});

test("暂停接单：仍在名单与详情里，但结算时不可选", async () => {
  const reason = "本周档期已满，下周一恢复。";
  const result = await setAdminCompanionFlags("cp-1", "pause", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    unavailableReason: reason,
  });
  assert.equal(result.changed, true);
  assert.equal(result.enabled, true, "暂停不是下架：它还在名单里");
  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, reason);

  // 用户端列表与直链详情照常（这就是「暂停」与「停用」的区别）
  const list = await publicCompanions();
  assert.equal(list.items.some((item) => item.id === "cp-1"), true);
  const detail = await getCompanionDetail("cp-1", undefined, "server");
  assert.equal(detail.listed, true);
  assert.equal(detail.selectable, false);
  assert.equal(detail.available, false);

  // 结算页拒绝：详情页能打开不等于可以下单
  await expectApiError(
    previewCheckout(checkoutSelection("cp-1"), undefined, "server"),
    "BAD_REQUEST",
    "该陪玩当前不可选，请重新选择",
  );

  // 恢复接单后原因要清空：能接单了就不该再留着「休息中」
  const resumed = await setAdminCompanionFlags("cp-1", "resume", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(resumed.available, true);
  assert.equal(resumed.unavailableReason, "");
  assert.equal((await getCompanionDetail("cp-1", undefined, "server")).selectable, true);
});

test("停用：从用户端列表与结算页消失，直链详情是只读的「不提供服务」", async () => {
  const result = await setAdminCompanionFlags("cp-1", "disable", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.enabled, false);
  assert.equal(result.available, false, "停用同时强制不可接单");

  const list = await publicCompanions();
  assert.equal(list.items.some((item) => item.id === "cp-1"), false, "停用的不该出现在公开名单");

  // 直链仍然打开，但标记为不在名单里（页面据此渲染只读说明与「暂不可提供服务」）
  const detail = await getCompanionDetail("cp-1", undefined, "server");
  assert.ok(detail, "停用的陪玩直链不该 404");
  assert.equal(detail.listed, false);
  assert.equal(detail.selectable, false);

  await expectApiError(
    previewCheckout(checkoutSelection("cp-1"), undefined, "server"),
    "BAD_REQUEST",
    "该陪玩当前不可选，请重新选择",
  );

  // 后台筛选「已停用」能把它找回来
  const disabled = await adminCompanions({ state: "disabled" });
  assert.equal(disabled.items.some((item) => item.id === "cp-1"), true);

  // 已停用的记录谈不上「暂停 / 恢复接单」
  await expectApiError(
    setAdminCompanionFlags("cp-1", "pause", ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      unavailableReason: "随便写",
    }),
    "BAD_REQUEST",
    ADMIN_COMPANION_DISABLED_MESSAGE,
  );

  // 启用只是回到名单，不自动变成可接单
  const enabled = await setAdminCompanionFlags("cp-1", "enable", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.available, false, "回到名单不等于马上能接单");
  const after = await adminCompanions({ state: "unavailable" });
  assert.equal(after.items.some((item) => item.id === "cp-1"), true);
});

test("移除是软删除：不物理删除、用户端不可见、后台仍可筛出、历史都还在", async () => {
  const before = await getCompanionRepository().findCompanionById("cp-1");

  const result = await removeAdminCompanion("cp-1", ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(result.changed, true);
  assert.equal(result.removedAt !== null, true);

  // 记录还在，字段一个不少（历史订单、评价、鸡腿都指着它）
  const after = await getCompanionRepository().findCompanionById("cp-1");
  assert.ok(after, "移除不是删除记录");
  assert.equal(after.displayName, before.displayName);
  assert.equal(after.completedOrderCount, before.completedOrderCount);
  assert.deepEqual(after.reviews, before.reviews);

  // 用户端两处都不可见，直链详情仍在（只读）
  const list = await publicCompanions();
  assert.equal(list.items.some((item) => item.id === "cp-1"), false);
  await expectApiError(
    previewCheckout(checkoutSelection("cp-1"), undefined, "server"),
    "BAD_REQUEST",
    "该陪玩当前不可选，请重新选择",
  );
  assert.equal((await getCompanionDetail("cp-1", undefined, "server")).listed, false);

  // 后台默认看不到，但筛「已移除」能看到
  const active = await adminCompanions({ removal: "active" });
  assert.equal(active.items.some((item) => item.id === "cp-1"), false);
  const removed = await adminCompanions({ removal: "removed" });
  assert.deepEqual(removed.items.map((item) => item.id), ["cp-1"]);

  // 已移除是终态：不能再编辑、不能再停用、重复移除不刷新时间
  await expectApiError(
    updateAdminCompanion("cp-1", ADMIN_ID, {
      ...profilePatch(),
      idempotencyKey: uniqueKey(),
    }),
    "BAD_REQUEST",
    ADMIN_COMPANION_REMOVED_MESSAGE,
  );
  await expectApiError(
    setAdminCompanionFlags("cp-1", "disable", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    ADMIN_COMPANION_REMOVED_MESSAGE,
  );
  const again = await removeAdminCompanion("cp-1", ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(again.changed, false, "重复移除不该刷新移除时间");
  assert.equal(again.removedAt, after.removedAt);

  // 不存在的对象是另一种错误
  await expectApiError(
    removeAdminCompanion("cp-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_COMPANION_NOT_FOUND_MESSAGE,
  );
});

test("新通过的护航立刻出现在后台列表，并能被筛选到", async () => {
  const result = await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  const list = await adminCompanions({ removal: "active", pageSize: 50 });
  const created = list.items.find((item) => item.id === result.companionId);
  assert.ok(created, "新护航必须立刻出现在后台列表里");
  assert.equal(created.enabled, true);
  assert.equal(created.available, false);
  assert.equal(created.unavailableReason, NEW_COMPANION_UNAVAILABLE_REASON);
  assert.equal(created.rating, null);
  assert.equal(created.linkedUserId, companionApplicationSeed.find((item) => item.id === PENDING_APPLICATION).userId);
  assert.equal(adminCompanionStatus(created).key, "unavailable");

  // 公开列表按「可接单」筛不到它（available=false），但按关键字能查到它
  const available = await publicCompanions({ availability: "available" });
  assert.equal(available.items.some((item) => item.id === result.companionId), false);
  const byKeyword = await publicCompanions({ keyword: created.displayName });
  assert.equal(byKeyword.items.some((item) => item.id === result.companionId), true);

  // 后台把它改成可接单后，结算页立刻能选
  await setAdminCompanionFlags(result.companionId, "resume", ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  const { request } = await createPaymentRequest(
    { ...checkoutSelection(result.companionId), idempotencyKey: uniqueKey() },
    "u-1002",
  );
  assert.equal(request.companionId, result.companionId);
});

// ——————————————————————————— §十 审计 ———————————————————————————

test("每个写操作恰好一条审计，动作名与对象对得上", async () => {
  const cases = [
    ["application.start-review", PENDING_APPLICATION, () =>
      startReviewAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() })],
    ["application.approve", REVIEWING_APPLICATION, () =>
      approveAdminApplication(REVIEWING_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() })],
    ["application.reject", PENDING_APPLICATION, () =>
      rejectAdminApplication(PENDING_APPLICATION, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        reviewNote: "截图与段位对不上。",
      })],
    ["companion.update", "cp-1", () =>
      updateAdminCompanion("cp-1", ADMIN_ID, {
        ...profilePatch({ intro: "换一段介绍。" }),
        idempotencyKey: uniqueKey(),
      })],
    ["companion.pause", "cp-2", () =>
      setAdminCompanionFlags("cp-2", "pause", ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        unavailableReason: "档期已满",
      })],
    ["companion.resume", "cp-4", () =>
      setAdminCompanionFlags("cp-4", "resume", ADMIN_ID, { idempotencyKey: uniqueKey() })],
    ["companion.disable", "cp-5", () =>
      setAdminCompanionFlags("cp-5", "disable", ADMIN_ID, { idempotencyKey: uniqueKey() })],
    ["companion.enable", "cp-7", () =>
      setAdminCompanionFlags("cp-7", "enable", ADMIN_ID, { idempotencyKey: uniqueKey() })],
    ["companion.remove", "cp-9", () =>
      removeAdminCompanion("cp-9", ADMIN_ID, { idempotencyKey: uniqueKey() })],
  ];

  for (const [, , run] of cases) await run();

  const audits = await getAdminAuditRepository().listAudits();
  assert.equal(audits.length, cases.length, "九次写操作应当正好九条审计");
  for (const [action, targetId] of cases) {
    const matched = audits.filter((entry) => entry.action === action);
    assert.equal(matched.length, 1, `${action} 应当有且只有一条审计`);
    assert.equal(matched[0].targetId, targetId);
    assert.equal(matched[0].actorId, ADMIN_ID);
    assert.equal(matched[0].targetType, action.startsWith("application.") ? "companionApplication" : "companion");
    assert.equal(matched[0].before !== null, true);
    assert.equal(matched[0].after !== null, true);
    assert.equal(matched[0].operationId.length >= 8, true);
    assert.equal(Number.isNaN(Date.parse(matched[0].createdAt)), false);
  }

  // 「什么都没发生」的写操作不写审计：重复一次同样的停用（换个键）
  const before = audits.length;
  await setAdminCompanionFlags("cp-5", "disable", ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(await getAdminAuditRepository().countAudits(), before);
});

test("审计只记动作不记内容：没有 Cookie、没有凭据、没有凭证文件名", async () => {
  await approveAdminApplication(PENDING_APPLICATION, ADMIN_ID, { idempotencyKey: uniqueKey() });
  await updateAdminCompanion("cp-1", ADMIN_ID, {
    ...profilePatch({ intro: "一段很长的介绍，用来验证审计里存的是裁剪后的文本。" }),
    idempotencyKey: uniqueKey(),
  });

  const audits = await getAdminAuditRepository().listAudits();
  assert.ok(audits.length >= 2);

  for (const entry of audits) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "action",
      "actorId",
      "actorName",
      "actorRole",
      "after",
      "before",
      "createdAt",
      "id",
      "operationId",
      "targetId",
      "targetType",
    ]);

    for (const snapshot of [entry.before, entry.after]) {
      assert.ok(snapshot && typeof snapshot === "object");
      for (const [key, value] of Object.entries(snapshot)) {
        // 只允许标量：一个字段忘了裁剪也不可能把一个对象整个塞进来
        assert.equal(
          value === null || ["string", "number", "boolean"].includes(typeof value),
          true,
          `${key} 的值必须是标量`,
        );
        assert.equal(/cookie|session|token|password|secret|openid|unionid|contact/i.test(key), false, key);
      }
    }

    // 不存 Cookie / 会话标识、不存凭据、不存凭证的文件名与地址。
    // 头像是个例外：它是资料的**公开字段**（白名单里的 Mock 占位图），
    // 与凭据无关，去掉它反而会让「改了头像」这件事没留下痕迹。
    const serialized = JSON.stringify(entry);
    for (const forbidden of [
      "mock_admin_id",
      "mock_user_id",
      "cookie",
      "session",
      "level-screenshot",
      "rank-1.png",
      "evidence-placeholder",
      ".png",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `审计里不该出现 ${forbidden}`);
    }
    // 申请快照里带的是凭证**数量**，不是地址或文件名
    if (entry.targetType === "companionApplication") {
      assert.equal("evidenceCount" in entry.after, true);
      assert.equal("evidence" in entry.after, false);
      assert.equal("contactNote" in entry.after, false);
    }
  }
});

test("审计仓储是只读的：没有 create / update / delete", async () => {
  const repository = getAdminAuditRepository();
  for (const forbidden of ["create", "update", "delete", "remove", "save", "append", "write"]) {
    assert.equal(typeof repository[forbidden], "undefined", `审计仓储不该有 ${forbidden}`);
  }
  assert.deepEqual(
    Object.keys(repository).sort(),
    ["countAudits", "findAuditByOperationId", "listAudits"],
  );
});

// ——————————————————————————— §十二 回归：P4–P7B 不受影响 ———————————————————————————

test("新增角色不改变消费口径：用户名单、订单与排行榜的数据源都没被这次改动动过", async () => {
  // 周期排行榜读的是支付仓储 + 用户仓储；资格与护航名单都不在它的输入里
  const ranking = await getConsumptionRanking(null, new URLSearchParams(), "server");
  assert.ok(ranking.items.length > 0, "预置数据里应当有人上榜，否则这个用例证明不了什么");
  for (const item of ranking.items) {
    assert.equal(Object.keys(item).some((key) => /companion|qualification|role/i.test(key)), false);
  }

  // 用户端陪玩名单仍然只由 `isCompanionListed()` 决定（公开列表与结算共用同一条规则）
  const list = await publicCompanions({ pageSize: 50 });
  assert.equal(list.total, companionSeed.filter(isCompanionListed).length);
  assert.equal(userSeed.length > 0, true);
});

// ——————————————————————————— 真实服务（HTTP） ———————————————————————————

async function requestWithCookie(pathname, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, body: await response.text() };
}

async function mockLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  return { status: response.status, setCookie: response.headers.getSetCookie() };
}

/**
 * 九条管理写接口的地址与入参。
 *
 * ⚠️ 请求体**故意不带幂等键**（不是漏了），这是这套用例的设计：
 *
 * 1. 权限矩阵要证明的是**权限排在业务之前**。被拒身份拿到 401 / 403、
 *    管理者拿到「幂等键缺失」的 400——这件事本身就说明了 `requireAdmin()`
 *    确实比解析入参先执行。哪个路由要是先把请求体校验了一遍，这里会立刻变红。
 * 2. 这台服务的**内存是整轮 HTTP 用例共享的**。矩阵如果真去「通过一条申请」
 *    或「移除一位护航」，同一轮里读这些记录的用例就会跟着失败——测试互相污染，
 *    报错却指向别处。所以矩阵一个字节都不写。
 *
 * 「写得进去」的端到端验证由下面那条 PATCH 用例承担：它每次从服务端当前值出发，
 * 重复跑同一台服务也不会留下不一致。
 */
function writeCases(applicationId, companionId) {
  const body = JSON.stringify({});
  return [
    ["POST", `/api/admin/companion-applications/${applicationId}/start-review`, body],
    ["POST", `/api/admin/companion-applications/${applicationId}/approve`, body],
    ["POST", `/api/admin/companion-applications/${applicationId}/reject`, body],
    ["PATCH", `/api/admin/companions/${companionId}`, body],
    ["POST", `/api/admin/companions/${companionId}/pause`, body],
    ["POST", `/api/admin/companions/${companionId}/resume`, body],
    ["POST", `/api/admin/companions/${companionId}/enable`, body],
    ["POST", `/api/admin/companions/${companionId}/disable`, body],
    ["POST", `/api/admin/companions/${companionId}/remove`, body],
  ];
}

async function sendWithCookie(method, pathname, body, cookie) {
  const response = await fetch(new URL(pathname, BASE), {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
  return { status: response.status, body: await response.text() };
}

test("权限矩阵：匿名 401，客服 / 护航 / 停用的管理员 403，管理者可读、写穿过权限层", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  const adminCookie = login.status === 200 ? login.setCookie[0].split(";")[0] : null;

  const readPaths = [
    "/api/admin/companion-applications",
    `/api/admin/companion-applications/${PENDING_APPLICATION}`,
    "/api/admin/companions",
    "/api/admin/companions/cp-1",
  ];
  const writes = writeCases(PENDING_APPLICATION, "cp-1");

  // ① 匿名：读与写都必须是 401
  for (const pathname of readPaths) {
    assert.equal((await requestWithCookie(pathname, null)).status, 401, `${pathname} 匿名应当 401`);
  }
  for (const [method, pathname, body] of writes) {
    assert.equal((await sendWithCookie(method, pathname, body, null)).status, 401, `${pathname} 匿名应当 401`);
  }

  // ② 普通用户的 Cookie 换不来管理权限
  for (const cookie of ["mock_user_id=u-1001", "mock_user_id=admin-1"]) {
    assert.equal((await requestWithCookie(readPaths[0], cookie)).status, 401, `${cookie} 不该被当成管理者`);
    assert.equal(
      (await sendWithCookie("POST", writes[0][1], writes[0][2], cookie)).status,
      401,
      `${cookie} 不该能写`,
    );
  }

  if (!adminCookie) {
    // 开关关闭：`getSessionAdmin()` 一律返回 null，因此这三种身份连「有会话但没权限」都不存在，
    // 全部按未登录处理（401）。这是设计如此，不是漏判。
    for (const id of ["admin-2", "admin-3", "admin-4"]) {
      assert.equal((await requestWithCookie(readPaths[0], `mock_admin_id=${id}`)).status, 401);
    }
    return;
  }

  // ③ 有会话但没权限：客服、护航、被停用的管理员
  const forbidden = { "admin-2": "客服", "admin-3": "护航", "admin-4": "已停用的管理员" };
  const messages = new Set();
  for (const [id, label] of Object.entries(forbidden)) {
    for (const pathname of readPaths) {
      const { status, body } = await requestWithCookie(pathname, `mock_admin_id=${id}`);
      assert.equal(status, 403, `${label} 不该读 ${pathname}`);
      assert.ok(body.includes("FORBIDDEN"));
      messages.add(JSON.parse(body).error.message);
    }
    for (const [method, pathname, body] of writes) {
      const result = await sendWithCookie(method, pathname, body, `mock_admin_id=${id}`);
      assert.equal(result.status, 403, `${label} 不该写 ${pathname}`);
      messages.add(JSON.parse(result.body).error.message);
    }
  }
  // 三种被拒身份 + 读与写，错误文本完全一致：不区分「角色不对」与「账号被停用」，
  // 也不区分「对象不存在」与「无权访问」——那等于给出一个可以探测账号状态的接口
  assert.equal(messages.size, 1, `拒绝文案应当只有一句：${[...messages].join(" / ")}`);

  // ④ 管理员：读 200；写则**穿过了权限层**——错在缺幂等键（400），不是被挡在门外。
  //    400 而不是 404 同时证明这些写地址真实存在，不需要另找办法探活。
  for (const pathname of readPaths) {
    assert.equal((await requestWithCookie(pathname, adminCookie)).status, 200, `${pathname} 管理者应当可读`);
  }
  for (const [method, pathname, body] of writes) {
    const result = await sendWithCookie(method, pathname, body, adminCookie);
    assert.equal(result.status, 400, `${pathname} 管理者应当走到业务校验`);
    assert.equal(JSON.parse(result.body).error.code, "BAD_REQUEST");
    assert.equal("data" in JSON.parse(result.body), false);
  }

  // 不存在的对象与无权访问不泄露内部差异：不存在的申请对管理者是 404，
  // 对被拒身份仍然是 403（连「存不存在」都不回答）
  const missing = "/api/admin/companion-applications/ca-nope";
  assert.equal((await requestWithCookie(missing, adminCookie)).status, 404);
  assert.equal((await requestWithCookie(missing, "mock_admin_id=admin-2")).status, 403);
});

test("ENABLE_MOCK_ADMIN=false 时 P8A 接口完全关闭：登录 404，伪造 Cookie 无效", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status === 200) return; // 本次跑的服务开着开关，由「关掉开关再跑一次」覆盖

  assert.equal(login.status, 404);
  assert.equal(login.setCookie.length, 0);

  // 伪造 Cookie 也不产生任何管理身份：读 401，写 401
  for (const pathname of ["/api/admin/companion-applications", "/api/admin/companions"]) {
    assert.equal((await requestWithCookie(pathname, "mock_admin_id=admin-1")).status, 401);
  }
  for (const [method, pathname, body] of writeCases(PENDING_APPLICATION, "cp-1")) {
    assert.equal((await sendWithCookie(method, pathname, body, "mock_admin_id=admin-1")).status, 401);
  }

  // 用户端完全不受影响
  const userLogin = await fetch(new URL("/api/auth/mock-login", BASE), { method: "POST" });
  assert.equal(userLogin.status, 200);
  assert.equal((await requestWithCookie("/api/companions", null)).status, 200);
});

test("管理接口不接受来自用户端的写操作：用户 Cookie 打不动任何一条写路径", { skip: SKIP_HTTP }, async () => {
  for (const [method, pathname, body] of writeCases(PENDING_APPLICATION, "cp-1")) {
    const { status } = await sendWithCookie(method, pathname, body, "mock_user_id=u-1001");
    assert.equal(status, 401, `${pathname} 不该接受用户 Cookie`);
  }
  // 顺带确认这些地址确实存在（否则上面的 401 可能只是「路由不存在」）。
  // 用**读**接口探活：管理接口存在与否与鉴权无关，不必真去写一条记录。
  // 写路径的存在性由权限矩阵里的 400（缺幂等键，而不是 404）证明。
  const login = await mockLogin();
  if (login.status !== 200) return;
  const adminCookie = login.setCookie[0].split(";")[0];
  const detail = await requestWithCookie(
    `/api/admin/companion-applications/${PENDING_APPLICATION}`,
    adminCookie,
  );
  assert.equal(detail.status, 200, "这些管理接口必须真实存在");
});

/**
 * 真写一次，端到端。
 *
 * 挑 `cp-9` 的**服务标签**，理由是它与别的用例没有交集：
 * `http-smoke` 里被读到的是 cp-1（结算是它）、「不可用 / 已下架」那两位、以及列表的
 * DTO 形状与分页稳定性——都不是 cp-9，也不看标签取值。
 *
 * 入参从服务端**当前值**出发再改一项：这样重复跑同一台服务也不会越写越歪，
 * 第二次跑只是 `changed: false`，断言依旧成立。
 */
test("管理者的一次真实写入端到端成立：改标签后，后台详情与用户端详情同时看到", { skip: SKIP_HTTP }, async () => {
  const login = await mockLogin();
  if (login.status !== 200) return;

  const adminCookie = login.setCookie[0].split(";")[0];
  const before = await fetch(new URL("/api/admin/companions/cp-9", BASE), { headers: { cookie: adminCookie } });
  assert.equal(before.status, 200);
  const current = (await before.json()).data;

  const tags = ["陪练", "上分"];
  const patch = {
    idempotencyKey: uniqueKey(),
    displayName: current.displayName,
    avatarUrl: current.avatarUrl,
    intro: current.intro,
    gameIds: current.games.map((game) => game.id),
    regions: current.regions,
    serviceTags: tags,
    enabled: current.enabled,
    available: current.available,
    unavailableReason: current.unavailableReason,
    sortOrder: current.sortOrder,
  };

  const written = await sendWithCookie("PATCH", "/api/admin/companions/cp-9", JSON.stringify(patch), adminCookie);
  assert.equal(written.status, 200, written.body);
  assert.equal(JSON.parse(written.body).data.companionId, "cp-9");

  // 后台详情：读的是同一份数据，因此立刻就是新值
  const after = await fetch(new URL("/api/admin/companions/cp-9", BASE), { headers: { cookie: adminCookie } });
  assert.deepEqual((await after.json()).data.serviceTags, tags);

  // 用户端详情页：同一条记录，直接可见——「改完要等同步」这种说法本站不存在。
  // 「陪练」不在 cp-9 的预置标签里，它在页面上出现只可能是这次写入带过去的；
  // 反过来，若同一台服务被跑过第二遍，这条会因为已经是新值而平凡通过——
  // 与 `http-smoke` 对共享服务的态度一致：断言的是「现在确实是这样」。
  const page = await fetch(new URL("/companions/cp-9", BASE));
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes("陪练"), "用户端详情页没有看到刚写入的标签");
});
