import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINE_GRID_ENTRIES, MINE_PRIMARY_ENTRIES } from "../lib/constants/mine.ts";
import { homeSeed } from "../lib/mocks/fixtures/seed.ts";
import { findAppFile, hasAppFile } from "./app-path.mjs";

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

/**
 * 从一个目录往上列出**整条祖先链**（含自身），直到 `app/` 为止。
 *
 * 用来查「有没有 `loading.tsx` 罩在这一段上面」这类问题：Suspense 边界的作用范围是整棵
 * 子树，只看本层会漏掉上提的那一层，而状态码正是在那一层被定死的。
 */
function ancestorDirs(dir) {
  const levels = [];
  let current = dir;
  while (current.startsWith(APP_DIR)) {
    levels.push(current);
    if (current === APP_DIR) break;
    current = path.dirname(current);
  }
  return levels;
}

/** 去掉注释后再做「源码里不该出现某标识」的断言：文档注释里说明「本页没有 X」不算出现 X。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
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
  // hasAppFile 忽略路由组：页面搬进 `(mobile)` 之后，写死 `app/companion` 这种检查
  // 会因为「目录压根不在这儿」而永远通过，变成一条不起作用的断言。
  assert.equal(hasAppFile("companion/page.tsx"), false, "残留了单数路由目录");
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
  assert.ok(
    source.indexOf("<NavBar") < source.indexOf("<RequireAuth"),
    "/join 的导航栏应在 RequireAuth 之外渲染",
  );
  // 二级页面：不在 (tabs) 里，因此不会出现底部 TabBar
  assert.equal(ROUTES.get("/join").includes("(tabs)"), false);
});

test("/companions、/rank、/agreements 继续允许游客访问", () => {
  for (const route of ["/companions", "/rank", "/agreements"]) {
    assert.equal(ROUTES.has(route), true, `缺少 ${route} 页面`);
    // 先去掉注释：P7A 的页面在文档里写明了「这里刻意不用 RequireAuth」，
    // 那句话本身不构成鉴权（注释不该让这条断言误判）
    assert.equal(
      stripComments(readFileSync(ROUTES.get(route), "utf8")).includes("RequireAuth"),
      false,
      `${route} 是浏览型页面，不该因为本次改动被一起保护起来`,
    );
    assert.equal(ROUTES.get(route).includes("(protected)"), false);
  }
});

/**
 * P6B 新增的二级页面：优惠券 / 评价 / 鸡腿记录 / 意见反馈（含各自的表单页）。
 * `/reviews/new/[orderId]` 是动态段，不进静态路由表，由下面单独一条测试覆盖。
 */
const P6B_SECONDARY_ROUTES = [
  "/coupons",
  "/reviews",
  "/tips",
  "/tips/new",
  "/suggestions",
  "/suggestions/new",
];

test("P6B 的七个页面全部存在，且都是「需登录 + 顶部返回 + 无 TabBar」的二级页面", () => {
  for (const route of P6B_SECONDARY_ROUTES) {
    const file = ROUTES.get(route);
    assert.ok(file, `缺少 ${route} 页面`);

    // 不在 (tabs) 里：因此不会带上底部 TabBar
    assert.equal(file.includes("(tabs)"), false, `${route} 不该在一级 Tab 里`);
    assert.equal(file.includes("(protected)"), false, `${route} 自己有鉴权，不该挂进受保护的一级 Tab`);
    // 路由组不该绕过 URL 段：地址就是上面写的那一个
    assert.equal(route.includes("("), false);

    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("RequireAuth"), `${route} 必须走统一鉴权`);
    assert.ok(source.includes("<NavBar"), `${route} 应有顶部返回导航`);
    // 导航必须在鉴权之外渲染：未登录时也要有返回入口，不能把人困在登录页上
    assert.ok(
      source.indexOf("<NavBar") < source.indexOf("<RequireAuth"),
      `${route} 的导航栏应在 RequireAuth 之外渲染`,
    );
  }
});

