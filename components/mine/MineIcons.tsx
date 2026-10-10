import type { ReactElement, ReactNode } from "react";

/**
 * 「我的」页功能入口的图形。
 *
 * 统一成**一套线性图标**：同一画布（24×24）、同一线宽、同一圆角与端点，颜色取
 * `currentColor`（由磁贴决定）。原型里的图标是多色拟物图形，本阶段没有正式图标素材，
 * 因此不做「每个入口一个风格」的复杂图形——那比统一占位更难看，也更难替换。
 *
 * 接入正式图标素材时，只需替换本文件里对应的图形，入口配置（`lib/constants/mine.ts`）
 * 与页面都不用改。
 */

const BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function Glyph({ className = "h-6 w-6", children }: { className?: string; children: ReactNode }) {
  return (
    <svg {...BASE} className={className}>
      {children}
    </svg>
  );
}

type GlyphComponent = (props: { className?: string }) => ReactElement;

/** 图标键 → 图形。键与 `lib/constants/mine.ts` 中入口的 `icon` 一一对应。 */
export const MINE_ICONS: Record<string, GlyphComponent> = {
  // 主功能
  orders: (props) => (
    <Glyph {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9.5 4.2h5" />
      <path d="M8.5 10h7" />
      <path d="M8.5 14h4" />
    </Glyph>
  ),
  complaints: (props) => (
    <Glyph {...props}>
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.6 3.6V16H5.5A1.5 1.5 0 0 1 4 14.5z" />
      <path d="M12 8v3.4" />
      <circle cx="12" cy="13.9" r="0.7" fill="currentColor" stroke="none" />
    </Glyph>
  ),
  join: (props) => (
    <Glyph {...props}>
      <path d="M12 3.4 18.4 6v5c0 4.1-2.7 7.3-6.4 8.4C8.3 18.3 5.6 15.1 5.6 11V6z" />
      <path d="m9.4 11.9 1.9 1.9 3.5-3.7" />
    </Glyph>
  ),
  favorites: (props) => (
    <Glyph {...props}>
      <path d="M12 20.2s-7.6-4.6-7.6-9.5A4.1 4.1 0 0 1 12 8.1a4.1 4.1 0 0 1 7.6 2.6c0 4.9-7.6 9.5-7.6 9.5z" />
    </Glyph>
  ),

  // 小宫格
  rank: (props) => (
    <Glyph {...props}>
      <path d="M5.5 19v-7" />
      <path d="M12 19V5" />
      <path d="M18.5 19v-4.5" />
      <path d="M3.5 19h17" />
    </Glyph>
  ),
  coupon: (props) => (
    <Glyph {...props}>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z" />
      <path d="M13.5 6v1.5M13.5 11.2v1.6M13.5 16.5V18" />
    </Glyph>
  ),
  review: (props) => (
    <Glyph {...props}>
      <path d="m12 4.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" />
    </Glyph>
  ),
  agreement: (props) => (
    <Glyph {...props}>
      <path d="M6 3.5h7l5 5v12H6z" />
      <path d="M13 3.5v5h5" />
      <path d="M9 13h6" />
      <path d="M9 16.5h4" />
    </Glyph>
  ),
  companion: (props) => (
    <Glyph {...props}>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.8 19.5a5.2 5.2 0 0 1 10.4 0" />
      <circle cx="17" cy="9.8" r="2.3" />
      <path d="M15.6 14.7a4.4 4.4 0 0 1 4.6 4.3" />
    </Glyph>
  ),
  tips: (props) => (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.2 8.6 12 12l2.8-3.4" />
      <path d="M12 12v4" />
      <path d="M9.6 13.6h4.8" />
    </Glyph>
  ),
  suggestion: (props) => (
    <Glyph {...props}>
      <path d="M8 12.4a4 4 0 1 1 8 0c0 1.4-.7 2.2-1.4 3.1H9.4c-.7-.9-1.4-1.7-1.4-3.1z" />
      <path d="M9.6 17.7h4.8" />
      <path d="M10.4 20.2h3.2" />
    </Glyph>
  ),
  gift: (props) => (
    <Glyph {...props}>
      <path d="M4.5 11.5h15V20h-15z" />
      <path d="M3.2 7.8h17.6v3.7H3.2z" />
      <path d="M12 7.8V20" />
      <path d="M12 7.8S10.9 4 8.9 4a2 2 0 0 0 0 3.8z" />
      <path d="M12 7.8s1.1-3.8 3.1-3.8a2 2 0 0 1 0 3.8z" />
    </Glyph>
  ),
  level: (props) => (
    <Glyph {...props}>
      <circle cx="12" cy="9.8" r="5.4" />
      <path d="m9.4 14.4-1.2 6.1 3.8-2 3.8 2-1.2-6.1" />
    </Glyph>
  ),
  help: (props) => (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.8 9.7a2.3 2.3 0 1 1 3 2.5c-.6.2-.8.6-.8 1.2v.3" />
      <circle cx="12" cy="16.6" r="0.7" fill="currentColor" stroke="none" />
    </Glyph>
  ),
  // P0-4 打手工作台。手绘游戏手柄：这是「打手」这一行的用具，
  // 与 `companion`（两个人）区分开——名单是找人，工作台是自己上手。
  console: (props) => (
    <Glyph {...props}>
      <path d="M8.4 7.5h7.2a5 5 0 0 1 4.9 4l.6 3.4a2.4 2.4 0 0 1-4.3 1.9l-.9-1.2H8.1l-.9 1.2a2.4 2.4 0 0 1-4.3-1.9l.6-3.4a5 5 0 0 1 4.9-4z" />
      <path d="M7.6 11.6v2.6M6.3 12.9h2.6" />
      <circle cx="16.6" cy="12.2" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="18.3" cy="13.9" r="0.7" fill="currentColor" stroke="none" />
    </Glyph>
  ),
  external: (props) => (
    <Glyph {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.4 8.4" />
      <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
    </Glyph>
  ),
};
