"use client";

import { useEffect, useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPANION_AVAILABILITY_LABELS,
  COMPANION_AVAILABILITY_VALUES,
  COMPANION_MOCK_NOTICE,
  COMPANION_PAGE_SIZE,
  type CompanionAvailability,
} from "@/lib/constants/companions";
// 「加载更多」的合并与按 id 去重由分页模块统一提供，列表自己不再拼数组
import { mergePageResult } from "@/lib/constants/pagination";
import { fetchCompanions } from "@/lib/services/companionsHttp";
import type { CompanionGameTag, CompanionPage } from "@/lib/types/companion";
import CompanionCard from "./CompanionCard";

/** 列表区域的三种状态：加载与错误只替换列表，筛选栏不会跟着消失。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的卡片清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 陪玩列表（搜索 + 游戏筛选 + 可用状态筛选 + 加载更多）。
 *
 * 四条与订单 / 商品 / 反馈列表一致的做法：
 *
 * 1. **首屏由 Server Component 取好后传进来**，本组件不在挂载时再请求一次，
 *    因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 * 2. **搜索用「搜索按钮 / 回车」触发**，不是每敲一个字就请求：请求次数可预期，
 *    也不会出现「刚敲第一个字就闪一下空结果」。
 * 3. **每次取数领一个自增序号**，回来时序号不是最新的就丢弃：筛选切得快时，
 *    先发后到的旧响应不会覆盖新结果。
 * 4. **筛选变化一律回到第 1 页**。不回到第一页的话，用户在第 5 页把「全部游戏」改成
 *    某个游戏，很可能直接看到一个空列表——而那个游戏其实是有陪玩的。
 *
 * 筛选条件会同步到地址栏（`history.replaceState`，不新建历史记录）：
 * 这样「没搜到」时刷新一下不会丢掉自己选的条件，地址也能直接发给别人。
 */
