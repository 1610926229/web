import assert from "node:assert/strict";
import test from "node:test";
import {
  compareContentOrder,
  isContentVisible,
  selectActivityImageUrl,
  selectPublicAnnouncements,
  selectPublicShortcuts,
  toAdminQuickEntryList,
  toHomeShortcut,
} from "../lib/constants/homeContent.ts";

/**
 * P8E-1：**用户端挑选规则的独立测试**（纯函数）。
 *
 * 这个文件回答一个问题：**后台配的内容，用户端到底会看到什么**。
 * 它是「后台配置真正驱动用户端」这条要求的**读侧证明**——写侧的测试
 * （`tests/adminContentQuickEntries.test.mjs`）证明数据被正确写进仓储，
 * 这里证明同一份数据到了用户端会被正确地挑选、排序与收窄。
 *
 * 守四条边界，每一条都对应一种「只有对着屏幕才看得见」的故障：
 *
 * 1. **排序是全序**：`sortOrder` 相同再按 id 排，否则首页会出现「刷新一下顺序就变」；
 * 2. **用户端 DTO 是窄的**：公告没有标题、入口没有 `path`——后台的识别字段
 *    （`title`）绝不能漏到用户端，否则以后一定会有人把它渲染出来；
 * 3. **停用与已移除都不出场**，而两者是两件事（停用可逆、移除是终态）；
 * 4. **地址安全在用户端还有最后一道**：写入侧校验过的记录仍会再过一次
 *    `isSafePath()`，因为这一层守的是「`<Link href>` 里不出现 `javascript:`」。
 */

const SEEDED_AT = "2026-01-06T09:00:00.000Z";

/** 一条公告记录；用例按需覆盖。 */
function announcement(overrides = {}) {
  return {
    id: "a1",
    title: "后台辨认用的名称",
    imageUrl: "/mock/announcement-1.svg",
    alt: "公告图片占位 1",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
    ...overrides,
  };
}

/** 一条活动 Banner 记录。 */
function banner(overrides = {}) {
  return {
    id: "b1",
    title: "后台辨认用的名称",
    imageUrl: "/mock/promo-activity.svg",
    alt: "活动图片占位",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
    ...overrides,
  };
}

/** 一条快捷入口记录。注意字段叫 `path`（后台口径），用户端 DTO 里叫 `href`。 */
function quickEntry(overrides = {}) {
  return {
    id: "service",
    label: "联系客服",
    icon: "service",
    path: "/service",
    enabled: true,
    sortOrder: 10,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
    removedAt: null,
    ...overrides,
  };
}

// ————————————————————————— 排序：必须是全序 —————————————————————————

test("compareContentOrder：先比 sortOrder，升序", () => {
  const low = { id: "z", sortOrder: 10 };
  const high = { id: "a", sortOrder: 20 };

  assert.ok(compareContentOrder(low, high) < 0, "排序值小的排在前面");
  assert.ok(compareContentOrder(high, low) > 0);
  assert.equal(compareContentOrder(low, { id: "z", sortOrder: 10 }), 0);
});

test("compareContentOrder：sortOrder 相同时按 id 升序（独立用例）", () => {
  // 只比 sortOrder 的话，两条排序值相同的记录会以「容器遍历顺序」出现在首页，
  // 于是出现「什么都没改，刷新一下两个格子换了位置」——这一条就是为此存在的
  const a = { id: "announcement-a", sortOrder: 10 };
  const b = { id: "announcement-b", sortOrder: 10 };

  assert.ok(compareContentOrder(a, b) < 0, "id 小的排在前面");
  assert.ok(compareContentOrder(b, a) > 0);
  assert.equal(compareContentOrder(a, { id: "announcement-a", sortOrder: 10 }), 0);

  // 同一条记录与自己比必须相等，否则 sort 的行为取决于实现
  assert.equal(compareContentOrder(a, a), 0);
});

test("排序结果与输入顺序无关：同一个数组排两次结果一致", () => {
  const records = [
    announcement({ id: "a3", sortOrder: 30 }),
    announcement({ id: "a1", sortOrder: 10 }),
    announcement({ id: "a2", sortOrder: 10 }),
    announcement({ id: "a4", sortOrder: 20 }),
  ];

  const first = selectPublicAnnouncements(records).map((item) => item.id);
  const second = selectPublicAnnouncements(records).map((item) => item.id);

  // 相同 sortOrder（a1 / a2）由 id 兜底，因此顺序是确定的而不是「碰巧」
  assert.deepEqual(first, ["a1", "a2", "a4", "a3"]);
  assert.deepEqual(second, first, "同一个输入连排两次必须得到同一个顺序");

  // 把输入打乱再排，结果仍然一样：顺序只由记录本身决定
  const shuffled = [...records].reverse();
  assert.deepEqual(selectPublicAnnouncements(shuffled).map((item) => item.id), first);
});

// ————————————————————————— 公告 —————————————————————————

