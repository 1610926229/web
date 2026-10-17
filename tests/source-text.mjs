import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 源码文本工具（**只给测试用**）。
 *
 * ## 为什么单独一个文件
 *
 * `stripComments` / `readSource` / `collectFiles` / `withoutImports` 这几个纯文本函数
 * 在 `tests/` 下已经被逐字节抄了十几份。新写门禁时再抄一份，只会让下一次改动需要改更多
 * 个地方——而它们与断言毫无关系，是纯粹的「把源码变成字符串」。
 *
 * 因此：**新写的用例从这里 import，不再新增拷贝。** 已有的那些拷贝保持原样，
 * 把它们统一改成引用本模块属于重构，不在任何一批的范围内。
 *
 * ⚠️ 本文件不含任何 `test(...)`：它不会被 `node --test "tests/*.test.mjs"` 收集，
 * 只是一份被 import 的普通模块（与 `app-path.mjs` 同一性质）。
 */

/**
 * 去掉注释。门禁断言看的是**代码**：注释里写「本页没有 X」不算出现 X。
 *
 * ⚠️ 它是正则而不是解析器：字符串字面量里的 `//` 也会被当成注释。
 * 本项目里没有 URL 字面量，因此这个取舍是安全的；若将来出现，先改这里而不是绕开它。
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 读取源码文件（UTF-8）。 */
export function readSource(file) {
  return readFileSync(file, "utf8");
}

/**
 * 去掉 import 语句。
 *
 * 「守卫是第一个动作」这类**顺序**断言必须先去掉 import：`import { readJsonBody }`
 * 出现在文件开头，而它只是一个名字，与「什么时候解析请求体」毫无关系。
 */
export function withoutImports(source) {
  return source.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");
}

/** 递归列出目录下所有文件（不含目录本身）。 */
export function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectFiles(full));
    else found.push(full);
  }
  return found;
}
