import assert from "node:assert/strict";
import test from "node:test";

/**
 * **运营内容管理的 HTTP 验收测试**（P8E-1 §一 / §二十二）。
 *
 * 与 `homeContentWiring.test.mjs` 的分工：那条走的是**进程内的服务层直调**，
 * 证明「后台改记录 → 用户端取数」这条链在数据层是通的；这一条走的是
 * **真实 HTTP**，证明链路上每一个真实存在的断点都不存在——
 * 路由有没有挂上、鉴权拦没拦住、请求体的字段名对不对、Cookie 认不认、
 * 编码后的中文有没有在某个环节被吃掉。这些**只有真跑一个服务才能发现**。
 *
 * ⚠️ 本文件刻意覆盖三条最容易「看起来对、其实不对」的东西：
 *
 * 1. **代理层鉴权**（§十四）：未带 Cookie、带用户 Cookie、带客服 Cookie
 *    三种身份打同一批写接口，都必须被挡住。鉴权只写在页面上的话，
 *    一个 curl 就能绕过整个后台。
 * 2. **服务端不信任客户端 actor**：请求体里塞 `actorId` 不会有任何效果——
 *    这条只能在 HTTP 层验证，因为它要证明的是「请求体里那个字段没人读」。
 * 3. **幂等键真的过了网络**：同一个键在两个**独立的 fetch** 里到达服务端，
 *    第二次必须返回第一次的结果而不是再写一条。进程内调用证明不了这件事，
 *    因为真正会重发的是网络。
 *
 * 不设 `APP_BASE_URL` 时整组跳过，因此 `pnpm test` 在没有服务时依然全绿。
 * 用法：`pnpm build && pnpm start -p 3105`，另开终端
 * `APP_BASE_URL=http://localhost:3105 pnpm test`。
 *
 * 服务端需要 `ENABLE_MOCK_ADMIN=true`（管理端身份）与 `ENABLE_MOCK_AUTH=true`
 * （用户端身份，用来验证普通用户打不进来）。开关没开时相关用例如实跳过并说明原因，
 * 不伪装成通过。
 */

const BASE = process.env.APP_BASE_URL;
const SKIP = BASE ? false : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过运营内容 HTTP 验收";

/**
 * 管理端登录一次。
 *
 * `ENABLE_MOCK_ADMIN=false` 时接口表现为「不存在」，返回 null —— 需要管理身份的
 * 用例据此跳过，而不是拿一个假的 Cookie 去撞。
 */
async function adminLogin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

