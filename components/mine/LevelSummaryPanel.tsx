"use client";

import { useState } from "react";
import LevelSummaryCard from "@/components/rights/LevelSummaryCard";
import { fetchConsumptionLevel } from "@/lib/services/levelsHttp";
import type { ConsumptionLevelSummary } from "@/lib/types/level";

type PanelState =
  | { status: "ready"; summary: ConsumptionLevelSummary }
  | { status: "loading" }
  | { status: "error"; message: string };

/**
 * 「我的」页顶部的消费等级摘要。
 *
 * 三件刻意的事：
 *
 * 1. **取数失败只让这一块降级**。等级摘要来自 `/api/me/consumption-level`，
 *    它失败不代表「我的」页坏了——订单、优惠券、投诉等入口都不依赖它。
 *    因此这里给出**独立的重试按钮**，重试只重取这一块，整页不动。
 * 2. **不在浏览器端遍历订单算等级**。重试走的是同一个专用接口，
 *    金额与等级仍由服务端算好；本组件从头到尾没有订单数据。
 * 3. 首屏数据由 Server Component 传进来，因此正常情况下**没有加载闪烁**，
 *    只有用户主动点重试时才会看到加载态。
 */
export default function LevelSummaryPanel({
  initialSummary,
  initialError,
}: {
  /** 服务端首屏取到的摘要；服务端取数失败时为 null */
  initialSummary: ConsumptionLevelSummary | null;
  /** 服务端首屏取数失败的原因；成功时为空串 */
  initialError: string;
}) {
  const [state, setState] = useState<PanelState>(() =>
    initialSummary
      ? { status: "ready", summary: initialSummary }
      : { status: "error", message: initialError || "等级信息加载失败。" },
  );

  async function retry() {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", summary: await fetchConsumptionLevel() });
    } catch (cause) {
      setState({
        status: "error",
        message: cause instanceof Error ? cause.message : "等级信息加载失败，请稍后重试。",
      });
    }
  }

  if (state.status === "ready") {
    return <LevelSummaryCard summary={state.summary} tone="hero" />;
  }

  return (
    <div className="rounded-[16px] border border-mine-hero-button-border bg-mine-hero-button p-4">
      <p className="text-[13px] font-medium text-mine-hero-ink">我的消费等级</p>
      <p className="mt-1 text-[12px] leading-5 text-mine-hero-ink-soft">
        {state.status === "loading" ? "正在重新获取…" : state.message}
      </p>

      {state.status === "error" ? (
        <button
          type="button"
          onClick={() => void retry()}
          className="mt-3 rounded-full border border-mine-hero-button-border px-4 py-1 text-[12px] leading-5 text-mine-hero-ink"
        >
          重试
        </button>
      ) : null}

      <p className="mt-3 text-[11px] leading-4 text-mine-hero-ink-soft">
        其他功能不受影响，可以正常使用。
      </p>
    </div>
  );
}
