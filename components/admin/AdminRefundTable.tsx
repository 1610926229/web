"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_REFUND_EMPTY_MESSAGE,
  ADMIN_REFUND_LIST_FIELDS_NOTE,
  ADMIN_REFUND_MOCK_NOTICE,
  ADMIN_REFUND_PAGE_SIZE,
  ADMIN_REFUND_STATUS_FILTERS,
  ADMIN_REFUND_STATUS_FILTER_LABELS,
  type AdminRefundStatusFilter,
} from "@/lib/constants/adminRefunds";
import { fetchAdminRefunds } from "@/lib/services/adminHttp";
import type { AdminRefundListData } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminRefundFilters = {
  status: AdminRefundStatusFilter;
  keyword: string;
  page: number;
};

/**
 * 管理端退款申请列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表只读**：操作列只有「去审核」链接。三个审核动作都在详情页——
 * 那里能看到退款原因、说明与凭证，而「通过」会在同一次写入里把订单改成已退款。
 *
 * ⚠️ 列表同时显示**退款状态**与**订单状态**两列，这是刻意的：
 * 它们是两条独立的线（§退款审核），把两者摆在一起，客服才能一眼看出
 * 「这笔退款已经批了，可订单还停在护航中」这类中间状态是正常的。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function AdminRefundTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminRefundFilters;
  initialResult: AdminRefundListData;
}) {
  const [status, setStatus] = useState<AdminRefundStatusFilter>(initialFilters.status);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminRefundFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminRefunds({
        status: query.status,
        keyword: query.keyword,
        page: query.page,
        pageSize: ADMIN_REFUND_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setStatus(query.status);
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

  const current: AdminRefundFilters = { status, keyword, page };

  /** 重置回默认筛选（「待审核」——这个页面的主要用途是处理待办）。 */
  function reset() {
    setInput("");
    void load({ status: "pending", keyword: "", page: 1 });
  }

  const filtered = status !== "pending" || keyword !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">退款单号 / 订单号 / 用户</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入退款单号、订单号、用户昵称或平台 ID"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">退款状态</span>
          <select
            value={status}
            onChange={(event) =>
              void load({
                ...current,
                status: event.target.value as AdminRefundStatusFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_REFUND_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_REFUND_STATUS_FILTER_LABELS[item]}
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

      {/* Mock 标注：列表上就有「已通过」这个状态，不写清楚会被读成「钱已经退回去了」 */}
      <p className="rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {ADMIN_REFUND_MOCK_NOTICE}
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
          <p className="text-[13px] text-ink-2">{ADMIN_REFUND_EMPTY_MESSAGE}</p>
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
            <table className="w-full min-w-[1120px] border-collapse text-[13px]">
              <caption className="sr-only">
                退款申请列表，共 {result.total} 条。审核动作在每条申请的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">退款单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品</th>
                  <th scope="col" className="px-4 py-3 font-medium">退款金额</th>
                  <th scope="col" className="px-4 py-3 font-medium">退款状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">订单状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">申请时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.refundNo}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      <span className="block">{item.user.nickname || "—"}</span>
                      <span className="block text-[12px] text-ink-3">{item.user.displayId}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.orderNo}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{item.productTitle}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink">
                      {/* 第一行是**申请金额**（申请时的实付快照），第二行才是**实退金额**。
                          P0-13 起两者在部分退款下不相等，只给前者会把一笔退了一半的申请
                          显示成它实际不是的样子（下方 `ADMIN_REFUND_LIST_FIELDS_NOTE` 说明了口径） */}
                      <span className="block tabular-nums">¥{formatYuan(item.amount)}</span>
                      {item.decidedAmount === null ? null : (
                        <span className="block text-[12px] text-ink-3">
                          实退 ¥{formatYuan(item.decidedAmount)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.statusLabel}
                        tone={REFUND_STATUS_TONE[item.status]}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.orderStatusLabel}
                        tone={ORDER_STATUS_TONE[item.orderStatus]}
                      />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/refunds/${item.id}`}
                        className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        {item.status === "pending" || item.status === "reviewing"
                          ? "去审核"
                          : "查看详情"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AdminPagination
            page={result.page}
            total={result.total}
            hasMore={result.hasMore}
            pending={loadStatus === "loading"}
            onPrev={() => void load({ ...current, page: page - 1 })}
            onNext={() => void load({ ...current, page: page + 1 })}
          />
        </>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{ADMIN_REFUND_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
