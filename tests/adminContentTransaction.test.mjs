import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  createAnnouncement,
  createBanner,
  createQuickEntry,
  removeAnnouncement,
  removeBanner,
  setAnnouncementEnabled,
  setBannerEnabled,
  updateAnnouncement,
  updateBanner,
  updateQuickEntry,
} from "../lib/data/adminContentTransaction.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getContentRepository } from "../lib/data/contentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";

/**
 * **伪事务层自己的**测试（`lib/data/adminContentTransaction.ts`）。
 *
 * 与 Agent A / C 写的服务层测试刻意分工不同：那些测试走的是「接口 → 服务 → 事务」
 * 的完整链路，验证的是**接口契约**；这里绕过服务层直接调事务，验证的是**事务自己的
 * 三条不变量**——它们是这一层的存在理由，任何一条破了都不是「某个接口写错了」，
 * 而是所有写入路径一起出问题：
 *
 * 1. **幂等**：同一个幂等键第二次到达，业务记录数与审计条数**都不变**。
 * 2. **同生共死**：业务写入与审计写入要么都发生、要么都不发生；
 *    前置条件不满足时不允许留下半完成的数据。
 * 3. **守卫在守卫该在的地方**：`invalid-path` 这一类判定**必须在事务层也成立**，
 *    因为它是安全属性。服务层的校验发生在若干次 `await` 之前，
 *    而 `await` 之间隔着取会话、读请求体的时间——只有事务层能保证
 *    「写下去的那一刻它是安全的」。
 *
 * ⚠️ 还有一条只有在这一层才测得出来的性质：**`previous` 必须是副本**。
 * 走服务层时返回值马上被转成 DTO，看不出来；而审计快照的 before 取的正是它，
 * 一旦仓储把内部对象直接交出来，后面的一次写入会把 before 一起改掉，
 * 于是「这次改了什么」在审计里永久失真。这里用字符串指纹把它钉死。
 */

const ADMIN = "admin-1";

/** 一次后台写操作的完整身份。`operationId` 就是幂等键。 */
function ctx(operationId, at = new Date().toISOString()) {
  return {
    actorId: ADMIN,
    actorRole: "admin",
    actorName: null,
    operationId,
    at,
  };
}

function key() {
  return crypto.randomUUID();
}

/** 一份合法的公告 draft。逐用例只覆盖需要变的那几个字段。 */
function announcementDraft(overrides = {}) {
  return {
    title: "首页公告位 - 事务层用例",
    imageUrl: "/mock/announcement-1.svg",
    alt: "公告图片占位",
    sortOrder: 50,
    enabled: true,
    ...overrides,
  };
}

function quickEntryDraft(overrides = {}) {
  return {
    label: "事务层入口",
    icon: "service",
    path: "/service",
    sortOrder: 50,
    enabled: true,
    ...overrides,
  };
}

function bannerDraft(overrides = {}) {
  return {
    title: "首页活动位 - 事务层用例",
    imageUrl: "/mock/promo-activity.svg",
    alt: "活动图片占位",
    sortOrder: 50,
    enabled: true,
    ...overrides,
  };
}

/** 业务记录数与审计条数。幂等用例几乎每一条都要同时看这两个数。 */
async function counts() {
  const content = getContentRepository();
  const [announcements, banners, quickEntries, audits] = await Promise.all([
    content.listAnnouncementRecords(),
    content.listBannerRecords(),
    content.listQuickEntryRecords(),
    getAdminAuditRepository().countAudits(),
  ]);
  return {
    announcements: announcements.length,
    banners: banners.length,
    quickEntries: quickEntries.length,
    audits,
  };
}

beforeEach(() => {
  resetMockStore("content");
  resetMockStore("adminAudit");
});

// ——————————————————————————— 幂等 ———————————————————————————

