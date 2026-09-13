import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 按**路由**找 `app/` 下的源文件，不关心它待在哪个路由组里。
 *
 * 为什么需要它：路由组（`(tabs)` / `(mobile)`）只影响布局与文件组织，不产生 URL 段。
 * 而 `readFileSync("app/rights/page.tsx")` 这种写法把「路由」和「文件位置」绑死了——
 * 2026-09 把用户端页面整体搬进 `(mobile)`、好让 `/admin` 不被 480px 移动壳层罩住时，
 * 一批与那次改动**毫无关系**的断言集体变红（9 条），全部是这一类路径。
 *
 * 那些断言真正想说的是「`/rights` 这个页面的源码里有 / 没有某段代码」，
 * 那就应该按路由去找，而不是按当时的目录名去猜。`tests/routes.test.mjs` 里的
 * `collectRoutes` 早就按同一套规则扫路由了，本模块把它复用到「找文件」上。
 *
 * 匹配规则：把候选路径中的路由组段去掉后与入参比较。
 * 例：`findAppFile("tips/new/page.tsx")` → `<root>/app/(mobile)/tips/new/page.tsx`
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(ROOT, "app");

const isRouteGroup = (segment) => segment.startsWith("(") && segment.endsWith(")");

/** 递归收集 `app/` 下的全部文件，同时记下「去掉路由组之后」的相对路径。 */
function collect(dir, segments, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // 与 Next 的规则一致：`.` 开头的目录/文件不参与路由
    if (entry.name.startsWith(".")) continue;
    const next = isRouteGroup(entry.name) ? segments : [...segments, entry.name];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, next, found);
    else found.push({ key: next.join("/"), full });
  }
  return found;
}

let scanned = null;

function files() {
  scanned ??= collect(APP_DIR, [], []);
  return scanned;
}

/** 归一化入参：允许写成 `"app/tips/new/page.tsx"` 或 `"tips/new/page.tsx"`。 */
function normalize(relative) {
  return relative
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^app\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

/**
 * 找到唯一的那个文件并返回绝对路径。
 *
 * 找不到或匹配到多个都直接抛错，而不是返回 undefined：这类调用**总是**要读内容的，
 * 静默返回空值会把「路径写错了」伪装成「断言通过了空字符串」，那是最难查的一种失败。
 */
export function findAppFile(relative) {
  const key = normalize(relative);
  const matches = files().filter((item) => item.key === key);
  if (matches.length === 0) {
    throw new Error(`app/ 下找不到 ${relative}（路由组已忽略，请检查路由路径是否写对）`);
  }
  if (matches.length > 1) {
    throw new Error(`app/ 下有多个文件匹配 ${relative}：${matches.map((m) => m.full).join(", ")}`);
  }
  return matches[0].full;
}

/** 该文件是否存在（路由组已忽略）。用于「残留路由不该存在」这类断言。 */
export function hasAppFile(relative) {
  const key = normalize(relative);
  return files().filter((item) => item.key === key).length > 0;
}

/**
 * 把源码路径解析成可以直接 `readFileSync` 的绝对路径。
 *
 * - `"app/..."` → 按路由找（路由组已忽略），因此页面在 `app/(mobile)/` 下也能找到；
 * - 其它（`"components/..."` / `"lib/..."`）→ 原样接在仓库根后面。
 *
 * 存在的意义是让调用处**只改一个函数名**：很多断言在同一个循环里同时遍历
 * `app/...` 与 `components/...`，如果只对前者换写法，循环就得拆成两段。
 */
export function resolveSource(relative) {
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.startsWith("app/")) return findAppFile(normalized);
  return path.join(ROOT, normalized);
}
