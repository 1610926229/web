"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { STAFF_STATE_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_STAFF_EMPTY_MESSAGE,
  ADMIN_STAFF_LIST_FIELDS_NOTE,
  ADMIN_STAFF_PAGE_SIZE,
  ADMIN_STAFF_STATE_FILTERS,
  ADMIN_STAFF_STATE_FILTER_LABELS,
  type AdminStaffStateFilter,
} from "@/lib/constants/adminStaff";
import { fetchAdminStaffList } from "@/lib/services/adminHttp";
import type { AdminStaffListData } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminStaffFilters = {
  state: AdminStaffStateFilter;
  keyword: string;
  page: number;
};

/**
 * 管理端客服账号列表的交互部分。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表不含 Cookie、密码与会话标识**：这三样在客服账号里根本不存在
 * （本阶段是 Mock 认证，记录里没有密码字段）。列表上也没有「重置密码」这类入口——
 * 给出一个点了没用的按钮，比没有按钮更让人困惑。
 *
 * 状态角标用的是**服务端算好的** `state` 与 `stateLabel`：已移除优先于启用 / 停用，
 * 页面不自己拿 `enabled` 推。推错一次就会出现「列表说已移除、详情说已停用」。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function AdminStaffTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminStaffFilters;
  initialResult: AdminStaffListData;
}) {
  const [state, setState] = useState<AdminStaffStateFilter>(initialFilters.state);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminStaffFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminStaffList({
        state: query.state,
        keyword: query.keyword,
        page: query.page,
        pageSize: ADMIN_STAFF_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setState(query.state);
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

  const current: AdminStaffFilters = { state, keyword, page };

  /** 重置回默认筛选（全部状态）。 */
  function reset() {
    setInput("");
    void load({ state: "all", keyword: "", page: 1 });
  }

  const filtered = state !== "all" || keyword !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">登录名 / 客服名称</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
            }}
            placeholder="输入登录名或客服名称（不区分大小写）"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">账号状态</span>
          <select
            value={state}
            onChange={(event) =>
              void load({ ...current, state: event.target.value as AdminStaffStateFilter, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_STAFF_STATE_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_STAFF_STATE_FILTER_LABELS[item]}
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

      {/* 三个状态的条数统计的是**全部账号**，不是当前筛选结果：
          角标要回答的是「已停用的有几个」，而不是「在只显示已停用的列表里有几个」 */}
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        启用中 {result.counts.enabled} · 已停用 {result.counts.disabled} · 已移除{" "}
        {result.counts.removed} · 全部 {result.counts.total}
      </p>

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
          <p className="text-[13px] text-ink-2">{ADMIN_STAFF_EMPTY_MESSAGE}</p>
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
                客服账号列表，共 {result.total} 条。启停与移除在每条账号的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">客服</th>
                  <th scope="col" className="px-4 py-3 font-medium">登录名</th>
                  <th scope="col" className="px-4 py-3 font-medium">角色</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">上次登录</th>
                  <th scope="col" className="px-4 py-3 font-medium">创建时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">更新时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <img
                          src={item.avatarUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded-full border border-admin-line object-cover"
                        />
                        <span className="min-w-0 text-ink">{item.displayName}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.username}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">{item.roleLabel}</td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.stateLabel}
                        tone={STAFF_STATE_TONE[item.state]}
                      />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {/* 从未登录用「从未登录」而不是破折号：两者含义不同，
                          「—」会让人以为数据缺了 */}
                      {item.lastLoginAt ? formatDateTime(item.lastLoginAt) : "从未登录"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.updatedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/customer-service/${item.id}`}
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

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{ADMIN_STAFF_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
