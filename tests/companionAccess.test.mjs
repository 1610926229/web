import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getCompanionRepository } from "../lib/data/companionRepository.ts";
import { resolveCompanionAccess } from "../lib/services/companionAccess.ts";
import { hasAppFile } from "./app-path.mjs";

/**
 * P0-4「打手工作台接入」的持续测试。
 *
 * 本批次只做一件事：**已是打手的用户能从自己的用户会话直接进入工作台**。
 * 因此这里锁的不是页面长什么样，而是三条边界：
 *
 * 1. **访问规则只有一处**（`resolveCompanionAccess`）：无护航资料 / 已下架 / 正常，
 *    三种结论由同一段代码给出，页面与接口守卫都读它。软移除**不是**一个额外的判断——
 *    它由 `findCompanionByUser` 的「有效护航」口径覆盖（下面有专门的回归断言）。
 *
 *    而且**一次调用只有一次仓储读取**，判定与展示数据（段位）来自同一份结果。
 *    这条不是性能偏好：布局与页面若各查一次，两次 `await` 之间资格可能刚好被下架，
 *    于是「布局按旧记录渲染了工作台壳、页面按新记录取不到资料」——页面停在
 *    「顶栏 + 空白」。P0-5 的打手业务全部挂在这份判定上，因此这里既有用例级的
 *    读取计数断言，也有源码级的结构约束（工作台目录里只允许一处调用点）。
 * 2. **没有第二套身份**：负向门禁扫描全仓，确认不存在独立的打手会话模块、Cookie、
 *    环境开关、登录页与认证接口。这条门禁**刻意扫描注释**——一句「这里没有 X」的注释
 *    同样是后来者重新引入 X 的起点。
 * 3. **打手 DTO 是显式挑字段的**：`enabled` / `removedAt` / `applicationId` / `intro`
 *    这些内部字段不进工作台 DTO。
 *
 * ⚠️ 内存 Mock 仓储在同一进程内是共享的（node 对每个测试文件起一个子进程），
 * 因此需要写数据的用例一律用 `uniqueUser()` 生成独立用户，用例之间不会互相看见对方。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let userSeq = 0;
/** 每个用例一个全新用户 id，避免用例之间互相污染护航名单。 */
function uniqueUser() {
  userSeq += 1;
  return `u-p04-${process.pid}-${userSeq}`;
}

let companionSeq = 0;
/** 一条形状完整的护航资料；只需覆盖关心的字段。 */
function companionFixture(userId, overrides = {}) {
  companionSeq += 1;
  return {
    id: `cp-p04-${process.pid}-${companionSeq}`,
    userId,
    applicationId: null,
    removedAt: null,
    displayName: `测试护航${companionSeq}（占位）`,
    avatarUrl: "/mock/avatars/companion-1.svg",
    rankLabel: "钻石打手",
    intro: "这是一段不会出现在工作台 DTO 里的自我介绍",
    gameIds: [],
    regions: [],
    serviceTags: [],
    available: false,
    unavailableReason: "",
    completedOrderCount: 0,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 999,
    enabled: true,
    reviews: [],
    ...overrides,
  };
}

/** 建一条护航资料（等价于「入驻申请审核通过」在数据层的落点）。 */
async function grantCompanion(userId, overrides) {
  const created = await getCompanionRepository().createCompanion(companionFixture(userId, overrides));
  assert.equal(created.kind, "created", "这条用例需要一条新创建的护航资料");
  return created.companion;
}

// ——————————————————————— 一、三种访问态 ———————————————————————

test("没有护航资料的用户 → not-a-companion（含预置用户与空 id）", async () => {
  // u-1001 是预置普通用户：预置护航里没有一条的 userId 指向它
  //（`cp-*` 大多为 null，有关联的只有 `cp-10` / `cp-11` → u-1022 / u-1023）
  for (const userId of ["u-1001", uniqueUser(), "", "u-不存在的人"]) {
    assert.deepEqual(
      await resolveCompanionAccess(userId),
      { kind: "not-a-companion" },
      `${JSON.stringify(userId)} 不该被当成护航`,
    );
  }
});

