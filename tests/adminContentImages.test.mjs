import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTENT_ALT_EMPTY_MESSAGE,
  CONTENT_IMAGE_URL_EMPTY_MESSAGE,
  CONTENT_IMAGE_URL_INVALID_MESSAGE,
  CONTENT_SORT_ORDER_INVALID_MESSAGE,
  CONTENT_TITLE_EMPTY_MESSAGE,
  CONTENT_TITLE_MAX_LENGTH,
  CONTENT_TITLE_TOO_LONG_MESSAGE,
  countAdminContentStates,
  resolveContentRemovalFilter,
} from "../lib/constants/adminContent.ts";
import { compareContentOrder, selectActivityImageUrl } from "../lib/constants/homeContent.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getContentRepository } from "../lib/data/contentRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { announcementSeed, bannerSeed } from "../lib/mocks/fixtures/contentSeed.ts";
import { getHomeData } from "../lib/services/home.ts";
import {
  ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE,
  ADMIN_ANNOUNCEMENT_REMOVED_MESSAGE,
  ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE,
  ADMIN_CONTENT_REMOVAL_INVALID_MESSAGE,
  createAdminAnnouncement,
  getAdminAnnouncementDetail,
  queryAdminAnnouncementList,
  removeAdminAnnouncement,
  resolveAdminContentListQuery,
  setAdminAnnouncementEnabled,
  updateAdminAnnouncement,
} from "../lib/services/adminAnnouncements.ts";
import {
  ADMIN_BANNER_NOT_FOUND_MESSAGE,
  ADMIN_BANNER_REMOVED_MESSAGE,
  createAdminBanner,
  getAdminBannerDetail,
  queryAdminBannerList,
  removeAdminBanner,
  resolveAdminContentListQuery as resolveAdminBannerListQuery,
  setAdminBannerEnabled,
  updateAdminBanner,
} from "../lib/services/adminBanners.ts";

/**
 * P8E-1：图片公告与活动 Banner 的**服务层 + 接口层**测试。
 *
 * 伪事务自己的不变量（幂等、同生共死、previous 是副本）由
 * `tests/adminContentTransaction.test.mjs` 直接盯住；这里走的是
 * 「服务 → 事务 → 仓储 → 用户端」的**完整链路**，守的是接口契约：
 *
 * 1. **身份只来自会话**：请求体里的 `actorId` / `role` / `id` / `removedAt` 一律无效；
 * 2. **幂等**：同一个键第二次到达 → `changed:false, replayed:true`，数据与审计都不动；
 *    同一个键换个对象 → 明确的 400，而不是安静地重放；
 * 3. **后台改完，用户端立刻是新的**：停用公告 → 公告区少一条；改 Banner 的
 *    `sortOrder` / `enabled` → 首页活动位换成新的那张。这是 §三 冻结口径里最要紧的一条，
 *    只有走到 `getHomeData()` 才证明得了「用户端确实变了」；
 * 4. **软删除**：移除之后记录还在（`removedAt !== null`），但用户端看不到、也不能再编辑；
 * 5. **审计恰好一条**：每次真实变更一条，重放与空提交都不写；动作名由事务层算好
 *    （编辑时把启用勾去掉记的是「停用」而不是「编辑」）；
 * 6. **DTO 最小化**：响应里没有 `removedAt` 原文、没有审计记录、没有内部状态描述。
 *
 * ⚠️ 断言的是**真实实现**：`lib/services/adminAnnouncements.ts` /
 * `adminBanners.ts` 加上真实的 Mock 仓储，不是复制一份逻辑再测一遍复制品。
 *
 * 权限（401 / 403）需要真实服务，走 `APP_BASE_URL` 的 HTTP 矩阵在
 * `tests/adminCategories.test.mjs` 里有一份同形的；这里改用**源码级**断言盯住
 * 「每个 handler 的第一件事都是 `requireAdmin()`」——它不需要起服务，因此永远不会被跳过。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_API_DIR = path.join(ROOT, "app", "api", "admin", "content");

/** 执行操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置数据里的关键记录（见 `lib/mocks/fixtures/contentSeed.ts`）。 */
const ANNOUNCEMENT_1 = "a1";
const ANNOUNCEMENT_2 = "a2";
const BANNER_1 = "b1";

let keySeq = 0;
/** 每个用例一个全新的幂等键：键与「这次意图」绑定，用例之间不能共用。 */
function uniqueKey() {
  keySeq += 1;
  return `p8e1-img-key-${process.pid}-${keySeq}`;
}

function params(input = {}) {
  return new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 同上，用于**同步**就要报错的那几处（查询条件解析没有必要做成异步）。 */
function expectApiErrorNow(run, code, message) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

/** 一份合法的公告 / 活动图提交体，用例按需覆盖其中几项。 */
function imageInput(overrides = {}) {
  return {
    title: "首页素材 - 用例",
    imageUrl: "/mock/announcement-1.svg",
    alt: "素材图片占位",
    sortOrder: 100,
    enabled: true,
    ...overrides,
  };
}

/** 管理端公告列表：从地址栏参数解析查询条件再取数（页面与接口走的是同一条路径）。 */
async function adminAnnouncements(input = {}, strict = false) {
  const search = params(input);
  const query = resolveAdminContentListQuery(search, strict);
  return queryAdminAnnouncementList(query, search, "server");
}

async function adminBanners(input = {}, strict = false) {
  const search = params(input);
  const query = resolveAdminContentListQuery(search, strict);
  return queryAdminBannerList(query, search, "server");
}

function announcementRecords() {
  return getContentRepository().listAnnouncementRecords();
}

function bannerRecords() {
  return getContentRepository().listBannerRecords();
}

function announcementAudits(targetId) {
  return getAdminAuditRepository().listAudits({
    targetType: "announcement",
    ...(targetId ? { targetId } : {}),
  });
}

function bannerAudits(targetId) {
  return getAdminAuditRepository().listAudits({
    targetType: "banner",
    ...(targetId ? { targetId } : {}),
  });
}

function createAnnouncement(overrides = {}, key = uniqueKey()) {
  return createAdminAnnouncement(ADMIN_ID, { idempotencyKey: key, ...imageInput(overrides) });
}

function createBanner(overrides = {}, key = uniqueKey()) {
  return createAdminBanner(ADMIN_ID, { idempotencyKey: key, ...imageInput(overrides) });
}

/** 用户端首页。后台改完之后「用户端是不是真的变了」只能由它回答。 */
function home() {
  return getHomeData(undefined, "server");
}

/** 列表必须是 `sortOrder` → `id` 的全序（与用户端同一个比较函数）。 */
function assertSorted(items) {
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(
      compareContentOrder(items[index - 1], items[index]) <= 0,
      `列表顺序不是 sortOrder → id 升序：${items.map((item) => item.id).join(" / ")}`,
    );
  }
}