/** 用户端登录一次（普通用户）。 */
async function userLogin(userId = "u-1001") {
  const response = await fetch(new URL("/api/auth/mock-login", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (response.status !== 200) return null;
  const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
  return cookies.length > 0 ? cookies.join("; ") : null;
}

const ADMIN = BASE ? await adminLogin() : null;
const SKIP_ADMIN = SKIP || (ADMIN ? false : "服务端未开启 ENABLE_MOCK_ADMIN，跳过需要管理身份的用例");

const USER = BASE ? await userLogin() : null;
const SKIP_USER = SKIP || (USER ? false : "服务端未开启 ENABLE_MOCK_AUTH，跳过需要用户身份的用例");

// ——————————————————————————— 请求辅助 ———————————————————————————

async function request(method, path, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(new URL(path, BASE), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // `html` 与 `text` 是同一份东西，两个名字是为了让调用点自己说清在断言什么：
  // `json` 是接口，`html` 是**用户真正看到的那个页面**（Server Component 渲染出来的）。
  // 「后台改了东西 → 用户刷新看得见」这条链最终只能靠 `html` 回答。
  return { status: response.status, json, text, html: text };
}

/** 带管理身份读接口。 */
function adminGet(path) {
  return request("GET", path, { cookie: ADMIN });
}

/** 带管理身份写接口。`body` 缺省时自动补一个幂等键。 */
function adminWrite(method, path, body = {}) {
  return request(method, path, {
    cookie: ADMIN,
    body: { idempotencyKey: crypto.randomUUID(), ...body },
  });
}

/** 首页（用户端真正读的那个入口）。 */
async function home() {
  const { status, json } = await request("GET", "/api/home");
  assert.equal(status, 200, "用户在首页取数失败了");
  return json.data;
}

/** 一份合法的公告表单内容。逐用例只覆盖需要变的那几项。 */
function announcementForm(overrides = {}) {
  return {
    title: "HTTP 验收 - 首页公告位",
    imageUrl: "/mock/announcement-1.svg",
    alt: "HTTP 验收公告图",
    sortOrder: 50,
    enabled: true,
    ...overrides,
  };
}

function quickEntryForm(overrides = {}) {
  return {
    label: "HTTP 入口",
    icon: "service",
    path: "/service",
    sortOrder: 50,
    enabled: true,
    ...overrides,
  };
}

// ——————————————————————————— 鉴权（§十四）———————————————————————————

/**
 * 全部内容管理写接口。列在这里而不是逐个用例里重复，是因为
 * 「新增接口忘了加 `requireAdmin()`」正是这一条要挡的事：
 * 漏掉的那一个不会让别的用例变红，只会安静地开着一个不需要登录的后门。
 */
const CONTENT_ADMIN_WRITE_ROUTES = [
  ["POST", "/api/admin/content/announcements"],
  ["PATCH", "/api/admin/content/announcements/a1"],
  ["POST", "/api/admin/content/announcements/a1/enable"],
  ["POST", "/api/admin/content/announcements/a1/disable"],
  ["POST", "/api/admin/content/announcements/a1/remove"],
  ["POST", "/api/admin/content/banners"],
  ["PATCH", "/api/admin/content/banners/b1"],
  ["POST", "/api/admin/content/banners/b1/enable"],
  ["POST", "/api/admin/content/banners/b1/disable"],
  ["POST", "/api/admin/content/banners/b1/remove"],
  ["POST", "/api/admin/content/quick-entries"],
  ["PATCH", "/api/admin/content/quick-entries/service"],
  ["POST", "/api/admin/content/quick-entries/service/enable"],
  ["POST", "/api/admin/content/quick-entries/service/disable"],
  ["POST", "/api/admin/content/quick-entries/service/remove"],
  ["PATCH", "/api/admin/content/agreements/user"],
  ["POST", "/api/admin/content/agreements/user/enable"],
  ["POST", "/api/admin/content/agreements/user/disable"],
];

const CONTENT_ADMIN_READ_ROUTES = [
  "/api/admin/content/announcements",
  "/api/admin/content/announcements/a1",
  "/api/admin/content/banners",
  "/api/admin/content/banners/b1",
  "/api/admin/content/quick-entries",
  "/api/admin/content/quick-entries/service",
  "/api/admin/content/agreements",
  "/api/admin/content/agreements/user",
];

test("未登录打内容管理接口：一个都进不去，且响应体里没有业务数据", { skip: SKIP }, async () => {
  for (const path of CONTENT_ADMIN_READ_ROUTES) {
    const { status, text } = await request("GET", path);
    assert.equal(status, 401, `GET ${path} 未登录时返回了 ${status}`);
    assert.equal(text.includes("announcement-1.svg"), false, `GET ${path} 在 401 响应里泄漏了业务数据`);
  }

  for (const [method, path] of CONTENT_ADMIN_WRITE_ROUTES) {
    const { status } = await request(method, path, { body: { idempotencyKey: crypto.randomUUID() } });
    assert.equal(status, 401, `${method} ${path} 未登录时返回了 ${status}`);
  }
});

test("普通用户打内容管理接口：同样进不去，用户端 Cookie 在这里没有任何用处", { skip: SKIP_USER }, async () => {
  for (const path of CONTENT_ADMIN_READ_ROUTES) {
    const { status } = await request("GET", path, { cookie: USER });
    assert.equal(status, 401, `GET ${path} 拿着用户 Cookie 返回了 ${status}`);
  }

  for (const [method, path] of CONTENT_ADMIN_WRITE_ROUTES) {
    const { status } = await request(method, path, {
      cookie: USER,
      body: { idempotencyKey: crypto.randomUUID() },
    });
    assert.equal(status, 401, `${method} ${path} 拿着用户 Cookie 返回了 ${status}`);
  }
});

test("管理端 Cookie 的取值域由仓储决定：谁是管理员不是由 Cookie 自己说了算", { skip: SKIP }, async () => {
  // ⚠️ 这条断言的是**真实设计**，不是「Cookie 不可伪造」——在 Mock 认证下
  // 管理端 Cookie 就是 `mock_admin_id=<id>`，本身**没有凭据**，
  // `/api/admin/auth/mock-login` 对任何人开放。这正是 `ENABLE_MOCK_ADMIN` 的含义：
  // 它的开关是「这个接口存不存在」，不是「密码对不对」。
  //
  // 因此真正要守的是**取值域**：id 必须命中仓储里一个**有管理权限**的账号。
  // 编一个 id 出来不会产生身份，拿一个存在但不是管理员的 id 也不行。
  // 这条边界由 `lib/api/adminRoute.ts` 一处判定（`getSessionAdmin()` → 角色 → 状态），
  // 与 `tests/admin.test.mjs` 的同类断言同源。
  const admin = await request("GET", "/api/admin/content/announcements", {
    cookie: "mock_admin_id=admin-1",
  });
  assert.equal(admin.status, 200, "预置的管理员账号应当可用（Mock 认证下它就是唯一的凭据）");

  for (const [id, expected] of [
    ["admin-2", 403],
    ["admin-3", 403],
    ["admin-999", 401],
  ]) {
    const { status } = await request("GET", "/api/admin/content/announcements", {
      cookie: `mock_admin_id=${id}`,
    });
    assert.equal(
      status,
      expected,
      `mock_admin_id=${id} 拿到了 ${status}——管理权限必须由仓储里的账号决定`,
    );
  }
});

test("管理员身份可用：内容管理列表能读出来，且读到的是仓储里的真实记录", { skip: SKIP_ADMIN }, async () => {
  const { status, json } = await adminGet("/api/admin/content/announcements");
  assert.equal(status, 200);

  const data = json.data;
  assert.ok(Array.isArray(data.items), "列表响应的形状变了");
  assert.ok(data.items.length > 0, "后台读不到任何公告——列表没有接上仓储");
  assert.equal(typeof data.total, "number");
  assert.ok(data.counts, "列表缺少四种状态的计数，筛选角标会算不出来");

  // 预置记录的图片地址出现在响应里 → 渲染的是仓储数据，不是空壳
  assert.ok(
    data.items.some((item) => item.imageUrl === "/mock/announcement-1.svg"),
    "列表里找不到预置公告",
  );
});

// ——————————————————————— §一 的核心链路（走 HTTP）———————————————————————

test("【§一 主链路】后台 HTTP 改公告图片 → 用户端 HTTP 立刻看到新图片", { skip: SKIP_ADMIN }, async () => {
  const before = await home();
  const target = before.announcements[0];
  assert.ok(target, "用户端首页原本就没有公告，这条链路验不了");

  /**
   * ⚠️ 要改成的目标值由**当前值**推出来（在两张预置图之间来回切），不写死一张。
   *
   * 打的是活服务，Mock 仓储是进程内的内存表：它跨用例、跨整轮运行都留着。
   * 写死 `announcement-2` 的话，第二次运行时「改成那一张」正好是个空操作，
   * `changed` 会是 false ——用例会以一个与它要验的东西（后台改的东西用户端能不能看见）
   * 毫无关系的理由变红。
   */
  const PAGES = ["/mock/announcement-1.svg", "/mock/announcement-2.svg"];
  const nextImage = PAGES.find((url) => url !== target.imageUrl) ?? PAGES[0];

  // —— 管理员在后台改一条公告 ——
  const { status, json } = await adminWrite("PATCH", `/api/admin/content/announcements/${target.id}`, {
    ...announcementForm({ imageUrl: nextImage, alt: "HTTP 改过的公告图" }),
  });
  assert.equal(status, 200, "管理员保存失败了");
  assert.equal(json.data.changed, true, `图片要从「${target.imageUrl}」改成「${nextImage}」，内容确实变了，\`changed\` 却是 false`);

  // —— 用户刷新 ——
  const after = await home();
  const updated = after.announcements.find((item) => item.id === target.id);
  assert.ok(updated, "改完之后用户端看不到这条公告了");
  assert.equal(
    updated.imageUrl,
    nextImage,
    "后台保存成功了，用户端读到的还是旧图片地址——这条链是断的",
  );
  assert.equal(updated.alt, "HTTP 改过的公告图");
});

test("【§一 主链路】后台 HTTP 新建公告 → 用户端 HTTP 看到，且排到 sortOrder 指定的位置", { skip: SKIP_ADMIN }, async () => {
  const before = await home();

  const created = await adminWrite("POST", "/api/admin/content/announcements", {
    ...announcementForm({ title: "HTTP 验收 - 排到最前", alt: "新公告图", sortOrder: 1 }),
  });
  assert.equal(created.status, 200, "管理员新建失败了");
  const newId = created.json.data.updated.id;
  assert.ok(newId, "新建没有返回记录 id");

  const after = await home();
  assert.equal(after.announcements.length, before.announcements.length + 1);
  assert.equal(after.announcements[0].id, newId, "新建的公告没有排到最前");
  assert.equal(after.announcements[0].alt, "新公告图");
});

test("【§一 主链路】后台 HTTP 停用公告 → 用户端 HTTP 少一条；启用后回来", { skip: SKIP_ADMIN }, async () => {
  const before = await home();
  const target = before.announcements[0];

  const disabled = await adminWrite("POST", `/api/admin/content/announcements/${target.id}/disable`);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.changed, true);

  const withoutIt = await home();
  assert.equal(
    withoutIt.announcements.some((item) => item.id === target.id),
    false,
    "后台停用了，用户端还看得见",
  );

  const enabled = await adminWrite("POST", `/api/admin/content/announcements/${target.id}/enable`);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.data.changed, true);

  const back = await home();
  assert.equal(
    back.announcements.some((item) => item.id === target.id),
    true,
    "后台重新启用了，用户端没回来",
  );
});

test("【§一 主链路】后台 HTTP 移除公告 → 用户端不再展示，但后台仍查得到这条记录", { skip: SKIP_ADMIN }, async () => {
  const before = await home();
  const target = before.announcements[0];

  const removed = await adminWrite("POST", `/api/admin/content/announcements/${target.id}/remove`);
  assert.equal(removed.status, 200);
  assert.equal(removed.json.data.changed, true);

  const after = await home();
  assert.equal(
    after.announcements.some((item) => item.id === target.id),
    false,
    "已移除的公告仍然出现在用户端",
  );

  // 软删除：后台详情仍然 200，且 `removed` 为 true
  const detail = await adminGet(`/api/admin/content/announcements/${target.id}`);
  assert.equal(detail.status, 200, "移除把记录删掉了——后台应当仍能查到它");
  assert.equal(detail.json.data.removed, true);
});

test("【§一 主链路】后台 HTTP 把另一张 Banner 提权 → 用户端首页活动图换成那一张", { skip: SKIP_ADMIN }, async () => {
  // ⚠️ 这条用例**不假设预置的那张是哪一张**。HTTP 测试打的是一个**有状态**的活服务，
  // 同一个进程里的用例会互相影响（前一节改过的活动图仍在仓储里），
  // 因此凡是「初始值是什么」的断言都会变成对用例执行顺序的依赖。
  // 改用「相对变化」来断言：记下此刻是哪张，改完必须是**另一张**，停用后必须**回落**。
  const before = await home();
  assert.equal(typeof before.activityImageUrl, "string", "activityImageUrl 不是字符串了");

  const PROMOTED = "/mock/announcement-2.svg";
  assert.notEqual(before.activityImageUrl, PROMOTED, "挑一张与当前不同的素材，否则这条用例证明不了任何事");

  // 备第二张素材，排在**此刻所有素材之后**（此刻不影响首页）。
  // 排序值取「现有最大值 + 1」而不是写死一个数：写死的数在第二次跑这条用例时
  // 会与上一次留下的记录打平，而平局由 id 决定——那会让「它还不是第一张」
  // 这个断言变成对用例历史的依赖。
  const listed = await adminGet("/api/admin/content/banners");
  const maxSortOrder = listed.json.data.items.reduce(
    (max, item) => Math.max(max, item.sortOrder),
    0,
  );
  const created = await adminWrite("POST", "/api/admin/content/banners", {
    title: "HTTP 验收 - 备用活动图",
    imageUrl: PROMOTED,
    alt: "备用活动图",
    sortOrder: Math.min(maxSortOrder + 1, 9999),
    enabled: true,
  });
  assert.equal(created.status, 200, "管理员新建活动图失败了");
  const secondId = created.json.data.updated.id;

  const stillFirst = await home();
  assert.equal(
    stillFirst.activityImageUrl,
    before.activityImageUrl,
    "排序靠后的 Banner 抢到了首页展示位",
  );

  // 提到最前：`sortOrder` 取 0（允许的最小值），这样它是**唯一**的第一名，
  // 不必依赖平局时的 id 决出顺序
  const promoted = await adminWrite("PATCH", `/api/admin/content/banners/${secondId}`, {
    title: "HTTP 验收 - 提权后的活动图",
    imageUrl: PROMOTED,
    alt: "提权后的活动图",
    sortOrder: 0,
    enabled: true,
  });
  assert.equal(promoted.status, 200);

  const after = await home();
  assert.equal(
    after.activityImageUrl,
    PROMOTED,
    "后台改了 Banner 排序，用户端首页还是旧的那张（用户端必须只展示当前有效的那一张）",
  );
  assert.equal(typeof after.activityImageUrl, "string", "用户端活动位被改成了轮播");

  // 停用当前这张 → 回落成「此刻启用的里面排最前的那一张」，而不是留一张停用的图
  const disabled = await adminWrite("POST", `/api/admin/content/banners/${secondId}/disable`);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.changed, true);

  const fallenBack = await home();
  assert.notEqual(fallenBack.activityImageUrl, PROMOTED, "停用的活动图仍然占着首页展示位");
  assert.equal(
    fallenBack.activityImageUrl,
    before.activityImageUrl,
    "停用当前 Banner 之后没有回落到上一张启用中的素材",
  );
});

