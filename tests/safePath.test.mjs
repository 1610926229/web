import assert from "node:assert/strict";
import test from "node:test";
import {
  SAFE_PATH_INVALID_MESSAGE,
  SAFE_PATH_MAX_LENGTH,
  SAFE_PATH_MUST_BE_INTERNAL_MESSAGE,
  SAFE_PATH_REQUIRED_MESSAGE,
  SAFE_PATH_TOO_LONG_MESSAGE,
  isSafePath,
  validateSafePath,
} from "../lib/constants/safePath.ts";

/**
 * P8E-1：**站内路径安全规则的独立测试**。
 *
 * 这个文件存在的理由只有一条：`validateSafePath()` 是全站**唯一**的站内地址安全判定
 * （后台填的快捷入口地址、公告与活动图的图片地址都走它），而它守的是一条**安全属性**
 * ——「用户端 `<Link href>` 里不出现 `javascript:`，也不出现站外地址」。
 * 安全属性不能只靠某个调用点的测试顺带覆盖：后台表单改了、服务层重构了，
 * 这条规则本身仍然必须是钉死的，因此它有自己的测试文件。
 *
 * 覆盖四件事：
 * 1. **通过的形状**（站内绝对路径、带查询串 / 锚点 / 中文、边界长度）；
 * 2. **每一条被拒的形状**（脚本协议、协议相对地址、反斜杠、控制字符、
 *    零宽 / 格式化字符、空白、无前导斜杠、超长）；
 * 3. **`startsWith("/")` 单独不够**——这是冻结契约里点名的场景，因此有独立用例；
 * 4. **返回值与传入值逐字符相同**、**纯函数**、以及 `isSafePath()` 与
 *    `validateSafePath().ok` 结论一致。
 *
 * ⚠️ 「返回值与传入值逐字符相同」是 P8E-1 集成阶段改掉的一条规则：早先的实现
 * 先 `trim()` 再校验，于是 `/join\t` 会通过并入库成 `/join`。如今首尾的空白与控制字符
 * **一律被拒**，两处用例相应升级（只增不减，见文件内说明）。
 */

/** 全部合法拒绝文案。用例只断言「命中其中之一」，不把某条样例绑死到某句话上。 */
const REJECT_MESSAGES = [
  SAFE_PATH_REQUIRED_MESSAGE,
  SAFE_PATH_MUST_BE_INTERNAL_MESSAGE,
  SAFE_PATH_INVALID_MESSAGE,
  SAFE_PATH_TOO_LONG_MESSAGE,
];

/**
 * 必须**通过**的样例。
 *
 * 最后一条刻意取到长度上限：边界值本身合法（校验用的是「大于上限才拒」），
 * 而边界值恰恰是最容易在重构里被写成 `>=` 的地方。
 */
const ACCEPTED = [
  ["最普通的站内路径", "/join"],
  ["另一个真实路由", "/service"],
  ["带查询串与中文（预置入口就是这个形状）", "/placeholder?title=点单权益"],
  ["投诉专区", "/complaints"],
  ["带锚点", "/join#top"],
  ["纯中文路径段", "/分类/排位护航"],
  ["正好等于长度上限", `/${"a".repeat(SAFE_PATH_MAX_LENGTH - 1)}`],
];

/**
 * 必须**被拒**的样例。
 *
 * 每一条对应一类真实填错：从别处复制的整条外链、少写一个斜杠的相对写法、
 * 复制粘贴时带进来的换行、以及长度失控。用数据表而不是十几个手写用例，
 * 是因为「新想到一类攻击面」应当只加一行——加一行比加一个用例容易得多。
 */
const REJECTED = [
  ["脚本协议", "javascript:alert(1)"],
  ["脚本协议（大小写变体）", "JavaScript:alert(1)"],
  ["data 协议", "data:text/html,<script>"],
  ["明文外链", "http://evil.example"],
  ["https 外链", "https://evil.example"],
  ["协议相对地址（浏览器会当成站外）", "//evil.example"],
  ["反斜杠开头的伪协议相对地址", "/\\evil.example"],
  ["空串", ""],
  ["纯空白", "   "],
  ["没有前导斜杠", "join"],
  ["路径中间夹带制表符", "/jo\tin"],
  ["路径中间夹带换行", "/jo\nin"],
  ["路径中间有空格", "/jo in"],
  ["含 NUL 控制字符（写成转义序列，避免源码里出现不可见字节）", "/jo\u0000in"],
  ["超长（上限 +1）", `/${"a".repeat(SAFE_PATH_MAX_LENGTH)}`],
];

