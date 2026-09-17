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

/**
 * P7B 用的额外 Mock 身份。
 *
 * 账号切换只发生在接口层（`/api/auth/mock-login` 的请求体里），**用户端页面没有任何
 * 切换入口**；这里用它来覆盖「预置里有申请」的几种状态，以及一条不与其他用例争抢的
 * 申请人身份（`u-1008`：预置里没有申请、也没有任何有效消费，写进去不会影响排行榜）。
 */
const SESSION_JOIN_PENDING = BASE ? await loginAs("u-1002") : null; // 预置「待查看」
const SESSION_JOIN_REVIEWING = BASE ? await loginAs("u-1003") : null; // 预置「审核中」
const SESSION_JOIN_APPROVED = BASE ? await loginAs("u-1004") : null; // 预置「已通过」
const SESSION_JOIN_APPLICANT = BASE ? await loginAs("u-1008") : null; // 预置没有申请

/**
 * 去掉 `<script>` 标签后再做「页面上不该出现某段文字」的断言。
 *
 * 理由：Next 的 HTML 里有两段**不是页面内容**的东西——RSC 的 flight 载荷与
 * Turbopack 的分块文件名（`/_next/static/chunks/05w-twpn2bx9w.js`）。
 * 它们由构建产物决定，会随任何一次改动变化，且长相随机：
 * 「金额不该用 k / w 缩写」这类断言扫到它们就会红，而且红得与断言的本意毫无关系。
 * 因此凡是判断**页面上看得见的文字**的断言，都应当先过一遍这里。
 */
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, "");
}

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
  assert.equal(html.includes("功能开发中"), false, "陪玩列表不该还是占位页");
  // Mock 标注与「绑定规则待确认」必须写在页面上，否则会被当成真实名单与真实预约
  assert.ok(html.includes("陪玩与订单的绑定、定价与排班规则待确认"), "缺少 Mock 与规则待确认说明");
  // 名单来自数据层：至少有一位陪玩、有可用状态筛选
  assert.ok(html.includes("（占位）"), "缺少 Mock 陪玩卡片");
  assert.ok(html.includes("当前可接单"), "缺少可用状态筛选");
  // 二级页面：只有顶部返回，没有底部 TabBar
  assert.ok(html.includes("返回"), "缺少返回入口");
  assert.equal(html.includes(TABBAR_TEXT), false, "/companions 不该显示底部 TabBar");
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

test("登录后 /join 是入驻表单：字段齐全、不承诺回报，且没有底部 TabBar", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/join", SESSION);

  assert.equal(status, 200);
  assert.ok(html.includes("成为护航"));
  assert.equal(html.includes("页面待实现"), false, "入驻页不该还是占位页");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "已登录不该再出现登录引导");

  // 表单字段（u-1001 没有申请，看到的是表单）
  for (const label of ["陪玩昵称", "擅长游戏", "可服务大区", "服务标签", "经验说明", "自我介绍"]) {
    assert.ok(html.includes(label), `入驻表单缺少「${label}」`);
  }
  assert.ok(html.includes("提交入驻申请"), "缺少提交按钮");
  // 游戏选项来自真实游戏目录，不在页面里写死第二份名单
  assert.ok(html.includes("三角洲行动"), "缺少游戏选项");
  // 不承诺任何回报，也不给审核时限
  assert.ok(html.includes("审核规则待确认"), "缺少「审核规则待确认」说明");
  assert.equal(html.includes("开通接单权限"), false, "/join 不该承诺开通权限");
  // 不收集敏感信息：原型里的身份证 / 银行卡 / 真实姓名 / 所在城市都不是可填内容
  for (const forbidden of ["身份证", "银行卡", "真实姓名", "所在城市"]) {
    assert.equal(html.includes(forbidden), false, `入驻表单不该出现「${forbidden}」`);
  }
  // 手机号 / 微信号 / QQ / 邮箱也不是输入项（只在「不采集」那句说明里被提到）
  for (const attribute of [
    'name="phone"',
    'name="wechat"',
    'name="qq"',
    'name="email"',
    'name="realName"',
    'placeholder="手机号',
    'placeholder="微信号',
  ]) {
    assert.equal(html.includes(attribute), false, `入驻表单不该有「${attribute}」字段`);
  }
  assert.ok(html.includes("不采集手机号、微信号"), "联系说明必须写明不采集具体联系方式");
  // 输入框不使用 maxLength 静默截断（超限是给出错误提示，不是悄悄截断）
  assert.equal(/maxlength/i.test(html), false, "入驻表单不该用 maxLength 静默截断");

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

// ——————————————————————————— P6B：优惠券 / 评价 / 鸡腿记录 / 意见反馈 ———————————————————————————

/** P6B 新增的二级页面。地址本身就是登录后要停留的地址（登录不跳走）。 */
const P6B_PAGES = [
  { path: "/coupons", title: "我的优惠券" },
  { path: "/reviews", title: "我的评价" },
  { path: "/tips", title: "鸡腿记录" },
  { path: "/tips/new", title: "送鸡腿" },
  { path: "/suggestions", title: "功能建议" },
  { path: "/suggestions/new", title: "我要反馈" },
];

test("游客打开 P6B 页面：统一登录引导 + 有返回入口 + 没有底部 TabBar", { skip: SKIP }, async () => {
  for (const { path } of P6B_PAGES) {
    const { status, html } = await get(path);
    assert.equal(status, 200, `${path} 不该 404`);
    assert.ok(html.includes(LOGIN_GATE_TEXT), `${path} 未登录时应显示统一登录引导`);
    // 导航栏在鉴权之外：未登录也要有返回入口，不能把人困在登录页上
    assert.ok(html.includes("返回"), `${path} 未登录时缺少返回入口`);
    // 二级页面不带底部 TabBar
    assert.equal(html.includes(TABBAR_TEXT), false, `${path} 不该显示底部 TabBar`);
  }
});

test("登录后 P6B 页面正常打开，且没有底部 TabBar", { skip: SKIP_SESSION }, async () => {
  for (const { path, title } of P6B_PAGES) {
    const { status, html } = await get(path, SESSION);
    assert.equal(status, 200, `${path} 不该 404`);
    assert.equal(html.includes(LOGIN_GATE_TEXT), false, `${path} 已登录不该再出现登录引导`);
    assert.ok(html.includes(title), `${path} 缺少标题「${title}」`);
    assert.equal(html.includes(TABBAR_TEXT), false, `${path} 不该显示底部 TabBar`);
  }
});

test("评价表单按订单地址进入：登录后能打开（或按服务端判定给出不可评价的原因）", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/reviews/new/ord-seed-1001-08", SESSION);

  assert.equal(status, 200);
  assert.equal(html.includes(LOGIN_GATE_TEXT), false);
  // 页面标题与「能不能评价」的结论都来自服务端：要么是表单，要么写明原因
  assert.ok(html.includes("发表评价"));
  assert.ok(
    html.includes("提交评价") || html.includes("不可评价") || html.includes("已评价"),
    "既没有表单也没有给出不可评价的原因",
  );
});

test("游客打开评价表单也是登录拦截，不是 404", { skip: SKIP }, async () => {
  const { status, html } = await get("/reviews/new/ord-seed-1001-08");
  assert.equal(status, 200, "评价表单不该 404");
  assert.ok(html.includes(LOGIN_GATE_TEXT));
  assert.equal(html.includes(TABBAR_TEXT), false);
});

