"use client";

/* eslint-disable @next/next/no-img-element -- 陪玩头像为本地 SVG 占位图，不经 next/image 优化器。 */
import type { Companion } from "@/lib/types/companion";

/**
 * 推荐陪玩选择面板（底部弹出）。
 *
 * 选择陪玩是**可选**的：第一项就是「不选择陪玩」，选它一样可以正常下单支付，
 * 订单会以「已付款 + 未指定陪玩」的状态等待后续接单或平台分配。
 *
 * 当前不可选的陪玩仍然列出并置灰：直接隐藏会让人以为名单里没有这个人，
 * 标注「暂不可选」既说明情况，也解释了为什么点不动（服务端同样会拒绝）。
 */
export default function CompanionSheet({
  open,
  companions,
  selectedId,
  onSelect,
  onClose,
}: {
  open: boolean;
  companions: Companion[];
  selectedId: string | null;
  onSelect: (companion: Companion | null) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* 遮罩本身也是按钮：点它关闭，避免在非交互元素上挂点击事件 */}
      <button
        type="button"
        aria-label="关闭陪玩选择"
        onClick={onClose}
        className="flex-1 bg-black/40"
      />

      <div className="max-h-[70%] overflow-y-auto rounded-t-[16px] bg-surface">
        <div className="sticky top-0 flex items-center border-b border-line bg-surface px-4 py-3">
          <h2 className="flex-1 text-[16px] font-medium text-ink">推荐陪玩</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 items-center justify-center text-ink-3"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            aria-pressed={selectedId === null}
            onClick={() => onSelect(null)}
            className={`mb-2 w-full rounded-[10px] border px-3 py-3 text-left text-[14px] ${
              selectedId === null ? "border-brand-red text-brand-red" : "border-line text-ink-2"
            }`}
          >
            不选择陪玩
            <span className="ml-2 text-[12px] text-ink-3">由平台后续接单或分配</span>
          </button>

          {companions.map((companion) => {
            const active = companion.id === selectedId;
            return (
              <button
                key={companion.id}
                type="button"
                disabled={!companion.available}
                aria-pressed={active}
                onClick={() => onSelect(companion)}
                className={`mb-2 flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left disabled:opacity-50 ${
                  active ? "border-brand-red" : "border-line"
                }`}
              >
                <img
                  src={companion.avatarUrl}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full border border-line bg-page object-cover"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">
                    {companion.name}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {companion.available ? companion.rankLabel : "暂不可选"}
                  </span>
                </span>
                {active ? <span className="shrink-0 text-[12px] text-brand-red">已选择</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
