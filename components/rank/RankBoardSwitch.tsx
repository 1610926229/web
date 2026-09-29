import Link from "next/link";

/**
 * 榜单切换条（P1-5）：在「用户消费榜」与「打手榜」之间跳转。
 *
 * ## 为什么是**导航**而不是同一页里的页签
 *
 * 产品裁定（`rounds/P1-5/02-decisions.md` §10）要求
 * 「**Companion Ranking 与 User Consumption Ranking 必须是两个独立业务维度**」，
 * 而两个榜的**取数参数、名次规则、空态文案、隐私边界全都不一样**
 * （消费榜有「我的排名」、打手榜没有；消费榜名次是序号、打手榜是竞赛排名）。
 *
 * 做成同一页内的页签，两条取数路径就会共享一层页面状态（周期、分页、竞态判定），
 * 而消费榜那一层恰好是本轮**明令不得改写**的东西。做成两个地址，隔离性
 * **用文件边界就能证明**，不需要靠断言去猜。
 *
 * ## 为什么它是 Server Component（没有 `"use client"`）
 *
 * 它只渲染两个链接，没有状态、没有点击处理。整页刷新换来的是：
 * **切榜之后地址栏、首屏数据与页面标题三者一定一致**——
 * 而消费榜那条客户端取数路径恰恰要额外处理「地址栏与数据不同步」的竞态。
 * 能不做成客户端状态就不做。
 *
 * ## 为什么用 `aria-current` 而不是只给选中项上色
 *
 * 颜色单独出现时，色觉障碍用户与读屏用户都读不出「你现在在哪一页」。
 * 选中态同时用**背景、字重与 `aria-current="page"`** 表达。
 */
export default function RankBoardSwitch({ active }: { active: "consumption" | "companion" }) {
  const tabs = [
    { key: "consumption", label: "消费榜", href: "/rank" },
    { key: "companion", label: "打手榜", href: "/rank/companions" },
  ] as const;

  return (
    <nav
      className="flex shrink-0 gap-1.5 bg-surface px-3 pb-2"
      aria-label="榜单切换"
    >
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={selected ? "page" : undefined}
            className={`rounded-full px-3 py-1 text-[12px] leading-5 ${
              selected
                ? "seg-tab-active font-semibold underline decoration-2 underline-offset-4"
                : "bg-page text-ink-3"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