test("/tips/new 只是说明页：写明规则待确认，提交按钮禁用，没有模拟支付", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/tips/new", SESSION);

  assert.equal(status, 200);
  assert.ok(html.includes("规则待确认"), "缺少「规则待确认」说明");
  assert.ok(html.includes("鸡腿价格"), "缺少待确认项：鸡腿价格");
  assert.ok(html.includes("打手结算"), "缺少待确认项：打手结算");
  // 禁用按钮必须同时给出理由，而不是一个灰按钮
  assert.ok(html.includes("暂不可送鸡腿"));
  assert.ok(html.includes("规则待确认，暂不可提交"));
  assert.ok(html.includes("disabled"));
  // 不产生支付请求：没有「模拟支付成功」这类按钮
  assert.equal(html.includes("模拟支付"), false, "/tips/new 不该出现模拟支付入口");
});

test("鸡腿记录接口只有 GET：没有面向用户的创建接口", { skip: SKIP_SESSION }, async () => {
  const write = await fetch(new URL("/api/tips", BASE), {
    method: "POST",
    headers: { cookie: SESSION, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(write.status, 405, "本阶段不该存在创建鸡腿记录的接口");
});

test("鸡腿记录列表只返回原始记录值：没有单价、比例、抽成与到手金额", { skip: SKIP_SESSION }, async () => {
  const response = await fetch(new URL("/api/tips?page=1&pageSize=10", BASE), {
    headers: { cookie: SESSION },
  });
  assert.equal(response.status, 200);

  const { data } = await response.json();
  assert.ok(Array.isArray(data.items));
  assert.ok(data.items.length > 0, "预置的 Mock 记录应当能读到");
  assert.ok(data.counts.all >= data.items.length);

  for (const item of data.items) {
    for (const key of Object.keys(item)) {
      assert.equal(
        /price|amount|ratio|rate|net|commission/i.test(key),
        false,
        `鸡腿记录不该出现未确认字段：${key}`,
      );
    }
    assert.equal(Number.isInteger(item.quantity), true, "数量应为原始记录值（整数）");
    assert.ok(item.paymentStatusLabel);
  }
});

test("优惠券领取幂等：同一个键第二次返回第一次的结果，领取后出现在「我的优惠券」", { skip: SKIP_SESSION }, async () => {
  const centerResponse = await fetch(new URL("/api/coupons?tab=claimable&pageSize=20", BASE), {
    headers: { cookie: SESSION },
  });
  assert.equal(centerResponse.status, 200);
  const center = (await centerResponse.json()).data;
  // 优先挑一张**还能领**的券；同一台服务被跑过一遍之后可能已经没有可领的了，
  // 那时退回到「已经领过」的券——重复领取不产生第二条记录同样要在这里验一遍。
  // （「第一次领取真的写入了记录」由数据层测试覆盖，不依赖服务是不是干净的。）
  const target =
    center.items.find((item) => item.claimable) ?? center.items.find((item) => item.claimed);
  assert.ok(target, "领券中心里至少应有一张可领取或已领取的 Mock 券");

  const key = `smoke-${crypto.randomUUID().slice(0, 18)}`;
  const claim = () =>
    fetch(new URL(`/api/coupons/${encodeURIComponent(target.id)}/claim`, BASE), {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key }),
    });

  const first = await claim();
  assert.equal(first.status, 200);
  const firstBody = (await first.json()).data;

  // 重复领取：不是错误，返回同一条领取记录（不会多出一条）
  const second = await claim();
  assert.equal(second.status, 200);
  const secondBody = (await second.json()).data;
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.claimId, firstBody.claimId);
  assert.equal(secondBody.couponId, firstBody.couponId);

  // 已经领到的券在「我的优惠券」里能查到，且在领券中心变成不可领取
  const owned = (await (
    await fetch(new URL("/api/coupons?tab=owned&pageSize=20", BASE), { headers: { cookie: SESSION } })
  ).json()).data;
  assert.ok(owned.items.some((item) => item.couponId === target.id));

  const after = (await (
    await fetch(new URL("/api/coupons?tab=claimable&pageSize=20", BASE), { headers: { cookie: SESSION } })
  ).json()).data;
  const again = after.items.find((item) => item.id === target.id);
  assert.equal(again.claimable, false);
  assert.equal(again.claimed, true);
  assert.ok(again.reason.length > 0, "不可领取时必须给出原因");
});

test("意见反馈提交幂等：同一个键只写一条，重复提交返回第一次的结果", { skip: SKIP_SESSION }, async () => {
  const key = `smoke-${crypto.randomUUID().slice(0, 18)}`;
  const body = JSON.stringify({
    typeKey: "feature",
    content: "冒烟测试提交的反馈（Mock 文案）",
    contact: "",
    evidence: [],
    idempotencyKey: key,
  });
  const send = () =>
    fetch(new URL("/api/suggestions", BASE), {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body,
    });

  const first = await send();
  assert.equal(first.status, 200);
  const firstBody = (await first.json()).data;
  assert.equal(firstBody.created, true);

  const second = await send();
  assert.equal(second.status, 200);
  const secondBody = (await second.json()).data;
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.suggestionId, firstBody.suggestionId);

  // 列表里只有一条，状态是服务端写的「已提交」，回复为空
  const list = (await (
    await fetch(new URL("/api/suggestions?pageSize=20", BASE), { headers: { cookie: SESSION } })
  ).json()).data;
  const mine = list.items.filter((item) => item.id === firstBody.suggestionId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].content, "冒烟测试提交的反馈（Mock 文案）");
  assert.equal(mine[0].status, "submitted");
  assert.equal(mine[0].statusLabel, "已提交");
  assert.equal(mine[0].reply, "");
  assert.equal(mine[0].repliedAt, null);
});

test("意见反馈的空白与超长内容被接口拒绝，凭证只收图片", { skip: SKIP_SESSION }, async () => {
  const post = (payload) =>
    fetch(new URL("/api/suggestions", BASE), {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `smoke-${crypto.randomUUID().slice(0, 18)}`, ...payload }),
    });

  const blank = await post({ typeKey: "feature", content: "   " });
  assert.equal(blank.status, 400);
  assert.equal((await blank.json()).error.message, "请填写反馈内容");

  const tooLong = await post({ typeKey: "feature", content: "字".repeat(301) });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.message, "反馈内容不能超过 300 个字符");

  const noType = await post({ content: "没问题（Mock 文案）" });
  assert.equal(noType.status, 400);
  assert.equal((await noType.json()).error.message, "请选择反馈类型");

  // 伪造的状态与回复不起作用：接口只认白名单字段，写入的仍是「已提交 + 无回复」
  const forged = await post({
    typeKey: "other",
    content: "伪造状态（Mock 文案）",
    status: "replied",
    reply: "平台已答应补偿（伪造）",
  });
  assert.equal(forged.status, 200);
  const forgedId = (await forged.json()).data.suggestionId;
  const list = (await (
    await fetch(new URL("/api/suggestions?pageSize=20", BASE), { headers: { cookie: SESSION } })
  ).json()).data;
  const item = list.items.find((entry) => entry.id === forgedId);
  assert.equal(item.status, "submitted");
  assert.equal(item.reply, "");
});

test("四个 P6B 接口都要求登录：游客拿到 401 而不是别人的数据", { skip: SKIP }, async () => {
  for (const path of ["/api/coupons?tab=owned", "/api/reviews?tab=reviewed", "/api/tips", "/api/suggestions"]) {
    const response = await fetch(new URL(path, BASE));
    assert.equal(response.status, 401, `${path} 未登录时应返回 401`);
    const body = await response.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    // 响应里不能出现任何数据
    assert.equal("data" in body, false);
  }
});