test("有护航资料且启用 → granted，DTO 恰好是工作台要用的四个字段", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId);

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "granted");
  assert.deepEqual(state.companion, {
    userId,
    companionId: created.id,
    displayName: created.displayName,
    avatarUrl: created.avatarUrl,
  });

  // 内部字段一个都不进工作台 DTO：上架开关、软移除时间、来源申请、自我介绍、接单状态…
  assert.deepEqual(
    Object.keys(state.companion).sort(),
    ["avatarUrl", "companionId", "displayName", "userId"],
    "工作台 DTO 的字段表就是边界，多一个字段多一条泄漏路径",
  );

  // 展示用的段位**随判定一起返回**：调用方不需要（也不允许）为了它再查一次仓储
  assert.equal(state.rankLabel, created.rankLabel);
  assert.deepEqual(
    Object.keys(state).sort(),
    ["companion", "kind", "rankLabel"],
    "granted 就是工作台需要的全部：判定 + 身份 + 展示字段",
  );
});

test("护航资料被下架（enabled = false）→ disabled，既不是 granted 也不是 not-a-companion", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId, { enabled: false });

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "disabled", "下架与「不是护航」是两件事：页面提示与后续处置都不同");
  assert.equal(state.companion.companionId, created.id);
  // 下架态只够渲染一句提示，因此**不带**展示字段：段位只发给真的进得去的人
  assert.deepEqual(Object.keys(state).sort(), ["companion", "kind"]);
});

test("用户隔离：别人是护航，不代表我是护航", async () => {
  const me = uniqueUser();
  const other = uniqueUser();
  await grantCompanion(other);

  assert.deepEqual(await resolveCompanionAccess(me), { kind: "not-a-companion" });
  assert.equal((await resolveCompanionAccess(other)).kind, "granted");
});

// ——————————————————————— 二、软移除（回归断言）———————————————————————

/**
 * ⚠️ 这一条是**唯一**允许在「有效护航」口径变化时被改写的用例。
 *
 * 它防的是一个具体的、很容易犯的错误：把软移除当成第四种访问态，
 * 或者在访问规则里再写一次 `removedAt === null`。两种写法都会让
 * 「已移除」与「已下架」在页面上长得一样，而两者的后续处置完全不同——
 * 下架是暂时的（管理员可以恢复），移除之后再进工作台必须重新走审核。
 */
test("软移除之后不再算护航：由 findCompanionByUser 的「有效护航」口径覆盖，不是第四种状态", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId);
  assert.equal((await resolveCompanionAccess(userId)).kind, "granted");

  await getCompanionRepository().markCompanionRemoved(created.id, new Date().toISOString());

  // 仓储口径本身：已移除的不算「有效护航」
  assert.equal(
    await getCompanionRepository().findCompanionByUser(userId),
    null,
    "findCompanionByUser 应当只返回未移除的记录",
  );
  // 因此访问态是 not-a-companion，**不是** disabled
  assert.deepEqual(await resolveCompanionAccess(userId), { kind: "not-a-companion" });

  // 但记录本身仍然取得到：软移除不是删除，历史订单与评价还要指得到它
  const removed = await getCompanionRepository().findCompanionById(created.id);
  assert.ok(removed, "软移除不该把记录删掉");
  assert.notEqual(removed.removedAt, null);
});

test("移除之后重新审核通过：又能进入工作台（移除会释放「一名用户一条有效护航」的名额）", async () => {
  const userId = uniqueUser();
  const first = await grantCompanion(userId);
  await getCompanionRepository().markCompanionRemoved(first.id, new Date().toISOString());

  const second = await grantCompanion(userId);

  const state = await resolveCompanionAccess(userId);
  assert.equal(state.kind, "granted");
  assert.equal(state.companion.companionId, second.id, "工作台应当指向新的那条资料");
});

