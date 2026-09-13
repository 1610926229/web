import { register } from "node:module";

/**
 * `node --import ./tests/alias-hook.mjs --test tests/` 的入口：
 * 注册 `@/*` 别名解析钩子，其余什么都不做。
 */
register("./alias-loader.mjs", import.meta.url);
