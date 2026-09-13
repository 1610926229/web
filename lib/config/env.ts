/**
 * Mock 能力环境开关（**仅服务端读取**）。
 *
 * 未显式开启时，Mock 能力一律关闭：模拟登录接口返回 404、Mock 会话 Cookie 不再
 * 产生登录身份、调试查询参数不再影响数据。正式部署不设置这两个变量即可。
 *
 * ⚠️ 这里用**动态 key** 访问 process.env，而不是 `process.env.ENABLE_MOCK_AUTH`：
 * 打包器会把静态写法的 `process.env.X` 在构建期内联成常量，导致「构建时开、运行时关」
 * 这类差异被抹掉；动态取值保证每次调用都读运行时的真实环境变量。
 */
function readFlag(name: string): boolean {
  return process.env[name] === "true";
}

/** 模拟登录（`/api/auth/mock-login`、mock 会话 Cookie）是否启用。 */
export function isMockAuthEnabled(): boolean {
  return readFlag("ENABLE_MOCK_AUTH");
}

/** 调试查询参数（`mockError` / `mockEmpty` / `mockDelay`）是否启用。 */
export function isMockDebugEnabled(): boolean {
  return readFlag("ENABLE_MOCK_DEBUG");
}
