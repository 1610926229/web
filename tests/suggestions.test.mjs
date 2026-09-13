import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  SUGGESTION_CONTACT_MAX_LENGTH,
  SUGGESTION_CONTENT_MAX_LENGTH,
  SUGGESTION_EVIDENCE_MAX_COUNT,
  SUGGESTION_MOCK_NOTICE,
  SUGGESTION_PAGE_SIZE,
  SUGGESTION_STATUS_LABELS,
  SUGGESTION_SUBMIT_NOTE,
  SUGGESTION_TYPES,
  SUGGESTION_TYPE_REQUIRED_MESSAGE,
  mergeSuggestionPage,
  parseSuggestionListQuery,
  suggestionFieldErrors,
} from "../lib/constants/suggestions.ts";
import { getSuggestionRepository } from "../lib/data/suggestionRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { suggestionSeed } from "../lib/mocks/fixtures/suggestionSeed.ts";
import {
  createSuggestionForUser,
  parseSuggestionInput,
  querySuggestionsForUser,
} from "../lib/services/suggestions.ts";

/**
 * 意见反馈的持续测试。
 *
 * 跑的是**真实实现**：真实的内存仓储 + 真实的 `lib/services/suggestions.ts`，
 * 因此「只看得到自己的反馈」「空白与超长被拒」「重复提交只写一条」
 * 这些规则每次提交都会被重新验证，而不是一次性脚本。
 *
 * 其中三条是本阶段的**边界**，必须由测试守住：
 * 1. 状态与回复由平台侧决定 —— 客户端塞 `status` / `reply` / `repliedAt` 一律无效；
 * 2. 平台回复只能来自预置数据 —— 用户新提交的反馈回复一定为空；
 * 3. 不承诺任何回报 —— 文案里不出现奖励 / 补偿 / 返现这类结论。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function list(userId, params = {}) {
  return querySuggestionsForUser(userId, page(params), "server");
}

function uniqueKey() {
  return `key-${crypto.randomUUID().slice(0, 18)}`;
}

/** 提交一条反馈；幂等键默认自动生成，调用方可以显式覆盖（例如测缺键）。 */
function submit(userId, overrides = {}) {
  return createSuggestionForUser(
    userId,
    {
      typeKey: "feature",
      content: "希望订单列表能按打手筛选。（测试文案）",
      contact: "",
      evidence: [],
      idempotencyKey: uniqueKey(),
      ...overrides,
    },
    undefined,
    "server",
    new Date("2026-09-13T12:00:00.000Z"),
  );
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("suggestion");
});

test("反馈列表只包含当前用户的记录，且按提交时间倒序", async () => {
  const result = await list(USER_A);

  assert.equal(result.total, 3);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["sug-seed-1001-02", "sug-seed-1001-01", "sug-seed-1001-03"],
  );
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].createdAt >= result.items[index].createdAt);
  }

  // B 一条反馈都没有：空态不需要额外的调试开关就能看到（原型就是空态）
  const other = await list(USER_B);
  assert.equal(other.total, 0);
  assert.deepEqual(other.items, []);
});

test("列表卡片拿到完整正文与平台回复：本阶段没有详情页，列表是唯一落点", async () => {
  const result = await list(USER_A);
  const byId = new Map(result.items.map((item) => [item.id, item]));

  const replied = byId.get("sug-seed-1001-01");
  assert.equal(replied.status, "replied");
  assert.equal(replied.statusLabel, "已回复");
  assert.ok(replied.reply.length > 0);
  assert.ok(replied.repliedAt);
  // 正文完整，没有被截断成摘要
  assert.equal(replied.content, suggestionSeed.find((s) => s.id === "sug-seed-1001-01").content);
  assert.ok(replied.content.length > 40);

  // 已提交但还没回复：回复为空、回复时间为 null，卡片按状态给出说明
  const submitted = byId.get("sug-seed-1001-02");
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.reply, "");
  assert.equal(submitted.repliedAt, null);

  // 联系方式是选填：没填就是空串，不留 undefined
  assert.equal(submitted.contact, "");
  assert.equal(byId.get("sug-seed-1001-03").contact, "见账号绑定手机");

  // 凭证是选填：没上传就是空数组
  assert.deepEqual(submitted.evidence, []);
  assert.equal(byId.get("sug-seed-1001-01").evidence[0].kind, "image");
});

