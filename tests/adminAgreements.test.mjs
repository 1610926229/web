import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import {
  ADMIN_AGREEMENT_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  ADMIN_AGREEMENT_NOT_FOUND_MESSAGE,
  ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE,
  AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE,
  AGREEMENT_PARAGRAPH_EMPTY_MESSAGE,
  AGREEMENT_PARAGRAPHS_EMPTY_MESSAGE,
  AGREEMENT_PARAGRAPH_MAX_LENGTH,
  AGREEMENT_PARAGRAPH_TOO_LONG_MESSAGE,
  AGREEMENT_SECTIONS_EMPTY_MESSAGE,
  AGREEMENT_SECTION_MAX_COUNT,
  AGREEMENT_SECTIONS_TOO_MANY_MESSAGE,
  AGREEMENT_SECTION_HEADING_MAX_LENGTH,
  AGREEMENT_HEADING_TOO_LONG_MESSAGE,
  AGREEMENT_TITLE_EMPTY_MESSAGE,
  AGREEMENT_TITLE_MAX_LENGTH,
  AGREEMENT_TITLE_TOO_LONG_MESSAGE,
  agreementActionFromEnabled,
  agreementProfileFieldErrors,
  containsMarkup,
  firstAgreementProfileErrorField,
  hasAgreementProfileError,
  isAgreementContentUnchanged,
  normalizeAgreementProfilePatch,
  sortAgreementsForAdmin,
  toAdminAgreementDetail,
  toAdminAgreementListItem,
} from "../lib/constants/adminAgreements.ts";
import {
  AGREEMENT_TYPE_LABELS,
  AGREEMENT_TYPES,
  compareAgreementVersion,
} from "../lib/constants/agreements.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { getAgreementRepository } from "../lib/data/agreementRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { agreementSeed } from "../lib/mocks/fixtures/agreementSeed.ts";
import {
  getAdminAgreementDetail,
  queryAdminAgreementList,
  resolveAdminAgreementListQuery,
  setAdminAgreementEnabled,
  updateAdminAgreement,
} from "../lib/services/adminAgreements.ts";

/**
 * P8E-1 协议管理的持续测试：**Public 永远只读，Admin 独占写权限**。
 *
 * 断言的是**真实实现**：`lib/services/adminAgreements.ts`、伪事务与真实的 Mock 仓储，
 * 不是复制一份逻辑再测一遍复制品。守的是四条规则：
 *
 * 1. **版本号只跟着正文走**：标题或正文真的变了才递增，只改启用状态不动版本，
 *    什么都没改则连 `updatedAt` 都不刷新、审计也不写。这条挡住「每次点保存都涨版本」；
 * 2. **审计记的是动作，不是内容**：快照里只有 `sectionCount` / `paragraphCount`，
 *    协议正文一个字符都不进去（否则审计表会以正文长度而不是操作次数增长）；
 * 3. **幂等靠服务端**：同一个键第二次到达返回第一次的结果，不写第二次数据与审计；
 *    键被用在另一条协议上则明确 400，而不是安静地重放；
 * 4. **正文是纯文本**：出现 `<` 或 `>` 一律拒绝。本阶段没有 sanitizer，
 *    因此是「不接受 HTML」而不是「接受之后清洗」。
 *
 * ⚠️ 服务层的写入口直接收 `adminId`，因此这里不需要起 HTTP 服务就能跑真实的写路径；
 * 「谁是操作者」由接口层的 `requireAdmin()` 决定，本文件用源码级断言守住那一段。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API_DIR = path.join(ROOT, "app", "api", "admin", "content", "agreements");

/** 执行操作的管理者。与 `MOCK_ADMIN_LOGIN_ID` 同一个取值域，但测试不依赖登录。 */
const ADMIN_ID = "admin-1";

/** 预置数据里的协议（见 `lib/mocks/fixtures/agreementSeed.ts`）。 */
const USER_CURRENT = "ag-user-110"; // user 的当前版本 1.1.0
const USER_OLDER = "ag-user-100"; // user 的较早版本 1.0.0
const PLATFORM_ENABLED = "ag-platform-200";
const PLATFORM_DISABLED = "ag-platform-100"; // 预置里唯一一条停用记录