test("【§一 主链路】后台 HTTP 改快捷入口文案 → 用户端首页 HTML 里就是新文案", { skip: SKIP_ADMIN }, async () => {
  const BASELINE = { label: "考核入驻", path: "/join" };
  const CHANGED = { label: "护航入驻", path: "/companions" };

  /**
   * ⚠️ 先把入口**复位到一个已知状态**，再开始断言。
   *
   * 不这么做的话，「首页原本没有「考核入驻」」这句就变成对**用例执行历史**的依赖：
   * 打的是活服务，上一次跑到一半失败留下的状态会带进这一次。
   * 复位这一步本身也顺带验证了「改回来也生效」——它不是准备动作，是断言的一部分。
   */
  const baseline = await adminWrite("PATCH", "/api/admin/content/quick-entries/join", {
    ...quickEntryForm({ ...BASELINE, icon: "join", sortOrder: 30 }),
  });
  assert.equal(baseline.status, 200, "把入口复位到基准状态失败了");

  const start = await request("GET", "/");
  assert.equal(start.status, 200);
  assert.ok(start.html.includes(BASELINE.label), "首页没有渲染基准状态的入口文案");
  assert.ok(start.html.includes(`href="${BASELINE.path}"`), "首页没有渲染基准状态的入口地址");

  // —— 管理员在后台改文案与地址 ——
  const updated = await adminWrite("PATCH", "/api/admin/content/quick-entries/join", {
    ...quickEntryForm({ ...CHANGED, icon: "join", sortOrder: 30 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.changed, true);

  // —— 用户刷新首页（Server Component 的服务端渲染 HTML）——
  const refreshed = await request("GET", "/");
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.html.includes(CHANGED.label), "后台改了文案，首页 HTML 里没有它");
  assert.equal(refreshed.html.includes(BASELINE.label), false, "首页还渲染着旧文案");
  assert.ok(
    refreshed.html.includes(`href="${CHANGED.path}"`),
    "入口地址没有跟着改——后台改的是文案，用户端跳的还是旧地址",
  );

  // 复原，避免影响同一批里的其它用例（也让这条用例可以反复跑）
  const restored = await adminWrite("PATCH", "/api/admin/content/quick-entries/join", {
    ...quickEntryForm({ ...BASELINE, icon: "join", sortOrder: 30 }),
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.changed, true, "改回基准状态没有被算成一次真实改动");
});

test("【§一 主链路】后台 HTTP 停用快捷入口 → 用户端首页少一格，重新启用后回来", { skip: SKIP_ADMIN }, async () => {
  const ID = "complaint";
  const LABEL = "投诉客服专区";

  // ⚠️ 先复位成启用（同「改文案」那条的理由：活服务的内存数据会跨运行留下）。
  // 不这么做的话，上一次跑到一半失败留下的「已停用」会让这一次的停用变成空操作，
  // 断言 `changed === true` 会红在一个与主链路无关的地方
  const baseline = await adminWrite("POST", `/api/admin/content/quick-entries/${ID}/enable`);
  assert.equal(baseline.status, 200, "把入口复位到启用状态失败了");

  const before = await request("GET", "/");
  assert.ok(before.html.includes(LABEL), `基准状态下首页没有「${LABEL}」这一格，本用例无从下手`);

  const disabled = await adminWrite("POST", `/api/admin/content/quick-entries/${ID}/disable`);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.data.changed, true, "从启用改成停用，`changed` 却是 false");

  const without = await request("GET", "/");
  assert.equal(without.html.includes(LABEL), false, "停用的入口仍然渲染在首页上");

  const enabled = await adminWrite("POST", `/api/admin/content/quick-entries/${ID}/enable`);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.json.data.changed, true, "从停用改回启用，`changed` 却是 false");

  const back = await request("GET", "/");
  assert.ok(back.html.includes(LABEL), "重新启用后入口没有回到首页");
});

// ——————————————————————————— 路径安全（§七）———————————————————————————

test("危险地址过不了 HTTP 这一关：400，且用户端与后台都没有这条记录", { skip: SKIP_ADMIN }, async () => {
  const before = await adminGet("/api/admin/content/quick-entries");
  const beforeCount = before.json.data.items.length;

  const attempts = [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "//evil.example/x",
    "https://evil.example/x",
    "data:text/html,<script>alert(1)</script>",
    "/\\evil.example",
    "join",
  ];

  for (const path of attempts) {
    const { status, json } = await adminWrite("POST", "/api/admin/content/quick-entries", {
      ...quickEntryForm({ path }),
    });
    assert.equal(status, 400, `危险地址「${path}」没有被接口挡住（返回 ${status}）`);
    assert.ok(json.error?.message, "400 响应里应当有一句可读的错误说明");
  }

  const after = await adminGet("/api/admin/content/quick-entries");
  assert.equal(after.json.data.items.length, beforeCount, "被拒绝的写入仍然建出了记录");

  // 用户端也不该出现这些地址
  const { html } = await request("GET", "/");
  for (const scheme of ["javascript:", "//evil.example", "data:text/html"]) {
    assert.equal(
      stripScripts(html).includes(scheme),
      false,
      `用户端首页 HTML 里出现了危险地址「${scheme}」`,
    );
  }
});

test("合法站内地址在 HTTP 这一关被接受：拒绝的是危险地址，不是所有地址", { skip: SKIP_ADMIN }, async () => {
  const created = [];

  for (const path of ["/join", "/placeholder?title=点单权益", "/complaints#top"]) {
    const { status, json } = await adminWrite("POST", "/api/admin/content/quick-entries", {
      // ⚠️ 文案要短于 `CONTENT_LABEL_MAX_LENGTH`（8）：这个用例要证明的是**地址**被接受，
      // 文案超长会以另一个理由 400，那样连「地址到底过没过」都测不出来
      ...quickEntryForm({ path, label: "合法路径" }),
    });
    assert.equal(status, 200, `合法站内路径「${path}」被误拒了`);
    assert.equal(
      json.data.path,
      path,
      `「${path}」通过了校验，写进去的却是「${json.data.path}」——校验看到的和存下去的不是同一个字符串`,
    );
    created.push(json.data.id);
  }

  // 收拾现场：这三条是用来证明「合法地址能进能出」的，不该留在用户端首页上
  for (const id of created) {
    const { status } = await adminWrite("POST", `/api/admin/content/quick-entries/${id}/remove`);
    assert.equal(status, 200, "验收用例建出来的入口没有收拾干净");
  }
});

// ——————————————————————— 幂等 / 校验 / 不信任客户端 ———————————————————————

test("幂等键真的过了网络：同一个键两次 POST 只建一条记录", { skip: SKIP_ADMIN }, async () => {
  const idempotencyKey = crypto.randomUUID();
  const form = announcementForm({ title: "HTTP 验收 - 幂等" });

  const before = await adminGet("/api/admin/content/announcements");

  const first = await request("POST", "/api/admin/content/announcements", {
    cookie: ADMIN,
    body: { ...form, idempotencyKey },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.data.replayed, false);

  const second = await request("POST", "/api/admin/content/announcements", {
    cookie: ADMIN,
    body: { ...form, idempotencyKey },
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.replayed, true, "同一个幂等键的第二次请求没有被认出来");
  assert.equal(second.json.data.changed, false);
  assert.equal(
    second.json.data.updated.id,
    first.json.data.updated.id,
    "重放返回的不是第一次建出来的那条记录",
  );

  const after = await adminGet("/api/admin/content/announcements");
  assert.equal(
    after.json.data.items.length,
    before.json.data.items.length + 1,
    "同一个幂等键建出了两条记录",
  );
});

test("缺少或格式非法的幂等键：400，且不写任何数据", { skip: SKIP_ADMIN }, async () => {
  const before = await adminGet("/api/admin/content/announcements");

  for (const body of [
    { ...announcementForm() }, // 完全没有幂等键
    { ...announcementForm(), idempotencyKey: "" },
    { ...announcementForm(), idempotencyKey: "short7!" }, // 长度不够，且带非法字符
    { ...announcementForm(), idempotencyKey: "has space" }, // 合法长度，但带非法字符
    { ...announcementForm(), idempotencyKey: "a".repeat(65) }, // 超长（上限 64）
    { ...announcementForm(), idempotencyKey: "带中文的键" },
    { ...announcementForm(), idempotencyKey: 12345 },
  ]) {
    const { status } = await request("POST", "/api/admin/content/announcements", {
      cookie: ADMIN,
      body,
    });
    assert.equal(status, 400, `幂等键不合法时返回了 ${status}`);
  }

  const after = await adminGet("/api/admin/content/announcements");
  assert.equal(after.json.data.items.length, before.json.data.items.length);
});

test("服务端不信任客户端 actor：请求体里塞 actorId / role 不会改变审计里的操作者", { skip: SKIP_ADMIN }, async () => {
  const idempotencyKey = crypto.randomUUID();
  const { status } = await request("POST", "/api/admin/content/announcements", {
    cookie: ADMIN,
    body: {
      ...announcementForm({ title: "HTTP 验收 - 伪造操作者" }),
      idempotencyKey,
      actorId: "someone-else",
      actorRole: "superadmin",
      actorName: "冒充者",
      id: "a1",
      createdAt: "1999-01-01T00:00:00.000Z",
      updatedAt: "1999-01-01T00:00:00.000Z",
      removedAt: "1999-01-01T00:00:00.000Z",
    },
  });
  assert.equal(status, 200);

  // 审计只能从管理端接口查（用户端没有任何入口），这里断言的是**接口层面的两条事实**：
  // 记录的服务端字段没有被客户端改写，且新记录确实建出来了（说明该生效的字段生效了）
  //
  // ⚠️ 不带 `removal` 参数：它只接受空值 / `active` / `removed`（严格解析，其它一律 400）。
  // 刚建出来的公告没有被移除，本来就在默认的 `active` 这一档里
  const list = await adminGet("/api/admin/content/announcements");
  const created = list.json.data.items.find((item) => item.title === "HTTP 验收 - 伪造操作者");
  assert.ok(created, "新建的记录没找到——该生效的字段反而没生效");
  assert.notEqual(created.id, "a1", "客户端塞进来的 id 生效了");
  assert.notEqual(created.createdAt, "1999-01-01T00:00:00.000Z", "客户端改动了 createdAt");
  assert.equal(created.removed, false, "客户端凭请求体把记录标记成了已移除");
});

test("后台列表 DTO 不带正文与内部字段，但带运营需要的状态与计数", { skip: SKIP_ADMIN }, async () => {
  const { json } = await adminGet("/api/admin/content/announcements");
  const item = json.data.items[0];
  assert.ok(item);

  for (const key of ["id", "title", "imageUrl", "alt", "enabled", "sortOrder", "createdAt", "updatedAt", "removed"]) {
    assert.ok(key in item, `后台列表缺少「${key}」——运营没法在这一页做完整判断`);
  }
  // 后台 DTO 里不该出现 `removedAt` 这个内部时间戳：它是软删除的实现细节，
  // 界面上要的是「移除了没有」这一个布尔
  assert.equal("removedAt" in item, false, "后台 DTO 泄漏了内部字段 removedAt");
});

test("用户端 DTO 不带任何后台字段：拿用户身份读到的公告里没有 enabled / sortOrder / removed", { skip: SKIP }, async () => {
  const data = await home();
  assert.ok(Array.isArray(data.announcements));

  for (const item of data.announcements) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ["alt", "id", "imageUrl"],
      "用户端公告 DTO 里出现了后台字段——「哪些看得见」会因此变成前端自己的判断",
    );
  }

  for (const shortcut of data.shortcuts) {
    assert.deepEqual(
      Object.keys(shortcut).sort(),
      ["href", "icon", "id", "label"],
      "用户端快捷入口 DTO 的字段集变了",
    );
  }

  // 首页整体也没有把后台概念漏出去
  assert.deepEqual(
    Object.keys(data).sort(),
    ["activityImageUrl", "announcements", "sections", "shortcuts"],
    "首页取数的顶层字段集变了",
  );
});

// ——————————————————————————— 协议（§一 / §四）———————————————————————————

test("协议管理：用户端仍然只有 GET，且五类内容一次返回", { skip: SKIP }, async () => {
  const { status, json } = await request("GET", "/api/agreements");
  assert.equal(status, 200);

  const tabs = json.data.tabs;
  assert.deepEqual(
    tabs.map((tab) => tab.type),
    ["user", "privacy", "companion", "platform", "version"],
    "用户端协议页签的五类内容或顺序变了",
  );

  // 用户端拿到的协议对象里没有配置字段
  for (const tab of tabs) {
    if (!tab.agreement) continue;
    for (const key of ["enabled", "removedAt", "createdAt"]) {
      assert.equal(key in tab.agreement, false, `用户端协议 DTO 泄漏了「${key}」`);
    }
  }
});

test("协议管理：用户端没有任何写入口（只读是产品约束，不只是没做）", { skip: SKIP }, async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const response = await fetch(new URL("/api/agreements", BASE), { method });
    assert.ok(
      response.status === 404 || response.status === 405,
      `用户端协议接口出现了 ${method}（返回 ${response.status}）——它必须是只读的`,
    );
  }

  // 协议页面上没有保存 / 编辑入口
  const page = await request("GET", "/agreements");
  assert.equal(page.status, 200);
  for (const forbidden of ["保存", "编辑协议", "确认修改"]) {
    assert.equal(
      stripScripts(page.html).includes(forbidden),
      false,
      `协议页面上出现了「${forbidden}」——用户端不应当有编辑入口`,
    );
  }
});