// ————————————————— P7A：消费等级 / 消费排行榜 / 相关协议 —————————————————

const MINE_PATH = "/mine";

test("游客打开 /rights 是登录拦截，不是 404，也没有底部 TabBar", { skip: SKIP }, async () => {
  const { status, html } = await get("/rights");

  assert.equal(status, 200, "/rights 不该 404");
  assert.ok(html.includes(LOGIN_GATE_TEXT), "/rights 未登录时应显示统一登录引导");
  // 导航在鉴权之外：未登录也要有返回入口，登录后地址仍是 /rights
  assert.ok(html.includes("返回"), "未登录时缺少返回入口");
  assert.equal(html.includes(TABBAR_TEXT), false, "/rights 不该显示底部 TabBar");
});

test("登录后 /rights 显示当前等级、累计金额、进度、差额与全部等级", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/rights", SESSION);

  assert.equal(status, 200);
  assert.equal(html.includes(LOGIN_GATE_TEXT), false);

  // 当前用户 u-1001 的**累计**有效消费是 ¥240.60（既有种子 174.60 + 周期榜预置的今日订单 66.00），
  // 落在最低等级。这里的口径是累计，不随排行榜当前页签变化。
  assert.ok(html.includes("普通老板"), "缺少当前等级名");
  assert.ok(html.includes("240.60"), "缺少累计有效消费金额（两位小数）");
  assert.ok(html.includes("高级老板"), "缺少下一等级名");
  assert.ok(html.includes("59.40"), "缺少升级差额");
  // 进度不是只靠颜色表达：百分比以文字给出
  assert.ok(html.includes("progressbar"), "缺少进度条");
  assert.ok(/\d+%/.test(html), "进度百分比没有以文字给出");

  // 全部启用等级（含门槛）与权益说明都在页面上
  for (const name of ["至尊老板", "金牌老板"]) assert.ok(html.includes(name), `缺少等级「${name}」`);
  assert.ok(html.includes("300.00"), "缺少等级门槛");
  // 停用等级不出现
  assert.equal(html.includes("已停用"), false, "停用等级不该出现在页面上");

  // 两句必须出现的说明：口径 + 当前为 Mock 配置
  assert.ok(html.includes("累计有效消费金额只统计本人"), "缺少统计口径说明");
  assert.ok(html.includes("Mock 等级配置"), "缺少「当前为 Mock 等级配置」说明");
  assert.ok(html.includes("不构成折扣"), "缺少权益说明性声明");

  assert.equal(html.includes(TABBAR_TEXT), false, "/rights 不该显示底部 TabBar");
});

test("消费等级接口要求登录，且只返回当前用户的摘要", { skip: SKIP }, async () => {
  const anonymous = await fetch(new URL("/api/me/consumption-level", BASE));
  assert.equal(anonymous.status, 401);
  const body = await anonymous.json();
  assert.equal(body.error.code, "UNAUTHORIZED");
  assert.equal("data" in body, false);
});

test("消费等级接口的响应里没有订单明细，只有等级摘要", { skip: SKIP_SESSION }, async () => {
  const response = await fetch(new URL("/api/me/consumption-level", BASE), {
    headers: { cookie: SESSION },
  });
  assert.equal(response.status, 200);

  const { data } = await response.json();
  assert.equal(data.available, true);
  // 累计口径：不随排行榜页签变化（这是本阶段刻意保持不变的既有规则）
  assert.equal(data.effectiveSpendAmount, 24060);
  assert.equal(data.currentLevel.name, "普通老板");
  assert.equal(data.amountToNextLevel, 5940);
  assert.ok(data.levels.length > 0);

  const serialized = JSON.stringify(data);
  for (const forbidden of ["orderId", "orderNo", "gameAccountId", "remark", "refundReason"]) {
    assert.equal(serialized.includes(forbidden), false, `等级摘要不该出现 ${forbidden}`);
  }
  // 等级条目里没有配置字段
  assert.equal("enabled" in data.currentLevel, false);
});

test("游客可以打开 /rank：拿到完整榜单，但没有「我的排名」", { skip: SKIP }, async () => {
  const { status, html } = await get("/rank");

  assert.equal(status, 200, "/rank 不该 404");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "/rank 不该要求登录");
  // 榜单内容真实存在：前三名 + 完整榜单 + 口径说明
  assert.ok(html.includes("消费排行榜"), "缺少页面标题");
  assert.ok(html.includes("完整榜单") || html.includes("共 "), "缺少榜单内容");
  // 默认页签是「本周」：口径说明也要是周期口径（按完成时间归属），而不是累计口径
  assert.ok(html.includes("周期榜按所选周期内"), "缺少周期榜的统计口径说明");
  assert.ok(html.includes("完成时间为准"), "周期口径必须写明按完成时间归属");
  assert.ok(html.includes("统计范围："), "缺少统计范围（周期边界应可核对）");
  // 游客不显示「我的排名」，也不提示登录
  assert.equal(html.includes("我的排名"), false, "游客不该看到「我的排名」");
  // 二级页面：没有底部 TabBar
  assert.equal(html.includes(TABBAR_TEXT), false, "/rank 不该显示底部 TabBar");

  // 榜单金额是完整两位小数，没有 k / w 缩写。
  // ⚠️ 这一条必须**排除 script 标签**再判断：Turbopack 的分块文件名是内容哈希，
  // 形如 `/_next/static/chunks/05w-twpn2bx9w.js`，天然会命中 `\d+w\b`。
  // 早先直接扫整页 HTML，是因为当时的哈希恰好没有撞上——那属于运气，不是保证：
  // 换一次构建产物就会红，而且红得跟金额毫无关系。
  const visible = stripScripts(html);
  assert.ok(/¥\d+\.\d{2}/.test(visible), "榜单金额应保留两位小数");
  assert.equal(/\d+k\b|\d+w\b/.test(visible), false, "榜单金额不该使用 k / w 缩写");
});

/** 六个周期与它们的页签文案。 */
const RANKING_PERIODS = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "all", label: "累计" },
];

/** 从页面 HTML 里读出卖的选中页签：选中态同时有 aria-pressed，不只看颜色。 */
function activePeriodTab(html) {
  const pressed = html.match(/aria-pressed="(true|false)"/g) ?? [];
  const active = pressed.filter((value) => value.includes("true"));
  assert.equal(active.length, 1, `应当恰好有一个选中页签，实际有 ${active.length} 个`);

  const match = html.match(/aria-pressed="true"[^>]*>(.*?)<\/button>/);
  assert.ok(match, "选中页签没有渲染出可读的标签");
  return match[1].trim();
}

