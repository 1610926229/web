"use client";

import Link from "next/link";
import { useState } from "react";
import { MINE_GRID_ENTRIES, MINE_PRIMARY_ENTRIES, MINE_SECTION_TITLE } from "@/lib/constants/mine";
import { MINE_ICONS } from "./MineIcons";

/**
 * 「全部功能」区：四个主功能入口 + 分隔线 + 小宫格。
 *
 * 入口清单来自 `lib/constants/mine.ts`，本组件只负责画，不自己维护一份列表——
 * 加一个入口只改常量文件。
 *
 * 关于反馈（要求「所有可见入口均有反馈，不能点击无反应」）：
 * - `kind: "link"` 的入口都是 `<Link>`，目标页面全部真实存在（真页面或统一占位页），不会 404；
 * - `kind: "notice"` 的入口（「同款系统」）目标地址尚未确定，**不允许编造 URL**，
 *   点击后在宫格下方给出 `role="status"` 的文字反馈，说明链接未配置。
 *
 * 反馈用局部状态而不是弹窗：这里没有需要用户确认的动作，弹窗会打断浏览；
 * 也不用定时器自动消失——读不到就消失的提示对屏幕阅读器和手慢的用户都不友好。
 */
export default function MineMenu() {
  const [notice, setNotice] = useState<{ label: string; message: string } | null>(null);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink">
        <span className="mine-section-bar h-5 w-1 rounded-full" aria-hidden />
        {MINE_SECTION_TITLE}
      </h2>

      <nav aria-label="主要功能" className="grid grid-cols-4 gap-2">
        {MINE_PRIMARY_ENTRIES.map((entry) => (
          <Link
            key={entry.id}
            href={entry.href}
            className="flex flex-col items-center gap-2 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mine-grid-icon"
          >
            <span
              className={`flex aspect-square w-full items-center justify-center rounded-[16px] ${entry.tile}`}
            >
              <EntryIcon icon={entry.icon} className="h-8 w-8" />
            </span>
            <span className="text-[13px] leading-4 text-ink">{entry.label}</span>
          </Link>
        ))}
      </nav>

      <Divider />

      <nav aria-label="全部功能" className="grid grid-cols-4 gap-y-5">
        {MINE_GRID_ENTRIES.map((entry) =>
          entry.kind === "link" ? (
            <Link
              key={entry.id}
              href={entry.href}
              className="flex flex-col items-center gap-2 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mine-grid-icon"
            >
              <GridIcon icon={entry.icon} />
              <span className="text-[13px] leading-4 text-ink-2">{entry.label}</span>
            </Link>
          ) : (
            <button
              key={entry.id}
              type="button"
              onClick={() => setNotice({ label: entry.label, message: entry.notice })}
              className="flex flex-col items-center gap-2 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mine-grid-icon"
            >
              <GridIcon icon={entry.icon} />
              <span className="text-[13px] leading-4 text-ink-2">{entry.label}</span>
            </button>
          ),
        )}
      </nav>

      {notice ? (
        <p
          role="status"
          className="rounded-[10px] bg-page px-3 py-2 text-[12px] leading-5 text-ink-3"
        >
          {notice.label}：{notice.message}
        </p>
      ) : null}
    </section>
  );
}

/** 分隔线：两侧细线 + 中间三点（原型样式）。 */
function Divider() {
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <span className="h-px flex-1 bg-mine-grid-icon/20" />
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-mine-grid-icon/40" />
        <span className="h-1.5 w-1.5 rounded-full bg-mine-grid-icon/70" />
        <span className="h-1.5 w-1.5 rounded-full bg-mine-grid-icon/40" />
      </span>
      <span className="h-px flex-1 bg-mine-grid-icon/20" />
    </div>
  );
}

function EntryIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = MINE_ICONS[icon];
  return Icon ? <Icon className={className} /> : null;
}

/** 小宫格图标统一装在淡紫圆角底里（不逐项换色）。 */
function GridIcon({ icon }: { icon: string }) {
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-mine-grid-icon-soft text-mine-grid-icon">
      <EntryIcon icon={icon} className="h-6 w-6" />
    </span>
  );
}
