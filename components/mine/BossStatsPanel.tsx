"use client";

import { useState } from "react";
import BossStatsCard from "@/components/mine/BossStatsCard";
import { fetchBossStats } from "@/lib/services/bossStatsHttp";
import type { BossStatsSummary } from "@/lib/types/bossStats";

type PanelState =
  | { status: "ready"; summary: BossStatsSummary }
  | { status: "loading" }
  | { status: "error"; message: string };

/**
 * 「我的」页的老板数据面板（P1-7）。
 *
 * 与 `LevelSummaryPanel` **同一套降级策略**，理由也一样：
 *
 * 1. **取数失败只让这一块降级**。它来自 `/api/me/boss-stats`，失败不代表「我的」页坏了——
 *    订单、优惠券、投诉等入口都不依赖它。因此给出**独立的重试按钮**，重试只重取这一块。
 * 2. **不在浏览器端做统计**。重试走的是同一个专用接口，五个指标仍由服务端算好；
 *    本组件从头到尾没有订单数据。
 * 3. 首屏数据由 Server Component 传进来，因此正常情况下**没有加载闪烁**。
 */
export default function BossStatsPanel({
  initialSummary,
  initialError,
}: {
  /** 服务端首屏取到的摘要；服务端取数失败时为 null */
  initialSummary: BossStatsSummary | null;
  /** 服务端首屏取数失败的原因；成功时为空串 */
  initialError: string;
}) {
  const [state, setState] = useState<PanelState>(() =>
    initialSummary
      ? { status: "ready", summary: initialSummary }
      : { status: "error", message: initialError || "数据加载失败。" },
  );

  async function retry() {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", summary: await fetchBossStats() });
    } catch (cause) {
      setState({
        status: "error",
        message: cause instanceof Error ? cause.message : "数据加载失败，请稍后重试。",
      });
    }
  }

  if (state.status === "ready") {
    return <BossStatsCard summary={state.summary} />;
  }

  return (
    <section className="rounded-[16px] border border-line bg-surface p-4">
      <h2 className="text-[15px] font-semibold leading-6 text-ink">我的数据</h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-3">
        {state.status === "loading" ? "正在重新获取…" : state.message}
      </p>

      {state.status === "error" ? (
        <button
          type="button"
          onClick={() => void retry()}
          className="mt-3 rounded-full border border-line px-4 py-1 text-[12px] leading-5 text-ink-2"
        >
          重试
        </button>
      ) : null}

      <p className="mt-3 text-[11px] leading-4 text-ink-3">其他功能不受影响，可以正常使用。</p>
    </section>
  );
}