beforeEach(() => {
  // 内容与审计一起重置：幂等键的账本就在审计仓储里（`findAuditByOperationId`），
  // 只重置内容会让上一个用例用过的键在这个用例里变成「重放」
  resetMockStore("content");
  resetMockStore("adminAudit");
});

// ————————————————————————— 新建 · 落库与审计 —————————————————————————

test("新建公告：仓储里真的多了一条，时间戳来自服务端，审计 before 为 null", async () => {
  const before = await announcementRecords();
  const startedAt = Date.now();

  const result = await createAnnouncement({ title: "新公告甲", sortOrder: 55 });

  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(result.removed, false);
  assert.equal(result.enabled, true);
  assert.match(result.announcementId, /^an_/, "后台新建的 id 与预置数据的短 id 从取值域上分开");

  // 写结果里跟着的那条记录：字段与列表项 DTO 同形，且是**服务端确认过**的同一份快照
  assert.equal(result.updated.id, result.announcementId);
  assert.equal(result.updated.title, "新公告甲");
  assert.equal(result.updated.sortOrder, 55);
  assert.equal(result.updated.removed, false);
  assert.equal("removedAt" in result.updated, false, "写结果里泄漏了内部字段 removedAt");

  const after = await announcementRecords();
  assert.equal(after.length, before.length + 1, "接口回了成功，仓储里却没有这条记录");

  const detail = await getAdminAnnouncementDetail(result.announcementId, undefined, "server");
  assert.equal(detail.title, "新公告甲");
  assert.equal(detail.imageUrl, "/mock/announcement-1.svg");
  assert.equal(detail.alt, "素材图片占位");
  assert.equal(detail.sortOrder, 55);
  assert.equal(detail.enabled, true);
  assert.equal(detail.removed, false);

  // 时间戳由服务端取，且业务写入与审计写入共用同一个值
  assert.equal(detail.createdAt, detail.updatedAt, "新建时创建时间与更新时间必须是同一刻");
  assert.ok(
    Math.abs(new Date(detail.createdAt).getTime() - startedAt) < 10_000,
    `createdAt 不是服务端刚刚取的时间：${detail.createdAt}`,
  );

  const audits = await announcementAudits(result.announcementId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "announcement.create");
  assert.equal(audits[0].before, null, "新建时还不存在「更新前」，before 就是 null");
  assert.equal(audits[0].after.title, "新公告甲");
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].createdAt, detail.createdAt, "审计与业务写入没有共用同一个时间戳");
});

test("新建的公告立刻出现在管理端列表里，且预置记录一条没少", async () => {
  const created = await createAnnouncement({ title: "列表用新公告", sortOrder: 500 });
  const list = await adminAnnouncements();

  assert.equal(list.total, announcementSeed.length + 1);
  assert.equal(list.items.length, announcementSeed.length + 1);
  assert.ok(list.items.some((item) => item.id === created.announcementId));
  for (const seed of announcementSeed) {
    assert.ok(list.items.some((item) => item.id === seed.id), `预置公告 ${seed.id} 不见了`);
  }
  assertSorted(list.items);
});

// ——————————————————————————————— 幂等 ———————————————————————————————

test("同一个幂等键重复新建：第二次是重放，记录数与审计条数都不变", async () => {
  const key = uniqueKey();
  const first = await createAnnouncement({ title: "幂等新建" }, key);
  const countAfterFirst = (await announcementRecords()).length;
  const auditsAfterFirst = (await announcementAudits()).length;

  // 第二次的请求体故意不一样：重放必须返回**第一次**的结果，而不是按新请求体再建一条
  const second = await createAdminAnnouncement(ADMIN_ID, {
    idempotencyKey: key,
    ...imageInput({ title: "幂等新建（重放）", sortOrder: 999 }),
  });

  assert.equal(second.announcementId, first.announcementId, "重放返回的应当是第一次建出来的那条");
  assert.equal(second.changed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.updated.title, first.updated.title, "重放没有返回第一次的那条记录");
  assert.equal(second.updated.sortOrder, 100, "重放把第一次的结果换成了第二次的请求体");
  assert.deepEqual(second.updated, first.updated, "两次重放的「服务端确认过的记录」应当是同一份");
  assert.equal((await announcementRecords()).length, countAfterFirst, "重放又建了一条记录");
  assert.equal((await announcementAudits()).length, auditsAfterFirst, "重放写了第二条审计");

  const stored = await getAdminAnnouncementDetail(first.announcementId, undefined, "server");
  assert.equal(stored.title, "幂等新建", "重放按新请求体改写了已经建好的记录");
  assert.equal(stored.sortOrder, 100);
});

test("幂等键用在另一条公告上、或用在 Banner 上：都是冲突，且不写任何东西", async () => {
  const key = uniqueKey();
  const created = await createAnnouncement({ title: "键的主人" }, key);
  const recordsBefore = (await announcementRecords()).length;

  // 同一个键去改另一条公告：安静重放会返回另一个对象的结果，比报错危险得多
  await expectApiError(
    updateAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
      idempotencyKey: key,
      ...imageInput({ title: "亏本单改" }),
    }),
    "BAD_REQUEST",
    ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE,
  );
  // 同一个键用在另一**类**内容上同理：键的归属按「目标类型 × 目标对象 × 操作者」算
  await expectApiError(
    createBanner({ title: "跨类型的键" }, key),
    "BAD_REQUEST",
    ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE,
  );

  // 冲突没有产生任何副作用
  assert.equal((await announcementRecords()).length, recordsBefore);
  assert.equal((await bannerRecords()).length, bannerSeed.length);
  assert.equal((await announcementAudits()).length, 1);
  const untouched = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");
  assert.equal(untouched.title, "首页公告位 - 开工活动");
  assert.ok(created.announcementId);
});

