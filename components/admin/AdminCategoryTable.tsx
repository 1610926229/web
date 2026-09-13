"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { CATEGORY_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_CATALOG_REMOVAL_FILTER_LABELS,
  ADMIN_CATALOG_REMOVAL_FILTERS,
  ADMIN_ENABLED_FILTER_LABELS,
  ADMIN_ENABLED_FILTERS,
  type AdminCatalogRemovalFilter,
  type AdminEnabledFilter,
} from "@/lib/constants/adminCatalog";
import {
  ADMIN_CATEGORY_EMPTY_MESSAGE,
  ADMIN_CATEGORY_PAGE_SIZE,
  ADMIN_CATEGORY_REMOVED_EMPTY_MESSAGE,
  adminCategoryStatus,
} from "@/lib/constants/adminCategories";
import { fetchAdminCategories } from "@/lib/services/adminHttp";
import type { AdminCategoryListData } from "@/lib/types/catalog";

type LoadStatus = "ready" | "loading" | "error";

export type AdminCategoryFilters = {
  keyword: string;
  gameId: string;
  enabled: AdminEnabledFilter;
  removal: AdminCatalogRemovalFilter;
  page: number;
};

/**
 * 管理端类目列表的交互部分。
 *
 * ⚠️ 这里看到的是**全部**类目：启用中的、停用的、已移除的。
 * 用户端的分类导航只看得到「启用且未移除」的那些——两个口径都来自
 * **同一份数据源**，由数据层按各自的筛选条件区分，页面不自己过滤。
 *
 * 与其他管理端列表一样：首屏由服务端取好，之后的筛选与翻页在浏览器里发起请求，
 * 每次请求领一个序号，先发后到的旧响应会被丢弃（快速连点两次筛选不会出现
 * 「后一次的结果被前一次的响应覆盖」）。
 *
 * ⚠️ 本表**只读**：新建走右上角入口，编辑、停用、移除都在详情页。
 * 表格里放一排会改数据的按钮，等于把「改错了」的概率乘上每一行。
 */
export default function AdminCategoryTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminCategoryFilters;
  initialResult: AdminCategoryListData;
}) {
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [gameId, setGameId] = useState(initialFilters.gameId);
  const [enabled, setEnabled] = useState<AdminEnabledFilter>(initialFilters.enabled);
  const [removal, setRemoval] = useState<AdminCatalogRemovalFilter>(initialFilters.removal);
  const [page, setPage] = useState(initialFilters.page);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminCategoryFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminCategories({ ...query, pageSize: ADMIN_CATEGORY_PAGE_SIZE });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setKeyword(query.keyword);
      setGameId(query.gameId);
      setEnabled(query.enabled);
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

  const current: AdminCategoryFilters = { keyword, gameId, enabled, removal, page };
  const filtered = enabled !== "" || removal !== "active" || gameId !== "" || keyword !== "";

  const emptyMessage =
    removal === "removed" ? ADMIN_CATEGORY_REMOVED_EMPTY_MESSAGE : ADMIN_CATEGORY_EMPTY_MESSAGE;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">类目名称</span>
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
            value={enabled}
            onChange={(event) =>
              void load({ ...current, enabled: event.target.value as AdminEnabledFilter, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_ENABLED_FILTERS.map((item) => (
              <option key={item || "all"} value={item}>
                {ADMIN_ENABLED_FILTER_LABELS[item]}
                {/* 角标只在能给出准确数字的选项上显示：已移除的类目不算「已停用」，
                    两个数字混在一起会让人以为「已停用 3」里有两条其实已经删了 */}
                {item === "" ? `（${result.counts.all}）` : `（${result.counts[item]}）`}
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
                removal: event.target.value as AdminCatalogRemovalFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_CATALOG_REMOVAL_FILTERS.map((item) => (
              <option key={item} value={item}>
                {ADMIN_CATALOG_REMOVAL_FILTER_LABELS[item]}
                {item === "removed" ? `（${result.counts.removed}）` : ""}
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
              void load({ keyword: "", gameId: "", enabled: "", removal: "active", page: 1 });
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
          <p className="text-[13px] text-ink-2">{emptyMessage}</p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setInput("");
                void load({ keyword: "", gameId: "", enabled: "", removal: "active", page: 1 });
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
          {/* 窄屏只在**内容区**横向滚动：页面本身不横向滚，侧栏与顶栏始终在位 */}
          <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[880px] border-collapse text-[13px]">
              <caption className="sr-only">
                类目列表，共 {result.total} 条。编辑、停用与移除在每条记录的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">类目名称</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">所属游戏</th>
                  <th scope="col" className="px-4 py-3 font-medium">排序</th>
                  <th scope="col" className="px-4 py-3 font-medium">商品数</th>
                  <th scope="col" className="px-4 py-3 font-medium">更新时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => {
                  const status = adminCategoryStatus(item);

                  return (
                    <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                      <td className="px-4 py-3">
                        <span className="block text-ink">{item.name}</span>
                        <span className="block font-mono text-[12px] text-ink-3">{item.id}</span>
                      </td>
                      <td className="px-4 py-3">
                        <AdminStatusBadge
                          label={status.label}
                          description={status.description}
                          tone={CATEGORY_STATUS_TONE[status.key]}
                        />
                      </td>
                      <td className="px-4 py-3 text-ink-2">{item.gameName}</td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">{item.sortOrder}</td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">
                        {item.productCount}
                        {/* 数字是「能不能移除」的提前说明，不是判断依据：
                            真正判定在服务端原子区段里重新数一遍 */}
                      </td>
                      <td className="px-4 py-3 text-[12px] text-ink-3">{item.updatedAt}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link
                          href={`/admin/categories/${item.id}`}
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
        「商品数」只数未移除的商品；类目下还有商品时不能移除类目，也不会连带删掉商品。
      </p>
    </div>
  );
}
