"use client";

/**
 * 上一页 / 下一页分页控件（管理后台与客服工作台共用）。
 *
 * 用「上一页 / 下一页」而不是页码列表：这两个界面的列表排序都是固定的
 * （申请按提交时间倒序、会话按最后消息时间倒序），页码列表除了让人跳来跳去
 * 没有别的作用，而跳页会打断「刚才看到第几条」的上下文。
 *
 * `total` 与 `hasMore` 都来自服务端，页面不自己用 total 推 hasMore——
 * 两侧口径不一致时，会出现「下一页」点了没反应，或者最后一页仍然可点。
 *
 * ⚠️ 它是**纯展示**的：不取数、不路由、不记住任何东西。谁来点、点了之后
 * 请求哪一页由调用方决定（管理端与工作台的筛选参数不同）。
 *
 * 放在 `components/common/` 而不是各自的目录里：它没有一句文案与业务有关，
 * 复制第二份的唯一后果是「一边修了无障碍问题，另一边没修」。
 */
export default function Pagination({
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
