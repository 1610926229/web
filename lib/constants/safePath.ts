/**
 * 站内路径的安全校验。
 *
 * 存在的理由很具体：P8E-1 起**管理员可以自己填一个快捷入口的目标地址**，
 * 而这个地址会被直接放进用户端的 `<Link href={...}>`。在 `href` 上放一个
 * 未校验的字符串，等于把一个「点一下执行 `javascript:`」的口子交给了后台表单——
 * 一次误填、一次复制粘贴，用户端就多了一个可被利用的入口。
 *
 * ⚠️ **`startsWith("/")` 单独是不够的**。`//evil.example/x` 也以 `/` 开头，
 * 浏览器会把它当成**协议相对地址**，于是用户端首页出现一个指向站外的入口。
 * 因此本文件的第一条规则是「以 `/` 开头**且不**以 `//` 开头」。
 *
 * 校验分两层，缺一不可：
 *
 * 1. **语法层（本文件）**：一个字符串能不能作为站内地址使用。
 * 2. **存在性层**：这个地址背后是不是真有一页。这一层**不在服务端**——
 *    路由表只有构建期知道，服务端读不到 `app/` 目录。它由源码级测试
 *    `tests/routes.test.mjs` 对**预置数据**把关，并新增
 *    `tests/safePath.test.mjs` 对规则本身把关。因此「管理员填了一个格式合法但
 *    不存在的地址」是允许出现的——它会 404，但**不会**把人带到站外或执行脚本。
 *    这条边界是刻意的：宁可 404，不可执行。
 *
 * ⚠️ 本文件是纯函数，无任何运行时依赖，node 能直接加载它做测试，
 * 客户端组件引用它也不会把服务端模块打进浏览器产物。
 */

/** 路径长度上限。200 个字符足够任何真实站内地址，超出的多半是粘贴错了内容。 */
export const SAFE_PATH_MAX_LENGTH = 200;

/**
 * 明确拒绝的协议前缀（小写比对）。
 *
 * ⚠️ 这些串**本来就被「必须以 `/` 开头」挡在外面**，列出来是**第二道**防线：
 * 校验规则将来若因为别的需求放宽（比如允许填完整 URL），这些串必须仍然被拒绝，
 * 而那时写校验的人未必会想起 `javascript:`。把危险名单写在校验旁边，
 * 它就不会随着规则演进而消失。
 *
 * ⚠️ 这里**没有** `"//"`：协议相对地址由下面两条更宽的规则挡住——
 * 「不以 `//` 开头」与「任何位置都不出现 `//`」。后者同时覆盖 `/..//evil.example`
 * 这类先靠点段、再把 `//` 挪到中间的写法。名单里再放一份是重复的，
 * 而重复的规则在改动时只会有一处被改到。
 */
const DANGEROUS_SCHEMES: readonly string[] = [
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "http:",
  "https:",
];

/**
 * 不可见字符：Unicode 的 `C` 类（Cc 控制 / Cf 格式 / Cs 代理 / Co 私用 / Cn 未分配）。
 *
 * ⚠️ 为什么单独说这一条。原先只挡 C0（`code < 0x20`）与 DEL，于是有两类字符能穿过去：
 *
 * - **C1 控制字符**（U+0080–U+009F）——它们不在 `code < 0x20` 里，也不被 `\s` 命中；
 * - **零宽字符与格式化字符**（U+200B 零宽空格、U+200C/D 连字控制、U+2060 词连接符、
 *   U+00AD 软连字符、U+FEFF 字节序标记）。
 *
 * 后一类不是「越权」，但它直接破坏本文件的第 4 条规则：`/jo​in` 与 `/join`
 * 在运营眼里**看起来一模一样**，却是两个不同的字符串。今天它只是 404；
 * 等下游多一层「复制粘贴清洗」或「URL 规范化」把零宽字符剥掉，两个地址就会真的合并，
 * 而那时没人还能解释清楚「为什么两个不同的入口跳到了同一页」。
 * 「看起来一样就必须一样」，只能在这里保证。
 *
 * ⚠️ 用 `\p{C}` 而不是一份手写名单：手写名单永远是漏的（C1 就是漏掉的那一类），
 * 而这里要表达的规则本来就是一个 Unicode 类别。中文是 `Lo`、emoji 是 `So`、
 * `?` `#` `&` 是标点，都不在 `C` 类里，因此合法站内地址一个都不会被误伤。
 * 单独写一个代理对（不成对的 `\uD800`）是 `Cs`，同样被拒——它不是合法字符。
 */
const INVISIBLE_CHARACTER_PATTERN = /\p{C}/u;

/** 与 `lib/constants/admin*.ts` 同一套局部惯例：字段校验结果只有两态。 */
type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

export const SAFE_PATH_REQUIRED_MESSAGE = "请填写入口地址";
export const SAFE_PATH_MUST_BE_INTERNAL_MESSAGE = "入口地址必须是以 / 开头的站内地址";
export const SAFE_PATH_INVALID_MESSAGE = "入口地址包含不允许的字符或协议";
export const SAFE_PATH_TOO_LONG_MESSAGE = `入口地址不能超过 ${SAFE_PATH_MAX_LENGTH} 个字符`;