test("幂等键非法或缺失：400，且任何数据都没被写", async () => {
  for (const value of [undefined, "", "short", "有中文的键", "x".repeat(65)]) {
    const body = { ...imageInput({ title: "非法键" }) };
    if (value !== undefined) body.idempotencyKey = value;
    await expectApiError(
      createAdminAnnouncement(ADMIN_ID, body),
      "BAD_REQUEST",
      ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
    );
  }

  // 运营内容列表**没有关键字搜索**（个位数到几十条，搜索框只会让人误以为筛过了），
  // 因此这里直接数仓储：一次都没写进去才是真的
  const records = await announcementRecords();
  assert.equal(records.length, announcementSeed.length);
  assert.equal(records.some((record) => record.title === "非法键"), false);
  assert.equal((await announcementAudits()).length, 0);
});

// ——————————————————————————————— 编辑 ———————————————————————————————

test("编辑公告：名称 / 图片 / 排序生效，updatedAt 变了，审计 before 与 after 是两份不同的快照", async () => {
  const before = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");

  const result = await updateAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: "开工活动（改）",
      imageUrl: "/mock/announcement-2.svg",
      alt: "改过的说明",
      sortOrder: 5,
    }),
  });
  assert.equal(result.changed, true);

  const after = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");
  assert.equal(after.title, "开工活动（改）");
  assert.equal(after.imageUrl, "/mock/announcement-2.svg");
  assert.equal(after.alt, "改过的说明");
  assert.equal(after.sortOrder, 5);
  assert.equal(after.enabled, before.enabled);
  assert.equal(after.createdAt, before.createdAt, "createdAt 不是可编辑字段");
  assert.notEqual(after.updatedAt, before.updatedAt, "改完要留下新的更新时间");

  const audits = await announcementAudits(ANNOUNCEMENT_1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "announcement.update");
  assert.notDeepEqual(audits[0].before, audits[0].after, "before 与 after 变成了同一份快照");
  assert.equal(audits[0].before.title, "首页公告位 - 开工活动");
  assert.equal(audits[0].after.title, "开工活动（改）");
  assert.equal(audits[0].before.sortOrder, 10);
  assert.equal(audits[0].after.sortOrder, 5);
  assert.equal(audits[0].actorId, ADMIN_ID);

  // 审计快照只允许标量：一个字段忘了裁剪，也不可能把对象整个塞进来
  for (const snapshot of [audits[0].before, audits[0].after]) {
    for (const value of Object.values(snapshot)) {
      assert.equal(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        true,
        `审计快照里出现了非标量：${JSON.stringify(value)}`,
      );
    }
  }
});

test("编辑时把启用勾去掉：审计动作是「停用公告」，而不是「编辑公告」", async () => {
  const detail = await getAdminAnnouncementDetail(ANNOUNCEMENT_2, undefined, "server");
  assert.equal(detail.enabled, true, "预置公告本来是启用中的，否则这个用例证明不了什么");

  const disabled = await updateAdminAnnouncement(ANNOUNCEMENT_2, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: detail.title,
      imageUrl: detail.imageUrl,
      alt: detail.alt,
      sortOrder: detail.sortOrder,
      enabled: false,
    }),
  });

  // 动作名由事务层按「本次提交的差异」算出来：同一个编辑接口既能是编辑，也能是停用。
  // 审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」
  assert.equal(disabled.changed, true);
  assert.equal(disabled.enabled, false);
  assert.equal(
    (await getAdminAnnouncementDetail(ANNOUNCEMENT_2, undefined, "server")).enabled,
    false,
  );
  assert.deepEqual(
    (await announcementAudits(ANNOUNCEMENT_2)).map((entry) => entry.action),
    ["announcement.disable"],
  );

  // 勾回来记的是「启用」，同样不是「编辑」
  const enabled = await updateAdminAnnouncement(ANNOUNCEMENT_2, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: detail.title,
      imageUrl: detail.imageUrl,
      alt: detail.alt,
      sortOrder: detail.sortOrder,
      enabled: true,
    }),
  });
  assert.equal(enabled.enabled, true, "启用之后那条记录仍然是停用的");
  assert.equal(enabled.changed, true);
  assert.deepEqual(
    (await announcementAudits(ANNOUNCEMENT_2)).map((entry) => entry.action),
    ["announcement.disable", "announcement.enable"],
  );
});

test("提交的内容与现状完全相同：changed 与 replayed 都是 false，且不写审计", async () => {
  const detail = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");

  const noop = await updateAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: detail.title,
      imageUrl: detail.imageUrl,
      alt: detail.alt,
      sortOrder: detail.sortOrder,
      enabled: detail.enabled,
    }),
  });

  // 「什么都没变」不是错误（管理员点了一次保存而没改任何东西），但也必须让前端能看出来
  assert.equal(noop.changed, false);
  assert.equal(noop.replayed, false, "这不是重放：这个键是第一次到达");
  assert.equal(
    (await announcementAudits()).length,
    0,
    "一次没有内容的保存不该在审计里留下「改了什么」看不出来的记录",
  );

  // 启停同理：对一个已经启用的公告再启用一次
  const again = await setAdminAnnouncementEnabled(ANNOUNCEMENT_1, true, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(again.changed, false);
  assert.equal(again.replayed, false);
  assert.equal((await announcementAudits()).length, 0);

  const stored = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");
  assert.equal(stored.updatedAt, detail.updatedAt, "没有变更的提交不该刷新更新时间");
});

// ——————————————————— 后台改完，用户端立刻是新的 ———————————————————

test("停用一条公告之后，用户端公告区确实没有它了；启用回来又有了", async () => {
  const first = await home();
  assert.ok(
    first.announcements.some((item) => item.id === ANNOUNCEMENT_1),
    "预置公告本来在首页公告区里，否则这个用例证明不了什么",
  );

  await setAdminAnnouncementEnabled(ANNOUNCEMENT_1, false, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });

  const hidden = await home();
  assert.equal(
    hidden.announcements.some((item) => item.id === ANNOUNCEMENT_1),
    false,
    "停用之后用户端还看得到它——用户端读的与管理端改的不是同一份数据",
  );
  assert.ok(hidden.announcements.some((item) => item.id === ANNOUNCEMENT_2), "别的公告不该受影响");
  assert.equal((await announcementAudits(ANNOUNCEMENT_1)).length, 1);

  // 停用是可逆的，与移除不是一回事
  await setAdminAnnouncementEnabled(ANNOUNCEMENT_1, true, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  const restored = await home();
  assert.ok(restored.announcements.some((item) => item.id === ANNOUNCEMENT_1));
});