test("DTO 只有列表需要的字段：没有 userId，也没有平台侧内部字段", async () => {
  const result = await list(USER_A);

  assert.equal("userId" in result.items[0], false);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    "contact",
    "content",
    "createdAt",
    "evidence",
    "id",
    "repliedAt",
    "reply",
    "status",
    "statusLabel",
    "typeKey",
    "typeLabel",
  ]);

  // 分页结果的形状固定：hasMore 由服务端算好
  assert.deepEqual(Object.keys(result).sort(), [
    "hasMore",
    "items",
    "page",
    "pageSize",
    "total",
  ]);
});

test("分页稳定不重复，加载更多是合并不是替换", async () => {
  const first = await list(USER_A, { page: 1, pageSize: 2 });
  const second = await list(USER_A, { page: 2, pageSize: 2 });

  assert.deepEqual(
    first.items.map((item) => item.id),
    ["sug-seed-1001-02", "sug-seed-1001-01"],
  );
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.items.map((item) => item.id), ["sug-seed-1001-03"]);

  const seen = new Set();
  for (const item of [...first.items, ...second.items]) {
    assert.equal(seen.has(item.id), false, `${item.id} 在分页里重复出现`);
    seen.add(item.id);
  }
  assert.equal(seen.size, 3);

  // 重复取同一页再合并：去重后条数不变（「加载更多」连点两次的兜底）
  const merged = mergeSuggestionPage(first, first);
  assert.equal(merged.items.length, first.items.length);
  assert.equal(merged.hasMore, first.hasMore);
});

test("分页参数非法走规范化，不让整页报错", async () => {
  assert.deepEqual(parseSuggestionListQuery(page()), { page: 1, pageSize: SUGGESTION_PAGE_SIZE });
  assert.equal(parseSuggestionListQuery(page({ page: "abc" })).page, 1);
  assert.equal(parseSuggestionListQuery(page({ page: 0 })).page, 1);
  assert.equal(parseSuggestionListQuery(page({ pageSize: 999 })).pageSize, 20);

  const result = await list(USER_A, { page: "abc", pageSize: "999" });
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 20);
  assert.equal(result.total, 3);
});

test("提交后立刻能在列表里读到，并且是排在最前面的那条", async () => {
  const created = await submit(USER_A, { content: "刚提交的建议（测试文案）" });
  assert.equal(created.created, true);
  assert.ok(created.suggestionId.startsWith("sug_"));

  const result = await list(USER_A);
  assert.equal(result.total, 4);
  assert.equal(result.items[0].id, created.suggestionId);
  assert.equal(result.items[0].content, "刚提交的建议（测试文案）");
  // 新提交的状态由服务端写死为「已提交」，回复为空
  assert.equal(result.items[0].status, "submitted");
  assert.equal(result.items[0].statusLabel, "已提交");
  assert.equal(result.items[0].reply, "");
  assert.equal(result.items[0].repliedAt, null);
  // 提交时间由服务端写（测试里钉死的时刻）
  assert.equal(result.items[0].createdAt, "2026-09-13T12:00:00.000Z");

  // 别人看不到这条
  assert.equal((await list(USER_B)).total, 0);
});

