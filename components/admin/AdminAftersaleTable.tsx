"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminStatusBadge, {
  COMPLAINT_STATUS_TONE,
  ORDER_STATUS_TONE,
  REFUND_STATUS_TONE,
  type AdminStatusTone,
} from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_AFTERSALE_CASE_TYPES,
  ADMIN_AFTERSALE_CASE_TYPE_LABELS,
  ADMIN_AFTERSALE_EMPTY_MESSAGE,
  ADMIN_AFTERSALE_LIST_FIELDS_NOTE,
  ADMIN_AFTERSALE_OUT_OF_RANGE_MESSAGE,
  ADMIN_AFTERSALE_VIEWS,
  ADMIN_AFTERSALE_VIEW_LABELS,
  DEFAULT_ADMIN_AFTERSALE_CASE_TYPE,
  DEFAULT_ADMIN_AFTERSALE_VIEW,
  type AdminAftersaleCaseType,
  type AdminAftersaleView,
} from "@/lib/constants/adminAftersales";
import { fetchAdminAftersales } from "@/lib/services/adminHttp";
import type { AdminAftersaleListData, AdminAftersaleRow } from "@/lib/types/aftersale";
import type { ComplaintStatus } from "@/lib/types/complaint";
import type { RefundStatus } from "@/lib/types/refund";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/** 列表区域的三种状态；加载与错误都只替换表格区域，筛选栏始终在位。 */
type LoadStatus = "ready" | "loading" | "error";

export type AdminAftersaleFilters = {
  view: AdminAftersaleView;
  caseType: AdminAftersaleCaseType | "all";
  keyword: string;
  from: string;
  to: string;
  page: number;
};

/**
 * 金额列的口径说明（这一列的图例，不是列表级的字段说明）。
 *
 * ⚠️ 这句话必须写在界面上：P0-15 起一笔退款可以只退一部分，「申请金额」
 * 与「核定金额」在部分退款下**不是同一个数**。只显示其中一个，
 * 管理员会把申请时的实付快照当成实际退出去的钱。
 *
 * ⚠️ 文案写在组件里而不是 `lib/constants/adminAftersales.ts`：它只描述本表这一列，
 * 与列表级、页面级的说明（`ADMIN_AFTERSALE_LIST_FIELDS_NOTE` / `data.notice`）
 * 是两件事，混进常量文件会让「哪些话在哪些页面出现」变模糊。
 */
const AMOUNT_COLUMN_NOTE =
  "「金额」列：退款的案件在管理员核定后显示核定金额，尚未核定时显示申请金额——" +
  "两者在部分退款下不相等；投诉的案件没有金额，显示「—」。";

/**
 * 案件状态用哪一档语气。
 *
 * 聚合 DTO 给的是 `status: string`：同一列里并排着**退款**与**投诉**两套状态键
 * （`pending` 两边都有、其余互不相同），而语气表是按各自的窄联合键的。
 * 因此这里先按 `caseType` 分流再取表——**状态清单没有第二份**：
 * `approved` / `closed` 这些键只在 `REFUND_STATUS_TONE` / `COMPLAINT_STATUS_TONE`
 * 里定义一次，本文件不重写任何一个。
 *
 * 分流之后仍然取不到时返回 `undefined`（两张表将来若分叉也不会让页面崩掉），
 * `AdminStatusBadge` 会退回中性灰：状态文字始终是权威，颜色只是辅助。
 */
function caseStatusTone(row: AdminAftersaleRow): AdminStatusTone | undefined {
  if (row.caseType === "refund") return REFUND_STATUS_TONE[row.status as RefundStatus];
  return COMPLAINT_STATUS_TONE[row.status as ComplaintStatus];
}

/**
 * 售后统一工作台列表的交互部分（`/admin/aftersales`）。
 *
 * 首屏由 Server Component 取好（`initialResult`）后传进来，本组件不在挂载时再请求一次。
 *
 * ⚠️ **本表只读**：操作列只有「查看」链接，通往 `/admin/aftersales/<caseType>/<id>`。
 * 退款与投诉各自的处置动作留在**各自的专用页面**上（`AdminRefundConsole` /
 * `AdminComplaintConsole`），本列表与聚合详情页都不提供第二组按钮——
 * 一个后台里出现两条改同一份状态的路径，早晚会有一条先过时。
 *
 * ⚠️ **本表不含任何隐私内容**：没有手机号、实名信息、内部分账比例与后台备注，
 * 用户只给昵称与平台展示 ID。这些字段服务端也不放进本 DTO。
 *
 * ⚠️ **本表不做任何金额运算**：金额来自服务端 DTO，页面只做 `formatYuan` 展示，
 * 「核定金额优先、否则申请金额」是一个**取值**选择，不是一次计算。
 *
 * 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。
 */