test("同一个幂等键建两次公告：只多一条记录、只多一条审计，第二次是重放", async () => {
  const operationId = key();
  const before = await counts();

  const first = await createAnnouncement(announcementDraft(), ctx(operationId));
  assert.equal(first.kind, "ok");
  assert.equal(first.changed, true);
  assert.equal(first.replayed, false);

  const afterFirst = await counts();
  assert.equal(afterFirst.announcements, before.announcements + 1, "第一次没有真的建记录");
  assert.equal(afterFirst.audits, before.audits + 1, "第一次没有真的写审计");

  // 第二次：**完全相同的意图**再到达一次
  const second = await createAnnouncement(announcementDraft(), ctx(operationId));
  assert.equal(second.kind, "ok");
  assert.equal(second.changed, false, "重放不该被算成一次改动");
  assert.equal(second.replayed, true, "第二次到达没有被认出来是重放");
  assert.equal(
    second.value.updated.id,
    first.value.updated.id,
    "重放返回的应当是第一次建出来的那条记录",
  );

  const afterSecond = await counts();
  assert.deepEqual(
    afterSecond,
    afterFirst,
    "重放改变了记录数或审计条数——幂等没有生效",
  );
});

test("同一个幂等键建两次快捷入口 / Banner：同样只生效一次", async () => {
  const entryKey = key();
  const bannerKey = key();
  const before = await counts();

  await createQuickEntry(quickEntryDraft(), ctx(entryKey));
  await createQuickEntry(quickEntryDraft(), ctx(entryKey));
  await createBanner(bannerDraft(), ctx(bannerKey));
  await createBanner(bannerDraft(), ctx(bannerKey));

  const after = await counts();
  assert.equal(after.quickEntries, before.quickEntries + 1, "快捷入口被建了两次");
  assert.equal(after.banners, before.banners + 1, "Banner 被建了两次");
  assert.equal(after.audits, before.audits + 2, "审计条数不等于真正发生的两次操作");
});

test("幂等键用在**另一条**公告上：判为冲突，而不是安静地重放", async () => {
  const operationId = key();

  const first = await createAnnouncement(announcementDraft(), ctx(operationId));
  assert.equal(first.kind, "ok");
  const targetId = first.value.updated.id;

  // 同一个键，但目标换成了另一条预置公告
  const conflict = await updateAnnouncement(
    "a1",
    announcementDraft({ title: "换了目标" }),
    ctx(operationId),
  );

  assert.equal(
    conflict.kind,
    "operation-conflict",
    "同一个幂等键换个对象再用，必须报冲突——安静重放会让调用方拿到与事实相反的成功",
  );

  // 冲突不写任何东西
  const audits = await getAdminAuditRepository().listAudits({ targetType: "announcement" });
  assert.equal(audits.length, 1, "冲突路径写了审计");
  const records = await getContentRepository().listAnnouncementRecords();
  assert.equal(
    records.filter((record) => record.id === targetId).length,
    1,
    "冲突路径改了业务数据",
  );
});

test("新建的 id 不会撞上预置记录：预置数据在新建之后一条不少", async () => {
  const before = await getContentRepository().listAnnouncementRecords();
  const beforeIds = new Set(before.map((record) => record.id));

  for (let index = 0; index < 5; index += 1) {
    const outcome = await createAnnouncement(
      announcementDraft({ title: `批量新建 ${index}` }),
      ctx(key()),
    );
    assert.equal(outcome.kind, "ok");
    assert.equal(
      beforeIds.has(outcome.value.updated.id),
      false,
      `新建生成的 id「${outcome.value.updated.id}」撞上了一条预置记录`,
    );
  }

  const after = await getContentRepository().listAnnouncementRecords();
  for (const id of beforeIds) {
    assert.ok(
      after.some((record) => record.id === id),
      `预置记录 ${id} 在批量新建之后消失了`,
    );
  }
});

// —————————————————————— 审计与业务同生共死 ——————————————————————

test("前置条件失败时不留下半完成的数据：既不写业务，也不写审计", async () => {
  const before = await counts();

  // 目标不存在
  const missing = await updateAnnouncement("不存在", announcementDraft(), ctx(key()));
  assert.equal(missing.kind, "not-found");

  // 目标已移除
  const removed = await removeAnnouncement("a1", ctx(key()));
  assert.equal(removed.kind, "ok");
  const afterRemove = await counts();
  assert.equal(afterRemove.audits, before.audits + 1);

  const onRemoved = await updateAnnouncement("a1", announcementDraft(), ctx(key()));
  assert.equal(onRemoved.kind, "removed", "已移除的公告还能被编辑");
  const onRemovedEnabled = await setAnnouncementEnabled("a1", false, ctx(key()));
  assert.equal(onRemovedEnabled.kind, "removed", "已移除的公告还能被启停");

  const after = await counts();
  assert.deepEqual(
    after,
    afterRemove,
    "失败路径改变了记录数或审计条数——要么写了半截数据，要么留下了一条说不清来历的审计",
  );
});