let sequence = 0;

/** 每次调用都是一个**新的**幂等键：模拟「一次新的操作意图」。 */
function operationKey() {
  sequence += 1;
  return `op-agreement-${sequence}`;
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 本次请求的幂等键。测试里都显式生成，避免依赖调用顺序。 */
function keyed(body, key = operationKey()) {
  return { idempotencyKey: key, ...body };
}

function section(heading, ...paragraphs) {
  return { heading, paragraphs };
}

async function auditsOf(id) {
  return getAdminAuditRepository().listAudits({ targetType: "agreement", targetId: id });
}

async function recordOf(id) {
  return getAgreementRepository().findAgreementById(id);
}

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

beforeEach(() => {
  resetMockStore("agreement");
  resetMockStore("adminAudit");
});

// ——————————————————————————— 列表与详情 ———————————————————————————

test("列表：五项按页签顺序返回，行里不带正文", async () => {
  const data = await queryAdminAgreementList(
    resolveAdminAgreementListQuery(page()),
    undefined,
    "server",
  );

  // 后台看得见全部记录（含预置里的较早版本与停用记录），一条都不少
  assert.equal(data.items.length, agreementSeed.length);
  assert.ok(data.notice.length > 0, "列表要说明「改动会立即影响用户端」");

  // 类型齐全，且每一项的标签与服务端同源
  const types = [...new Set(data.items.map((item) => item.type))];
  assert.deepEqual(
    [...types].sort(),
    [...AGREEMENT_TYPES].sort(),
    "五个类型都要在列表里",
  );
  for (const item of data.items) {
    assert.equal(item.typeLabel, AGREEMENT_TYPE_LABELS[item.type]);
  }

  // 顺序即页签顺序：把每一项映射成它在 AGREEMENT_TYPES 里的下标，必须单调不减
  const ranks = data.items.map((item) => AGREEMENT_TYPES.indexOf(item.type));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "列表顺序必须与页签一致");
  assert.equal(ranks[0], 0);
  assert.equal(ranks[ranks.length - 1], AGREEMENT_TYPES.length - 1);

  // ⚠️ 列表行里**没有正文**：协议有几十段，列表一次带五条等于每次开后台传一遍全文
  for (const item of data.items) {
    assert.equal("sections" in item, false, "列表行不该带正文");
    assert.deepEqual(
      Object.keys(item).sort(),
      [
        "enabled",
        "id",
        "paragraphCount",
        "sectionCount",
        "title",
        "type",
        "typeLabel",
        "updatedAt",
        "version",
      ],
    );
    assert.ok(item.sectionCount > 0 && item.paragraphCount > 0);
  }
});

test("列表不筛掉停用记录：停用的那条必须能被重新启用", async () => {
  const data = await queryAdminAgreementList(
    resolveAdminAgreementListQuery(page()),
    undefined,
    "server",
  );

  const disabled = data.items.find((item) => item.id === PLATFORM_DISABLED);
  assert.ok(disabled, "停用的协议必须出现在后台列表里，否则它永远无法被重新启用");
  assert.equal(disabled.enabled, false);

  // 停用不是「删除」：正文与版本都还在
  assert.equal(disabled.version, "1.0.0");
  assert.ok(disabled.sectionCount > 0);
});

test("详情：带正文，且与仓储数据不共享引用", async () => {
  const detail = await getAdminAgreementDetail(USER_CURRENT, undefined, "server");
  assert.ok(detail);
  assert.equal(detail.id, USER_CURRENT);
  assert.equal(detail.type, "user");
  assert.ok(detail.sections.length > 0);
  assert.ok(detail.sections[0].paragraphs.length > 0);

  // 改 DTO 的段落不能影响仓储里的数据
  detail.sections[0].paragraphs.push("被改过的段落");
  const stored = await recordOf(USER_CURRENT);
  assert.equal(stored.sections[0].paragraphs.includes("被改过的段落"), false);

  // 找不到就是找不到，由接口层转 404
  assert.equal(await getAdminAgreementDetail("ag-not-exist", undefined, "server"), null);
});