test("评价表单按订单地址进入：/reviews/new/[orderId] 是动态段，改由数据层覆盖资格判定", () => {
  // 动态段不是入口地址，进不了 ROUTES 表，只能按路径找；findAppFile 会忽略路由组
  const file = findAppFile("reviews/new/[orderId]/page.tsx");

  const source = readFileSync(file, "utf8");
  assert.ok(source.includes("RequireAuth"));
  assert.ok(source.includes("<NavBar"));
  // 资格判定只在服务端做：页面调用服务而不是自己看订单状态
  assert.ok(source.includes("getReviewTargetForUser"), "评价资格必须由服务端判定");
});

test("「我的」页四个 P6B 入口指向真实页面，且标签与页面标题一致", () => {
  const entries = [...MINE_PRIMARY_ENTRIES, ...MINE_GRID_ENTRIES];
  const expected = {
    coupon: { label: "我的优惠券", href: "/coupons" },
    review: { label: "我的评价", href: "/reviews" },
    tips: { label: "鸡腿记录", href: "/tips" },
    suggestion: { label: "功能建议", href: "/suggestions" },
  };

  for (const [id, want] of Object.entries(expected)) {
    const entry = entries.find((item) => item.id === id);
    assert.ok(entry, `「我的」页缺少入口 ${id}`);
    assert.equal(entry.label, want.label);
    assert.equal(entry.href, want.href);
    assert.equal(ROUTES.has(want.href), true, `${want.label} 指向了不存在的路由`);
  }
});

test("优惠券与鸡腿记录不再有占位页式的「待开放」入口", () => {
  // 四个入口必须都是真实地址，不能还停在 /placeholder
  for (const entry of [...MINE_PRIMARY_ENTRIES, ...MINE_GRID_ENTRIES]) {
    if (!["coupon", "review", "tips", "suggestion"].includes(entry.id)) continue;
    assert.equal(entry.kind, "link", `${entry.label} 应是可跳转的入口`);
    assert.equal(pathnameOf(entry.href).startsWith("/placeholder"), false);
  }
});

// ————————————————— P7A：消费等级 / 消费排行榜 / 相关协议 —————————————————

/** P7A 的三个页面，以及它们各自的性质。 */
const P7A_PAGES = [
  // /rights 需要登录：等级与金额都是私有数据
  { path: "/rights", requiresAuth: true },
  // /rank 与 /agreements 游客可访问：榜单与协议是公开内容
  { path: "/rank", requiresAuth: false },
  { path: "/agreements", requiresAuth: false },
];

test("P7A 三个页面都不是占位页：入口已经落到真实实现上", () => {
  for (const { path: route } of P7A_PAGES) {
    const file = ROUTES.get(route);
    assert.ok(file, `缺少 ${route} 页面`);

    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(code.includes("PlaceholderPage"), false, `${route} 还是占位页`);

    // 二级页面：不在 (tabs) 内，因此不会带上底部 TabBar
    assert.equal(file.includes("(tabs)"), false, `${route} 不该在一级 Tab 里`);
    assert.ok(code.includes("<NavBar"), `${route} 应有顶部返回导航`);

    // 错误边界：取数失败时给出「返回」与「重试」，而不是白屏
    // 边界就找页面自己所在的那一段，而不是把地址拼回目录名——
    // 路由组不产生 URL 段，按地址拼出来的路径根本不存在。
    const dir = path.dirname(file);
    const errorFile = path.join(dir, "error.tsx");
    assert.equal(existsSync(errorFile), true, `${route} 缺少 error.tsx`);
    const errorSource = readFileSync(errorFile, "utf8");
    assert.ok(
      errorSource.includes("ErrorState"),
      `${route} 的错误边界应复用统一 ErrorState（含「重试」）`,
    );
    assert.ok(
      errorSource.includes("<NavBar") && errorSource.includes("showBack"),
      `${route} 的错误边界要有返回入口`,
    );

    // 加载边界不是可选项：这三个页面在渲染前先 `await` 取数，没有同段的 Suspense 边界时，
    // 取数失败发生在外壳阶段，React 无法恢复，响应会退化成 500（HTTP 冒烟测试实测）。
    // 有了它，响应保持 200，错误由上面的 error.tsx 接管。
    const loadingFile = path.join(dir, "loading.tsx");
    assert.equal(existsSync(loadingFile), true, `${route} 缺少 loading.tsx`);
    assert.ok(
      readFileSync(loadingFile, "utf8").includes("<NavBar"),
      `${route} 的加载态应保留返回导航，加载时布局不跳`,
    );
  }
});

