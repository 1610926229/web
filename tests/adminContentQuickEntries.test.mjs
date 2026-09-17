import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { beforeEach } from "node:test";
import { findAppFile } from "./app-path.mjs";
import {
  CONTENT_ICON_INVALID_MESSAGE,
  CONTENT_LABEL_EMPTY_MESSAGE,
  CONTENT_LABEL_MAX_LENGTH,
  CONTENT_LABEL_TOO_LONG_MESSAGE,
  CONTENT_SORT_ORDER_INVALID_MESSAGE,
  countAdminContentStates,
  quickEntryFieldErrors,
  resolveContentRemovalFilter,
} from "../lib/constants/adminContent.ts";
import { selectPublicShortcuts } from "../lib/constants/homeContent.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import {
  createQuickEntry as createQuickEntryTx,
  removeQuickEntry as removeQuickEntryTx,
  setQuickEntryEnabled as setQuickEntryEnabledTx,
  updateQuickEntry as updateQuickEntryTx,
} from "../lib/data/adminContentTransaction.ts";
import { getContentRepository } from "../lib/data/contentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { quickEntrySeed } from "../lib/mocks/fixtures/contentSeed.ts";
import {
  ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE,
  ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE,
  ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE,
  ADMIN_QUICK_ENTRY_REMOVED_MESSAGE,
  createAdminQuickEntry,
  getAdminQuickEntryDetail,
  queryAdminQuickEntryList,
  removeAdminQuickEntry,
  setAdminQuickEntryEnabled,
  updateAdminQuickEntry,
} from "../lib/services/adminQuickEntries.ts";

/**
 * P8E-1：首页快捷入口管理的持续测试（服务层与接口）。
 *
 * 断言的是**真实实现**：`lib/services/adminQuickEntries.ts`、
 * `lib/data/adminContentTransaction.ts` 与真实的 Mock 仓储，不是复制一份逻辑再测一遍复制品。
 * 守的是 §运营内容 与 §API、权限与一致性：
 *
 * 1. **身份不由客户端决定**：`ctx.actorId` 只来自会话，请求体里的 actor 字段没有读取位置；
 * 2. **幂等**：同一个键第二次到达不写数据、不写审计；键用在别的对象上报冲突；
 * 3. **目标地址的两级安全校验**：服务层一次、事务层的原子区段内再一次。
 *    第二级单独用**直接调用事务**的方式验证——这正是它的用途：将来多出一条
 *    绕过服务层的写入路径（批量导入、种子数据）时，它仍然拦得住；
 * 4. **软移除不是删除**：记录还在、后台查得到、用户端看不到，且不能再编辑；
 * 5. **审计恰好一次**：每次真实变更一条，重放与「什么都没改」都不写第二条。
 *
 * ⚠️ 与 `tests/adminCategories.test.mjs` 的差别只有一处：本文件**没有**依赖
 * `APP_BASE_URL` 的 HTTP 用例（因此也不会在任何环境下被跳过）。401 / 403 的
 * 真实状态码矩阵需要一台跑着的服务，那部分归 `tests/admin.test.mjs` 的接口清单与
 * 权限矩阵统一覆盖；这里用**源码级断言**钉住同一件事：五个接口文件的每一个 handler
 * 都是「先 `await requireAdmin()`，再碰请求体与路径参数」。
 */

/** 执行操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置的四个入口（见 `lib/mocks/fixtures/contentSeed.ts`）。 */
const SEEDED = quickEntrySeed;
const SEEDED_SERVICE = "service";
const SEEDED_JOIN = "join";

let keySeq = 0;
/** 每个用例一个全新的幂等键：键与「这次意图」绑定，用例之间不能共用。 */
function uniqueKey() {
  keySeq += 1;
  return `p8e-quick-key-${process.pid}-${keySeq}`;
}