// ——————————————————————— 通过：站内地址的正常形状 ———————————————————————

test("站内路径全部通过，且通过时给出的是原值", () => {
  for (const [label, sample] of ACCEPTED) {
    const result = validateSafePath(sample);

    assert.equal(result.ok, true, `${label}：${JSON.stringify(sample)} 应当通过`);
    assert.equal(result.value, sample, `${label}：通过时返回值就是它自己`);
    // 失败结果才带 message：成功结果里不该留一个空的错误字段给调用方误读
    assert.equal("message" in result, false, `${label}：成功的返回值不带 message`);
  }
});

test("长度上限本身合法，被拒的是「上限 + 1」——边界不是 >= 而是 >", () => {
  const max = `/${"a".repeat(SAFE_PATH_MAX_LENGTH - 1)}`;
  assert.equal(Array.from(max).length, SAFE_PATH_MAX_LENGTH, "这条样例必须正好在上限上");
  assert.equal(validateSafePath(max).ok, true);

  const over = `/${"a".repeat(SAFE_PATH_MAX_LENGTH)}`;
  assert.equal(Array.from(over).length, SAFE_PATH_MAX_LENGTH + 1);
  assert.equal(validateSafePath(over).ok, false);
  assert.equal(validateSafePath(over).message, SAFE_PATH_TOO_LONG_MESSAGE);
});

test("长度按 code point 算，不是 UTF-16 长度（中文路径不该被提前判超长）", () => {
  // 200 个中文字的 UTF-16 长度也是 200，但取一半（100 个字）已经足够说明口径：
  // 真正的检查点是「用 Array.from 数、不是用 .length 数」这一句写在实现里
  const exact = `/${"中".repeat(SAFE_PATH_MAX_LENGTH - 1)}`;
  assert.equal(validateSafePath(exact).ok, true);

  // 代理对（emoji）按 2 个 UTF-16 单元占 1 个 code point：若实现用 .length 计数，
  // 这一条会**提前**被判超长，从而拒掉一个完全合法的地址
  const emoji = `/${"🎮".repeat(SAFE_PATH_MAX_LENGTH - 1)}`;
  assert.equal(Array.from(emoji).length, SAFE_PATH_MAX_LENGTH);
  assert.equal(emoji.length, SAFE_PATH_MAX_LENGTH * 2 - 1, "这条样例的 UTF-16 长度确实更大");
  assert.equal(validateSafePath(emoji).ok, true);
});

// ——————————————————————— 拒绝：每一条单独一个用例 ———————————————————————

for (const [label, sample] of REJECTED) {
  test(`拒绝：${label}（${JSON.stringify(sample)}）`, () => {
    const result = validateSafePath(sample);

    assert.equal(result.ok, false, `${label}：必须被拒`);
    assert.equal(
      REJECT_MESSAGES.includes(result.message),
      true,
      `${label}：文案必须是四句已知文案之一，实际是 ${JSON.stringify(result.message)}`,
    );
    // 拒绝结果里没有 value：调用方不可能「顺手」把被拒的串拿去用
    assert.equal("value" in result, false, `${label}：被拒的结果不带 value`);
  });
}

test("被拒的四种原因各自对应正确的文案（不是所有失败都回同一句话）", () => {
  assert.equal(validateSafePath("").message, SAFE_PATH_REQUIRED_MESSAGE);
  assert.equal(validateSafePath("   ").message, SAFE_PATH_REQUIRED_MESSAGE);
  assert.equal(validateSafePath("join").message, SAFE_PATH_MUST_BE_INTERNAL_MESSAGE);
  assert.equal(validateSafePath("//evil.example").message, SAFE_PATH_MUST_BE_INTERNAL_MESSAGE);
  assert.equal(validateSafePath("/jo in").message, SAFE_PATH_INVALID_MESSAGE);
  assert.equal(validateSafePath("/jo\tin").message, SAFE_PATH_INVALID_MESSAGE);
  assert.equal(
    validateSafePath(`/${"a".repeat(SAFE_PATH_MAX_LENGTH)}`).message,
    SAFE_PATH_TOO_LONG_MESSAGE,
  );
});

