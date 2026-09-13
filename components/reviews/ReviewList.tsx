"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  REVIEW_MOCK_NOTICE,
  REVIEW_PAGE_SIZE,
  REVIEW_RANGES,
  REVIEW_RATING_LABELS,
  REVIEW_TABS,
  companionLabel,
  mergePendingReviewPage,
  mergeReviewPage,
} from "@/lib/constants/reviews";
import { fetchPendingReviews, fetchReviewedReviews } from "@/lib/services/reviewsHttp";
import type {
  PendingReviewPage,
  ReviewListItem,
  ReviewPendingItem,
  ReviewRange,
  ReviewTabCounts,
  ReviewTabKey,
  ReviewedReviewPage,
} from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";

/** 首屏由服务端取好的那一页。两个 Tab 的形状不同，因此用可辨识联合。 */
export type ReviewInitial =
  | { tab: "reviewed"; range: ReviewRange; page: ReviewedReviewPage }
  | { tab: "pending"; range: ReviewRange; page: PendingReviewPage };

/** 列表区域的三种状态：加载与错误只替换列表，Tab 与筛选始终保留，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的记录清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 评价列表（已评价 / 待评价 + 时间筛选）。
 *
 * 与订单、优惠券列表同一套做法：首屏由 Server Component 取好后传进来，本组件不在挂载时
 * 再请求一次，因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。切 Tab 或切时间筛选时
 * 先发后到的旧响应因此**不会覆盖**新的结果——两个 Tab、五个时间范围的列表长得很像，
 * 这一条不处理的话非常难发现。
 *
 * 缓存按「Tab + 时间范围」存：切回来不必重新请求，也不会因为「只存一份结果」
 * 而把另一个 Tab 或另一个范围的分页信息丢掉。
 *
 * 待评价订单上的「评价服务」入口**完全按服务端返回的 `allowedActions` 显示**：
 * 不能评价时显示服务端给出的原因（退款中 / 已退款），前端不拿订单状态自己推断。
 */