/** `assert.rejects` 的薄包装：把「错误码」与「文案」分开断言，失败时看得清是哪一条。 */
function expectApiError(promise, code, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 一份合法的入口输入，用例按需覆盖其中几项。 */
function entryInput(overrides = {}) {
  return {
    label: "测试入口",
    icon: "service",
    path: "/service",
    sortOrder: 100,
    enabled: true,
    ...overrides,
  };
}

function createEntry(overrides = {}, key = uniqueKey()) {
  return createAdminQuickEntry(ADMIN_ID, { idempotencyKey: key, ...entryInput(overrides) });
}

/** 事务层的写上下文（测试里直接调用事务时用，模拟「绕过服务层的写入路径」）。 */
function txContext(operationId = uniqueKey()) {
  return {
    actorId: ADMIN_ID,
    actorRole: "admin",
    actorName: null,
    operationId,
    at: new Date().toISOString(),
  };
}

function adminList(removal = "active") {
  return queryAdminQuickEntryList(removal, undefined, "server");
}

function auditsFor(targetId) {
  return getAdminAuditRepository().listAudits({ targetType: "quickEntry", targetId });
}

async function auditCount() {
  return getAdminAuditRepository().countAudits();
}

async function records() {
  return getContentRepository().listQuickEntryRecords();
}

async function recordCount() {
  return (await records()).length;
}

beforeEach(() => {
  // 运营内容与审计一起重置：幂等键的账本就在审计仓储里（`findAuditByOperationId`），
  // 只重置内容会让上一个用例用过的键在这个用例里变成「重放」
  resetMockStore("content");
  resetMockStore("adminAudit");
});

// ——————————————————————————— 列表 ———————————————————————————

test("列表：默认只看「使用中」，已移除要显式筛选才看得到", async () => {
  const active = await adminList();
  assert.equal(active.items.length, SEEDED.length);
  assert.equal(active.total, SEEDED.length);
  assert.deepEqual(active.counts, countAdminContentStates(SEEDED));

  // 不分页：响应里没有页码字段，「共 N 条」由 total 回答。
  // 加分页会带来「改完第 2 页的排序，第 1 页没变」这类由分页自己制造的问题
  for (const key of ["page", "pageSize", "hasMore"]) {
    assert.equal(key in active, false, `运营内容列表不分页，不该出现 ${key}`);
  }

  // 预置数据里没有已移除的入口：一上来就摆一条，「已移除」筛选永远看不到空态
  const removed = await adminList("removed");
  assert.deepEqual(removed.items, []);
  assert.equal(
    removed.total,
    SEEDED.length,
    "切换筛选不改变「还有几条在用」——这两个数字回答的是两个问题",
  );

  const created = await createEntry({ label: "稍后移除" });
  await removeAdminQuickEntry(created.id, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const activeAfter = await adminList();
  assert.equal(
    activeAfter.items.some((item) => item.id === created.id),
    false,
    "已移除的入口不能混在「使用中」里，否则看起来就像移除根本没生效",
  );
  assert.equal(activeAfter.total, SEEDED.length);
  assert.deepEqual(activeAfter.counts, {
    all: SEEDED.length + 1,
    enabled: SEEDED.length,
    disabled: 0,
    removed: 1,
  });

  const removedAfter = await adminList("removed");
  assert.deepEqual(
    removedAfter.items.map((item) => item.id),
    [created.id],
  );
  assert.equal(removedAfter.total, SEEDED.length);
});

test("筛选口径：removal 只认 removed，其余（含手改坏的值）都收敛到「使用中」", () => {
  // 接口层用的就是这个纯函数，因此这里的结论对 `?removal=…` 同样成立。
  // 与「页面宽松、接口严格」的其它列表不同，这里**接口也宽松**：运营内容的筛选
  // 只有两个取值，为它造一个 400 换不来任何东西，而地址栏被手改坏是常事
  assert.equal(resolveContentRemovalFilter("removed"), "removed");
  assert.equal(resolveContentRemovalFilter("active"), "active");
  assert.equal(resolveContentRemovalFilter(null), "active");
  assert.equal(resolveContentRemovalFilter("gone"), "active");
});

test("列表不分页：条目按 sortOrder → id 全序返回，角标四个数加起来等于总数", async () => {
  const data = await adminList();
  assert.deepEqual(
    data.items.map((item) => item.id),
    [...SEEDED].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1)).map((r) => r.id),
  );
  assert.equal(
    data.counts.all,
    data.counts.enabled + data.counts.disabled + data.counts.removed,
  );

  // 停用只影响 enabled / disabled 两个角标，不影响「还在不在」
  await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const after = await adminList();
  assert.equal(after.items.length, SEEDED.length, "停用不是移除：它仍然在「使用中」视图里");
  assert.deepEqual(after.counts, {
    all: SEEDED.length,
    enabled: SEEDED.length - 1,
    disabled: 1,
    removed: 0,
  });
});