test("?mockEmpty=agreements 返回空列表，而不是抛错", async () => {
  const previous = process.env.ENABLE_MOCK_DEBUG;
  process.env.ENABLE_MOCK_DEBUG = "true";
  try {
    const data = await queryAdminAgreementList(
      resolveAdminAgreementListQuery(page()),
      page({ mockEmpty: "agreements", mockDelay: "0" }),
      "server",
    );

    assert.deepEqual(data.items, []);
    assert.ok(data.notice.length > 0, "空列表时仍然要说明这份数据意味着什么");
  } finally {
    if (previous === undefined) delete process.env.ENABLE_MOCK_DEBUG;
    else process.env.ENABLE_MOCK_DEBUG = previous;
  }
});

// ——————————————————————————— 能改 / 改动后的结果 ———————————————————————————

test("能改标题：改完读回来真的变了，且只写一条审计", async () => {
  const before = await recordOf(USER_CURRENT);

  const result = await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({ title: "用户协议（试行版）", sections: before.sections, enabled: before.enabled }),
  );

  assert.equal(result.changed, true);
  assert.equal(result.agreementId, USER_CURRENT);

  const after = await recordOf(USER_CURRENT);
  assert.equal(after.title, "用户协议（试行版）");
  assert.equal(after.id, before.id);
  assert.equal(after.type, before.type, "类型是记录的身份，编辑改不动它");

  const audits = await auditsOf(USER_CURRENT);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "agreement.update");
  assert.equal(audits[0].before.title, before.title);
  assert.equal(audits[0].after.title, "用户协议（试行版）");
});

test("能改正文：段落真的被覆盖，且只改这一条记录", async () => {
  const other = await recordOf(PLATFORM_ENABLED);

  const result = await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({
      title: "用户协议",
      sections: [
        section("重要提示", "修改后的第一段。", "修改后的第二段。"),
        section("", "没有小标题的一节也是合法的。"),
      ],
      enabled: true,
    }),
  );

  assert.equal(result.changed, true);

  const after = await recordOf(USER_CURRENT);
  assert.equal(after.sections.length, 2);
  assert.equal(after.sections[0].heading, "重要提示");
  assert.deepEqual(after.sections[0].paragraphs, ["修改后的第一段。", "修改后的第二段。"]);
  assert.equal(after.sections[1].heading, "", "小标题为空串表示该节没有小标题");
  assert.deepEqual(after.sections[1].paragraphs, ["没有小标题的一节也是合法的。"]);

  // 别的协议一个字都没变
  assert.deepEqual(await recordOf(PLATFORM_ENABLED), other);
});

test("改正文后 version 递增（不是随便换一个值）", async () => {
  const before = await recordOf(USER_CURRENT);

  const result = await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({
      title: before.title,
      sections: [section("重要提示", "改过措辞的一段。")],
      enabled: before.enabled,
    }),
  );

  assert.equal(result.changed, true);
  assert.notEqual(result.version, before.version, "正文变了就必须换版本号");

  const after = await recordOf(USER_CURRENT);
  assert.equal(after.version, result.version);
  assert.ok(
    compareAgreementVersion(after.version, before.version) > 0,
    `版本号必须递增：${before.version} → ${after.version}`,
  );

  // 新版本仍然是「当前版本」：递增之后的版本号必须仍是同类里最高的
  assert.equal(compareAgreementVersion(after.version, (await recordOf(USER_OLDER)).version) > 0, true);
});

test("只改标题也递增 version", async () => {
  const before = await recordOf(USER_CURRENT);

  await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({ title: "用户协议 2026 版", sections: before.sections, enabled: before.enabled }),
  );

  const after = await recordOf(USER_CURRENT);
  assert.ok(
    compareAgreementVersion(after.version, before.version) > 0,
    "标题也是正文的一部分，改了就要递增版本",
  );
});