test("排行榜六个周期都是真实数据：接口逐个返回对应的周期与时间范围", { skip: SKIP }, async () => {
  const seen = new Map();

  for (const { key, label } of RANKING_PERIODS) {
    const response = await fetch(
      new URL(`/api/rankings/consumption?period=${key}&pageSize=50`, BASE),
    );
    assert.equal(response.status, 200, `${key} 不该失败`);
    const { data } = await response.json();

    assert.equal(data.period, key, "响应的周期必须与请求一致");
    assert.equal(data.periodLabel, label);
    // 「现在这一刻」是右开端点：今日 / 本周 / 本月 / 累计 都终止于生成榜单的那一瞬间；
    // 昨日与上月是**已结束**的区间，终止于下一段时间的起点
    if (["today", "week", "month", "all"].includes(key)) {
      assert.equal(data.rangeEnd, data.generatedAt, "时间范围与生成时间应来自同一个瞬间");
    } else {
      assert.ok(Date.parse(data.rangeEnd) <= Date.parse(data.generatedAt));
    }

    if (key === "all") {
      // 累计不限起始时间，口径与消费等级页一致
      assert.equal(data.rangeStart, null);
      assert.ok(data.notice.includes("累计"));
    } else {
      assert.ok(Date.parse(data.rangeStart) > 0, `${key} 缺少起始时间`);
      assert.ok(Date.parse(data.rangeStart) < Date.parse(data.rangeEnd));
      assert.ok(data.notice.includes("完成时间"));
    }

    // 金额降序，名次连续
    data.items.forEach((item, index) => assert.equal(item.rank, index + 1));
    for (let index = 1; index < data.items.length; index += 1) {
      assert.ok(
        data.items[index - 1].effectiveSpendAmount >= data.items[index].effectiveSpendAmount,
        `${key} 的榜单没有按金额降序`,
      );
    }

    seen.set(key, data);
  }

  // 六个周期真的是六份不同的聚合结果，而不是把同一份累计榜换个标题
  const signatures = new Map();
  for (const [key, data] of seen) {
    const signature = data.items.map((item) => `${item.rank}:${item.effectiveSpendAmount}`).join(",");
    assert.equal(signature.length > 0, true, `${key} 不该是空榜`);
    signatures.set(key, signature);
  }
  assert.notEqual(signatures.get("today"), signatures.get("yesterday"));
  assert.notEqual(signatures.get("yesterday"), signatures.get("week"));
  assert.notEqual(signatures.get("lastMonth"), signatures.get("all"));

  // 包含关系：短周期的人不会比长周期多
  assert.ok(seen.get("today").total <= seen.get("week").total);
  assert.ok(seen.get("week").total <= seen.get("all").total);
  assert.ok(seen.get("today").total <= seen.get("month").total);
  assert.ok(seen.get("all").total > seen.get("today").total, "累计应当比今日多");
});

test("上月的相对数据在任何月份都在，且同一个进程里两次请求完全一致", { skip: SKIP }, async () => {
  // 相对时间构造的三位：上月 20 日 / 15 日 / 8 日完成，金额 288.00 / 137.00 / 137.00。
  // 他们不依赖任何绝对日期，因此换个月、跨年、闰年二月再打开这一档，这三位都还在。
  const expected = [
    { nickname: "泊野（占位）", amount: 28800 },
    { nickname: "微凉（占位）", amount: 13700 },
    { nickname: "听澜（占位）", amount: 13700 },
  ];

  const fetchLastMonth = async () => {
    const response = await fetch(
      new URL("/api/rankings/consumption?period=lastMonth&pageSize=50", BASE),
    );
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  const first = await fetchLastMonth();
  assert.equal(first.period, "lastMonth");
  for (const { nickname, amount } of expected) {
    const row = first.items.find((item) => item.nickname === nickname);
    assert.ok(row, `上月榜缺少相对构造的 ${nickname}`);
    assert.equal(row.effectiveSpendAmount, amount, `${nickname} 的金额不对`);
  }

  // 同一个月内两位 137.00 的用户按用户 id 升序：微凉（u-1016）必须排在听澜（u-1021）之前。
  // 只比较这两位的位置，不假设整张榜上只有他们同额——绝对日期订单碰巧同额也不该影响这条规则。
  const indexOf = (nickname) => first.items.findIndex((item) => item.nickname === nickname);
  assert.ok(indexOf("微凉（占位）") < indexOf("听澜（占位）"), "同额并列的第二排序条件失效");

  // 同一进程内榜单不漂移：两次请求的名次与金额逐条相同。
  // 只比榜单内容——`generatedAt` / `rangeEnd` 每次请求都会变，那是「更新时间」而不是漂移。
  const second = await fetchLastMonth();
  assert.deepEqual(second.items, first.items, "同一进程内两次请求的榜单内容不一致");
  assert.equal(second.total, first.total);
  // 时间范围里的起始时间也是固定的：上月已经结束，不会因为多跑一次就变
  assert.equal(second.rangeStart, first.rangeStart);
});

test("非法 period 回 400，不传则用默认周期（本周）", { skip: SKIP }, async () => {
  for (const bad of ["lastWeek", "TODAY", "cumulative", "0", " "]) {
    const response = await fetch(
      new URL(`/api/rankings/consumption?period=${encodeURIComponent(bad)}`, BASE),
    );
    assert.equal(response.status, 400, `period=${bad} 应当被拒绝`);
    const body = await response.json();
    assert.equal(body.error.code, "BAD_REQUEST");
    // 拒绝时不能顺手返回一份榜单——那正是「含义不明的榜单」
    assert.equal("data" in body, false);
  }

  const fallback = await fetch(new URL("/api/rankings/consumption", BASE));
  assert.equal(fallback.status, 200);
  const { data } = await fallback.json();
  assert.equal(data.period, "week", "不传 period 时用原型默认选中的「本周」");
});

test("六个周期的深链接各自选中对应页签，游客全部可用", { skip: SKIP }, async () => {
  const ranges = new Map();

  for (const { key, label } of RANKING_PERIODS) {
    const { status, html } = await get(`/rank?period=${key}`);

    assert.equal(status, 200, `/rank?period=${key} 不该 404`);
    assert.equal(html.includes(LOGIN_GATE_TEXT), false, `游客应当能看「${label}」榜`);
    assert.equal(activePeriodTab(html), label, `?period=${key} 没有选中「${label}」页签`);

    const range = html.match(/统计范围：([^（<]*)（北京时间）/);
    assert.ok(range, `${key} 缺少统计范围`);
    ranges.set(key, range[1].trim());
  }

  // 每个周期的统计范围都不一样，「累计」没有起点
  assert.equal(ranges.get("all").startsWith("不限起始时间"), true);
  assert.notEqual(ranges.get("today"), ranges.get("yesterday"));
  assert.notEqual(ranges.get("week"), ranges.get("month"));

  // 非法周期在**页面地址**里被规范化到默认周期，页面本身照常打开
  const broken = await get("/rank?period=lastWeek&mockDelay=0");
  assert.equal(broken.status, 200, "非法周期不该把页面打挂");
  assert.equal(activePeriodTab(broken.html), "本周", "非法周期应规范化到默认页签");
});

test("切周期的深链接给出该周期的「我的排名」：今日 66.00，累计另算", { skip: SKIP_SESSION }, async () => {
  // u-1001 有一单完成于今日（相对时间构造），因此在今日榜上必然有名次
  const today = await get("/rank?period=today", SESSION);
  assert.equal(today.status, 200);
  assert.equal(activePeriodTab(today.html), "今日");
  assert.ok(today.html.includes("我的排名"), "登录后应显示「我的排名」");
  assert.ok(today.html.includes("66.00"), "今日的「我的排名」金额应为 ¥66.00");
  assert.equal(today.html.includes(LOGIN_GATE_TEXT), false);

  // 昨日没有它的订单：如实说明「这个周期没有有效消费」，而不是编一个名次
  const yesterday = await get("/rank?period=yesterday", SESSION);
  assert.equal(yesterday.status, 200);
  assert.equal(activePeriodTab(yesterday.html), "昨日");
  assert.ok(yesterday.html.includes("我的排名"), "登录后这一块仍然在");
  assert.ok(
    yesterday.html.includes("你在昨日没有已完成的有效消费"),
    "未上榜时应当说明是哪个周期没有消费",
  );

  // 累计口径与消费等级页一致
  const all = await get("/rank?period=all", SESSION);
  assert.equal(all.status, 200);
  assert.equal(activePeriodTab(all.html), "累计");
  assert.ok(all.html.includes("240.60"), "累计口径应当与 /rights 的金额一致");
});

test("登录后 /rank 显示「我的排名」，名次与服务端口径一致", { skip: SKIP_SESSION }, async () => {
  const { html } = await get("/rank", SESSION);

  assert.ok(html.includes("我的排名"), "登录后应显示「我的排名」");
  assert.ok(/¥\d+\.\d{2}/.test(html), "缺少当前用户的消费金额");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false);
});