test("【§一 主链路】后台 HTTP 改协议正文 → 版本号递增，用户端 HTTP 立刻读到新正文", { skip: SKIP_ADMIN }, async () => {
  const list = await adminGet("/api/admin/content/agreements");
  assert.equal(list.status, 200, "后台读不到协议列表");

  // ⚠️ 断言的是**五类齐全**，不是「一共五条」：同一类协议可以有多份历史版本
  // （预置数据里 user 与 platform 就各有两版）。把条数写成 5，等于把
  // 「历史上只留一版」这条实现细节当成了契约，多存一版历史就会把用例打红
  assert.deepEqual(
    [...new Set(list.json.data.items.map((item) => item.type))].sort(),
    ["companion", "platform", "privacy", "user", "version"],
    "后台协议列表没有覆盖固定的五类",
  );

  // 要改的是**用户此刻正在读的那一份**——由用户端自己指认，不靠写死 id 去猜
  const targetId = await currentAgreementId("user");
  const detail = await adminGet(`/api/admin/content/agreements/${targetId}`);
  assert.equal(detail.status, 200, `后台读不到协议详情 ${targetId}`);

  const target = detail.json.data;
  const sections = target.sections;
  assert.ok(Array.isArray(sections) && sections.length > 0, "协议详情里没有正文");

  const markerText = `HTTP 验收写入的正文 ${crypto.randomUUID()}`;
  const patched = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: target.title,
    enabled: true,
    sections: [{ heading: sections[0].heading, paragraphs: [markerText] }],
  });
  assert.equal(patched.status, 200, "管理员保存协议正文失败了");
  assert.equal(patched.json.data.changed, true, "正文确实变了，`changed` 却是 false");

  const before = target.version;
  const after = patched.json.data.version;
  assert.notEqual(after, before, "改了正文，版本号却没有变化——协议正文更新没有版本化");
  assert.ok(
    versionValue(after) > versionValue(before),
    `版本号只变了长相没有变大小：「${before}」→「${after}」。递增意味着新版本要比旧版本大，否则「哪一份是当前生效的」将无法回答`,
  );

  // —— 用户刷新协议页 ——
  const publicAfter = await request("GET", "/api/agreements");
  const userTab = publicAfter.json.data.tabs.find((tab) => tab.type === "user");
  assert.ok(userTab?.agreement, "用户端读不到用户协议了");
  assert.equal(userTab.agreement.id, targetId, "用户端读到的不是刚才改的那一份协议");
  assert.equal(userTab.agreement.version, patched.json.data.version, "用户端读到的版本号不是最新版本");
  assert.equal(
    JSON.stringify(userTab.agreement.sections).includes(markerText),
    true,
    "后台保存了协议正文，用户端读到的还是旧正文——这条链是断的",
  );

  // 复原，并把「改回去也立刻生效」一并断言掉（否则这条用例会污染后续所有协议用例）
  const restored = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: target.title,
    enabled: true,
    sections,
  });
  assert.equal(restored.status, 200);

  const publicRestored = await request("GET", "/api/agreements");
  const restoredTab = publicRestored.json.data.tabs.find((tab) => tab.type === "user");
  assert.equal(
    JSON.stringify(restoredTab.agreement.sections).includes(markerText),
    false,
    "正文改回去了，用户端还读得到验收写入的那一段",
  );
});