test("每一次真正生效的改动，审计恰好增加一条；没生效的一次也不写", async () => {
  const operationId = key();
  const created = await createAnnouncement(announcementDraft(), ctx(operationId));
  const id = created.value.updated.id;
  const base = (await counts()).audits;

  // 真正生效的编辑 → +1
  const edited = await updateAnnouncement(id, announcementDraft({ title: "改过的标题" }), ctx(key()));
  assert.equal(edited.changed, true);
  assert.equal((await counts()).audits, base + 1, "一次真实改动没有对应恰好一条审计");

  // 提交内容与现状完全相同 → 不写审计（`changed:false` 不是错误，但也不是一次变更）
  const noop = await updateAnnouncement(id, announcementDraft({ title: "改过的标题" }), ctx(key()));
  assert.equal(noop.kind, "ok");
  assert.equal(noop.changed, false, "提交与现状完全相同，却被算成一次改动");
  assert.equal((await counts()).audits, base + 1, "一次空提交写了审计");

  // 启停 → +1
  const disabled = await setAnnouncementEnabled(id, false, ctx(key()));
  assert.equal(disabled.changed, true);
  assert.equal(disabled.value.action, "announcement.disable");
  assert.equal((await counts()).audits, base + 2, "一次启停没有对应恰好一条审计");

  // 重复启停同一个状态 → 不写审计
  const again = await setAnnouncementEnabled(id, false, ctx(key()));
  assert.equal(again.changed, false, "重复停用同一条被算成一次改动");
  assert.equal((await counts()).audits, base + 2, "一次空启停写了审计");

  // 移除 → +1
  const removed = await removeAnnouncement(id, ctx(key()));
  assert.equal(removed.changed, true);
  assert.equal((await counts()).audits, base + 3);

  // 重复移除 → 不写审计，也不刷新 removedAt
  const removedAgain = await removeAnnouncement(id, ctx(key()));
  assert.equal(removedAgain.changed, false, "重复移除被算成一次改动");
  assert.equal(
    removedAgain.value.updated.removedAt,
    removed.value.updated.removedAt,
    "重复移除把软删除时间戳刷新了——「什么时候移除的」因此失真",
  );
  assert.equal((await counts()).audits, base + 3, "一次空移除写了审计");
});

test("审计记的是谁做的：三个操作者字段全部来自 ctx，请求里没有第二个来源", async () => {
  const operationId = key();
  await createAnnouncement(announcementDraft(), ctx(operationId));

  const entry = await getAdminAuditRepository().findAuditByOperationId(operationId);
  assert.ok(entry, "新建之后找不到对应的审计记录");
  assert.equal(entry.actorId, ADMIN);
  assert.equal(entry.actorRole, "admin");
  assert.equal(entry.actorName, null);
  assert.equal(entry.action, "announcement.create");
  assert.equal(entry.targetType, "announcement");
  assert.equal(entry.before, null, "新建的 before 必须是 null（当时还不存在「更新前」）");
  assert.ok(entry.after, "新建的 after 不能为空");
});

// ———————————————————— previous 必须是副本 ————————————————————

test("返回的 previous 是快照：后续写入不会把审计里的 before 一起改掉", async () => {
  const id = "a1";
  const operationId = key();

  const first = await updateAnnouncement(
    id,
    announcementDraft({ title: "第一次改名" }),
    ctx(operationId, "2026-03-01T00:00:00.000Z"),
  );
  assert.equal(first.kind, "ok");

  const previousFingerprint = JSON.stringify(first.value.previous);

  // 再改一次（时间戳换一个明确不同的值，这样「谁的时间戳」是可断言的）
  await updateAnnouncement(
    id,
    announcementDraft({ title: "第二次改名" }),
    ctx(key(), "2026-04-02T00:00:00.000Z"),
  );

  assert.equal(
    JSON.stringify(first.value.previous),
    previousFingerprint,
    "第一次返回的 previous 被后续写入改动了——审计快照的 before 会永久失真",
  );
  assert.equal(first.value.previous.title, "首页公告位 - 开工活动");
  assert.equal(
    first.value.previous.updatedAt,
    "2026-01-06T09:00:00.000Z",
    "previous 里那条预置记录的更新时间被后来的写入改掉了",
  );

  // 仓储里那条记录确实已经变了（不是「因为压根没写进去」才没被动）
  const stored = await getContentRepository().findAnnouncementById(id);
  assert.equal(stored.title, "第二次改名");
  assert.equal(
    stored.updatedAt,
    "2026-04-02T00:00:00.000Z",
    "updatedAt 不是来自服务端写入那一刻的 ctx.at",
  );
});