test("排行榜接口游客可访问，且条目里没有用户标识", { skip: SKIP }, async () => {
  const response = await fetch(new URL("/api/rankings/consumption?page=1&pageSize=10", BASE));
  assert.equal(response.status, 200, "排行榜是公开数据，不该 401");

  const { data } = await response.json();
  assert.equal(data.viewerLoggedIn, false);
  assert.equal(data.me, null);
  assert.ok(data.items.length > 0, "预置的 Mock 订单应当能聚合出榜单");

  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), [
      "avatarUrl",
      "effectiveSpendAmount",
      "levelName",
      "nickname",
      "rank",
    ]);
    assert.equal(Number.isInteger(item.effectiveSpendAmount), true);
  }

  // 名次连续且金额降序
  data.items.forEach((item, index) => assert.equal(item.rank, index + 1));
  for (let index = 1; index < data.items.length; index += 1) {
    assert.ok(data.items[index - 1].effectiveSpendAmount >= data.items[index].effectiveSpendAmount);
  }

  const serialized = JSON.stringify(data);
  for (const forbidden of ["userId", "displayId", "openid", "unionid", "orderNo"]) {
    assert.equal(serialized.includes(forbidden), false, `榜单响应不该出现 ${forbidden}`);
  }
});

test("排行榜接口不接受客户端提交的名次或金额", { skip: SKIP }, async () => {
  const response = await fetch(
    new URL("/api/rankings/consumption?rank=1&effectiveSpendAmount=99999999&userId=u-1004", BASE),
  );
  assert.equal(response.status, 200);

  const { data } = await response.json();
  // 名次与金额仍由服务端按订单重算，客户端传什么都不影响
  data.items.forEach((item, index) => assert.equal(item.rank, index + 1));
  assert.ok(data.items.every((item) => item.effectiveSpendAmount < 99999999));
});

test("游客可以打开 /agreements：五类内容齐全，正文不是条款占位", { skip: SKIP }, async () => {
  const { status, html } = await get("/agreements");

  assert.equal(status, 200, "/agreements 不该 404");
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "/agreements 不该要求登录");
  // P8E-1 起页签是五类（新增「隐私协议」，插在用户协议之后）
  for (const label of ["用户协议", "隐私协议", "陪玩协议", "平台协议", "版本介绍"]) {
    assert.ok(html.includes(label), `缺少页签「${label}」`);
  }
  // 示例性质与占位主体必须在页面上明确写出
  assert.ok(html.includes("示例"), "缺少「示例文案」说明");
  assert.ok(html.includes("平台主体名称待配置"), "缺少平台主体占位变量");
  // 正文确实来自数据层（服务端渲染的第一类内容可见）
  assert.ok(html.includes("重要提示") || html.includes("协议范围"), "缺少协议正文");
  assert.equal(html.includes(TABBAR_TEXT), false, "/agreements 不该显示底部 TabBar");
});

test("协议接口游客可访问，且不返回 enabled 与历史版本", { skip: SKIP }, async () => {
  const response = await fetch(new URL("/api/agreements", BASE));
  assert.equal(response.status, 200);

  const { data } = await response.json();
  // 五类页签：顺序即页签顺序，隐私协议插在用户协议之后
  assert.equal(data.tabs.length, 5);
  assert.deepEqual(
    data.tabs.map((tab) => tab.type),
    ["user", "privacy", "companion", "platform", "version"],
    "页签类型或顺序变了——AGREEMENT_TYPES 是页签顺序的唯一来源",
  );
  for (const tab of data.tabs) {
    assert.ok(tab.agreement, `${tab.type} 应当有内容`);
    assert.equal("enabled" in tab.agreement, false);
    // 公开 DTO 不带后台字段：正文可被后台编辑之后，这一条**一个字都不许放宽**
    for (const internal of ["enabled", "removedAt", "createdAt"]) {
      assert.equal(internal in tab.agreement, false, `公开协议 DTO 里出现了 ${internal}`);
    }
  }

  // 较早版本与被停用的版本都不出现
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes("ag-user-100"), false, "较早版本不该返回");
  assert.equal(serialized.includes("ag-platform-100"), false, "停用版本不该返回");
  // 不编造法律信息
  for (const pattern of [/有限公司/, /统一社会信用代码/, /1[3-9]\d{9}/]) {
    assert.equal(pattern.test(serialized), false, `协议正文出现了不该编造的信息：${pattern}`);
  }
});