test("列表 DTO 最小化：没有 removedAt 原文，也没有任何审计字段", async () => {
  const created = await createEntry({ label: "DTO 边界" });
  const item = (await adminList()).items.find((row) => row.id === created.id);

  assert.ok(item, "刚建的入口应当出现在列表里");
  assert.equal(item.removed, false);
  assert.equal("removedAt" in item, false, "后台列表要的是「还在不在」，不是时间戳");
  for (const key of ["actorId", "actorRole", "actorName", "operationId", "action", "before", "after"]) {
    assert.equal(key in item, false, `列表项不该出现审计字段 ${key}`);
  }
  // 详情同样窄
  const detail = await getAdminQuickEntryDetail(created.id, undefined, "server");
  assert.equal("removedAt" in detail, false);
  assert.equal(detail.removed, false);
});

test("详情：不存在的返回 null；已移除的照样返回（软移除不是记录消失）", async () => {
  assert.equal(await getAdminQuickEntryDetail("qe-nope", undefined, "server"), null);

  const created = await createEntry({ label: "移除后仍可查" });
  await removeAdminQuickEntry(created.id, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const detail = await getAdminQuickEntryDetail(created.id, undefined, "server");
  assert.equal(detail.id, created.id);
  assert.equal(detail.removed, true, "后台要能查到「这条被移除过」");
  assert.equal(detail.label, "移除后仍可查");
});

// ——————————————————————————— 新建 ———————————————————————————

test("新建入口：字段落库、时间戳来自服务端、审计 before 为 null", async () => {
  const before = await recordCount();
  const result = await createEntry({ label: "新入口甲", icon: "join", path: "/join", sortOrder: 55 });

  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.removed, false);
  assert.equal(result.label, "新入口甲");
  assert.equal(result.icon, "join");
  assert.equal(result.path, "/join");
  assert.equal(result.sortOrder, 55);
  assert.match(result.id, /^qe_/, "后台新建的 id 与预置数据的短 id 从取值域上分开");

  assert.equal(await recordCount(), before + 1, "仓储里真的多了一条");

  // 时间戳由服务端在原子区段内取：是「刚刚」，而不是任何客户端能指定的值
  const age = Math.abs(Date.now() - Date.parse(result.createdAt));
  assert.ok(age < 60_000, `createdAt 应当是服务端刚才的时间，实际 ${result.createdAt}`);
  assert.equal(result.createdAt, result.updatedAt, "新建时两个时间戳是同一次写入的同一个时刻");

  const audits = await auditsFor(result.id);
  assert.equal(audits.length, 1, "恰好一条审计");
  assert.equal(audits[0].action, "quickEntry.create");
  assert.equal(audits[0].before, null, "新建时还不存在「更新前」，before 就是 null");
  assert.equal(audits[0].after.label, "新入口甲");
  assert.equal(audits[0].after.path, "/join");
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].actorName, null);

  // 快照只允许标量：一个字段忘了裁剪，也不可能把对象整个塞进来
  for (const value of Object.values(audits[0].after)) {
    assert.equal(value === null || ["string", "number", "boolean"].includes(typeof value), true);
  }
});

test("身份不由客户端决定：请求体里的 actor / id / 时间字段一律无效", async () => {
  const result = await createAdminQuickEntry(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...entryInput({ label: "伪造测试" }),
    // 下面这些在服务层**没有读取的位置**，不是「校验后被忽略」
    id: SEEDED_JOIN,
    removedAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    actorId: "admin-999",
    actorRole: "customer_service",
    actorName: "冒充者",
    role: "admin",
    action: "quickEntry.remove",
  });

  assert.notEqual(result.id, SEEDED_JOIN, "id 由服务端在原子区段里生成");
  assert.equal(result.removed, false);
  assert.notEqual(result.createdAt, "2020-01-01T00:00:00.000Z");
  assert.notEqual(result.updatedAt, "2020-01-01T00:00:00.000Z");

  const audits = await auditsFor(result.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, ADMIN_ID, "审计里的操作者只能来自会话");
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].actorName, null, "管理员侧本阶段不记名称快照，编一个出来就是假的「谁」");
  assert.equal(audits[0].action, "quickEntry.create", "动作名由服务端决定，客户端指定不了");

  // 预置的那条入口没有被覆盖
  const untouched = await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server");
  assert.equal(untouched.label, "考核入驻");
  assert.equal(untouched.path, "/join");
});

test("编辑已存在的 id 时，请求体里的 id 也不能把写入改到另一条记录上", async () => {
  // id 来自**路径参数**，请求体里的 id 没有读取位置
  await updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...entryInput({ label: "只改标签", path: "/service" }),
    id: SEEDED_JOIN,
  });

  const service = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");
  const join = await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server");
  assert.equal(service.label, "只改标签");
  assert.equal(join.label, "考核入驻", "请求体里的 id 不该改变写入目标");
});