/**
 * 校验一个站内路径。
 *
 * ⚠️ **通过时返回的值与传入的值逐字符相同**（首尾空白不是「被去掉」，而是「被判为不合法」）。
 *
 * 这一点是刻意的，也是本函数唯一一处容易被写错的地方。早先的实现是 `raw.trim()`
 * 之后再校验，于是 `/join\t` 会**通过**并入库成 `/join`。它在当时并不构成越权
 * （危险协议与 `//` 都在 trim 之后才判定），但它违反了本函数存在的意义：
 * 安全判定的最后一站绝不能存在「校验的是 A、存的是 B」。只要有一处下游
 * （HTTP 头、日志、另一个消费方）拿的是**原始输入**而不是返回值，
 * 被 trim 掉的那一段就变成了两个消费方看到两个不同地址的入口。
 *
 * 因此「首尾有空白或控制字符」= **拒绝**，而不是「静默规范化」。
 * 表单那一层已经做过 `trim()`（`readTrimmedString`），运营粘贴时多带的空格
 * 在那里就没了，走到这里的一定是已经修剪过的字符串——所以这条规则
 * 对正常使用没有任何影响，它只对「绕过表单直接调接口」的那些输入生效。
 *
 * 规则（按顺序，全部命中才算通过）：
 *
 * 1. 去空白后非空（`""` 与全空白都归到这里：「没填」与「填错了」是两回事）；
 * 2. **首尾没有空白或控制字符**（`raw === raw.trim()`）——见上；
 * 3. 长度不超过 `SAFE_PATH_MAX_LENGTH`（按码点计，不是 UTF-16 单元）；
 * 4. **不含任何不可见字符**：C0 / C1 控制字符、零宽字符与格式化字符、代理与私用区
 *    （`INVISIBLE_CHARACTER_PATTERN`，见那里的说明）；
 * 5. **不含任何空白**：站内地址里没有空格，留着只会让「看起来一样」的两个地址行为不同；
 * 6. 以 `/` 开头；
 * 7. **不**以 `//` 开头（协议相对地址，见文件头）；
 * 8. **任何位置**都不出现 `//`：`/..//evil.example` 这类先靠点段、再把 `//` 挪到中间的
 *    写法，在第 7 条下是合法的，而它一旦被某个消费方「规范化后拼上 origin」就会
 *    序列化回协议相对地址。站内路由里没有一条需要用 `//`；
 * 9. 不含反斜杠（`/\evil.example` 在部分浏览器里等价于 `//evil.example`）；
 * 10. 小写后不以任何 `DANGEROUS_SCHEMES` 开头（第二道防线）。
 */
export function validateSafePath(raw: string): FieldResult<string> {
  const trimmed = raw.trim();

  // 「没填」与「填了空白」是同一件事：都还没有地址
  if (trimmed.length === 0) {
    return { ok: false, message: SAFE_PATH_REQUIRED_MESSAGE };
  }

  // 首尾有空白/控制字符 → 拒绝，不静默修剪（见函数头）
  if (raw !== trimmed) {
    return { ok: false, message: SAFE_PATH_INVALID_MESSAGE };
  }

  const value = raw;

  if (Array.from(value).length > SAFE_PATH_MAX_LENGTH) {
    return { ok: false, message: SAFE_PATH_TOO_LONG_MESSAGE };
  }

  if (INVISIBLE_CHARACTER_PATTERN.test(value)) {
    return { ok: false, message: SAFE_PATH_INVALID_MESSAGE };
  }

  if (/\s/.test(value)) {
    return { ok: false, message: SAFE_PATH_INVALID_MESSAGE };
  }

  if (!value.startsWith("/")) {
    return { ok: false, message: SAFE_PATH_MUST_BE_INTERNAL_MESSAGE };
  }

  if (value.startsWith("//")) {
    return { ok: false, message: SAFE_PATH_MUST_BE_INTERNAL_MESSAGE };
  }

  // 不在开头的 `//` 同样不允许：`//` 出现在中间的唯一含义就是有人在挪协议相对地址
  if (value.includes("//")) {
    return { ok: false, message: SAFE_PATH_INVALID_MESSAGE };
  }

  if (value.includes("\\")) {
    return { ok: false, message: SAFE_PATH_INVALID_MESSAGE };
  }

  const lowered = value.toLowerCase();
  for (const scheme of DANGEROUS_SCHEMES) {
    if (lowered.startsWith(scheme)) {
      return { ok: false, message: SAFE_PATH_MUST_BE_INTERNAL_MESSAGE };
    }
  }

  return { ok: true, value };
}

/** 校验是否通过。需要值的时候用 `validateSafePath()`，这里只回答是非。 */
export function isSafePath(raw: string): boolean {
  return validateSafePath(raw).ok;
}
