import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  createAnnouncement,
  removeAnnouncement,
  setAnnouncementEnabled,
  setQuickEntryEnabled,
  updateAnnouncement,
  updateBanner,
  updateQuickEntry,
} from "../lib/data/adminContentTransaction.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getHomeData } from "../lib/services/home.ts";

/**
 * **接线测试**：后台配置是否真的驱动用户端首页内容（P8E-1 §一 的核心要求）。
 *
 * 这是本阶段唯一一条不验证「某个函数算得对」、而验证**整条链**的测试：
 *
 *     管理后台改记录 ─→ 仓储（同一份 Map） ─→ mockSource ─→ getHomeData ─→ 用户端首页
 *
 * ⚠️ 为什么必须单独有一条。P8E-1 最容易出现的失败**不是某个函数写错**，而是
 * 后台有能力改、用户端却还在读另一份写死的静态数据——界面上两边都「正常」，
 * 管理员改完保存成功、用户端刷新纹丝不动。而**没有任何一条单元测试会红**：
 * 事务层测过、纯函数测过、DTO 测过，每一块都对，拼起来是错的。
 *
 * 因此这条测试刻意**只经由 `getHomeData()` 这一个用户端入口读**，
 * 不直接调 `selectPublicAnnouncements()` 之类的纯函数——那些已经被别的用例覆盖了，
 * 在这里再调一次只会让「接缝断了」这件事继续藏在中间层后面。
 *
 * ⚠️ 另一条刻意之处：断言用的是**内容本身**（图片地址、文案、顺序），
 * 不是「长度变了」。长度断言在「替换」与「新增」之间区分不出来，
 * 而「后台换了一张公告图，用户端刷新还是旧的」正是要挡的那个 bug。
 * 历史上有过同类教训：只断言条数的用例，在数据被整份换掉时一样全绿。
 */

const ADMIN = "admin-1";

function ctx(operationId = crypto.randomUUID(), at = new Date().toISOString()) {
  return { actorId: ADMIN, actorRole: "admin", actorName: null, operationId, at };
}

/** 用户端首页看到的东西。每次调用都是一次「用户刷新」。 */
function home() {
  return getHomeData(undefined, "server");
}

/** 首页某个快捷入口。 */
function shortcutOf(data, id) {
  return data.shortcuts.find((shortcut) => shortcut.id === id) ?? null;
}

beforeEach(() => {
  resetMockStore("content");
  resetMockStore("adminAudit");
});

// ——————————————————————————— 公告 ———————————————————————————

test("后台改公告图片地址之后，用户端首页下一次取数就是新地址", async () => {
  const before = await home();
  assert.equal(before.announcements.length, 2, "预置公告应当是两条");

  const target = before.announcements[0];
  assert.equal(target.imageUrl, "/mock/announcement-1.svg");

  const outcome = await updateAnnouncement(
    target.id,
    {
      title: "首页公告位 - 换图",
      imageUrl: "/mock/announcement-2.svg",
      alt: "换过的公告图",
      sortOrder: 10,
      enabled: true,
    },
    ctx(),
  );
  assert.equal(outcome.kind, "ok");
  assert.equal(outcome.changed, true);

  // —— 用户刷新 ——
  const after = await home();
  const updated = after.announcements.find((item) => item.id === target.id);
  assert.ok(updated, "改完之后用户端看不到这条公告了");
  assert.equal(updated.imageUrl, "/mock/announcement-2.svg", "用户端还显示着旧图片地址");
  assert.equal(updated.alt, "换过的公告图");
});

test("后台停用一条公告之后，用户端首页立刻少一条；重新启用后回来", async () => {
  const before = await home();
  const target = before.announcements[0];

  await setAnnouncementEnabled(target.id, false, ctx());
  const disabled = await home();
  assert.equal(
    disabled.announcements.some((item) => item.id === target.id),
    false,
    "停用的公告仍然出现在用户端首页",
  );
  assert.equal(disabled.announcements.length, before.announcements.length - 1);

  await setAnnouncementEnabled(target.id, true, ctx());
  const reenabled = await home();
  assert.equal(
    reenabled.announcements.some((item) => item.id === target.id),
    true,
    "重新启用之后公告没有回到用户端",
  );
  assert.equal(reenabled.announcements.length, before.announcements.length);
});

