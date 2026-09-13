"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { APPLICATION_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_APPLICATION_ACTION_LABELS,
  ADMIN_APPLICATION_EMPTY_MESSAGE,
  ADMIN_APPLICATION_PAGE_SIZE,
  ADMIN_APPLICATION_STATUS_FILTERS,
  ADMIN_APPLICATION_STATUS_FILTER_LABELS,
  type AdminApplicationStatusFilter,
} from "@/lib/constants/adminApplications";
import { formatDateTime } from "@/lib/utils/format";
import { fetchAdminApplications } from "@/lib/services/adminHttp";
import type { AdminApplicationListData } from "@/lib/types/companionApplication";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminApplicationFilters = {
  status: AdminApplicationStatusFilter;
  keyword: string;
  gameId: string;
  page: number;
};

/**
 * 管理端入驻申请列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件**不在挂载时再请求一次**，
 * 因此首屏没有加载闪烁；之后所有取数都由用户操作触发（切状态、搜索、翻页），
 * 请求由谁发起是明确的。
 *
 * ⚠️ **本表只读**：没有任何审核按钮。三个审核动作都在详情页——那里能看到申请正文、
 * 凭证与申请人摘要，而「通过」会真的建出一条护航资料并发资格。
 * 把这种动作放在只看得见单号与昵称的列表上，等于让人闭着眼睛点。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃，
 * 因此快速连点筛选不会让先发后到的旧响应覆盖新结果。
 */
export default function AdminApplicationTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminApplicationFilters;
  initialResult: AdminApplicationListData;
}) {
  const [status, setStatus] = useState<AdminApplicationStatusFilter>(initialFilters.status);
  const [gameId, setGameId] = useState(initialFilters.gameId);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(
    query: { status: AdminApplicationStatusFilter; keyword: string; gameId: string; page: number },
  ) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminApplications({
        status: query.status,
        keyword: query.keyword,
        gameId: query.gameId,
        page: query.page,
        pageSize: ADMIN_APPLICATION_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setStatus(query.status);
      setGameId(query.gameId);
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

  function search() {
    void load({ status, keyword: input.trim(), gameId, page: 1 });
  }

  const filtered = status !== "all" || gameId !== "" || keyword !== "";

  return (
    <div className="flex flex-col">
      {/* 筛选栏：搜索、状态、游戏三者是叠加条件，切换任何一项都从第 1 页重新开始 */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">单号 / 昵称</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search();
            }}
            placeholder="输入申请单号或陪玩昵称"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">状态</span>
          <select
            value={status}
            onChange={(event) =>
              void load({
                status: event.target.value as AdminApplicationStatusFilter,
                keyword,
                gameId,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_APPLICATION_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_APPLICATION_STATUS_FILTER_LABELS[item]}
                {item === "all" ? "" : `（${result.counts[item]}）`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">游戏</span>
          <select
            value={gameId}
            onChange={(event) =>
              void load({ status, keyword, gameId: event.target.value, page: 1 })
            }
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

        <button
          type="button"
          onClick={search}
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
              void load({ status: "pending", keyword: "", gameId: "", page: 1 });
            }}
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
            onClick={() => void load({ status, keyword, gameId, page })}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {loadStatus !== "error" && result.items.length === 0 ? (
        <div className="rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">{ADMIN_APPLICATION_EMPTY_MESSAGE}</p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setInput("");
                void load({ status: "pending", keyword: "", gameId: "", page: 1 });
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
          {/*
            窄屏横向滚动：后台表格列多，缩到 768px 时宁可让表格自己滚，
            也不把单元格压成一条缝或让侧栏盖住内容
          */}
          <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[960px] border-collapse text-[13px]">
              <caption className="sr-only">
                入驻申请列表，共 {result.total} 条。审核动作在每条申请的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">申请单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">申请人</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">游戏 / 大区</th>
                  <th scope="col" className="px-4 py-3 font-medium">提交时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">最近更新</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.applicationNo}
                    </td>
                    <td className="px-4 py-3 text-ink">{item.displayName}</td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.statusLabel}
                        tone={APPLICATION_STATUS_TONE[item.status]}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink-2">
                      <span className="block">{item.games.map((game) => game.name).join("、")}</span>
                      <span className="block text-[12px] text-ink-3">
                        {item.regions.join("、")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.submittedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.updatedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/applications/${item.id}`}
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
            onPrev={() => void load({ status, keyword, gameId, page: page - 1 })}
            onNext={() => void load({ status, keyword, gameId, page: page + 1 })}
          />
        </>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        列表不展示申请正文、联系方式、凭证与审核意见；{ADMIN_APPLICATION_ACTION_LABELS.startReview} /{" "}
        {ADMIN_APPLICATION_ACTION_LABELS.approve} / {ADMIN_APPLICATION_ACTION_LABELS.reject}
        在详情页执行。
      </p>
    </div>
  );
}
