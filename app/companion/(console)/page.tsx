/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { getSessionUser } from "@/lib/auth/session";
import {
  COMPANION_COMING_SOON_ITEMS,
  COMPANION_COMING_SOON_TITLE,
  COMPANION_IDENTITY_NOTICE,
  COMPANION_ROLE_LABEL,
  COMPANION_SCOPE_NOTICE,
} from "@/lib/constants/companionConsole";
import { getCompanionWorkspaceView } from "@/lib/services/companionAccess";

/**
 * 打手工作台概览（P0-4）。
 *
 * ⚠️ **本批次只做身份接入**。这一页因此刻意很薄：它回答「你是谁」，
 * 并把「还没开放什么」写清楚。**没有一个按钮是能点出订单的**——
 * 订单池、接单、开始服务、完成材料、打手收益都属于后续批次，
 * 在这里放一个「敬请期待」的假按钮比什么都不放更糟。
 *
 * 页面上出现的每一个值都来自**同一个地方**：当前用户名下那条护航资料
 * （`getCompanionWorkspaceView`）。因此「同一个人既是老板又是打手」不需要任何切换：
 * 换个页面而已，身份还是同一个用户会话。
 *
 * ⚠️ 未登录与「不是打手」两种情况**在这一页里都到不了**：
 * 布局层（`layout.tsx`）已经判定过访问态并渲染了对应的提示页。
 * 页面与布局在 React 里是**并行渲染**的，因此页面仍然自己判一次，只信任自己的结果——
 * 取不到就渲染空白，绝不去读一份不存在的资料。
 */
export default async function CompanionConsolePage() {
  const user = await getSessionUser();
  const view = user ? await getCompanionWorkspaceView(user.id) : null;

  // 布局层已拦过一道；走到这里还取不到，只可能是会话在这两次读取之间失效了
  if (!view) return null;

  return (
    <>
      {/* 身份卡：这份资料与用户端「陪玩详情」里的那个人是同一条记录 */}
      <section className="flex items-center gap-3 rounded-2xl border border-line px-4 py-4">
        <img
          src={view.companion.avatarUrl}
          alt=""
          className="h-14 w-14 shrink-0 rounded-full border border-line object-cover"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-[16px] font-semibold text-ink">
            {view.companion.displayName}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-brand-blue-soft px-2 py-0.5 text-[11px] text-brand-blue">
              {COMPANION_ROLE_LABEL}
            </span>
            {view.rankLabel ? (
              <span className="text-[12px] text-ink-3">{view.rankLabel}</span>
            ) : null}
          </span>
        </div>
      </section>

      <p className="rounded-xl border border-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
        {COMPANION_IDENTITY_NOTICE}
      </p>

      <section className="flex flex-col gap-2 rounded-2xl border border-line px-4 py-4">
        <h2 className="text-[14px] font-semibold text-ink">{COMPANION_COMING_SOON_TITLE}</h2>
        <ul className="flex flex-col gap-1.5">
          {COMPANION_COMING_SOON_ITEMS.map((item) => (
            <li key={item} className="flex items-center gap-2 text-[13px] text-ink-3">
              <span className="h-1 w-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        <p className="pt-1 text-[12px] leading-5 text-ink-3">{COMPANION_SCOPE_NOTICE}</p>
      </section>
    </>
  );
}