test("改排序会改变首页公告的展示顺序：排序值升序，相同则按 id", async () => {
  const created = await createAnnouncement({ title: "排到最前", sortOrder: 1 });

  const data = await home();
  assert.equal(data.announcements[0].id, created.announcementId, "排序值最小的应当排在最前");
  assert.equal(data.announcements[0].imageUrl, "/mock/announcement-1.svg");
  assert.equal(data.announcements[0].alt, "素材图片占位");
  assert.ok(
    data.announcements.every((item) => !("title" in item) && !("enabled" in item)),
    "用户端公告 DTO 里不该出现后台字段",
  );
});

// ——————————————————————————————— 软删除 ———————————————————————————————

test("移除是软移除：记录还在且 removedAt 不为 null，但用户端选择函数把它排除", async () => {
  const countBefore = (await announcementRecords()).length;

  const result = await removeAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(result.changed, true);
  assert.equal(result.removed, true);
  assert.equal(result.updated.removed, true, "移除后的记录在写结果里仍显示为未移除");

  const stored = await getContentRepository().findAnnouncementById(ANNOUNCEMENT_1);
  assert.ok(stored, "移除把记录删掉了——「当时首页上那张图是什么」将永久查不到");
  assert.notEqual(stored.removedAt, null);
  assert.equal((await announcementRecords()).length, countBefore, "移除不该改变记录数");

  const data = await home();
  assert.equal(data.announcements.some((item) => item.id === ANNOUNCEMENT_1), false);

  // 后台仍然查得到（软删除不是记录消失）
  const detail = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");
  assert.equal(detail.id, ANNOUNCEMENT_1);
  assert.equal(detail.removed, true);

  // 重复移除是幂等的：不刷新时间戳、不写第二条审计
  const stamp = stored.removedAt;
  const again = await removeAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.equal(again.changed, false);
  assert.equal(again.replayed, false);
  assert.equal(
    (await getContentRepository().findAnnouncementById(ANNOUNCEMENT_1)).removedAt,
    stamp,
    "重复移除把软删除时间戳刷新了——「什么时候移除的」因此失真",
  );
  // 这条记录一共只有一条审计：移除它的那一条。重复的那次什么都没写
  assert.deepEqual(
    (await announcementAudits(ANNOUNCEMENT_1)).map((entry) => entry.action),
    ["announcement.remove"],
  );
});

test("已移除的公告不能再编辑 / 启停，但详情照常打得开", async () => {
  const created = await createAnnouncement({ title: "待移除公告" });
  await removeAdminAnnouncement(created.announcementId, ADMIN_ID, { idempotencyKey: uniqueKey() });

  await expectApiError(
    updateAdminAnnouncement(created.announcementId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...imageInput({ title: "改名试试" }),
    }),
    "BAD_REQUEST",
    ADMIN_ANNOUNCEMENT_REMOVED_MESSAGE,
  );
  for (const enabled of [true, false]) {
    await expectApiError(
      setAdminAnnouncementEnabled(created.announcementId, enabled, ADMIN_ID, {
        idempotencyKey: uniqueKey(),
      }),
      "BAD_REQUEST",
      ADMIN_ANNOUNCEMENT_REMOVED_MESSAGE,
    );
  }

  const detail = await getAdminAnnouncementDetail(created.announcementId, undefined, "server");
  assert.equal(detail.title, "待移除公告", "被拒绝的编辑还是改动了记录");
  assert.equal(detail.removed, true);

  // 被拒绝的三次没有留下审计：这条记录一共两条——建它的那条，和移除它的那条
  assert.deepEqual(
    (await announcementAudits(created.announcementId)).map((entry) => entry.action),
    ["announcement.create", "announcement.remove"],
  );
});

