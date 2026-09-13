import Link from "next/link";
import type { AdminOverviewMetric } from "@/lib/types/admin";

/**
 * 概览指标卡。
 *
 * **服务端组件**：卡片只是链接，没有任何交互状态，因此不需要 `"use client"`，
 * 数字随 HTML 一起输出，首屏不会先闪一排占位再跳到真实值。
 *
 * 每张卡都是指向对应列表筛选的链接（`href` 由服务端给出）。
 * 数字是**仓储聚合出来的**，不是写死的展示值——文案与数值都来自
 * `lib/services/adminConsole.ts`，本组件不做任何计算。
 *
 * 桌面端一行四列，窄屏自动降为两列、一列；不做横向滚动：
 * 后台的数字应当一屏看完，而不是要拖动才看得到。
 */
export default function AdminMetricCards({
  metrics,
  emptyHint,
}: {
  metrics: readonly AdminOverviewMetric[];
  /** 全部指标为 0 时显示的说明；为空时表示当前有数据 */
  emptyHint?: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <li key={metric.key}>
            <Link
              href={metric.href}
              className="flex h-full flex-col gap-2 rounded-xl border border-admin-line bg-surface p-4 transition-colors hover:border-admin-accent"
            >
              <span className="text-[13px] text-ink-3">{metric.label}</span>
              {/*
                数字用表格数字宽度（`tabular-nums`）：刷新时数字位数变化不会让整行抖动。
                颜色用中性主文字色——这里没有「好 / 坏」之分，不该由颜色暗示结论。
              */}
              <span className="text-[28px] font-semibold leading-none tabular-nums text-ink">
                {metric.value}
              </span>
              <span className="text-[12px] leading-4 text-ink-3">{metric.hint}</span>
            </Link>
          </li>
        ))}
      </ul>

      {emptyHint ? (
        <p className="rounded-xl border border-admin-line bg-surface px-4 py-3 text-[13px] text-ink-3">
          {emptyHint}
        </p>
      ) : null}
    </div>
  );
}