test("selectPublicAnnouncements：只留可见的，且 DTO 只有 {id,imageUrl,alt}", () => {
  const records = [
    announcement({ id: "a1", sortOrder: 10 }),
    // 停用：用户端不该看到
    announcement({ id: "a2", sortOrder: 20, enabled: false }),
    // 已移除：用户端不该看到
    announcement({ id: "a3", sortOrder: 30, removedAt: SEEDED_AT }),
    announcement({ id: "a4", sortOrder: 40 }),
  ];

  const items = selectPublicAnnouncements(records);
  assert.deepEqual(items.map((item) => item.id), ["a1", "a4"]);

  for (const item of items) {
    // 公告区只滚动展示图片，不显示文字、不响应点击：`title` 是后台的识别字段，
    // 一旦漏进 DTO，将来一定会有人把它渲染出来
    assert.deepEqual(
      Object.keys(item).sort(),
      ["alt", "id", "imageUrl"],
      "用户端公告 DTO 的字段就是这三个",
    );
    assert.equal("title" in item, false, "后台的识别字段不进用户端 DTO");
    assert.equal("enabled" in item, false);
    assert.equal("sortOrder" in item, false);
    assert.equal("removedAt" in item, false, "软移除时间不该出现在用户端");
    assert.equal("href" in item, false, "公告不含跳转字段（业务口径，不是还没做）");
  }
});

test("selectPublicAnnouncements：一条都不剩时返回空数组，不是占位图", () => {
  const empty = selectPublicAnnouncements([]);
  assert.deepEqual(empty, []);

  const allDisabled = selectPublicAnnouncements([
    announcement({ id: "a1", enabled: false }),
    announcement({ id: "a2", enabled: false }),
  ]);
  assert.deepEqual(allDisabled, []);

  // 停用 + 已移除的四种组合都不出场
  const mixed = selectPublicAnnouncements([
    announcement({ id: "a1", enabled: false, removedAt: SEEDED_AT }),
    announcement({ id: "a2", removedAt: SEEDED_AT }),
  ]);
  assert.deepEqual(mixed, []);
});

// ————————————————————————— 活动图：只有一张 —————————————————————————

test("selectActivityImageUrl：一张都没有就是空串（页面据此隐藏活动位）", () => {
  assert.equal(selectActivityImageUrl([]), "");
  assert.equal(selectActivityImageUrl([banner({ enabled: false })]), "", "只有停用的等于没有");
  assert.equal(
    selectActivityImageUrl([banner({ removedAt: SEEDED_AT })]),
    "",
    "已移除的等于没有",
  );
  assert.equal(
    selectActivityImageUrl([
      banner({ id: "b1", enabled: false }),
      banner({ id: "b2", removedAt: SEEDED_AT }),
    ]),
    "",
  );
});

test("selectActivityImageUrl：多张启用时取排序最前的那张（首页是一张图，不是轮播）", () => {
  const records = [
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 10 }),
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 20 }),
    banner({ id: "b3", imageUrl: "/mock/b3.svg", sortOrder: 30 }),
  ];

  assert.equal(selectActivityImageUrl(records), "/mock/b1.svg");
  // 输入顺序不影响结果
  assert.equal(selectActivityImageUrl([...records].reverse()), "/mock/b1.svg");
});

test("后台改排序，用户端就换图：sortOrder 把另一张顶到前面", () => {
  const records = [
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 10 }),
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 20 }),
  ];
  assert.equal(selectActivityImageUrl(records), "/mock/b1.svg");

  // 运营把 b2 的排序值调到 5：用户端刷新后看到的就是 b2
  const reordered = [
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 10 }),
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 5 }),
  ];
  assert.equal(selectActivityImageUrl(reordered), "/mock/b2.svg");

  // 排序值相同则由 id 兜底：b1 在前，仍然是确定的
  const tied = [
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 5 }),
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 5 }),
  ];
  assert.equal(selectActivityImageUrl(tied), "/mock/b1.svg");
});

test("后台改启用状态，用户端也换图：停用当前那张，第二张顶上来", () => {
  const records = [
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 10 }),
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 20 }),
  ];
  assert.equal(selectActivityImageUrl(records), "/mock/b1.svg");

  // 停用 b1：b2 成为唯一启用的那张
  const b1Disabled = [
    banner({ id: "b1", imageUrl: "/mock/b1.svg", sortOrder: 10, enabled: false }),
    banner({ id: "b2", imageUrl: "/mock/b2.svg", sortOrder: 20 }),
  ];
  assert.equal(selectActivityImageUrl(b1Disabled), "/mock/b2.svg");

  // 再启用回来：可逆，b1 又回到第一位
  assert.equal(selectActivityImageUrl(records), "/mock/b1.svg");

  // 两张都停用 → 活动位消失（空串）
  assert.equal(
    selectActivityImageUrl([
      banner({ id: "b1", enabled: false }),
      banner({ id: "b2", enabled: false }),
    ]),
    "",
  );
});

