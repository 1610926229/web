"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { PRODUCT_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_CATALOG_REMOVAL_FILTER_LABELS,
  ADMIN_CATALOG_REMOVAL_FILTERS,
  ADMIN_RECOMMENDED_FILTER_LABELS,
  ADMIN_RECOMMENDED_FILTERS,
  ADMIN_STATUS_FILTER_LABELS,
  ADMIN_STATUS_FILTERS,
  type AdminCatalogRemovalFilter,
  type AdminRecommendedFilter,
  type AdminStatusFilter,
} from "@/lib/constants/adminCatalog";
import {
  ADMIN_PRODUCT_EMPTY_MESSAGE,
  ADMIN_PRODUCT_PAGE_SIZE,
  ADMIN_PRODUCT_REMOVED_EMPTY_MESSAGE,
  adminProductStatus,
} from "@/lib/constants/adminProducts";
import { fetchAdminProducts } from "@/lib/services/adminHttp";
import type { AdminProductListData } from "@/lib/types/product";
import { formatYuan } from "@/lib/utils/format";

type LoadStatus = "ready" | "loading" | "error";

export type AdminProductFilters = {
  keyword: string;
  gameId: string;
  categoryId: string;
  status: AdminStatusFilter;
  recommended: AdminRecommendedFilter;
  removal: AdminCatalogRemovalFilter;
  page: number;
};

/**
 * 管理端商品列表的交互部分。
 *
 * ⚠️ 这里看到的是**全部**商品：上架的、下架的、已移除的。
 * 用户端的首页、分类页与搜索只看得到「上架且未移除」的那些——
 * 两个口径都来自**同一份数据源**，由数据层按各自的筛选条件区分，页面不自己过滤。
 *
 * 「已下架」与「已移除」是**两件不同的事**，筛选器里也是两个独立的维度：
 * 下架 = 停止销售（直链仍可打开并显示「已下架」，只是不能结算）；
 * 移除 = 软删除（直链 404、不进任何用户端列表）。把它们混成一个「不可用」，
 * 运营就没法回答「这件商品是暂时不卖了还是不卖了」。
 *
 * 与其他管理端列表一样：首屏由服务端取好，之后的筛选与翻页在浏览器里发起请求，
 * 每次请求领一个序号，先发后到的旧响应会被丢弃。
 *
 * ⚠️ 本表**只读**：新建走右上角入口，编辑、上下架、移除都在详情页。
 * 表格里放一排会改数据的按钮，等于把「改错了」的概率乘上每一行。
 */
