"use client";

/**
 * 管理端分页控件（上一页 / 下一页 + 当前页与总数）。
 *
 * 用「上一页 / 下一页」而不是页码列表：后台列表的排序固定（申请按提交时间倒序、
 * 护航按展示排序），页码列表除了让人跳来跳去没有别的作用，而跳页会打断
 * 「刚才看到第几条」的上下文。
 *
 * `total` 与 `hasMore` 都来自服务端，页面不自己用 total 推 hasMore
 * （两侧口径不一致时，会出现「下一页」点了没反应或最后一页仍可点）。
 */
export default function AdminPagination({
  page,
  total,
  hasMore,
  pending,
  onPrev,
  onNext,
}: {
  page: number;
  total: number;
  hasMore: boolean;
  pending: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const hasPrev = page > 1;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      {/* 总数与页码是给读屏与快速核对用的，视觉上保持次要 */}
      <p className="text-[12px] text-ink-3">
        第 {page} 页 · 共 {total} 条
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev || pending}
          className="rounded-lg border border-admin-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-50"
        >
          上一页
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasMore || pending}
          className="rounded-lg border border-admin-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-50"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