// ——————————————————————— 三、单次解析（P0-4 修订）———————————————————————

/**
 * 一次判定 = 一次仓储读取。
 *
 * 这条用例用**读取计数**钉住它：如果以后有谁在服务层里再加一次
 * `findCompanionByUser`（比如为了取段位、或者为了「再确认一下还是护航」），
 * 计数会变成 2，用例立刻红。
 *
 * ⚠️ 计数是**在仓储对象上临时替换方法**得到的。Mock 仓储是本进程共享的单例，
 * 因此替换必须在 `finally` 里还原；本文件内的用例是顺序执行的，不会互相看见中间态。
 */
test("一次判定只读一次仓储：判定与展示数据出自同一份结果", async () => {
  const userId = uniqueUser();
  const created = await grantCompanion(userId);

  const repo = getCompanionRepository();
  const original = repo.findCompanionByUser;
  let reads = 0;
  repo.findCompanionByUser = async (id) => {
    reads += 1;
    return original.call(repo, id);
  };

  try {
    const state = await resolveCompanionAccess(userId);

    assert.equal(reads, 1, "一次判定只允许读一次仓储；多读一次就会多一个 TOCTOU 窗口");
    assert.equal(state.kind, "granted");
    assert.equal(state.rankLabel, created.rankLabel, "段位必须来自这次读取的记录");
  } finally {
    repo.findCompanionByUser = original;
  }
});

test("不是护航 / 已下架时不读第二次：一次判定同样只读一次仓储", async () => {
  const normal = uniqueUser();
  const disabled = uniqueUser();
  await grantCompanion(disabled, { enabled: false });

  const repo = getCompanionRepository();
  const original = repo.findCompanionByUser;
  let reads = 0;
  repo.findCompanionByUser = async (id) => {
    reads += 1;
    return original.call(repo, id);
  };

  try {
    assert.deepEqual(await resolveCompanionAccess(normal), { kind: "not-a-companion" });
    assert.equal(reads, 1, "「不是护航」也只需要一次读取");

    assert.equal((await resolveCompanionAccess(disabled)).kind, "disabled");
    assert.equal(reads, 2, "第二条判定同样只多读一次");
  } finally {
    repo.findCompanionByUser = original;
  }
});

/**
 * 结构约束：**一次页面请求只有一份资格结果**。
 *
 * 用例级的读取计数只能证明「这一个函数读了一次」，证明不了「页面只调用了它一次」。
 * 因此这里再加一条源码级约束，把「多出来的读取」挡在代码评审之前：
 *
 * - 资格判定只有 `resolveCompanionAccess()` 一个入口，而且**必须包在 `React.cache` 里**
 *   （P0-5 起工作台有多个页面，布局与页面都会调它；靠缓存保证一次请求只算一次）；
 * - 工作台路由目录下的调用点是**显式清单**，多一个文件就要在这里加一行
 *   （与 `tests/admin.test.mjs` 的后台接口清单同一个做法）；
 * - 概览页（`page.tsx`）与身份卡组件都是**纯展示**：不许出现任何读取入口。
 *
 * 为什么值得单独立一条结构约束：布局与页面在 React 里是**并行渲染**的，两者各查一次
 * 时，中间那个窗口足以让布局按旧记录渲染出工作台壳、页面按新记录取不到资料，
 * 最终停在「顶栏 + 空白」。这种中间态在测试里极难复现，只能靠结构上不可能发生。
 *
 * ⚠️ P0-5 修订：原来钉的是「工作台里只允许一处调用点」。工作台多了两张订单池页之后
 * 这条不再够用——它们必须拿到当前打手的 id 才能取自己的池子，而布局无法给 `children`
 * 传 props。因此约束改成两条更结实的：**缓存包装**（保证一次请求一份结果）+
 * **调用点清单**（保证新增读取点必须被看见）。下面两条断言分别钉住它们。
 *
 * ⚠️ P0-6 修订：打手多了「我的订单」列表页与订单详情页（`orders/`），
 * 两页都由 URL 里的订单 id 或当前会话打手 id 取数，因此同样要拿会话身份——
 * 清单随之从三个变五个。清单**不是**「只准三处」的配额，而是
 * 「每多一处都必须有人确认它走的是同一份 `React.cache` 结果」。
 *
 * ⚠️ P0-9 修订：「我的收益」（`earnings/`）与「我的订单」同一个取舍——
 * 它要拿当前打手的 id 去查自己那份收益，因此同样必须走同一份缓存结果，清单从五个变六个。
 */
