"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ADMIN_DASHBOARD_METRIC_HINTS,
  ADMIN_DASHBOARD_METRIC_LABELS,
  ADMIN_DASHBOARD_PENDING_HINTS,
  ADMIN_DASHBOARD_PENDING_HREFS,
  ADMIN_DASHBOARD_PENDING_LABELS,
  ADMIN_DASHBOARD_PENDING_TITLE,
  ADMIN_DASHBOARD_REFUNDS_HREF,
  ADMIN_DASHBOARD_REFUND_NOTICE,
  ADMIN_DASHBOARD_TODAY_NOTICE,
  ADMIN_DASHBOARD_TODAY_ORDERS_HREF,
  ADMIN_DASHBOARD_TODAY_TITLE,
} from "@/lib/constants/adminDashboard";
import { fetchAdminDashboard } from "@/lib/services/adminHttp";
import type { AdminDashboardDTO } from "@/lib/types/admin";
import { formatYuan } from "@/lib/utils/format";

/** 这一块自己的三种状态；加载与错误只替换数字区域，标题与说明始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

/**
 * 经营首页的「今日经营」与「当前待办」两块（P1-1）。
 *
 * ## 首屏不在这里取数
 *
 * 首屏的六个数字由 Server Component 取好（`initialDashboard`）后传进来，
 * 本组件**不在挂载时再请求一次**——因此首屏不会先闪一排占位再跳到真实值。
 * 这里发起的请求只有两种：用户点「刷新数据」，或失败后点「重试」。
 * 这与 `AdminOrderTable` 等既有管理列表是同一套路，理由也相同。
 *
 * ## 金额在**服务端算好的分值**上格式化
 *
 * `formatYuan()` 是纯字符串拼接的定长转换（不用 `Intl`、不看运行时区域设置），
 * 因此服务端渲染与浏览器渲染结果必然一致，不会有水合告警。
 * ⚠️ 这里**没有任何金额算术**：数字怎么来的全在服务层，本组件只把它显示出来。
 *
 * ## 全 0 不是错误，也不整页空态
 *
 * 「今天还没有订单」是一个**完全正常**的经营首页。因此六个数字全为 0 时，
 * 这里只是照常显示 `0` 并补一句说明，**不渲染整页 EmptyState**（§十）。
 *
 * ## 只读
 *
 * 卡片全是链接：点进去到**既有**管理页处理业务。本组件没有任何会改数据的按钮
 * ——审批、退款、换人、改申请状态都不在经营首页上发生（§六）。
 */
