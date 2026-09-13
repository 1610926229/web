"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPLAINT_PAGE_SIZE,
  COMPLAINT_STATUS_CLASS,
  COMPLAINT_STATUS_HINTS,
  COMPLAINT_STATUS_LABELS,
  COMPLAINT_TABS,
  mergeComplaintPage,
  type ComplaintTabKey,
} from "@/lib/constants/complaints";
import { fetchComplaints } from "@/lib/services/complaintsHttp";
import type { PageResult } from "@/lib/types/common";
import type { ComplaintListItem } from "@/lib/types/complaint";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态：加载与错误只替换列表，筛选区始终保留，页面不会整体白屏。 */
type ListStatus = "ready" | "loading" | "error";
/** 「加载更多」的独立状态：它的失败不能把已经加载出来的投诉清掉。 */
type MoreStatus = "idle" | "loading" | "error";

/**
 * 投诉记录的交互部分。
 *
 * 与订单列表同一套做法：首屏由 Server Component 取好后通过 `initialResult` 传进来，
 * 本组件不在挂载时再请求一次，因此首屏没有加载闪烁；之后所有请求都由用户操作触发。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃，
 * 快速连点筛选时先发后到的旧响应不会覆盖新结果。
 *
 * 列表项只展示**摘要**（单号、状态、类型、关联订单号、时间）：
 * 投诉说明、凭证、处理结果都在详情页，那里会再校验一次归属。
 */
export default function ComplaintList({
  initialStatus,
  initialResult,
}: {
  initialStatus: ComplaintTabKey;
  initialResult: PageResult<ComplaintListItem>;
}) {
  const [status, setStatus] = useState<ComplaintTabKey>(initialStatus);
  const [result, setResult] = useState(initialResult);
  const [listStatus, setListStatus] = useState<ListStatus>("ready");
  const [listError, setListError] = useState("");
  const [moreStatus, setMoreStatus] = useState<MoreStatus>("idle");
  const [moreError, setMoreError] = useState("");

  const ticketRef = useRef(0);
  // 「加载更多」的同步闸门：state 更新是异步的，连点两次可能都读到旧的 moreStatus
  const moreLoadingRef = useRef(false);

  async function load(
    query: { status: ComplaintTabKey; page?: number },
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
      const next = await fetchComplaints({
        status: query.status === "all" ? "" : query.status,
        page: query.page ?? 1,
        pageSize: COMPLAINT_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      if (mode === "append") {
        // 合并而不是替换：加载更多只往后追加，已经看到的投诉不能消失
        setResult((current) => mergeComplaintPage(current, next));
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
        // 加载更多失败：保留已经加载出来的投诉，只在列表末尾提示
        setMoreStatus("error");
        setMoreError(message);
        moreLoadingRef.current = false;
      }
    }
  }

  function selectStatus(next: ComplaintTabKey) {
    if (next === status) return;
    setStatus(next);
    void load({ status: next }, "replace");
  }

  function loadMore() {
    if (moreLoadingRef.current) return;
    void load({ status, page: result.page + 1 }, "append");
  }

  return (
    <div className="flex flex-1 flex-col bg-page">
      {/* 状态筛选：切 Tab 时始终保留，只有下方列表被替换 */}
      <header className="sticky top-11 z-10 shrink-0 bg-surface px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {COMPLAINT_TABS.map((tab) => {
            const active = tab.key === status;
            return (
              <button
                key={tab.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectStatus(tab.key)}
                className={`shrink-0 rounded-full px-2.5 py-[5px] text-[13px] leading-[18px] ${
                  active ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
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
              onClick={() => void load({ status }, "replace")}
              className="rounded-full border border-line px-5 py-1.5 text-[13px] text-ink-2"
            >
              重试
            </button>
          </div>
        ) : null}

        {listStatus === "ready" ? (
          result.items.length === 0 ? (
            // 空状态只替换列表区域：五个 Tab 与顶部入口都还在
            <div className="flex flex-1 flex-col items-center justify-center py-10">
              <EmptyState
                title={status === "all" ? "暂无投诉记录" : "没有该状态的投诉"}
                description="提交投诉后可以在这里查看客服的处理进度。"
              />
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {result.items.map((complaint) => (
                  <li key={complaint.id}>
                    <ComplaintCard complaint={complaint} />
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

/** 投诉卡片：只展示摘要字段，点进详情才看得到说明、凭证与处理结果。 */
function ComplaintCard({ complaint }: { complaint: ComplaintListItem }) {
  return (
    <Link href={`/complaints/${complaint.id}`} className="block rounded-[10px] bg-surface p-3">
      <div className="flex items-center gap-3">
        <span className={`text-[14px] font-medium ${COMPLAINT_STATUS_CLASS[complaint.status]}`}>
          {COMPLAINT_STATUS_LABELS[complaint.status]}
        </span>
        <span className="ml-auto shrink-0 text-[12px] text-ink-3">
          {formatDateTime(complaint.createdAt)}
        </span>
      </div>

      <p className="mt-1.5 text-[13px] leading-5 text-ink-2">
        {COMPLAINT_STATUS_HINTS[complaint.status]}
      </p>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
        <span>{complaint.typeLabel}</span>
        <span>投诉单号 {complaint.complaintNo}</span>
        {/* 未关联订单的投诉（平台服务类）如实显示，不编一个订单号出来 */}
        <span>{complaint.orderNo ? `订单号 ${complaint.orderNo}` : "未关联订单"}</span>
      </div>
    </Link>
  );
}