test("结构约束：资格判定必须缓存包装，工作台的调用点是显式清单", () => {
  const consoleDir = path.join(ROOT, "app", "companion");
  const callSites = [...walk(consoleDir)]
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes("resolveCompanionAccess("))
    .map((file) => path.relative(ROOT, file).replace(/\\/g, "/"))
    .sort();

  assert.deepEqual(
    callSites,
    [
      "app/companion/(console)/earnings/page.tsx",
      "app/companion/(console)/exclusive/page.tsx",
      "app/companion/(console)/layout.tsx",
      "app/companion/(console)/orders/[id]/page.tsx",
      "app/companion/(console)/orders/page.tsx",
      "app/companion/(console)/pool/page.tsx",
    ],
    "工作台的资格调用点是一份显式清单：新增一处就必须在这里写清楚，并确认它与其他调用点共享同一份结果",
  );

  // 一次请求一份结果靠的是 React.cache，因此这条包装本身就是约束的一部分：
  // 去掉它，上面那六个调用点就会变成六次独立的仓储读取
  const access = stripComments(
    readFileSync(path.join(ROOT, "lib", "services", "companionAccess.ts"), "utf8"),
  );
  assert.ok(
    access.includes("cache(") && access.includes("resolveCompanionAccess = cache("),
    "resolveCompanionAccess 必须由 React.cache 包装：布局与页面各调一次时，仓储只能读一次",
  );

  // 读取入口的黑名单：出现任何一个，都意味着展示数据可能来自另一次查询
  const READERS = [
    "getSessionUser",
    "requireUser",
    "resolveCompanionAccess",
    "getCompanionRepository",
    "findCompanionByUser",
  ];

  const page = stripComments(
    readFileSync(path.join(consoleDir, "(console)", "page.tsx"), "utf8"),
  );
  for (const reader of READERS) {
    assert.equal(
      page.includes(reader),
      false,
      `工作台页面只放不需要资格判定的静态内容；出现 ${reader} 说明它又读了一次`,
    );
  }

  const card = stripComments(
    readFileSync(path.join(ROOT, "components", "companion", "CompanionIdentityCard.tsx"), "utf8"),
  );
  for (const reader of READERS) {
    assert.equal(
      card.includes(reader),
      false,
      `身份卡只能渲染传进来的那份结果；出现 ${reader} 说明它自己又查了一次`,
    );
  }
});

// ——————————————————————— 四、负向门禁 ———————————————————————

/** 递归列出目录下的全部文件（跳过 `.` 开头的目录，与路由规则一致）。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * 负向门禁：**打手身份建立在现有 User Session 之上**。
 *
 * 打手不是第四套账号：没有自己的会话模块、Cookie、环境开关、登录页与认证接口。
 * 身份一律由 `requireUser()`（用户会话）→ 护航资料推导出来。
 *
 * ⚠️ 扫描范围是 `app/` `lib/` `components/`，**不含 `tests/` 与 `docs/`**：
 * 本文件与整改计划里必须写出这些标识才能禁止它们，把这两处纳入扫描等于
 * 让门禁自己把自己判红。要挡的是「生产代码里出现第二条路」，不是「文档里提到过它」。
 *
 * ⚠️ 扫描的是**原文，注释也算**。一句「本模块不建 companionSession」的注释
 * 正是后来者重新引入它的起点；用词上绕开标识本身，成本远低于一次误判。
 *
 * ⚠️ 这里**不用** `readFlag(` 的调用次数做门禁：那会让以后新增任何无关环境开关时
 * 产生无意义的失败。本门禁要保证的是「打手能力不建立在第二个开关上」，
 * 不是「环境变量开关数量恒定」。
 */
