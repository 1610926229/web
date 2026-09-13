"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { COMPANION_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_COMPANION_EMPTY_MESSAGE,
  ADMIN_COMPANION_PAGE_SIZE,
  ADMIN_COMPANION_REMOVAL_FILTERS,
  ADMIN_COMPANION_REMOVAL_FILTER_LABELS,
  ADMIN_COMPANION_STATE_FILTERS,
  ADMIN_COMPANION_STATE_FILTER_LABELS,
  adminCompanionStatus,
  type AdminCompanionRemovalFilter,
  type AdminCompanionStateFilter,
} from "@/lib/constants/adminCompanions";
import { fetchAdminCompanions } from "@/lib/services/adminHttp";
import type { AdminCompanionListData } from "@/lib/types/companion";

type LoadStatus = "ready" | "loading" | "error";

export type AdminCompanionFilters = {
  keyword: string;
  gameId: string;
  state: AdminCompanionStateFilter;
  removal: AdminCompanionRemovalFilter;
  page: number;
};

/**
 * 管理端护航名单的交互部分。
 *
 * ⚠️ **这里看到的是全部记录**（含已停用与已移除），与用户端公开列表不是一回事：
 * 公开列表只出现在架且未移除的记录。两个口径都来自**同一份数据源**，
 * 由数据层按各自的筛选条件区分，页面不自己过滤。
 *
 * 与其他管理端列表一样：首屏由服务端取好，之后的筛选与翻页在浏览器里发起请求，
 * 每次请求领一个序号，先发后到的旧响应会被丢弃。
 *
 * ⚠️ 本表**只读**：编辑资料与启用 / 停用 / 暂停 / 移除都在详情页。
 * 表格里放一排会改数据的按钮，等于把「改错了」的概率乘上每一行。
 */
export default function AdminCompanionTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminCompanionFilters;
  initialResult: AdminCompanionListData;
}) {
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [gameId, setGameId] = useState(initialFilters.gameId);
  const [state, setState] = useState<AdminCompanionStateFilter>(initialFilters.state);
  const [removal, setRemoval] = useState<AdminCompanionRemovalFilter>(initialFilters.removal);
  const [page, setPage] = useState(initialFilters.page);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminCompanionFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminCompanions({ ...query, pageSize: ADMIN_COMPANION_PAGE_SIZE });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setKeyword(query.keyword);
      setGameId(query.gameId);
      setState(query.state);
      setRemoval(query.removal);
      setPage(next.page);
      setLoadStatus("ready");
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  const current: AdminCompanionFilters = { keyword, gameId, state, removal, page };
  const filtered = state !== "all" || removal !== "active" || gameId !== "" || keyword !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">昵称 / 介绍 / 标签</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void load({ ...current, keyword: input.trim(), page: 1 });
              }
            }}
            placeholder="输入关键词"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">游戏</span>
          <select
            value={gameId}
            onChange={(event) => void load({ ...current, gameId: event.target.value, page: 1 })}
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            <option value="">全部游戏</option>
            {result.games.map((game) => (
              <option key={game.id} value={game.id}>
                {game.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">状态</span>
          <select
            value={state}
            onChange={(event) =>
              void load({
                ...current,
                state: event.target.value as AdminCompanionStateFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_COMPANION_STATE_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_COMPANION_STATE_FILTER_LABELS[item]}
                {item === "all" ? "" : `（${result.counts[item]}）`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">移除状态</span>
          <select
            value={removal}
            onChange={(event) =>
              void load({
                ...current,
                removal: event.target.value as AdminCompanionRemovalFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_COMPANION_REMOVAL_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_COMPANION_REMOVAL_FILTER_LABELS[item]}
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
            onClick={() => {
              setInput("");
              void load({ keyword: "", gameId: "", state: "all", removal: "active", page: 1 });
            }}
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
          <p className="text-[13px] text-ink-2">{ADMIN_COMPANION_EMPTY_MESSAGE}</p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setInput("");
                void load({ keyword: "", gameId: "", state: "all", removal: "active", page: 1 });
              }}
              className="mt-3 rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
            >
              重置筛选
            </button>
          ) : null}
        </div>
      ) : null}

      {result.items.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[1040px] border-collapse text-[13px]">
              <caption className="sr-only">
                护航名单，共 {result.total} 条。资料编辑与状态操作在每条记录的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">陪玩昵称</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">游戏 / 大区</th>
                  <th scope="col" className="px-4 py-3 font-medium">服务标签</th>
                  <th scope="col" className="px-4 py-3 font-medium">排序</th>
                  <th scope="col" className="px-4 py-3 font-medium">统计（只读）</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => {
                  const status = adminCompanionStatus(item);

                  return (
                    <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {/* 头像来自白名单 Mock 占位图，装饰性内容不进读屏 */}
                          <img
                            src={item.avatarUrl}
                            alt=""
                            className="h-8 w-8 shrink-0 rounded-full border border-admin-line object-cover"
                          />
                          <div className="min-w-0">
                            <span className="block truncate text-ink">{item.displayName}</span>
                            <span className="block font-mono text-[12px] text-ink-3">{item.id}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <AdminStatusBadge
                          label={status.label}
                          description={status.description}
                          tone={COMPANION_STATUS_TONE[status.key]}
                        />
                        {item.available ? null : item.unavailableReason ? (
                          <span className="mt-1 block text-[12px] text-ink-3">
                            原因：{item.unavailableReason}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        <span className="block">
                          {item.games.map((game) => game.name).join("、")}
                        </span>
                        <span className="block text-[12px] text-ink-3">
                          {item.regions.join("、")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ink-2">{item.serviceTags.join("、")}</td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">{item.sortOrder}</td>
                      <td className="px-4 py-3 text-[12px] text-ink-3">
                        {/* 评分可能为空（新护航还没有评价），空值显示「—」而不是 0，两者含义不同 */}
                        <span className="block">
                          评分 {item.rating === null ? "—" : item.rating.toFixed(1)}
                        </span>
                        <span className="block">
                          完成 {item.completedOrderCount} · 评价 {item.reviewCount} · 鸡腿{" "}
                          {item.tipsCount}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link
                          href={`/admin/companions/${item.id}`}
                          className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
                        >
                          {item.removedAt ? "查看（已移除）" : "查看 / 编辑"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
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
        「已移除」的记录只在把「移除状态」切到已移除时出现；它们的订单、评价与鸡腿记录都还在。
      </p>
    </div>
  );
}
