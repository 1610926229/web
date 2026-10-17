"use client";

/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import RankBoardSwitch from "@/components/rank/RankBoardSwitch";
import {
  COMPANION_RANKING_BOARDS,
  COMPANION_RANKING_LIST_TITLE,
  COMPANION_RANKING_PAGE_SIZE,
  COMPANION_RANKING_TOP_COUNT,
  companionRankingBoardLabel,
  companionRankingEmptyDescription,
  companionRankingEmptyTitle,
  companionRankingNotice,
  formatCompanionMedal,
  formatCompanionRankNumber,
  mergeCompanionRankingPage,
  shouldApplyCompanionRankingResponse,
  withCompanionRankingBoard,
  type CompanionRankingRequest,
} from "@/lib/constants/companionRankings";
import {
  RANKING_PERIOD_TABS,
  formatRankingRangeLabel,
  readRankingPeriod,
  withRankingPeriod,
  type RankingPeriod,
} from "@/lib/constants/rankingPeriods";
import { fetchCompanionRanking } from "@/lib/services/companionRankingsHttp";
import type { CompanionRankingBoard as Board, CompanionRankingPage, CompanionRankingEntry } from "@/lib/types/companionRanking";
import { formatDateTime } from "@/lib/utils/format";

type ListStatus = "ready" | "loading" | "error";
type MoreStatus = "idle" | "loading" | "error";

/**
 * 打手排行榜（P1-5）。
 *
 * 首屏由 Server Component 取好传进来（不在挂载时再请求一次，首屏没有加载闪烁），
 * 之后切榜 / 切周期与「加载更多」会发请求。翻页用**追加**而不是替换：
 * 榜单是排名，用户往下看时不应该把前面的名次抽走；**切榜与切周期则是整体替换**。
 *
 * ## 六条不能越过的线
 *
 * 1. **聚合、排序、名次与分页全在服务端**。本组件只画，不排序、不算金额、
 *    不重新编号名次，也不做周期过滤——名次由服务端按数据算好，客户端连订单都拿不到；
 * 2. **每个榜、每个周期都是一次真实的重新取数**。切页签 = 换参数重新请求，
 *    不是把已经拿到的那一页换个标题，更不是从累计榜里挑几条出来；
 * 3. **切换后不留上一个榜 / 周期的条目**。切换时列表整体进入加载态，
 *    旧数据不再显示；
 * 4. **没有「我的排名」**（产品裁定 §10：第一版不做）。因此这里**不读会话、
 *    不判断登录**，也就没有「游客看不到哪一块」这种分支——
 *    排行榜对所有人是同一份内容；
 * 5. **名次并列时 `key` 不能用名次**。裁定 §6 要求同指标值并列同名次
 *    （`100/80/80/50` ⇒ `1/2/2/4`），因此 `rank` 在同一页里**可能重复**，
 *    拿它做 React key 会让 React 把两条记录当成同一条。key 用 `companionId`
 *    （榜单内唯一，见 `mergeCompanionRankingPage` 的同一条理由）；
 * 6. **只展示 DTO 里的六项**。`metricLabel` 是服务端格式化好的展示值——
 *    本组件**不自己拼金额**，否则「服务端算好的口径」与「前端又算一遍」迟早分叉。
 *
 * ## 竞态
 *
 * 快速连点页签时先发的请求可能后到。判定逻辑抽成了纯函数
 * `shouldApplyCompanionRankingResponse`（序号 + 榜 + 周期三者都要对得上），
 * 并单独做了单元测试——组件里只负责把「最新一次请求的身份」放在 ref 里。
 */