test("审计快照里没有正文，只有两个规模标量", async () => {
  const before = await recordOf(USER_CURRENT);

  await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({ title: before.title, sections: [section("重要提示", "换了一段话。")], enabled: true }),
  );

  const audits = await auditsOf(USER_CURRENT);
  assert.equal(audits.length, 1);

  for (const snapshot of [audits[0].before, audits[0].after]) {
    assert.equal("sections" in snapshot, false, "协议正文不该进审计快照");
    assert.equal(typeof snapshot.sectionCount, "number");
    assert.equal(typeof snapshot.paragraphCount, "number");
    assert.equal(snapshot.type, "user");
    // 快照的值只能是标量（数组 / 对象都进不来）
    for (const value of Object.values(snapshot)) {
      assert.equal(
        typeof value === "object" && value !== null,
        false,
        "快照里不该出现对象或数组",
      );
    }
  }

  assert.equal(audits[0].before.version, before.version);
  assert.notEqual(audits[0].after.version, before.version);
  assert.equal(audits[0].after.paragraphCount, 1);
});

test("内容与现状完全一致：changed:false，不动 version、不动 updatedAt、不写审计", async () => {
  const before = await recordOf(USER_CURRENT);

  const result = await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({ title: before.title, sections: before.sections, enabled: before.enabled }),
  );

  assert.equal(result.changed, false);
  assert.equal(result.version, before.version);

  const after = await recordOf(USER_CURRENT);
  assert.deepEqual(after, before, "什么都没改，记录必须原样不动（含 updatedAt）");
  assert.equal((await auditsOf(USER_CURRENT)).length, 0, "什么都没改就不该有审计");
});

test("只改 enabled（走 PATCH）：不动 version，审计动作是启停", async () => {
  const before = await recordOf(PLATFORM_ENABLED);

  const disabled = await updateAdminAgreement(
    ADMIN_ID,
    PLATFORM_ENABLED,
    keyed({ title: before.title, sections: before.sections, enabled: false }),
  );

  assert.equal(disabled.changed, true);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.version, before.version, "启用状态不是正文的版本");

  const after = await recordOf(PLATFORM_ENABLED);
  assert.equal(after.version, before.version);
  assert.equal(after.updatedAt, disabled.updatedAt, "真正写入时要刷新更新时间");
  assert.notEqual(after.updatedAt, before.updatedAt);

  const audits = await auditsOf(PLATFORM_ENABLED);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "agreement.disable");

  // 正文与标题一个字符都没动
  assert.deepEqual(after.sections, before.sections);
  assert.equal(after.title, before.title);
});

test("同时改正文与启用状态时，审计动作以启停为准", async () => {
  const before = await recordOf(PLATFORM_ENABLED);

  await updateAdminAgreement(
    ADMIN_ID,
    PLATFORM_ENABLED,
    keyed({ title: before.title, sections: [section("内容说明", "同时改了正文并停用。")], enabled: false }),
  );

  const audits = await auditsOf(PLATFORM_ENABLED);
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0].action,
    "agreement.disable",
    "两者同时变时记启停：它回答「这份协议为什么从用户端消失了」",
  );
  // 正文确实也变了
  assert.notEqual(audits[0].before.version, audits[0].after.version);
});

// ——————————————————————————— 启用 / 停用（窄写入）———————————————————————————

test("enable / disable 是窄写入：enabled 真的翻转，version 不动", async () => {
  const before = await recordOf(USER_CURRENT);
  assert.equal(before.enabled, true);

  const off = await setAdminAgreementEnabled(
    ADMIN_ID,
    USER_CURRENT,
    false,
    keyed({}, operationKey()),
  );
  assert.equal(off.changed, true);
  assert.equal(off.enabled, false);
  assert.equal(off.version, before.version);

  const midway = await recordOf(USER_CURRENT);
  assert.equal(midway.enabled, false);
  assert.equal(midway.version, before.version);
  assert.deepEqual(midway.sections, before.sections, "窄写入不碰正文");

  const back = await setAdminAgreementEnabled(
    ADMIN_ID,
    USER_CURRENT,
    true,
    keyed({}, operationKey()),
  );
  assert.equal(back.changed, true);
  assert.equal(back.enabled, true);
  assert.equal(back.version, before.version, "停用再启用不该凭空多出一个版本");

  const actions = (await auditsOf(USER_CURRENT)).map((entry) => entry.action);
  assert.deepEqual(actions, ["agreement.disable", "agreement.enable"]);
});

