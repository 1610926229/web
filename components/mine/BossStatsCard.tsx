/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */
import type { ReactNode } from "react";
import { BOSS_LIST_EMPTY_MESSAGE, formatUsageCount } from "@/lib/constants/bossStats";
import { formatYuan } from "@/lib/utils/format";
import type { BossStatsSummary } from "@/lib/types/bossStats";

/**
 * 老板数据面板（**纯展示**，P1-7）。
 *
 * ## 它显示什么
 *
 * 五个指标，全部由服务端算好（见 `lib/constants/bossStats.ts`）：
 * 累计订单数 / 累计消费金额 / 最近 30 天消费 / 常玩游戏 Top3 / 常用打手 Top3。
 *
 * ⚠️ **本组件不遍历订单、不做任何统计**。它拿到的是已经聚合好的 DTO；
 * 一旦它自己开始按游戏名 group、按打手计数，页面上就会出现第二套口径。
 *
 * ## 几处刻意的决定
 *
 * - **金额复用 `formatYuan`**（产品裁定 `D12`：不另造格式），与消费等级卡、
 *   订单卡读的是同一个格式化函数，因此「¥1,234.00」在全站只有一种写法。
 * - **不做成可点击的行**（`D11`）：本轮是历史统计展示，不是「再来一单」入口，
 *   因此列表项没有 `Link`、没有按钮，也不会跳转到打手主页。
 * - **空列表显示「暂无数据」，不显示 `—`、也不隐藏整块**（`D12`）：
 *   `—` 在本项目里保留给「指标存在但数学上暂无可计算值」（例如完成率分母为 0），
 *   而这里单纯是「还没有历史数据」，两者含义不同。
 * - **口径说明原样展示**：用户看到「累计消费」时最容易自己脑补一个口径，
 *   与消费等级页 `CONSUMPTION_CALCULATION_NOTICE` 是同一条约定。
 */
export default function BossStatsCard({ summary }: { summary: BossStatsSummary }) {
  return (
    <section className="rounded-[16px] border border-line bg-surface p-4">
      <h2 className="text-[15px] font-semibold leading-6 text-ink">我的数据</h2>

      {/* 三个数值指标。三列等宽，数字用 tabular-nums 对齐，避免位数变化时左右跳动 */}
      <dl className="mt-3 grid grid-cols-3 gap-2">
        <StatItem label="累计订单数" value={`${summary.orderCount}`} unit="单" />
        <StatItem label="累计消费" value={`¥${formatYuan(summary.totalSpendAmount)}`} />
        <StatItem label="最近 30 天消费" value={`¥${formatYuan(summary.recent30dSpendAmount)}`} />
      </dl>

      <p className="mt-3 text-[11px] leading-4 text-ink-3">{summary.spendNotice}</p>

      <UsageSection
        title="常玩游戏"
        notice={summary.gameNotice}
        rows={summary.recentGames.map((game) => ({
          key: game.name,
          render: () => (
            <>
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">
                {game.name}
              </span>
              <span className="shrink-0 text-[12px] leading-5 text-ink-3">
                {formatUsageCount(game.orderCount)}
              </span>
            </>
          ),
        }))}
      />

      <UsageSection
        title="常用打手"
        notice={summary.companionNotice}
        rows={summary.recentCompanions.map((companion) => ({
          key: companion.companionId,
          render: () => (
            <>
              {/* 打手没有快照时**不编名字**，回落到中性文案（历史脏数据，不是正常状态） */}
              {companion.avatarUrl ? (
                <img
                  src={companion.avatarUrl}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded-full bg-page object-cover"
                />
              ) : (
                <span className="h-7 w-7 shrink-0 rounded-full bg-page" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">
                {companion.name || "打手"}
              </span>
              <span className="shrink-0 text-[12px] leading-5 text-ink-3">
                {formatUsageCount(companion.serviceCount)}
              </span>
            </>
          ),
        }))}
      />
    </section>
  );
}

function StatItem({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] leading-4 text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate text-[15px] font-semibold leading-6 text-ink">
        <span className="tabular-nums">{value}</span>
        {unit ? <span className="ml-0.5 text-[11px] font-normal text-ink-3">{unit}</span> : null}
      </dd>
    </div>
  );
}

/**
 * 一个 Top3 榜单区块：小标题 + 行 + 口径说明。
 *
 * 空列表走 `BOSS_LIST_EMPTY_MESSAGE`（产品裁定 `D12`）。文案从常量取而不是写死，
 * 是为了让「无数据时到底显示什么」成为可断言的一件事。
 */
function UsageSection({
  title,
  notice,
  rows,
}: {
  title: string;
  notice: string;
  rows: readonly { key: string; render: () => ReactNode }[];
}) {
  return (
    <div className="mt-4">
      <h3 className="text-[13px] font-medium leading-5 text-ink-2">{title}</h3>

      {rows.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-5 text-ink-3">{BOSS_LIST_EMPTY_MESSAGE}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2">
              {row.render()}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1.5 text-[11px] leading-4 text-ink-3">{notice}</p>
    </div>
  );
}
