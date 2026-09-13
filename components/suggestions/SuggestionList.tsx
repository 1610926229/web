"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  SUGGESTION_MOCK_NOTICE,
  SUGGESTION_PAGE_SIZE,
  SUGGESTION_STATUS_CLASS,
  SUGGESTION_STATUS_HINTS,
  mergeSuggestionPage,
} from "@/lib/constants/suggestions";
import { fetchSuggestions } from "@/lib/services/suggestionsHttp";
import type { SuggestionListItem, SuggestionPage } from "@/lib/types/suggestion";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态：加载与错误只替换列表，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的记录清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 意见反馈列表。
 *
 * 与订单、投诉、优惠券、鸡腿列表同一套做法：首屏由 Server Component 取好后传进来，
 * 本组件不在挂载时再请求一次，因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 *
 * ⚠️ 卡片上**完整展开**用户提交的内容与平台回复，而不是给一个摘要：本阶段没有反馈详情页，
 * 列表就是唯一的落点——只显示摘要的话，用户提交完就再也看不到自己写了什么。
 *
 * 页面本身只读：新增入口指向 `/suggestions/new`，列表不产生记录。
 */
export default function SuggestionList({ initialPage }: { initialPage: SuggestionPage }) {
  const [current, setCurrent] = useState<SuggestionPage>(initialPage);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  // 每次取数领一个自增序号，回来时序号不是最新的就丢弃：先发后到的旧响应不会覆盖新结果
  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  async function load(page: number, mode: "replace" | "append") {
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
      const next = await fetchSuggestions({ page, pageSize: SUGGESTION_PAGE_SIZE });
      if (ticket !== ticketRef.current) return;

      setCurrent((previous) =>
        mode === "append" ? mergeSuggestionPage(previous, next) : next,
      );

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

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load(current.page + 1, "append");
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      <div className="flex flex-1 flex-col px-3 py-3">
        {/* 数据是 Mock、反馈不换来任何回报：这句话不能省 */}
        <p className="text-[12px] leading-4 text-ink-3">{SUGGESTION_MOCK_NOTICE}</p>

        <div className="mt-3 flex flex-1 flex-col">
          {listStatus === "loading" ? (
            <p className="py-10 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {listStatus === "error" ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-[13px] leading-5 text-ink-3">{listError}</p>
              <button
                type="button"
                onClick={() => void load(1, "replace")}
                className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
              >
                重试
              </button>
            </div>
          ) : null}

          {listStatus === "ready" ? (
            current.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10">
                {/* 文案与原型一致 */}
                <EmptyState title="暂无建议记录" description="提交的建议会在这里留下记录。" />
              </div>
            ) : (
              <>
                <ul className="flex flex-col gap-2.5">
                  {current.items.map((suggestion) => (
                    <li key={suggestion.id}>
                      <SuggestionCard suggestion={suggestion} />
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

          {/* 除了右上角的 ＋，列表底部再给一个写着字的新增入口：图标不是所有人都认得 */}
          <div className="mt-4">
            <Link
              href="/suggestions/new"
              className="flex h-11 w-full items-center justify-center rounded-full border border-brand-blue-border bg-brand-blue-soft text-[15px] font-medium text-brand-blue"
            >
              新增反馈
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 一条反馈。
 *
 * 展示的四组信息：类型、当前状态、提交时间，以及**完整**的反馈内容、凭证与平台回复。
 * 没有详情页，因此这里不做任何截断（正文按原样换行显示，凭证可点开原图）。
 */
function SuggestionCard({ suggestion }: { suggestion: SuggestionListItem }) {
  return (
    <article className="rounded-[10px] border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-page px-2 py-0.5 text-[11px] leading-5 text-ink-2">
          {suggestion.typeLabel}
        </span>
        <span
          className={`ml-auto text-[13px] font-medium ${SUGGESTION_STATUS_CLASS[suggestion.status]}`}
        >
          {suggestion.statusLabel}
        </span>
      </div>

      {/* 完整正文：whitespace-pre-wrap 保留用户自己敲的换行，break-words 防止长串撑破卡片 */}
      <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-5 text-ink">
        {suggestion.content}
      </p>

      {suggestion.evidence.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {suggestion.evidence.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noreferrer" aria-label={`查看凭证 ${item.name}`}>
                <img
                  src={item.url}
                  alt={item.name}
                  className="h-16 w-16 rounded-[8px] border border-line object-cover"
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {suggestion.contact ? (
        <p className="mt-2 break-words text-[12px] leading-4 text-ink-3">
          联系方式 {suggestion.contact}
        </p>
      ) : null}

      <p className="mt-2 text-[12px] text-ink-3">提交于 {formatDateTime(suggestion.createdAt)}</p>

      {/* 平台回复：只有真的回复过才出现这一块，没有回复时给一句状态说明 */}
      {suggestion.reply ? (
        <div className="mt-2 rounded-[8px] bg-page px-3 py-2">
          <p className="text-[12px] font-medium text-ink-2">
            平台回复
            {suggestion.repliedAt ? (
              <span className="ml-2 font-normal text-ink-3">
                {formatDateTime(suggestion.repliedAt)}
              </span>
            ) : null}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-ink-2">
            {suggestion.reply}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          {SUGGESTION_STATUS_HINTS[suggestion.status]}
        </p>
      )}
    </article>
  );
}
