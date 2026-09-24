import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hasAppFile } from "./app-path.mjs";
import { collectFiles, readSource, stripComments, withoutImports } from "./source-text.mjs";

/**
 * 打手端**接口契约**的清单门禁（P0-5.5 建立）。
 *
 * ## 这个文件测什么，不测什么
 *
 * 它测的是 `app/api/companion/**` 的**形状**：有哪些地址、各导出哪些方法、谁鉴权、
 * 调哪个服务层函数。它**不测**陪玩领域数据（那是 `tests/companions.test.mjs`）、
 * 也不测「打手身份只有一套」（那是 `tests/companionAccess.test.mjs` 的负向门禁，
 * 其中已经覆盖了「`api/companion` 下不允许出现 `auth/` 段」，这里**刻意不再重复**）。
 *
 * ## 为什么要有这份清单
 *
 * 管理端（`tests/admin.test.mjs`）与客服端（`tests/staff.test.mjs`）都有同样的门禁，
 * 打手端此前是**唯一没有的**。缺了它的后果不是「少一个测试」，而是：
 * 一个接口被悄悄新增、改名、被换成另一个身份守卫，都不会有任何东西变红。
 *
 * ⚠️ 清单**逐条列出**而不是只断言数量：数量相同但地址被换掉的改动同样必须现形。
 *
 * ⚠️ 清单只描述**当前真实存在**的接口。
 *
 * ## 2026-09-23（P0-6）修订
 *
 * 原文是「`/companion/orders` 与 `/companion/orders/[id]`（「开始服务」，
 * `accepted → serving`）属于后续业务 Round，不得登记」——这句话已经把**两件不同的事**
 * 写成了一件。P0-6 实现了前者（打手「我的订单」列表 / 详情 / 主动取消接单三件套），
 * 后者**仍然没有实现**、也**仍然不属于本轮**。
 *
 * 因此这条约束被拆成两半，各自有对面那半挡住：
 * - **列表 / 详情 / 取消接单**已登记为 CURRENT（见下面清单）；
 * - **「开始服务」（`accepted → serving`）继续是负向门禁**：它既不许出现在清单里，
 *   也不许出现在磁盘上，而且 `orders/[id]` 下**只有 cancel 一个写入口**。
 *   详见本文件最后一条用例——那是这一段注释真正的意图所在。
 *
 * 保留这条约束的理由没有变：把未实现的接口登记进清单，等于在门禁与文档里
 * 同时宣称一个不存在的能力已经存在，而门禁本身将再也发现不了它的缺失。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_API_DIR = path.join(ROOT, "app", "api", "companion");

/** 相对 `app/api/companion/` 的路径，统一用 `/`，Windows 与 POSIX 下结果一致。 */
function relativeRoute(file) {
  return path.relative(COMPANION_API_DIR, file).replace(/\\/g, "/");
}

/**
 * 打手端接口清单（CURRENT）。
 *
 * - `methods`：这个文件**导出**的 HTTP 方法。一个 `route.ts` 可以同时处理多个方法
 *   （例如详情 GET + 发送 POST 共用一个地址段），因此这里是数组而不是单值。
 * - `guard` / `guardModule`：必须出现的身份守卫，以及它**必须来自哪个模块**。
 *   打手**只有** `requireCompanion()`——没有第二套账号。只钉名字不钉模块是不够的：
 *   将来若冒出第二个同名但更宽松的守卫模块，名字断言照样通过。
 * - `service` / `serviceModule`：这个接口必须调用的服务层函数与它所在的模块。
 *   「接口薄、业务在服务层」这条约束靠这两个字段守住：接口自己写业务逻辑时，
 *   这里会立刻对不上。
 */