test("后台新建一条公告并排到最前：用户端首页第一条就是它", async () => {
  const outcome = await createAnnouncement(
    {
      title: "首页公告位 - 新建到最前",
      imageUrl: "/mock/announcement-1.svg",
      alt: "新建的公告图",
      sortOrder: 1,
      enabled: true,
    },
    ctx(),
  );
  assert.equal(outcome.kind, "ok");

  const after = await home();
  assert.equal(after.announcements.length, 3);
  assert.equal(
    after.announcements[0].id,
    outcome.value.updated.id,
    "新建的公告没有排到最前（sortOrder 更小却排在后面）",
  );
  assert.equal(after.announcements[0].alt, "新建的公告图");
});

test("后台移除公告之后，用户端首页不再有它，但记录仍在仓储里", async () => {
  const before = await home();
  const target = before.announcements[0];

  await removeAnnouncement(target.id, ctx());

  const after = await home();
  assert.equal(
    after.announcements.some((item) => item.id === target.id),
    false,
    "已移除的公告仍然出现在用户端首页",
  );

  // 记录还在：移除是软删除，事后要能回答「当时首页上那张图是什么」
  const { getContentRepository } = await import("../lib/data/contentRepository.ts");
  const stored = await getContentRepository().findAnnouncementById(target.id);
  assert.ok(stored, "移除把记录删掉了——移除必须是软删除");
  assert.notEqual(stored.removedAt, null);
});

test("用户端拿到的公告 DTO 不带后台字段：title / enabled / sortOrder / removedAt 一个都没有", async () => {
  const data = await home();
  assert.ok(data.announcements.length > 0);

  for (const item of data.announcements) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["alt", "id", "imageUrl"],
      "公告 DTO 里出现了后台字段——「哪些用户端看得到」会因此变成前端自己的判断",
    );
  }
});

// ——————————————————————————— 活动 Banner ———————————————————————————

test("后台把另一张 Banner 的排序调到前面并启用，用户端首页就换成那一张", async () => {
  const before = await home();
  assert.equal(before.activityImageUrl, "/mock/promo-activity.svg");

  // 运营备好第二张素材
  const second = await createBannerStub();
  assert.equal(second.kind, "ok");

  // 此刻第二张排在后面，用户端还是第一张
  const stillFirst = await home();
  assert.equal(
    stillFirst.activityImageUrl,
    "/mock/promo-activity.svg",
    "排序靠后的 Banner 不该抢到首页的展示位",
  );

  // 运营把它调到最前
  const reordered = await updateBanner(
    second.value.updated.id,
    {
      title: "首页活动位 - 新客首单（提权）",
      imageUrl: "/mock/announcement-1.svg",
      alt: "被提到最前的活动图",
      sortOrder: 1,
      enabled: true,
    },
    ctx(),
  );
  assert.equal(reordered.kind, "ok");

  const after = await home();
  assert.equal(
    after.activityImageUrl,
    "/mock/announcement-1.svg",
    "后台改了排序，用户端首页还是旧的那张活动图",
  );
});

test("后台停用当前 Banner 之后，用户端首页的活动位变成空——隐藏而不是留一张旧图", async () => {
  const before = await home();
  assert.notEqual(before.activityImageUrl, "");

  const { getContentRepository } = await import("../lib/data/contentRepository.ts");
  const [current] = await getContentRepository().listBannerRecords();

  await updateBanner(
    current.id,
    {
      title: current.title,
      imageUrl: current.imageUrl,
      alt: current.alt,
      sortOrder: current.sortOrder,
      enabled: false,
    },
    ctx(),
  );

  const after = await home();
  assert.equal(
    after.activityImageUrl,
    "",
    "没有启用的 Banner 时，用户端应当拿到空串（首页据此隐藏活动位），而不是旧地址或占位图",
  );
});

test("活动图始终是**一个字符串**，不是数组——用户端首页不是轮播", async () => {
  const data = await home();
  assert.equal(
    typeof data.activityImageUrl,
    "string",
    "activityImageUrl 被改成了数组：后台能管多张素材，不等于用户端要变成轮播",
  );
  assert.equal(Array.isArray(data.activityImageUrl), false);
});

// ——————————————————————————— 快捷入口 ———————————————————————————

