/**
 * P8E-1「浏览器真实链路」的证据脚本（**手动运行，不进 `pnpm test`**）。
 *
 * 为什么单独一个文件而不是一条 `.test.mjs`：它做的事和 `httpContentAdmin.test.mjs`
 * 高度重叠，区别只在**输出形式**——它把「改动前 / 改动后」的用户端原文并排打出来，
 * 供人工一眼核对，而测试文件只给通过/失败。把它塞进测试套件只会让同一件事跑两遍。
 *
 * 用法（服务已在跑）：
 *   node tests/manual/browserChain.mjs http://localhost:3105
 *
 * 它模拟的是浏览器在这一页上真正发出的请求序列：
 * 后台页面 → 管理员 Cookie → 写接口；用户端页面 → `GET /`（Server Component
 * 渲染出来的 HTML）与 `GET /api/home`（首页客户端再拉的那一份数据）。
 * 每一步都**改完再改回去**，跑完不留痕。
 */

const BASE = process.argv[2] ?? "http://localhost:3105";

let adminCookie = null;
let failures = 0;

async function req(method, path, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, BASE), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: safeJson(text) };
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const adminGet = (path) => req("GET", path, { cookie: adminCookie });
const adminWrite = (method, path, body = {}) =>
  req(method, path, { cookie: adminCookie, body: { idempotencyKey: crypto.randomUUID(), ...body } });

const home = async () => (await req("GET", "/api/home")).json.data;
const homeHtml = async () => (await req("GET", "/")).text;
const agreementsHtml = async () => (await req("GET", "/agreements")).text;

function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✔" : "✘"} ${label}${detail ? `　→ ${detail}` : ""}`);
}

/** 页面上出现过的图片地址，按出现次数统计。 */
function images(html) {
  return [...html.matchAll(/\/mock\/[a-z0-9-]+\.svg/g)].map((match) => match[0]);
}

// ————————————————————————— 链路 —————————————————————————

console.log(`\n=== P8E-1 用户端真实链路（${BASE}）===\n`);