test("不存在的公告：详情返回 null（页面转 404），四种写操作都是 404", async () => {
  assert.equal(await getAdminAnnouncementDetail("a-nope", undefined, "server"), null);
  assert.equal(await getAdminAnnouncementDetail("", undefined, "server"), null);

  await expectApiError(
    updateAdminAnnouncement("a-nope", ADMIN_ID, { idempotencyKey: uniqueKey(), ...imageInput() }),
    "NOT_FOUND",
    ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    setAdminAnnouncementEnabled("a-nope", false, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE,
  );
  await expectApiError(
    removeAdminAnnouncement("a-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_ANNOUNCEMENT_NOT_FOUND_MESSAGE,
  );
});

// ——————————————————————————————— 列表 ———————————————————————————————

test("列表筛选：默认看「还在用的」，等号两边是 total 与 counts 各自的含义", async () => {
  const all = await adminAnnouncements();
  assert.equal(all.total, announcementSeed.length);
  assert.deepEqual(all.counts, countAdminContentStates(announcementSeed));
  assert.deepEqual(
    all.counts,
    { all: announcementSeed.length, enabled: announcementSeed.length, disabled: 0, removed: 0 },
  );

  // 停用一条、移除一条：两个动作在角标上落在不同的格子里
  await setAdminAnnouncementEnabled(ANNOUNCEMENT_2, false, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  const created = await createAnnouncement({ title: "稍后移除" });
  await removeAdminAnnouncement(created.announcementId, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const after = await adminAnnouncements();
  assert.deepEqual(after.counts, {
    all: announcementSeed.length + 1,
    enabled: announcementSeed.length - 1,
    disabled: 1,
    removed: 1,
  });
  // 已移除的那条**不**计入 disabled：点「已停用」角标看到的是另一批记录
  assert.equal(after.counts.enabled + after.counts.disabled + after.counts.removed, after.counts.all);

  // 默认视图里停用还在、已移除不在——两者不是同一件事
  assert.equal(after.items.some((item) => item.id === ANNOUNCEMENT_2), true);
  assert.equal(after.items.some((item) => item.id === created.announcementId), false);
  assert.equal(after.items.some((item) => item.removed), false);

  // total 说的是「还在用的有多少条」，与 items.length 不是一回事
  assert.equal(after.total, announcementSeed.length);
  assert.equal(after.items.length, announcementSeed.length);

  const removed = await adminAnnouncements({ removal: "removed" });
  assert.deepEqual(
    removed.items.map((item) => item.id),
    [created.announcementId],
  );
  assert.equal(removed.total, announcementSeed.length, "切到「已移除」不该改变「还在用的」这个数");
  assert.deepEqual(removed.counts, after.counts, "角标口径与筛选无关");
  assertSorted(removed.items);
});

test("列表是 sortOrder → id 的全序：排序值相同时也不会「刷新一下换个位置」", async () => {
  const first = await createAnnouncement({ title: "同序甲", sortOrder: 1 });
  const second = await createAnnouncement({ title: "同序乙", sortOrder: 1 });

  const list = await adminAnnouncements();
  assertSorted(list.items);

  const same = list.items.filter((item) =>
    [first.announcementId, second.announcementId].includes(item.id),
  );
  assert.equal(same.length, 2);
  assert.deepEqual(
    same.map((item) => item.id),
    [first.announcementId, second.announcementId].sort(),
    "排序值相同时必须按 id 升序——否则首页会出现没人改过任何东西的位移",
  );
});

test("非法筛选值：接口 400（严格），页面收敛到默认值（宽松）", async () => {
  // 接口调用的 strict 模式：静默当成「只看使用中」会让调用方拿着一个
  // 自己不知道筛了什么的结果继续往下用
  expectApiErrorNow(
    () => resolveAdminContentListQuery(params({ removal: "gone" }), true),
    "BAD_REQUEST",
    ADMIN_CONTENT_REMOVAL_INVALID_MESSAGE,
  );

  // 页面用的宽松模式：地址栏被手改坏了，收敛到默认筛选而不是整页报错
  assert.equal(resolveAdminContentListQuery(params({ removal: "gone" }), false).removal, "active");
  assert.equal(resolveAdminContentListQuery(params(), false).removal, "active");
  assert.equal(resolveAdminContentListQuery(params({ removal: "removed" }), true).removal, "removed");
  assert.equal(resolveContentRemovalFilter("removed"), "removed");
  // 公告与活动图的列表条件只有一份实现，Banner 服务只是把它再导出了一次
  assert.equal(resolveAdminBannerListQuery, resolveAdminContentListQuery);
});

// ——————————————————————————————— 字段规则 ———————————————————————————————

test("字段规则：名称必填 / 超长、图片必须是站内图片、说明必填、排序必须是区间内的整数", async () => {
  const cases = [
    [{ title: "   " }, CONTENT_TITLE_EMPTY_MESSAGE],
    [{ title: "名".repeat(CONTENT_TITLE_MAX_LENGTH + 1) }, CONTENT_TITLE_TOO_LONG_MESSAGE],
    [{ imageUrl: "" }, CONTENT_IMAGE_URL_EMPTY_MESSAGE],
    // 站内但不是图片：填进去用户端只会渲染出一个碎图
    [{ imageUrl: "/join" }, CONTENT_IMAGE_URL_INVALID_MESSAGE],
    [{ imageUrl: "https://evil.example/x.png" }, CONTENT_IMAGE_URL_INVALID_MESSAGE],
    [{ imageUrl: "javascript:alert(1)" }, CONTENT_IMAGE_URL_INVALID_MESSAGE],
    [{ imageUrl: "//evil.example/x.png" }, CONTENT_IMAGE_URL_INVALID_MESSAGE],
    [{ alt: "  " }, CONTENT_ALT_EMPTY_MESSAGE],
    [{ sortOrder: Number.NaN }, CONTENT_SORT_ORDER_INVALID_MESSAGE],
    [{ sortOrder: -1 }, CONTENT_SORT_ORDER_INVALID_MESSAGE],
    [{ sortOrder: 10000 }, CONTENT_SORT_ORDER_INVALID_MESSAGE],
    [{ sortOrder: 1.5 }, CONTENT_SORT_ORDER_INVALID_MESSAGE],
  ];

  for (const [overrides, message] of cases) {
    await expectApiError(
      createAnnouncement(overrides, uniqueKey()),
      "BAD_REQUEST",
      message,
    );
  }

  // 排序整个没传（缺省 NaN）也要报错，而不是当成 0
  await expectApiError(
    createAdminAnnouncement(ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      title: "没有排序",
      imageUrl: "/mock/announcement-1.svg",
      alt: "素材图片占位",
      enabled: true,
    }),
    "BAD_REQUEST",
    CONTENT_SORT_ORDER_INVALID_MESSAGE,
  );

  // 校验顺序即字段顺序：报的是**第一条**错误（最靠上的那一栏）
  await expectApiError(
    createAnnouncement({ title: "", imageUrl: "https://evil.example/x.png" }, uniqueKey()),
    "BAD_REQUEST",
    CONTENT_TITLE_EMPTY_MESSAGE,
  );

  // 全部被拒之后什么都没写
  assert.equal((await announcementRecords()).length, announcementSeed.length);
  assert.equal((await announcementAudits()).length, 0);

  // 边界值本身合法：名称正好 40 字、排序 0 与上限
  const created = await createAnnouncement({
    title: "名".repeat(CONTENT_TITLE_MAX_LENGTH),
    sortOrder: 0,
  });
  assert.equal(created.changed, true);
  const detail = await getAdminAnnouncementDetail(created.announcementId, undefined, "server");
  assert.equal(detail.sortOrder, 0);
  assert.equal(detail.title.length, CONTENT_TITLE_MAX_LENGTH);
});

test("DTO 最小化：响应里没有 removedAt 原文、没有审计记录、没有内部状态描述", async () => {
  const created = await createAnnouncement({ title: "DTO 用公告" });
  const record = await getContentRepository().findAnnouncementById(created.announcementId);
  assert.equal(record.removedAt, null, "刚建的记录 removedAt 是 null（实体里有这个字段）");

  const list = await adminAnnouncements();
  const row = list.items.find((item) => item.id === created.announcementId);
  assert.ok(row);
  assert.equal("removedAt" in row, false, "已移除的时间戳是审计要回答的问题，不该进列表 DTO");
  assert.equal(typeof row.removed, "boolean");
  assert.equal(JSON.stringify(list).includes("removedAt"), false);
  assert.equal(JSON.stringify(list).includes("aud_"), false, "响应里混进了审计记录");

  const detail = await getAdminAnnouncementDetail(created.announcementId, undefined, "server");
  assert.deepEqual(
    Object.keys(detail).sort(),
    ["alt", "createdAt", "enabled", "id", "imageUrl", "removed", "sortOrder", "title", "updatedAt"],
    "管理端 DTO 的字段多一个少一个都要在这里说清楚",
  );

  // 写操作的结果同样只说「现在是什么状态」
  const result = await setAdminAnnouncementEnabled(created.announcementId, false, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
  });
  assert.deepEqual(
    Object.keys(result).sort(),
    ["announcementId", "changed", "enabled", "removed", "replayed", "updated"],
    "写结果的字段集变了——它只说「现在是什么状态」，动作名去审计里读",
  );
  // 跟着的那条记录走的是同一个 DTO：字段集与列表里那一行逐字相同
  assert.deepEqual(Object.keys(result.updated).sort(), Object.keys(row).sort());
  assert.equal(result.updated.id, created.announcementId);
  assert.equal(result.updated.enabled, false, "写结果里那条记录没有反映这次停用");
  assert.equal(JSON.stringify(result).includes("removedAt"), false);
  assert.equal(JSON.stringify(result).includes("aud_"), false);
});

test("客户端伪造的服务端字段一律无效：id / removedAt / createdAt / role / actorId 都没有入口", async () => {
  const result = await createAdminAnnouncement(ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({ title: "伪造测试" }),
    // 下面这些在服务层**没有读取的位置**，不是「校验后被忽略」
    id: ANNOUNCEMENT_1,
    removedAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    actorId: "admin-99",
    actorRole: "customer_service",
    actorName: "伪造的客服",
    role: "admin",
  });

  assert.notEqual(result.announcementId, ANNOUNCEMENT_1, "id 由服务端在原子区段里生成");
  assert.match(result.announcementId, /^an_/);
  assert.equal(result.removed, false);

  const detail = await getAdminAnnouncementDetail(result.announcementId, undefined, "server");
  assert.notEqual(detail.createdAt, "2020-01-01T00:00:00.000Z");
  assert.notEqual(detail.updatedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(detail.removed, false);

  // 身份只来自 `requireAdmin()` 的会话：请求体里的 actor 字段一个都没生效
  const audits = await announcementAudits(result.announcementId);
  assert.equal(audits.length, 1, "伪造的 actor 字段多写了一条审计");
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].actorName, null, "管理员侧的名称快照本阶段一律 null");

  // 预置的那条公告没有被覆盖
  const untouched = await getAdminAnnouncementDetail(ANNOUNCEMENT_1, undefined, "server");
  assert.equal(untouched.title, "首页公告位 - 开工活动");

  // 编辑时塞服务端字段同样无效：改不动 id、改动不了移除状态
  await updateAdminAnnouncement(ANNOUNCEMENT_2, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({ title: "试图改服务端字段" }),
    id: ANNOUNCEMENT_1,
    createdAt: "1999-01-01T00:00:00.000Z",
    updatedAt: "1999-01-01T00:00:00.000Z",
    removedAt: "1999-01-01T00:00:00.000Z",
  });

  const edited = await getAdminAnnouncementDetail(ANNOUNCEMENT_2, undefined, "server");
  assert.equal(edited.id, ANNOUNCEMENT_2);
  assert.equal(edited.title, "试图改服务端字段", "该生效的字段反而没生效");
  assert.equal(edited.removed, false, "客户端凭请求体把记录标记成了已移除");
  assert.equal(edited.createdAt, announcementSeed[1].createdAt);
  assert.notEqual(edited.updatedAt, "1999-01-01T00:00:00.000Z");
});