// ——————————————————————————— 编辑 ———————————————————————————

test("编辑入口：名称 / 图标 / 地址 / 排序都生效，审计 before 与 after 不同", async () => {
  const before = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");

  const result = await updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...entryInput({
      label: "联系客服（改）",
      icon: "benefits",
      path: "/placeholder?title=联系客服",
      sortOrder: 5,
      enabled: true,
    }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);

  const after = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");
  assert.equal(after.label, "联系客服（改）");
  assert.equal(after.icon, "benefits");
  assert.equal(after.path, "/placeholder?title=联系客服");
  assert.equal(after.sortOrder, 5);
  assert.equal(after.createdAt, before.createdAt, "createdAt 不是可编辑字段");
  assert.notEqual(after.updatedAt, before.updatedAt, "改完要留下新的更新时间");

  const audits = await auditsFor(SEEDED_SERVICE);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "quickEntry.update");
  assert.notDeepEqual(audits[0].before, audits[0].after, "审计要能看出改了什么");
  assert.equal(audits[0].before.label, "联系客服");
  assert.equal(audits[0].after.label, "联系客服（改）");
  assert.equal(audits[0].before.path, "/service");
  assert.equal(audits[0].after.path, "/placeholder?title=联系客服");
});

test("编辑时把启用勾去掉：审计记的是 quickEntry.disable（独立用例）", async () => {
  const result = await updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...entryInput({ label: "联系客服", path: "/service", sortOrder: 10, enabled: false }),
  });
  assert.equal(result.changed, true);
  assert.equal(result.enabled, false);

  // 审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」：
  // 停用既可能来自列表开关，也可能来自编辑表单，两者记的是同一件事
  const audits = await auditsFor(SEEDED_SERVICE);
  assert.deepEqual(
    audits.map((entry) => entry.action),
    ["quickEntry.disable"],
  );
  assert.equal(audits[0].before.enabled, true);
  assert.equal(audits[0].after.enabled, false);
});

test("提交内容与现状完全相同：changed 为 false，且不写审计", async () => {
  const current = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");
  const auditsBefore = await auditCount();
  const updatedBefore = current.updatedAt;

  const result = await updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...entryInput({
      label: current.label,
      icon: current.icon,
      path: current.path,
      sortOrder: current.sortOrder,
      enabled: current.enabled,
    }),
  });

  assert.equal(result.changed, false);
  assert.equal(result.replayed, false, "这不是重放，是「一次没有内容的保存」");
  assert.equal(await auditCount(), auditsBefore, "没改任何东西就不该留下一条看不出改了什么的审计");
  assert.equal(
    (await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server")).updatedAt,
    updatedBefore,
    "没有变更就不刷新更新时间",
  );
});

test("编辑的字段错误按「第一条」报，且任何一项都没写进去", async () => {
  const auditsBefore = await auditCount();

  await expectApiError(
    updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...entryInput({ label: "   " }),
    }),
    "BAD_REQUEST",
    CONTENT_LABEL_EMPTY_MESSAGE,
  );
  await expectApiError(
    updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...entryInput({ label: "名".repeat(CONTENT_LABEL_MAX_LENGTH + 1) }),
    }),
    "BAD_REQUEST",
    CONTENT_LABEL_TOO_LONG_MESSAGE,
  );
  await expectApiError(
    updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...entryInput({ icon: "not-an-icon" }),
    }),
    "BAD_REQUEST",
    CONTENT_ICON_INVALID_MESSAGE,
  );
  await expectApiError(
    updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...entryInput({ sortOrder: 1.5 }),
    }),
    "BAD_REQUEST",
    CONTENT_SORT_ORDER_INVALID_MESSAGE,
  );
  // 排序整个没传（缺省 NaN）也要报错，而不是当成 0
  await expectApiError(
    updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      label: "没有排序",
      icon: "service",
      path: "/service",
      enabled: true,
    }),
    "BAD_REQUEST",
    CONTENT_SORT_ORDER_INVALID_MESSAGE,
  );

  assert.equal((await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server")).label, "联系客服");
  assert.equal(await auditCount(), auditsBefore, "被拒的操作不该留下审计");
});

// ——————————————————— 路径安全：服务层（第一级） ———————————————————