export default function CompanionBrowser({
  initialPage,
  games,
  initialKeyword,
  initialGameId,
  initialAvailability,
}: {
  initialPage: CompanionPage;
  /** 游戏筛选项：来自服务端的真实游戏数据，前端不维护第二份列表 */
  games: CompanionGameTag[];
  initialKeyword: string;
  initialGameId: string;
  initialAvailability: CompanionAvailability;
}) {
  const [keyword, setKeyword] = useState(initialKeyword);
  /** 已经点过搜索 / 回车的那个关键词。输入框里正在敲的字不算条件 */
  const [appliedKeyword, setAppliedKeyword] = useState(initialKeyword);
  const [gameId, setGameId] = useState(initialGameId);
  const [availability, setAvailability] = useState<CompanionAvailability>(initialAvailability);

  const [current, setCurrent] = useState<CompanionPage>(initialPage);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  // 请求序号：筛选切得快时，先发的请求可能后返回，只认最后一次的结果
  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  /**
   * 挂载时把地址栏对齐到**服务端实际用的筛选条件**一次。
   *
   * `?gameId=不存在的游戏` 这类非法值由页面侧规范化成默认值（接口侧仍然是 400 的严格契约），
   * 服务端按规范化后的条件取数，地址栏里却还留着那个坏值——两者不一致时，
   * 刷新一下用户会以为「我还在筛那个游戏」。这里只在真的不一致时改写一次，
   * 依赖项全是服务端渲染时给定的初始值，生命周期内不会变，因此不会反复触发。
   */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search);
    const sameAvailability = (raw.get("availability") ?? "all") === initialAvailability;
    const sameGameId = (raw.get("gameId") ?? "") === initialGameId;
    if (sameAvailability && sameGameId) return;

    replaceListAddress(
      { keyword: initialKeyword, gameId: initialGameId, availability: initialAvailability },
      initialPage.page,
    );
  }, [initialKeyword, initialGameId, initialAvailability, initialPage.page]);

  async function load(
    next: { keyword: string; gameId: string; availability: CompanionAvailability },
    page: number,
    mode: "replace" | "append",
  ) {
    const ticket = ++ticketRef.current;

    if (mode === "replace") {
      setListStatus("loading");
      setListError("");
      setMoreStatus("idle");
      moreLoadingRef.current = false;
    } else {
      setMoreStatus("loading");
      setMoreError("");
      moreLoadingRef.current = true;
    }

    try {
      const result = await fetchCompanions({
        keyword: next.keyword,
        gameId: next.gameId,
        availability: next.availability,
        page,
        pageSize: COMPANION_PAGE_SIZE,
      });
      // 不是最新一次请求的结果就丢弃：晚到的旧响应不能覆盖新筛选的列表
      if (ticket !== ticketRef.current) return;

      setCurrent((previous) => (mode === "append" ? mergePageResult(previous, result) : result));

      if (mode === "append") {
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setListStatus("ready");
        replaceListAddress(next, page);
      }
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已经加载出来的卡片，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  /** 任何筛选变化都回到第 1 页。 */
  function applyFilter(next: {
    keyword?: string;
    gameId?: string;
    availability?: CompanionAvailability;
  }) {
    const merged = {
      keyword: next.keyword ?? appliedKeyword,
      gameId: next.gameId ?? gameId,
      availability: next.availability ?? availability,
    };

    setAppliedKeyword(merged.keyword);
    setGameId(merged.gameId);
    setAvailability(merged.availability);
    void load(merged, 1, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load({ keyword: appliedKeyword, gameId, availability }, current.page + 1, "append");
  }

  function resetFilters() {
    setKeyword("");
    applyFilter({ keyword: "", gameId: "", availability: "all" });
  }

  const hasFilter = appliedKeyword !== "" || gameId !== "" || availability !== "all";

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 搜索行：输入不触发请求，点按钮或回车才搜 */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface px-3">
          <span className="shrink-0 text-ink-3" aria-hidden>
            ⌕
          </span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyFilter({ keyword: keyword.trim() });
              }
            }}
            placeholder="搜索昵称"
            aria-label="搜索陪玩昵称、自我介绍或服务标签"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          {keyword ? (
            <button
              type="button"
              aria-label="清空搜索词"
              onClick={() => {
                setKeyword("");
                applyFilter({ keyword: "" });
              }}
              className="shrink-0 text-[14px] text-ink-3"
            >
              ✕
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => applyFilter({ keyword: keyword.trim() })}
          className="h-9 shrink-0 rounded-full bg-brand-blue px-4 text-[13px] font-medium text-white"
        >
          搜索
        </button>
      </div>

      {/* 游戏筛选：选项来自服务端真实游戏数据，横向可换行，窄屏不会撑出横向滚动 */}
      <div className="px-3 pt-3">
        <p className="text-[12px] text-ink-3">擅长游戏</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <FilterChip
            label="全部"
            active={gameId === ""}
            onClick={() => applyFilter({ gameId: "" })}
          />
          {games.map((game) => (
            <FilterChip
              key={game.id}
              label={game.name}
              active={gameId === game.id}
              onClick={() => applyFilter({ gameId: game.id })}
            />
          ))}
        </div>
      </div>

      {/* 可用状态筛选 */}
      <div className="px-3 pt-2.5">
        <p className="text-[12px] text-ink-3">接单状态</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {COMPANION_AVAILABILITY_VALUES.map((value) => (
            <FilterChip
              key={value}
              label={COMPANION_AVAILABILITY_LABELS[value]}
              active={availability === value}
              onClick={() => applyFilter({ availability: value })}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col px-3 pb-3 pt-3">
        {/* 名单是 Mock、绑定规则未定：这句话不能省 */}
        <p className="text-[12px] leading-4 text-ink-3">{COMPANION_MOCK_NOTICE}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() =>
                  void load({ keyword: appliedKeyword, gameId, availability }, 1, "replace")
                }
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" ? (
            current.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                {/* 空态只替换列表区域：搜索行与两组筛选都还在，用户能立刻改条件 */}
                <EmptyState
                  title={hasFilter ? "没有符合条件的陪玩" : "暂无陪玩"}
                  description={
                    hasFilter
                      ? "换个关键词、游戏或接单状态再试试。"
                      : "名单还没有内容，稍后再来看看。"
                  }
                />
                {hasFilter ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-4 rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
                  >
                    清空筛选
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <p className="text-[12px] text-ink-3">共 {current.total} 位陪玩</p>

                <ul className="mt-2 flex flex-col gap-2.5">
                  {current.items.map((companion) => (
                    <li key={companion.id}>
                      <CompanionCard companion={companion} />
                    </li>
                  ))}
                </ul>

                <div className="mt-3">
                  {current.hasMore ? (
                    <button
                      type="button"
                      disabled={moreStatus === "loading"}
                      onClick={loadMore}
                      className="w-full rounded-full border border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
                    >
                      {moreStatus === "loading" ? "加载中…" : "加载更多"}
                    </button>
                  ) : (
                    // 「没有更多了」与「列表为空」是两个不同的状态，不合并成一句话
                    <p className="text-center text-[12px] text-ink-3">没有更多了</p>
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
      </div>
    </div>
  );
}

/**
 * 把当前筛选条件写回地址栏。
 *
 * 放在组件**外面**（而不是组件里的闭包）：挂载时对齐地址栏的那个 effect 只依赖
 * 服务端给的初始值，不需要把每次渲染都会变身份的闭包也算进依赖里。
 *
 * 用 `replaceState` 而不是 `pushState`：筛选不是「一次导航」，
 * 每点一个筛选胶囊就往历史里塞一条的话，用户得按十几次返回才能退出这一页。
 */
function replaceListAddress(
  next: { keyword: string; gameId: string; availability: CompanionAvailability },
  page: number,
): void {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(window.location.search);
  // 空条件就从地址里去掉，而不是留一个 `?keyword=` 的空参数
  for (const key of ["keyword", "gameId"]) {
    const value = key === "keyword" ? next.keyword : next.gameId;
    if (value) params.set(key, value);
    else params.delete(key);
  }
  if (next.availability === "all") params.delete("availability");
  else params.set("availability", next.availability);
  // 第 1 页不写页码：地址里留一个 `?page=1` 只是噪音
  if (page > 1) params.set("page", String(page));
  else params.delete("page");

  const query = params.toString();
  window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
}

/**
 * 筛选胶囊。
 *
 * 选中态除了底色还带 `aria-pressed`：颜色不是唯一的选中标志，
 * 读屏软件与黑白屏都能分辨出当前选的是哪一个。
 */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-[13px] ${
        active
          ? "seg-tab-active font-medium"
          : "border border-line bg-surface text-ink-2"
      }`}
    >
      {label}
    </button>
  );
}