test("内容空白与超长都被拒绝，边界值通过", async () => {
  await expectApiError(submit(USER_A, { content: "" }), "BAD_REQUEST", "请填写反馈内容");
  await expectApiError(submit(USER_A, { content: "   \n  " }), "BAD_REQUEST", "请填写反馈内容");
  await expectApiError(
    submit(USER_A, { content: "字".repeat(SUGGESTION_CONTENT_MAX_LENGTH + 1) }),
    "BAD_REQUEST",
    `反馈内容不能超过 ${SUGGESTION_CONTENT_MAX_LENGTH} 个字符`,
  );

  // 正好卡在上限：通过。超限判定按字符数（一个汉字算 1 个）
  const boundary = await submit(USER_A, { content: "字".repeat(SUGGESTION_CONTENT_MAX_LENGTH) });
  assert.equal(boundary.created, true);

  // Emoji 计 1 个字符：上限个 Emoji 不该被判超长
  const emoji = await submit(USER_A, { content: "😀".repeat(SUGGESTION_CONTENT_MAX_LENGTH) });
  assert.equal(emoji.created, true);

  // 首尾空格会被去掉后再判空与长度
  const trimmed = await submit(USER_A, { content: "  有空格的正文（测试文案）  " });
  const stored = (await list(USER_A)).items.find((item) => item.id === trimmed.suggestionId);
  assert.equal(stored.content, "有空格的正文（测试文案）");
});

test("类型必选且必须是中央那几种，联系方式选填但有长度上限", async () => {
  await expectApiError(
    submit(USER_A, { typeKey: "" }),
    "BAD_REQUEST",
    SUGGESTION_TYPE_REQUIRED_MESSAGE,
  );
  await expectApiError(
    submit(USER_A, { typeKey: "not-a-type" }),
    "BAD_REQUEST",
    SUGGESTION_TYPE_REQUIRED_MESSAGE,
  );

  // 四种类型都能提交，类型文案由服务端写
  for (const type of SUGGESTION_TYPES) {
    const created = await submit(USER_A, { typeKey: type.key });
    const item = (await list(USER_A)).items.find((entry) => entry.id === created.suggestionId);
    assert.equal(item.typeKey, type.key);
    assert.equal(item.typeLabel, type.label);
  }

  // 联系方式选填：不填是空串，填了按字符数校验
  const withContact = await submit(USER_A, { contact: "  微信：youmu-test  " });
  const item = (await list(USER_A)).items.find((entry) => entry.id === withContact.suggestionId);
  assert.equal(item.contact, "微信：youmu-test");

  await expectApiError(
    submit(USER_A, { contact: "字".repeat(SUGGESTION_CONTACT_MAX_LENGTH + 1) }),
    "BAD_REQUEST",
    `联系方式不能超过 ${SUGGESTION_CONTACT_MAX_LENGTH} 个字符`,
  );
});

test("凭证只收图片、最多 4 张，id 与地址由服务端生成", async () => {
  const created = await submit(USER_A, {
    evidence: [{ kind: "image", name: "screen.png" }],
  });
  const item = (await list(USER_A)).items.find((entry) => entry.id === created.suggestionId);
  assert.equal(item.evidence.length, 1);
  assert.ok(item.evidence[0].id.startsWith("ev_"));
  assert.equal(item.evidence[0].url, "/mock/evidence-placeholder.svg");
  // 客户端只给了类型与文件名，地址不是它说了算
  assert.equal(item.evidence[0].name, "screen.png");

  await expectApiError(
    submit(USER_A, { evidence: [{ kind: "video", name: "clip.mp4" }] }),
    "BAD_REQUEST",
    "凭证只支持图片",
  );
  await expectApiError(
    submit(USER_A, {
      evidence: Array.from({ length: SUGGESTION_EVIDENCE_MAX_COUNT + 1 }, (_, index) => ({
        kind: "image",
        name: `shot-${index}.png`,
      })),
    }),
    "BAD_REQUEST",
    `最多上传 ${SUGGESTION_EVIDENCE_MAX_COUNT} 个凭证`,
  );
});

