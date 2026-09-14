"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Pagination from "@/components/common/Pagination";
import {
  STAFF_CONVERSATION_EMPTY_DESCRIPTION,
  STAFF_CONVERSATION_EMPTY_TITLE,
  STAFF_CONVERSATION_LIST_FIELDS_NOTE,
  STAFF_ORDER_STATUS_FILTERS,
  STAFF_ORDER_STATUS_FILTER_LABELS,
  STAFF_PAGE_SIZE,
  type StaffOrderStatusFilter,
} from "@/lib/constants/staff";
import { fetchStaffConversations } from "@/lib/services/staffHttp";
import type { StaffConversationListData } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";

type LoadStatus = "ready" | "loading" | "error";

export type StaffConversationFilters = {
  keyword: string;
  unreadOnly: boolean;
  status: StaffOrderStatusFilter;
  page: number;
};

/**
 * 客服工作台的会话列表（搜索 + 未读筛选 + 订单状态筛选 + 分页）。
 *
 * 首屏由服务端取好（`initialResult`）传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ 列表项**不含游戏 ID、订单备注与完整消息历史**（见
 * `StaffConversationListItem` 的字段表）。这里也不做「展开看全文」——
 * 要看全文就点进详情页，那一次请求才会带上消息。
 *
 * ⚠️ 未读数（最后一个「未读」列）是**当前登录客服**的口径，不是用户侧的未读数：
 * 客服读了不清用户的未读，用户读了也不清客服的未读。因此这一列不是「这条会话
 * 有没有人没看」，而是「**我**还有没有要处理的」。
 *
 * ⚠️ 排序由**服务端**决定（最后消息时间倒序，订单号兜底），本组件不重排：
 * 客户端重排会与服务端的分页窗口对不上，出现「第 2 页里有第 1 页的内容」。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function StaffConversationTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: StaffConversationFilters;
  initialResult: StaffConversationListData;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: StaffConversationFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchStaffConversations({
        keyword: query.keyword,
        unreadOnly: query.unreadOnly,
        status: query.status,
        page: query.page,
        pageSize: STAFF_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setFilters(query);
      setLoadStatus("ready");
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  function reset() {
    setInput("");
    void load({ keyword: "", unreadOnly: false, status: "all", page: 1 });
  }

  const filtered = filters.keyword !== "" || filters.unreadOnly || filters.status !== "all";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">订单号 / 用户昵称 / 商品名</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void load({ ...filters, keyword: input.trim(), page: 1 });
              }
            }}
            placeholder="输入订单号、用户昵称或商品名（不区分大小写）"
            className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">订单状态</span>
          <select
            value={filters.status}
            onChange={(event) =>
              void load({
                ...filters,
                keyword: input.trim(),
                status: event.target.value as StaffOrderStatusFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {STAFF_ORDER_STATUS_FILTERS.map((item) => (
              <option key={item} value={item}>
                {STAFF_ORDER_STATUS_FILTER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex h-9 items-center gap-2 rounded-lg border border-admin-line px-3 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={filters.unreadOnly}
            onChange={(event) =>
              void load({
                ...filters,
                keyword: input.trim(),
                unreadOnly: event.target.checked,
                page: 1,
              })
            }
          />
          只看未读
        </label>

        <button
          type="button"
          onClick={() => void load({ ...filters, keyword: input.trim(), page: 1 })}
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
            onClick={() => void load(filters)}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {loadStatus !== "error" && result.items.length === 0 ? (
        <div className="mt-2 rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[14px] text-ink-2">{STAFF_CONVERSATION_EMPTY_TITLE}</p>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            {STAFF_CONVERSATION_EMPTY_DESCRIPTION}
          </p>
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
            <table className="w-full min-w-[1080px] border-collapse text-[13px]">
              <caption className="sr-only">
                会话列表，共 {result.total} 条。按最后一条消息时间倒序排列，点订单号进入沟通页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品</th>
                  <th scope="col" className="px-4 py-3 font-medium">订单状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">最后消息</th>
                  <th scope="col" className="px-4 py-3 font-medium">发送者</th>
                  <th scope="col" className="px-4 py-3 font-medium">时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">未读</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.orderId} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/staff/conversations/${item.orderId}`}
                        className="font-mono text-[12px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        {item.orderNo}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">{item.userNickname}</td>
                    <td className="max-w-[220px] px-4 py-3 text-ink-2">
                      <span className="line-clamp-1">{item.productTitle}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">
                      {item.orderStatusLabel}
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-ink-2">
                      {/* 一条消息都没有的会话不该出现在列表里（列表口径就是「有沟通记录」），
                          但仓储真给出一条空会话时，这里显示「暂无消息」而不是空白单元格 */}
                      <span className="line-clamp-1">
                        {item.lastMessageBody ?? "暂无消息"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {item.lastMessageRoleLabel ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {item.lastMessageAt ? formatDateTime(item.lastMessageAt) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {item.unreadCount > 0 ? (
                        // 实心红底白字，与用户端客服页的未读角标同一个样式：
                        // 同一个含义在两个端上不该长成两个样子
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-red px-1.5 text-[11px] leading-none text-white">
                          {item.unreadCount}
                        </span>
                      ) : (
                        // 0 也用文字写出来：空单元格会让人分不清「没有未读」和「没算出来」
                        <span className="text-[12px] text-ink-3">0</span>
                      )}
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
            onPrev={() => void load({ ...filters, page: filters.page - 1 })}
            onNext={() => void load({ ...filters, page: filters.page + 1 })}
          />
        </>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_CONVERSATION_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