{
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  adminCookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
check("管理员登录拿到会话 Cookie", adminCookie.length > 0, adminCookie);

// —— A. 首页公告：改一张图 ——
console.log("\n[A] 首页公告（图片轮播）");
{
  const list = await adminGet("/api/admin/content/announcements");
  const target = list.json.data.items[0];
  const before = await home();
  const beforeItem = before.announcements.find((item) => item.id === target.id);

  const PAGES = ["/mock/announcement-1.svg", "/mock/announcement-2.svg"];
  const next = PAGES.find((url) => url !== beforeItem.imageUrl) ?? PAGES[0];

  console.log(`  后台改「${target.title}」的图片：${beforeItem.imageUrl} → ${next}`);
  const write = await adminWrite("PATCH", `/api/admin/content/announcements/${target.id}`, {
    title: target.title,
    imageUrl: next,
    alt: target.alt,
    sortOrder: target.sortOrder,
    enabled: true,
  });
  check("后台保存返回 200", write.status === 200, `status=${write.status}`);

  const after = await home();
  const afterItem = after.announcements.find((item) => item.id === target.id);
  check("用户端 /api/home 读到的图片变成了新的", afterItem?.imageUrl === next, afterItem?.imageUrl);

  const html = await homeHtml();
  check("用户端首页 HTML 里渲染出了新图片", images(html).includes(next), `页面上共有 ${images(html).length} 张公告图`);

  // 改回去
  const back = await adminWrite("PATCH", `/api/admin/content/announcements/${target.id}`, {
    title: target.title,
    imageUrl: beforeItem.imageUrl,
    alt: beforeItem.alt,
    sortOrder: target.sortOrder,
    enabled: true,
  });
  check("改回原图也生效", back.status === 200);
}

// —— B. 首页活动位：换一张 Banner ——
console.log("\n[B] 首页活动 Banner（用户端只显示一张）");
{
  const before = await home();

  // 换一张**看得出不一样**的图：预置素材里只有一张活动图，因此从公告图里借一张。
  // 借图不是为了好看，是为了让「后台改了 → 用户端变了」在这份输出里肉眼可辨——
  // 用同一张图做前后对比，即使链路是断的也看不出来
  const POOL = ["/mock/promo-activity.svg", "/mock/announcement-2.svg"];
  const next = POOL.find((url) => url !== before.activityImageUrl) ?? POOL[0];

  /**
   * ⚠️ **先**记下此刻启用中的有哪些，再做任何改动。
   *
   * 用户端只认「启用 + 排序最前 + id 最小」的那一条，因此光新建一张是不够的：
   * 后台里可能早就躺着别的启用中的素材，排序打平时由 id 决出胜负，而 id 是随机的。
   * 要让「当前生效的是哪一张」变成确定的，就得把其余的先停用——而**停用了就必须启用回去**。
   * 记在新建之前，收拾现场时才不会漏（漏了的话，这个脚本每跑一次就少一张启用中的图）。
   */
  const beforeList = await adminGet("/api/admin/content/banners?removal=active");
  const previouslyEnabled = beforeList.json.data.items
    .filter((item) => item.enabled)
    .map((item) => item.id);

  const created = await adminWrite("POST", "/api/admin/content/banners", {
    title: `浏览器链路验收 ${Date.now()}`,
    imageUrl: next,
    alt: "浏览器链路验收活动图",
    sortOrder: 0,
    enabled: true,
  });
  check("后台新建一张活动图", created.status === 200, `status=${created.status}`);
  // ⚠️ 活动图的写结果是 `{bannerId, …, updated}`，**不是**扁平的记录本身
  // （快捷入口那组才是扁平的 `AdminQuickEntryItem & {changed, replayed}`）。别照抄。
  const newId = created.json?.data?.updated?.id;

  for (const id of previouslyEnabled) {
    await adminWrite("POST", `/api/admin/content/banners/${id}/disable`);
  }

  const after = await home();
  console.log(`  用户端活动位：${before.activityImageUrl} → ${after.activityImageUrl}`);
  check("用户端活动位仍是**一个字符串**，不是轮播数组", typeof after.activityImageUrl === "string");
  check("只剩一张启用中的，它就是当前生效的那张", after.activityImageUrl === next, after.activityImageUrl);
  check("而且和改动前确实不是同一张", after.activityImageUrl !== before.activityImageUrl);

  const html = await homeHtml();
  check("首页 HTML 里活动位用的是这一张", html.includes(next));

  if (newId) {
    const removed = await adminWrite("POST", `/api/admin/content/banners/${newId}/remove`);
    check("移除这张活动图", removed.status === 200);

    const empty = await home();
    check(
      "一张启用中的都不剩时活动位回落成空串（首页据此隐藏，而不是留一张已移除的图）",
      empty.activityImageUrl === "",
      JSON.stringify(empty.activityImageUrl),
    );
  }

  // 收拾现场：把改动前启用中的逐份启用回去
  for (const id of previouslyEnabled) {
    await adminWrite("POST", `/api/admin/content/banners/${id}/enable`);
  }
  const back = await home();
  check(
    "启用回去之后活动位回到改动前那张",
    back.activityImageUrl === before.activityImageUrl,
    `${back.activityImageUrl}`,
  );
}

// —— C. 首页四宫格：改文案 ——
console.log("\n[C] 首页 QuickEntry（四宫格）");
{
  const entryId = "join";
  const detail = await adminGet(`/api/admin/content/quick-entries/${entryId}`);
  const original = detail.json.data;

  const nextLabel = "护航入驻";
  const write = await adminWrite("PATCH", `/api/admin/content/quick-entries/${entryId}`, {
    label: nextLabel,
    icon: original.icon,
    path: original.path,
    sortOrder: original.sortOrder,
    enabled: true,
  });
  check("后台改文案返回 200", write.status === 200, `status=${write.status}`);

  const html = await homeHtml();
  check("首页 HTML 里出现了新文案", html.includes(nextLabel), nextLabel);
  check("首页 HTML 里不再有旧文案", !html.includes(original.label), original.label);

  const restore = await adminWrite("PATCH", `/api/admin/content/quick-entries/${entryId}`, {
    label: original.label,
    icon: original.icon,
    path: original.path,
    sortOrder: original.sortOrder,
    enabled: true,
  });
  check("改回原文案也生效", restore.status === 200);
}

// —— D. 协议：改正文 ——
console.log("\n[D] 协议（用户端只读）");
{
  const current = (await req("GET", "/api/agreements")).json.data.tabs.find((tab) => tab.type === "user");
  const targetId = current.agreement.id;
  const detail = await adminGet(`/api/admin/content/agreements/${targetId}`);
  const original = detail.json.data;

  const marker = `浏览器链路验收写入的正文 ${Date.now()}`;
  const write = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: original.title,
    enabled: true,
    sections: [{ heading: original.sections[0].heading, paragraphs: [marker] }],
  });
  check("后台保存协议正文返回 200", write.status === 200, `status=${write.status}`);

  const after = (await req("GET", "/api/agreements")).json.data.tabs.find((tab) => tab.type === "user");
  check("版本号递增", after.agreement.version !== original.version, `${original.version} → ${after.agreement.version}`);

  const html = await agreementsHtml();
  check("协议页 HTML 里读到了新正文", html.includes(marker));
  check("协议页上仍然只有一个 GET 接口（用户端没有写入口）", (await req("PATCH", "/api/agreements")).status >= 400);

  const restore = await adminWrite("PATCH", `/api/admin/content/agreements/${targetId}`, {
    title: original.title,
    enabled: true,
    sections: original.sections,
  });
  check("恢复原正文也生效", restore.status === 200);
  const restored = (await req("GET", "/api/agreements")).json.data.tabs.find((tab) => tab.type === "user");
  check("用户端读不到验收写入的那一段了", !JSON.stringify(restored.agreement.sections).includes(marker));
}

console.log(`\n=== ${failures === 0 ? "全部通过" : `${failures} 项失败`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
