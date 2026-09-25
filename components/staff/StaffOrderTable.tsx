"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminStatusBadge, { ORDER_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import Pagination from "@/components/common/Pagination";
import {
  STAFF_ORDER_EMPTY_TITLE,
  STAFF_ORDER_LIST_FIELDS_NOTE,
  STAFF_ORDER_STATUS_FILTERS,
  STAFF_ORDER_STATUS_FILTER_LABELS,
  STAFF_PAGE_SIZE,
  type StaffOrderStatusFilter,
} from "@/lib/constants/staff";
import { fetchStaffOrders } from "@/lib/services/staffHttp";
import type { StaffOrderListData } from "@/lib/types/staff";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

type LoadStatus = "ready" | "loading" | "error";

export type StaffOrderFilters = {
  status: StaffOrderStatusFilter;
  keyword: string;
  game: string;
  from: string;
  to: string;
  page: number;
};

/**
 * 客服工作台的全量订单列表（关键词 + 状态 + 游戏 + 下单日期筛选 + 分页）。
 *
 * 首屏由服务端取好（`initialResult`）传进来，本组件**不在挂载时再请求一次**，
 * 因此首屏没有加载闪烁；之后所有取数都由客服的操作触发。
 *
 * ⚠️ **本表只读**：没有任何「改状态 / 改金额 / 换人 / 退款」的按钮，
 * 操作列只有「查看详情」。客服对订单没有任何写入口，这一点由服务端的 DTO 保证
 * （`StaffOrderDetail` 上没有 `allowedActions`——本轮没有任何可执行动作）。
 *
 * ⚠️ 排序与分页窗口**由服务端决定**（创建时间降序 + 稳定次级键），本组件不重排：
 * 客户端重排会与服务端的分页窗口对不上，出现「第 2 页里有第 1 页的内容」。
 * 同样，`games` 这一列选项取自**订单里出现过的游戏名**（服务端给），
 * 不取当前商品目录——目录里新增的游戏一单都没有时，选它只会得到一次必然为空的查询。
 *
 * ⚠️ 「用户」列同时给出昵称与**两串**标识：它们是搜索命中的字段，
 * 不显示出来会出现「搜到了但看不出来为什么搜到」。
 *
 * 两串标识各有名字，不能都叫「平台 ID」：
 * - **平台 ID** 是 `displayId`——用户资料页上那串，用户报的就是它，
 *   管理端订单页给的是同一个值（`app/admin/(console)/orders/[id]/page.tsx` 的
 *   `label="平台 ID"`）。**这才是搜索框那句「平台 ID」承诺的东西**；
 * - **内部 ID** 是客服会话页一直给的那串，客服从别处粘过来时也要搜得到。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃，
 * 因此快速连点筛选不会让先发后到的旧响应覆盖新结果。
 */