test("重复提交只写一条：幂等键命中返回第一次的结果", async () => {
  const key = uniqueKey();
  const first = await submit(USER_A, { idempotencyKey: key, content: "第一次（测试文案）" });
  assert.equal(first.created, true);

  const second = await submit(USER_A, { idempotencyKey: key, content: "第二次换了个内容" });
  assert.equal(second.created, false);
  assert.equal(second.suggestionId, first.suggestionId);

  // 内容被改了也仍然返回第一次的结果：同一个键就是同一次提交意图
  const result = await list(USER_A);
  assert.equal(result.total, 4);
  assert.equal(
    result.items.find((item) => item.id === first.suggestionId).content,
    "第一次（测试文案）",
  );
});

test("并发提交同一个幂等键只产生一条记录", async () => {
  const key = uniqueKey();
  const results = await Promise.all(Array.from({ length: 8 }, () => submit(USER_A, { idempotencyKey: key })));

  const ids = new Set(results.map((result) => result.suggestionId));
  assert.equal(ids.size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await list(USER_A)).total, 4);
});

test("幂等键缺失或格式非法一律拒绝，宁可不做", async () => {
  await expectApiError(
    submit(USER_A, { idempotencyKey: "" }),
    "BAD_REQUEST",
    "缺少或非法的幂等键",
  );
  await expectApiError(
    submit(USER_A, { idempotencyKey: "短" }),
    "BAD_REQUEST",
    "缺少或非法的幂等键",
  );
  assert.equal((await list(USER_A)).total, 3);
});

test("身份、状态、回复与时间都由服务端说了算：塞进请求体也无效", async () => {
  const created = await submit(USER_A, {
    userId: USER_B,
    status: "replied",
    reply: "平台已经答应补偿（伪造）",
    repliedAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
    id: "sug_forged",
    typeLabel: "伪造的类型",
  });

  // 伪造的 id 不会被采用
  assert.notEqual(created.suggestionId, "sug_forged");

  // 记在了提交者名下，而不是请求体里那个 userId
  const mine = (await list(USER_A)).items.find((item) => item.id === created.suggestionId);
  assert.ok(mine);
  assert.equal((await list(USER_B)).total, 0);

  assert.equal(mine.status, "submitted");
  assert.equal(mine.statusLabel, "已提交");
  assert.equal(mine.reply, "");
  assert.equal(mine.repliedAt, null);
  assert.equal(mine.createdAt, "2026-09-13T12:00:00.000Z");
  assert.equal(mine.typeLabel, "功能建议");

  // 白名单解析器本身也只认这四个字段
  assert.deepEqual(Object.keys(parseSuggestionInput({ typeKey: "other", content: "内容（测试）" })).sort(), [
    "contact",
    "content",
    "evidence",
    "typeKey",
  ]);
});

test("平台回复只可能来自预置数据：用户端写不出回复，也改不了状态", async () => {
  // 用户新提交的反馈没有回复
  const created = await submit(USER_A);

  const item = (await list(USER_A)).items.find((entry) => entry.id === created.suggestionId);
  assert.equal(item.reply, "");
  assert.equal(item.repliedAt, null);
  assert.equal(item.status, "submitted");

  // 有回复的**只可能是种子里那几条**（将来是后台写入的），且回复时间不早于提交时间
  const replied = (await list(USER_A)).items.filter((entry) => entry.reply);
  assert.ok(replied.length > 0);
  for (const entry of replied) {
    const seed = suggestionSeed.find((item) => item.id === entry.id);
    assert.ok(seed, `列表里出现了非种子的回复：${entry.id}`);
    // 状态与回复都原样来自种子，服务端没有另外加工出一套口径
    assert.equal(entry.status, seed.status);
    assert.equal(entry.reply, seed.reply);
    assert.ok(entry.repliedAt);
    assert.ok(Date.parse(entry.repliedAt) >= Date.parse(entry.createdAt));
  }
});

