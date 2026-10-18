/**
 * 公网只读预览的**路径白名单**（仅服务端使用）。
 *
 * ## 为什么需要这一层
 *
 * Staging 目前同时服务两类访问：
 *
 * 1. **SSH 隧道**（`127.0.0.1:3000`）——私有验收环境，Mock 登录、管理端、
 *    客服端、打手端、模拟支付都必须继续可用；
 * 2. **公网反向代理**（Nginx → `127.0.0.1:3000`）——任何人都能打开的只读预览，
 *    只允许浏览首页、分类、商品、陪玩、榜单与协议。
 *
 * 两者最终落到**同一个 Next.js 进程**，进程自己无法从来源 IP 区分它们
 * （隧道请求同样来自 `127.0.0.1`）。因此不能靠「隐藏前端入口」或「只挡页面」，
 * 必须在**请求进入路由之前**按公网预览的规则拒绝。
 *
 * 区分方式只有一个：Nginx 在反代时**覆盖写入** `X-Chaoge-Public-Preview: 1`，
 * 并用 `proxy_set_header Cookie ""` 清掉 Cookie。公网访客无法让这个头消失，
 * 也无法伪造它（Nginx 的 `proxy_set_header` 会覆盖客户端传来的同名头）；
 * 隧道直连不经过 Nginx，因此没有这个头，仍走完整功能。
 *
 * ## 这一层与 Nginx 的关系
 *
 * 两层是**互相独立**的：
 *
 * - Nginx 先做一层白名单（连 `/api/admin` 都不转发）；
 * - 本模块在应用内再做一次同样的白名单（即使 Nginx 配置被改松、或未来多了一条
 *   反代路径，危险接口仍然到不了路由）。
 *
 * 任何一层单独失效都不足以把 Mock 管理/客服/支付能力暴露到公网。
 *
 * ## 白名单的取舍
 *
 * 只列**游客可访问**的页面与只读接口。新增公开页面/接口时，必须同时改这里与
 * `deploy/proxy/chaoge-public.conf`，并补 `tests/publicPreview.test.mjs`；
 * 漏改的表现是公网 404（安全的一侧），而不是意外放行。
 */

/** Nginx 写入的公网预览标记头。隧道直连不会带它。 */
export const PUBLIC_PREVIEW_HEADER = "x-chaoge-public-preview";

/** 标记头的唯一合法值。 */
export const PUBLIC_PREVIEW_HEADER_VALUE = "1";

/**
 * 公开页面（精确路径）。不含子路径。
 *
 * - `/` 首页
 * - `/category` 分类
 * - `/rank`、`/rank/companions` 两个排行榜
 * - `/companions` 陪玩列表
 * - `/agreements` 协议
 * - `/activities`、`/help`、`/placeholder` 静态/占位页
 */
const PUBLIC_PAGE_EXACT: readonly string[] = [
  "/",
  "/category",
  "/rank",
  "/rank/companions",
  "/companions",
  "/agreements",
  "/activities",
  "/help",
  "/placeholder",
];

/**
 * 公开页面的**前缀**（详情页）。
 *
 * 只放行这两棵子树，`/product/<id>` 与 `/companions/<id>` 内部仍由页面自己做
 * 404 / 下架判断；这里不解析 id，也不接触数据。
 */
const PUBLIC_PAGE_PREFIXES: readonly string[] = ["/product/", "/companions/"];

/**
 * 公开只读接口（精确路径）。
 *
 * 这些接口本身就声明为游客可访问，且只返回公开 DTO：
 * 首页、商品列表、陪玩列表、协议、消费榜、打手榜。
 *
 * 其余 `/api/**` 一律不进入路由，尤其是：
 * `/api/auth/**`、`/api/admin/**`、`/api/staff/**`、`/api/companion/**`、
 * `/api/debug/**`、`/api/payments/**`、`/api/orders/**`、`/api/me/**`、
 * `/api/favorites/**`、`/api/coupons/**`、`/api/refunds/**`。
 */
const PUBLIC_API_EXACT: readonly string[] = [
  "/api/home",
  "/api/catalog/products",
  "/api/companions",
  "/api/agreements",
  "/api/rankings/consumption",
  "/api/rankings/companions",
];

/**
 * 去掉末尾斜杠（根路径除外）。
 *
 * Next 默认会把 `/category/` 308 到 `/category`；但公网层如果先拒绝，
 * 用户连重定向都看不到。这里按同一条路径处理两种写法。
 */
export function normalizePublicPreviewPath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname;
}

/**
 * 公网预览是否允许这个路径。
 *
 * 采用**白名单**：未列出的路径一律 false。`/api` 命名空间必须先于页面前缀判断，
 * 避免将来出现一个以 `/product/` 开头的接口时被误放行。
 */
export function isPublicPreviewPath(pathname: string): boolean {
  const normalized = normalizePublicPreviewPath(pathname);

  if (PUBLIC_API_EXACT.includes(normalized)) return true;
  if (normalized === "/api" || normalized.startsWith("/api/")) return false;

  if (PUBLIC_PAGE_EXACT.includes(normalized)) return true;
  return PUBLIC_PAGE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 公网预览只允许读取。
 *
 * HEAD 与 GET 由 Next/HTTP 语义视为同一类安全方法；POST/PUT/PATCH/DELETE/OPTIONS
 * 全部拒绝。这样即使某个允许页面上挂着 Server Action，公网也无法提交。
 */
export function isPublicPreviewMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * 公网预览里「该入口需要登录」的占位原因。
 *
 * 与真正「尚未开发」的占位页区分开：公网访客点到底部导航的「订单/客服/我的」
 * 或首页快捷入口里的「联系客服/点单权益/考核入驻/投诉客服专区」时，看到的是
 * 「暂不可用 · 该功能仅对已登录用户开放」，而不是误导性的「页面待实现」。
 */
export const PUBLIC_PREVIEW_UNAVAILABLE_REASON = "public-preview";

export const PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION =
  "该功能仅对已登录用户开放，公网预览暂不提供。请通过微信小程序访问完整功能。";

/**
 * 为「公网不可达」的入口生成占位页地址。
 *
 * 只改**展示层**的落点：Nginx 与应用内的白名单都不动，受保护路由照旧 404。
 * 这样公网访客不会撞上裸 404，也无法借占位页拿到任何能力。
 */
export function publicPreviewUnavailableHref(label: string): string {
  const title = label.trim() || "该功能";
  return `/placeholder?title=${encodeURIComponent(title)}&reason=${PUBLIC_PREVIEW_UNAVAILABLE_REASON}`;
}

/**
 * 公网预览下的链接改写：公开路径原样返回，其余换成「暂不可用」占位页。
 *
 * 只处理站内绝对路径；外链、`tel:`/`weixin:` 等协议、纯锚点原样返回——
 * 它们不经过本应用的路由，改写反而会破坏原有行为。
 *
 * ⚠️ 这是**导航可达性**的修复，不是权限判断。真正的拒绝仍在 Nginx 与
 * `proxy.ts`；即使有人手工输入 `/orders`，结果依然是 404。
 */
export function publicPreviewSafeHref(href: string, label: string): string {
  try {
    const url = new URL(href, "https://public-preview.invalid");
    if (url.origin !== "https://public-preview.invalid") return href;
    if (isPublicPreviewPath(url.pathname)) return href;
    return publicPreviewUnavailableHref(label);
  } catch {
    return href;
  }
}
