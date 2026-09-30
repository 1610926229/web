import Link from "next/link";
import type { ReactElement } from "react";
import type { HomeShortcut, QuickEntryIcon } from "@/lib/types/content";

/**
 * 图标表：`QuickEntryIcon` → 内置 SVG。
 *
 * ⚠️ 键是**枚举 `QuickEntryIcon`**，不是 `shortcut.id`（P8E-1 之前是后者）。
 * 这个改动是必须的，不是偏好：入口从这一阶段起由后台新建，id 是随机生成的
 * （`qe_…`），拿 id 当键的话，新建的入口全都查不到图标，页面上只剩一个空的黑方块。
 * 图标因此必须由记录上自己的 `icon` 字段决定。
 *
 * 类型写成 `Record<QuickEntryIcon, …>` 而不是 `Record<string, …>`：
 * 前者让「枚举里加了一个取值、这里忘了补」变成**编译错误**，
 * 后者会让它变成运行期的一个空方块。这是本文件唯一需要类型帮忙的地方。
 */
const ICONS: Record<QuickEntryIcon, () => ReactElement> = {
  service: ServiceIcon,
  benefits: BenefitsIcon,
  join: JoinIcon,
  complaint: ComplaintIcon,
};

/** 首页快捷入口：四宫格，每个入口为「深色图标块 + 文案」。 */
export default function HomeShortcutGrid({ shortcuts }: { shortcuts: HomeShortcut[] }) {
  return (
    <nav aria-label="快捷入口" className="grid grid-cols-4 gap-1 bg-surface px-2 py-4">
      {shortcuts.map((shortcut) => {
        const Icon = ICONS[shortcut.icon];
        return (
          <Link key={shortcut.id} href={shortcut.href} className="flex flex-col items-center gap-2">
            <span className="flex h-12 w-12 items-center justify-center rounded-[10px] bg-ink">
              {/* `icon` 由类型保证必然命中，这里的 `?.` 只是防将来有人绕过类型
                  从接口塞一个未知值进来——那时宁可少一个图标，也不能整页崩掉 */}
              {Icon ? <Icon /> : null}
            </span>
            <span className="text-[13px] text-ink-2">{shortcut.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function glyphProps() {
  return {
    viewBox: "0 0 24 24",
    className: "h-6 w-6",
    fill: "none",
    stroke: "#ffffff",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function ServiceIcon() {
  return (
    <svg {...glyphProps()}>
      <path d="M6 12.5v-1a6 6 0 0 1 12 0v1" />
      <rect x="3.6" y="12.5" width="3.6" height="5.2" rx="1.6" />
      <rect x="16.8" y="12.5" width="3.6" height="5.2" rx="1.6" />
      <path d="M18.6 18v1.2a2.4 2.4 0 0 1-2.4 2.4H13" />
    </svg>
  );
}

function BenefitsIcon() {
  return (
    <svg {...glyphProps()}>
      <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" />
    </svg>
  );
}

function JoinIcon() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 3.4 18.4 6v5c0 4.1-2.7 7.3-6.4 8.4C8.3 18.3 5.6 15.1 5.6 11V6z" />
      <path d="m9.4 11.9 1.9 1.9 3.5-3.7" />
    </svg>
  );
}

function ComplaintIcon() {
  return (
    <svg {...glyphProps()}>
      <path d="M3.8 10.6v2.8a1.2 1.2 0 0 0 1.2 1.2h1.8l5.2 3.6V6.2L6.8 9.8H5a1.2 1.2 0 0 0-1.2 1.2z" />
      <path d="M16.4 9.2a4 4 0 0 1 0 5.6" />
    </svg>
  );
}