test("仓储只暴露读取与创建：没有「改状态 / 写回复」的方法", async () => {
  const repository = getSuggestionRepository();
  assert.deepEqual(Object.keys(repository).sort(), [
    "createSuggestion",
    "findSuggestionByKey",
    "querySuggestions",
  ]);
  for (const name of Object.keys(repository)) {
    assert.equal(
      /update|set|reply|close|resolve|patch|delete|remove/i.test(name),
      false,
      `仓储不该有改状态的写方法：${name}`,
    );
  }
});

test("文案不承诺任何回报，也不含未确认的规则", () => {
  for (const text of [SUGGESTION_SUBMIT_NOTE, SUGGESTION_MOCK_NOTICE]) {
    // 文案**可以提到**奖励 / 补偿，但只能是「不给」的说法：
    // 出现这些词的那一句里必须带否定词（「不会因为提交建议自动获得奖励或补偿」）。
    for (const word of ["奖励", "补偿", "返现", "返利", "红包"]) {
      if (!text.includes(word)) continue;
      const sentence = text.split(/[。；;]/).find((part) => part.includes(word)) ?? text;
      assert.ok(
        /不|无|没有/.test(sentence),
        `提到「${word}」时必须是「不给」的说法：${sentence}`,
      );
    }

    // 明确的承诺句式一个都不许出现
    for (const pattern of [/将获得/, /即可获得/, /可以获得/, /赠送/, /返现给/, /返还/]) {
      assert.equal(pattern.test(text), false, `文案不该出现承诺句式 ${pattern}：${text}`);
    }
  }
  // Mock 标注必须写明数据来源与「不影响订单金额」
  assert.ok(SUGGESTION_MOCK_NOTICE.includes("Mock"));
  assert.ok(SUGGESTION_MOCK_NOTICE.includes("不影响订单金额"));

  // 三个状态各有文案，且顺序与列表一致
  assert.deepEqual(SUGGESTION_STATUS_LABELS, {
    submitted: "已提交",
    replied: "已回复",
    closed: "已关闭",
  });
});

test("种子数据的自洽性与覆盖度", () => {
  const statuses = new Set(suggestionSeed.map((item) => item.status));
  assert.deepEqual([...statuses].sort(), ["closed", "replied", "submitted"]);
  // 至少有一条没有凭证、一条没有联系方式，保证空态版式被覆盖
  assert.ok(suggestionSeed.some((item) => item.evidence.length === 0));
  assert.ok(suggestionSeed.some((item) => !item.contact));

  for (const item of suggestionSeed) {
    assert.ok(item.content.trim().length > 0);
    // 有回复就必须有回复时间，且不早于提交时间
    if (item.reply) {
      assert.ok(item.repliedAt, `${item.id} 有回复但没有回复时间`);
      assert.ok(Date.parse(item.repliedAt) >= Date.parse(item.createdAt));
    } else {
      assert.equal(item.repliedAt, null, `${item.id} 没有回复却有回复时间`);
    }
  }
});

test("表单错误提示从输入推导：超限实时可见，空内容只在点过提交后提示", () => {
  // 还没点提交：空内容不报错，超限照样报
  assert.deepEqual(suggestionFieldErrors({ content: "", contact: "", attempted: false }), {
    content: null,
    contact: null,
  });
  assert.equal(
    suggestionFieldErrors({
      content: "字".repeat(SUGGESTION_CONTENT_MAX_LENGTH + 1),
      contact: "",
      attempted: false,
    }).content,
    `反馈内容不能超过 ${SUGGESTION_CONTENT_MAX_LENGTH} 个字符`,
  );

  // 点过提交之后：空内容才提示
  assert.equal(
    suggestionFieldErrors({ content: "   ", contact: "", attempted: true }).content,
    "请填写反馈内容",
  );
  assert.equal(
    suggestionFieldErrors({
      content: "正常内容",
      contact: "字".repeat(SUGGESTION_CONTACT_MAX_LENGTH + 1),
      attempted: true,
    }).contact,
    `联系方式不能超过 ${SUGGESTION_CONTACT_MAX_LENGTH} 个字符`,
  );
});