test("协议管理：停用一类协议之后用户端显示「内容暂未配置」，但页签仍在", { skip: SKIP_ADMIN }, async () => {
  const TYPE = "version";

  /**
   * ⚠️ 同一类协议**可以有多份启用中的版本**（预置数据里就有），用户端取其中版本号最高的一份。
   * 只停用一份，用户端会回落到另一份，「这一类在用户端没有内容」这个状态就永远到不了。
   * 因此这里停用的是**该类当前全部启用中的记录**，并记下来，用例结束再逐一启用回去。
   */
  const list = await adminGet("/api/admin/content/agreements");
  const actives = list.json.data.items.filter((item) => item.type === TYPE && item.enabled);
  assert.ok(actives.length > 0, `后台列表里没有启用中的「${TYPE}」协议——本用例无从下手`);

  for (const item of actives) {
    const { status } = await adminWrite("POST", `/api/admin/content/agreements/${item.id}/disable`);
    assert.equal(status, 200, `停用「${item.id}」失败了`);
  }

  const publicAfter = await request("GET", "/api/agreements");
  const tab = publicAfter.json.data.tabs.find((item) => item.type === TYPE);
  assert.ok(tab, "停用之后页签整个消失了——五类内容的页签是固定的");
  assert.equal(tab.agreement, null, "停用的协议仍然下发到用户端");
  assert.ok(tab.label, "页签名称不应当因为内容停用而消失");

  // —— 逐份启用回去，用户端恢复到停用前的样子 ——
  for (const item of actives) {
    const { status, json } = await adminWrite("POST", `/api/admin/content/agreements/${item.id}/enable`);
    assert.equal(status, 200);
    assert.equal(json.data.changed, true, `重新启用「${item.id}」没有算成一次真实改动`);
  }

  const back = await request("GET", "/api/agreements");
  const restored = back.json.data.tabs.find((item) => item.type === TYPE);
  assert.ok(restored.agreement, "重新启用之后协议没有回到用户端");

  // 恢复到的不只是「有内容」，而是**原来那一份**：版本最高的那条重新成为当前生效的
  const expected = actives.reduce((best, item) =>
    versionValue(item.version) > versionValue(best.version) ? item : best,
  );
  assert.equal(
    restored.agreement.id,
    expected.id,
    "重新启用之后，用户端读到的不是版本最高的那一份——版本选择规则没有生效",
  );
});