/** 服务层会给出的地址错误文案：直接问字段校验，避免把文案抄死在测试里。 */
function expectedPathMessage(path) {
  return quickEntryFieldErrors({
    label: "入口",
    icon: "service",
    path,
    sortOrder: 100,
    enabled: true,
  }).path;
}

test("服务层拦下不安全的地址：脚本协议 / 协议相对 / 站外 / 空串全部被拒", async () => {
  // 这四条覆盖了「复制了整条外链」「少写一个斜杠」「没填」三类真实填错
  for (const path of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "//evil.example",
    "https://evil.example",
    "http://evil.example",
    "",
    "   ",
    "/jo in",
  ]) {
    const message = expectedPathMessage(path);
    assert.ok(message, `${path} 必须有一条字段级错误文案`);

    // 新建与编辑两条路径都要拦得住：编辑时改地址是同一个口子
    await expectApiError(
      createAdminQuickEntry(ADMIN_ID, { idempotencyKey: uniqueKey(), ...entryInput({ path }) }),
      "BAD_REQUEST",
      message,
    );
    await expectApiError(
      updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        ...entryInput({ label: "联系客服", path, sortOrder: 10 }),
      }),
      "BAD_REQUEST",
      message,
    );
  }
});

test("被拒的地址不产生任何副作用：记录数与审计条数都不变", async () => {
  const recordsBefore = await recordCount();
  const auditsBefore = await auditCount();

  for (const path of ["javascript:alert(1)", "//evil.example", "https://evil.example", ""]) {
    await expectApiError(
      createAdminQuickEntry(ADMIN_ID, { idempotencyKey: uniqueKey(), ...entryInput({ path }) }),
      "BAD_REQUEST",
    );
    await expectApiError(
      updateAdminQuickEntry(SEEDED_SERVICE, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
        ...entryInput({ label: "联系客服", path, sortOrder: 10 }),
      }),
      "BAD_REQUEST",
    );
  }

  assert.equal(await recordCount(), recordsBefore, "仓储里不能多出记录");
  assert.equal(await auditCount(), auditsBefore, "审计里不能多出记录");
  // 那条被反复「改坏」的入口原封不动
  const service = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");
  assert.equal(service.path, "/service");
  assert.equal(service.label, "联系客服");
});

// ——————————————————— 路径安全：事务层（第二级） ———————————————————

/**
 * 第二级校验**绕过服务层**直接验证。
 *
 * 这正是它存在的理由：写入侧的校验发生在若干次 `await` 之前（取会话、读请求体），
 * 而事务层的判定在原子区段内、紧邻写入；将来多一条写入路径（批量导入、种子数据、
 * 直接的仓储写入）时，服务层那次根本不会被执行。
 */
test("事务层在写入前再判一次地址：非法地址返回 invalid-path，且什么都不写", async () => {
  const recordsBefore = await recordCount();
  const auditsBefore = await auditCount();

  for (const path of ["javascript:alert(1)", "//evil.example", "https://evil.example", ""]) {
    const created = await createQuickEntryTx({ ...entryInput({ path }) }, txContext());
    assert.deepEqual(created, { kind: "invalid-path" }, `${path} 必须在事务层被拦下`);

    const updated = await updateQuickEntryTx(SEEDED_SERVICE, { ...entryInput({ path }) }, txContext());
    assert.deepEqual(updated, { kind: "invalid-path" });
  }

  assert.equal(
    await recordCount(),
    recordsBefore,
    "非法地址的写入被拒后，仓储里不能多出一条记录",
  );
  assert.equal(await auditCount(), auditsBefore, "非法地址的写入不产生审计");
  assert.equal(
    (await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server")).path,
    "/service",
    "记录里的地址没有被改坏",
  );

  // 启停与移除**不涉及地址**，因此不该被这一条拦住——它们是窄写入，不读也不写 `path`
  assert.equal((await setQuickEntryEnabledTx(SEEDED_SERVICE, false, txContext())).kind, "ok");
  assert.equal((await removeQuickEntryTx(SEEDED_JOIN, txContext())).kind, "ok");
  assert.equal(await recordCount(), recordsBefore, "启停与移除都不增删记录");
  assert.equal(await auditCount(), auditsBefore + 2, "这两次各写了一条审计");
});

test("事务层放行合法地址：第二级不是把所有人都挡在外面", async () => {
  const outcome = await createQuickEntryTx(
    { ...entryInput({ path: "/placeholder?title=点单权益" }) },
    txContext(),
  );

  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.changed, true);
  assert.equal(outcome.value.updated.path, "/placeholder?title=点单权益");
});

