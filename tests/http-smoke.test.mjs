import assert from "node:assert/strict";
import test from "node:test";

/**
 * HTTP 冒烟测试：需要已经跑起来的服务，未提供地址时自动跳过。
 *
 * 用法（两种跑法都行）：
 *
 *   pnpm build && pnpm start -p 3105        # 另开一个终端
 *   APP_BASE_URL=http://localhost:3105 pnpm test
 *
 * 保留在仓库里而不是用完即弃的脚本：这里断言的是**只有真跑服务才能发现**的东西——
 * 路由到底 404 不 404、游客能不能打开、页面里有没有那句提示。
 * `routes.test.mjs` 检查路由表与入口地址，数据层测试检查业务规则，三者互补。
 *
 * 不设 `APP_BASE_URL` 时整组跳过，因此 `pnpm test` 在没有任何服务时依然全绿。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过 HTTP 冒烟测试";

/** 登录拦截页的固定文案，用来判断「打开了受保护页面」而不是「404」。 */
const LOGIN_GATE_TEXT = "需要登录";
/** 底部 TabBar 的固定标记（`components/common/TabBar.tsx` 的 aria-label）。 */
const TABBAR_TEXT = "主导航";

/**
 * 模拟登录一次并拿到会话 Cookie。
 *
 * Node 的 fetch 不管 Cookie，因此把服务端下发的 `Set-Cookie` 原样带回去。
 * 服务端未开启 `ENABLE_MOCK_AUTH` 时返回 null——需要登录态的用例会说明原因并跳过，
 * 而不是伪装成通过。
 */
async function loginAs(userId = "u-1001") {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;

  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

const SESSION = BASE ? await loginAs() : null;
const SKIP_SESSION = SKIP || (SESSION ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要登录态的用例");

async function get(path, cookie) {
  const response = await fetch(new URL(path, BASE), {
    headers: cookie ? { cookie } : undefined,
  });
  return { status: response.status, html: await response.text() };
}

test("游客可以打开 /companions：不是 404，也不是登录拦截", { skip: SKIP }, async () => {
  const { status, html } = await get("/companions");

  assert.equal(status, 200);
  assert.ok(html.includes("寻找陪玩"), "缺少「寻找陪玩」标题");
  assert.ok(html.includes("功能开发中"), "缺少「功能开发中」占位状态");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "/companions 不该要求登录");
});

test("游客可以打开 /rank 与 /agreements：本次改动不牵连它们", { skip: SKIP }, async () => {
  for (const path of ["/rank", "/agreements"]) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${path} 不该 404`);
    assert.equal(html.includes(LOGIN_GATE_TEXT), false, `${path} 不该要求登录`);
  }
});

test("/companion（单数）不再是正式页面", { skip: SKIP }, async () => {
  const { status } = await get("/companion");
  assert.equal(status, 404);
});

test("游客打开 /join 命中统一登录引导（不是 404，也不是占位内容）", { skip: SKIP }, async () => {
  const { status, html } = await get("/join");

  assert.equal(status, 200, "/join 不该 404");
  assert.ok(html.includes(LOGIN_GATE_TEXT), "/join 未登录时应显示统一登录引导");
  assert.equal(html.includes("页面待实现"), false, "未登录不该看到入驻占位内容");
  // 导航栏在鉴权之外：未登录也要有返回入口
  assert.ok(html.includes("返回"), "未登录时缺少返回入口");
});

test("登录后 /join 显示「成为护航」占位内容，且没有底部 TabBar", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/join", SESSION);

  assert.equal(status, 200);
  assert.ok(html.includes("成为护航"));
  assert.ok(html.includes("页面待实现"), "登录后应看到入驻占位内容");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "已登录不该再出现登录引导");
  // 二级页面：只有顶部返回，没有底部 TabBar
  assert.equal(html.includes(TABBAR_TEXT), false, "/join 不该显示底部 TabBar");
});

test("首页「考核入驻」与「我的」页「成为护航」都指向 /join", { skip: SKIP_SESSION }, async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.ok(home.html.includes('href="/join"'), "首页没有指向 /join 的入口");
  assert.equal(home.html.includes("placeholder?title=考核入驻"), false, "首页还残留旧地址");

  const mine = await get("/mine", SESSION);
  assert.equal(mine.status, 200);
  assert.ok(mine.html.includes('href="/join"'), "「我的」页没有指向 /join 的入口");
  assert.ok(mine.html.includes("成为护航"));
  assert.ok(mine.html.includes('href="/companions"'));
});

test("已下架商品：直链打开是「已下架」状态页，不是 404", { skip: SKIP }, async () => {
  const { status, html } = await get("/product/p-off-1");

  assert.equal(status, 200);
  assert.ok(html.includes("商品已下架"), "缺少下架提示");
  // 不能购买：底部主按钮不出现「立即购买」，结算页也没有入口
  assert.equal(html.includes("立即购买"), false, "已下架商品不该出现购买按钮");
  assert.equal(html.includes("/checkout"), false, "已下架商品不该有结算入口");
});

test("真正不存在的商品仍然是 404", { skip: SKIP }, async () => {
  assert.equal((await get("/product/nope")).status, 404);
});

test("游客打开受保护页面是登录拦截，而不是 404", { skip: SKIP }, async () => {
  for (const path of ["/mine", "/favorites", "/settings", "/profile/edit", "/join"]) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${path} 不该 404`);
    assert.ok(html.includes(LOGIN_GATE_TEXT), `${path} 未登录时应显示登录拦截`);
  }
});