test("协议正文不接受 HTML：试图写入标签不会变成可执行内容", { skip: SKIP_ADMIN }, async () => {
  const targetId = await currentAgreementId("user");
  const detail = await adminGet(`/api/admin/content/agreements/${targetId}`);
  const sections = detail.json.data.sections;

  const htmlAttempt = "<script>alert(1)</script>";
  const { status, json } = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: detail.json.data.title,
    enabled: true,
    sections: [{ heading: "HTTP 验收", paragraphs: [htmlAttempt] }],
  });

  // 两条都可以是「对」的：要么**当场被校验拒绝**（400），要么被当成**纯文本**存下来。
  // 不可以的是它变成了一段真的 HTML。两条分支各自断言，不让「什么都没发生」蒙混过去。
  assert.ok(status === 200 || status === 400, `写入 HTML 的请求返回了 ${status}`);
  const storedAsText = status === 200;

  if (storedAsText) {
    // 走了「当纯文本收下」这条路：正文里现在必须**真的有这串字符**。
    // 不查这一条的话，「接口 200 但把它悄悄丢掉了」也会让下面的页面断言全绿
    const after = await adminGet(`/api/admin/content/agreements/${targetId}`);
    assert.equal(
      JSON.stringify(after.json.data.sections).includes(htmlAttempt),
      true,
      "接口回了 200，正文里却没有这串字符——它被静默丢掉了，用户会读到一个少了一段正文的协议",
    );
  } else {
    assert.ok(json.error?.message, "400 响应里应当有一句可读的错误说明，告诉运营该改哪里");
  }

  // —— 用户端 ——
  const page = await request("GET", "/agreements");
  /**
   * ⚠️ 先摘掉 Next 自己的 `<script>` 再断言。
   *
   * `<script>` 里装的是 RSC 的 flight 载荷（页面上每一段文本都会原样进那个字符串），
   * 它既不是页面正文、也不是可执行的标签。不加这一层，`includes` 会把载荷里的
   * 字符串一起算上，于是「把标签写得像 XML 一点」就能让这条用例红得莫名其妙。
   */
  const visible = stripScripts(page.html);
  assert.equal(
    visible.includes(htmlAttempt),
    false,
    "协议页面上出现了未转义的用户可控 HTML——用户端存在注入面",
  );
  assert.equal(
    /<script[^>]*>\s*alert\(1\)/.test(visible),
    false,
    "协议正文里的标签被真的解析成了脚本",
  );
  // 反过来也要能看见：存下来了就必须以**转义形态**出现在页面上，
  // 否则上面两条会因为「它根本没显示」而假绿
  if (storedAsText) {
    assert.ok(
      visible.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
      "正文存下来了，页面上却看不到它转义之后的形态——用户读到的东西和后台存的东西对不上",
    );
  }

  const restored = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: detail.json.data.title,
    enabled: true,
    sections,
  });
  assert.equal(restored.status, 200);
});