export default function StaffOrderTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: StaffOrderFilters;
  initialResult: StaffOrderListData;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  /**
   * ⚠️ 服务端重新取数之后，这张表必须**采纳新的快照**。与
   * `StaffConversationTable` / `StaffRefundTable` 同因同解，完整理由见那里的注释：
   * `useState` 的初值只在首次挂载时生效，而页头的「刷新」走的 `router.refresh()`
   * **刻意保留客户端 state**（内置文档
   * `01-app/03-api-reference/04-functions/use-router.md`：merge the updated RSC payload
   * *without losing unaffected client-side React (e.g. `useState`)*），
   * 于是服务端重新查到的订单到不了屏幕上——客服点「刷新」看不到刚下的那一单。
   *
   * 判据用**引用**：`initialResult` 由服务端每次渲染重新构造，只有服务端真的重新取过数
   * 才会换引用；客服在本地筛选、翻页、输入关键词都不会动它，所以不会误伤本地状态。
   * 筛选条件随之回到地址栏口径（`initialFilters`）。
   *
   * ⚠️ 这里**只**采纳快照，不碰任何订单事实：筛选口径、排序与分页窗口仍然完全由服务端决定。
   */
  const [serverResult, setServerResult] = useState(initialResult);
  if (serverResult !== initialResult) {
    setServerResult(initialResult);
    setResult(initialResult);
    setFilters(initialFilters);
    setInput(initialFilters.keyword);
    setLoadStatus("ready");
    setError("");
    setNote("");
  }

  async function load(query: StaffOrderFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchStaffOrders({
        status: query.status,
        keyword: query.keyword,
        game: query.game,
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: STAFF_PAGE_SIZE,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setFilters(query);
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

  /** 清空全部条件并回到第 1 页。默认是「全部状态 + 不限游戏 + 不限日期」——这是一个查询页，不是待办页。 */
  function reset() {
    setInput("");
    void load({ status: "all", keyword: "", game: "", from: "", to: "", page: 1 });
  }

  const filtered =
    filters.status !== "all" ||
    filters.keyword !== "" ||
    filters.game !== "" ||
    filters.from !== "" ||
    filters.to !== "";

  return (
    <div className="flex flex-col">
      {/* 筛选栏：五类条件是叠加关系，改动任何一项都从第 1 页重新开始 */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">订单号 / 用户 / 商品</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void load({ ...filters, keyword: input.trim(), page: 1 });
              }
            }}
            placeholder="输入订单号、用户昵称、平台 ID 或商品名称（不区分大小写）"
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

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">游戏</span>
          <select
            value={filters.game}
            onChange={(event) =>
              void load({ ...filters, keyword: input.trim(), game: event.target.value, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            <option value="">全部游戏</option>
            {/* 选项取自**订单里出现过的游戏名快照**（服务端给），不是当前商品目录 */}
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
            value={filters.from}
            onChange={(event) =>
              void load({ ...filters, keyword: input.trim(), from: event.target.value, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">到</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) =>
              void load({ ...filters, keyword: input.trim(), to: event.target.value, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          />
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

      {/* 状态行：加载 / 成功 / 失败都在这里说明，表格区域各自渲染 */}
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
          <p className="text-[14px] text-ink-2">{STAFF_ORDER_EMPTY_TITLE}</p>
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
          {/* 窄屏横向滚动：列多时宁可让表格自己滚，也不把单元格压成一条缝 */}
          <div className="mt-2 overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[1120px] border-collapse text-[13px]">
              <caption className="sr-only">
                全量订单列表，共 {result.total} 条。按创建时间倒序排列，点订单号或「查看详情」进入只读详情。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品 / 规格</th>
                  <th scope="col" className="px-4 py-3 font-medium">数量</th>
                  <th scope="col" className="px-4 py-3 font-medium">实收金额</th>
                  <th scope="col" className="px-4 py-3 font-medium">游戏</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">创建时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/staff/orders/${item.id}`}
                        className="font-mono text-[12px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        {item.orderNo}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {/* 昵称与两串标识都在这里：它们是搜索命中的字段，
                          不显示出来会出现「搜到了但看不出来为什么搜到」。
                          用户记录缺失时平台 ID 是空串——那一行不渲染，
                          而不是显示一串查无此人的值 */}
                      <span className="block">{item.user.nickname || "—"}</span>
                      {item.user.displayId ? (
                        <span className="block font-mono text-[12px] text-ink-3">
                          平台 ID {item.user.displayId}
                        </span>
                      ) : null}
                      <span className="block font-mono text-[12px] text-ink-3">
                        内部 ID {item.user.id}
                      </span>
                    </td>
                    <td className="max-w-[220px] px-4 py-3 text-ink-2">
                      <span className="block line-clamp-1">{item.productTitle}</span>
                      <span className="block line-clamp-1 text-[12px] text-ink-3">
                        {item.specName}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">{item.quantity}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums text-ink">
                      ¥{formatYuan(item.totalAmount)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">{item.gameName}</td>
                    <td className="px-4 py-3">
                      {/* 状态色只有一个来源（`ORDER_STATUS_TONE`），页面不写死颜色 */}
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
                        href={`/staff/orders/${item.id}`}
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
            onPrev={() => void load({ ...filters, page: filters.page - 1 })}
            onNext={() => void load({ ...filters, page: filters.page + 1 })}
          />
        </>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_ORDER_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
