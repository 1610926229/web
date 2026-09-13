"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";
import SafeAreaContainer from "./SafeAreaContainer";

type IconProps = { filled: boolean };
type TabItem = {
  href: string;
  label: string;
  Icon: (props: IconProps) => ReactElement;
};

const TABS: TabItem[] = [
  { href: "/", label: "首页", Icon: HomeIcon },
  { href: "/category", label: "分类", Icon: GridIcon },
  { href: "/orders", label: "订单", Icon: OrderIcon },
  { href: "/service", label: "客服", Icon: ChatIcon },
  { href: "/mine", label: "我的", Icon: UserIcon },
];

/**
 * 底部主导航。使用 sticky 保持在文档流内，
 * 因此不会遮挡页面内容，也无需为内容额外预留高度。
 */
export default function TabBar() {
  const pathname = usePathname();

  return (
    <SafeAreaContainer className="sticky bottom-0 z-30 shrink-0 border-t border-line bg-surface">
      <nav aria-label="主导航" className="flex h-[var(--tabbar-height)] items-stretch">
        {TABS.map(({ href, label, Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center justify-center gap-[3px] ${
                active ? "text-ink" : "text-ink-3"
              }`}
            >
              <Icon filled={active} />
              <span className={`text-[11px] leading-none ${active ? "font-semibold" : ""}`}>{label}</span>
            </Link>
          );
        })}
      </nav>
    </SafeAreaContainer>
  );
}

/* ---------- 图标：选中为实心，未选中为描边 ---------- */

function HomeIcon({ filled }: IconProps) {
  return filled ? (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
      <path d="M12 2.9 2.6 11.2h2.6v9a.9.9 0 0 0 .9.9H9v-5.9h6v5.9h2.9a.9.9 0 0 0 .9-.9v-9h2.6z" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.2 10.6 12 3.8l7.8 6.8" />
      <path d="M6.3 10v10.2h11.4V10" />
    </svg>
  );
}

function GridIcon({ filled }: IconProps) {
  const squares = [
    { x: 3, y: 3 },
    { x: 13.4, y: 3 },
    { x: 3, y: 13.4 },
    { x: 13.4, y: 13.4 },
  ];
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      {squares.map((s) => (
        <rect
          key={`${s.x}-${s.y}`}
          x={s.x}
          y={s.y}
          width="7.6"
          height="7.6"
          rx="2"
          fill={filled ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={filled ? 0 : 1.7}
        />
      ))}
    </svg>
  );
}

function OrderIcon({ filled }: IconProps) {
  return filled ? (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <rect x="4" y="2.6" width="16" height="18.8" rx="3" fill="currentColor" />
      <g stroke="#fff" strokeWidth={1.8} strokeLinecap="round">
        <path d="M8 8.6h8" />
        <path d="M8 12h8" />
        <path d="M8 15.4h4.5" />
      </g>
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4.5" y="3.1" width="15" height="17.8" rx="2.6" />
      <path d="M8.4 8.6h7.2" />
      <path d="M8.4 12h7.2" />
      <path d="M8.4 15.4h4" />
    </svg>
  );
}

function ChatIcon({ filled }: IconProps) {
  const bubble =
    "M4 4h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8.9L6 20v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z";
  return filled ? (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <path d={bubble} fill="currentColor" />
      <g fill="#fff">
        <circle cx="8.4" cy="10" r="1.2" />
        <circle cx="12" cy="10" r="1.2" />
        <circle cx="15.6" cy="10" r="1.2" />
      </g>
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={bubble} />
      <path d="M8.4 10h.01M12 10h.01M15.6 10h.01" />
    </svg>
  );
}

function UserIcon({ filled }: IconProps) {
  return filled ? (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
      <circle cx="12" cy="8" r="4.1" />
      <path d="M4 20.6c0-4.1 3.7-6.6 8-6.6s8 2.5 8 6.6z" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="4.1" />
      <path d="M4.8 20c0-3.5 3.2-5.6 7.2-5.6s7.2 2.1 7.2 5.6" />
    </svg>
  );
}