// ——————————————————————— 冻结契约：startsWith("/") 单独不够 ———————————————————————

test("`/` 开头的地址也可能把人带到站外：//evil.example 必须被拒（独立用例）", () => {
  const sample = "//evil.example";

  // 这一条是整条规则存在的起因：`startsWith("/")` 单独判断会放过它，
  // 而浏览器把 `//host` 当成**协议相对地址**，用户端首页于是多了一个指向站外的格子
  assert.equal(sample.startsWith("/"), true, "这条样例确实以 / 开头——正是要点");
  assert.equal(sample.startsWith("//"), true, "而且以 // 开头");
  assert.equal(validateSafePath(sample).ok, false, "以 // 开头必须被拒");
  assert.equal(isSafePath(sample), false);

  // 同一类绕法的另外两种写法：反斜杠与三斜杠
  assert.equal(validateSafePath("/\\evil.example").ok, false);
  assert.equal(validateSafePath("//evil.example/x").ok, false);
  assert.equal(validateSafePath("///evil.example").ok, false);
});

/**
 * ⚠️ 这一条曾经是「已报告的规则缺口」，现在是**规则本身**。
 *
 * 冻结清单把「结尾带制表符 / 换行」（`/join\t`、`/join\n`）列为**必须被拒**的样例。
 * 早先的实现是 `raw.trim()` 之后再校验，于是 `/join\t` 会**通过**并入库成 `/join`
 * ——不是越权（危险协议与 `//` 都排在 trim 之后判定），但它违反了这条校验存在的意义：
 * **安全判定的最后一站不能有「校验的是 A、存的是 B」**。
 *
 * 现在的行为是拒绝。这条用例跟着从「钉住实际行为 + 标注已报告」升级成
 * 「钉住要求的行为」——强度只增不减：它同时断言**首尾**与**中间**的控制字符都被拒，
 * 而原来只断言了中间那一半。
 */
test("首尾空白与控制字符一律被拒：不接受「静默规范化成另一个地址」", () => {
  for (const sample of ["/join\t", "/join\n", "\n/join\r\t", "  /join  ", "\t/join"]) {
    assert.equal(
      validateSafePath(sample).ok,
      false,
      `${JSON.stringify(sample)} 被接受了——首尾的空白/控制字符必须被拒，而不是被 trim 掉`,
    );
    assert.equal(isSafePath(sample), false);
  }

  // 中间的控制字符同样被拒：首尾与中间不该有两套规则
  assert.equal(validateSafePath("/jo\tin").ok, false);
  assert.equal(validateSafePath("/jo\nin").ok, false);

  // 带空白前缀的危险地址照样被拒（两道防线各自独立）
  assert.equal(validateSafePath("  //evil.example  ").ok, false);
  assert.equal(validateSafePath("\njavascript:alert(1)").ok, false);
  assert.equal(validateSafePath("/\t\\evil.example").ok, false);

  // 「没填」与「填了空白」仍然是同一类：都还没有地址
  assert.equal(validateSafePath("").message, SAFE_PATH_REQUIRED_MESSAGE);
  assert.equal(validateSafePath("   ").message, SAFE_PATH_REQUIRED_MESSAGE);
});

/**
 * 不可见字符：C1 控制字符与**零宽 / 格式化字符**。
 *
 * ⚠️ 这一条守的是本文件的第 4 条规则「两个视觉上相同的地址不能有不同行为」。
 * 原先只挡 C0（`code < 0x20`）与 DEL，于是 `/jo​in`（零宽空格）能穿过去：
 * 它在运营眼里与 `/join` **一模一样**，却是另一个字符串。今天它只是 404；
 * 一旦下游多一层复制粘贴清洗或 URL 规范化把零宽字符剥掉，两个地址就会真的合并。
 *
 * 同样被拒的还有 U+00AD（软连字符）、U+2060（词连接符）、U+FEFF（字节序标记）
 * 以及 C1 区间（U+0080–U+009F）——它们既不在 `code < 0x20` 里，也不被 `\s` 命中。
 */
