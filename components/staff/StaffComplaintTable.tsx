"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/common/Pagination";
import { COMPLAINT_STATUS_CLASS } from "@/lib/constants/complaints";
import { STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import {
  STAFF_COMPLAINT_EMPTY_MESSAGE,
  STAFF_COMPLAINT_LIST_FIELDS_NOTE,
  STAFF_COMPLAINT_STATUS_FILTERS,
  STAFF_COMPLAINT_STATUS_FILTER_LABELS,
  STAFF_COMPLAINT_TYPE_FILTERS,
  STAFF_COMPLAINT_TYPE_FILTER_LABELS,
  type StaffComplaintStatusFilter,
  type StaffComplaintTypeFilter,
} from "@/lib/constants/staffComplaints";
import { fetchStaffComplaints } from "@/lib/services/staffComplaintsHttp";
import type { StaffComplaintListData } from "@/lib/types/complaint";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type StaffComplaintFilters = {
  status: StaffComplaintStatusFilter;
  type: StaffComplaintTypeFilter;
  keyword: string;
  page: number;
};

/**
 * 客服工作台投诉列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表只读**：操作列只有「查看详情」链接。三个处理动作都在详情页——
 * 那里才看得到投诉正文、凭证与联系方式，而「解决」与「关闭」的结果会展示给用户。
 *
 * ⚠️ 操作列用**统一**的「查看详情」文案，不按状态写 `if (status === "pending")`：
 * 能不能处理由详情页的服务端 `allowedActions` 决定，列表只负责把人带过去。
 *
 * ⚠️ 列表**不显示联系方式**（§投诉处理）：一次列表请求会带走全部投诉人的手机号，
 * 而列表上根本用不到它；它只在详情页出现，且是只读的。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function StaffComplaintTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: StaffComplaintFilters;
  initialResult: StaffComplaintListData;
}) {
  const [status, setStatus] = useState<StaffComplaintStatusFilter>(initialFilters.status);
  const [type, setType] = useState<StaffComplaintTypeFilter>(initialFilters.type);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  /**
   * ⚠️ 服务端重新取数之后，这张表必须**采纳新的快照**。
   *
   * 上面那行 `useState(initialResult)` 只在首次挂载时读一次初值，而页面顶部的
   * 「刷新」走的是 `router.refresh()`——它会**合并**新的 RSC 载荷，并**刻意保留**
   * 客户端的 `useState`（内置文档 `01-app/03-api-reference/04-functions/use-router.md`：
   * merge the updated RSC payload *without losing unaffected client-side React
   * (e.g. `useState`)`）。两者相遇的结果是：服务端明明按最新数据重新查过一遍，
   * 这张表却继续显示打开页面时的那一份——客服点几次「刷新」都看不到用户刚提交的投诉。
   *
   * 判据用**引用**：`initialResult` 由服务端每次渲染重新构造，只有服务端真的重新取过数
   * 才会换一个引用；客服在本地筛选、翻页、输入关键词都不会动它，所以不会误伤本地状态。
   * 筛选条件随之回到地址栏口径：`initialFilters` 每次渲染都是新对象、比不了引用，
   * 但既然此刻已经确定「服务端重新取过数」，把两者一起采纳正是「按这个地址重新读一遍」
   * 的语义——而不是保留客服本地改过、地址栏上并不存在的条件。
   *
   * 竞态：若此刻恰有一个客户端取数在途，它会在这之后回来并覆盖这份快照——那一份
   * 是客服**自己刚选的**筛选结果，仍然自洽（旧了几百毫秒），下一次交互即回到最新。
   */
  const [serverResult, setServerResult] = useState(initialResult);
  if (serverResult !== initialResult) {
    setServerResult(initialResult);
    setResult(initialResult);
    setStatus(initialFilters.status);
    setType(initialFilters.type);
    setKeyword(initialFilters.keyword);
    setInput(initialFilters.keyword);
    setPage(initialFilters.page);
    setLoadStatus("ready");
    setError("");
    setNote("");
  }

  async function load(query: StaffComplaintFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchStaffComplaints({
        status: query.status,
        type: query.type,
        keyword: query.keyword,
        page: query.page,
        pageSize: STAFF_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setStatus(query.status);
      setType(query.type);
      setKeyword(query.keyword);
      setPage(next.page);
      setLoadStatus("ready");
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  const current: StaffComplaintFilters = { status, type, keyword, page };

  /** 重置回默认筛选（「待处理」——这个页面的主要用途是处理待办）。 */
  function reset() {
    setInput("");
    void load({ status: "pending", type: "all", keyword: "", page: 1 });
  }

  const filtered = status !== "pending" || type !== "all" || keyword !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">投诉编号 / 订单号 / 用户昵称</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入投诉编号、订单号或用户昵称（不区分大小写）"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">投诉状态</span>
          <select
            value={status}
            onChange={(event) =>
              void load({
                ...current,
                status: event.target.value as StaffComplaintStatusFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {STAFF_COMPLAINT_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {STAFF_COMPLAINT_STATUS_FILTER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">投诉类型</span>
          <select
            value={type}
            onChange={(event) =>
              void load({
                ...current,
                type: event.target.value as StaffComplaintTypeFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {STAFF_COMPLAINT_TYPE_FILTERS.map((item) => (
              <option key={item} value={item}>
                {STAFF_COMPLAINT_TYPE_FILTER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => void load({ ...current, keyword: input.trim(), page: 1 })}
          disabled={loadStatus === "loading"}
          className="h-9 rounded-lg bg-ink px-5 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {loadStatus === "loading" ? "查询中…" : "查询"}
        </button>

        {filtered ? (
          <button
            type="button"
            onClick={reset}
            className="h-9 rounded-lg border border-admin-line px-4 text-[13px] text-ink-2 hover:bg-page"
          >
            重置
          </button>
        ) : null}
      </div>

      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[18px] text-[12px] leading-[18px] text-ink-3"
      >
        {loadStatus === "loading" ? "加载中…" : note}
      </p>

      {loadStatus === "error" ? (
        <div className="mt-2 flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load(current)}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {loadStatus !== "error" && result.items.length === 0 ? (
        <div className="mt-2 rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">{STAFF_COMPLAINT_EMPTY_MESSAGE}</p>
          {filtered ? (
            <button
              type="button"
              onClick={reset}
              className="mt-3 rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
            >
              重置筛选
            </button>
          ) : null}
        </div>
      ) : null}

      {result.items.length > 0 ? (
        <>
          <div className="mt-2 overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[1000px] border-collapse text-[13px]">
              <caption className="sr-only">
                投诉列表，共 {result.total} 条。处理动作在每条投诉的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">投诉编号</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">类型</th>
                  <th scope="col" className="px-4 py-3 font-medium">关联订单</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">提交时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">更新时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.complaintNo}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      <span className="block">{item.user.nickname || "—"}</span>
                      <span className="block font-mono text-[12px] text-ink-3">{item.user.id}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">{item.typeLabel}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {/* 未关联订单的投诉是合法状态，不是缺失数据 */}
                      {item.orderNo ?? "未关联订单"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[13px] font-medium ${COMPLAINT_STATUS_CLASS[item.status]}`}>
                        {item.statusLabel}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.updatedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/staff/complaints/${item.id}`}
                        className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        查看详情
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={result.page}
            total={result.total}
            hasMore={result.hasMore}
            pending={loadStatus === "loading"}
            onPrev={() => void load({ ...current, page: page - 1 })}
            onNext={() => void load({ ...current, page: page + 1 })}
          />
        </>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_COMPLAINT_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