test("停用后重新启用能恢复：这是协议唯一的下架方式", async () => {
  // 预置里唯一一条停用记录：重新启用之后它必须真的回到启用状态
  const before = await recordOf(PLATFORM_DISABLED);
  assert.equal(before.enabled, false);

  const result = await setAdminAgreementEnabled(
    ADMIN_ID,
    PLATFORM_DISABLED,
    true,
    keyed({}, operationKey()),
  );

  assert.equal(result.changed, true);
  assert.equal(result.enabled, true);
  assert.equal((await recordOf(PLATFORM_DISABLED)).enabled, true);
  assert.equal((await recordOf(PLATFORM_DISABLED)).version, before.version);
});

test("重复 enable 是幂等的：不写数据、不写第二条审计、不刷新更新时间", async () => {
  const before = await recordOf(USER_CURRENT);

  const again = await setAdminAgreementEnabled(
    ADMIN_ID,
    USER_CURRENT,
    true,
    keyed({}, operationKey()),
  );

  assert.equal(again.changed, false);
  assert.equal((await auditsOf(USER_CURRENT)).length, 0);
  assert.deepEqual(await recordOf(USER_CURRENT), before);
});

// ——————————————————————————— 幂等 ———————————————————————————

test("幂等：同一个键第二次到达返回第一次的结果，不写第二条审计", async () => {
  const before = await recordOf(USER_CURRENT);
  const key = operationKey();
  const body = keyed(
    { title: "用户协议（幂等）", sections: [section("重要提示", "只该写进去一次。")], enabled: true },
    key,
  );

  const first = await updateAdminAgreement(ADMIN_ID, USER_CURRENT, body);
  assert.equal(first.changed, true);

  const second = await updateAdminAgreement(ADMIN_ID, USER_CURRENT, body);
  assert.equal(second.changed, false);
  assert.equal(second.version, first.version);
  assert.equal(second.updatedAt, first.updatedAt);

  assert.equal((await auditsOf(USER_CURRENT)).length, 1, "同一个键只该有一条审计");
  assert.equal((await recordOf(USER_CURRENT)).title, "用户协议（幂等）");
  assert.notEqual(before.title, "用户协议（幂等）");
});

test("幂等：同一个键在 enable 上第二次到达也不写第二条审计", async () => {
  const key = operationKey();

  const first = await setAdminAgreementEnabled(ADMIN_ID, USER_CURRENT, false, keyed({}, key));
  const second = await setAdminAgreementEnabled(ADMIN_ID, USER_CURRENT, false, keyed({}, key));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal((await auditsOf(USER_CURRENT)).length, 1);
});

test("幂等键冲突：同一个键用在另一条协议上 → 400", async () => {
  const key = operationKey();

  await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({ title: "用户协议", sections: [section("重要提示", "第一次操作。")], enabled: true }, key),
  );

  await assert.rejects(
    () =>
      updateAdminAgreement(
        ADMIN_ID,
        PLATFORM_ENABLED,
        keyed({ title: "平台协议", sections: [section("内容说明", "第二次操作。")], enabled: true }, key),
      ),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE);
      return true;
    },
  );

  // 冲突时**什么都不写**：目标记录保持原样，审计也只有第一条
  assert.equal((await auditsOf(PLATFORM_ENABLED)).length, 0);
});

test("幂等键只属于生成它的那个操作者", async () => {
  const key = operationKey();

  await setAdminAgreementEnabled(ADMIN_ID, USER_CURRENT, false, keyed({}, key));

  // 换一个管理员带同一个键：不能把「别人做过的事」当成自己的重放
  await assert.rejects(
    () => setAdminAgreementEnabled("admin-2", USER_CURRENT, false, keyed({}, key)),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.message, ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE);
      return true;
    },
  );
});

// ——————————————————————————— 未找到与缺参 ———————————————————————————

test("未找到：不存在的 id → 404", async () => {
  for (const call of [
    () => updateAdminAgreement(ADMIN_ID, "ag-not-exist", keyed({ title: "x", sections: [section("", "y")], enabled: true })),
    () => setAdminAgreementEnabled(ADMIN_ID, "ag-not-exist", true, keyed({})),
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.status, 404);
      assert.equal(error.message, ADMIN_AGREEMENT_NOT_FOUND_MESSAGE);
      return true;
    });
  }
});

