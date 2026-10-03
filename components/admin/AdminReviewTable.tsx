"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminReviewDimensions from "@/components/admin/AdminReviewDimensions";
import AdminReviewStatusBadge from "@/components/admin/AdminReviewStatusBadge";
import type { AdminReviewStatusFilter } from "@/lib/constants/adminReviews";
import {
  REVIEW_PAGE_SIZE,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
} from "@/lib/constants/reviews";
import { fetchAdminReviews } from "@/lib/services/adminHttp";
import type { AdminReviewListData } from "@/lib/types/review";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminReviewFilters = {
  status: AdminReviewStatusFilter;
  keyword: string;
  page: number;
};

/**
 * 管理端评价审核列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表只读**：操作列只有「去审核」链接，四个动作都在详情页。
 * 列表行上放「通过」等于让人闭着眼睛批准一条会立刻出现在商品页与打手页上的内容。
 *
 * ⚠️ 状态角标（`counts`）由**服务端**给出且不受筛选 / 分页影响：它回答的是
 * 「后台一共有多少条处于该状态」，用于决定要不要去看这一页。前端不自己累加——
 * 那样会随翻页变化，角标就成了另一个数。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function AdminReviewTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminReviewFilters;
  initialResult: AdminReviewListData;
}) {
  const [status, setStatus] = useState<AdminReviewStatusFilter>(initialFilters.status);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminReviewFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminReviews({
        status: query.status,
        keyword: query.keyword,
        page: query.page,
        pageSize: REVIEW_PAGE_SIZE,
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

  const current: AdminReviewFilters = { status, keyword, page };

  /** 重置回默认筛选（「待审核」——这个页面的主要用途是处理待办）。 */
  function reset() {
    setInput("");
    void load({ status: "pending", keyword: "", page: 1 });
  }

  const filtered = status !== "pending" || keyword !== "";
  const totalAll = REVIEW_STATUSES.reduce((sum, key) => sum + result.counts[key], 0);

  return (
    <div className="flex flex-col">
      {/* 状态角标：点击即筛选。数字来自服务端，与当前页显示了多少条无关 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-admin-line bg-surface p-4">
        <StatusChip
          label="全部"
          count={totalAll}
          active={status === "all"}
          onClick={() => void load({ ...current, status: "all", page: 1 })}
        />
        {REVIEW_STATUSES.map((key) => (
          <StatusChip
            key={key}
            label={REVIEW_STATUS_LABELS[key]}
            count={result.counts[key]}
            active={status === key}
            onClick={() => void load({ ...current, status: key, page: 1 })}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">订单号 / 评价编号 / 商品 / 规格 / 打手</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入订单号、评价编号、商品名、规格名或打手名"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
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
          <p className="text-[13px] text-ink-2">当前筛选下没有评价。</p>
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
            <table className="w-full min-w-[1240px] border-collapse text-[13px]">
              <caption className="sr-only">
                评价审核列表，共 {result.total} 条。四个审核动作在每条评价的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品</th>
                  <th scope="col" className="px-4 py-3 font-medium">作者</th>
                  <th scope="col" className="px-4 py-3 font-medium">评价内容</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">原因</th>
                  <th scope="col" className="px-4 py-3 font-medium">提交时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.orderNo}
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      <span className="block max-w-[200px] truncate">{item.productTitle}</span>
                      <span className="block text-[12px] text-ink-3">
                        {item.specName} · ×{item.quantity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {/* 后台看的是 `AdminUserSummary`（与订单 / 退款 / 投诉同一套），
                          不是公开面的脱敏昵称——审核要能回答「这是谁写的」（D13 只管公开面） */}
                      <span className="block">{item.user.nickname || "—"}</span>
                      <span className="block text-[12px] text-ink-3">{item.user.displayId}</span>
                    </td>
                    <td className="px-4 py-3">
                      <AdminReviewDimensions
                        productReview={item.productReview}
                        companionReview={item.companionReview}
                        compact
                      />
                    </td>
                    <td className="px-4 py-3">
                      <AdminReviewStatusBadge status={item.status} label={item.statusLabel} />
                    </td>
                    <td className="px-4 py-3">
                      <ReasonCell item={item} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/reviews/${item.id}`}
                        className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        {item.allowedActions.canApprove ? "去审核" : "查看详情"}
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
    </div>
  );
}

/** 状态筛选胶囊：文字 + 数量，选中态用底色区分（不靠颜色单独表达，`aria-pressed` 也在）。 */
function StatusChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] ${
        active
          ? "bg-admin-accent font-medium text-white"
          : "border border-admin-line text-ink-2 hover:bg-page"
      }`}
    >
      {label}
      <span className={`text-[12px] ${active ? "text-white/80" : "text-ink-3"}`}>{count}</span>
    </button>
  );
}

/**
 * 原因列：只显示**当前状态对应的那一个**原因。
 *
 * 驳回原因与隐藏原因是两件不同的事（前者要求用户改，后者是平台主动撤下），
 * 把两条都摊在列表里会让管理员分不清这条评价现在为什么不可见。
 */
function ReasonCell({ item }: { item: AdminReviewListData["items"][number] }) {
  const reason =
    item.status === "rejected"
      ? item.rejectReason
      : item.status === "hidden"
        ? item.hideReason
        : null;

  if (!reason) return <span className="text-[12px] text-ink-3">—</span>;

  return (
    <span className="line-clamp-2 block max-w-[220px] break-words text-[12px] leading-4 text-ink-2">
      {reason}
    </span>
  );
}
