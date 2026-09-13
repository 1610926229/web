import type { ReactNode } from "react";

/**
 * 统一空状态 / 占位状态。
 * 所有尚未实现或暂无数据的页面均复用此组件，避免各自设计。
 */
export default function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 text-center">
      <span
        className="flex h-24 w-24 items-center justify-center rounded-full bg-page text-ink-3"
        aria-hidden
      >
        {children ?? <DefaultGlyph />}
      </span>
      <p className="text-[15px] font-medium text-ink-2">{title}</p>
      {description ? (
        <p className="max-w-[17rem] text-[13px] leading-5 text-ink-3">{description}</p>
      ) : null}
    </div>
  );
}

function DefaultGlyph() {
  return (
    <svg
      viewBox="0 0 48 48"
      className="h-10 w-10"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="8" y="12" width="32" height="24" rx="4" />
      <path d="M14 20h12" />
      <path d="M14 27h8" />
      <path d="M31 26l6 6M37 26l-6 6" />
    </svg>
  );
}