test("/rights 需要登录：走统一 RequireAuth，导航留在鉴权之外", () => {
  const file = ROUTES.get("/rights");
  const source = readFileSync(file, "utf8");

  assert.ok(source.includes("RequireAuth"), "/rights 必须走统一鉴权，而不是自己写一套登录判断");
  // 导航在鉴权之外：未登录时也要有返回入口，登录后地址仍是 /rights（不会跳走）
  assert.ok(source.indexOf("<NavBar") < source.indexOf("<RequireAuth"));
  // 等级与进度由服务端算好：页面不得自己遍历订单
  assert.ok(source.includes("getConsumptionLevelForUser"));
  assert.equal(stripComments(source).includes("sumEffectiveSpend"), false);
});

test("/rank 与 /agreements 保持游客可访问，并且不再要求登录", () => {
  for (const route of ["/rank", "/agreements"]) {
    const code = stripComments(readFileSync(ROUTES.get(route), "utf8"));
    assert.equal(code.includes("RequireAuth"), false, `${route} 是公开页面，不该被保护起来`);
  }

  // 榜单服务端聚合、协议一次取回，两者都通过服务层而不是直接读仓储
  assert.ok(readFileSync(ROUTES.get("/rank"), "utf8").includes("getConsumptionRanking"));
  assert.ok(readFileSync(ROUTES.get("/agreements"), "utf8").includes("listAgreements"));
});

test("排行榜的六个周期都是真实页签：没有「尚未开放」，也不是先拿累计再在本地过滤", () => {
  const boardFile = path.join(ROOT, "components", "rank", "RankingBoard.tsx");
  assert.equal(existsSync(boardFile), true, "缺少排行榜列表组件");
  const code = stripComments(readFileSync(boardFile, "utf8"));

  // 六个周期全部可切换：任何一个写成「暂未开放」都说明页签只是摆设
  for (const copy of ["尚未开放", "暂未开放", "敬请期待"]) {
    assert.equal(code.includes(copy), false, `排行榜页签里不该再出现「${copy}」`);
  }

  const tabsSource = readFileSync(path.join(ROOT, "lib", "constants", "rankingPeriods.ts"), "utf8");
  for (const period of ["today", "yesterday", "week", "month", "lastMonth", "all"]) {
    assert.ok(tabsSource.includes(`"${period}"`), `周期表里缺少 ${period}`);
  }
  for (const label of ["今日", "昨日", "本周", "本月", "上月", "累计"]) {
    assert.ok(tabsSource.includes(label), `周期表里缺少「${label}」`);
  }

  // 页签从常量表渲染，而不是在组件里手写一遍（两份清单一定会分叉）
  assert.ok(code.includes("RANKING_PERIOD_TABS"), "页签应来自统一的周期常量表");
  // 选中态不能只靠颜色：还要有 aria-pressed 之类的语义标记
  assert.ok(code.includes("aria-pressed"), "当前页签需要可被读屏识别的选中态");

  // 切周期必须重新取数，并且**先按周期聚合再分页**：把周期带进请求，由服务端重新聚合
  assert.ok(code.includes("fetchConsumptionRanking"), "切周期必须重新请求服务端");
  assert.ok(code.includes("period"), "请求里必须带上周期");
  assert.equal(code.includes("buildConsumptionRanking"), false, "客户端不该拿到全量订单自己聚合");

  // 迟到的响应不能覆盖界面：序号与周期都要对得上
  assert.ok(code.includes("shouldApplyRankingResponse"), "缺少过期响应守卫");

  // 页面只在调用服务前规范化周期；服务端仍然是严格的（非法值回 400）
  const pageCode = stripComments(readFileSync(ROUTES.get("/rank"), "utf8"));
  assert.ok(pageCode.includes("normalizeRankingPeriod"));
});