test("三个 P7A 接口都只有 GET：没有任何写入入口", { skip: SKIP_SESSION }, async () => {
  for (const path of ["/api/me/consumption-level", "/api/rankings/consumption", "/api/agreements"]) {
    const response = await fetch(new URL(path, BASE), {
      method: "POST",
      headers: { cookie: SESSION, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 405, `${path} 不该存在写入接口`);
  }
});

test("「我的」页保留 TabBar 与既有入口，并展示消费等级摘要", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get(MINE_PATH, SESSION);

  assert.equal(status, 200);
  // 一级 Tab 页：底部 TabBar 仍在
  assert.ok(html.includes(TABBAR_TEXT), "「我的」页应保留底部 TabBar");
  // P7A 的三个入口都在，且指向真实页面
  for (const href of ['href="/rights"', 'href="/rank"', 'href="/agreements"']) {
    assert.ok(html.includes(href), `「我的」页缺少入口 ${href}`);
  }
  // 既有入口一个都没被挤掉
  for (const href of [
    'href="/orders"',
    'href="/complaints"',
    'href="/coupons"',
    'href="/reviews"',
    'href="/tips"',
    'href="/suggestions"',
    'href="/companions"',
  ]) {
    assert.ok(html.includes(href), `「我的」页丢失了入口 ${href}`);
  }

  // 等级摘要出现在资料卡区域内，且带累计金额
  assert.ok(html.includes("我的消费等级"), "缺少等级摘要");
  assert.ok(html.includes("240.60"), "等级摘要缺少累计有效消费金额");
  assert.ok(html.includes("普通老板"), "等级摘要缺少当前等级名");
});

test("等级摘要取数失败时「我的」页仍然可用：只是那一块降级", { skip: SKIP_SESSION }, async () => {
  // 只有等级摘要接受服务端故障注入（它的错误态是局部降级，不会把整页打挂）
  const { status, html } = await get(`${MINE_PATH}?mockError=1`, SESSION);

  assert.equal(status, 200, "等级摘要失败不该把「我的」页打成错误页");
  assert.equal(html.includes("加载失败"), false, "不该整页错误");
  // 降级卡片 + 独立重试 + 其余入口照常
  assert.ok(html.includes("重试"), "缺少单独的重试入口");
  assert.ok(html.includes("其他功能不受影响"), "缺少降级说明");
  assert.ok(html.includes(TABBAR_TEXT), "底部 TabBar 必须保留");
  for (const href of ['href="/orders"', 'href="/rights"', 'href="/rank"', 'href="/agreements"']) {
    assert.ok(html.includes(href), `降级后丢失了入口 ${href}`);
  }
});

test("P7A 三个页面在调试参数下也不 500：空数据是空态，不是错误", { skip: SKIP_SESSION }, async () => {
  const cases = [
    { path: "/rights?mockEmpty=levels", expect: "等级配置暂不可用" },
    { path: "/rank?mockEmpty=rankings", expect: "本周暂无有效消费" },
    { path: "/agreements?mockEmpty=agreements", expect: "内容暂未配置" },
  ];

  for (const { path, expect: expected } of cases) {
    const response = await get(path, SESSION);
    assert.equal(response.status, 200, `${path} 不该 500`);
    assert.ok(response.html.includes(expected), `${path} 缺少空态文案「${expected}」`);
  }
});

test("空榜文案随周期变化：是「这个周期没有」，不是「榜单坏了」", { skip: SKIP_SESSION }, async () => {
  const cases = [
    { period: "today", expect: "今日暂无有效消费" },
    { period: "yesterday", expect: "昨日暂无有效消费" },
    { period: "lastMonth", expect: "上月暂无有效消费" },
    { period: "all", expect: "榜单暂时还没有数据" },
  ];

  for (const { period, expect: expected } of cases) {
    const { status, html } = await get(`/rank?mockEmpty=rankings&period=${period}`, SESSION);

    assert.equal(status, 200, `${period} 空榜不该 500`);
    assert.ok(html.includes(expected), `${period} 缺少空态文案「${expected}」`);
    // 空态也要能看出「换了周期就会变」：周期榜的说明给出下一步，累计榜没有周期可换
    const description =
      period === "all" ? "还没有用户产生有效消费" : "还没有用户在这个周期内完成订单";
    assert.ok(html.includes(description), `${period} 缺少空态说明`);
    // 空数据不能被伪装成「取数失败」
    assert.equal(html.includes("加载失败"), false, `${period} 空榜不该显示错误态`);
    // 页签仍然是可切换的：空榜不等于这一档不可用
    assert.equal(activePeriodTab(html), RANKING_PERIODS.find((item) => item.key === period).label);
  }
});

test("P7A 页面取数失败时停在路由错误边界，不是 500 白屏", { skip: SKIP_SESSION }, async () => {
  // 这些页面都在渲染前 `await` 取数：加载边界先渲染、响应头先发出去，随后才拿到错误。
  // 已发出的 200 改不了，服务端把这一段标记成「由客户端边界接管」（`$RX(...)`），
  // 浏览器里由同段的 error.tsx 渲染「加载失败 + 重试 + 返回」——那部分由 routes.test.mjs
  // 的源码断言保证，这里能验证的是它没有退化成应用级 500。
  //
  // 反面实测：把 loading.tsx 删掉，请求会变成 500 的 `__next_error__` 页。
  // `/suggestions` 是本次修订补上错误边界的页面，加进来防止它退化回去。
  const cases = [
    { path: "/rights?mockError=1", body: "统计口径" },
    { path: "/rank?mockError=1", body: "完整榜单" },
    { path: "/rank?mockError=1&period=month", body: "本月共" },
    { path: "/agreements?mockError=1", body: "用户协议" },
    { path: "/suggestions?mockError=1", body: "反馈记录与平台回复均为本地 Mock 数据" },
  ];

  for (const { path, body } of cases) {
    const response = await get(path, SESSION);

    assert.equal(response.status, 200, `${path} 应停在路由错误边界，而不是 500`);
    assert.equal(
      response.html.includes("__next_error__"),
      false,
      `${path} 落到了应用级错误页，说明路由边界没接住`,
    );
    // 错误随流下发，交给同段边界在客户端渲染
    assert.match(
      response.html,
      /\$RX\("B:\d+","\d+"\)/,
      `${path} 没有把错误交给路由错误边界`,
    );
    assert.equal(response.html.includes(TABBAR_TEXT), false, `${path} 错误态不该有 TabBar`);
    // 顶部返回照常：不把人困在错误页上
    assert.ok(response.html.includes("返回"), `${path} 错误态缺少返回入口`);
    // 取数失败不能被伪装成「拿到了一份空数据」
    assert.equal(response.html.includes(body), false, `${path} 失败时不该渲染正文`);
  }
});

test("/suggestions 的错误页可重试：重试会去掉调试参数，而不是原地再失败一次", { skip: SKIP_SESSION }, async () => {
  // 调试参数注入的失败，`reset()` 只会拿着同一个地址再取一次、必然同样失败，
  // 用户看到的是「点了没反应」。因此错误态的重试要先把调试参数从地址里去掉
  // （`components/common/ErrorState.tsx`），页面本身仍然照常可用。
  const { status, html } = await get("/suggestions?mockError=1", SESSION);

  assert.equal(status, 200);
  assert.equal(html.includes("__next_error__"), false);
  // 错误边界与它的「重试」由客户端接管，源码断言见 routes.test.mjs；
  // 这里确认这一屏确实拿到了错误交接，而不是白白渲染了一个空列表
  assert.match(html, /\$RX\("B:\d+","\d+"\)/);
  assert.equal(html.includes("没有更多了"), false, "不该渲染出一份空列表");

  // 去掉调试参数后同一个地址恢复正常：这正是重试按钮要做的事
  const healed = await get("/suggestions", SESSION);
  assert.equal(healed.status, 200);
  assert.ok(healed.html.includes("功能建议"), "去掉调试参数后页面应恢复正常");
  assert.equal(healed.html.includes("__next_error__"), false);
});

// ————————————————— P7B：寻找陪玩 / 护航入驻申请 —————————————————

/** 陪玩列表项 DTO 的字段集合（多一个少一个都会在这里被发现）。 */
const COMPANION_LIST_ITEM_KEYS = [
  "available",
  "avatarUrl",
  "completedOrderCount",
  "displayName",
  "games",
  "id",
  "introBrief",
  "rating",
  "regions",
  "reviewCount",
  "serviceTags",
  "tipsCount",
  "unavailableReason",
];

test("游客可以打开陪玩详情：资料与「选择」入口都在，但没有下单入口", { skip: SKIP }, async () => {
  const { status, html } = await get("/companions/cp-1");

  assert.equal(status, 200, "陪玩详情不该 404");
  assert.ok(html.includes("陪玩资料"), "缺少详情页标题");
  assert.ok(html.includes("选择这位陪玩"), "缺少选择入口");
  // 选择只是本地演示：必须写明不会创建订单、不会写入任何陪玩关系
  assert.ok(html.includes("陪玩与订单的最终绑定规则待确认"), "缺少绑定规则待确认说明");
  assert.ok(html.includes("不会创建订单"), "缺少「不会创建订单」说明");
  // 详情页没有任何结算或购买入口
  assert.equal(html.includes("/checkout"), false, "陪玩详情不该有结算入口");
  assert.equal(html.includes("立即购买"), false, "陪玩详情不该有购买按钮");
  // 游客可见，且是二级页面
  assert.equal(html.includes(LOGIN_GATE_TEXT), false, "/companions/[id] 不该要求登录");
  assert.equal(html.includes(TABBAR_TEXT), false, "陪玩详情不该显示底部 TabBar");
});

test("不可用的陪玩：按钮禁用 + 具体原因，不是只把按钮置灰", { skip: SKIP }, async () => {
  const { status, html } = await get("/companions/cp-4");

  assert.equal(status, 200, "在架但暂不可用的陪玩应当能打开详情");
  assert.ok(html.includes("该陪玩当前不可提供服务"), "缺少不可选结论");
  assert.ok(html.includes("暂不接单"), "缺少具体原因");
  assert.ok(html.includes("disabled"), "按钮应当是禁用的");
  // 不可用仍要能看到这位陪玩的资料，而不是一个空页
  assert.ok(html.includes("（占位）"));
});

test("已下架的陪玩：只读资料页，没有选择或下单入口", { skip: SKIP }, async () => {
  const { status, html } = await get("/companions/cp-7");

  assert.equal(status, 200, "已下架的陪玩不该 404");
  assert.ok(html.includes("没有选择或下单入口"), "缺少只读说明");
  assert.equal(html.includes("选择这位陪玩"), false, "已下架不该出现选择入口");
  assert.equal(html.includes("/checkout"), false);
});

test("不存在的陪玩是 404，并且给出回到列表的入口", { skip: SKIP }, async () => {
  const { status, html } = await get("/companions/cp-not-exist");

  // 状态码是这里最要紧的一条：只有它正确，爬虫与用户代理才不会把「没有这位陪玩」
  // 记成一个正常页面。与 `/product/nope` 完全一致（同一套 notFound() 处理）。
  assert.equal(status, 404);
  assert.ok(html.includes("陪玩不存在"));
  assert.ok(html.includes("该陪玩可能已下线，或链接已失效。"), "缺少 404 说明");
  // 退路：文案在响应里。**不**断言 `href="/companions"` 这个 HTML 属性——
  // 这条路由不挂加载边界（否则状态码会退化成 200），notFound() 因此由客户端运行时渲染，
  // 响应体是 `<html id="__next_error__">` + RSC 载荷，锚点写在载荷里而不是 HTML 属性里
  // （`/product/nope` 一模一样）。源码级的「404 页必须指向 /companions」在 routes.test.mjs。
  assert.ok(html.includes("返回陪玩列表"), "404 页缺少返回列表的入口");
  assert.equal(html.includes(TABBAR_TEXT), false);
});

test("陪玩列表接口：游客可访问，非法枚举回 400，分页参数规范化", { skip: SKIP }, async () => {
  // 页面侧：手改坏了的地址不该变成错误页
  const broken = await get("/companions?availability=online&gameId=g-not-exist&mockDelay=0");
  assert.equal(broken.status, 200, "非法筛选值不该把页面打挂");
  assert.ok(broken.html.includes("寻找陪玩"));

  // 接口侧：明确的业务条件写错必须报错
  for (const query of ["availability=online", "gameId=g-not-exist"]) {
    const response = await fetch(new URL(`/api/companions?${query}`, BASE));
    assert.equal(response.status, 400, `?${query} 应当被拒绝`);
    const body = await response.json();
    assert.equal(body.error.code, "BAD_REQUEST");
    assert.equal("data" in body, false);
  }

  // 游客可访问；分页参数越界时规范化而不是报错
  const response = await fetch(new URL("/api/companions?page=-1&pageSize=999", BASE));
  assert.equal(response.status, 200, "陪玩名单是公开内容，不该 401");
  const { data } = await response.json();
  assert.equal(data.page, 1);
  assert.equal(data.pageSize, 20);
  assert.ok(data.items.length > 0, "预置的 Mock 名单应当能读到");
  assert.equal(typeof data.hasMore, "boolean");

  // 已下架的 cp-7 不进公开列表
  assert.equal(data.items.some((item) => item.id === "cp-7"), false);
  // 列表项字段是确定的一份，且没有内部字段与用户标识
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), COMPANION_LIST_ITEM_KEYS);
  }
  const serialized = JSON.stringify(data);
  for (const forbidden of ["sortOrder", "enabled", "rankLabel", "userId", "openid", "unionid"]) {
    assert.equal(serialized.includes(forbidden), false, `陪玩列表响应不该出现 ${forbidden}`);
  }

  // 关键词在服务端生效：命中昵称
  const named = await fetch(new URL(`/api/companions?keyword=${encodeURIComponent("老K")}`, BASE));
  assert.deepEqual(
    (await named.json()).data.items.map((item) => item.id),
    ["cp-3"],
  );
});

