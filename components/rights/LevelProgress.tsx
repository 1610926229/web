import { formatYuan } from "@/lib/utils/format";

/**
 * 消费等级进度条。
 *
 * **纯展示组件**：百分比由服务端的 `buildConsumptionLevelSummary` 算好传进来，
 * 本组件不读订单、不推导等级。这里只做两件事：
 *
 * 1. **兜住异常值**：非有限值按 0、负数按 0、超过 100 按 100。服务端已经收敛过一次，
 *    但进度条是「一个 NaN 就会渲染成 width: NaN% 而整条消失」的地方，因此在渲染出口
 *    再收敛一次——这是最后一道，不是唯一一道。
 * 2. **颜色不是唯一的信息载体**：条形旁边始终有一句文字说明（「还差 ¥xx 升级」或
 *    「已达到当前最高等级」），百分比也写进 `aria-valuetext` 并单独显示一次，
 *    因此不依赖颜色深浅也能读出进度。
 *
 * `tone` 只决定配色（`/rights` 的深色摘要卡 / `/mine` 的浅色卡片），
 * 不改变任何数值与文案——两处的进度必须是同一个数。
 */
export default function LevelProgress({
  percent,
  currentAmount,
  targetAmount,
  caption,
  tone = "hero",
}: {
  /** 0–100 的进度百分比（服务端给出） */
  percent: number;
  /** 当前等级区间内已完成的金额（分） */
  currentAmount: number;
  /** 当前等级区间的总宽度（分）；已是最高等级时为 null */
  targetAmount: number | null;
  /** 条形下方那句文字（差额或「已达到当前最高等级」） */
  caption: string;
  tone?: "hero" | "light";
}) {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const rounded = Math.round(safePercent);

  const amountText =
    targetAmount === null
      ? ""
      : `${formatYuan(Math.max(0, currentAmount))} / ${formatYuan(Math.max(0, targetAmount))}`;

  const trackClass = tone === "hero" ? "bg-white/20" : "bg-page";
  const captionClass = tone === "hero" ? "text-mine-hero-ink-soft" : "text-ink-3";

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={amountText ? `${amountText}，已完成 ${rounded}%` : `已完成 ${rounded}%`}
        className={`h-2 w-full overflow-hidden rounded-full ${trackClass}`}
      >
        <div
          className="level-progress-fill h-full rounded-full"
          style={{ width: `${safePercent}%` }}
        />
      </div>

      <div className={`flex flex-wrap items-baseline gap-x-2 text-[12px] leading-5 ${captionClass}`}>
        {/* 文字与数字都写出来：颜色只表示「多与少」，不承担「有与无」的信息 */}
        <span>{caption}</span>
        {amountText ? <span>{amountText}</span> : null}
        <span className="ml-auto">{rounded}%</span>
      </div>
    </div>
  );
}