test("/suggestions 有了自己的错误边界：不再落回全局错误页或白屏", () => {
  // 边界与页面同段，因此从页面自己的位置推出来，而不是把地址拼回目录名
  const dir = path.dirname(ROUTES.get("/suggestions"));
  for (const name of ["error.tsx", "loading.tsx"]) {
    assert.equal(existsSync(path.join(dir, name)), true, `/suggestions 缺少 ${name}`);
  }

  const errorSource = readFileSync(path.join(dir, "error.tsx"), "utf8");
  // 与其它二级列表页一致：统一 ErrorState（含「重试」）+ 顶部返回
  assert.ok(errorSource.includes("ErrorState"));
  assert.ok(errorSource.includes("<NavBar") && errorSource.includes("showBack"));
  // 二级页面：不该带上底部 TabBar（注释里说明「这里没有 TabBar」不算出现）
  assert.equal(stripComments(errorSource).includes("TabBar"), false);

  const loadingSource = readFileSync(path.join(dir, "loading.tsx"), "utf8");
  assert.ok(loadingSource.includes("<NavBar"), "加载态也要保留返回入口");
  assert.equal(stripComments(loadingSource).includes("TabBar"), false);

  // 正常提交流程没有被改动：列表仍然由原来的页面与服务层负责
  const pageCode = stripComments(readFileSync(ROUTES.get("/suggestions"), "utf8"));
  assert.ok(pageCode.includes("querySuggestionsForUser"), "反馈列表仍然走服务层");
});