test("陪玩详情是服务端渲染的只读页面：没有任何「把陪玩带出去」的接口", { skip: SKIP }, async () => {
  // 详情页由 Server Component 直接取数渲染，页面上的选择动作只改本地状态，
  // 因此本阶段**不需要也不存在**陪玩详情的取数接口，更不存在「创建陪玩关系」的写接口。
  for (const path of ["/api/companions/cp-1", "/api/companions/cp-1/relationship"]) {
    const response = await fetch(new URL(path, BASE));
    assert.equal(response.status, 404, `${path} 不该存在`);
  }

  const write = await fetch(new URL("/api/companions", BASE), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ companionId: "cp-1" }),
  });
  assert.equal(write.status, 405, "陪玩列表接口不该支持写入");
});

test("入驻申请接口：一个人最多一条、幂等提交、撤销幂等，且只返回本人的申请", { skip: SKIP_SESSION }, async () => {
  const cookie = SESSION_JOIN_APPLICANT;
  const headers = { cookie, "content-type": "application/json" };
  const readMine = async () => {
    const response = await fetch(new URL("/api/me/companion-application", BASE), {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  const send = (idempotencyKey) =>
    fetch(new URL("/api/companion-applications", BASE), {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey,
        displayName: "接口冒烟（占位）",
        gameIds: ["g-valorant"],
        regions: ["端游"],
        serviceTags: ["护航"],
        experience: "冒烟测试提交的经验说明（Mock 文案）",
        introduction: "冒烟测试提交的自我介绍（Mock 文案）",
        contactNote: "",
        evidence: [],
      }),
    });

  // 同一台服务可能被跑过一遍：从现在的状态出发，不假设「一定没有申请」
  const before = await readMine();
  let justCreated = false;

  if (!before.application) {
    const key = `smoke-${crypto.randomUUID().slice(0, 18)}`;
    const first = await send(key);
    assert.equal(first.status, 200);
    const created = (await first.json()).data;
    assert.equal(created.created, true);
    assert.equal(created.status, "pending", "用户新提交的申请只会是「待查看」");

    // 同一个键第二次：不是错误，返回第一次的结果，不会多出一条
    const repeated = await send(key);
    assert.equal(repeated.status, 200);
    const again = (await repeated.json()).data;
    assert.equal(again.created, false);
    assert.equal(again.applicationId, created.applicationId);
    assert.equal(again.applicationNo, created.applicationNo);
    justCreated = true;
  }

  // 换一个键也写不进第二条
  const conflict = await send(`smoke-${crypto.randomUUID().slice(0, 18)}`);
  assert.equal(conflict.status, 400);
  assert.equal((await conflict.json()).error.message, "你已有一条入驻申请，请在入驻进度页查看");

  // 详情：只有本人看得到，响应里没有 userId
  const mine = await readMine();
  assert.ok(mine.application, "提交之后应当能读到自己的申请");
  assert.equal("userId" in mine.application, false, "入驻申请 DTO 不该带 userId");
  assert.equal(mine.application.evidence.length, 0);
  if (justCreated) {
    assert.equal(mine.application.status, "pending");
    assert.equal(mine.application.reviewNote, "");
    assert.equal(mine.application.reviewedAt, null);
    assert.equal(mine.application.experience, "冒烟测试提交的经验说明（Mock 文案）");
  }

  // 撤销：只有本人能撤、重复撤销幂等、撤销只改状态不删记录
  const withdrawUrl = new URL(
    `/api/companion-applications/${mine.application.id}/withdraw`,
    BASE,
  );
  const withdraw = () =>
    fetch(withdrawUrl, { method: "POST", headers: { cookie, "content-type": "application/json" } });

  const first = await withdraw();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).data.status, "withdrawn");

  const second = await withdraw();
  assert.equal(second.status, 200);
  const repeated = (await second.json()).data;
  assert.equal(repeated.withdrawn, false, "重复撤销不该再产生一次变更");
  assert.equal(repeated.applicationId, mine.application.id);

  const after = await readMine();
  assert.equal(after.application.status, "withdrawn");
  assert.equal(after.application.submittedAt, mine.application.submittedAt);
  assert.equal(after.application.experience, mine.application.experience, "撤销不该删掉申请内容");

  // 不存在与不属于本人返回同一个 404：拿别人的 id 试探得不到信息
  const missing = await fetch(
    new URL("/api/companion-applications/ca-not-exist/withdraw", BASE),
    { method: "POST", headers: { cookie, "content-type": "application/json" } },
  );
  const notMine = await fetch(new URL("/api/companion-applications/ca-1002/withdraw", BASE), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(missing.status, 404);
  assert.equal(notMine.status, 404);
  assert.equal(
    (await missing.json()).error.message,
    (await notMine.json()).error.message,
    "「不存在」与「不是本人的」对外表现必须一致",
  );
});

