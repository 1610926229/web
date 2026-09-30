import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveSource } from "./app-path.mjs";
import {
  AGREEMENT_MOCK_NOTICE,
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_LABELS,
  PLATFORM_CONTACT_PLACEHOLDER,
  PLATFORM_ENTITY_PLACEHOLDER,
  agreementTypeLabel,
  buildAgreementsDto,
  bumpAgreementVersion,
  compareAgreementVersion,
  formatAgreementVersion,
  pickCurrentAgreements,
  toAgreementDetail,
} from "../lib/constants/agreements.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getAgreementRepository } from "../lib/data/agreementRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { agreementSeed } from "../lib/mocks/fixtures/agreementSeed.ts";
import {
  getAdminAgreementDetail,
  setAdminAgreementEnabled,
  updateAdminAgreement,
} from "../lib/services/adminAgreements.ts";
import { listAgreements } from "../lib/services/agreements.ts";
// 用户端协议服务的**完整导出表**本身也要断言（只有读函数，一个写函数都没有）。
// 命名导入与命名空间导入指向同一个模块实例，node 不会加载两遍。
import * as publicServiceModule from "../lib/services/agreements.ts";

/**
 * 协议与版本介绍的持续测试。
 *
 * 五条规则是本阶段的重点：
 *
 * 1. **每类只展示当前启用版本**：同类型多版本取最高（`user` 有 1.1.0 与 1.0.0）；
 *    停用版本不出现（`platform` 的 1.0.0 已停用）；
 * 2. **缺内容不放大成整页失败**：某一类没配置只让那一块显示「内容暂未配置」；
 * 3. **不编造法律信息**：平台主体名称、联系方式一律是明显的占位变量，
 *    正文里没有编造的公司名称、登记地址、电话与主体登记信息；
 * 4. **Public 永远只读，Admin 独占写权限**（P8E-1）。这一条在下面分成三组断言：
 *    (a) 用户端这一侧至今没有任何写入口——接口只有 GET、页面没有编辑入口、
 *    正文以结构化段落下发且不使用不受控 HTML；
 *    (b) 写能力只存在于 `app/api/admin/**`，且每个管理接口都自己 `requireAdmin()`；
 *    (c) **后台配置真正驱动用户端内容**：Admin 改完正文，用户端读到的就是新正文。
 *
 * ⚠️ 第 4 条是 P8E-1 对既有约束的**升级**而不是放宽：改之前这里断言的是
 * 「整个协议系统不可写」，那条断言已经被真实需求推翻（协议正文必须能由后台维护），
 * 于是它被换成了更强的一组——「谁能写、写在哪、写完用户端看到什么」，
 * 而不是把原来那条测试删掉了事。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "app", "api");
const ADMIN_API_DIR = path.join(ROOT, "app", "api", "admin");

/** 执行协议写操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置里 `user` 类型的当前版本（1.1.0）：后台改它，用户端读到的就是它。 */
const USER_CURRENT = "ag-user-110";

const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

let operationSeq = 0;