export default function AdminProductTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminProductFilters;
  initialResult: AdminProductListData;
}) {
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [gameId, setGameId] = useState(initialFilters.gameId);
  const [categoryId, setCategoryId] = useState(initialFilters.categoryId);
  const [status, setStatus] = useState<AdminStatusFilter>(initialFilters.status);
  const [recommended, setRecommended] = useState<AdminRecommendedFilter>(
    initialFilters.recommended,
  );
  const [removal, setRemoval] = useState<AdminCatalogRemovalFilter>(initialFilters.removal);
  const [page, setPage] = useState(initialFilters.page);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminProductFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminProducts({ ...query, pageSize: ADMIN_PRODUCT_PAGE_SIZE });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setKeyword(query.keyword);
      setGameId(query.gameId);
      setCategoryId(query.categoryId);
      setStatus(query.status);
      setRecommended(query.recommended);
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

  const current: AdminProductFilters = {
    keyword,
    gameId,
    categoryId,
    status,
    recommended,
    removal,
    page,
  };
  const filtered =
    status !== "" ||
    recommended !== "" ||
    removal !== "active" ||
    gameId !== "" ||
    categoryId !== "" ||
    keyword !== "";

  // 类目选项跟着所选游戏走：选了游戏还列着别的游戏的类目，只会让人筛出 0 条
  const categoryOptions = result.categories.filter(
    (category) => gameId === "" || category.gameId === gameId,
  );

  const emptyMessage =
    removal === "removed" ? ADMIN_PRODUCT_REMOVED_EMPTY_MESSAGE : ADMIN_PRODUCT_EMPTY_MESSAGE;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">商品名称 / 副标题</span>
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
            onChange={(event) => {
              // 换了游戏，原来的类目多半不属于它：一起清掉，
              // 而不是留着让下一次查询筛出 0 条
              const nextGame = event.target.value;
              void load({ ...current, gameId: nextGame, categoryId: "", page: 1 });
            }}
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
          <span className="text-[12px] text-ink-3">类目</span>
          <select
            value={categoryId}
            onChange={(event) => void load({ ...current, categoryId: event.target.value, page: 1 })}
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            <option value="">全部类目</option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {/* 停用/已移除的类目照样能筛——它们名下可能还有在架商品，
                    标出来是为了让人知道「这一类目已经不用于新建了」 */}
                {category.removedAt !== null ? "（已移除）" : category.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">上下架</span>
          <select
            value={status}
            onChange={(event) =>
              void load({ ...current, status: event.target.value as AdminStatusFilter, page: 1 })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_STATUS_FILTERS.map((item) => (
              <option key={item || "all"} value={item}>
                {ADMIN_STATUS_FILTER_LABELS[item]}
                {item === "" ? `（${result.counts.all}）` : `（${result.counts[item]}）`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-ink-3">推荐</span>
          <select
            value={recommended}
            onChange={(event) =>
              void load({
                ...current,
                recommended: event.target.value as AdminRecommendedFilter,
                page: 1,
              })
            }
            className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
          >
            {ADMIN_RECOMMENDED_FILTERS.map((item) => (
              <option key={item || "all"} value={item}>
                {ADMIN_RECOMMENDED_FILTER_LABELS[item]}
                {item === "recommended" ? `（${result.counts.recommended}）` : ""}
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
              void load({
                keyword: "",
                gameId: "",
                categoryId: "",
                status: "",
                recommended: "",
                removal: "active",
                page: 1,
              });
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
                void load({
                  keyword: "",
                  gameId: "",
                  categoryId: "",
                  status: "",
                  recommended: "",
                  removal: "active",
                  page: 1,
                });
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
            <table className="w-full min-w-[1120px] border-collapse text-[13px]">
              <caption className="sr-only">
                商品列表，共 {result.total} 条。编辑、上下架与移除在每条记录的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">商品</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">游戏 / 类目</th>
                  <th scope="col" className="px-4 py-3 font-medium">起售价</th>
                  <th scope="col" className="px-4 py-3 font-medium">规格</th>
                  <th scope="col" className="px-4 py-3 font-medium">排序 / 推荐</th>
                  <th scope="col" className="px-4 py-3 font-medium">销量（只读）</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => {
                  const status = adminProductStatus(item);

                  return (
                    <tr key={item.id} className="border-b border-admin-line last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {/* 封面来自白名单 Mock 图，装饰性内容不进读屏 */}
                          <img
                            src={item.coverUrl}
                            alt=""
                            className="h-10 w-14 shrink-0 rounded border border-admin-line object-cover"
                          />
                          <div className="min-w-0">
                            <span className="block truncate text-ink">{item.title}</span>
                            <span className="block font-mono text-[12px] text-ink-3">{item.id}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <AdminStatusBadge
                          label={status.label}
                          description={status.description}
                          tone={PRODUCT_STATUS_TONE[status.key]}
                        />
                      </td>
                      <td className="px-4 py-3 text-ink-2">
                        <span className="block">{item.gameName}</span>
                        <span className="block text-[12px] text-ink-3">
                          {item.categoryName || "未归类"}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">
                        {/* 起售价由**有效规格**算出，商品本身没有价格字段：
                            「没有可用规格」显示「—」而不是 ¥0.00，两者含义不同 */}
                        {item.effectiveSpecCount === 0 ? "—" : `¥${formatYuan(item.priceFrom)}`}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">
                        <span className="block">
                          有效 {item.effectiveSpecCount} / 共 {item.specCount}
                        </span>
                        {item.effectiveSpecCount === 0 && item.status === "on" ? (
                          <span className="block text-[12px] text-brand-red">
                            在架却没有可用规格
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">
                        <span className="block">{item.sortOrder}</span>
                        <span className="block text-[12px] text-ink-3">
                          {item.recommended ? "已推荐" : "未推荐"}
                        </span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-2">{item.monthlySales}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link
                          href={`/admin/products/${item.id}`}
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
        「销量」由系统统计，后台只能查看；下架的商品从列表消失但直链仍显示「已下架」，
        移除的商品直链为 404 —— 两者都会保留历史订单与收藏记录。
      </p>
    </div>
  );
}
