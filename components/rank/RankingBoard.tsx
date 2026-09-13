"use client";

/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */

import { useEffect, useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  RANKING_LEVEL_PLACEHOLDER,
  RANKING_LIST_TITLE,
  RANKING_ME_TITLE,
  RANKING_PAGE_SIZE,
  RANKING_TOP_COUNT,
  formatRankNumber,
  mergeRankingPage,
} from "@/lib/constants/rankings";
import {
  RANKING_PERIOD_TABS,
  formatRankingRangeLabel,
  rankingEmptyDescription,
  rankingEmptyTitle,
  rankingMeEmptyMessage,
  rankingPeriodLabel,
  readRankingPeriod,
  shouldApplyRankingResponse,
  withRankingPeriod,
  type RankingPeriod,
  type RankingRequest,
} from "@/lib/constants/rankingPeriods";
import { fetchConsumptionRanking } from "@/lib/services/rankingsHttp";
import type { ConsumptionRankingPage, RankingEntry } from "@/lib/types/ranking";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

type ListStatus = "ready" | "loading" | "error";
type MoreStatus = "idle" | "loading" | "error";

/**
 * 消费排行榜。
 *
 * 首屏由 Server Component 取好传进来（不在挂载时再请求一次，首屏没有加载闪烁），
 * 之后切周期与「加载更多」会发请求。翻页用**追加**而不是替换：榜单是排名，
 * 用户往下看时不应该把前面的名次抽走；**切周期则是整体替换**（见下）。
 *
 * 五条不能越过的线：
 *
 * 1. **聚合与排序全在服务端**。本组件只画，不排序、不算金额、不重新编号名次，
 *    也不做周期过滤——名次由服务端按订单算好，客户端连订单都拿不到；
 * 2. **每个周期都是一次真实的重新取数**。切页签 = 换 `period` 重新请求，
 *    不是把已经拿到的那一页换个标题，更不是从累计榜里挑几条出来；
 * 3. **切周期后不留上一个周期的条目**。切换时列表整体进入加载态，
 *    旧数据不再显示，「我的排名」同样只在数据与当前页签一致时才渲染；
 * 4. **游客不做登录拦截**。未登录时不显示「我的排名」区域，也不提示登录：
 *    排行榜是公开内容，看榜不该被迫登录；
 * 5. **等级名为空时不编一个**。等级配置不可用时服务端给空串，这里显示「等级待配置」。
 *
 * 列表的 React key 用**名次**：公开 DTO 里刻意没有 id（见 `lib/types/ranking.ts`），
 * 同一份榜单内名次唯一，足够稳定。
 *
 * 竞态：快速连点页签时先发的请求可能后到。判定逻辑抽成了纯函数
 * `shouldApplyRankingResponse`（序号 + 周期都要对得上），并单独做了单元测试——
 * 组件里只负责把「最新一次请求的身份」放在 ref 里，不把判定写成内联条件。
 */
