import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINE_GRID_ENTRIES, MINE_PRIMARY_ENTRIES } from "../lib/constants/mine.ts";
import { homeSeed } from "../lib/mocks/fixtures/seed.ts";

/**
 * 路由表与入口地址的持续测试。
 *
 * 这一组测试不跑页面，而是**从 `app/` 目录真实地扫出路由表**，再拿页面配置里的入口地址去对照。
 * 目的很具体：入口点了不能没反应，更不能 404。之前的 `/companion`（单数）就是靠肉眼发现不了的
 * 一类问题——「我的」页指向了一个并不存在的路由，配置本身看着完全正常。
 *
 * 路由组 `(tabs)` 不产生 URL 段，`_` / `.` 开头的目录不参与路由（与 Next.js 的规则一致）。
 * 动态段（`[id]`）不进静态路由表：它们不是入口地址，另有数据层测试覆盖。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "app");

/** 扫出静态路由：URL 路径 → 该路由的 `page.tsx` 绝对路径。 */
function collectRoutes(dir, prefix = "", table = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
        // 路由组：只影响布局与文件组织，不进 URL
        collectRoutes(full, prefix, table);
      } else if (entry.name.includes("[")) {
        // 动态段：它不是一个可以写死的入口地址，另有数据层测试覆盖（例如商品详情）
        continue;
      } else if (!entry.name.startsWith("_") && !entry.name.startsWith(".")) {
        collectRoutes(full, `${prefix}/${entry.name}`, table);
      }
    } else if (entry.name === "page.tsx") {
      table.set(prefix === "" ? "/" : prefix, full);
    }
  }
  return table;
}

const ROUTES = collectRoutes(APP_DIR);

/** 递归列出目录下的全部文件。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

/** 去掉查询串，只留路径。 */
function pathnameOf(href) {
  return href.split("?")[0];
}

test("扫描器本身正确：能找到已知路由、并排除动态段与不存在的路径", () => {
  assert.equal(ROUTES.has("/"), true);
  assert.equal(ROUTES.has("/mine"), true);
  assert.equal(ROUTES.has("/companions"), true);
  // 动态路由不进静态表（它不是一个可以直接写死的入口地址）
  assert.equal(ROUTES.has("/product/[id]"), false);
  assert.equal(ROUTES.has("/product/p-off-1"), false);
  assert.equal(ROUTES.has("/definitely-not-a-route"), false);
});

test("陪玩列表用复数 /companions，单数 /companion 不再是页面路由", () => {
  assert.equal(ROUTES.has("/companions"), true, "缺少 /companions 页面");
  assert.equal(ROUTES.has("/companion"), false, "/companion（单数）不应再是页面路由");
  assert.equal(existsSync(path.join(APP_DIR, "companion")), false, "残留了单数路由目录");
});

test("「我的」页每个入口地址都真实存在，且寻找陪玩指向 /companions", () => {
  const entries = [...MINE_PRIMARY_ENTRIES, ...MINE_GRID_ENTRIES];
  const companion = entries.find((entry) => entry.id === "companion");
  const join = entries.find((entry) => entry.id === "join");

  assert.ok(companion, "缺少寻找陪玩入口");
  assert.equal(companion.label, "寻找陪玩");
  assert.equal(companion.kind, "link");
  assert.equal(companion.href, "/companions");

  // 「我的」页「成为护航」与首页「考核入驻」是同一个页面的两个入口，地址必须一致
  assert.ok(join, "缺成为护航入口");
  assert.equal(join.label, "成为护航");
  assert.equal(join.href, "/join");

  for (const entry of entries) {
    if (entry.kind !== "link") continue;
    assert.ok(entry.href, `${entry.label} 是 link 却没有地址`);
    assert.equal(
      ROUTES.has(pathnameOf(entry.href)),
      true,
      `「我的」页入口「${entry.label}」指向了不存在的路由：${entry.href}`,
    );
    // 单数 /companion 曾经就是在这里漏出去的
    assert.notEqual(pathnameOf(entry.href), "/companion");
  }
});

test("首页每个快捷入口都真实存在：考核入驻统一指向 /join", () => {
  const join = homeSeed.shortcuts.find((shortcut) => shortcut.id === "join");

  assert.ok(join, "缺少考核入驻入口");
  assert.equal(join.label, "考核入驻");
  assert.equal(join.href, "/join");
  assert.notEqual(join.href, "/placeholder?title=考核入驻");

  for (const shortcut of homeSeed.shortcuts) {
    assert.equal(
      ROUTES.has(pathnameOf(shortcut.href)),
      true,
      `首页入口「${shortcut.label}」指向了不存在的路由：${shortcut.href}`,
    );
  }
});

test("/join 需要登录：套用统一 RequireAuth，导航留在鉴权之外", () => {
  const source = readFileSync(ROUTES.get("/join"), "utf8");

  assert.ok(source.includes("RequireAuth"), "/join 必须走统一鉴权，而不是自己写一套登录判断");
  // 导航栏必须在鉴权之外渲染：未登录时也要有返回入口，不能把人困在登录页上
  assert.ok(source.includes("<NavBar"), "导航栏应在 RequireAuth 之外渲染");
  // 仍只是占位：不提前开发正式申请表单
  assert.ok(source.includes("PlaceholderPage"));
  assert.equal(source.includes("useState"), false, "本阶段不该出现申请表单");
  // 二级页面：不在 (tabs) 里，因此不会出现底部 TabBar
  assert.equal(ROUTES.get("/join").includes("(tabs)"), false);
});

test("/companions、/rank、/agreements 继续允许游客访问", () => {
  for (const route of ["/companions", "/rank", "/agreements"]) {
    assert.equal(ROUTES.has(route), true, `缺少 ${route} 页面`);
    assert.equal(
      readFileSync(ROUTES.get(route), "utf8").includes("RequireAuth"),
      false,
      `${route} 是浏览型页面，不该因为本次改动被一起保护起来`,
    );
    assert.equal(ROUTES.get(route).includes("(protected)"), false);
  }
});

test("不存在指向 /placeholder?title=考核入驻 的入口", () => {
  const entries = [...MINE_PRIMARY_ENTRIES, ...MINE_GRID_ENTRIES];
  for (const entry of entries) {
    assert.notEqual(entry.href, "/placeholder?title=考核入驻");
  }
  for (const shortcut of homeSeed.shortcuts) {
    assert.notEqual(shortcut.href, "/placeholder?title=考核入驻");
  }

  // 源码里也不该再出现这个地址（注释里写一句也算「还有入口」的隐患）
  const offenders = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (readFileSync(file, "utf8").includes("placeholder?title=考核入驻")) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
