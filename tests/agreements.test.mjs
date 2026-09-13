import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { resolveSource } from "./app-path.mjs";
import {
  AGREEMENT_MOCK_NOTICE,
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_LABELS,
  PLATFORM_CONTACT_PLACEHOLDER,
  PLATFORM_ENTITY_PLACEHOLDER,
  agreementTypeLabel,
  buildAgreementsDto,
  compareAgreementVersion,
  formatAgreementVersion,
  pickCurrentAgreements,
  toAgreementDetail,
} from "../lib/constants/agreements.ts";
import { getAgreementRepository } from "../lib/data/agreementRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { agreementSeed } from "../lib/mocks/fixtures/agreementSeed.ts";
import { listAgreements } from "../lib/services/agreements.ts";

/**
 * 协议与版本介绍的持续测试。
 *
 * 四条规则是本阶段的重点：
 *
 * 1. **每类只展示当前启用版本**：同类型多版本取最高（`user` 有 1.1.0 与 1.0.0）；
 *    停用版本不出现（`platform` 的 1.0.0 已停用）；
 * 2. **缺内容不放大成整页失败**：某一类没配置只让那一块显示「内容暂未配置」；
 * 3. **不编造法律信息**：平台主体名称、联系方式一律是明显的占位变量，
 *    正文里没有公司名、注册地址、电话、统一社会信用代码；
 * 4. **只读且游客可见**：仓储没有写方法、接口只有 GET、客户端没有编辑入口，
 *    正文以结构化段落下发，不使用不受控 HTML。
 */

const ORIGINAL_MOCK_DEBUG = process.env.ENABLE_MOCK_DEBUG;

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** 去掉注释后再做「源码里不该出现某标识」的断言。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

beforeEach(() => {
  resetMockStore("agreement");
});

afterEach(() => {
  if (ORIGINAL_MOCK_DEBUG === undefined) delete process.env.ENABLE_MOCK_DEBUG;
  else process.env.ENABLE_MOCK_DEBUG = ORIGINAL_MOCK_DEBUG;
});

test("四类内容都有页签，顺序固定，标签与服务端同源", () => {
  assert.deepEqual([...AGREEMENT_TYPES], ["user", "companion", "platform", "version"]);

  const dto = buildAgreementsDto(agreementSeed);
  assert.deepEqual(
    dto.tabs.map((tab) => tab.type),
    ["user", "companion", "platform", "version"],
  );
  for (const tab of dto.tabs) {
    assert.equal(tab.label, AGREEMENT_TYPE_LABELS[tab.type]);
    assert.equal(tab.label, agreementTypeLabel(tab.type));
    assert.ok(tab.agreement, `${tab.type} 应有内容`);
  }
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

test("某一类没有内容时只让那一块为空，其他类型照常渲染", () => {
  // 只剩用户协议：其余三类为 null，但页签仍然齐全
  const onlyUser = buildAgreementsDto(agreementSeed.filter((item) => item.type === "user"));
  assert.equal(onlyUser.tabs.length, 4);
  assert.ok(onlyUser.tabs.find((tab) => tab.type === "user").agreement);
  for (const type of ["companion", "platform", "version"]) {
    assert.equal(onlyUser.tabs.find((tab) => tab.type === type).agreement, null);
  }

  // 一条内容都没有：四个页签全部为 null，而不是抛错
  const none = buildAgreementsDto([]);
  assert.equal(none.tabs.length, 4);
  for (const tab of none.tabs) assert.equal(tab.agreement, null);
  assert.ok(none.notice.length > 0, "内容为空时仍然要说明内容性质");
});

test("服务层：四类内容一次返回，且都是结构化段落而不是 HTML", async () => {
  const dto = await listAgreements(page(), "server");

  assert.equal(dto.tabs.length, 4);
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
  assert.equal(dto.tabs.length, 4);
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

test("只读：仓储没有写方法，接口只有 GET，客户端没有编辑入口", async () => {
  const repository = getAgreementRepository();
  assert.deepEqual(Object.keys(repository).sort(), ["listAgreements"]);
  for (const name of Object.keys(repository)) {
    assert.equal(/create|update|save|write|set|delete/i.test(name), false, `仓储不该有写方法：${name}`);
  }

  const routeSource = readFileSync("app/api/agreements/route.ts", "utf8");
  assert.match(routeSource, /export async function GET/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(routeSource),
      false,
      `协议接口不该出现 ${method}`,
    );
  }
  // 游客可访问：不收用户身份，也就没有可以泄漏的用户数据
  const routeCode = stripComments(routeSource);
  assert.equal(/requireUser\s*\(/.test(routeCode), false, "协议页不该要求登录");

  // 页面与组件都不引用 Mock：正文只能来自服务端数据层
  for (const file of [
    "app/agreements/page.tsx",
    "components/agreements/AgreementTabs.tsx",
  ]) {
    // resolveSource：`app/...` 按路由找（路由组已忽略），`components/...` 原样
    const code = stripComments(readFileSync(resolveSource(file), "utf8"));
    assert.equal(code.includes("lib/mocks"), false, `${file} 不该引用 lib/mocks`);
    assert.equal(code.includes("lib/data/"), false, `${file} 不该直接引用 lib/data`);
    // 不使用不受控 HTML
    assert.equal(code.includes("dangerouslySetInnerHTML"), false, `${file} 不该使用 dangerouslySetInnerHTML`);
    assert.equal(code.includes("innerHTML"), false, `${file} 不该使用 innerHTML`);
  }

  // 页面不写死条款正文：正文只能来自数据层
  const pageCode = stripComments(readFileSync(resolveSource("app/agreements/page.tsx"), "utf8"));
  for (const clause of ["争议解决", "免责", "不可抗力", "账号注册"]) {
    assert.equal(pageCode.includes(clause), false, `页面里写死了条款正文：${clause}`);
  }
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