test("零宽字符、格式化字符与 C1 控制字符不能藏在地址里", () => {
  // 用转义写而不是把字符直接贴进源码：这些字符**看不见**，
  // 直接贴进来的话，读代码与改代码的人都无法确认自己看到的到底是哪一个。
  const invisible = [
    "\u200B", // 零宽空格
    "\u200C", // 零宽非连接符
    "\u200D", // 零宽连接符
    "\u2060", // 词连接符
    "\uFEFF", // 字节序标记
    "\u00AD", // 软连字符
    "\u202E", // 从右到左覆盖（同一个家族：不可见却改变阅读顺序）
    "\u0085", // C1 控制字符 NEL（不在 code < 0x20 里）
    "\u009F", // C1 控制字符区间上界
  ];

  for (const character of invisible) {
    const sample = `/jo${character}in`;
    assert.equal(
      validateSafePath(sample).ok,
      false,
      `零宽/控制字符 U+${character.codePointAt(0).toString(16).toUpperCase()} 穿过了校验`,
    );
    assert.equal(isSafePath(sample), false);
  }

  // 反过来：中文与 emoji 不在 `C` 类里，一个都不该被误伤
  for (const sample of ["/placeholder?title=点单权益", "/join#开始", "/a?q=😀"]) {
    assert.equal(validateSafePath(sample).ok, true, `合法地址 ${sample} 被误拒了`);
  }
});

test("脚本协议带前导斜杠的变体也被拒（`//` 与危险协议两道防线各自独立）", () => {
  // 前导斜杠 + 脚本协议：既踩「不以 / 开头」也踩「//」；这里确认它不会因为
  // 规则执行的先后顺序而漏过
  for (const sample of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:,x"]) {
    assert.equal(validateSafePath(sample).ok, false, `${sample} 必须被拒`);
  }
});

// ——————————————————————— 返回值与纯函数性质 ———————————————————————

test("返回值与传入值逐字符相同：不存在「校验的是 A、存的是 B」", () => {
  // 通过时值是它自己——一个字符都不多、一个字符都不少
  for (const [label, sample] of ACCEPTED) {
    assert.deepEqual(
      validateSafePath(sample),
      { ok: true, value: sample },
      `${label}：通过时返回值必须与传入值完全相同`,
    );
  }

  // 带首尾空白的输入不是「被规范化成合法值」，而是被拒——
  // 这是这条用例与上一版最大的差别：以前它断言 `"  /join  "` → `{ok:true, value:"/join"}`，
  // 那正是在给「两个消费方看到两个不同字符串」留口子
  for (const sample of ["  /join  ", "\t/join\n", "  /placeholder?title=点单权益  "]) {
    assert.equal(validateSafePath(sample).ok, false, `${JSON.stringify(sample)} 不该被静默修剪`);
  }

  // 带空白前缀的危险地址照样被拒
  assert.equal(validateSafePath("  //evil.example  ").ok, false);
  assert.equal(validateSafePath("   ").message, SAFE_PATH_REQUIRED_MESSAGE);
});

test("纯函数：同一个输入连续调用两次结果相同，且与调用顺序无关", () => {
  for (const [, sample] of [...ACCEPTED, ...REJECTED]) {
    assert.deepEqual(
      validateSafePath(sample),
      validateSafePath(sample),
      `${JSON.stringify(sample)} 两次调用结果必须一致`,
    );
  }

  // 一次失败不会污染后续调用（没有模块级的可变状态被写坏）
  const before = validateSafePath("/join");
  validateSafePath("javascript:alert(1)");
  validateSafePath("");
  assert.deepEqual(validateSafePath("/join"), before);

  // 上限常量本身也不被改写：调用不产生副作用
  assert.equal(SAFE_PATH_MAX_LENGTH, 200);
});

test("isSafePath 与 validateSafePath().ok 对每一个样例结论一致", () => {
  for (const [label, sample] of ACCEPTED) {
    assert.equal(isSafePath(sample), true, `通过样例「${label}」两者必须都说可以`);
    assert.equal(isSafePath(sample), validateSafePath(sample).ok);
  }
  for (const [label, sample] of REJECTED) {
    assert.equal(isSafePath(sample), false, `拒绝样例「${label}」两者必须都说不可以`);
    assert.equal(isSafePath(sample), validateSafePath(sample).ok);
  }

  // 非字符串输入不在契约里（类型上就写不出来），因此不在这里替它兜底断言
});