test("缺少或非法幂等键 → 400，且什么都不写", async () => {
  const before = await recordOf(USER_CURRENT);

  for (const body of [
    { title: "用户协议", sections: [section("重要提示", "无键。")], enabled: true },
    { idempotencyKey: "短", title: "用户协议", sections: [section("重要提示", "非法键。")], enabled: true },
    { idempotencyKey: 12345, title: "用户协议", sections: [section("重要提示", "非字符串键。")], enabled: true },
  ]) {
    await assert.rejects(
      () => updateAdminAgreement(ADMIN_ID, USER_CURRENT, body),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, ADMIN_AGREEMENT_MISSING_IDEMPOTENCY_KEY_MESSAGE);
        return true;
      },
    );
  }

  assert.deepEqual(await recordOf(USER_CURRENT), before);
  assert.equal((await auditsOf(USER_CURRENT)).length, 0);
});

// ——————————————————————————— 纯文本校验 ———————————————————————————

test("拒绝 HTML：段落里出现 < 或 > 一律 400，且说明请填写纯文本", async () => {
  const before = await recordOf(USER_CURRENT);

  const illegal = [
    "<p>这是一段 HTML</p>",
    "第一行<br>第二行",
    "<strong>加粗</strong>",
    "1 < 2 是数学写法，但正文里也不接受",
    "尖括号 > 也是",
  ];

  for (const paragraph of illegal) {
    await assert.rejects(
      () =>
        updateAdminAgreement(
          ADMIN_ID,
          USER_CURRENT,
          keyed({ title: "用户协议", sections: [section("重要提示", paragraph)], enabled: true }),
        ),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE);
        assert.ok(error.message.includes("纯文本"), "文案要让填写的人知道该删掉标签");
        return true;
      },
    );
  }

  // 小标题用同一把尺：标题能写 HTML 而段落不能，只会让人以为正文支持富文本
  await assert.rejects(
    () =>
      updateAdminAgreement(
        ADMIN_ID,
        USER_CURRENT,
        keyed({
          title: "用户协议",
          sections: [section("<h2>重要提示</h2>", "看起来很正常的一段。")],
          enabled: true,
        }),
      ),
    (error) => {
      assert.equal(error.message, AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE);
      return true;
    },
  );

  // 被拒绝的请求一次都没有落盘
  assert.deepEqual(await recordOf(USER_CURRENT), before);
  assert.equal((await auditsOf(USER_CURRENT)).length, 0);
});

test("正文的结构约束：空段落、空标题、空正文、超限都被拒绝", async () => {
  const cases = [
    {
      patch: { title: "用户协议", sections: [section("重要提示", "一段。", "")], enabled: true },
      message: AGREEMENT_PARAGRAPH_EMPTY_MESSAGE,
    },
    {
      patch: { title: "用户协议", sections: [section("重要提示", "   ")], enabled: true },
      message: AGREEMENT_PARAGRAPH_EMPTY_MESSAGE,
    },
    {
      patch: { title: "用户协议", sections: [section("重要提示")], enabled: true },
      message: AGREEMENT_PARAGRAPHS_EMPTY_MESSAGE,
    },
    { patch: { title: "用户协议", sections: [], enabled: true }, message: AGREEMENT_SECTIONS_EMPTY_MESSAGE },
    { patch: { title: "   ", sections: [section("重要提示", "一段。")], enabled: true }, message: AGREEMENT_TITLE_EMPTY_MESSAGE },
    {
      patch: {
        title: "用".repeat(AGREEMENT_TITLE_MAX_LENGTH + 1),
        sections: [section("重要提示", "一段。")],
        enabled: true,
      },
      message: AGREEMENT_TITLE_TOO_LONG_MESSAGE,
    },
    {
      patch: {
        title: "用户协议",
        sections: [section("标".repeat(AGREEMENT_SECTION_HEADING_MAX_LENGTH + 1), "一段。")],
        enabled: true,
      },
      message: AGREEMENT_HEADING_TOO_LONG_MESSAGE,
    },
    {
      patch: {
        title: "用户协议",
        sections: Array.from({ length: AGREEMENT_SECTION_MAX_COUNT + 1 }, () => section("", "一段。")),
        enabled: true,
      },
      message: AGREEMENT_SECTIONS_TOO_MANY_MESSAGE,
    },
    {
      patch: {
        title: "用户协议",
        sections: [section("重要提示", "字".repeat(AGREEMENT_PARAGRAPH_MAX_LENGTH + 1))],
        enabled: true,
      },
      message: AGREEMENT_PARAGRAPH_TOO_LONG_MESSAGE,
    },
  ];

  for (const item of cases) {
    await assert.rejects(
      () => updateAdminAgreement(ADMIN_ID, USER_CURRENT, keyed(item.patch)),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.message, item.message, JSON.stringify(item.patch).slice(0, 80));
        return true;
      },
    );
  }

  assert.equal((await auditsOf(USER_CURRENT)).length, 0);
});