test("「我的」页保留消费等级、排行榜与协议入口，并展示等级摘要", () => {
  const entries = [...MINE_PRIMARY_ENTRIES, ...MINE_GRID_ENTRIES];
  const expected = {
    level: { label: "消费等级", href: "/rights" },
    rank: { label: "消费排行榜", href: "/rank" },
    agreement: { label: "相关协议", href: "/agreements" },
  };

  for (const [id, want] of Object.entries(expected)) {
    const entry = entries.find((item) => item.id === id);
    assert.ok(entry, `「我的」页缺少入口 ${id}`);
    assert.equal(entry.kind, "link");
    assert.equal(entry.label, want.label);
    assert.equal(entry.href, want.href);
  }

  const mineFile = ROUTES.get("/mine");
  const source = readFileSync(mineFile, "utf8");

  // 一级 Tab 页：保留底部 TabBar（不在二级页那套结构里）
  assert.equal(mineFile.includes("(tabs)"), true, "「我的」页仍是一级 Tab");

  // 等级摘要在服务端取，且**失败不让整页崩**：包在 try/catch 里，交给局部重试
  assert.ok(source.includes("LevelSummaryPanel"), "缺少等级摘要");
  assert.ok(source.includes("getConsumptionLevelForUser"), "等级摘要必须由服务端算");
  assert.ok(source.includes("try {") && source.includes("catch"), "等级摘要失败必须被兜住");
  // 页面不得自己遍历订单算等级
  assert.equal(stripComments(source).includes("sumEffectiveSpend"), false);
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

// ————————————————— P7B：寻找陪玩 / 护航入驻申请 —————————————————

/** P7B 的四个页面，以及它们各自的性质。 */
const P7B_PAGES = [
  // 陪玩名单与陪玩资料是浏览型内容：游客可访问
  { path: "/companions", requiresAuth: false },
  // /join 与 /join/status 是私有数据：必须登录
  { path: "/join", requiresAuth: true },
  { path: "/join/status", requiresAuth: true },
];

test("P7B 四个页面都不是占位页，且都是「顶部返回 + 无 TabBar」的二级页面", () => {
  for (const { path: route, requiresAuth } of P7B_PAGES) {
    const file = ROUTES.get(route);
    assert.ok(file, `缺少 ${route} 页面`);

    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(code.includes("PlaceholderPage"), false, `${route} 还是占位页`);

    // 二级页面：不在 (tabs) 内，因此不会带上底部 TabBar
    assert.equal(file.includes("(tabs)"), false, `${route} 不该在一级 Tab 里`);
    assert.ok(code.includes("<NavBar"), `${route} 应有顶部返回导航`);

    if (requiresAuth) {
      assert.ok(code.includes("RequireAuth"), `${route} 必须走统一鉴权`);
      assert.ok(
        code.indexOf("<NavBar") < code.indexOf("<RequireAuth"),
        `${route} 的导航栏应在 RequireAuth 之外渲染`,
      );
    } else {
      // 浏览型页面不读会话：不该因为这次改动被一起保护起来
      assert.equal(code.includes("RequireAuth"), false, `${route} 是浏览型页面，不该要求登录`);
    }

    // 边界就找**页面自己所在的那一段**（`page.tsx` 的兄弟文件），而不是把地址拼回目录名：
    // 路由组（如 `app/companions/(list)`）不产生 URL 段，按地址拼出来的路径根本不存在。
    const dir = path.dirname(file);

    // 错误边界：取数失败时给出「返回」与「重试」，而不是白屏
    const errorFile = path.join(dir, "error.tsx");
    assert.equal(existsSync(errorFile), true, `${route} 缺少 error.tsx`);
    const errorSource = readFileSync(errorFile, "utf8");
    assert.ok(errorSource.includes("ErrorState"), `${route} 的错误边界应复用统一 ErrorState`);
    assert.ok(
      errorSource.includes("<NavBar") && errorSource.includes("showBack"),
      `${route} 的错误边界要有返回入口`,
    );

    // 加载边界不是可选项：页面在渲染前先 `await` 取数，没有同段的 Suspense 边界时，
    // 取数失败发生在外壳阶段，React 无法恢复，响应会退化成 500（与 /rank、/suggestions 同理）。
    const loadingFile = path.join(dir, "loading.tsx");
    assert.equal(existsSync(loadingFile), true, `${route} 缺少 loading.tsx`);
    assert.ok(
      readFileSync(loadingFile, "utf8").includes("<NavBar"),
      `${route} 的加载态应保留返回导航，加载时布局不跳`,
    );
  }
});

test("陪玩列表与详情分成两个同级的路由段：加载边界收在列表自己那一段里", () => {
  // 位置一律从页面自己推出来（ROUTES 扫出来的就是真实路径），不写死 `app/companions`：
  // 用户端整体搬进 `(mobile)` 之后，写死路径的断言会连整段逻辑一起失效——
  // 检查的是一个并不存在的位置，然后「通过」。
  const listDir = path.dirname(ROUTES.get("/companions"));
  const segmentDir = path.dirname(listDir); // companions 这一层
  const detailDir = path.join(segmentDir, "[id]");

  assert.equal(path.basename(listDir), "(list)", "陪玩列表应当待在路由组 (list) 里");
  assert.equal(existsSync(detailDir), true, "陪玩详情应当是列表的同级段");

  // 分家的理由：列表需要加载边界（否则取数失败会退化成 500），
  // 而详情一旦被它罩住，「不存在的陪玩」就会变成一屏 200 的 404 文案。
  for (const name of ["page.tsx", "loading.tsx", "error.tsx"]) {
    assert.equal(existsSync(path.join(listDir, name)), true, `列表段缺少 ${name}`);
  }
  // 列表那三个文件不该被上提到 companions 这一层：上提一层就等于罩住 [id]
  for (const name of ["page.tsx", "loading.tsx", "error.tsx"]) {
    assert.equal(
      existsSync(path.join(segmentDir, name)),
      false,
      `${path.relative(ROOT, path.join(segmentDir, name))} 不该存在：上提一层会罩住 [id]，让真实 404 变成 200`,
    );
  }
});

test("陪玩详情是动态段：不存在走 notFound()，且没有 loading 边界（否则状态码会变成 200）", () => {
  const dir = path.dirname(findAppFile("companions/[id]/page.tsx"));

  for (const name of ["page.tsx", "error.tsx", "not-found.tsx"]) {
    assert.equal(existsSync(path.join(dir, name)), true, `陪玩详情缺少 ${name}`);
  }

  // 与 `app/product/[id]` 一致：加了 loading.tsx 之后外壳会先以 200 发出，
  // 随后到达的 notFound() 只能改页面内容、改不了已经发出的状态码——
  // 「不存在的陪玩」会变成一屏 200 的 404 文案。这里选状态码正确的那一边。
  //
  // 检查的是**整条祖先链**而不只是这一层：真正决定状态码的是「谁的 Suspense 边界罩住了
  // 这次取数」，兄弟目录 `app/companions/(list)/loading.tsx` 一度就是这样把详情罩住的
  // （实测 /companions/cp-not-exist 返回 200）。只查本层查不出这类上提。
  for (const level of ancestorDirs(dir)) {
    assert.equal(
      existsSync(path.join(level, "loading.tsx")),
      false,
      `${path.relative(ROOT, level)} 的 loading.tsx 罩住了陪玩详情：不存在的 ID 会返回 200 而不是 404`,
    );
  }

  const code = stripComments(readFileSync(path.join(dir, "page.tsx"), "utf8"));
  // 不存在 → 项目统一的 404；不在名单里的陪玩仍然能打开详情，因此这里只对 null 生效
  assert.ok(code.includes("notFound()"), "不存在的陪玩 ID 应走项目统一的 404");
  assert.ok(code.includes("getCompanionDetail"), "详情必须由服务端取数");
  // 详情页没有下单能力：不出现任何创建订单 / 支付请求的调用
  for (const forbidden of ["createPaymentRequest", "createOrder", "confirmPaymentRequest"]) {
    assert.equal(code.includes(forbidden), false, `陪玩详情不该出现 ${forbidden}`);
  }

  // 不存在的 ID 与「取数失败」是两件事，不能合并成一屏
  const notFoundSource = readFileSync(path.join(dir, "not-found.tsx"), "utf8");
  assert.ok(notFoundSource.includes("EmptyState"));
  assert.ok(notFoundSource.includes('href="/companions"'), "404 页应给一条回到名单的退路");
});

test("不在名单里的陪玩是只读资料页：没有选择入口，且靠服务端的 listed 与「暂不可用」区分", () => {
  const constants = stripComments(
    readFileSync(path.join(ROOT, "lib", "constants", "companions.ts"), "utf8"),
  );
  // 「下架」与「在架但暂不可用」两种情况的 available 都是 false，只能靠 listed 区分。
  // 规则只有一处定义：`isCompanionListed()`（`enabled && removedAt === null`）——
  // 公开列表的筛选、详情与结算都调它，各自写一遍迟早会分叉。
  assert.ok(
    constants.includes("companion.enabled && companion.removedAt === null"),
    "listed 必须来自仓储的上架标记",
  );
  assert.ok(
    constants.includes("listed: isCompanionListed(companion)"),
    "详情的 listed 必须由 isCompanionListed() 算，不能另起一套判断",
  );
  assert.ok(
    constants.includes("selectable: isCompanionListed(companion) && companion.available"),
    "能不能选必须由服务端算好",
  );

  const code = stripComments(
    readFileSync(path.join(ROOT, "components", "companions", "CompanionDetailView.tsx"), "utf8"),
  );
  assert.ok(code.includes("companion.listed"), "详情组件应按服务端给的 listed 分支");
  // 只读说明必须写清「没有选择或下单入口」，而不是给一个灰按钮
  assert.ok(constants.includes("没有选择或下单入口"), "只读页的说明文案不完整");
  assert.ok(code.includes("COMPANION_DETAIL_DISABLED_NOTICE"), "只读页应给出这段说明");
});

test("列表项与详情的共有字段只有一份：同一个字段不会在两处各写一遍", () => {
  const source = stripComments(
    readFileSync(path.join(ROOT, "lib", "constants", "companions.ts"), "utf8"),
  );

  assert.ok(source.includes("toCompanionListItem"), "缺少列表项 DTO 转换");
  assert.ok(source.includes("toCompanionDetail"), "缺少详情 DTO 转换");
  // 一个定义 + 两处引用：两份 DTO 从 toCompanionBase 出发，差别只有自我介绍与评价。
  // 不共用的话，昵称 / 头像 / 可用状态会在两处各拼一遍，迟早出现「两处写法不一样」。
  assert.equal(
    (source.match(/toCompanionBase\(/g) ?? []).length,
    3,
    "列表项与详情应当共用同一份共有字段（一个定义 + 两处引用）",
  );
  assert.ok(source.includes("...toCompanionBase(companion, gameNameById)"));
});

test("陪玩的选择交互不产生任何业务结果：不发请求、不写存储、不进结算页", () => {
  const file = path.join(ROOT, "components", "companions", "CompanionDetailView.tsx");
  assert.equal(existsSync(file), true, "缺少陪玩详情组件");

  const code = stripComments(readFileSync(file, "utf8"));

  // 不创建订单、不创建支付请求、不写入陪玩关系仓储：连可以调用的入口都不该有
  for (const forbidden of [
    "createPaymentRequest",
    "createOrder",
    "confirmPaymentRequest",
    "fetchCompanions",
    "companionsHttp",
    "apiPost",
    "fetch(",
  ]) {
    assert.equal(code.includes(forbidden), false, `选择陪玩不该调用 ${forbidden}`);
  }

  // 不写 localStorage / sessionStorage / Cookie
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
    assert.equal(code.includes(forbidden), false, `陪玩详情不该写 ${forbidden}`);
  }

  // 不改动 P4 结算页的地址：连跳转都不该有
  assert.equal(code.includes("/checkout"), false, "陪玩详情不该把用户带进结算页");
  assert.equal(code.includes("companionId"), false, "陪玩 ID 不该被注入任何订单 / 支付参数");

  // 文案必须说明「绑定规则待确认」，而不是声称已经预约 / 锁定 / 分配。
  // 只看常量本身（去掉注释）：注释里写「不使用『已预约』这类词」不算文案里出现了它。
  assert.ok(code.includes("COMPANION_SELECTION_NOTICE"), "缺少「绑定规则待确认」的说明");
  const notice = stripComments(
    readFileSync(path.join(ROOT, "lib", "constants", "companions.ts"), "utf8"),
  );
  assert.ok(notice.includes("待确认"));
  for (const claim of ["已预约", "已锁定", "已分配", "预约成功", "锁定成功"]) {
    assert.equal(notice.includes(claim), false, `说明文案里出现了未确认的结论：${claim}`);
  }
});

test("入驻申请表单不使用 maxLength 静默截断，且游戏选项来自服务端目录", () => {
  const file = path.join(ROOT, "components", "companions", "CompanionApplicationForm.tsx");
  assert.equal(existsSync(file), true, "缺少入驻申请表单组件");

  const code = stripComments(readFileSync(file, "utf8"));
  // 超限要能继续输入并给出错误，不能用 maxLength 把字挡住
  assert.equal(code.includes("maxLength"), false, "输入框不该用 maxLength 静默截断");
  assert.ok(code.includes("countCharacters"), "字数要用全站统一的口径");
  // 无障碍：出错字段可被读屏识别
  assert.ok(code.includes("aria-invalid"), "表单缺少 aria-invalid");
  assert.ok(code.includes("aria-describedby"), "表单缺少 aria-describedby");
  assert.ok(code.includes('role="alert"'), "表单缺少 role=\"alert\"");
  // 防重不能只靠按钮禁用：还要有同步闸门与幂等键
  assert.ok(code.includes("submittingRef"), "缺少同步提交闸门");
  assert.ok(code.includes("crypto.randomUUID"), "缺少幂等键");
  assert.ok(code.includes('router.replace("/join/status")'), "提交成功后应 replace 到进度页");

  // 申请页面的游戏选项来自服务层，且服务层读的是真实游戏目录
  const service = readFileSync(
    path.join(ROOT, "lib", "services", "companionApplications.ts"),
    "utf8",
  );
  assert.ok(service.includes("listCompanionApplicationGameOptions"));
  assert.ok(service.includes("getGames()"), "游戏选项必须来自真实游戏目录");
});

test("陪玩组件不引用 Mock / 数据层，且客户端只引用 *Http 取数模块", () => {
  const files = [];
  for (const file of walk(path.join(ROOT, "components", "companions"))) {
    if (file.endsWith(".tsx") || file.endsWith(".ts")) files.push(file);
  }
  assert.ok(files.length >= 5, "陪玩组件目录文件过少，检查是否扫错目录");

  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const forbidden of ["@/lib/mocks", "@/lib/data"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${path.basename(file)} 引用了 ${forbidden}：Mock 层与内存存储会被打进浏览器产物`,
      );
    }
    // 种子数据与仓储实体也不能出现在客户端组件里
    for (const forbidden of ["companionApplicationSeed", "companionSeed", "getMockStore"]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${path.basename(file)} 直接引用了 ${forbidden}`,
      );
    }
  }

  // 服务端模块与浏览器模块分开：客户端只能引用 *Http 那一个，或只取类型
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const line of code.split("\n")) {
      if (!line.includes('from "@/lib/services/')) continue;
      assert.ok(
        line.includes("Http\"") || line.includes("import type"),
        `${path.basename(file)} 引用了服务端服务模块：${line.trim()}`,
      );
    }
  }
});