test("审核状态没有任何用户端入口：撤不掉审核中的申请，也没有改状态接口", { skip: SKIP_SESSION }, async () => {
  const cookie = SESSION_JOIN_REVIEWING;

  const response = await fetch(new URL("/api/companion-applications/ca-1003/withdraw", BASE), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(response.status, 400);
  assert.ok((await response.json()).error.message.includes("不能撤销"));

  // 申请接口只有 POST：没有 GET，也没有任何「改这条申请」的地址
  const list = await fetch(new URL("/api/companion-applications", BASE), { headers: { cookie } });
  assert.equal(list.status, 405, "提交接口不该支持读取");
  for (const method of ["GET", "PATCH", "PUT", "DELETE"]) {
    const write = await fetch(new URL("/api/companion-applications/ca-1003", BASE), {
      method,
      headers: { cookie, "content-type": "application/json" },
    });
    assert.equal(write.status, 404, `${method} /api/companion-applications/[id] 不该存在`);
  }

  // 状态仍然没有被改动
  const mine = (
    await (
      await fetch(new URL("/api/me/companion-application", BASE), { headers: { cookie } })
    ).json()
  ).data;
  assert.equal(mine.application.status, "reviewing");
});

test("三个入驻申请接口都要求登录：游客拿到 401 而不是别人的申请", { skip: SKIP }, async () => {
  const cases = [
    { path: "/api/me/companion-application", method: "GET" },
    { path: "/api/companion-applications", method: "POST" },
    { path: "/api/companion-applications/ca-1002/withdraw", method: "POST" },
  ];

  for (const { path, method } of cases) {
    const response = await fetch(new URL(path, BASE), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path} 未登录时应返回 401`);
    const body = await response.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal("data" in body, false);
  }
});

test("入驻进度页：状态与时间轴来自服务端，没有申请就有回填入口", { skip: SKIP_SESSION }, async () => {
  // u-1002 预置为「待查看」：时间轴只有已经发生的节点，并给出撤销入口
  const pending = await get("/join/status", SESSION_JOIN_PENDING);
  assert.equal(pending.status, 200);
  assert.equal(pending.html.includes(LOGIN_GATE_TEXT), false);
  assert.ok(pending.html.includes("入驻进度"), "缺少页面标题");
  assert.ok(pending.html.includes("RA-MOCK-0002"), "缺少申请单号");
  assert.ok(pending.html.includes("入驻申请已提交，等待平台查看"), "缺少已发生的节点说明");
  assert.ok(pending.html.includes("撤销申请"), "「待查看」应当可以撤销");
  // 用「小节标题」判断，而不是「正文里出现过这四个字」：
  // 页面底部的 Mock 说明句里本来就含「审核结果」，那不是在展示结论。
  assert.equal(pending.html.includes(">审核结果<"), false, "还没有结果时不该出现审核结果区");
  assert.equal(pending.html.includes(TABBAR_TEXT), false, "/join/status 不该显示底部 TabBar");

  // u-1004 预置为「已通过」：审核备注与结果时间只在真的有结果时出现
  const approved = await get("/join/status", SESSION_JOIN_APPROVED);
  assert.equal(approved.status, 200);
  assert.ok(approved.html.includes(">审核结果<"), "有结果时应当出现审核结果区");
  assert.ok(approved.html.includes("（Mock 备注）"), "缺少服务端下发的审核备注");
  assert.equal(approved.html.includes("撤销申请"), false, "已通过不该出现撤销入口");

  // u-1001 没有申请：说明「还没有申请」并给出去填写的入口
  const none = await get("/join/status", SESSION);
  assert.equal(none.status, 200);
  assert.ok(none.html.includes("还没有入驻申请"));
  assert.ok(none.html.includes('href="/join"'), "缺少去填写入驻申请的入口");
});

test("P7B 页面取数失败时停在路由错误边界，不是 500 白屏", { skip: SKIP_SESSION }, async () => {
  // 断言的是**正文独有的**文案，不是页面标题：错误边界自己也会渲染同一个顶部
  // NavBar，拿标题当「正文没渲染」的证据必然误判（它本来就该出现在错误态里）。
  //
  // 这里没有 `/companions/cp-1`：详情路由刻意不带 `loading.tsx`（否则 notFound()
  // 只能返回 200），代价就是外壳阶段的取数失败没有边界可接，行为与
  // `/product/[id]` 完全一致（500 + `__next_error__`），因此不适合放进这张表。
  const cases = [
    { path: "/companions?mockError=1", body: "陪玩名单与评价均为本地 Mock 数据" },
    { path: "/join?mockError=1", body: "陪玩昵称" },
    { path: "/join/status?mockError=1", body: "还没有入驻申请" },
  ];

  for (const { path, body } of cases) {
    const response = await get(path, SESSION);

    assert.equal(response.status, 200, `${path} 应停在路由错误边界，而不是 500`);
    assert.equal(
      response.html.includes("__next_error__"),
      false,
      `${path} 落到了应用级错误页，说明路由边界没接住`,
    );
    assert.match(response.html, /\$RX\("B:\d+","\d+"\)/, `${path} 没有把错误交给路由错误边界`);
    assert.equal(response.html.includes(TABBAR_TEXT), false, `${path} 错误态不该有 TabBar`);
    assert.ok(response.html.includes("返回"), `${path} 错误态缺少返回入口`);
    assert.equal(response.html.includes(body), false, `${path} 失败时不该渲染正文`);
  }
});

test("P7B 在调试参数下也不 500：空名单是空态，不是错误", { skip: SKIP_SESSION }, async () => {
  const { status, html } = await get("/companions?mockEmpty=companions&mockDelay=0", SESSION);

  assert.equal(status, 200, "空名单不该 500");
  assert.equal(html.includes("__next_error__"), false);
  assert.equal(html.includes("加载失败"), false, "空数据不能被伪装成取数失败");
  assert.ok(html.includes("暂无陪玩"), "缺少空态文案");
  assert.ok(html.includes("名单还没有内容"), "缺少空态说明");
  // 空态仍然保留筛选栏：改筛选条件仍然是有意义的下一步
  assert.ok(html.includes("当前可接单"), "空态不该把筛选栏一起隐藏");
});