export default function AdminDashboardBoard({
  initialDashboard,
}: {
  initialDashboard: AdminDashboardDTO;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");

  async function refresh() {
    setLoadStatus("loading");
    setError("");

    try {
      setDashboard(await fetchAdminDashboard());
      setLoadStatus("ready");
    } catch (cause) {
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  const { businessDate, metrics, pending } = dashboard;
  const todayOrdersHref = ADMIN_DASHBOARD_TODAY_ORDERS_HREF(businessDate);

  /**
   * 三张经营卡。
   *
   * ⚠️ 今日订单与今日 GMV 指向**同一个**列表（按同一天筛选的订单列表）：
   * GMV 的明细就是那一天的订单，列表里逐单显示了实付金额。给 GMV 单独编一个
   * 「金额明细页」反而会造出一个不存在于本项目里的页面。
   */
  const todayCards = [
    {
      key: "todayOrderCount",
      label: ADMIN_DASHBOARD_METRIC_LABELS.todayOrderCount,
      value: String(metrics.todayOrderCount),
      unit: "单",
      href: todayOrdersHref,
      hint: ADMIN_DASHBOARD_METRIC_HINTS.todayOrderCount,
    },
    {
      key: "todayGmvAmount",
      label: ADMIN_DASHBOARD_METRIC_LABELS.todayGmvAmount,
      value: `¥ ${formatYuan(metrics.todayGmvAmount)}`,
      unit: "",
      href: todayOrdersHref,
      hint: ADMIN_DASHBOARD_METRIC_HINTS.todayGmvAmount,
    },
    {
      key: "todayRefundAmount",
      label: ADMIN_DASHBOARD_METRIC_LABELS.todayRefundAmount,
      value: `¥ ${formatYuan(metrics.todayRefundAmount)}`,
      unit: "",
      href: ADMIN_DASHBOARD_REFUNDS_HREF,
      hint: ADMIN_DASHBOARD_METRIC_HINTS.todayRefundAmount,
    },
  ];

  /**
   * 三张待办卡。
   *
   * ⚠️ **0 条照常显示 `0`**，不隐藏卡片：一张消失的卡片与一个为 0 的卡片
   * 传达的是两件事——前者让人以为「这一项没有」，后者才是「现在没有需要处理的」。
   */
  const pendingCards = [
    {
      key: "applications",
      label: ADMIN_DASHBOARD_PENDING_LABELS.applications,
      value: pending.applications,
      href: ADMIN_DASHBOARD_PENDING_HREFS.applications,
      hint: ADMIN_DASHBOARD_PENDING_HINTS.applications,
    },
    {
      key: "refunds",
      label: ADMIN_DASHBOARD_PENDING_LABELS.refunds,
      value: pending.refunds,
      href: ADMIN_DASHBOARD_PENDING_HREFS.refunds,
      hint: ADMIN_DASHBOARD_PENDING_HINTS.refunds,
    },
    {
      key: "complaints",
      label: ADMIN_DASHBOARD_PENDING_LABELS.complaints,
      value: pending.complaints,
      href: ADMIN_DASHBOARD_PENDING_HREFS.complaints,
      hint: ADMIN_DASHBOARD_PENDING_HINTS.complaints,
    },
  ];

  const todayAllZero =
    metrics.todayOrderCount === 0 &&
    metrics.todayGmvAmount === 0 &&
    metrics.todayRefundAmount === 0;
  const pendingAllZero =
    pending.applications === 0 && pending.refunds === 0 && pending.complaints === 0;

  return (
    <div className="flex flex-col gap-5">
      {/* ————— 今日经营 ————— */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[16px] font-semibold text-ink">{ADMIN_DASHBOARD_TODAY_TITLE}</h2>
          <p className="text-[12px] text-ink-3">
            业务日 {businessDate}（北京时间）
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loadStatus === "loading"}
            className="ml-auto h-8 rounded-lg border border-admin-line px-3 text-[12px] text-ink-2 hover:bg-page disabled:opacity-60"
          >
            {loadStatus === "loading" ? "刷新中…" : "刷新数据"}
          </button>
        </div>

        {/* 两条口径说明分两段：订单/GMV 一条，退款一条。合并成一段会让人以为
            「退款不倒扣」与「退款按发生日归属」是同一句话的两个说法 */}
        <p className="text-[12px] leading-5 text-ink-3">{ADMIN_DASHBOARD_TODAY_NOTICE}</p>
        <p className="text-[12px] leading-5 text-ink-3">{ADMIN_DASHBOARD_REFUND_NOTICE}</p>

        {/* 状态行：加载 / 失败都在这里说，数字区域各自渲染 */}
        <p
          role="status"
          aria-live="polite"
          className="min-h-[18px] text-[12px] leading-[18px] text-ink-3"
        >
          {loadStatus === "loading" ? "加载中…" : ""}
        </p>

        {loadStatus === "error" ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
            <p role="alert" className="text-[13px] leading-5 text-brand-red">
              {error}
            </p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
            >
              重试
            </button>
          </div>
        ) : null}

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {todayCards.map((card) => (
            <li key={card.key}>
              <Link
                href={card.href}
                className="flex h-full flex-col gap-2 rounded-xl border border-admin-line bg-surface p-4 transition-colors hover:border-admin-accent"
              >
                <span className="text-[13px] text-ink-3">{card.label}</span>
                <span className="text-[28px] font-semibold leading-none tabular-nums text-ink">
                  {card.value}
                  {card.unit ? <span className="ml-1 text-[14px] text-ink-3">{card.unit}</span> : null}
                </span>
                <span className="text-[12px] leading-4 text-ink-3">{card.hint}</span>
              </Link>
            </li>
          ))}
        </ul>

        {todayAllZero ? (
          <p className="rounded-xl border border-admin-line bg-surface px-4 py-3 text-[13px] text-ink-3">
            今天还没有成交记录。这可能是正常的——本地 Mock 数据重启会回到预置数据，
            预置订单也未必落在今天；「今天为 0」不是页面故障。
          </p>
        ) : null}
      </section>

      {/* ————— 当前待办 ————— */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[16px] font-semibold text-ink">{ADMIN_DASHBOARD_PENDING_TITLE}</h2>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pendingCards.map((card) => (
            <li key={card.key}>
              <Link
                href={card.href}
                className="flex h-full flex-col gap-2 rounded-xl border border-admin-line bg-surface p-4 transition-colors hover:border-admin-accent"
              >
                <span className="text-[13px] text-ink-3">{card.label}</span>
                <span className="text-[28px] font-semibold leading-none tabular-nums text-ink">
                  {card.value}
                  <span className="ml-1 text-[14px] text-ink-3">条</span>
                </span>
                <span className="text-[12px] leading-4 text-ink-3">{card.hint}</span>
              </Link>
            </li>
          ))}
        </ul>

        {pendingAllZero ? (
          <p className="rounded-xl border border-admin-line bg-surface px-4 py-3 text-[13px] text-ink-3">
            当前没有需要管理员处理的申请、退款或投诉。
          </p>
        ) : null}
      </section>
    </div>
  );
}
