/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */
import {
  LEVEL_PRIVILEGE_NOTICE,
  LEVEL_SECTION_TITLE,
  LEVEL_SPEND_LABEL,
  LEVEL_UNAVAILABLE_HINT,
  TOP_LEVEL_REACHED_MESSAGE,
  formatAmountToNextLevel,
} from "@/lib/constants/levels";
import type { ConsumptionLevelSummary } from "@/lib/types/level";
import { formatYuan } from "@/lib/utils/format";
import LevelProgress from "./LevelProgress";

/**
 * 消费等级摘要卡（`/rights` 顶部 / `/mine` 的等级入口）。
 *
 * **只吃 DTO**：等级、差额与进度都由服务端的 `buildConsumptionLevelSummary` 算好，
 * 本组件一次都没有遍历订单，也没有自己比较阈值——页面组件不得计算等级，
 * 否则「我的」页与消费等级页迟早会算出两个答案。
 *
 * 三种状态各有明确表现，**不互相伪装**：
 *
 * - 正常：当前等级 + 累计金额 + 进度 + 下一等级与差额；
 * - 已是最高等级：显示「已达到当前最高等级」，**不编造一个下一等级**，差额也不出现；
 * - 配置不可用（`available: false`）：等级位置显示原因，进度整块不渲染。
 *   但**累计金额照常显示**——它来自订单，与等级配置无关，藏起来反而像是数据丢了。
 *
 * 头像与昵称是可选的：`/rights` 顶部需要，`/mine` 上方已经有一张信息卡，传空即可。
 */
export default function LevelSummaryCard({
  summary,
  nickname,
  avatarUrl,
  tone = "hero",
}: {
  summary: ConsumptionLevelSummary;
  nickname?: string;
  avatarUrl?: string;
  tone?: "hero" | "light";
}) {
  const hero = tone === "hero";
  const titleClass = hero ? "text-mine-hero-ink" : "text-ink";
  const softClass = hero ? "text-mine-hero-ink-soft" : "text-ink-3";
  const strongClass = hero ? "text-mine-hero-ink" : "text-ink";
  const dividerClass = hero ? "border-white/15" : "border-line";

  return (
    <section className={`flex flex-col gap-3 rounded-[16px] ${hero ? "" : "border border-line bg-surface"} p-4`}>
      {nickname ? (
        <div className="flex items-center gap-3">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-11 w-11 shrink-0 rounded-full bg-white/10 object-cover ring-2 ring-mine-avatar-ring"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[15px] font-medium ${titleClass}`}>{nickname}</p>
            <p className={`text-[12px] leading-5 ${softClass}`}>{LEVEL_SECTION_TITLE}</p>
          </div>
        </div>
      ) : (
        <p className={`text-[13px] font-medium ${softClass}`}>{LEVEL_SECTION_TITLE}</p>
      )}

      {summary.available && summary.currentLevel ? (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
            <p className={`text-[22px] font-bold leading-7 ${strongClass}`}>
              {summary.currentLevel.name}
            </p>
            <p className={`flex items-baseline gap-1 text-[12px] leading-5 ${softClass}`}>
              {LEVEL_SPEND_LABEL}
              <span className={`text-[16px] font-semibold ${strongClass}`}>
                {`¥${formatYuan(summary.effectiveSpendAmount)}`}
              </span>
            </p>
          </div>

          <LevelProgress
            percent={summary.progressPercent}
            currentAmount={summary.progressCurrentAmount}
            targetAmount={summary.progressTargetAmount}
            caption={
              // 已是最高等级时给「已达到」而不是一个假的下一等级或负的差额
              summary.nextLevel && summary.amountToNextLevel !== null
                ? formatAmountToNextLevel(`¥${formatYuan(summary.amountToNextLevel)}`)
                : TOP_LEVEL_REACHED_MESSAGE
            }
            tone={tone}
          />

          {summary.nextLevel && summary.amountToNextLevel !== null ? (
            <p className={`text-[12px] leading-5 ${softClass}`}>
              {`下一等级：${summary.nextLevel.name}（累计消费满 ¥${formatYuan(summary.nextLevel.thresholdAmount)}）`}
            </p>
          ) : (
            // 最高等级：这里**不显示**「下一等级」，也不显示 0 元差额
            <p className={`text-[12px] leading-5 ${softClass}`}>
              已是当前最高等级，不再有下一等级与升级差额。
            </p>
          )}
        </>
      ) : (
        <>
          <p className={`text-[18px] font-semibold leading-7 ${strongClass}`}>
            {summary.unavailableReason}
          </p>
          <p className={`text-[12px] leading-5 ${softClass}`}>
            {`${LEVEL_SPEND_LABEL} ¥${formatYuan(summary.effectiveSpendAmount)}`}
          </p>
          <p className={`text-[12px] leading-5 ${softClass}`}>{LEVEL_UNAVAILABLE_HINT}</p>
        </>
      )}

      <div className={`border-t ${dividerClass} pt-3`}>
        {/* 权益是说明性示例，不是承诺：这句话在摘要卡上也不能省 */}
        <p className={`text-[11px] leading-4 ${softClass}`}>{LEVEL_PRIVILEGE_NOTICE}</p>
      </div>
    </section>
  );
}