const COMPANION_API_MANIFEST = [
  {
    route: "dispatches/route.ts",
    methods: ["GET"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "listCompanionPools",
    serviceModule: "@/lib/services/companionDispatch",
  },
  {
    route: "dispatches/[id]/accept/route.ts",
    methods: ["POST"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "acceptDispatchForCompanion",
    serviceModule: "@/lib/services/companionDispatch",
  },
  // —— P0-6 / P0-7：打手「我的订单」四件套 ——
  // 四条都走同一个服务模块：列表、详情、开始服务与取消接单对归属的判定必须是**同一件事**
  // （`Order.actualCompanionId`），拆成两个模块就迟早会有一边判成 `exclusiveCompanionId`。
  {
    route: "orders/route.ts",
    methods: ["GET"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "listCompanionOrders",
    serviceModule: "@/lib/services/companionOrders",
  },
  {
    route: "orders/[id]/route.ts",
    methods: ["GET"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "getCompanionOrderDetail",
    serviceModule: "@/lib/services/companionOrders",
  },
  {
    // P0-6 的**写**入口（`accepted → paid`）。
    route: "orders/[id]/cancel/route.ts",
    methods: ["POST"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "cancelCompanionOrder",
    serviceModule: "@/lib/services/companionOrders",
  },
  {
    // P0-7 的**写**入口（`accepted → serving`）。
    //
    // ⚠️ 它**没有请求体**（没有原因、没有幂等键），因此它的接口里**不应该**出现
    // `readJsonBody`：幂等的判据是状态本身（已经是 `serving` 且归本人就是重放）。
    // 这条不在本文件的断言里，但它是「不许给这个接口发明必填字段」那件事的由来。
    //
    // 它出现在这里就意味着打手端多了一个能改订单状态的接口，因此 `orders/[id]` 下的
    // 写入口必须与下面那条负向门禁一起看——多一个就是偷偷实现了后续 Round。
    route: "orders/[id]/start/route.ts",
    methods: ["POST"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "startCompanionOrder",
    serviceModule: "@/lib/services/companionOrders",
  },
  {
    // P0-8 的**写**入口：打手提交完成材料（`serving` → pending submission）。
    //
    // ⚠️ 它**不直接推进订单**——订单到 completed 是客服通过 / 到期自动通过的结果，
    // 因此「提交完成材料」是完成材料线上的写动作，不是订单状态机的直接写入口。
    // 它出现在这里意味着 `orders/[id]` 下多了一个 POST，负向门禁要跟着一起改。
    route: "orders/[id]/completion/route.ts",
    methods: ["POST"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "submitCompanionCompletion",
    serviceModule: "@/lib/services/companionCompletions",
  },
  {
    // P0-9：打手「我的收益」（**只读**，本阶段没有提现、没有余额调整）。
    //
    // ⚠️ 它**没有请求体、也不读查询参数**：`companionId` 只能来自
    // `requireCompanion()` 的会话身份。多一个参数位就等于给「看别人的收益」留一扇门。
    // 读取路径上必须先物化完成事实、再物化解冻（「先有完成、才有收益」），
    // 因此这一条服务模块同时出现在 `sweepCompletionAutoApprovals` 的调用方白名单里
    // （见 `tests/completions.test.mjs` 的门禁 23）。
    route: "earnings/route.ts",
    methods: ["GET"],
    guard: "requireCompanion",
    guardModule: "@/lib/api/companionRoute",
    service: "listCompanionEarnings",
    serviceModule: "@/lib/services/companionEarnings",
  },
];

/** 全仓路由里**唯一**允许被当作身份守卫的四个名字。多出来的那个就是问题所在。 */
const FORBIDDEN_GUARDS = [
  "requireUser",
  "requireAdmin",
  "requireStaff",
  "getSessionUser",
  "getSessionAdmin",
];

/** Next.js 只会把 HTTP 方法名导出当路由处理函数；别的导出名不是方法。 */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * 这个文件**导出**的 HTTP 方法（去重、排序）。注释先去掉：注释里提到 `POST` 不算导出。
 *
 * 覆盖三种导出写法，缺一种就是一个可以被绕过的洞：
 * 1. `export function GET()` / `export async function GET()`
 * 2. `export const POST = …`
 * 3. `export { GET, POST }` / `export { handler as POST }`
 *
 * ⚠️ 不处理 `export default { POST }`：App Router 的 route handler 只认**具名**导出，
 * 默认导出不会被当成任何方法的路由处理函数，因此它不是一种「导出方法」的写法。
 * 将来若有人这么写，它同时也会被 `exportedMethods` 判为「没导出方法」而变红——方向是安全的。
 */
function exportedMethods(source) {
  const code = stripComments(source);
  const found = new Set();

  const add = (name) => {
    if (HTTP_METHODS.has(name)) found.add(name);
  };

  // 1. 具名函数导出
  for (const match of code.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    add(match[1]);
  }

  // 2. 变量导出（含 `export let` / `export var`——只有 `const` 的话，
  //    把它改成 `let` 就能悄悄绕过这条门禁）
  for (const match of code.matchAll(
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
  )) {
    add(match[1]);
  }

  // 3. 导出列表：`export { GET }` 与 `export { handler as POST }` 都要算
  for (const match of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const clause of match[1].split(",")) {
      const raw = clause.trim();
      if (!raw) continue;
      const parts = raw.split(/\s+as\s+/);
      add((parts[1] ?? parts[0]).trim());
    }
  }

  return [...found].sort();
}

/** 第一次出现的位置；一个都没有返回 -1。 */
function firstIndexOf(source, needles) {
  let best = -1;
  for (const needle of needles) {
    const at = source.indexOf(needle);
    if (at === -1) continue;
    if (best === -1 || at < best) best = at;
  }
  return best;
}

// ——————————————————————————— 一、清单本身的体检 ———————————————————————————

test("清单自己先自检：没有重复地址、每个地址至少声明一个方法、守卫一律是 requireCompanion", () => {
  // 一张写坏了的清单会让下面所有断言一起变成假绿：重复地址会被 deepEqual 的排序掩盖，
  // 空 methods 会让「方法一致」这一条退化成永真。
  const routes = COMPANION_API_MANIFEST.map((entry) => entry.route);
  assert.equal(new Set(routes).size, routes.length, "清单里出现了重复地址");

  for (const entry of COMPANION_API_MANIFEST) {
    assert.ok(entry.methods.length > 0, `${entry.route} 没有声明任何方法`);
    assert.equal(entry.guard, "requireCompanion", `${entry.route} 的守卫必须是打手守卫`);
    assert.equal(
      entry.guardModule,
      "@/lib/api/companionRoute",
      `${entry.route} 的守卫必须来自打手守卫模块`,
    );
  }

  // 打手端当前恰好**八个**接口（P0-5.5 两条 + P0-6 三条 + P0-7 一条 + P0-8 一条 + P0-9 一条）。
  // 改这个数就要同步改清单，不能只是「多了一个」。
  assert.equal(COMPANION_API_MANIFEST.length, 8);
});

// ——————————————————————————— 二、清单与实际路由一致 ———————————————————————————

test("打手接口清单固定：当前恰好八个接口，多一个 / 少一个 / 被改名都会在这里现形", () => {
  const routeFiles = collectFiles(COMPANION_API_DIR).filter((file) => file.endsWith("route.ts"));

  assert.deepEqual(
    routeFiles.map(relativeRoute).sort(),
    COMPANION_API_MANIFEST.map((entry) => entry.route).sort(),
  );
});

test("每个打手接口导出的 HTTP 方法与方法清单一致：多导出一个方法也要现形", () => {
  for (const entry of COMPANION_API_MANIFEST) {
    const file = path.join(COMPANION_API_DIR, entry.route);
    const methods = exportedMethods(readSource(file));

    assert.deepEqual(
      methods,
      [...entry.methods].sort(),
      `${entry.route} 导出的方法与清单不一致`,
    );
  }
});

test("打手接口只调约定的服务层：接口自己写业务逻辑时，这一条会立刻对不上", () => {
  for (const entry of COMPANION_API_MANIFEST) {
    const code = stripComments(readSource(path.join(COMPANION_API_DIR, entry.route)));

    assert.ok(
      code.includes(entry.service),
      `${entry.route} 没有调用约定的服务层函数 ${entry.service}`,
    );
    assert.ok(
      code.includes(entry.serviceModule),
      `${entry.route} 没有从 ${entry.serviceModule} 引入服务层函数`,
    );
  }
});

// ——————————————————————————— 三、鉴权 ———————————————————————————

test("每个打手接口都自己鉴权，而且是第一个动作：任何解析都不能发生在鉴权之前", () => {
  for (const entry of COMPANION_API_MANIFEST) {
    const file = path.join(COMPANION_API_DIR, entry.route);
    const code = stripComments(readSource(file));

    // ⚠️ 比较位置之前**必须先把 import 去掉**。
    // `import { requireCompanion } from "…"` 出现在第 1 行，不去掉它的话
    // 「守卫在第 1 行、比任何解析点都靠前」对**每一个** import 了守卫的文件都无条件成立——
    // 这条断言就退化成了恒为真的摆设：一个 import 了守卫却从不调用它、
    // 上来就 `await request.json()` 的路由照样能过。
    // 仓库既有的同类断言都是先剥 import（`tests/staff.test.mjs` 的
    // `withoutImports(stripComments(readSource(file)))`），这里沿用同一写法。
    const body = withoutImports(code);

    const guard = body.indexOf(entry.guard);
    assert.notEqual(guard, -1, `${entry.route} 缺少打手身份守卫 ${entry.guard} 的调用`);

    // 守卫还必须来自约定的模块：只断言名字出现的话，将来冒出第二个同名的
    // 守卫模块（例如另写一个宽松版本）不会被这条门禁发现。
    assert.ok(
      code.includes(entry.guardModule),
      `${entry.route} 的守卫不是来自 ${entry.guardModule}`,
    );

    // 「先鉴权再干活」不能只靠自觉：把解析成本或业务调用交给一个未认证的请求，
    // 本身就是一次可以被无限放大的开销。这里的判据是**位置**，不是「出现过没有」。
    //
    // 取「解析点」与「服务层调用」两类里最早出现的那一处，两者都必须排在守卫之后：
    // - 只比解析点的话，`dispatches/route.ts`（GET、不读任何参数）会让整条断言无从判定；
    // - 只比服务层调用的话，「先 `await request.json()` 再鉴权」这种写法会漏掉。
    const parseAt = firstIndexOf(body, [
      "readJsonBody",
      "request.json(",
      "context.params",
      "searchParams",
    ]);
    const workAt = body.indexOf(entry.service);

    const boundaries = [parseAt, workAt].filter((at) => at !== -1);
    assert.notEqual(
      boundaries.length,
      0,
      `${entry.route} 既不读参数也不调服务层，这条断言无从判定`,
    );
    for (const boundary of boundaries) {
      assert.ok(
        guard < boundary,
        `${entry.route} 的守卫必须排在读取参数 / 请求体 / 调用服务层之前`,
      );
    }
  }
});

test("打手接口不会混进别的身份守卫：混进一个就等于开了第二条进工作台的路", () => {
  for (const entry of COMPANION_API_MANIFEST) {
    const file = path.join(COMPANION_API_DIR, entry.route);
    const code = stripComments(readSource(file));

    for (const forbidden of FORBIDDEN_GUARDS) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${entry.route} 不该出现 ${forbidden}`,
      );
    }
  }
});

// ——————————————————————————— 四、不得提前落地未来的接口 ———————————————————————————

/**
 * 写入口集合门禁：`orders/**` 下**恰好三个**写入口。
 *
 * ## 这条挡的不是「以后不许做」，而是「现在别偷偷做」
 *
 * 到 P0-8 为止，`orders/[id]` 下导出 POST 的恰好三个：`cancel`（P0-6 主动取消，
 * `accepted → paid`）、`start`（P0-7 开始服务，`accepted → serving`）、
 * `completion`（P0-8 提交完成材料，`serving` → pending submission）。
 *
 * ⚠️ `completion` 与另两个**性质不同**：它不直接推进订单状态——订单到 `completed`
 * 是客服通过 / 到期自动通过的结果，入口在客服端，不在打手端。但「一个 route 文件
 * 导出了 POST」就是一个写入口，这条门禁按**行为性质**而不是业务语义数入口：
 * 多一个 POST 就现形。
 *
 * P0-6 时这条断言写的是「只有 cancel 一个」，P0-7 改成「就这两个」，P0-8 改成
 * 「就这三个」——每一次都**在轮次里显式改一次**，这正是它存在的意义：下一位要落地
 * `serving → completed` 的直接写入口（或任何新写动作）时会先看到它变红。
 *
 * ## 为什么断言「写入口集合」而不是只断言某个具体名字
 *
 * 只断言 `start` 这个名字的话，把接口叫 `begin` / `serve` / `submit` 就绕过去了，
 * 而「打手点一下就能把订单推进到下一步」这件事与名字无关。因此判据是**行为性质**：
 * 一个 route 文件导出了 `POST`，它就是一个写入口。
 */
test("写入口门禁：orders 下恰好三个写入口——completion（P0-8）、start（P0-7）与 cancel（P0-6），再多就是偷偷实现了后续 Round", () => {
  // (1) P0-8 的地址必须**在**（它已从 TARGET 变成 CURRENT）。
  //     `hasAppFile` 已忽略路由组，因此换个目录层级也躲不过去
  assert.equal(
    hasAppFile("api/companion/orders/[id]/completion/route.ts"),
    true,
    "「提交完成材料」已在 P0-8 落地：地址必须存在（缺了上面那条清单一致性也会红）",
  );

  // (2) 不点名任何具体动词：`orders/**` 下导出 POST 的只能有这三个
  const writeEntries = collectFiles(path.join(COMPANION_API_DIR, "orders"))
    .filter((file) => file.endsWith("route.ts"))
    .filter((file) => exportedMethods(readSource(file)).includes("POST"))
    .map(relativeRoute)
    .sort();

  assert.deepEqual(
    writeEntries,
    ["orders/[id]/cancel/route.ts", "orders/[id]/completion/route.ts", "orders/[id]/start/route.ts"],
    "orders 下多了一个写入口：到 P0-8 为止打手只有「主动取消接单」「开始服务」「提交完成材料」三个写动作，其余（确认完成等）都是后续 Round 的范围",
  );

  // (3) 清单与上面这份集合必须是同一件事：登记进去而磁盘上没有，是最难被发现的一种不一致
  const startEntries = COMPANION_API_MANIFEST.filter((entry) =>
    entry.route.split("/").includes("start"),
  );
  assert.deepEqual(
    startEntries.map((entry) => entry.route),
    ["orders/[id]/start/route.ts"],
    "P0-7 起清单里必须有且只有一条 start 段——它不再是 TARGET",
  );
});

/**
 * 「开始服务」接口**不读请求体**。
 *
 * 这个动作没有原因、没有幂等键（幂等判据是状态本身），因此它的接口里不该出现
 * `readJsonBody`：调了它，一个空的 POST 体就会变成 400「请求体格式无效」——
 * 等于给这个接口发明了一条服务端文档里并不存在的必填体规则。
 *
 * 反过来读它就是另一件更糟的事：一旦有了 body，下一位就可能从里面取 `companionId`
 * 当身份用。这条断言把「身份只能来自 `requireCompanion()`」这句注释变成可执行的。
 */
test("开始服务接口不读请求体：没有原因、没有幂等键，身份与参数都不可能来自调用方", () => {
  const code = stripComments(readSource(path.join(COMPANION_API_DIR, "orders/[id]/start/route.ts")));

  assert.equal(
    code.includes("readJsonBody"),
    false,
    "开始服务没有请求体：调 readJsonBody 会把「空体」判成非法，也会给「从 body 取身份」留一扇门",
  );
  assert.equal(
    code.includes("request.json("),
    false,
    "开始服务不解析请求体：解析一定是为了让某个字段生效，而这个接口一个字段都不该有",
  );
});
