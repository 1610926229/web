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
 * 模拟管理员登录是否启用（**独立于 `ENABLE_MOCK_AUTH`**）。
 *
 * 关闭时 `/api/admin/auth/mock-login` 返回 404，管理登录页不渲染「模拟管理员登录」按钮，
 * 管理端 Cookie 也不再产生任何管理者身份——伪造该 Cookie 只会被引导回登录页。
 *
 * ⚠️ 与用户端开关**互不影响**：关掉这一个，普通用户的模拟登录照常可用；
 * 关掉 `ENABLE_MOCK_AUTH` 也不会顺带关掉管理端。两个开关、两套会话、两套 Cookie，
 * 「用户 Cookie 不能获得管理权限」「管理 Cookie 不能冒充普通用户」由此在开关层面也不会串。
 */
export function isMockAdminEnabled(): boolean {
  return readFlag("ENABLE_MOCK_ADMIN");
}

/**
 * 模拟**客服端**登录是否启用（**独立于 `ENABLE_MOCK_AUTH` 与 `ENABLE_MOCK_ADMIN`**）。
 *
 * 关闭时 `/api/staff/auth/mock-login` 返回 404，客服登录页不渲染任何账号选择控件，
 * 客服端 Cookie 也不再产生任何客服身份——伪造该 Cookie 只会被引导回登录页。
 *
 * ⚠️ 三个开关、三套会话、三套 Cookie，互不影响：关掉这一个，用户端与管理员端照常可用；
 * 关掉另外两个也不会顺带关掉客服端。「用户 Cookie 不能进工作台」「管理 Cookie 不能进工作台」
 * 「客服 Cookie 不能调用户或管理接口」由此在开关层面也不会串。
 */
export function isMockStaffEnabled(): boolean {
  return readFlag("ENABLE_MOCK_STAFF");
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
