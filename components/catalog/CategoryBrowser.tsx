"use client";

import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import ProductCard from "@/components/common/ProductCard";
import { fetchProducts } from "@/lib/services/catalogHttp";
import type { Game, ProductListQuery } from "@/lib/types/catalog";
import type { PageResult } from "@/lib/types/common";
import type { Product } from "@/lib/types/product";

/** 列表区域的三种状态。加载与错误都只影响列表区域，不替换整页。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的商品清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 分类页的浏览交互。
 *
 * 首屏商品由 Server Component 取好后通过 `initialResult` 传进来，本组件**不在挂载时再请求一次**，
 * 因此首屏没有加载闪烁，也不会与 SSR 结果不一致。之后所有的取数都发生在用户操作里
 * （搜索、切游戏、切类目、加载更多），而不是 effect 里——请求由谁触发是明确的。
 *
 * 搜索用「搜索按钮 / 回车」触发，而不是每敲一个字就请求：请求次数可预期，也便于测试。
 *
 * 切换游戏或类目会清空搜索框并把列表恢复到「浏览该类目」的状态；
 * 搜索则只在当前游戏 + 类目范围内按名称过滤。
 */
export default function CategoryBrowser({
  games,
  initialGameId,
  initialCategoryId,
  initialResult,
}: {
  games: Game[];
  initialGameId: string;
  initialCategoryId: string;
  initialResult: PageResult<Product>;
}) {
  const [gameId, setGameId] = useState(initialGameId);
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [input, setInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState(initialResult);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  // 请求序号：切换类目/搜索很快时，先发的请求可能后返回，只认最后一次的结果
  const ticketRef = useRef(0);

  async function load(query: ProductListQuery, mode: "replace" | "append") {
    const ticket = ++ticketRef.current;

    if (mode === "replace") {
      setListStatus("loading");
      setListError("");
      setMoreStatus("idle");
    } else {
      setMoreStatus("loading");
      setMoreError("");
    }

    try {
      const next = await fetchProducts(query);
      if (ticket !== ticketRef.current) return;
      setResult(next);
      setListStatus("ready");
      if (mode === "append") setMoreStatus("idle");
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已有商品，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
      }
    }
  }

  function selectGame(nextGameId: string) {
    if (nextGameId === gameId) return;
    const nextGame = games.find((item) => item.id === nextGameId);
    const nextCategoryId = nextGame?.categories[0]?.id ?? "";
    setGameId(nextGameId);
    setCategoryId(nextCategoryId);
    setInput("");
    setKeyword("");
    void load({ gameId: nextGameId, categoryId: nextCategoryId }, "replace");
  }

  function selectCategory(nextCategoryId: string) {
    if (nextCategoryId === categoryId) return;
    setCategoryId(nextCategoryId);
    setInput("");
    setKeyword("");
    void load({ gameId, categoryId: nextCategoryId }, "replace");
  }

  function search() {
    const next = input.trim();
    setKeyword(next);
    void load({ gameId, categoryId, keyword: next }, "replace");
  }

  function clearSearch() {
    setInput("");
    setKeyword("");
    void load({ gameId, categoryId }, "replace");
  }

  function loadMore() {
    void load({ gameId, categoryId, keyword, page: result.page + 1 }, "append");
  }

  function retry() {
    void load({ gameId, categoryId, keyword }, "replace");
  }

  const game = games.find((item) => item.id === gameId) ?? games[0];
  if (!game) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface px-4 py-16">
        <EmptyState title="暂无分类" description="分类配置尚未就绪，请稍后再来。" />
      </div>
    );
  }

  const categoryName = game.categories.find((item) => item.id === categoryId)?.name ?? "全部商品";
  const countHint =
    listStatus === "ready"
      ? keyword
        ? `“${keyword}”共 ${result.total} 件`
        : `共 ${result.total} 件商品`
      : "";

  return (
    <div className="flex flex-1 flex-col bg-surface">
      {/* 搜索行 */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-full bg-page px-3">
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0 text-ink-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="6" />
            <path d="M20 20l-4.2-4.2" />
          </svg>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search();
            }}
            placeholder="搜索商品名称"
            aria-label="搜索商品名称"
            className="h-full w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </div>
        <button
          type="button"
          onClick={search}
          className="h-9 shrink-0 rounded-full bg-brand-red px-5 text-[14px] font-medium text-white"
        >
          搜索
        </button>
      </div>

      {/* 游戏分类 */}
      <div className="px-3 pb-2">
        <h2 className="mb-2 text-[16px] font-bold text-ink">全部商品</h2>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {games.map((item) => {
            const active = item.id === gameId;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => selectGame(item.id)}
                className={`shrink-0 rounded-full px-3.5 py-[6px] text-[13px] ${
                  active ? "bg-brand-red font-medium text-white" : "bg-page text-ink-2"
                }`}
              >
                {item.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* 左侧类目竖栏 + 右侧商品列表 */}
      <div className="flex flex-1 items-stretch border-t border-line">
        <nav className="w-[80px] shrink-0 bg-page">
          {game.categories.map((item) => {
            const active = item.id === categoryId;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => selectCategory(item.id)}
                className={`relative block w-full px-[6px] py-3 text-center text-[13px] leading-[18px] ${
                  active ? "bg-surface font-semibold text-ink" : "text-ink-2"
                }`}
              >
                {active ? (
                  <span
                    className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-brand-red"
                    aria-hidden
                  />
                ) : null}
                {item.name}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 px-3 pb-4 pt-3">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="h-4 w-[3px] shrink-0 rounded-full bg-brand-red" aria-hidden />
            <h3 className="truncate text-[15px] font-semibold text-ink">
              {keyword ? "搜索结果" : categoryName}
            </h3>
            {countHint ? (
              <span className="ml-auto shrink-0 text-[12px] text-ink-3">{countHint}</span>
            ) : null}
          </div>

          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={retry}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" ? (
            result.items.length === 0 ? (
              // 空状态只替换列表区域：搜索行、游戏分类、左侧类目栏都还在
              <div className="py-8">
                <EmptyState
                  title={keyword ? "没有找到相关商品" : "该分类暂无商品"}
                  description={
                    keyword
                      ? `没有名称包含“${keyword}”的商品，换个关键词试试。`
                      : "该分类下暂时没有上架商品，看看其他分类吧。"
                  }
                />
                {keyword ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
                    >
                      清空搜索
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-2.5 gap-y-4">
                  {result.items.map((product) => (
                    <ProductCard key={product.id} product={product} compact />
                  ))}
                </div>

                <div className="mt-4">
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