test("invalid-path 的接口文案是一条明确的中文提示，而不是「操作失败」", () => {
  assert.equal(typeof ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE, "string");
  assert.ok(ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE.length > 0);
  // 说的是「地址该怎么改」，而不是一句不知道从哪下手的「操作失败」
  assert.equal(ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE.includes("路径"), true);
  assert.notEqual(ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE, "操作失败");

  // 与表单里「目标地址」那一栏的措辞同源：同一个判定的两处出口说同一句话，
  // 运营不必分辨「这次是表单拦的还是服务端拦的」——两次要做的修改是同一件事。
  // 将来若有人改了其中一处措辞，这条断言会提醒他另一处还没改。
  assert.equal(
    ADMIN_QUICK_ENTRY_INVALID_PATH_MESSAGE,
    expectedPathMessage("https://evil.example"),
  );
});

// ——————————————————————————— 停用 / 移除 ———————————————————————————

test("停用入口：用户端四宫格不再有它，但记录与后台列表都还在", async () => {
  const before = selectPublicShortcuts(await records());
  assert.equal(
    before.some((item) => item.id === SEEDED_SERVICE),
    true,
    "先确认停用之前它在用户端出场，否则这个用例证明不了什么",
  );

  await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const after = selectPublicShortcuts(await records());
  assert.equal(
    after.some((item) => item.id === SEEDED_SERVICE),
    false,
    "停用之后用户端读到的就是新值，不需要任何同步动作",
  );

  // 记录还在、后台默认视图里也还在
  const detail = await getAdminQuickEntryDetail(SEEDED_SERVICE, undefined, "server");
  assert.equal(detail.enabled, false);
  assert.equal(detail.removed, false);
  assert.equal(
    (await adminList()).items.some((item) => item.id === SEEDED_SERVICE),
    true,
    "停用不是移除：它仍然是一条使用中的记录",
  );

  // 再停用一次：没有新的变更，也不该再写一条审计
  const again = await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(again.changed, false);

  // 启用回来是可逆的
  await setAdminQuickEntryEnabled(SEEDED_SERVICE, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(
    selectPublicShortcuts(await records()).some((item) => item.id === SEEDED_SERVICE),
    true,
  );
  assert.deepEqual(
    (await auditsFor(SEEDED_SERVICE)).map((entry) => entry.action),
    ["quickEntry.disable", "quickEntry.enable"],
  );
});

test("移除是软移除：记录还在、用户端看不到、后台查得到、不能再编辑或启停", async () => {
  const recordsBefore = await recordCount();
  const result = await removeAdminQuickEntry(SEEDED_JOIN, ADMIN_ID, { idempotencyKey: uniqueKey() });

  assert.equal(result.changed, true);
  assert.equal(result.removed, true);
  assert.equal(await recordCount(), recordsBefore, "软移除不删记录，只写一个时间戳");

  // 记录本身还在，而且写入的是**服务端时间**的移除时间戳（DTO 里只暴露「已移除」这个事实）
  const stored = (await records()).find((record) => record.id === SEEDED_JOIN);
  assert.ok(stored, "记录必须还在：移除是软移除，不是删除");
  assert.notEqual(stored.removedAt, null);
  assert.ok(Math.abs(Date.now() - Date.parse(stored.removedAt)) < 60_000);
  assert.equal(stored.enabled, true, "移除不改变启用状态，它是一条独立的状态迁移");

  // 用户端：四宫格少一个格子
  assert.equal(
    selectPublicShortcuts(await records()).some((item) => item.id === SEEDED_JOIN),
    false,
  );

  // 后台：默认视图看不到，显式筛「已移除」看得到，详情照常打开
  assert.equal((await adminList()).items.some((item) => item.id === SEEDED_JOIN), false);
  assert.deepEqual(
    (await adminList("removed")).items.map((item) => item.id),
    [SEEDED_JOIN],
  );
  assert.equal((await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server")).removed, true);

  // 已移除的不能再编辑 / 启停：它已经不在用户端了，改名称与排序没有去向
  await expectApiError(
    updateAdminQuickEntry(SEEDED_JOIN, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...entryInput({ label: "考核入驻（改）", path: "/join" }),
    }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_REMOVED_MESSAGE,
  );
  await expectApiError(
    setAdminQuickEntryEnabled(SEEDED_JOIN, true, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_REMOVED_MESSAGE,
  );

  // 移除是幂等的：再来一次不刷新时间戳，也不多写一条审计
  const stamp = (await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server")).updatedAt;
  const again = await removeAdminQuickEntry(SEEDED_JOIN, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(again.changed, false);
  assert.equal(again.replayed, false);
  assert.equal(
    (await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server")).updatedAt,
    stamp,
  );

  assert.deepEqual(
    (await auditsFor(SEEDED_JOIN)).map((entry) => entry.action),
    ["quickEntry.remove"],
    "两次重放都没有写审计：这条入口一共就一条——移除它的那条",
  );

  // 被拒的编辑与启停也都没有留下审计
  assert.equal(await auditCount(), 1);
});

test("不存在的入口：详情返回 null（页面转 404），三种写操作 404", async () => {
  assert.equal(await getAdminQuickEntryDetail("qe-nope", undefined, "server"), null);
  assert.equal(await getAdminQuickEntryDetail("", undefined, "server"), null);

  await expectApiError(
    updateAdminQuickEntry("qe-nope", ADMIN_ID, { idempotencyKey: uniqueKey(), ...entryInput() }),
    "NOT_FOUND",
    ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    setAdminQuickEntryEnabled("qe-nope", true, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    removeAdminQuickEntry("qe-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_QUICK_ENTRY_NOT_FOUND_MESSAGE,
  );
});

// ——————————————————————————— 幂等 ———————————————————————————

test("幂等：同一个键重复到达只建一条、只写一条审计，返回的是第一次的结果", async () => {
  const key = uniqueKey();
  const before = await recordCount();

  const first = await createEntry({ label: "幂等测试" }, key);
  // 第二次的请求体故意不一样：重放必须返回**第一次**的结果，而不是按新请求体再建一条
  const second = await createEntry({ label: "幂等测试重放", path: "/complaints" }, key);

  assert.equal(second.id, first.id, "重放返回第一次建出来的那条记录");
  assert.equal(second.changed, false);
  assert.equal(second.replayed, true, "「重放」与「什么都没改」要能分开");
  assert.equal(second.path, "/service", "重放不该按新请求体改写已经建好的记录");

  assert.equal(await recordCount(), before + 1, "记录数不变（只多了第一次那一条）");
  assert.equal(
    (await auditsFor(first.id)).length,
    1,
    "审计条数不变：重放不写第二条",
  );
});

test("幂等：编辑 / 启停 / 移除的重复到达同样不写数据、不写审计", async () => {
  const key = uniqueKey();
  const first = await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, {
    idempotencyKey: key,
  });
  const second = await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, {
    idempotencyKey: key,
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.replayed, true);
  assert.equal((await auditsFor(SEEDED_SERVICE)).length, 1);
});

test("幂等键被别的对象用过：报冲突而不是安静重放", async () => {
  const key = uniqueKey();
  await setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, { idempotencyKey: key });

  // 同一个键去改另一个入口：安静重放会返回另一个对象的结果，比报错危险得多
  await expectApiError(
    setAdminQuickEntryEnabled(SEEDED_JOIN, false, ADMIN_ID, { idempotencyKey: key }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE,
  );
  // 去走另一类写操作（编辑）同样冲突
  await expectApiError(
    updateAdminQuickEntry(SEEDED_JOIN, ADMIN_ID, {
      idempotencyKey: key,
      ...entryInput({ label: "考核入驻（改）", path: "/join" }),
    }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE,
  );
  // 新建用过的键，也不能被编辑复用
  const createKey = uniqueKey();
  const created = await createEntry({ label: "键的所有者" }, createKey);
  await expectApiError(
    setAdminQuickEntryEnabled(SEEDED_JOIN, false, ADMIN_ID, { idempotencyKey: createKey }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_OPERATION_CONFLICT_MESSAGE,
  );

  // 冲突没有产生任何副作用
  const join = await getAdminQuickEntryDetail(SEEDED_JOIN, undefined, "server");
  assert.equal(join.label, "考核入驻");
  assert.equal(join.enabled, true);
  assert.equal((await auditsFor(SEEDED_JOIN)).length, 0);
  assert.equal((await auditsFor(created.id)).length, 1);
});

test("幂等键非法或缺失：400，且任何数据都没被写", async () => {
  const before = await recordCount();

  for (const value of [undefined, "", "short", "有中文的键", "x".repeat(65)]) {
    const body = { ...entryInput({ label: "非法键" }) };
    if (value !== undefined) body.idempotencyKey = value;
    await expectApiError(
      createAdminQuickEntry(ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
    await expectApiError(
      setAdminQuickEntryEnabled(SEEDED_SERVICE, false, ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }

  assert.equal(await recordCount(), before);
  assert.equal(await auditCount(), 0);
  // 幂等键缺失排在字段校验之前：连「地址不合法」都不会被回答
  await expectApiError(
    createAdminQuickEntry(ADMIN_ID, { ...entryInput({ path: "javascript:alert(1)" }) }),
    "BAD_REQUEST",
    ADMIN_QUICK_ENTRY_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );
});

test("并发：同一次意图的两个请求（同一个键）不会建出两条", async () => {
  const key = uniqueKey();
  const before = await recordCount();

  const [a, b] = await Promise.all([
    createEntry({ label: "并发幂等" }, key),
    createEntry({ label: "并发幂等" }, key),
  ]);

  assert.equal(a.id, b.id);
  assert.equal(await recordCount(), before + 1);
  assert.equal((await auditsFor(a.id)).length, 1);
});

// ——————————————————————— 源码级：每个 handler 先鉴权 ———————————————————————

/** 去掉注释后再做「源码里不该出现某标识 / 某语句在最前面」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * 五个接口文件。
 *
 * ⚠️ 这里断言的是**源码结构**，不是运行时行为：`requireAdmin()` 是每个 handler 的
 * 第一条语句，且它之前没有任何对请求体或路径参数的读取。真实状态码（401 / 403）
 * 需要一台跑着的服务，那部分归 `tests/admin.test.mjs` 的权限矩阵。
 */
const ROUTE_FILES = [
  "api/admin/content/quick-entries/route.ts",
  "api/admin/content/quick-entries/[id]/route.ts",
  "api/admin/content/quick-entries/[id]/enable/route.ts",
  "api/admin/content/quick-entries/[id]/disable/route.ts",
  "api/admin/content/quick-entries/[id]/remove/route.ts",
];

test("五个接口的每一个 handler 都是先 requireAdmin()，再碰请求体与路径参数", () => {
  for (const relative of ROUTE_FILES) {
    const code = stripComments(readFileSync(findAppFile(relative), "utf8"));
    const handlers = code.split(/export async function /).slice(1);

    assert.ok(handlers.length > 0, `${relative} 里没有找到任何 handler`);

    for (const handler of handlers) {
      const name = handler.slice(0, handler.indexOf("(")).trim();
      const guardAt = handler.indexOf("await requireAdmin()");

      assert.notEqual(guardAt, -1, `${relative} 的 ${name} 没有调用 requireAdmin()`);

      // 守卫之前不得出现任何「读入参」的动作：权限判断必须排在解析之前，
      // 否则被拒身份也能通过错误文案探出「这个 id 存不存在」
      const beforeGuard = handler.slice(0, guardAt);
      for (const forbidden of ["readJsonBody", "context.params", "new URL(", "await "]) {
        assert.equal(
          beforeGuard.includes(forbidden),
          false,
          `${relative} 的 ${name} 在鉴权之前就做了「${forbidden}」`,
        );
      }
    }
  }
});

test("接口文件的 handler 数量与预期一致（少一个、被改名都会在这里现形）", () => {
  const expected = {
    "api/admin/content/quick-entries/route.ts": 2, // GET + POST
    "api/admin/content/quick-entries/[id]/route.ts": 2, // GET + PATCH
    "api/admin/content/quick-entries/[id]/enable/route.ts": 1,
    "api/admin/content/quick-entries/[id]/disable/route.ts": 1,
    "api/admin/content/quick-entries/[id]/remove/route.ts": 1,
  };

  for (const [relative, count] of Object.entries(expected)) {
    const code = stripComments(readFileSync(findAppFile(relative), "utf8"));
    assert.equal(
      (code.match(/export async function /g) ?? []).length,
      count,
      `${relative} 的 handler 数量变了`,
    );
  }
});

test("接口层只做「鉴权 → 解析 → 调服务」，不自己判角色、不自己拼 DTO", () => {
  for (const relative of ROUTE_FILES) {
    const code = stripComments(readFileSync(findAppFile(relative), "utf8"));

    // 角色判断只有一处（`requireAdmin()` 内部），接口自己判就是第二处
    assert.equal(/role\s*===\s*["']admin["']/.test(code), false, `${relative} 自己判断了角色`);
    // DTO 由服务层生成：接口里直接碰仓储就会绕过校验与审计
    assert.equal(code.includes("lib/data/"), false, `${relative} 不该直接引用数据层`);
    assert.equal(code.includes("removedAt"), false, `${relative} 不该拼 DTO（响应里只有 removed）`);
  }
});