export default function CompanionRankingBoard({
  initialResult,
}: {
  initialResult: CompanionRankingPage;
}) {
  const [result, setResult] = useState<CompanionRankingPage>(initialResult);
  /** 当前选中的榜。页签的高亮以它为准，不以响应为准（切换要立即生效） */
  const [board, setBoard] = useState<Board>(initialResult.board);
  /** 当前选中的周期。同上 */
  const [period, setPeriod] = useState<RankingPeriod>(initialResult.period);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  /** 最新一次请求的身份。异步回调里读 state 会读到旧值，因此判定用 ref */
  const requestRef = useRef<CompanionRankingRequest>({
    id: 0,
    board: initialResult.board,
    period: initialResult.period,
  });
  const boardRef = useRef<Board>(initialResult.board);
  const periodRef = useRef<RankingPeriod>(initialResult.period);
  /** 已加载到第几页（当前榜 + 周期） */
  const pageRef = useRef(initialResult.page);
  // 同步闸门：state 更新是异步的，连点两次「加载更多」可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  /**
   * 地址栏规范化：`?board=revenue` / `?period=lastWeek` 这类非法值改写成默认值。
   *
   * 只处理**写了但非法**的情况。没写时不动地址：服务端已经按默认值渲染，
   * 硬写一个 `?board=dispatch&period=week` 出来只会让「打开这一页」多出一次地址变动。
   * 其余查询参数（调试参数、分页）原样保留。
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawBoard = params.get("board");
    const rawPeriod = params.get("period");
    const boardIllegal = rawBoard !== null && rawBoard !== boardRef.current;
    const periodIllegal = rawPeriod !== null && readRankingPeriod(rawPeriod) === null;

    if (boardIllegal || periodIllegal) {
      replaceAddress(boardRef.current, periodRef.current);
    }
  }, []);

  /** 只改地址，不产生导航：榜与周期是纯展示状态，数据由下面的请求决定。 */
  function replaceAddress(nextBoard: Board, nextPeriod: RankingPeriod) {
    const { pathname, search } = window.location;
    const withPeriod = withRankingPeriod(search, nextPeriod);
    const target = `${pathname}${withCompanionRankingBoard(withPeriod, nextBoard)}`;
    if (target !== `${pathname}${search}`) {
      window.history.replaceState(null, "", target);
    }
  }

  async function load(mode: "replace" | "append") {
    const targetBoard = boardRef.current;
    const targetPeriod = periodRef.current;
    const targetPage = mode === "append" ? pageRef.current + 1 : 1;
    // 序号自增：任何比它旧的请求回来时都会被判定为过期
    const request: CompanionRankingRequest = {
      id: requestRef.current.id + 1,
      board: targetBoard,
      period: targetPeriod,
    };
    requestRef.current = request;

    if (mode === "replace") {
      // 切榜 / 切周期：整体进入加载态，上一个榜 / 周期的条目一条都不留在屏幕上
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
      const next = await fetchCompanionRanking({
        board: targetBoard,
        period: targetPeriod,
        page: targetPage,
        pageSize: COMPANION_RANKING_PAGE_SIZE,
      });

      // 先发后到的旧响应不能覆盖新结果：序号要最新，榜与周期也要仍是当前选中项。
      // 三者以**服务端回包里的**为准：它才是这份数据真正对应的榜与周期。
      if (
        !shouldApplyCompanionRankingResponse(
          { id: request.id, board: next.board, period: next.period },
          requestRef.current,
        )
      ) {
        return;
      }

      if (mode === "append") {
        setResult((current) => mergeCompanionRankingPage(current, next));
        pageRef.current = targetPage;
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setResult(next);
        pageRef.current = next.page;
        setListStatus("ready");
      }
    } catch (cause) {
      if (!shouldApplyCompanionRankingResponse(request, requestRef.current)) return;

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

  function switchBoard(next: Board) {
    if (next === boardRef.current) return;

    boardRef.current = next;
    setBoard(next);
    replaceAddress(next, periodRef.current);
    void load("replace");
  }

  function switchPeriod(next: RankingPeriod) {
    if (next === periodRef.current) return;

    periodRef.current = next;
    setPeriod(next);
    replaceAddress(boardRef.current, next);
    void load("replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load("append");
  }

  const items = result.items;
  const top = items.slice(0, COMPANION_RANKING_TOP_COUNT);
  const rest = items.slice(COMPANION_RANKING_TOP_COUNT);

  /**
   * 画出来的数据必须**就是当前页签那一个榜、那一个周期**的。
   *
   * 只判 `listStatus` 不够保险：状态与数据一旦不同步（例如切换后响应还没回来），
   * 屏幕上的指标会属于上一个榜。因此三个条件一起用。
   */
  const boardMatches = listStatus === "ready" && result.board === board && result.period === period;

  /**
   * 口径说明：切榜那一瞬间 `result` **还是上一张榜的响应**，
   * 直接用 `result.notice` 会写出「接单榜…」而此刻选中的是完成榜——
   * 与加载提示说错榜名是同一类错误（只是它没有 loading 态兜着，会一直错到新响应回来）。
   *
   * ⚠️ 兜底**不是**另写一句文案，而是调用**同一个纯函数** `companionRankingNotice(board)`：
   * 服务端响应里那一句本来就是它的输出，两边不可能出现两份口径。
   */
  const noticeText = result.board === board ? result.notice : companionRankingNotice(board);

  /**
   * 统计范围：它同时依赖榜**与周期**，因此闸门用完整的 `boardMatches`。
   * 不匹配时**不显示上一张榜 / 上一个周期的区间**——那是一个看起来精确、
   * 实际上属于别人的数字，比空着更容易让人据此判断「这一榜算的是哪一段时间」。
   * 加载中与失败分开说：失败时那句「正在重新统计」会变成一句永远不会兑现的承诺。
   */
  const rangeText = boardMatches
    ? `统计范围：${formatRankingRangeLabel({
        start: result.rangeStart === null ? null : Date.parse(result.rangeStart),
        end: Date.parse(result.rangeEnd),
      })}（北京时间）`
    : listStatus === "error"
      ? "统计范围：暂不可用"
      : "统计范围：正在按当前周期重新统计…";

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 榜页签：消费榜 / 打手榜是**两个地址**，切换是一次跳转（见 RankBoardSwitch 的说明） */}
      <div className="shrink-0 bg-surface pt-2">
        <RankBoardSwitch active="companion" />
      </div>

      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 pb-2">
        {/* 三张榜：接单 / 完成 / 收入。切榜 = 换 `board` 重新取数 */}
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="榜单种类">
          {COMPANION_RANKING_BOARDS.map((tab) => {
            const active = tab.key === board;
            return (
              <button
                key={tab.key}
                type="button"
                // 选中态**不只是颜色**：权重加粗 + 下划线 + `aria-pressed`
                aria-pressed={active}
                onClick={() => switchBoard(tab.key)}
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

        {/* 周期页签：六档都可用，点了就按那个周期重新取数 */}
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="榜单周期">
          {RANKING_PERIOD_TABS.map((tab) => {
            const active = tab.key === period;
            return (
              <button
                key={tab.key}
                type="button"
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
        <p className="mt-2 text-[12px] leading-5 text-ink-3">{rangeText}</p>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <p className="text-[12px] leading-4 text-ink-3">{noticeText}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            // ⚠️ 榜名取**当前选中的**那一张，不取 `result.boardLabel`：
            // 切榜时 `result` 还是上一张榜的响应，用它的名字会写出
            // 「加载接单榜…」而此刻正在加载的是完成榜——加载提示说错榜名，
            // 比没有提示更容易让人以为点错了。
            <p className="py-10 text-center text-[13px] text-ink-3">{`加载${companionRankingBoardLabel(board)}…`}</p>
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

          {boardMatches ? (
            items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                {/* 空态文案带榜名与周期语义：是「这张榜这个周期没有」，不是「榜单坏了」 */}
                <EmptyState
                  title={companionRankingEmptyTitle(result.board, result.periodLabel)}
                  description={companionRankingEmptyDescription(result.board)}
                />
              </div>
            ) : (
              <>
                {top.length > 0 ? <Podium entries={top} /> : null}

                {rest.length > 0 ? (
                  <section className="mt-4">
                    <h2 className="text-[13px] font-semibold text-ink">
                      {COMPANION_RANKING_LIST_TITLE}
                    </h2>
                    <ul className="mt-2 flex flex-col gap-2">
                      {rest.map((entry) => (
                        <li key={entry.companionId}>
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
                      {`${result.periodLabel}共 ${result.total} 位打手上榜`}
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

        {boardMatches ? (
          <p className="mt-4 text-center text-[11px] leading-4 text-ink-3">
            {`更新于 ${formatDateTime(result.generatedAt)}`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 前三名：中间为第一名并抬高，两侧依次为二、三名。
 *
 * ⚠️ 名次可能并列（`1/1/3`），因此这里**不假设** `entries[0].rank === 1`：
 * 展示次序只按**数组次序**（数组已经是服务端排好的），名次数字照原样显示。
 * 拿名次反推位置，会在并列时把两个人的位置画错。
 *
 * ⚠️ 反过来也成立：**奖牌按 `entry.rank` 取，不按 `index` 取**（`formatCompanionMedal`）。
 * `index` 只决定画在左中右哪一格，不决定发什么牌。
 */
function Podium({ entries }: { entries: readonly CompanionRankingEntry[] }) {
  // 1 / 2 / 3 名的展示次序是「2 - 1 - 3」，让第一名落在视觉中心
  const order = [1, 0, 2].filter((index) => index < entries.length);

  return (
    <section className="flex items-end justify-center gap-2">
      {order.map((index) => {
        const entry = entries[index];
        const first = index === 0;
        return (
          <div
            key={entry.companionId}
            className={`flex flex-1 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface px-2 ${
              first ? "pb-4 pt-5" : "pb-3 pt-4"
            }`}
          >
            <span className={first ? "text-[16px]" : "text-[13px]"} aria-hidden>
              {formatCompanionMedal(entry.rank)}
            </span>
            <img
              src={entry.avatarUrl}
              alt=""
              className={`shrink-0 rounded-full border border-line object-cover ${
                first ? "h-14 w-14" : "h-11 w-11"
              }`}
            />
            {/* 头像与昵称都可以点进打手公开详情：`companionId` 是公开信息
                （`/companions/[id]` 游客可达），裁定 §9 允许它出现在 DTO 上 */}
            <Link
              href={`/companions/${entry.companionId}`}
              className="w-full truncate text-center text-[13px] font-medium text-ink"
            >
              {entry.nickname}
            </Link>
            <p className="text-[14px] font-semibold text-ink">{entry.metricLabel}</p>
            {/* 名次同时用文字写出：奖牌图形只是装饰，不承担名次信息 */}
            <p className="text-[11px] text-ink-3">{formatCompanionRankNumber(entry.rank)}</p>
          </div>
        );
      })}
    </section>
  );
}

/**
 * 普通榜单行。
 *
 * ⚠️ 这里**没有等级、没有金额换算、没有任何「我的」标记**：
 * - 等级：裁定 §11 明写本轮**不显示等级字段**；
 * - 「我的」标记：裁定 §10 第一版不做「我的排名」。
 *
 * 想加其中任何一个，都要先回答「这算不算把两个榜又合成了一个」。
 */
function RankRow({ entry }: { entry: CompanionRankingEntry }) {
  return (
    <article className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2">
      <span className="w-9 shrink-0 text-[13px] font-medium text-ink-2">
        {formatCompanionRankNumber(entry.rank)}
      </span>
      <img
        src={entry.avatarUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-line object-cover"
      />
      <div className="min-w-0 flex-1">
        <Link
          href={`/companions/${entry.companionId}`}
          className="block truncate text-[14px] font-medium text-ink"
        >
          {entry.nickname}
        </Link>
      </div>
      <p className="shrink-0 text-[14px] font-semibold text-ink">{entry.metricLabel}</p>
    </article>
  );
}
