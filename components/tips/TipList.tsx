"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  TIP_COMPANION_UNBOUND_LABEL,
  TIP_MOCK_NOTICE,
  TIP_PAGE_SIZE,
  TIP_STATUS_CLASS,
  TIP_STATUS_OPTIONS,
  mergeTipPage,
} from "@/lib/constants/tips";
import { fetchTips } from "@/lib/services/tipsHttp";
import type { TipListItem, TipPage, TipStatusFilter } from "@/lib/types/tip";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态：加载与错误只替换列表，筛选 chip 始终保留，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的记录清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 鸡腿记录列表（只读）。
 *
 * 与订单、投诉、优惠券列表同一套做法：首屏由 Server Component 取好后传进来，
 * 本组件不在挂载时再请求一次，因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。切换状态筛选时先发后到的
 * 旧响应因此**不会覆盖**新筛选的结果。
 *
 * ⚠️ 卡片上**只有鸡腿个数的原始记录值**，不显示单价、兑换比例、平台抽成与打手到手金额：
 * 这些规则都还没有确认（见 `lib/constants/tips.ts`）。页面上也没有任何提交入口，
 * 本列表只读，不产生记录、不产生支付请求。
 */
export default function TipList({
  initialStatus,
  initialResult,
}: {
  initialStatus: TipStatusFilter;
  initialResult: TipPage;
}) {
  const [status, setStatus] = useState<TipStatusFilter>(initialStatus);
  const [pages, setPages] = useState<Partial<Record<TipStatusFilter, TipPage>>>({
    [initialStatus]: initialResult,
  });
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  const currentPage = pages[status] ?? null;
  const counts = currentPage?.counts ?? initialResult.counts;

  async function load(
    target: TipStatusFilter,
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
      const next = await fetchTips({
        status: target,
        page: query.page ?? 1,
        pageSize: TIP_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setPages((current) => ({
        ...current,
        [target]:
          mode === "append" && current[target] ? mergeTipPage(current[target], next) : next,
      }));

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

  function selectStatus(next: TipStatusFilter) {
    if (next === status) return;
    setStatus(next);

    // 已经有缓存就直接显示（不发请求），否则取第一页
    if (pages[next]) {
      setListStatus("ready");
      setMoreStatus("idle");
      return;
    }
    void load(next, { page: 1 }, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load(status, { page: (currentPage?.page ?? 1) + 1 }, "append");
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 状态筛选：横向可滚动，窄屏下不会把页面撑宽 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="支付状态筛选">
          {TIP_STATUS_OPTIONS.map((item) => {
            const active = item.key === status;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectStatus(item.key)}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] leading-5 ${
                  active ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {item.label}
                <span className="ml-1 opacity-80">{counts[item.key]}</span>
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        {/* 数据是 Mock、只记录不结算：这句话不能省，否则用户会自己脑补一个价格 */}
        <p className="text-[12px] leading-4 text-ink-3">{TIP_MOCK_NOTICE}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() => void load(status, { page: 1 }, "replace")}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" && currentPage ? (
            currentPage.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                {/* 文案与原型一致 */}
                <EmptyState
                  title="暂无鸡腿记录"
                  description={
                    status === "all"
                      ? "送出的鸡腿会在这里留下记录。"
                      : "当前筛选状态下没有记录，换个状态看看。"
                  }
                />
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2.5">
                  {currentPage.items.map((tip) => (
                    <li key={tip.id}>
                      <TipCard tip={tip} />
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

/**
 * 一条鸡腿记录。
 *
 * 展示的四组信息：关联订单、收到鸡腿的打手、鸡腿数量的**原始记录值**、创建时间与支付状态。
 * 数量写成「×N（原始记录值）」而不是换算成金额：本阶段没有单价，写出来的任何金额都是自造的。
 */
function TipCard({ tip }: { tip: TipListItem }) {
  return (
    <article className="rounded-[10px] border border-line bg-surface p-3">
      <div className="flex gap-3">
        <img
          src={tip.productCoverUrl}
          alt={tip.productTitle}
          className="h-14 w-14 shrink-0 rounded-[8px] border border-line object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-[14px] font-medium leading-5 text-ink">
            {tip.productTitle}
          </p>
          <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">
            订单号 {tip.orderNo}
          </p>
          <p className="mt-1 break-words text-[12px] leading-4 text-ink-3">
            送给 {tip.companion ? tip.companion.name : TIP_COMPANION_UNBOUND_LABEL}
          </p>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
        <span className="text-[13px] text-ink-2">鸡腿数量</span>
        <span className="text-[14px] font-medium text-ink">×{tip.quantity}</span>
        <span className="text-[11px] text-ink-3">（原始记录值）</span>
        <span className={`ml-auto text-[13px] font-medium ${TIP_STATUS_CLASS[tip.paymentStatus]}`}>
          {tip.paymentStatusLabel}
        </span>
      </div>

      <p className="mt-1 text-[12px] text-ink-3">创建于 {formatDateTime(tip.createdAt)}</p>
    </article>
  );
}