export default function AdminAftersaleTable({
  initialFilters,
  initialResult,
}: {
  initialFilters: AdminAftersaleFilters;
  initialResult: AdminAftersaleListData;
}) {
  const [view, setView] = useState<AdminAftersaleView>(initialFilters.view);
  const [caseType, setCaseType] = useState<AdminAftersaleCaseType | "all">(
    initialFilters.caseType,
  );
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [input, setInput] = useState(initialFilters.keyword);
  const [from, setFrom] = useState(initialFilters.from);
  const [to, setTo] = useState(initialFilters.to);
  const [page, setPage] = useState(initialFilters.page);

  const [result, setResult] = useState(initialResult);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("ready");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const ticketRef = useRef(0);

  async function load(query: AdminAftersaleFilters) {
    const ticket = ++ticketRef.current;
    setLoadStatus("loading");
    setError("");
    setNote("");

    try {
      const next = await fetchAdminAftersales({
        view: query.view,
        caseType: query.caseType,
        keyword: query.keyword,
        from: query.from,
        to: query.to,
        page: query.page,
      });
      if (ticket !== ticketRef.current) return;

      setResult(next);
      setView(query.view);
      setCaseType(query.caseType);
      setKeyword(query.keyword);
      setFrom(query.from);
      setTo(query.to);
      setPage(next.page);
      setLoadStatus("ready");
      setNote(`已载入第 ${next.page} 页，共 ${next.total} 条`);
    } catch (cause) {
      if (ticket !== ticketRef.current) return;
      setLoadStatus("error");
      setError(cause instanceof Error ? cause.message : "服务暂时不可用，请稍后重试。");
    }
  }

  const current: AdminAftersaleFilters = { view, caseType, keyword, from, to, page };

  /** 重置回默认筛选（「未完结」——这个页面的主要用途是处理待办）。 */
  function reset() {
    setInput("");
    void load({
      view: DEFAULT_ADMIN_AFTERSALE_VIEW,
      caseType: DEFAULT_ADMIN_AFTERSALE_CASE_TYPE,
      keyword: "",
      from: "",
      to: "",
      page: 1,
    });
  }

  const filtered =
    view !== DEFAULT_ADMIN_AFTERSALE_VIEW ||
    caseType !== DEFAULT_ADMIN_AFTERSALE_CASE_TYPE ||
    keyword !== "" ||
    from !== "" ||
    to !== "";

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 rounded-xl border border-admin-line bg-surface p-4">
        {/* 视图：四个可点的数字，兼作这一页的「各有多少条」。
            角标来自服务端算好的 `counts`（每次取数都重新给一遍），
            不用当前这一页的 `items` 去数——那样数出来的只是这一页的量。 */}
        <div className="flex flex-wrap items-center gap-2">
          {ADMIN_AFTERSALE_VIEWS.map((item) => {
            const active = item === view;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={active}
                onClick={() => void load({ ...current, view: item, page: 1 })}
                className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                  active
                    ? "border-admin-accent bg-brand-blue-soft text-ink"
                    : "border-admin-line text-ink-2 hover:bg-page"
                }`}
              >
                {ADMIN_AFTERSALE_VIEW_LABELS[item]}
                <span className="ml-1 tabular-nums text-ink-3">（{result.counts[item]}）</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[260px] flex-1 flex-col gap-1">
            {/* 五处搜索范围写在这里：搜得到什么，取决于服务端索引了哪些字段，
                写含糊了会让人以为「输手机号也能搜」——而它本来就不在 DTO 里 */}
            <span className="text-[12px] text-ink-3">
              案件编号 / 订单号 / 用户昵称 / 平台展示 ID / 打手昵称
            </span>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void load({ ...current, keyword: input.trim(), page: 1 });
              }}
              placeholder="输入案件编号、订单号、用户昵称、平台展示 ID 或打手昵称"
              className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">案件类型</span>
            <select
              value={caseType}
              onChange={(event) =>
                void load({
                  ...current,
                  caseType: event.target.value as AdminAftersaleCaseType | "all",
                  page: 1,
                })
              }
              className="h-9 rounded-lg border border-admin-line bg-surface px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
            >
              {ADMIN_AFTERSALE_CASE_TYPES.map((item) => (
                <option key={item} value={item}>
                  {ADMIN_AFTERSALE_CASE_TYPE_LABELS[item]}
                </option>
              ))}
            </select>
          </label>

          {/* 日期区间：清空即不限（不是「从今天起」）。两个框各自独立，
              只填一个是合法的——只填「从」是「这一天之后提交的」 */}
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">提交日期从</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9 rounded-lg border border-admin-line px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">到</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-9 rounded-lg border border-admin-line px-2 text-[13px] text-ink outline-none focus:border-admin-accent"
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
      </div>

      <p
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[18px] text-[12px] leading-[18px] text-ink-3"
      >
        {loadStatus === "loading" ? "加载中…" : note}
      </p>

      {/* 金额列为退款显示的是**核定金额**：不写清楚，一笔退了一半的申请
          会被读成它实际不是的样子 */}
      <p className="rounded-lg border border-admin-line bg-page px-3 py-2 text-[12px] leading-4 text-ink-3">
        {AMOUNT_COLUMN_NOTE}
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

      {/* 空表有两种，判据是服务端给的 `total`（不是当前页的行数）：
          `total === 0` 是「真的没有案件」，`total > 0` 而没有行只可能是
          **页码越界**（手改地址栏 `?page=3` 而总共只有一页）。
          两者混成一句「没有案件」，使用者会去改筛选条件——
          而同屏的分页控件正写着「共 12 条」。
          ⚠️ 这里只读 `total`，不重新数一遍数据。 */}
      {loadStatus !== "error" && result.items.length === 0 ? (
        <div className="mt-2 rounded-xl border border-admin-line bg-surface p-8 text-center">
          {result.total === 0 ? (
            <>
              <p className="text-[13px] text-ink-2">{ADMIN_AFTERSALE_EMPTY_MESSAGE}</p>
              {filtered ? (
                <button
                  type="button"
                  onClick={reset}
                  className="mt-3 rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
                >
                  重置筛选
                </button>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[13px] text-ink-2">{ADMIN_AFTERSALE_OUT_OF_RANGE_MESSAGE}</p>
              <button
                type="button"
                onClick={() => void load({ ...current, page: 1 })}
                className="mt-3 rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
              >
                回到第 1 页
              </button>
            </>
          )}
        </div>
      ) : null}

      {result.items.length > 0 ? (
        <>
          <div className="mt-2 overflow-x-auto rounded-xl border border-admin-line bg-surface">
            <table className="w-full min-w-[1280px] border-collapse text-[13px]">
              <caption className="sr-only">
                售后案件列表，共 {result.total} 条。退款与投诉的处置动作在各自的专用页面。
              </caption>
              <thead>
                <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                  <th scope="col" className="px-4 py-3 font-medium">案件类型</th>
                  <th scope="col" className="px-4 py-3 font-medium">案件编号</th>
                  <th scope="col" className="px-4 py-3 font-medium">状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">用户</th>
                  <th scope="col" className="px-4 py-3 font-medium">订单号</th>
                  <th scope="col" className="px-4 py-3 font-medium">订单状态</th>
                  <th scope="col" className="px-4 py-3 font-medium">打手</th>
                  <th scope="col" className="px-4 py-3 font-medium">金额</th>
                  <th scope="col" className="px-4 py-3 font-medium">提交时间</th>
                  <th scope="col" className="px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  // 退款与投诉的 id 来自两张表，前缀不同但不是同一个序列，
                  // 因此 key 里带上案件类型
                  <tr
                    key={`${item.caseType}-${item.id}`}
                    className="border-b border-admin-line last:border-b-0"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">
                      {item.caseTypeLabel}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {item.caseNo}
                    </td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={item.statusLabel}
                        tone={caseStatusTone(item)}
                      />
                    </td>
                    <td className="px-4 py-3 text-ink">
                      <span className="block">{item.user.nickname || "—"}</span>
                      <span className="block text-[12px] text-ink-3">{item.user.displayId}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-ink-2">
                      {/* 未关联订单是合法状态（平台服务类的投诉本来就没有订单），
                          不是缺失数据 */}
                      {item.orderNo ?? "未关联订单"}
                    </td>
                    <td className="px-4 py-3">
                      {item.orderStatus === null ? (
                        <span className="text-[13px] text-ink-3">—</span>
                      ) : (
                        <AdminStatusBadge
                          label={item.orderStatusLabel ?? "—"}
                          tone={ORDER_STATUS_TONE[item.orderStatus]}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">
                      {/* 还没有人接单是这一单当前的事实，不补占位名字 */}
                      {item.companion?.name ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink">
                      {/* ⚠️ 退款列显示的是**核定金额**（管理员审核通过时写下的那个数），
                          只有尚未核定时才退回申请金额——部分退款下两者不相等
                          （口径见上方 `AMOUNT_COLUMN_NOTE`）。
                          这里只是**取值**，没有任何算术。 */}
                      {item.amount === null ? (
                        <span className="text-[13px] text-ink-3">—</span>
                      ) : (
                        <>
                          <span className="block tabular-nums">
                            ¥{formatYuan(item.decidedAmount ?? item.amount)}
                          </span>
                          <span className="block text-[12px] text-ink-3">
                            {item.decidedAmount === null
                              ? "申请金额（尚未核定）"
                              : `核定金额 · 申请 ¥${formatYuan(item.amount)}`}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[12px] text-ink-3">
                      {formatDateTime(item.submittedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/admin/aftersales/${item.caseType}/${item.id}`}
                        className="text-[13px] text-admin-accent underline-offset-2 hover:underline"
                      >
                        查看
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

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{ADMIN_AFTERSALE_LIST_FIELDS_NOTE}</p>
    </div>
  );
}
