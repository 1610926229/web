import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 让 node 能直接加载项目源码里的**无扩展名导入**与 `@/` 别名。
 *
 * 为什么需要它：项目按 bundler 的解析规则写导入——`@/lib/...` 指向仓库根目录，
 * 相对导入不写 `.ts` 扩展名。这两件事 Next 与 tsc 都认识，但 node 的 ESM 解析器都拒绝：
 * 别名它不认识，无扩展名的相对路径它会去找同名文件而报 MODULE_NOT_FOUND。
 *
 * 测试要跑**真实模块**而不是复制一份逻辑，就必须把这两条规则翻译过去。
 * 只需要一个解析钩子，不引入任何依赖：node 24 自带 TypeScript 类型擦除，
 * 因此 `lib/**` 下不依赖 React / next 的模块（常量、类型、仓储、service）可以直接被 import。
 * 带 JSX 的组件不在测试范围内——类型擦除不处理 JSX。
 *
 * ⚠️ 这是测试用的解析规则，不是运行时代码：应用本身仍由 Next 打包，
 * 本文件不参与构建（`tests/` 不在 tsconfig 的 include 里，也不会被打进产物）。
 */
const ROOT = new URL("../", import.meta.url);

// 顺序有意义：先试原样（已经带扩展名或指向真实文件），再补 `.ts` / `.tsx`，最后试目录下的 index
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolve(specifier, context, nextResolve) {
  // `@/xxx` → 仓库根目录；`./xxx` 与 `../xxx` → 相对当前模块
  const base = specifier.startsWith("@/")
    ? new URL(specifier.slice(2), ROOT)
    : (specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL
      ? new URL(specifier, context.parentURL)
      : null;

  if (base) {
    for (const extension of EXTENSIONS) {
      const url = new URL(`${base.href}${extension}`);
      if (existsSync(fileURLToPath(url))) {
        return { url: url.href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
