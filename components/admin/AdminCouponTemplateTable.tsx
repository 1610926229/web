"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, { COUPON_TEMPLATE_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_ENABLED_FILTER_LABELS,
  ADMIN_ENABLED_FILTERS,
  type AdminEnabledFilter,
} from "@/lib/constants/adminCatalog";
import {
  ADMIN_COUPON_AMOUNT_MAX_FEN,
  ADMIN_COUPON_PAGE_SIZE,
  ADMIN_COUPON_TEMPLATE_EMPTY_MESSAGE,
  adminCouponTemplateStatus,
} from "@/lib/constants/adminCoupons";
import { fetchAdminCouponTemplates } from "@/lib/services/adminHttp";
import type { AdminCouponTemplateItem, AdminCouponTemplateListData } from "@/lib/types/coupon";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

type LoadStatus = "ready" | "loading" | "error";

export type AdminCouponTemplateFilters = {
  keyword: string;
  enabled: AdminEnabledFilter;
  page: number;
};

/** 券面金额：整数分 → `¥10.00`。非满减券没有金额可显示，给一个字面的「—」。 */
function amountText(fen: number | null): string {
  if (fen === null) return "—";
  return `¥${formatYuan(fen)}`;
}

/**
 * 管理端优惠券模板列表的交互部分。
 *
 * ⚠️ 这里看到的是**全部**模板：启用中的、停用的、满减的、历史的折扣券与无门槛券。
 * 用户端领券中心只看得到「启用且可领」的那些——两个口径都来自**同一份数据源**，
 * 由 `lib/constants/coupons.ts` 判定，页面不自己过滤。
 *
 * 关键的一条分野写在这里：**`editable` 由服务端算好**（`isComputableCouponForm`），
 * 页面只是照着用。界面自己再判一次 `formKey`，两侧迟早给出不同答案——
 * 而这次分叉的后果是「「编辑」按钮能点，点下去 400」。
 *
 * 与其他管理端列表一样：首屏由服务端取好，之后的筛选与翻页在浏览器里发起请求，
 * 每次请求领一个序号，先发后到的旧响应会被丢弃。
 *
 * ⚠️ 本表**只读**：新建走右上角入口，编辑与启用 / 停用都在详情页。
 * 表格里放一排会改数据的按钮，等于把「改错了」的概率乘上每一行——
 * 而券的停用会**直接让已经领到手的用户核销不了**，比类目的停用更需要一次确认。
 */
export default function AdminCouponTemplateTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminCouponTemplateFilters;
  initialResult: AdminCouponTemplateListData;
}) {
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [enabled, setEnabled] = useState<AdminEnabledFilter>(initialFilters.enabled);
  const [page, setPage] = useState(initialFilters.page);
  const [input, setInput] = useState(initialFilters.keyword);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminCouponTemplateFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminCouponTemplates({ ...query, pageSize: ADMIN_COUPON_PAGE_SIZE });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setKeyword(query.keyword);
      setEnabled(query.enabled);
      setPage(next.page);
      setLoadStatus("ready");
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  const current: AdminCouponTemplateFilters = { keyword, enabled, page };
  const filtered = enabled !== "" || keyword !== "";

  function reset() {
    setInput("");
    void load({ keyword: "", enabled: "", page: 1 });
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[12px] text-ink-3">优惠券名称 / ID</span>
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
                {/* 角标按**全部**模板算，与筛选无关：三个数加起来就是总数，
                    因此「全部（5）= 已启用（3）+ 已停用（2）」在页面上是自洽的 */}
                {item === "" ? `（${result.counts.all}）` : `（${result.counts[item]}）`}
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
          <p className="text-[13px] text-ink-2">{ADMIN_COUPON_TEMPLATE_EMPTY_MESSAGE}</p>
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
          {/* 窄屏只在**内容区**横向滚动：页面本身不横向滚，侧栏与顶栏始终在位 */}
          <div className="overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[920px] border-collapse text-[13px]">
              <caption className="sr-only">
                优惠券模板列表，共 {result.total} 条。编辑与启用 / 停用在每条记录的详情页。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">优惠券</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">形式</th>
                  <th scope="col" className="px-4 py-3 font-medium">满减门槛</th>
                  <th scope="col" className="px-4 py-3 font-medium">优惠金额</th>
                  <th scope="col" className="px-4 py-3 font-medium">有效期</th>
                  <th scope="col" className="px-4 py-3 font-medium">已领取</th>
                  <th scope="col" className="px-4 py-3 font-medium">最近更新</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <CouponTemplateRow key={item.id} item={item} />
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
        「满减门槛」与「优惠金额」是服务端记录的**权威金额**（整数分）；
        券面上的「满 X 减 Y」由它们派生，不单独编辑。
        单笔金额上限 {formatYuan(ADMIN_COUPON_AMOUNT_MAX_FEN)} 元，超过的输入会被服务端拒绝。
      </p>
    </div>
  );
}

/**
 * 一行券模板。
 *
 * 抽成组件只是为了让上面那张表读得下去：列数多，内联展开会把「表头 → 每一行」
 * 的对应关系淹掉。它**没有任何交互**，因此不需要 `"use client"`。
 */
function CouponTemplateRow({ item }: { item: AdminCouponTemplateItem }) {
  const status = adminCouponTemplateStatus(item);

  return (
    <tr className="border-b border-admin-line last:border-b-0">
      <td className="px-4 py-3">
        <span className="block text-ink">{item.name}</span>
        <span className="block font-mono text-[12px] text-ink-3">{item.id}</span>
        {/* 券面文案是服务端派生的展示值，放在名称下面让人一眼看出「这张券长什么样」 */}
        <span className="block text-[12px] text-ink-3">
          {item.valueLabel} · {item.conditionLabel}
        </span>
      </td>
      <td className="px-4 py-3">
        <AdminStatusBadge
          label={status.label}
          description={status.description}
          tone={COUPON_TEMPLATE_STATUS_TONE[status.key]}
        />
      </td>
      <td className="px-4 py-3">
        <span className="block text-ink-2">{item.formLabel}</span>
        {/* 不参与结算的券必须**在列表上**就被看出来：它们是历史模板，
            既不能编辑也不会进入结算页的可选列表 */}
        {item.editable ? null : (
          <span className="block text-[12px] text-ink-3">不参与结算</span>
        )}
      </td>
      <td className="px-4 py-3 tabular-nums text-ink-2">{amountText(item.thresholdAmount)}</td>
      <td className="px-4 py-3 tabular-nums text-ink-2">{amountText(item.discountAmount)}</td>
      <td className="px-4 py-3 text-[12px] leading-4 text-ink-3">
        <span className="block">{formatDateTime(item.validFrom)}</span>
        <span className="block">至 {formatDateTime(item.validTo)}</span>
      </td>
      <td className="px-4 py-3 tabular-nums text-ink-2">
        {item.claimCount}
        {/* 这个数字是给管理员**看的**提示，不是一道闸：已经发出多少张
            不构成拒绝停用的理由（§5「停用不删除任何 Claim」） */}
        <span className="block text-[12px] text-ink-3">张</span>
      </td>
      <td className="px-4 py-3 text-[12px] leading-4 text-ink-3">
        <span className="block">{formatDateTime(item.updatedAt)}</span>
        <span className="block">建档 {formatDateTime(item.createdAt)}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <Link
          href={`/admin/coupons/${item.id}`}
          className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
        >
          {item.editable ? "查看 / 编辑" : "查看"}
        </Link>
      </td>
    </tr>
  );
}
