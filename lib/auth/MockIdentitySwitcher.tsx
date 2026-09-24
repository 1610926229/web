import { MOCK_LOGIN_ACCESS_LABELS, MOCK_LOGIN_USERS } from "@/lib/constants/mockUsers";
import { isMockAuthEnabled } from "@/lib/config/env";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import { getSessionUser } from "./session";
import MockIdentityPanel from "./MockIdentityPanel";

/**
 * DEV-1：身份切换面板的**服务端开关**（用户端全局布局挂这一个）。
 *
 * ## 存在理由只有一个：把开关判定关在服务端
 *
 * 客户端读不到环境变量，因此「要不要渲染这个工具」这件事**只能**由服务端回答。
 * 开关关闭时本组件直接返回 `null`——不是把按钮置灰、不是加一层 CSS、也不是
 * 「渲染出来但点了没用」，而是**页面上根本不存在这个东西**，名单也不会进入响应。
 * 这正是 DEV-1 §七要求的形态：优先「不渲染」，而不是 disabled。
 *
 * ⚠️ **顺序是安全约束的一部分，不要调换**：
 *
 * ```ts
 * if (!isMockAuthEnabled()) return null;   // ← 必须在前
 * const user = await getSessionUser();     // ← 必须在后
 * ```
 *
 * 先判开关再读会话，有两个后果，两个都是想要的：
 *
 * 1. 关闭时连 `cookies()` 都不会被调用。`session.ts` 里那句「无论开关如何都先读一次
 *    Cookie」是为**受保护路由**写的（它们必须按请求渲染），本组件在布局上、
 *    覆盖的是**所有**用户端页面（含首页这类原本可静态化的），因此这里刻意反着来：
 *    开关关闭时不读 Cookie，构建期该静态化的页面照旧静态化；
 * 2. 「开关是唯一判据」这件事在源码里看得见——一个不看开关就能读到会话的分支，
 *    将来很容易被改成「先读会话再决定」，那时开关就只挡 UI 不挡数据了。
 *
 * ## 它不认识权限，也不绕权限
 *
 * 面板只做「换掉当前会话」，不做任何页面级放行。切到一个进不去的身份时，
 * 由现有守卫（`RequireAuth` / 打手工作台布局）按各自的规则处理。本组件
 * **不 import 任何守卫**，也没有「让某个页面通过」的能力。
 *
 * ## 资格标签：由这里现算，不由名单声明
 *
 * 名单（`MOCK_LOGIN_USERS`）里只写 userId 与用途，**没有任何「谁是打手」的断言**。
 * 面板上那个「有效打手 / 普通用户」的标签由下面这段现算出来，走的是**唯一**的资格入口
 * `resolveCompanionAccess(userId)`——也就是打手工作台与打手接口守卫用的同一个函数。
 *
 * 为什么不让名单自己写：名单是一份**文案**，写错了没人拦得住，
 * 页面上就会出现「标着有效打手、点进去被 403」的自相矛盾（DEV-1 首轮交付
 * 正是因为这类「文案声称的与代码事实不符」被打回的）。现算的话，
 * 标签与真实判定用的是同一份数据、同一个函数，**没有脱节的可能**。
 *
 * ⚠️ 标签**只是显示**：面板不拿它做禁用、不做跳转，页面放行仍只由守卫决定。
 *
 * 代价是开关打开时每个用户端页面会多做 N 次资格查询（N = 名单长度，当前 8）。
 * 这是 Map 查找，且 `resolveCompanionAccess` 由 `React.cache` 包着；开关关闭时
 * （也就是正式形态）这段代码根本不执行——它在上面的早返回之后。
 *
 * ## 位置：`app/(mobile)/layout.tsx`
 *
 * 用户端全局（用户端所有页面都在这个布局下）。管理端与客服端**不挂**：
 * DEV-1 §十五 明确禁止管理 / 客服身份切换器，那两端的模拟登录各有自己的入口。
 */
export default async function MockIdentitySwitcher() {
  if (!isMockAuthEnabled()) return null;

  const user = await getSessionUser();

  // 逐个人现算资格标签。8 次仓储查询，每次是一次 Map 查找，且本函数由
  // `React.cache` 兜住同一请求内的重复调用；开关关闭时这段根本不执行。
  const accessLabels: Record<string, string> = {};
  for (const option of MOCK_LOGIN_USERS) {
    const access = await resolveCompanionAccess(option.userId);
    const label = MOCK_LOGIN_ACCESS_LABELS[access.kind];
    if (label) accessLabels[option.userId] = label;
  }

  return (
    <MockIdentityPanel
      current={user ? { userId: user.id, nickname: user.nickname } : null}
      accessLabels={accessLabels}
    />
  );
}