// —————————————— 服务端字段在入参里没有位置 ——————————————

test("draft 里塞服务端字段无效：id / createdAt / removedAt 不可能被客户端改写", async () => {
  const created = await createAnnouncement(announcementDraft(), ctx(key()));
  const id = created.value.updated.id;
  const original = created.value.updated;

  // 恶意 draft：把服务端字段一并塞进来
  const outcome = await updateAnnouncement(
    id,
    {
      ...announcementDraft({ title: "试图改服务端字段" }),
      id: "a1",
      createdAt: "1999-01-01T00:00:00.000Z",
      updatedAt: "1999-01-01T00:00:00.000Z",
      removedAt: "1999-01-01T00:00:00.000Z",
    },
    ctx(key()),
  );

  assert.equal(outcome.kind, "ok");
  const updated = outcome.value.updated;

  assert.equal(updated.id, id, "客户端塞进来的 id 生效了");
  assert.equal(updated.createdAt, original.createdAt, "客户端改动了 createdAt");
  assert.equal(updated.removedAt, null, "客户端凭 draft 把记录标记成已移除");
  assert.equal(updated.title, "试图改服务端字段", "该生效的字段反而没生效");
  assert.notEqual(updated.updatedAt, "1999-01-01T00:00:00.000Z", "客户端改动了 updatedAt");
});

// ———————————————————— 安全守卫在事务层 ————————————————————

test("事务层自己就挡得住不安全路径：绕过服务层也写不进 javascript: 与协议相对地址", async () => {
  const before = await counts();

  const attempts = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "//evil.example/x",
    "https://evil.example/x",
    "data:text/html,<script>alert(1)</script>",
    "/\\evil.example",
    "",
    "   ",
    "join",
  ];

  for (const path of attempts) {
    const outcome = await createQuickEntry(quickEntryDraft({ path }), ctx(key()));
    assert.equal(
      outcome.kind,
      "invalid-path",
      `路径「${path}」没有被事务层挡住（拿到了 ${outcome.kind}）`,
    );
  }

  const after = await counts();
  assert.deepEqual(
    after,
    before,
    "被挡下的写入仍然改变了记录数或审计条数",
  );

  // 编辑路径同样挡住：先把一条合法记录改成非法地址
  const created = await createQuickEntry(quickEntryDraft(), ctx(key()));
  const id = created.value.updated.id;
  const baseline = await counts();

  const edited = await updateQuickEntry(id, quickEntryDraft({ path: "javascript:alert(1)" }), ctx(key()));
  assert.equal(edited.kind, "invalid-path", "编辑路径没有经过同一道守卫");

  const stored = await getContentRepository().findQuickEntryById(id);
  assert.equal(stored.path, "/service", "被拒绝的编辑还是改动了记录");
  assert.deepEqual(await counts(), baseline, "被拒绝的编辑改变了记录数或审计条数");
});

test("合法的站内路径在事务层被接受：拒绝的是危险地址，不是所有地址", async () => {
  for (const path of ["/join", "/service", "/placeholder?title=点单权益", "/complaints#top"]) {
    const outcome = await createQuickEntry(quickEntryDraft({ path }), ctx(key()));
    assert.equal(outcome.kind, "ok", `合法的站内路径「${path}」被误拒了`);
    assert.equal(outcome.value.updated.path, path);
  }
});

// ———————————————————— 三条线互不干扰 ————————————————————