// ——————————————————————————— 工具 ———————————————————————————

/**
 * 用户端此刻正在读的那一份协议记录的 id。
 *
 * ⚠️ **不写死 id**。仓储里同一类协议可以有多份版本，哪一份生效是
 * `pickCurrentAgreements()` 按「启用 + 版本号最高」算出来的——写死 `ag-user-110`
 * 的用例，在预置数据多一版之后就悄悄变成了「测另一条记录」，而它仍然会全绿。
 * 让**用户端自己**说出它在读哪一份，才是在测「后台改的正是用户看到的那一份」。
 *
 * 该类当前一份启用中的都没有时（可能是上一次跑到一半留下的），退回后台列表里
 * 版本号最高的那条：那条正是重新启用后会被选中的一份。
 */
async function currentAgreementId(type) {
  const { json } = await request("GET", "/api/agreements");
  const tab = json.data.tabs.find((item) => item.type === type);
  assert.ok(tab, `用户端没有「${type}」这一类协议`);
  if (tab.agreement) return tab.agreement.id;

  const list = await adminGet("/api/admin/content/agreements");
  const candidates = list.json.data.items.filter((item) => item.type === type);
  assert.ok(candidates.length > 0, `后台列表里没有「${type}」类协议`);
  return candidates.reduce((best, item) =>
    versionValue(item.version) > versionValue(best.version) ? item : best,
  ).id;
}

/** 去掉 `<script>` 后再做「页面上看得见的文字」的断言（同 `http-smoke.test.mjs`）。 */
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

/**
 * 把 `1.2.0` 这样的版本号折成一个可比较的数。
 *
 * 只在**测试**里做这件事：产品代码里版本号是字符串（它要显示给人看，
 * 也要能容下 `1.2.0-beta` 这类后缀），而这里要回答的问题只有一个——
 * 「新的那个是不是比旧的大」。
 */
function versionValue(version) {
  return version
    .split(".")
    .map((segment) => (Number.isFinite(Number(segment)) ? Number(segment) : 0))
    .reduce((total, segment) => total * 1000 + segment, 0);
}
