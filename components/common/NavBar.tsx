"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/**
 * 顶部导航栏。标题居中；左右两侧使用等宽占位，保证标题始终居中。
 */
export default function NavBar({
  title,
  showBack = false,
  right,
}: {
  title: string;
  showBack?: boolean;
  right?: ReactNode;
}) {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center border-b border-line bg-surface px-3">
      {showBack ? (
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="返回"
          className="flex h-8 w-8 items-center justify-center text-ink-2"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      ) : (
        <span className="h-8 w-8" aria-hidden />
      )}

      <h1 className="flex-1 truncate text-center text-[16px] font-medium text-ink">{title}</h1>

      {right ? (
        <span className="flex h-8 min-w-8 items-center justify-end">{right}</span>
      ) : (
        <span className="h-8 w-8" aria-hidden />
      )}
    </header>
  );
}