test("纯函数：字段级错误、收窄与写入看到的是同一个字符串", () => {
  assert.equal(containsMarkup("<br>"), true);
  assert.equal(containsMarkup("a > b"), true);
  assert.equal(containsMarkup("《用户协议》"), false, "中文书名号不是尖括号");

  const errors = agreementProfileFieldErrors({
    title: "",
    sections: [section("标题", "<p>正文</p>")],
    enabled: true,
  });
  assert.ok(hasAgreementProfileError(errors));
  assert.equal(errors.title, AGREEMENT_TITLE_EMPTY_MESSAGE);
  assert.equal(errors.sections, AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE);
  assert.equal(errors.enabled, null, "勾选框没有「填错」这种状态");
  assert.equal(firstAgreementProfileErrorField(errors), "title");

  // 合法输入：normalize 返回的是 trim 之后的值，校验与写入看到的是同一个串
  const patch = normalizeAgreementProfilePatch({
    title: "  用户协议  ",
    sections: [section("  重要提示  ", "  第一段。  ")],
    enabled: false,
  });
  assert.deepEqual(patch, {
    title: "用户协议",
    sections: [{ heading: "重要提示", paragraphs: ["第一段。"] }],
    enabled: false,
  });

  // 非法输入一律返回 null，而不是「尽量修一修」
  assert.equal(
    normalizeAgreementProfilePatch({ title: "用户协议", sections: [section("", " ")], enabled: true }),
    null,
  );

  // 小标题允许为空串；段落不允许
  assert.ok(
    normalizeAgreementProfilePatch({ title: "用户协议", sections: [section("", "正文。")], enabled: true }),
  );
});

test("纯函数：内容是否变过 / 动作判定", () => {
  const previous = { title: "用户协议", sections: [section("重要提示", "第一段。")] };

  assert.equal(
    isAgreementContentUnchanged(previous, { title: "用户协议", sections: [section("重要提示", "第一段。")] }),
    true,
  );
  assert.equal(
    isAgreementContentUnchanged(previous, { title: "用户协议", sections: [section("重要提示", "第二段。")] }),
    false,
  );
  assert.equal(
    isAgreementContentUnchanged(previous, { title: "用户协议", sections: [section("重要提示", "第一段。", "多一段。")] }),
    false,
  );
  assert.equal(
    isAgreementContentUnchanged(previous, { title: "用户协议（新）", sections: previous.sections }),
    false,
  );
  assert.equal(
    isAgreementContentUnchanged(previous, { title: previous.title, sections: [] }),
    false,
    "节数不同也算变过",
  );

  assert.equal(agreementActionFromEnabled(true, true), "agreement.update");
  assert.equal(agreementActionFromEnabled(false, true), "agreement.enable");
  assert.equal(agreementActionFromEnabled(true, false), "agreement.disable");
});

test("纯函数：列表排序不受仓储返回顺序影响", () => {
  const records = [
    { id: "b", type: "platform", version: "1.0.0" },
    { id: "a", type: "user", version: "1.0.0" },
    { id: "c", type: "version", version: "2.0.0" },
    { id: "a2", type: "user", version: "1.2.0" },
  ];
  const sorted = sortAgreementsForAdmin(records, AGREEMENT_TYPES);

  assert.deepEqual(
    sorted.map((record) => record.id),
    ["a2", "a", "b", "c"],
    "按页签顺序，同类型高版本在前",
  );
  // 不改动入参
  assert.equal(records[0].id, "b");
});