export default function RankingBoard({
  initialResult,
}: {
  initialResult: ConsumptionRankingPage;
}) {
  const [result, setResult] = useState<ConsumptionRankingPage>(initialResult);
  /** 当前选中的周期。页签的高亮以它为准，不以响应为准（切换要立即生效） */
  const [period, setPeriod] = useState<RankingPeriod>(initialResult.period);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  /** 最新一次请求的身份。异步回调里读 state 会读到旧值，因此判定用 ref */
  const requestRef = useRef<RankingRequest>({ id: 0, period: initialResult.period });
  const periodRef = useRef<RankingPeriod>(initialResult.period);
  /** 已加载到第几页（当前周期） */
  const pageRef = useRef(initialResult.page);
  // 同步闸门：state 更新是异步的，连点两次「加载更多」可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  /**
   * 地址栏规范化：`?period=lastWeek` 这类非法值改写成默认周期。
   *
   * 只处理**写了但非法**的情况。没写 `period` 时不动地址（服务端已经按默认周期渲染，
   * 硬写一个 `?period=week` 出来只会让「打开 /rank」这件事多出一次地址变动）。
   * 其余查询参数（调试参数、分页）原样保留。
   */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("period");
    if (raw !== null && readRankingPeriod(raw) === null) {
      replaceAddress(periodRef.current);
    }
  }, []);

  /** 只改地址，不产生导航：`period` 是纯展示状态，数据由下面的请求决定。 */
  function replaceAddress(next: RankingPeriod) {
    const { pathname, search } = window.location;
    const target = `${pathname}${withRankingPeriod(search, next)}`;
    if (target !== `${pathname}${search}`) {
      window.history.replaceState(null, "", target);
    }
  }

  async function load(mode: "replace" | "append") {
    const targetPeriod = periodRef.current;
    const targetPage = mode === "append" ? pageRef.current + 1 : 1;
    // 序号自增：任何比它旧的请求回来时都会被判定为过期
    const request: RankingRequest = { id: requestRef.current.id + 1, period: targetPeriod };
    requestRef.current = request;

    if (mode === "replace") {
      // 切周期：整体进入加载态，上一个周期的条目一条都不留在屏幕上
      setListStatus("loading");
      setListError("");
      setMoreStatus("idle");
      setMoreError("");
      moreLoadingRef.current = false;
    } else {
      setMoreStatus("loading");
      setMoreError("");
      moreLoadingRef.current = true;
    }

    try {
      const next = await fetchConsumptionRanking({
        period: targetPeriod,
        page: targetPage,
        pageSize: RANKING_PAGE_SIZE,
      });

      // 先发后到的旧响应不能覆盖新结果：序号要最新，周期也要仍是当前选中项。
      // 周期以**服务端回包里的**为准：它才是这份数据真正对应的周期。
      if (
        !shouldApplyRankingResponse({ id: request.id, period: next.period }, requestRef.current)
      ) {
        return;
      }

      if (mode === "append") {
        setResult((current) => mergeRankingPage(current, next));
        pageRef.current = targetPage;
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setResult(next);
        pageRef.current = next.page;
        setListStatus("ready");
      }
    } catch (cause) {
      if (!shouldApplyRankingResponse(request, requestRef.current)) return;

      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已加载的名次，只在末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  function switchPeriod(next: RankingPeriod) {
    if (next === periodRef.current) return;

    periodRef.current = next;
    setPeriod(next);
    replaceAddress(next);
    void load("replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load("append");
  }

  const items = result.items;
  const top = items.slice(0, RANKING_TOP_COUNT);
  const rest = items.slice(RANKING_TOP_COUNT);

  /**
   * 画出来的数据必须**就是当前页签那一个周期**的。
   *
   * 只判 `listStatus` 不够保险：状态与数据一旦不同步（例如切换后响应还没回来），
   * 屏幕上的金额会属于上一个周期。因此两个条件一起用，`me` 与列表共用这一个判定。
   */
  const boardMatchesPeriod = listStatus === "ready" && result.period === period;

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 周期页签：六档都可用，点了就按那个周期重新取数 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="榜单周期">
          {RANKING_PERIOD_TABS.map((tab) => {
            const active = tab.key === period;
            return (
              <button
                key={tab.key}
                type="button"
                // 选中态**不只是颜色**：权重加粗 + 下划线 + `aria-pressed`，
                // 色觉障碍用户与读屏用户都能判断当前是哪一个周期
                aria-pressed={active}
                onClick={() => switchPeriod(tab.key)}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] leading-5 ${
                  active
                    ? "seg-tab-active font-semibold underline decoration-2 underline-offset-4"
                    : "bg-page text-ink-3"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* 统计范围写出来：既解释「这一榜算了哪一段时间」，也让周期边界可核对 */}
        <p className="mt-2 text-[12px] leading-5 text-ink-3">
          {`统计范围：${formatRankingRangeLabel({
            start: result.rangeStart === null ? null : Date.parse(result.rangeStart),
            end: Date.parse(result.rangeEnd),
          })}（北京时间）`}
        </p>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <p className="text-[12px] leading-4 text-ink-3">{result.notice}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">{`加载${rankingPeriodLabel(period)}榜单…`}</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() => void load("replace")}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {boardMatchesPeriod ? (
            items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                {/* 空态文案带周期语义：是「这个周期没有」，不是「榜单坏了」 */}
                <EmptyState
                  title={rankingEmptyTitle(result.period)}
                  description={rankingEmptyDescription(result.period)}
                />
              </div>
            ) : (
              <>
                {top.length > 0 ? <Podium entries={top} /> : null}

                {rest.length > 0 ? (
                  <section className="mt-4">
                    <h2 className="text-[13px] font-semibold text-ink">{RANKING_LIST_TITLE}</h2>
                    <ul className="mt-2 flex flex-col gap-2">
                      {rest.map((entry) => (
                        <li key={entry.rank}>
                          <RankRow entry={entry} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <div className="mt-3">
                  {result.hasMore ? (
                    <button
                      type="button"
                      disabled={moreStatus === "loading"}
                      onClick={loadMore}
                      className="w-full rounded-full border border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
                    >
                      {moreStatus === "loading" ? "加载中…" : "加载更多"}
                    </button>
                  ) : (
                    <p className="text-center text-[12px] text-ink-3">
                      {`${result.periodLabel}共 ${result.total} 位用户上榜`}
                    </p>
                  )}

                  {moreStatus === "error" ? (
                    <div className="mt-2 flex flex-col items-center gap-2">
                      <p className="text-center text-[12px] leading-5 text-ink-3">{moreError}</p>
                      <button
                        type="button"
                        onClick={loadMore}
                        className="text-[12px] text-brand-blue underline"
                      >
                        重试
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            )
          ) : null}
        </div>

        {/* 游客看不到这一块，也**不会**被要求登录；登录了但当前周期没上榜则如实说明原因 */}
        {boardMatchesPeriod && result.viewerLoggedIn ? (
          <section className="mt-4">
            <h2 className="text-[13px] font-semibold text-ink">{RANKING_ME_TITLE}</h2>
            {result.me ? (
              <ul className="mt-2">
                <li>
                  <RankRow entry={result.me} highlight />
                </li>
              </ul>
            ) : (
              <p className="mt-2 rounded-[10px] border border-line bg-surface px-3 py-3 text-[12px] leading-5 text-ink-3">
                {rankingMeEmptyMessage(result.period)}
              </p>
            )}
          </section>
        ) : null}

        {boardMatchesPeriod ? (
          <p className="mt-4 text-center text-[11px] leading-4 text-ink-3">
            {`更新于 ${formatDateTime(result.generatedAt)}`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 前三名：中间为第一名并抬高，两侧依次为二、三名。 */
function Podium({ entries }: { entries: readonly RankingEntry[] }) {
  // 1 / 2 / 3 名的展示次序是「2 - 1 - 3」，让第一名落在视觉中心
  const order = [1, 0, 2].filter((index) => index < entries.length);

  return (
    <section className="flex items-end justify-center gap-2">
      {order.map((index) => {
        const entry = entries[index];
        const first = index === 0;
        return (
          <div
            key={entry.rank}
            className={`flex flex-1 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface px-2 ${
              first ? "pb-4 pt-5" : "pb-3 pt-4"
            }`}
          >
            <span className={first ? "text-[16px]" : "text-[13px]"} aria-hidden>
              {MEDALS[index]}
            </span>
            <img
              src={entry.avatarUrl}
              alt=""
              className={`shrink-0 rounded-full border border-line object-cover ${
                first ? "h-14 w-14" : "h-11 w-11"
              }`}
            />
            <p className="w-full truncate text-center text-[13px] font-medium text-ink">
              {entry.nickname}
            </p>
            <p className="w-full truncate text-center text-[11px] text-ink-3">
              {entry.levelName || RANKING_LEVEL_PLACEHOLDER}
            </p>
            <p className="text-[14px] font-semibold text-ink">
              {`¥${formatYuan(entry.effectiveSpendAmount)}`}
            </p>
            {/* 名次同时用文字写出：奖牌图形只是装饰，不承担名次信息 */}
            <p className="text-[11px] text-ink-3">{formatRankNumber(entry.rank)}</p>
          </div>
        );
      })}
    </section>
  );
}

/** 名次徽标用文字而不是纯颜色：颜色单独出现时读不出「第几名」。 */
const MEDALS = ["🥇", "🥈", "🥉"];

/** 普通榜单行。 */
function RankRow({ entry, highlight = false }: { entry: RankingEntry; highlight?: boolean }) {
  return (
    <article
      className={`flex items-center gap-3 rounded-[10px] border bg-surface px-3 py-2 ${
        highlight ? "border-mine-grid-icon" : "border-line"
      }`}
    >
      <span className="w-9 shrink-0 text-[13px] font-medium text-ink-2">
        {formatRankNumber(entry.rank)}
      </span>
      <img
        src={entry.avatarUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-line object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-ink">{entry.nickname}</p>
        <p className="truncate text-[11px] leading-4 text-ink-3">
          {entry.levelName || RANKING_LEVEL_PLACEHOLDER}
        </p>
      </div>
      <p className="shrink-0 text-[14px] font-semibold text-ink">
        {`¥${formatYuan(entry.effectiveSpendAmount)}`}
      </p>
    </article>
  );
}