test("陪玩与入驻的路由地址没有第二种写法", () => {
  // 单数 /companion 不是页面路由，也没有残留目录
  assert.equal(ROUTES.has("/companion"), false);
  assert.equal(hasAppFile("companion/page.tsx"), false, "残留了单数路由目录");

  // 入驻进度是 /join/status，不是 /joinStatus 之类的第二种写法
  assert.equal(ROUTES.has("/join/status"), true);
  assert.equal(ROUTES.has("/joinStatus"), false);
  assert.equal(ROUTES.has("/companion/join"), false);

  // 二级页面不该出现底部 TabBar 组件
  for (const { path: route } of P7B_PAGES) {
    const code = stripComments(readFileSync(ROUTES.get(route), "utf8"));
    assert.equal(code.includes("TabBar"), false, `${route} 不该渲染底部 TabBar`);
  }
});

test("陪玩与入驻的 DTO 边界：公开接口不夹带身份与申请内容", () => {
  const code = stripComments(
    readFileSync(path.join(ROOT, "lib", "constants", "companions.ts"), "utf8"),
  );

  // 公开 DTO 的字段是显式列举的，而不是整体展开内部实体
  // （`[...companion.regions]` 这种是数组拷贝，允许；要挡住的是 `{ ...companion }`）
  assert.equal(
    /\.\.\.\s*companion\s*[,}]/.test(code),
    false,
    "公开 DTO 不该整体展开内部实体",
  );
  for (const forbidden of [
    "userId",
    "openId",
    "unionId",
    "contactNote",
    "reviewNote",
    "evidence",
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `公开陪玩 DTO 的构造里出现了不该外流的字段：${forbidden}`,
    );
  }

  // 陪玩列表接口不要求登录，也不接受任何用户标识
  const apiFile = path.join(APP_DIR, "api", "companions", "route.ts");
  assert.equal(existsSync(apiFile), true, "缺少 GET /api/companions");
  const apiCode = stripComments(readFileSync(apiFile, "utf8"));
  assert.equal(apiCode.includes("requireUser"), false, "陪玩列表是公开内容，接口不该要求登录");
  assert.ok(apiCode.includes("resolveCompanionListQuery"));
});
