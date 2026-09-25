"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/common/Pagination";
import AdminStatusBadge, {
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
} from "@/components/admin/AdminStatusBadge";
import {
  STAFF_REFUND_EMPTY_MESSAGE,
  STAFF_REFUND_LIST_FIELDS_NOTE,
  STAFF_REFUND_MOCK_NOTICE,
  STAFF_REFUND_STATUS_FILTERS,
  STAFF_REFUND_STATUS_FILTER_LABELS,
  type StaffRefundStatusFilter,
} from "@/lib/constants/staffRefunds";
import { STAFF_PAGE_SIZE } from "@/lib/constants/staff";
import { fetchStaffRefunds } from "@/lib/services/staffRefundsHttp";
import type { StaffRefundListData } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type StaffRefundFilters = {
  status: StaffRefundStatusFilter;
  keyword: string;
  page: number;
};

/**
 * 客服工作台的退款列表（搜索 + 状态筛选 + 分页）。
 *
 * 首屏由服务端取好（`initialResult`）传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表只读**：操作列只有「查看详情」链接。开始审核与驳回两个动作都在详情页——
 * 那里能看到退款原因、说明与凭证，才能决定该不该动手。
 *
 * ⚠️ 列表同时显示**退款状态**与**订单状态**两列，这是刻意的：
 * 它们是两条独立的线，把两者摆在一起，客服才能一眼看出
 * 「这笔退款已批了，可订单还停在护航中」这类中间状态是正常的。
 *
 * ⚠️ 列表项**不含**退款原因、说明、凭证、审核意见，也**没有** OpenID / UnionID /
 * 游戏 ID / 订单备注（字段表见 `StaffRefundListItem`）。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function StaffRefundTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: StaffRefundFilters;
  initialResult: StaffRefundListData;
}) {
  const [status, setStatus] = useState<StaffRefundStatusFilter>(initialFilters.status);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  /**
   * ⚠️ 服务端重新取数之后，这张表必须**采纳新的快照**。与
   * `StaffComplaintTable` 同因同解，完整理由见那里的注释：`useState` 的初值只在
   * 首次挂载时生效，而「刷新」走的 `router.refresh()` **刻意保留客户端 state**
   * （内置文档 `01-app/03-api-reference/04-functions/use-router.md`），
   * 于是服务端重新查到的退款申请到不了屏幕上——客服点「刷新」看不到用户刚提交的申请。
   *
   * 判据用**引用**：`initialResult` 只有服务端真的重新取过数才会换引用。
   */
  const [serverResult, setServerResult] = useState(initialResult);
  if (serverResult !== initialResult) {
    setServerResult(initialResult);
    setResult(initialResult);
    setStatus(initialFilters.status);
    setKeyword(initialFilters.keyword);
    setInput(initialFilters.keyword);
    setPage(initialFilters.page);
    setLoadStatus("ready");
    setError("");
    setNote("");
  }

  async function load(query: StaffRefundFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchStaffRefunds({
        status: query.status,
        keyword: query.keyword,
        page: query.page,
        pageSize: STAFF_PAGE_SIZE,
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

  const current: StaffRefundFilters = { status, keyword, page };

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
          <span className="text-[12px] text-ink-3">退款单号 / 订单号 / 用户昵称</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入退款单号、订单号或用户昵称（不区分大小写）"
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
                status: event.target.value as StaffRefundStatusFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {STAFF_REFUND_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {STAFF_REFUND_STATUS_FILTER_LABELS[item]}
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
        {STAFF_REFUND_MOCK_NOTICE}
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
          <p className="text-[13px] text-ink-2">{STAFF_REFUND_EMPTY_MESSAGE}</p>
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
            <table className="w-full min-w-[1040px] border-collapse text-[13px]">
              <caption className="sr-only">
                退款申请列表，共 {result.total} 条。开始审核与驳回在每条申请的详情页。
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
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-admin-line bg-page text-[10px] text-ink-3">
                          {item.user.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- Mock 头像占位图
                            <img src={item.user.avatarUrl} alt="" className="h-full w-full object-cover" />
                          ) : null}
                        </span>
                        <span className="text-ink">{item.user.nickname || "—"}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.orderNo}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{item.productTitle}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink">
                      {/* 第一行是**申请金额**（申请时的实付快照），第二行才是**实退金额**。
                          P0-13 起部分退款下两者不相等，只给前者会让客服照着它回答
                          「退了多少钱」——而那个数管理员压根没批过 */}
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
                        href={`/staff/refunds/${item.id}`}
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

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_REFUND_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