// ——————————————————————————— DTO 转换 ———————————————————————————

test("DTO：列表行不带正文，详情带正文且是副本", () => {
  const record = agreementSeed.find((item) => item.id === USER_CURRENT);

  const item = toAdminAgreementListItem(record);
  assert.equal("sections" in item, false);
  assert.equal(item.paragraphCount, record.sections.reduce((total, s) => total + s.paragraphs.length, 0));

  const detail = toAdminAgreementDetail(record);
  assert.equal(detail.typeLabel, AGREEMENT_TYPE_LABELS[record.type]);
  assert.notEqual(detail.sections, record.sections);
  detail.sections[0].paragraphs.push("注入的段落");
  assert.equal(record.sections[0].paragraphs.includes("注入的段落"), false);
});

// ——————————————————————————— 权限 ———————————————————————————

test("写接口只在 app/api/admin 下，且每个 handler 都自己调用 requireAdmin()", () => {
  const routes = collectRouteFiles(ADMIN_API_DIR);
  assert.ok(routes.length >= 4, `协议管理至少应有 4 个 route 文件，实际 ${routes.length}`);

  for (const file of routes) {
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    const code = stripComments(readFileSync(file, "utf8"));
    assert.ok(
      code.includes("await requireAdmin()"),
      `${relative} 没有调用 requireAdmin()：页面隐藏按钮挡不住直接请求接口`,
    );
  }

  // 三个写入口都在，且都是 POST / PATCH 而不是 GET
  const byPath = Object.fromEntries(
    routes.map((file) => [path.relative(ADMIN_API_DIR, file).replace(/\\/g, "/"), file]),
  );
  assert.deepEqual(
    Object.keys(byPath).sort(),
    ["[id]/disable/route.ts", "[id]/enable/route.ts", "[id]/route.ts", "route.ts"],
  );

  const patchCode = stripComments(readFileSync(byPath["[id]/route.ts"], "utf8"));
  assert.ok(patchCode.includes("export async function PATCH"));
  for (const file of ["[id]/enable/route.ts", "[id]/disable/route.ts"]) {
    const code = stripComments(readFileSync(byPath[file], "utf8"));
    assert.ok(code.includes("export async function POST"), `${file} 应当是 POST`);
    assert.equal(code.includes("export async function GET"), false, `${file} 不该有 GET`);
  }

  // 列表接口只有 GET：协议不能新增，所以没有 POST
  const listCode = stripComments(readFileSync(byPath["route.ts"], "utf8"));
  assert.ok(listCode.includes("export async function GET"));
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      new RegExp(`export (async )?function ${method}\\b`).test(listCode),
      false,
      `协议列表不该出现 ${method}：协议不能新增，也不能删除`,
    );
  }
});

test("审计的操作者只来自服务层的会话，请求体里的 actor 字段被忽略", async () => {
  await updateAdminAgreement(
    ADMIN_ID,
    USER_CURRENT,
    keyed({
      title: "用户协议",
      sections: [section("重要提示", "试图冒充别人的一次写入。")],
      enabled: true,
      // 这些字段在服务层**没有读取的位置**
      actorId: "admin-999",
      actorRole: "customer_service",
      actorName: "冒充者",
    }),
  );

  const audits = await auditsOf(USER_CURRENT);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].actorName, null, "管理端的名称快照本阶段恒为 null");
  assert.notEqual(audits[0].actorId, "admin-999");
});

test("服务层不自己判角色：权限判断只有 requireAdmin() 一处", () => {
  const code = stripComments(
    readFileSync(path.join(ROOT, "lib", "services", "adminAgreements.ts"), "utf8"),
  );

  assert.equal(
    /role\s*===\s*["']admin["']/.test(code),
    false,
    "服务层不该自己判断角色，应当由接口层的 requireAdmin() 决定",
  );
  assert.equal(code.includes("getSessionUser"), false, "管理端服务不该读用户端会话");
  assert.equal(code.includes("requireUser"), false);
});
