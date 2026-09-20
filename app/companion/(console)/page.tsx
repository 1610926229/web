import {
  COMPANION_COMING_SOON_ITEMS,
  COMPANION_COMING_SOON_TITLE,
  COMPANION_IDENTITY_NOTICE,
  COMPANION_SCOPE_NOTICE,
} from "@/lib/constants/companionConsole";

/**
 * 打手工作台概览（P0-4）—— **只有静态内容**。
 *
 * ⚠️ 这一页**不读任何数据**：不读会话、不查资格、不查仓储。
 * 「他是不是打手」「他是谁」「段位是什么」全部由壳层
 * （`app/companion/(console)/layout.tsx`）用**一次**资格判定决定，
 * 身份卡也由壳层渲染（`components/companion/CompanionIdentityCard.tsx`）。
 *
 * 为什么页面要这么薄：布局与页面在 React 里是**并行渲染**的。页面若自己再判一次资格，
 * 两次读取之间资格一旦变化，就会出现「布局按旧记录渲染出工作台壳、
 * 页面却取不到资料」的中间态——用户停在「顶栏 + 空白」。
 * 一份结果决定一切，就不存在两份结果不一致的可能。
 * 页面因此连「取不到资料就返回空白」这种分支都不需要：它没有资料可失去。
 *
 * ⚠️ 这一页**永远只有静态内容**，包括 P0-5 之后：两张订单池各自有页面
 * （`/companion/exclusive`、`/companion/pool`，入口在顶栏导航里），
 * 概览页不需要、也不允许为了「顺便显示几条待接单」去读一次资格与池子——
 * 那就等于把「一次渲染只有一份资格结果」重新拆成两份。
 *
 * ⚠️ 剩下的内容全部是「还没开放什么」。**没有一个按钮是能点出订单的**——
 * 开始服务、完成材料、打手收益都属于后续批次，在这里放一个「敬请期待」的假按钮
 * 比什么都不放更糟。
 */
export default function CompanionConsolePage() {
  return (
    <>
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