// ————————————————————————— 活动 Banner —————————————————————————

test("Banner 新建：落库、审计 banner.create，id 用后台前缀", async () => {
  const before = (await bannerRecords()).length;

  const result = await createBanner({ title: "活动图乙", sortOrder: 20 });

  assert.equal(result.changed, true);
  assert.match(result.bannerId, /^bn_/);
  assert.equal((await bannerRecords()).length, before + 1);

  const detail = await getAdminBannerDetail(result.bannerId, undefined, "server");
  assert.equal(detail.title, "活动图乙");
  assert.equal(detail.enabled, true);
  assert.equal(detail.removed, false);
  assert.equal(detail.createdAt, detail.updatedAt);

  const audits = await bannerAudits(result.bannerId);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "banner.create");
  assert.equal(audits[0].before, null);
  assert.equal(audits[0].after.title, "活动图乙");
  assert.equal(audits[0].actorId, ADMIN_ID);
});

test("Banner 编辑 / 启停 / 移除：四条链路各写各的审计动作，且都能挡回已移除的记录", async () => {
  const created = await createBanner({ title: "活动图链路", sortOrder: 30 });
  const id = created.bannerId;

  // 编辑
  const edited = await updateAdminBanner(id, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: "活动图链路（改）",
      imageUrl: "/mock/announcement-2.svg",
      sortOrder: 3,
    }),
  });
  assert.equal(edited.changed, true);

  // 停用 / 启用走的是窄写入，动作名与编辑分开
  const disabled = await setAdminBannerEnabled(id, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(disabled.enabled, false);
  const enabled = await setAdminBannerEnabled(id, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(enabled.enabled, true, "启用之后那张活动图仍然是停用的");

  // 重复启停不写第二条审计
  const again = await setAdminBannerEnabled(id, true, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(again.changed, false);

  // 移除
  const removed = await removeAdminBanner(id, ADMIN_ID, { idempotencyKey: uniqueKey() });
  assert.equal(removed.removed, true);
  assert.deepEqual(
    (await bannerAudits(id)).map((entry) => entry.action),
    ["banner.create", "banner.update", "banner.disable", "banner.enable", "banner.remove"],
  );

  // 已移除之后：不能编辑、不能启停，但详情照常打得开
  await expectApiError(
    updateAdminBanner(id, ADMIN_ID, { idempotencyKey: uniqueKey(), ...imageInput() }),
    "BAD_REQUEST",
    ADMIN_BANNER_REMOVED_MESSAGE,
  );
  await expectApiError(
    setAdminBannerEnabled(id, false, ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "BAD_REQUEST",
    ADMIN_BANNER_REMOVED_MESSAGE,
  );
  const detail = await getAdminBannerDetail(id, undefined, "server");
  assert.equal(detail.removed, true);
  assert.equal(detail.title, "活动图链路（改）");

  // 不存在的活动图
  assert.equal(await getAdminBannerDetail("b-nope", undefined, "server"), null);
  await expectApiError(
    removeAdminBanner("b-nope", ADMIN_ID, { idempotencyKey: uniqueKey() }),
    "NOT_FOUND",
    ADMIN_BANNER_NOT_FOUND_MESSAGE,
  );
});

test("Banner 列表：筛选与角标口径与公告一致，排序即用户端的挑选顺序", async () => {
  const created = await createBanner({ title: "备用素材", sortOrder: 30 });
  await setAdminBannerEnabled(created.bannerId, false, ADMIN_ID, { idempotencyKey: uniqueKey() });

  const list = await adminBanners();
  assert.equal(list.total, bannerSeed.length + 1, "停用不是移除，它仍然是一条还在用的记录");
  assert.deepEqual(list.counts, {
    all: bannerSeed.length + 1,
    enabled: bannerSeed.length,
    disabled: 1,
    removed: 0,
  });
  assertSorted(list.items);

  await removeAdminBanner(created.bannerId, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const afterRemove = await adminBanners();
  assert.equal(afterRemove.total, bannerSeed.length);
  assert.equal(afterRemove.items.length, bannerSeed.length);
  assert.equal(afterRemove.counts.removed, 1);

  const removed = await adminBanners({ removal: "removed" });
  assert.deepEqual(
    removed.items.map((item) => item.id),
    [created.bannerId],
  );

  // Banner 的 DTO 与公告同形，同样不含 removedAt
  assert.equal(JSON.stringify(afterRemove).includes("removedAt"), false);
});

test("后台改了排序或启用状态之后，用户端首页的活动图就是新的那一张", async () => {
  // ① 预置：首页活动位上是 b1
  const initial = await home();
  assert.equal(initial.activityImageUrl, "/mock/promo-activity.svg");
  assert.equal(selectActivityImageUrl(await bannerRecords()), "/mock/promo-activity.svg");
  assert.equal(bannerSeed.length, 1, "预置只有一张，否则「回落到下一张」证明不了什么");

  // ② 新建第二张（排序在后面）：用户端**不动**——提前备好的素材不该一建出来就顶掉正在投的那张
  const backup = await createBanner({
    title: "备用活动图",
    imageUrl: "/mock/announcement-2.svg",
    sortOrder: 30,
  });
  assert.equal((await home()).activityImageUrl, "/mock/promo-activity.svg");

  // ③ 把它排到最前：两张都启用，用户端换成排序更前的那张
  await updateAdminBanner(backup.bannerId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: "备用活动图",
      imageUrl: "/mock/announcement-2.svg",
      sortOrder: 5,
    }),
  });
  const switched = await home();
  assert.equal(
    switched.activityImageUrl,
    "/mock/announcement-2.svg",
    "后台把另一张排到了最前，用户端却还是旧的那张",
  );
  assert.equal(selectActivityImageUrl(await bannerRecords()), "/mock/announcement-2.svg");

  // ④ 把它排回去：用户端回到 b1
  await updateAdminBanner(backup.bannerId, ADMIN_ID, {
    idempotencyKey: uniqueKey(),
    ...imageInput({
      title: "备用活动图",
      imageUrl: "/mock/announcement-2.svg",
      sortOrder: 30,
    }),
  });
  assert.equal((await home()).activityImageUrl, "/mock/promo-activity.svg");

  // ⑤ 停用当前生效的那张：自动回落到下一张启用中的，而不是变成空白
  await setAdminBannerEnabled(BANNER_1, false, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const fallback = await home();
  assert.equal(fallback.activityImageUrl, "/mock/announcement-2.svg");

  // ⑥ 停用（再移除）剩下那张：一张都不剩时是空串，首页据此隐藏活动位
  await removeAdminBanner(backup.bannerId, ADMIN_ID, { idempotencyKey: uniqueKey() });
  const empty = await home();
  assert.equal(
    empty.activityImageUrl,
    "",
    "一张都没有时必须是空串：返回占位图会让「后台一张都没配」看起来像配好了",
  );
});

test("Banner 的幂等与幂等键冲突与公告同形", async () => {
  const key = uniqueKey();
  const first = await createBanner({ title: "Banner 幂等" }, key);
  const countAfterFirst = (await bannerRecords()).length;

  const second = await createBanner({ title: "Banner 幂等（重放）" }, key);
  assert.equal(second.bannerId, first.bannerId);
  assert.equal(second.changed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.updated, first.updated, "重放没有返回第一次的那条记录");
  assert.equal((await bannerRecords()).length, countAfterFirst);
  assert.equal((await bannerAudits()).length, 1);

  await expectApiError(
    updateAdminBanner(BANNER_1, ADMIN_ID, { idempotencyKey: key, ...imageInput() }),
    "BAD_REQUEST",
    ADMIN_CONTENT_OPERATION_CONFLICT_MESSAGE,
  );
  await expectApiError(
    createAdminBanner(ADMIN_ID, { ...imageInput({ title: "没有键" }) }),
    "BAD_REQUEST",
    ADMIN_CONTENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  );
});

test("Banner 的字段规则与公告同源：图片地址同样只能是站内图片", async () => {
  for (const imageUrl of ["https://evil.example/x.png", "/join", "javascript:alert(1)"]) {
    await expectApiError(
      createBanner({ imageUrl }, uniqueKey()),
      "BAD_REQUEST",
      CONTENT_IMAGE_URL_INVALID_MESSAGE,
    );
  }
  await expectApiError(
    createBanner({ title: "" }, uniqueKey()),
    "BAD_REQUEST",
    CONTENT_TITLE_EMPTY_MESSAGE,
  );

  assert.equal((await bannerRecords()).length, bannerSeed.length);
  assert.equal((await bannerAudits()).length, 0);
});

// ————————————————————— 接口层：权限排在业务之前 —————————————————————
//
// 权限矩阵（匿名 401、客服 / 护航 / 停用管理员 403）需要真实服务，见
// `tests/adminCategories.test.mjs` 里那份走 `APP_BASE_URL` 的同形用例。
// 下面这组断言**不需要起服务**，因此永远不会被跳过：它盯的是「每个 handler 的
// 第一件事就是 requireAdmin()」这条结构性质——漏掉一处，就是给某个接口开了后门。

/** 去掉注释后再断言：文档注释里说明「本文件不做某件事」不算做了那件事。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 每个接口文件里**应当**有的方法。多一个少一个都要在这里说清楚。 */
const CONTENT_ROUTES = {
  "announcements/route.ts": ["GET", "POST"],
  "announcements/[id]/route.ts": ["GET", "PATCH"],
  "announcements/[id]/enable/route.ts": ["POST"],
  "announcements/[id]/disable/route.ts": ["POST"],
  "announcements/[id]/remove/route.ts": ["POST"],
  "banners/route.ts": ["GET", "POST"],
  "banners/[id]/route.ts": ["GET", "PATCH"],
  "banners/[id]/enable/route.ts": ["POST"],
  "banners/[id]/disable/route.ts": ["POST"],
  "banners/[id]/remove/route.ts": ["POST"],
};

test("接口清单齐全，且每个 handler 的第一件事都是 requireAdmin()", () => {
  const collected = [];

  for (const [relative, methods] of Object.entries(CONTENT_ROUTES)) {
    const file = path.join(CONTENT_API_DIR, ...relative.split("/"));
    assert.equal(existsSync(file), true, `缺少接口文件：app/api/admin/content/${relative}`);

    const code = stripComments(readFileSync(file, "utf8"));
    // handler 的切分：每个 `export async function` 之后到下一个之前是一段
    const handlers = code.split(/export async function /).slice(1);
    assert.deepEqual(
      handlers.map((handler) => handler.slice(0, handler.indexOf("(")).trim()),
      methods,
      `${relative} 暴露的方法与预期不一致`,
    );

    for (const handler of handlers) {
      const firstAwait = handler.indexOf("await ");
      assert.equal(
        handler.slice(firstAwait, firstAwait + "await requireAdmin()".length),
        "await requireAdmin()",
        `${relative} 的第一个 await 不是 requireAdmin()：权限没有排在业务之前`,
      );
      // 解析入参必须发生在鉴权之后——否则被拒身份也能触发校验逻辑
      const body = handler.indexOf("readJsonBody(");
      if (body > -1) {
        assert.ok(
          handler.indexOf("await requireAdmin()") < body,
          `${relative} 先读了请求体再鉴权`,
        );
      }
    }

    collected.push(relative);
    // 角色判断只有 `lib/api/adminRoute.ts` 一处，接口层不得自己判
    assert.equal(
      /role\s*===\s*["']admin["']/.test(code),
      false,
      `${relative} 自己判断了角色，应当调用 requireAdmin()`,
    );
  }

  assert.equal(collected.length, 10, "公告与活动图各有 5 个接口文件");
});

// ——————————————— 写结果的字段集：审计字段不出现在响应里 ———————————————

/**
 * 写结果的字段集是**封死的**，多一个都不行。
 *
 * ⚠️ 这一条在 P8E-1 集成阶段才加，原因是三组内容（公告 / 活动图 / 快捷入口）
 * 由三个模块分别实现，其中两组的写结果一度多带一个 `action`（那一次变更的名字：
 * `announcement.create` / `banner.disable` …）。它读起来无害，但它**是审计的内容**：
 * 「这次到底记成了哪一条」的唯一权威是审计记录本身，把它放进响应等于让界面有机会
 * 照着响应复述一个自己没验证过的说法；而同一个编辑接口既可能记成 `update`、
 * 也可能记成 `enable`，客户端拿它做分支就是在复刻服务端的判定逻辑。
 *
 * 现在三个域口径一致：写结果只说**结果**（`changed` / `replayed` + 状态字段
 * + 服务端确认后的那条记录），动作名一律去审计里读。
 *
 * 顺带钉住 `removedAt`：它与列表项 DTO 同口径——软删除的**时间**是审计要回答的问题，
 * 响应里只有 `removed: boolean`。
 */
test("写结果不带审计字段：没有 action，也没有 removedAt", async () => {
  const created = await createAnnouncement({ title: "字段集用例" });
  const createdBanner = await createBanner({ title: "字段集用例 - 活动图" });

  const results = [
    ["公告新建", created],
    ["活动图新建", createdBanner],
    ["公告编辑", await updateAdminAnnouncement(ANNOUNCEMENT_1, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
      ...imageInput({ title: "字段集用例 - 编辑" }),
    })],
    ["公告启停", await setAdminAnnouncementEnabled(ANNOUNCEMENT_2, false, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
    })],
    ["公告移除", await removeAdminAnnouncement(created.announcementId, ADMIN_ID, {
      idempotencyKey: uniqueKey(),
    })],
  ];

  for (const [label, result] of results) {
    assert.equal("action" in result, false, `${label}：写结果里出现了审计字段 action`);
    assert.equal("removedAt" in result, false, `${label}：写结果里出现了内部时间戳 removedAt`);
    assert.equal(typeof result.changed, "boolean", `${label}：缺少 changed`);
    assert.equal(typeof result.replayed, "boolean", `${label}：缺少 replayed`);
    // 服务端确认后的那条记录是列表项 DTO，同样没有内部字段
    assert.equal("removedAt" in result.updated, false, `${label}：updated 里出现了 removedAt`);
    assert.equal(typeof result.updated.removed, "boolean", `${label}：updated 缺少 removed`);
  }

  // 反过来：动作名并没有丢，它只是搬到了它该在的地方——审计记录
  assert.deepEqual(
    (await announcementAudits(created.announcementId)).map((entry) => entry.action),
    ["announcement.create", "announcement.remove"],
  );
  assert.deepEqual(
    (await bannerAudits(createdBanner.bannerId)).map((entry) => entry.action),
    ["banner.create"],
  );
});