test("负向门禁：仓库里不存在任何「第二套打手身份」的痕迹", () => {
  const FORBIDDEN_TOKENS = [
    "ENABLE_MOCK_COMPANION", // 独立的模拟开关
    "mock_companion_id", // 独立的会话 Cookie
    "companionSession", // 独立的会话模块
  ];

  const offenders = [];
  for (const dir of ["app", "lib", "components"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        if (source.includes(token)) offenders.push(`${path.relative(ROOT, file)} → ${token}`);
      }
    }
  }

  assert.deepEqual(offenders, [], "打手不该有独立的开关 / Cookie / 会话模块");
});

test("负向门禁：不存在打手独立登录页，也不存在打手认证接口", () => {
  // hasAppFile 忽略路由组：`app/companion/(auth)/login/page.tsx` 这种改头换面同样会被抓住
  assert.equal(
    hasAppFile("companion/login/page.tsx"),
    false,
    "打手没有独立登录页：未登录时复用用户端登录控件",
  );
  assert.equal(
    hasAppFile("api/companion/auth/mock-login/route.ts"),
    false,
    "打手没有独立认证接口",
  );

  // api/companion 下不允许出现任何 auth 段（将来加接单接口时也不会凭空长出一个）。
  // 按路由扫描而不是写死路径：多一层少一层、换个目录名都躲不过去。
  const APP_DIR = path.join(ROOT, "app");
  const offenders = [];
  for (const file of walk(APP_DIR)) {
    const route = path
      .relative(APP_DIR, file)
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
      .join("/");
    if (route.startsWith("api/companion/auth/")) offenders.push(route);
  }
  assert.deepEqual(offenders, [], "打手不该有独立的认证接口");
});

test("结构约束：服务层只有一个读取点，不存在第二个「按 userId 查工作台数据」的入口", () => {
  const code = stripComments(
    readFileSync(path.join(ROOT, "lib", "services", "companionAccess.ts"), "utf8"),
  );

  const reads = code.match(/findCompanionByUser\(/g) ?? [];
  assert.equal(
    reads.length,
    1,
    "服务层只允许一处仓储读取：多一处，判定与展示就可能来自两条不同的记录",
  );

  // 第二个入口哪怕「只是给页面用的」，也是下一次分叉的起点
  assert.equal(
    code.includes("getCompanionWorkspaceView"),
    false,
    "不存在第二个按 userId 取工作台数据的函数；展示数据随判定一起返回",
  );
});

test("隔离断言：打手守卫走用户会话，且访问规则只有一处", () => {
  const code = stripComments(readFileSync(path.join(ROOT, "lib", "api", "companionRoute.ts"), "utf8"));

  // 身份来源是既有的用户会话守卫
  assert.ok(code.includes("requireUser"), "打手守卫必须先走既有的 requireUser()");

  // 不碰另外两套会话
  for (const forbidden of ["staffSession", "adminSession", "getSessionStaff", "getSessionAdmin"]) {
    assert.equal(code.includes(forbidden), false, `打手守卫不该引用 ${forbidden}`);
  }

  // 访问规则只有一处：守卫复用服务层的判定，而不是自己再查一次仓储
  assert.ok(
    code.includes("resolveCompanionAccess"),
    "访问规则应当只有 resolveCompanionAccess() 一处，守卫不得自己重写一遍",
  );
  assert.equal(
    code.includes("findCompanionByUser"),
    false,
    "守卫里再查一次仓储就会出现第二个真值来源（软移除口径会分叉）",
  );
});
