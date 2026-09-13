/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */
import Link from "next/link";
import type { ReactNode } from "react";
import { BIO_EMPTY_PLACEHOLDER } from "@/lib/constants/profile";
import { MINE_EDIT_LABEL, MINE_SETTINGS_LABEL } from "@/lib/constants/mine";
import type { UserProfile } from "@/lib/types/user";

/**
 * 「我的」页顶部用户信息卡。
 *
 * 数据来自 `UserProfile` DTO（`id / displayId / nickname / avatarUrl / bio`），
 * 五项的取值都由服务端 `lib/services/profile.ts` 从用户仓储里挑出来——
 * **不读 Mock 种子**，因此在编辑资料页改过的昵称/头像/简介在这里立刻是新的。
 *
 * 隐私：这里显示的 `displayId` 是平台自己的用户编号，不是微信 OpenID/UnionID。
 * 本组件拿不到、也不会显示任何微信身份字段（DTO 里根本没有这些字段）。
 *
 * 长文本：昵称与简介都可能很长，右侧按钮又是固定宽度，因此文字列用 `min-w-0` + `truncate`
 * 收缩，绝不允许把卡片撑破或把按钮挤出屏幕。
 *
 * `children` 渲染在资料行**下方、同一块深色底内**（「我的」页用它放消费等级摘要）。
 * 之所以放在这里面而不是下面另起一张卡：等级摘要是资料的一部分，且这样只占一个背景块，
 * 不会出现「两块深色渐变叠在一起」的分层错乱。摘要取数失败时也只影响这一块。
 */
export default function ProfileCard({
  profile,
  children,
}: {
  profile: UserProfile;
  children?: ReactNode;
}) {
  return (
    <div className="mine-hero px-4 pb-14 pt-8">
      <div className="flex items-start gap-3">
        <img
          src={profile.avatarUrl}
          alt=""
          className="h-[68px] w-[68px] shrink-0 rounded-full bg-white/10 object-cover ring-2 ring-mine-avatar-ring"
        />

        <div className="min-w-0 flex-1 pt-1">
          <p className="truncate text-[19px] font-bold leading-7 text-mine-hero-ink">
            {profile.nickname}
          </p>
          {/* ID 是 36 位平台编号，一定会超出卡片宽度，因此截断显示、完整值留在 DOM 与 title 里 */}
          <p className="truncate text-[12px] leading-5 text-mine-hero-ink-soft" title={profile.displayId}>
            ID: {profile.displayId}
          </p>
          <p className="truncate text-[13px] leading-5 text-mine-hero-ink-soft">
            {profile.bio || BIO_EMPTY_PLACEHOLDER}
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <RoundLink href="/settings" label={MINE_SETTINGS_LABEL}>
            <GearGlyph />
          </RoundLink>
          <RoundLink href="/profile/edit" label={MINE_EDIT_LABEL}>
            <PencilGlyph />
          </RoundLink>
        </div>
      </div>

      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}

function RoundLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-mine-hero-button-border bg-mine-hero-button text-mine-hero-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      {children}
    </Link>
  );
}

function glyphProps() {
  return {
    viewBox: "0 0 24 24",
    className: "h-[18px] w-[18px]",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function GearGlyph() {
  return (
    <svg {...glyphProps()}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  );
}

function PencilGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