test("三组内容各自的记录与审计互不串线", async () => {
  const announcement = await createAnnouncement(announcementDraft(), ctx(key()));
  const banner = await createBanner(bannerDraft(), ctx(key()));
  const entry = await createQuickEntry(quickEntryDraft(), ctx(key()));

  assert.equal(announcement.value.action, "announcement.create");
  assert.equal(banner.value.action, "banner.create");
  assert.equal(entry.value.action, "quickEntry.create");

  // 停用公告不该动到 Banner 与快捷入口
  const beforeBanner = (await getContentRepository().findBannerById(banner.value.updated.id)).enabled;
  const beforeEntry = (await getContentRepository().findQuickEntryById(entry.value.updated.id)).enabled;

  await setAnnouncementEnabled(announcement.value.updated.id, false, ctx(key()));
  await setBannerEnabled(banner.value.updated.id, false, ctx(key()));

  const audits = await getAdminAuditRepository().listAudits();
  assert.deepEqual(
    audits.map((item) => item.action),
    ["announcement.create", "banner.create", "quickEntry.create", "announcement.disable", "banner.disable"],
    "审计的顺序或动作名与真实发生的不一致",
  );

  assert.equal(beforeBanner, true);
  assert.equal(beforeEntry, true);
  assert.equal(
    (await getContentRepository().findQuickEntryById(entry.value.updated.id)).enabled,
    true,
    "停用别的类别的内容把快捷入口一起停用了",
  );
});

// ———————————————— Banner 线的编辑与移除（补齐事务层的同类不变量）————————————————

/**
 * 公告线上的四条不变量在 Banner 线上必须同样成立。
 *
 * ⚠️ 为什么值得单独一条。三组内容（公告 / Banner / 快捷入口）走的是**同一份**
 * 伪事务实现，但它们各自有独立的 store、独立的审计 target、独立的动作名。
 * 「公告上测过了」不等于 Banner 上也对：`mapOf(kind)` 少写一个分支、
 * 动作名拼成 `banner.updated`、移除时忘了写 `removedAt`——每一种都只会在
 * **用户端首页的活动位**上表现出来，而那里没有断言就看不见。
 *
 * 断言刻意与公告那条**同形**：两条线上同样的输入应当得到同样的形状，
 * 否则「Banner 与公告是同一种内容」这句话就只是注释里的一句声明。
 */
test("Banner 的编辑与移除和公告同形：软删除、动作名、重复移除不刷新时间戳", async () => {
  const created = await createBanner(bannerDraft(), ctx(key()));
  assert.equal(created.kind, "ok");
  const id = created.value.updated.id;

  // 编辑 → 恰好一条审计，动作名是 banner.update
  const edited = await updateBanner(id, bannerDraft({ title: "改过的活动图" }), ctx(key()));
  assert.equal(edited.kind, "ok");
  assert.equal(edited.changed, true);
  assert.equal(edited.value.action, "banner.update");
  const stored = await getContentRepository().findBannerById(id);
  assert.equal(stored.title, "改过的活动图");

  // 移除 → 软删除（记录仍在，removedAt 非空），动作名是 banner.remove
  const removed = await removeBanner(id, ctx(key()));
  assert.equal(removed.kind, "ok");
  assert.equal(removed.changed, true);
  assert.equal(removed.value.action, "banner.remove");

  const afterRemove = await getContentRepository().findBannerById(id);
  assert.ok(afterRemove, "移除把 Banner 记录删掉了——移除必须是软删除");
  assert.notEqual(afterRemove.removedAt, null);

  // 重复移除：既不算一次改动，也不刷新「什么时候移除的」
  const removedAgain = await removeBanner(id, ctx(key()));
  assert.equal(removedAgain.changed, false);
  assert.equal(removedAgain.value.updated.removedAt, removed.value.updated.removedAt);

  // 已移除之后不能编辑（与公告同一条规则）
  const onRemoved = await updateBanner(id, bannerDraft({ title: "试图改已移除的" }), ctx(key()));
  assert.equal(onRemoved.kind, "removed");

  // 审计只记真正发生过的三次：新建、编辑、移除
  const audits = await getAdminAuditRepository().listAudits({ targetType: "banner" });
  assert.deepEqual(
    audits.map((item) => item.action),
    ["banner.create", "banner.update", "banner.remove"],
  );
});
