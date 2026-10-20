"use client";

import AdminStatusBadge, { CONTENT_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  CONTENT_STATUS_FILTER_LABELS,
  CONTENT_STATUS_FILTERS,
  contentFilterCount,
  contentStatusOf,
  type ContentCounts,
  type ContentStatusFilter,
} from "@/components/admin/adminContentFilter";
import { QUICK_ENTRY_ICON_LABELS } from "@/lib/constants/adminContent";
import type { QuickEntryIcon } from "@/lib/types/content";

/**
 * 快捷入口的后台列表。
 *
 * ⚠️ 这一张表**没有**与图片公告 / 活动 Banner 共用实现，因为它管的字段不同：
 * 那里是「一张图 + 图注」，这里是「名称 + 图标 + 目标地址」。
 * 共用一份「差不多的表」会让两边的列都能被对方的改动影响，
 * 而它们要回答的问题本来就不一样（一张图好不好看 vs 一个入口点得到哪里）。
 * 共用的是**筛选口径**（`adminContentFilter.ts`）——那才是必须一致的东西。
 *
 * ⚠️ 用户端是**四宫格**（`HomeShortcutGrid`，`grid-cols-4`）。后台不限制条数，
 * 但超过四条时用户端会折到第二行、不再是设计稿里的样子，因此列表下方必须
 * 把这句话说出来，而不是等运营自己发现。
 */

export type QuickEntryRow = {
  id: string;
  label: string;
  icon: QuickEntryIcon;
  path: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string;
  removed: boolean;
};

/**
 * 入口图标在后台的占位图形。
 *
 * ⚠️ 这里**刻意不复刻**用户端每个图标的具体画法（那在
 * `components/home/HomeShortcutGrid.tsx` 里，按 `QuickEntryIcon` 映射）。
 * 后台要回答的是「这个入口配的是哪一个图标」，一句文字加一个通用图形就够了；
 * 复刻一套一模一样的图标意味着两处会各自漂移，而漂移之后运营看到的预览
 * 与用户看到的就不是同一个东西了——那比不预览更糟。
 */
function QuickEntryGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M9 12h6M12 9v6" />
    </svg>
  );
}

export default function AdminQuickEntryTable({
  rows,
  counts,
  filter,
  loading,
  error,
  busy,
  footerNote,
  onFilterChange,
  onRetry,
  onEdit,
  onToggleEnabled,
  onRemove,
}: {
  rows: QuickEntryRow[];
  counts: ContentCounts;
  filter: ContentStatusFilter;
  loading: boolean;
  /** 取数失败时的中文错误；非空时表格整体让位给错误块 */
  error: string;
  /** 有写操作正在进行：此时行内按钮全部禁用，避免在飞行中再发一次 */
  busy: boolean;
  footerNote: string;
  onFilterChange: (filter: ContentStatusFilter) => void;
  onRetry: () => void;
  onEdit: (row: QuickEntryRow) => void;
  onToggleEnabled: (row: QuickEntryRow) => void;
  onRemove: (row: QuickEntryRow) => void;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        {CONTENT_STATUS_FILTERS.map((item) => {
          const active = item === filter;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(item)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                active
                  ? "border-admin-accent bg-brand-blue-soft text-ink"
                  : "border-admin-line text-ink-2 hover:bg-page"
              }`}
            >
              {CONTENT_STATUS_FILTER_LABELS[item]}
              <span className="ml-1 tabular-nums text-ink-3">
                （{contentFilterCount(counts, item)}）
              </span>
            </button>
          );
        })}

        {loading ? (
          <span role="status" aria-live="polite" className="text-[12px] text-ink-3">
            加载中…
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {!error && rows.length === 0 ? (
        <div className="mt-3 rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">
            {filter === "removed"
              ? "还没有被移除的入口。移除是软删除，被移除的记录会留在这里供回查。"
              : "这个筛选下还没有快捷入口。点右上角新建一个，用户端下一次刷新就会出现。"}
          </p>
        </div>
      ) : null}

      {!error && rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-xl border border-admin-line bg-surface">
          <table className="w-full min-w-[920px] border-collapse text-[13px]">
            <caption className="sr-only">
              快捷入口列表，当前筛选下 {rows.length} 条。用户端是四宫格，最多四个位置最合适。
            </caption>
            <thead>
              <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                <th scope="col" className="px-4 py-3 font-medium">
                  图标
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  入口名称
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  目标地址
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  排序
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  状态
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  更新时间
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = contentStatusOf(row);

                return (
                  <tr key={row.id} className="border-b border-admin-line last:border-b-0">
                    <td className="px-4 py-3">
                      {/* 图标既有颜色也有文字：图形是辅助，`QUICK_ENTRY_ICON_LABELS`
                          才是「配的是哪一个」的答案（§十一：不靠颜色与图形单独承载信息） */}
                      <span className="flex items-center gap-2 text-ink-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink text-white">
                          <QuickEntryGlyph />
                        </span>
                        <span className="text-[12px]">{QUICK_ENTRY_ICON_LABELS[row.icon]}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block text-ink">{row.label}</span>
                      <span className="block font-mono text-[12px] text-ink-3">{row.id}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-ink-2">{row.path}</td>
                    <td className="px-4 py-3 tabular-nums text-ink-2">{row.sortOrder}</td>
                    <td className="px-4 py-3">
                      <AdminStatusBadge
                        label={status.label}
                        description={status.description}
                        tone={CONTENT_STATUS_TONE[status.key]}
                      />
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-3">{row.updatedAt}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {row.removed ? (
                        // 已移除是终态：服务端会拒绝改动它，因此只说明原因，不给按钮
                        <span className="text-[12px] leading-4 text-ink-3">已移除，只能回查</span>
                      ) : (
                        <span className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onEdit(row)}
                            className="text-[13px] text-admin-accent underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onToggleEnabled(row)}
                            className="text-[13px] text-ink-2 underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            {row.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onRemove(row)}
                            className="text-[13px] text-status-danger underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            移除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{footerNote}</p>
      <p className="mt-1 text-[12px] leading-4 text-ink-3">
        「全部 / 已启用 / 已停用」在同一批未移除的记录里分，只有切到「已移除」会重新查一次。
        {`快捷入口共 ${counts.all} 条，其中已移除 ${counts.removed} 条。`}
      </p>
    </section>
  );
}
