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

/**
 * 模拟支付是否启用。
 *
 * 关闭时 `/api/payments/mock-confirm` 返回 404，支付结果页也不渲染「模拟支付成功/失败/取消」
 * 三个控件——没有支付渠道时，不能给出一个看起来能确认支付状态的按钮。
 * 注意：本项目**没有**任何真实微信支付凭据，也永远不会因为开启这个开关而调用真实接口。
 */
export function isMockPaymentEnabled(): boolean {
  return readFlag("ENABLE_MOCK_PAYMENT");
}
