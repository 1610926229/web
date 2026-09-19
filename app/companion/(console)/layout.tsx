import type { ReactNode } from "react";
import CompanionAccessNotice from "@/components/companion/CompanionAccessNotice";
import CompanionHeader from "@/components/companion/CompanionHeader";
import CompanionIdentityCard from "@/components/companion/CompanionIdentityCard";
import MobileShell from "@/components/common/MobileShell";
import RequireAuth from "@/lib/auth/RequireAuth";
import { resolveCompanionAccess } from "@/lib/services/companionAccess";
import type { User } from "@/lib/types/user";

/**
 * 打手工作台的壳层（P0-4）。
 *
 * ⚠️ **鉴权分成两步，两步都在服务端**，而且**都不新建身份体系**：
 *
 * 1. **他登录了吗** —— `RequireAuth`，也就是用户端「我的」「订单」用的同一个守卫。
 *    未登录时它渲染的是**用户端的登录控件**（本项目没有独立的 `/login` 路由，
 *    也没有打手登录页），登录后地址仍然是 `/companion`，不会跳到别处。
 * 2. **他是打手吗** —— `resolveCompanionAccess(user.id)`：这个用户名下有没有一条
 *    有效的、已上架的护航资料。判定只有这一处实现（`lib/services/companionAccess.ts`），
 *    接口守卫与这里读的是同一个函数。
 *
 * ⚠️ **本层是工作台唯一的资格读取点**，`page.tsx` 与 `CompanionIdentityCard` 都不再读一次。
 * 这不是为了省一次查询，而是为了**消掉一个中间态**：布局与页面在 React 里并行渲染，
 * 若两边各查一次，两次 `await` 之间资格一旦变化（管理员刚点了下架），就会出现
 * 「布局按旧记录渲染出工作台壳、页面却取不到资料」——用户停在「顶栏 + 空白」。
 * 因此：**顶栏、身份卡、段位、两种提示页，全部由这一次判定决定**，
 * 页面只剩不需要资格的静态内容。`tests/companionAccess.test.mjs` 里有两条结构约束
 * 钉住这一点（本项目只允许一处调用点、页面与身份卡禁止出现任何读取入口）。
 *
 * ⚠️ 这一层**不是接口的保护伞**：页面跳转拦不住直接请求接口。
 * 将来的打手接口逐个调用 `requireCompanion()`（见 `lib/api/companionRoute.ts`）。
 *
 * ⚠️ 顶部**没有退出登录**：打手用的是用户账号，退出在「我的」页面。
 * 在工作台再放一个退出按钮，会让人以为退出后还有一个「打手登录」入口。
 *
 * 路由组 `(console)` 不产生 URL 段：`app/companion/(console)/page.tsx` 的地址就是
 * `/companion`。分组保留下来是为了让将来可能出现的兄弟页面（如 `/companion/*`）
 * 天然套上这层鉴权与壳层，而不是各自去写一遍——身份卡随之一起出现在每个兄弟页顶部，
 * 这是**有意**的：它们都是「这位打手自己的工作台」，页页写明「你是谁」不算噪音。
 */
export default function CompanionConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      {(user) => <CompanionConsoleShell user={user}>{children}</CompanionConsoleShell>}
    </RequireAuth>
  );
}

/**
 * 已登录用户的工作台外壳：能进就渲染顶栏 + 身份卡 + 内容，不能进就渲染提示页。
 *
 * ⚠️ 提示页**不套顶栏**：顶栏上写的是打手昵称与段位，没有理由拿给一个不是打手的人看。
 * 提示页也**不渲染 `children`**：拿不到资格时，页面的内容一个字节都不该出现。
 */
async function CompanionConsoleShell({ user, children }: { user: User; children: ReactNode }) {
  // 一次页面渲染里唯一的一次资格读取；下面渲染的每一个字段都出自它
  const access = await resolveCompanionAccess(user.id);

  if (access.kind !== "granted") {
    return (
      <MobileShell>
        <CompanionAccessNotice state={access} />
      </MobileShell>
    );
  }

  return (
    <MobileShell>
      <CompanionHeader companion={access.companion} />
      <main className="flex flex-1 flex-col gap-4 px-4 py-5">
        <CompanionIdentityCard companion={access.companion} rankLabel={access.rankLabel} />
        {children}
      </main>
    </MobileShell>
  );
}