test("后台改入口的文案与地址之后，用户端首页下一次取数就是新的", async () => {
  const before = await home();
  const join = shortcutOf(before, "join");
  assert.ok(join, "缺少考核入驻入口");
  assert.equal(join.label, "考核入驻");
  assert.equal(join.href, "/join");

  const outcome = await updateQuickEntry(
    join.id,
    { label: "护航入驻", icon: "join", path: "/companions", sortOrder: 30, enabled: true },
    ctx(),
  );
  assert.equal(outcome.kind, "ok");

  const after = await home();
  const updated = shortcutOf(after, "join");
  assert.ok(updated);
  assert.equal(updated.label, "护航入驻", "用户端还显示着旧文案");
  assert.equal(updated.href, "/companions", "用户端还指向着旧地址");
});

test("后台停用快捷入口之后，用户端四宫格少一格；重新启用后回来", async () => {
  const before = await home();
  assert.equal(before.shortcuts.length, 4);

  await setQuickEntryEnabled("complaint", false, ctx());
  const disabled = await home();
  assert.equal(disabled.shortcuts.length, 3, "停用的入口仍然出现在用户端");
  assert.equal(shortcutOf(disabled, "complaint"), null);

  await setQuickEntryEnabled("complaint", true, ctx());
  const reenabled = await home();
  assert.equal(reenabled.shortcuts.length, 4);
  assert.equal(shortcutOf(reenabled, "complaint").label, "投诉客服专区");
});

test("用户端快捷入口的顺序由 sortOrder 决定，后台改排序即改首页顺序", async () => {
  const before = await home();
  assert.deepEqual(
    before.shortcuts.map((shortcut) => shortcut.id),
    ["service", "benefits", "join", "complaint"],
  );

  // 把「投诉客服专区」调到最前
  await updateQuickEntry(
    "complaint",
    { label: "投诉客服专区", icon: "complaint", path: "/complaints", sortOrder: 1, enabled: true },
    ctx(),
  );

  const after = await home();
  assert.deepEqual(
    after.shortcuts.map((shortcut) => shortcut.id),
    ["complaint", "service", "benefits", "join"],
    "后台改了排序，用户端首页顺序没变",
  );
});

test("用户端快捷入口 DTO 是 href 不是 path，且带 icon", async () => {
  const data = await home();
  assert.ok(data.shortcuts.length > 0);

  for (const shortcut of data.shortcuts) {
    assert.deepEqual(
      Object.keys(shortcut).sort(),
      ["href", "icon", "id", "label"],
      "快捷入口 DTO 的字段集变了——用户端渲染的是 href，后台表单用的是 path，两者只能在一处转换",
    );
    assert.equal(typeof shortcut.icon, "string");
  }
});

test("所有预置入口的 href 都是站内路径：用户端不可能拿到协议相对地址或脚本协议", async () => {
  const data = await home();

  for (const shortcut of data.shortcuts) {
    assert.equal(shortcut.href.startsWith("/"), true);
    assert.equal(shortcut.href.startsWith("//"), false, `${shortcut.href} 是协议相对地址`);
    assert.equal(
      shortcut.href.toLowerCase().startsWith("javascript:"),
      false,
      `${shortcut.href} 是脚本协议`,
    );
  }
});

// ——————————————————— 与商品分组互不干扰 ———————————————————

test("首页取数仍然把商品分组一并算出来：加内容不影响原有的 sections", async () => {
  const data = await home();

  assert.ok(data.sections.length > 0, "首页商品分组没了——内容改动破坏了原有的 sections 取数");
  for (const section of data.sections) {
    assert.ok(section.id);
    assert.ok(section.title);
    assert.ok(Array.isArray(section.products));
  }
});

/**
 * 建一张备用 Banner 的辅助函数。
 *
 * 用 `createBanner` 而不是 `createAnnouncement`——上面那条用例里需要的是
 * **活动位**的第二张素材。写成一个具名函数，是因为 `createAnnouncement, await`
 * 那种写法读起来像是一次错误；这里显式表达「我要建的是 Banner」。
 */
async function createBannerStub() {
  const { createBanner } = await import("../lib/data/adminContentTransaction.ts");
  return createBanner(
    {
      title: "首页活动位 - 备用素材",
      imageUrl: "/mock/announcement-1.svg",
      alt: "备用活动图",
      sortOrder: 50,
      enabled: true,
    },
    ctx(),
  );
}
