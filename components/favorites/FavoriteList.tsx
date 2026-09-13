"use client";

import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import FavoriteCard from "@/components/favorites/FavoriteCard";
import {
  FAVORITE_EMPTY_DESCRIPTION,
  FAVORITE_EMPTY_TITLE,
  FAVORITE_FAILED_MESSAGE,
  FAVORITE_PAGE_SIZE,
  mergeFavoritePage,
} from "@/lib/constants/favorites";
import { fetchFavorites, removeFavorite } from "@/lib/services/favoritesHttp";
import type { PageResult } from "@/lib/types/common";
import type { FavoriteListItem } from "@/lib/types/favorite";

/** 列表区域的状态：加载与错误只替换列表区域，不替换顶部的标题与计数。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的收藏清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 收藏列表的交互部分。
 *
 * 首屏由 Server Component 取好后经 `initialResult` 传入，本组件**不在挂载时再请求一次**；
 * 之后只有两个动作会发请求：「加载更多」与「移除」——请求由谁触发始终是明确的。
 *
 * 与订单 / 投诉列表的差别：收藏**没有筛选与搜索**，所以这里只有分页与移除两种交互。
 *
 * 状态覆盖：加载中、空、错误（可重试）、加载更多失败（保留已加载项）、没有更多了。
 * 这五种是各自独立的，不能合并成一句话——「没有更多了」和「一条都没有」是两件事。
 */
export default function FavoriteList({
  initialResult,
}: {
  initialResult: PageResult<FavoriteListItem>;
}) {
  const [result, setResult] = useState(initialResult);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");
  /** 正在移除的收藏记录 id（按记录而不是商品：同一时刻只允许一个移除在飞） */
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState("");

  // 每次取数领一个自增序号，回来时不是最新的就丢弃，避免旧响应覆盖新状态
  const ticketRef = useRef(0);
  // 同步闸门：state 更新是异步的，连点两次可能都读到旧值
  const moreLoadingRef = useRef(false);
  const removingRef = useRef(false);

  async function loadMore() {
    if (moreLoadingRef.current) return;
    moreLoadingRef.current = true;
    setMoreStatus("loading");
    setMoreError("");

    const ticket = ++ticketRef.current;
    try {
      const next = await fetchFavorites(result.page + 1, FAVORITE_PAGE_SIZE);
      if (ticket !== ticketRef.current) return;
      // 合并而不是替换：已经看到的收藏不能消失（合并按收藏记录 id 去重）
      setResult((current) => mergeFavoritePage(current, next));
      setMoreStatus("idle");
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setMoreStatus("error");
      setMoreError(cause instanceof Error ? cause.message : FAVORITE_FAILED_MESSAGE);
    } finally {
      moreLoadingRef.current = false;
    }
  }

  async function retry() {
    setListStatus("loading");
    setListError("");

    const ticket = ++ticketRef.current;
    try {
      const next = await fetchFavorites(1, FAVORITE_PAGE_SIZE);
      if (ticket !== ticketRef.current) return;
      setResult(next);
      setListStatus("ready");
      setMoreStatus("idle");
      moreLoadingRef.current = false;
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setListStatus("error");
      setListError(cause instanceof Error ? cause.message : FAVORITE_FAILED_MESSAGE);
    }
  }

  async function handleRemove(item: FavoriteListItem) {
    if (removingRef.current) return;
    removingRef.current = true;
    setRemovingId(item.id);
    setRemoveError("");

    try {
      const removed = await removeFavorite(item.productId);
      // 服务端返回的是操作后的确定状态，页面按它渲染，不靠本地猜测
      if (removed.favorited) {
        setRemoveError(FAVORITE_FAILED_MESSAGE);
        return;
      }
      setResult((current) => ({
        ...current,
        items: current.items.filter((row) => row.id !== item.id),
        total: Math.max(0, current.total - 1),
      }));
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : FAVORITE_FAILED_MESSAGE);
    } finally {
      removingRef.current = false;
      setRemovingId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      <header className="shrink-0 px-4 pb-1 pt-3">
        <p className="text-[12px] text-ink-3">共 {result.total} 件收藏 · 按最近收藏排序</p>
      </header>

      <div className="flex flex-1 flex-col px-3 pb-3 pt-2">
        {removeError ? (
          <p role="alert" className="mb-2 rounded-[10px] bg-surface px-3 py-2 text-[12px] text-brand-red">
            {removeError}
          </p>
        ) : null}

        {listStatus === "loading" ? (
          <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
        ) : null}

        {listStatus === "error" ? (
          <div className="flex flex-col items-center gap-3 py-10">
            <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
            <button
              type="button"
              onClick={() => {
                void retry();
              }}
              className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
            >
              重试
            </button>
          </div>
        ) : null}

        {listStatus === "ready" ? (
          result.items.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-10">
              <EmptyState title={FAVORITE_EMPTY_TITLE} description={FAVORITE_EMPTY_DESCRIPTION} />
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {result.items.map((item) => (
                  <li key={item.id}>
                    <FavoriteCard
                      item={item}
                      removing={removingId === item.id}
                      onRemove={(target) => {
                        void handleRemove(target);
                      }}
                    />
                  </li>
                ))}
              </ul>

              <div className="mt-3">
                {result.hasMore ? (
                  <button
                    type="button"
                    disabled={moreStatus === "loading"}
                    onClick={() => {
                      void loadMore();
                    }}
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
                      onClick={() => {
                        void loadMore();
                      }}
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
  );
}
