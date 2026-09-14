"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { ORDER_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_ORDER_EMPTY_MESSAGE,
  ADMIN_ORDER_LIST_FIELDS_NOTE,
  ADMIN_ORDER_PAGE_SIZE,
  ADMIN_ORDER_PAYMENT_NOTICE,
  ADMIN_ORDER_STATUS_FILTERS,
  ADMIN_ORDER_STATUS_FILTER_LABELS,
  type AdminOrderStatusFilter,
} from "@/lib/constants/adminOrders";
import { fetchAdminOrders } from "@/lib/services/adminHttp";
import type { AdminOrderListData } from "@/lib/types/order";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminOrderFilters = {
  status: AdminOrderStatusFilter;
  keyword: string;
  game: string;
  from: string;
  to: string;
  page: number;
};

/**
 * 管理端全量订单列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件**不在挂载时再请求一次**，
 * 因此首屏没有加载闪烁；之后所有取数都由用户操作触发（切状态、搜索、改日期、翻页）。
 *
 * ⚠️ **本表只读**：没有任何「改状态 / 改金额」的按钮，操作列只有「查看详情」（§订单管理）。
 * 这一点也写在 DTO 里——`AdminOrderDetail` 上没有 `allowedActions` 字段。
 *
 * ⚠️ **筛选区不带任何用户标识**：后台看的是全部用户的订单，这是这一页存在的理由；
 * 而「能看」这件事由服务端的 `requireAdmin()` 决定，不由界面决定。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃，
 * 因此快速连点筛选不会让先发后到的旧响应覆盖新结果。
 */
export default function AdminOrderTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminOrderFilters;
  initialResult: AdminOrderListData;
}) {
  const [status, setStatus] = useState<AdminOrderStatusFilter>(initialFilters.status);
  const [game, setGame] = useState(initialFilters.game);
  const [from, setFrom] = useState(initialFilters.from);
  const [to, setTo] = useState(initialFilters.to);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminOrderFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminOrders({
        status: query.status,
        keyword: query.keyword,
        game: query.game,
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: ADMIN_ORDER_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setStatus(query.status);
      setGame(query.game);
      setFrom(query.from);
      setTo(query.to);
      setKeyword(query.keyword);
      setPage(next.page);
      setLoadStatus("ready");
      // 成功反馈是显式的：筛选后「什么都没变」与「筛完只剩这些」看起来一样，
      // 一行结果说明让人知道这次请求确实回来了
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  /** 当前筛选（用于重试与翻页：它们不该悄悄改掉用户已经选好的条件）。 */
  const current: AdminOrderFilters = { status, keyword, game, from, to, page };

  /** 清空全部条件并回到第 1 页。默认状态是「全部」——这是一个查询页，不是待办页。 */
  function reset() {
    setInput("");
    void load({ status: "all", keyword: "", game: "", from: "", to: "", page: 1 });
  }

  const filtered = status !== "all" || game !== "" || keyword !== "" || from !== "" || to !== "";

  return (
    <div className="flex flex-col">
      {/* 筛选栏：五类条件是叠加关系，改动任何一项都从第 1 页重新开始 */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">订单号 / 用户 / 商品</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入订单号、用户昵称、平台 ID 或商品名称"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">状态</span>
          <select
            value={status}
            onChange={(event) =>
              void load({
                ...current,
                status: event.target.value as AdminOrderStatusFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_ORDER_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_ORDER_STATUS_FILTER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">游戏</span>
          <select
            value={game}
            onChange={(event) => void load({ ...current, game: event.target.value, page: 1 })}
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            <option value="">全部游戏</option>
            {/* 选项取自**订单里出现过的游戏名快照**，不是当前商品目录：
                目录里新加的游戏一单都没有时，选它只会得到一次必然为空的查询 */}
            {result.games.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">下单日期从</span>
          <input
            type="date"
            value={from}
            onChange={(event) => void load({ ...current, from: event.target.value, page: 1 })}
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">到</span>
          <input
            type="date"
            value={to}
            onChange={(event) => void load({ ...current, to: event.target.value, page: 1 })}
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
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

      {/* 状态行：加载 / 成功 / 失败都在这里说明，表格区域各自渲染 */}
      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[18px] text-[12px] leading-[18px] text-ink-3"
      >
        {loadStatus === "loading" ? "加载中…" : note}
      </p>

      {loadStatus === "error" ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
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
        <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">{ADMIN_ORDER_EMPTY_MESSAGE}</p>
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
          {/*
            窄屏横向滚动：后台表格列多，缩到 768px 时宁可让表格自己滚，
            也不把单元格压成一条缝或让侧栏盖住内容
          */}
          <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[1040px] border-collapse text-[13px]">
              <caption className="sr-only">
                全量订单列表，共 {result.total} 条。订单详情为只读视图。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品 / 规格</th>
                  <th scope="col" className="px-4 py-3 font-medium">游戏</th>
                  <th scope="col" className="px-4 py-3 font-medium">实付金额</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">下单时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.orderNo}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {/* 昵称与平台 ID 都在这里：它们是搜索命中的字段，
                          不显示出来会出现「搜到了但看不出来为什么搜到」 */}
                      <span className="block">{item.user.nickname || "—"}</span>
                      <span className="block text-[12px] text-ink-3">{item.user.displayId}</span>
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      <span className="block">{item.productTitle}</span>
                      <span className="block text-[12px] text-ink-3">
                        {item.specName} × {item.quantity}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-2">{item.gameName}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink">
                      ¥{formatYuan(item.totalAmount)}
                    </td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.statusLabel}
                        tone={ORDER_STATUS_TONE[item.status]}
                      />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/orders/${item.id}`}
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

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        {ADMIN_ORDER_LIST_FIELDS_NOTE}
        {ADMIN_ORDER_PAYMENT_NOTICE}
      </p>
    </div>
  );
}
