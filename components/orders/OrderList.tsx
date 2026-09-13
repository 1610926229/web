"use client";

import { useEffect, useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import OrderCard from "@/components/orders/OrderCard";
import {
  ORDER_KEYWORD_MAX_LENGTH,
  ORDER_PAGE_SIZE,
  ORDER_TABS,
  mergeOrderPage,
  type OrderTabKey,
} from "@/lib/constants/orders";
import { fetchOrders } from "@/lib/services/ordersHttp";
import type { PageResult } from "@/lib/types/common";
import type { OrderListItem } from "@/lib/types/order";

/** 列表区域的三种状态：加载与错误都只替换列表区域，不替换筛选区，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的订单清掉。 */
type MoreStatus = "idle" | "loading" | "error";

const FILTER_HINT_TEXT = "更多筛选功能待补充";
const FILTER_HINT_MS = 2600;

/**
 * 订单列表的交互部分。
 *
 * 首屏订单由 Server Component 取好后通过 `initialResult` 传进来，本组件**不在挂载时再请求一次**，
 * 因此首屏没有加载闪烁。之后所有取数都发生在用户操作里（切 Tab、搜索、加载更多），
 * 而不是 effect 里——请求由谁触发是明确的。
 *
 * 状态与搜索**同时生效**：切 Tab 不会清掉搜索词，清空搜索则回到当前 Tab 的全部订单。
 * 搜索用「点放大镜 / 回车」触发，不逐字符请求：请求次数可预期，也便于测试。
 *
 * 竞态：每次取数领一个自增的序号，回来时序号不是最新的就直接丢弃，
 * 因此快速连点 Tab 时，先发后到的旧响应不会覆盖新状态的结果。
 *
 * 原型里的筛选图标当前**没有业务定义**，这里保留视觉入口，点击给出明确反馈
 * （「更多筛选功能待补充」），不自行发明日期 / 金额 / 商品等筛选规则，也不做成点了没反应。
 */
export default function OrderList({
  initialStatus,
  initialResult,
}: {
  initialStatus: OrderTabKey;
  initialResult: PageResult<OrderListItem>;
}) {
  const [status, setStatus] = useState<OrderTabKey>(initialStatus);
  const [input, setInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [result, setResult] = useState(initialResult);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");
  const [filterHint, setFilterHint] = useState(false);

  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
  }, []);

  async function load(
    query: { status: OrderTabKey; keyword: string; page?: number },
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
      const next = await fetchOrders({
        status: query.status === "all" ? "" : query.status,
        keyword: query.keyword,
        page: query.page ?? 1,
        pageSize: ORDER_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      if (mode === "append") {
        // 合并而不是替换：加载更多只往后追加，已经看到的订单不能消失
        setResult((current) => mergeOrderPage(current, next));
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setResult(next);
        setListStatus("ready");
      }
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已经加载出来的订单，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  function selectStatus(next: OrderTabKey) {
    if (next === status) return;
    setStatus(next);
    // 切状态重置页码；搜索词保留，两者是叠加条件
    void load({ status: next, keyword }, "replace");
  }

  function search() {
    const next = input.trim();
    setKeyword(next);
    void load({ status, keyword: next }, "replace");
  }

  function clearSearch() {
    if (!input && !keyword) return;
    setInput("");
    setKeyword("");
    void load({ status, keyword: "" }, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load({ status, keyword, page: result.page + 1 }, "append");
  }

  function retry() {
    void load({ status, keyword }, "replace");
  }

  function showFilterHint() {
    setFilterHint(true);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setFilterHint(false), FILTER_HINT_MS);
  }

  const searching = keyword.length > 0;

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 筛选区：切换状态与搜索时始终保留，列表只替换下方区域 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {ORDER_TABS.map((tab) => {
            const active = tab.key === status;
            return (
              <button
                key={tab.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectStatus(tab.key)}
                className={`shrink-0 rounded-full px-2.5 py-[5px] text-[13px] leading-[18px] ${
                  active ? "order-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="mt-1 flex items-center gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-page px-3">
            <button
              type="button"
              onClick={search}
              aria-label="搜索订单号"
              className="shrink-0 text-ink-3"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="6" />
                <path d="M20 20l-4.2-4.2" />
              </svg>
            </button>

            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") search();
              }}
              maxLength={ORDER_KEYWORD_MAX_LENGTH}
              enterKeyHint="search"
              placeholder="搜索订单号..."
              aria-label="搜索订单号"
              className="h-full w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
            />

            {input ? (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="清空搜索"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink-3 text-[11px] leading-none text-white"
              >
                ✕
              </button>
            ) : null}
          </div>

          <button
            type="button"
            onClick={showFilterHint}
            aria-label="更多筛选"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-page text-ink-2"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M4 7h16" />
              <path d="M7 12h10" />
              <path d="M10 17h4" />
            </svg>
          </button>
        </div>

        {filterHint ? (
          <p role="status" className="mt-1.5 text-[12px] leading-4 text-ink-3">
            {FILTER_HINT_TEXT}
          </p>
        ) : null}
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
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
            // 空状态只替换列表区域：六个 Tab 与搜索框都还在
            <div className="flex flex-1 flex-col items-center justify-center py-10">
              <EmptyState
                title={searching ? "没有找到相关订单" : "暂无订单"}
                description={
                  searching
                    ? `没有订单号包含“${keyword}”的订单，换个订单号试试。`
                    : "下单后可以在这里查看护航进度。"
                }
              />
              {searching ? (
                <button
                  type="button"
                  onClick={clearSearch}
                  className="mt-4 rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
                >
                  清空搜索
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {result.items.map((order) => (
                  <li key={order.id}>
                    <OrderCard order={order} />
                  </li>
                ))}
              </ul>

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
                  // 「没有更多了」与「列表为空」是两个不同的状态，不能合并成一句话
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
  );
}