export default function ReviewList({ initial }: { initial: ReviewInitial }) {
  const [tab, setTab] = useState<ReviewTabKey>(initial.tab);
  const [range, setRange] = useState<ReviewRange>(initial.range);
  const [reviewedPages, setReviewedPages] = useState<
    Partial<Record<ReviewRange, ReviewedReviewPage>>
  >(initial.tab === "reviewed" ? { [initial.range]: initial.page } : {});
  const [pendingPages, setPendingPages] = useState<Partial<Record<ReviewRange, PendingReviewPage>>>(
    initial.tab === "pending" ? { [initial.range]: initial.page } : {},
  );
  const [counts, setCounts] = useState<ReviewTabCounts>(initial.page.counts);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  const currentPage = tab === "reviewed" ? (reviewedPages[range] ?? null) : (pendingPages[range] ?? null);

  function cached(target: ReviewTabKey, targetRange: ReviewRange) {
    return target === "reviewed" ? reviewedPages[targetRange] : pendingPages[targetRange];
  }

  async function load(
    target: ReviewTabKey,
    targetRange: ReviewRange,
    query: { page?: number },
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
      const paging = { range: targetRange, page: query.page ?? 1, pageSize: REVIEW_PAGE_SIZE };

      if (target === "reviewed") {
        const next = await fetchReviewedReviews(paging);
        if (ticket !== ticketRef.current) return;
        setReviewedPages((current) => ({
          ...current,
          [targetRange]:
            mode === "append" && current[targetRange]
              ? mergeReviewPage(current[targetRange], next)
              : next,
        }));
        setCounts(next.counts);
      } else {
        const next = await fetchPendingReviews(paging);
        if (ticket !== ticketRef.current) return;
        setPendingPages((current) => ({
          ...current,
          [targetRange]:
            mode === "append" && current[targetRange]
              ? mergePendingReviewPage(current[targetRange], next)
              : next,
        }));
        setCounts(next.counts);
      }

      if (mode === "append") {
        setMoreStatus("idle");
        moreLoadingRef.current = false;
      } else {
        setListStatus("ready");
      }
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      const message = cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。";
      if (mode === "replace") {
        setListStatus("error");
        setListError(message);
      } else {
        // 加载更多失败：保留已经加载出来的记录，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  function selectTab(next: ReviewTabKey) {
    if (next === tab) return;
    setTab(next);

    // 已经有缓存就直接显示（不发请求），否则取第一页
    if (cached(next, range)) {
      setListStatus("ready");
      setMoreStatus("idle");
      return;
    }
    void load(next, range, { page: 1 }, "replace");
  }

  function selectRange(next: ReviewRange) {
    if (next === range) return;
    setRange(next);

    if (cached(tab, next)) {
      setListStatus("ready");
      setMoreStatus("idle");
      return;
    }
    void load(tab, next, { page: 1 }, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load(tab, range, { page: (currentPage?.page ?? 1) + 1 }, "append");
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 两个 Tab：切 Tab 时始终保留，只有下方列表被替换 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 pb-1 pt-2">
        <div className="flex gap-2" role="tablist" aria-label="评价分类">
          {REVIEW_TABS.map((item) => {
            const active = item.key === tab;
            const count = item.key === "reviewed" ? counts.reviewed : counts.pending;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectTab(item.key)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[14px] leading-5 ${
                  active ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {item.label}
                <span
                  className={`rounded-full px-1.5 text-[12px] leading-4 ${
                    active ? "bg-white/25 text-white" : "bg-surface text-ink-3"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* 时间筛选：横向可滚动，窄屏下不会把页面撑宽 */}
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {REVIEW_RANGES.map((item) => {
            const active = item.key === range;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectRange(item.key)}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] leading-5 ${
                  active ? "bg-brand-blue-soft text-brand-blue" : "bg-page text-ink-2"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <h2 className="text-[13px] font-medium text-ink-2">
          {REVIEW_TABS.find((item) => item.key === tab)?.heading}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{REVIEW_MOCK_NOTICE}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() => void load(tab, range, { page: 1 }, "replace")}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" && currentPage ? (
            currentPage.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                <EmptyState
                  title={tab === "reviewed" ? "暂无评价" : "暂无待评价订单"}
                  description={
                    tab === "reviewed"
                      ? "已完成的订单可以评价，评价后的记录会出现在这里。"
                      : "当前时间范围内没有需要评价的已完成订单，换个时间范围看看。"
                  }
                />
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2.5">
                  {tab === "reviewed"
                    ? (reviewedPages[range]?.items ?? []).map((review) => (
                        <li key={review.id}>
                          <ReviewedCard review={review} />
                        </li>
                      ))
                    : (pendingPages[range]?.items ?? []).map((order) => (
                        <li key={order.orderId}>
                          <PendingCard order={order} />
                        </li>
                      ))}
                </ul>

                <div className="mt-3">
                  {currentPage.hasMore ? (
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
    </div>
  );
}

/** 已评价记录：星级与正文在上，订单与打手信息在下。 */
function ReviewedCard({ review }: { review: ReviewListItem }) {
  return (
    <article className="rounded-[10px] border border-line bg-surface p-3">
      <ProductRow
        coverUrl={review.productCoverUrl}
        title={review.productTitle}
        specName={review.specName}
        quantity={review.quantity}
      />

      <div className="mt-2 flex items-center gap-2">
        <Stars rating={review.rating} />
        <span className="text-[12px] text-ink-3">{formatDateTime(review.createdAt)}</span>
      </div>

      <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink">
        {review.content}
      </p>

      {review.evidence.length > 0 ? (
        <ul className="mt-2 grid grid-cols-4 gap-2">
          {review.evidence.map((item) => (
            <li key={item.id}>
              <img
                src={item.url}
                alt={`评价凭证 ${item.name}`}
                className="aspect-square w-full rounded-[8px] border border-line object-cover"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 border-t border-line pt-2 text-[12px] leading-5 text-ink-3">
        <p className="break-words">订单号 {review.orderNo}</p>
        <p className="break-words">
          打手 {companionLabel(review.companion)} · 完成于 {formatDateTime(review.completedAt)}
        </p>
      </div>
    </article>
  );
}

/**
 * 待评价订单：右下角是「评价服务」入口或不能评价的原因。
 *
 * 入口显不显示**只看服务端给的 `allowedActions`**——能不能评价还取决于这一单有没有退款，
 * 前端拿订单状态自己推断一定会算错。
 */
function PendingCard({ order }: { order: ReviewPendingItem }) {
  return (
    <article className="rounded-[10px] border border-line bg-surface p-3">
      <ProductRow
        coverUrl={order.productCoverUrl}
        title={order.productTitle}
        specName={order.specName}
        quantity={order.quantity}
      />

      <div className="mt-2 border-t border-line pt-2 text-[12px] leading-5 text-ink-3">
        <p className="break-words">订单号 {order.orderNo}</p>
        <p className="break-words">
          打手 {companionLabel(order.companion)} · 完成于 {formatDateTime(order.completedAt)}
        </p>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {order.allowedActions.canReview ? (
          <Link
            href={`/reviews/new/${order.orderId}`}
            className="ml-auto flex h-8 shrink-0 items-center rounded-full bg-brand-red px-4 text-[13px] font-medium text-white"
          >
            评价服务
          </Link>
        ) : (
          <>
            {/* 不能评价时不做成灰色哑巴按钮：旁边一定有一句说明为什么 */}
            <span
              className="ml-auto flex h-8 shrink-0 items-center rounded-full border border-line px-4 text-[13px] text-ink-3"
              aria-disabled
            >
              暂不可评价
            </span>
            <span className="min-w-0 flex-1 text-[12px] leading-4 text-ink-3">
              {order.allowedActions.reason}
            </span>
          </>
        )}
      </div>
    </article>
  );
}

/** 商品行：封面 + 名称 + 规格数量。 */
function ProductRow({
  coverUrl,
  title,
  specName,
  quantity,
}: {
  coverUrl: string;
  title: string;
  specName: string;
  quantity: number;
}) {
  return (
    <div className="flex gap-3">
      <img
        src={coverUrl}
        alt={title}
        className="h-14 w-14 shrink-0 rounded-[8px] border border-line object-cover"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">{title}</p>
        <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">
          {specName} · ×{quantity}
        </p>
      </div>
    </div>
  );
}

/** 星级：星星是图形，读屏用户靠 `aria-label` 知道几星。 */
function Stars({ rating }: { rating: ReviewListItem["rating"] }) {
  return (
    <span
      role="img"
      aria-label={REVIEW_RATING_LABELS[rating]}
      className="text-[13px] leading-5 tracking-[2px] text-brand-red"
    >
      {"★".repeat(rating)}
      <span className="text-line">{"★".repeat(5 - rating)}</span>
    </span>
  );
}