function operationKey() {
  operationSeq += 1;
  return `op-agreements-${operationSeq}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 递归收集某个目录下的全部 `route.ts`。 */
function collectRouteFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

function relativeTo(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

/** 递归收集某个目录下的全部 `.ts` / `.tsx` 源文件（用于「谁引用了写服务」这类扫描）。 */
function collectSourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

beforeEach(() => {
  resetMockStore("agreement");
  // 写操作会写审计：每个用例都要从「没有人操作过」出发
  resetMockStore("adminAudit");
});

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

test("五类内容都有页签，顺序固定，标签与服务端同源", () => {
  assert.deepEqual(
    [...AGREEMENT_TYPES],
    ["user", "privacy", "companion", "platform", "version"],
  );

  const dto = buildAgreementsDto(agreementSeed);
  assert.deepEqual(
    dto.tabs.map((tab) => tab.type),
    ["user", "privacy", "companion", "platform", "version"],
  );
  assert.equal(dto.tabs.length, 5);
  for (const tab of dto.tabs) {
    assert.equal(tab.label, AGREEMENT_TYPE_LABELS[tab.type]);
    assert.equal(tab.label, agreementTypeLabel(tab.type));
    assert.ok(tab.agreement, `${tab.type} 应有内容`);
  }

  // 隐私协议是 P8E-1 新增的第五类，插在用户协议之后（两者同属「你与平台之间」的文件）
  assert.equal(dto.tabs[0].type, "user");
  assert.equal(dto.tabs[1].type, "privacy");
  assert.equal(dto.tabs[1].label, "隐私协议");
  assert.equal(dto.tabs[1].agreement.title, "隐私协议");

  // 五个页签的类型各不相同（每个类型恰好一项）
  assert.equal(new Set(AGREEMENT_TYPES).size, AGREEMENT_TYPES.length);
  assert.equal(Object.keys(AGREEMENT_TYPE_LABELS).length, AGREEMENT_TYPES.length);
});

test("版本选择：同类多版本取最高，停用版本不出现", () => {
  const picked = pickCurrentAgreements(agreementSeed);

  // user 有两个启用版本（1.1.0 / 1.0.0）：必须取 1.1.0
  assert.equal(picked.get("user").id, "ag-user-110");
  assert.equal(picked.get("user").version, "1.1.0");

  // platform 的 2.0.0 启用、1.0.0 停用：必须取 2.0.0，且停用那条完全不可见
  assert.equal(picked.get("platform").id, "ag-platform-200");
  assert.equal(picked.get("platform").version, "2.0.0");

  const dto = buildAgreementsDto(agreementSeed);
  const serialized = JSON.stringify(dto);
  assert.equal(serialized.includes("ag-user-100"), false, "较早版本不该出现在响应里");
  assert.equal(serialized.includes("ag-platform-100"), false, "停用版本不该出现在响应里");
  assert.equal(serialized.includes("已停用"), false);

  // 每个类型只有一条：多版本不会同时展示
  const ids = dto.tabs.map((tab) => tab.agreement.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("版本号比较：按段比数字，1.10.0 高于 1.9.0", () => {
  assert.ok(compareAgreementVersion("1.1.0", "1.0.0") > 0);
  assert.ok(compareAgreementVersion("1.0.0", "1.1.0") < 0);
  assert.equal(compareAgreementVersion("2.0.0", "2.0.0"), 0);
  // 逐段比较，不是字符串比较：否则 "1.10.0" 会被判成小于 "1.9.0"
  assert.ok(compareAgreementVersion("1.10.0", "1.9.0") > 0);
  assert.ok(compareAgreementVersion("2.0.0", "1.99.99") > 0);
  // 缺段按 0 处理，不会因为格式不齐而抛错
  assert.equal(compareAgreementVersion("1.2", "1.2.0"), 0);
  assert.ok(compareAgreementVersion("1.2.1", "1.2") > 0);

  assert.equal(formatAgreementVersion("1.2.0"), "v1.2.0");
});

/**
 * `bumpAgreementVersion()` 的**直接**测试。
 *
 * ⚠️ 补这一条的理由（P8E-1 复核发现 D.10）：它是「改正文 → 版本号递增」这条链上
 * 唯一一个纯函数，但此前**只被间接覆盖**——预置数据里的版本（`1.0.0` / `1.1.0` / `2.0.0`）
 * 全是纯数字段，因此「末段不是数字」与「空串」两条分支在测试里**从未被执行过**。
 * 只看「新版本比旧版本大」的间接断言也钉不住它：末段回落分支写错时，
 * 递增出来的字符串仍然可能比旧的大，而版本号是否可读、是否可比较是另一回事。
 *
 * 这条链的另一半是 `compareAgreementVersion()`：**递增出来的版本必须比原来大**，
 * 否则「哪一份是当前生效的」会算错——因此这里两个函数一起断言，
 * 而不是只断言字符串长得对。
 */
test("版本号递增：末段数字、末段非数字、空串三种情况都要有确定的结果", () => {
  // 末段是数字：递增它（修订号语义），段数不变
  assert.equal(bumpAgreementVersion("1.2.0"), "1.2.1");
  assert.equal(bumpAgreementVersion("1.2"), "1.3");
  assert.equal(bumpAgreementVersion("3"), "4");
  // 前导零不当成八进制，也不保留：递增的是数值
  assert.equal(bumpAgreementVersion("1.2.09"), "1.2.10");

  // 末段不是数字：**追加**一段 `.1`，不猜
  assert.equal(bumpAgreementVersion("v1.beta"), "v1.beta.1");
  assert.equal(bumpAgreementVersion("1.2.x"), "1.2.x.1");

  // 空串与纯空白：回落成 `1`（协议不能没有版本号，但它也不该抛错）
  assert.equal(bumpAgreementVersion(""), "1");
  assert.equal(bumpAgreementVersion("   "), "1");

  // 首尾空白不进入结果：递增的是 trim 之后的值，不是「带空格的版本号」
  assert.equal(bumpAgreementVersion("  1.2.0  "), "1.2.1");

  // ⚠️ 真正的约束：递增之后在**比较规则**下必须更大。
  // 版本号不是给人看的一串字符，它是「当前生效的是哪一份」的判定依据
  for (const before of ["1.2.0", "1.2", "3", "1.2.09", "v1.beta", "1.2.x", "", "   "]) {
    const after = bumpAgreementVersion(before);
    assert.ok(
      compareAgreementVersion(after, before) > 0,
      `「${before}」递增成「${after}」之后并不比原来大——用户端会继续读到旧的那一份`,
    );
  }
});

test("某一类没有内容时只让那一块为空，其他类型照常渲染", () => {
  // 只剩用户协议：其余四类为 null，但页签仍然齐全
  const onlyUser = buildAgreementsDto(agreementSeed.filter((item) => item.type === "user"));
  assert.equal(onlyUser.tabs.length, 5);
  assert.ok(onlyUser.tabs.find((tab) => tab.type === "user").agreement);
  for (const type of ["privacy", "companion", "platform", "version"]) {
    assert.equal(onlyUser.tabs.find((tab) => tab.type === type).agreement, null);
  }

  // 一条内容都没有：五个页签全部为 null，而不是抛错
  const none = buildAgreementsDto([]);
  assert.equal(none.tabs.length, 5);
  for (const tab of none.tabs) assert.equal(tab.agreement, null);
  assert.ok(none.notice.length > 0, "内容为空时仍然要说明内容性质");
});

test("服务层：五类内容一次返回，且都是结构化段落而不是 HTML", async () => {
  const dto = await listAgreements(page(), "server");

  assert.equal(dto.tabs.length, 5);
  assert.equal(dto.notice, AGREEMENT_MOCK_NOTICE);
  assert.ok(dto.notice.includes("示例"), "必须写明是示例文案，不是正式生效的协议");

  for (const tab of dto.tabs) {
    const agreement = tab.agreement;
    assert.ok(Array.isArray(agreement.sections) && agreement.sections.length > 0);
    for (const section of agreement.sections) {
      assert.equal(typeof section.heading, "string");
      assert.ok(Array.isArray(section.paragraphs) && section.paragraphs.length > 0);
      for (const paragraph of section.paragraphs) {
        assert.equal(typeof paragraph, "string");
      }
      // 正文里不能出现标签：它是纯文本段落，页面按纯文本渲染
      assert.equal(/<[a-z][\s\S]*>/i.test(section.paragraphs.join("")), false);
    }
    // 每条内容的第一段都标注了「示例内容」
    assert.ok(
      agreement.sections[0].paragraphs[0].includes("示例"),
      `${tab.type} 的开头没有标注示例内容`,
    );
  }
});

test("DTO 不包含配置字段：没有 enabled，也没有历史版本", async () => {
  const dto = await listAgreements(page(), "server");

  assert.deepEqual(Object.keys(dto).sort(), ["notice", "tabs"]);
  assert.deepEqual(
    Object.keys(dto.tabs[0]).sort(),
    ["agreement", "label", "type"],
  );
  assert.deepEqual(
    Object.keys(dto.tabs[0].agreement).sort(),
    ["id", "sections", "title", "type", "updatedAt", "version"],
  );
  assert.equal("enabled" in dto.tabs[0].agreement, false, "配置字段不该外泄");
});

test("?mockEmpty=agreements 演示「内容暂未配置」，且不抛错", async () => {
  process.env.ENABLE_MOCK_DEBUG = "true";

  const dto = await listAgreements(page({ mockEmpty: "agreements", mockDelay: 0 }), "server");
  assert.equal(dto.tabs.length, 5);
  for (const tab of dto.tabs) assert.equal(tab.agreement, null);

  // 别的范围不受影响
  const normal = await listAgreements(page({ mockEmpty: "levels", mockDelay: 0 }), "server");
  assert.ok(normal.tabs.every((tab) => tab.agreement));
});

test("不编造法律信息：主体名称与联系方式一律是占位变量", () => {
  const serialized = JSON.stringify(agreementSeed);

  // 占位变量本身必须能一眼看出来是「待配置」
  assert.ok(PLATFORM_ENTITY_PLACEHOLDER.includes("待配置"));
  assert.ok(PLATFORM_CONTACT_PLACEHOLDER.includes("待配置"));
  assert.equal(serialized.includes(PLATFORM_ENTITY_PLACEHOLDER), true);
  assert.equal(serialized.includes(PLATFORM_CONTACT_PLACEHOLDER), true);

  // 正文里没有任何编造的公司名、地址、电话、统一社会信用代码
  for (const pattern of [
    /有限公司/,
    /有限责任/,
    /统一社会信用代码/,
    /注册地址/,
    /1[3-9]\d{9}/, // 手机号
    /0\d{2,3}-\d{7,8}/, // 座机
  ]) {
    assert.equal(pattern.test(serialized), false, `正文里出现了不该编造的信息：${pattern}`);
  }
});

// ————————————————— Public 永远只读（P8E-1 升级后的约束）—————————————————

test("Public 只读（一）：用户端只有 GET 一个协议接口，且不要求登录", () => {
  // 递归扫 app/api/agreements/**：只要 GET，一个写方法都没有
  const publicRoutes = collectRouteFiles(path.join(API_DIR, "agreements"));
  assert.deepEqual(
    publicRoutes.map((file) => relativeTo(API_DIR, file)),
    ["agreements/route.ts"],
  );

  const routeSource = readFileSync(resolveSource("app/api/agreements/route.ts"), "utf8");
  assert.match(routeSource, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(routeSource),
      false,
      `协议接口不该出现 ${method}`,
    );
  }

  // 游客可访问：不收用户身份，也就没有可以泄漏的用户数据；更没有任何管理端写入口
  const routeCode = stripComments(routeSource);
  assert.equal(/requireUser\s*\(/.test(routeCode), false, "协议页不该要求登录");
  assert.equal(routeCode.includes("requireAdmin"), false, "用户端协议接口不该是管理接口");
  assert.equal(routeCode.includes("adminAgreements"), false, "用户端协议接口不该引用管理端写服务");
  assert.equal(routeCode.includes("updateAgreement"), false);
  assert.equal(routeCode.includes("setAgreementEnabled"), false);

  // 用户端服务本身也没有写能力：导出表里只有读取
  assert.deepEqual(
    Object.keys(publicServiceModule).sort(),
    ["listAgreements"],
    "用户端协议服务只应当有读函数",
  );
  const publicServiceCode = stripComments(
    readFileSync(path.join(ROOT, "lib", "services", "agreements.ts"), "utf8"),
  );
  for (const writer of ["updateAgreement", "setAgreementEnabled", "adminAgreements"]) {
    assert.equal(publicServiceCode.includes(writer), false, `用户端服务不该出现 ${writer}`);
  }
});

test("Public 只读（二）：用户端页面与组件没有编辑入口，也不使用不受控 HTML", () => {
  const files = [
    "app/agreements/page.tsx",
    "app/agreements/loading.tsx",
    "app/agreements/error.tsx",
    "components/agreements/AgreementTabs.tsx",
  ];

  for (const file of files) {
    // resolveSource：`app/...` 按路由找（路由组已忽略），`components/...` 原样
    const code = stripComments(readFileSync(resolveSource(file), "utf8"));

    // 正文只能来自服务端数据层
    assert.equal(code.includes("lib/mocks"), false, `${file} 不该引用 lib/mocks`);
    assert.equal(code.includes("lib/data/"), false, `${file} 不该直接引用 lib/data`);

    // ⚠️ 不使用不受控 HTML：正文是结构化段落，页面按纯文本渲染
    assert.equal(code.includes("dangerouslySetInnerHTML"), false, `${file} 不该使用 dangerouslySetInnerHTML`);
    assert.equal(code.includes("innerHTML"), false, `${file} 不该使用 innerHTML`);

    // 没有任何写操作的痕迹
    for (const word of ["编辑", "保存", "提交", "updateAgreement", "setAgreementEnabled", "adminAgreements"]) {
      assert.equal(code.includes(word), false, `${file} 里出现了写操作的痕迹：${word}`);
    }
    assert.equal(/contentEditable/i.test(code), false, `${file} 不该有可编辑区域`);
    assert.equal(/<textarea/.test(code), false, `${file} 不该有正文输入框`);
  }

  // 页面不写死条款正文：正文只能来自数据层
  const pageCode = stripComments(readFileSync(resolveSource("app/agreements/page.tsx"), "utf8"));
  for (const clause of ["争议解决", "免责", "不可抗力", "账号注册"]) {
    assert.equal(pageCode.includes(clause), false, `页面里写死了条款正文：${clause}`);
  }
});

test("Admin 独占写能力：写入口只在 app/api/admin 下，且每个 handler 都自己调用 requireAdmin()", () => {
  // ① 只有 app/api/admin/** 下的路由引用了协议写服务
  const adminAgreementRoutes = collectRouteFiles(ADMIN_API_DIR).filter((file) =>
    stripComments(readFileSync(file, "utf8")).includes("adminAgreements"),
  );
  assert.deepEqual(
    adminAgreementRoutes.map((file) => relativeTo(ADMIN_API_DIR, file)).sort(),
    [
      "content/agreements/[id]/disable/route.ts",
      "content/agreements/[id]/enable/route.ts",
      "content/agreements/[id]/route.ts",
      "content/agreements/route.ts",
    ],
  );

  const nonAdminRoutes = collectRouteFiles(API_DIR).filter(
    (file) => relativeTo(ADMIN_API_DIR, file).startsWith(".."),
  );
  assert.ok(nonAdminRoutes.length >= 20, "用户端 / 客服端路由都应当被扫到");
  for (const file of nonAdminRoutes) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(
      code.includes("adminAgreements"),
      false,
      `${relativeTo(API_DIR, file)} 在管理端之外引用了协议写服务`,
    );
  }

  // ② 每个管理端协议路由的每个 handler 都自己鉴权
  for (const file of collectRouteFiles(path.join(ADMIN_API_DIR, "content", "agreements"))) {
    const relative = relativeTo(ADMIN_API_DIR, file);
    const code = stripComments(readFileSync(file, "utf8"));

    assert.ok(
      code.includes("requireAdmin()"),
      `${relative} 没有调用 requireAdmin()：页面隐藏按钮挡不住直接请求接口`,
    );

    // 每个导出的 handler 里都要有 requireAdmin()：一段源码里出现过一次不算数
    const handlers = code.match(/export async function [A-Z]+\([\s\S]*?(?=\nexport |\n?$)/g) ?? [];
    assert.ok(handlers.length > 0, `${relative} 里没有找到导出的 handler`);
    for (const handler of handlers) {
      assert.ok(
        handler.includes("requireAdmin()"),
        `${relative} 里有一个 handler 没有自己鉴权`,
      );
    }
  }

  // ③ 协议写服务只被 app/admin/** 与 app/api/admin/** 引用（页面与接口两侧都是管理端）
  const adminAgreementRoutesSet = new Set(adminAgreementRoutes);
  for (const file of collectSourceFiles(path.join(ROOT, "app")).concat(
    collectSourceFiles(path.join(ROOT, "components")),
  )) {
    if (adminAgreementRoutesSet.has(file)) continue;
    const relative = relativeTo(ROOT, file);
    if (relative.startsWith("app/admin/") || relative.startsWith("app/api/admin/")) continue;

    assert.equal(
      readFileSync(file, "utf8").includes("services/adminAgreements"),
      false,
      `${relative} 在管理端之外引用了协议写服务`,
    );
  }
});

// ————————————————— Admin 写完之后，用户端看到什么 —————————————————

test("Admin 能改标题与正文：用户端读到的就是新正文（后台配置真正驱动用户端内容）", async () => {
  const before = await listAgreements(page(), "server");
  const beforeTab = before.tabs.find((tab) => tab.type === "user");
  assert.equal(beforeTab.agreement.id, USER_CURRENT);

  const result = await updateAdminAgreement(ADMIN_ID, USER_CURRENT, {
    idempotencyKey: operationKey(),
    title: "用户协议（后台改过）",
    sections: [{ heading: "重要提示", paragraphs: ["这一段是后台写进去的正文。"] }],
    enabled: true,
  });
  assert.equal(result.changed, true);
  assert.ok(
    compareAgreementVersion(result.version, beforeTab.agreement.version) > 0,
    "正文变了，版本号必须递增",
  );

  const after = await listAgreements(page(), "server");
  const afterTab = after.tabs.find((tab) => tab.type === "user");

  assert.equal(afterTab.agreement.title, "用户协议（后台改过）");
  assert.deepEqual(afterTab.agreement.sections, [
    { heading: "重要提示", paragraphs: ["这一段是后台写进去的正文。"] },
  ]);
  assert.equal(afterTab.agreement.version, result.version);

  // ⚠️ 公开 DTO 里**没有** `enabled`：既有约束一个字都没有放宽
  assert.equal("enabled" in afterTab.agreement, false);
  assert.deepEqual(
    Object.keys(afterTab.agreement).sort(),
    ["id", "sections", "title", "type", "updatedAt", "version"],
  );

  // 只改了 user 一类，其他四类一个字都没动
  for (const type of ["privacy", "companion", "platform", "version"]) {
    const tab = after.tabs.find((item) => item.type === type);
    const old = before.tabs.find((item) => item.type === type);
    assert.deepEqual(tab.agreement, old.agreement, `${type} 不该被影响`);
  }

  // 详情接口能拿到刚写进去的正文（编辑表单要用的就是它）
  const detail = await getAdminAgreementDetail(USER_CURRENT, undefined, "server");
  assert.equal(detail.title, "用户协议（后台改过）");
  assert.equal(detail.version, result.version);
  assert.equal(detail.enabled, true);
});

test("Admin 能启用 / 停用：停用后用户端显示「内容暂未配置」，重新启用即恢复", async () => {
  const privacy = agreementSeed.find((item) => item.type === "privacy");
  assert.ok(privacy, "预置数据里应当有隐私协议");

  const off = await setAdminAgreementEnabled(ADMIN_ID, privacy.id, false, {
    idempotencyKey: operationKey(),
  });
  assert.equal(off.changed, true);
  assert.equal(off.enabled, false);
  assert.equal(off.version, privacy.version, "启用状态不是正文的版本");

  const hidden = await listAgreements(page(), "server");
  assert.equal(hidden.tabs.length, 5, "停用一类不影响页签数量");
  assert.equal(hidden.tabs.find((tab) => tab.type === "privacy").agreement, null);
  assert.ok(hidden.tabs.find((tab) => tab.type === "user").agreement, "其他类型照常");

  const on = await setAdminAgreementEnabled(ADMIN_ID, privacy.id, true, {
    idempotencyKey: operationKey(),
  });
  assert.equal(on.changed, true);
  assert.equal(on.version, privacy.version);

  const restored = await listAgreements(page(), "server");
  const tab = restored.tabs.find((item) => item.type === "privacy");
  assert.ok(tab.agreement, "重新启用之后必须真的回到用户端");
  assert.equal(tab.agreement.version, privacy.version);
  assert.deepEqual(tab.agreement.sections, privacy.sections);
});

test("Admin 改正文后版本号递增；提交的内容没变时不写审计、不动版本号", async () => {
  const auditRepository = getAdminAuditRepository();
  const before = await getAgreementRepository().findAgreementById(USER_CURRENT);

  // ① 提交的内容与现状完全一致：什么都不写
  const noop = await updateAdminAgreement(ADMIN_ID, USER_CURRENT, {
    idempotencyKey: operationKey(),
    title: before.title,
    sections: before.sections,
    enabled: before.enabled,
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.version, before.version);
  assert.deepEqual(await getAgreementRepository().findAgreementById(USER_CURRENT), before);
  assert.equal((await auditRepository.listAudits({ targetType: "agreement" })).length, 0);

  // ② 正文真的变了：版本号递增，且只有一条审计
  const edited = await updateAdminAgreement(ADMIN_ID, USER_CURRENT, {
    idempotencyKey: operationKey(),
    title: before.title,
    sections: [{ heading: "重要提示", paragraphs: ["改过的正文。"] }],
    enabled: before.enabled,
  });
  assert.equal(edited.changed, true);
  assert.ok(compareAgreementVersion(edited.version, before.version) > 0);

  const audits = await auditRepository.listAudits({
    targetType: "agreement",
    targetId: USER_CURRENT,
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "agreement.update");
  assert.equal(audits[0].actorRole, "admin");
  // 审计快照记的是「动作与规模」，不是正文
  assert.equal("sections" in audits[0].after, false);
  assert.equal(audits[0].after.paragraphCount, 1);
});

test("toAgreementDetail 显式挑字段，且不与仓储实体共享引用", () => {
  const record = agreementSeed[0];
  const detail = toAgreementDetail(record);

  assert.equal(detail.id, record.id);
  assert.equal(detail.title, record.title);
  assert.equal(detail.version, record.version);
  assert.equal(detail.updatedAt, record.updatedAt);
  assert.equal("enabled" in detail, false);

  // 深拷贝：调用方改了 DTO 的段落，不能影响仓储里的数据
  detail.sections[0].paragraphs.push("被改过的段落");
  assert.equal(
    record.sections[0].paragraphs.includes("被改过的段落"),
    false,
    "DTO 与实体共享了引用，改 DTO 会影响后续请求",
  );

  // 每次转换都是新对象：两次请求拿到的不是同一个引用
  assert.notEqual(toAgreementDetail(record), toAgreementDetail(record));
});
