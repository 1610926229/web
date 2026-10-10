import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { updateAnnouncement } from "../lib/data/adminContentTransaction.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getHomeData } from "../lib/services/home.ts";

/**
 * 首页 `?mockEmpty` 的**既有验收语义**在 P8E-1 之后必须一字不变（§十三）。
 *
 * ⚠️ 为什么这条值得单独一个文件。首页的公告 / 活动图 / 快捷入口在 P8E-1 之前是
 * `mockSource` 里的一份静态数据，`applyMockEmpty()` 直接改那份对象就完事了；
 * 现在它们来自**仓储**，于是多了一条真实的失效路径：
 *
 * - 有人可能「顺手」把清空逻辑写进仓储（那会把**后台的数据**清掉，
 *   而不是只清这一次响应——调试参数绝不能写数据）；
 * - 有人可能让 `mockEmpty=1` 跟着一起清内容，因为「1 不就是全部吗」；
 * - 有人可能让 `mockEmpty=all` 漏掉新加的三组内容。
 *
 * 三条里任何一条都是**用户可见的验收行为变化**，而且都不会让别的测试变红。
 *
 * ⚠️ 尤其钉住 `mockEmpty=1`：它的含义在很早的版本里就固定为「只清商品分组」，
 * 首页的公告与入口保持原样——正是为了能单独看「有内容、没商品」这一种版面。
 * 把它改成「清全部」会让那个界面**再也造不出来**。
 */

function page(params) {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
}

beforeEach(() => {
  resetMockStore("content");
  resetMockStore("adminAudit");
  process.env.ENABLE_MOCK_DEBUG = "true";
});

test("?mockEmpty=1 只清商品分组：公告、活动图、快捷入口一个不少", async () => {
  const normal = await getHomeData(page({ mockDelay: 0 }), "server");
  assert.ok(normal.sections.length > 0, "预置数据里首页本来就没有商品分组");
  assert.ok(normal.announcements.length > 0);
  assert.notEqual(normal.activityImageUrl, "");
  assert.ok(normal.shortcuts.length > 0);

  const emptied = await getHomeData(page({ mockEmpty: 1, mockDelay: 0 }), "server");

  assert.deepEqual(emptied.sections, [], "mockEmpty=1 没有清掉商品分组");
  assert.deepEqual(
    emptied.announcements,
    normal.announcements,
    "mockEmpty=1 把公告一起清了——它的含义固定是「只清商品分组」",
  );
  assert.equal(
    emptied.activityImageUrl,
    normal.activityImageUrl,
    "mockEmpty=1 把活动图一起清了",
  );
  assert.deepEqual(emptied.shortcuts, normal.shortcuts, "mockEmpty=1 把快捷入口一起清了");
});

test("三个内容范围分别生效，且各自只清自己那一块", async () => {
  const normal = await getHomeData(page({ mockDelay: 0 }), "server");

  const noAnnouncements = await getHomeData(page({ mockEmpty: "announcements", mockDelay: 0 }), "server");
  assert.deepEqual(noAnnouncements.announcements, []);
  assert.equal(noAnnouncements.activityImageUrl, normal.activityImageUrl);
  assert.deepEqual(noAnnouncements.shortcuts, normal.shortcuts);
  assert.deepEqual(noAnnouncements.sections, normal.sections);

  const noActivity = await getHomeData(page({ mockEmpty: "activity", mockDelay: 0 }), "server");
  assert.equal(noActivity.activityImageUrl, "");
  assert.deepEqual(noActivity.announcements, normal.announcements);
  assert.deepEqual(noActivity.shortcuts, normal.shortcuts);

  const noShortcuts = await getHomeData(page({ mockEmpty: "shortcuts", mockDelay: 0 }), "server");
  assert.deepEqual(noShortcuts.shortcuts, []);
  assert.deepEqual(noShortcuts.announcements, normal.announcements);
  assert.equal(noShortcuts.activityImageUrl, normal.activityImageUrl);
});

test("?mockEmpty=all 清全部四块：内容与商品一起为空，但结构完整", async () => {
  const all = await getHomeData(page({ mockEmpty: "all", mockDelay: 0 }), "server");

  assert.deepEqual(all.announcements, []);
  assert.equal(all.activityImageUrl, "");
  assert.deepEqual(all.shortcuts, []);
  assert.deepEqual(all.sections, []);

  // 空数据**不是错误**：四个键都在，形状不变，页面据此渲染各自的局部空态
  assert.deepEqual(
    Object.keys(all).sort(),
    ["activityImageUrl", "announcements", "sections", "shortcuts"],
  );
});

test("清空只影响这一次响应，绝不动后台的数据", async () => {
  const { getContentRepository } = await import("../lib/data/contentRepository.ts");
  const before = await getContentRepository().listAnnouncementRecords();

  await getHomeData(page({ mockEmpty: "all", mockDelay: 0 }), "server");
  await getHomeData(page({ mockEmpty: "announcements", mockDelay: 0 }), "server");

  const after = await getContentRepository().listAnnouncementRecords();
  assert.deepEqual(
    after,
    before,
    "调试参数把仓储里的记录清掉了——?mockEmpty 只能改这一次响应的形状，不能写数据",
  );

  // 清空之后紧接着的正常请求必须完好如初
  const normal = await getHomeData(page({ mockDelay: 0 }), "server");
  assert.deepEqual(normal.announcements.length, before.filter((r) => r.enabled && r.removedAt === null).length);
});

test("调试开关关闭时 mockEmpty 完全不生效", async () => {
  process.env.ENABLE_MOCK_DEBUG = "false";

  const normal = await getHomeData(page({ mockDelay: 0 }), "server");

  for (const scope of ["all", "announcements", "activity", "shortcuts", "sections", 1]) {
    const data = await getHomeData(page({ mockEmpty: scope, mockDelay: 0 }), "server");
    assert.deepEqual(
      data,
      normal,
      `开关关闭时 ?mockEmpty=${scope} 仍然改变了首页数据`,
    );
  }
});

test("后台改过的内容同样会被清空语义正确对待：清完再取，用户端看到的仍是改过的那份", async () => {
  const { getContentRepository } = await import("../lib/data/contentRepository.ts");
  const [target] = await getContentRepository().listAnnouncementRecords();

  await updateAnnouncement(
    target.id,
    {
      title: "被后台改过的公告",
      imageUrl: "/mock/announcement-2.svg",
      alt: "改过的公告图",
      sortOrder: target.sortOrder,
      enabled: true,
    },
    { actorId: "admin-1", actorRole: "admin", actorName: null, operationId: crypto.randomUUID(), at: new Date().toISOString() },
  );

  await getHomeData(page({ mockEmpty: "all", mockDelay: 0 }), "server");

  const after = await getHomeData(page({ mockDelay: 0 }), "server");
  const updated = after.announcements.find((item) => item.id === target.id);
  assert.ok(updated, "清空语义把后台改过的公告弄丢了");
  assert.equal(
    updated.imageUrl,
    "/mock/announcement-2.svg",
    "调试参数之后，用户端读到的不是后台改过的那份内容",
  );
});