// ————————————————————————— 快捷入口 —————————————————————————

test("selectPublicShortcuts：排除停用与已移除，DTO 是 {id,label,href,icon}", () => {
  const records = [
    quickEntry({ id: "service", sortOrder: 10 }),
    quickEntry({ id: "benefits", sortOrder: 20, enabled: false }),
    quickEntry({ id: "join", sortOrder: 30, removedAt: SEEDED_AT }),
    quickEntry({ id: "complaint", sortOrder: 40, icon: "complaint", path: "/complaints" }),
  ];

  const shortcuts = selectPublicShortcuts(records);
  assert.deepEqual(
    shortcuts.map((item) => item.id),
    ["service", "complaint"],
  );

  for (const item of shortcuts) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["href", "icon", "id", "label"],
      "用户端入口 DTO 的字段就是这四个",
    );
    assert.equal("path" in item, false, "用户端字段叫 href，不是后台的 path");
    assert.equal("enabled" in item, false);
    assert.equal("sortOrder" in item, false);
    assert.equal("removedAt" in item, false);
    // 转换只有一处：`toHomeShortcut()` 把 path 搬到 href
    assert.equal(item.href.startsWith("/"), true);
  }
});

test("用户端仍有最后一道地址安全关卡：javascript: 的记录不进结果（独立用例）", () => {
  const records = [
    quickEntry({ id: "service", path: "/service", sortOrder: 10 }),
    // 一条**启用且未移除**、但地址是脚本协议的记录。
    // 写入侧（服务层 + 事务层）本不该让它进来；这里模拟「将来多出一条写入路径」
    // （批量导入、种子数据、直接的仓储写入）时的情形：用户端必须自己拦得住
    quickEntry({ id: "evil", label: "恶意", path: "javascript:alert(1)", sortOrder: 5 }),
    quickEntry({ id: "evil2", label: "站外", path: "//evil.example", sortOrder: 6 }),
    quickEntry({ id: "evil3", label: "外链", path: "https://evil.example", sortOrder: 7 }),
  ];

  const shortcuts = selectPublicShortcuts(records);
  const ids = shortcuts.map((item) => item.id);

  assert.equal(ids.includes("evil"), false, "脚本协议地址绝不能进用户端");
  assert.equal(ids.includes("evil2"), false, "协议相对地址绝不能进用户端");
  assert.equal(ids.includes("evil3"), false, "站外地址绝不能进用户端");
  assert.deepEqual(ids, ["service"], "四条里只有合法的那一条出场");

  // 双保险：结果里每一条的 href 都必须是安全的
  for (const item of shortcuts) {
    assert.equal(item.href.startsWith("/"), true);
    assert.notEqual(item.href.startsWith("//"), true);
  }
});

test("toHomeShortcut：一条记录 → 用户端 DTO，path 搬到 href", () => {
  const record = quickEntry({ id: "join", label: "考核入驻", icon: "join", path: "/join" });
  assert.deepEqual(toHomeShortcut(record), {
    id: "join",
    label: "考核入驻",
    href: "/join",
    icon: "join",
  });
});

test("isContentVisible：启用且未移除才算可见（停用与移除是两件事）", () => {
  assert.equal(isContentVisible({ enabled: true, removedAt: null }), true);
  assert.equal(isContentVisible({ enabled: false, removedAt: null }), false);
  assert.equal(isContentVisible({ enabled: true, removedAt: SEEDED_AT }), false);
  assert.equal(isContentVisible({ enabled: false, removedAt: SEEDED_AT }), false);
});

// ————————————————————————— 后台列表 DTO —————————————————————————

test("toAdminQuickEntryList：removedAt 变成 removed 布尔值，且结果里没有 removedAt 这个键", () => {
  const records = [
    quickEntry({ id: "service", sortOrder: 10 }),
    quickEntry({ id: "join", sortOrder: 20, removedAt: SEEDED_AT }),
  ];

  const items = toAdminQuickEntryList(records);
  assert.deepEqual(items.map((item) => item.id), ["service", "join"]);
  assert.equal(items[0].removed, false);
  assert.equal(items[1].removed, true);

  for (const item of items) {
    assert.equal("removedAt" in item, false, "后台列表要的是「还在不在」，不是时间戳");
    // 该有的可编辑字段一个不少：表单回填直接用它
    for (const key of ["id", "label", "icon", "path", "enabled", "sortOrder", "createdAt", "updatedAt", "removed"]) {
      assert.equal(key in item, true, `后台列表项缺少字段 ${key}`);
    }
  }

  // 排序与用户端同一套全序：后台看到的第一条就是用户端的第一条
  const tied = toAdminQuickEntryList([
    quickEntry({ id: "b", sortOrder: 5 }),
    quickEntry({ id: "a", sortOrder: 5 }),
  ]);
  assert.deepEqual(tied.map((item) => item.id), ["a", "b"]);
});
