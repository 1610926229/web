/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */
import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import LogoutButton from "@/components/settings/LogoutButton";
import MockUserSwitchButton from "@/components/settings/MockUserSwitchButton";
import RequireAuth from "@/lib/auth/RequireAuth";
import { isMockAuthEnabled } from "@/lib/config/env";
import { PLATFORM_NAME } from "@/lib/constants/site";
import { getUserProfile } from "@/lib/services/profile";

/**
 * 设置页（需登录）。
 *
 * 本阶段**只做四件事**：账号信息摘要、相关协议入口、关于平台（平台名称）、退出登录。
 * 修改密码、绑定手机号、注销账户、隐私开关都还没实现，因此这里**不摆做不到的开关**——
 * 一个点了没反应的开关比没有这个开关更糟。
 *
 * 退出登录入口从「我的」主页移到这里（原先是 P2 验证登录态用的临时控件）。
 * 关闭模拟登录时**整段退出入口都不渲染**：那种部署形态下没有可退的登录态，
 * 界面上也不应出现任何「模拟」措辞或模拟账号切换能力。
 *
 * ⚠️ P0-5 手工验收补进来的「切换 Mock 用户」放在**同一个受开关控制的区块里**，
 * 与退出登录是同一件事的两种说法：切换 = 退出后停在原页，让统一登录界面
 * 接着问「换成谁」。它不引入第二套身份与会话，开关关闭时整块一起消失。
 *
 * 关于平台一栏只显示集中配置里的平台名称占位（`lib/constants/site.ts`），
 * 公司主体、备案号、客服联系方式**一律不编造**，如实说明待确认。
 */
export default function SettingsPage() {
  const mockAuthEnabled = isMockAuthEnabled();

  return (
    <>
      <NavBar title="设置" showBack />

      <RequireAuth>
        {(user) => <SettingsBody userId={user.id} mockAuthEnabled={mockAuthEnabled} />}
      </RequireAuth>
    </>
  );
}

async function SettingsBody({
  userId,
  mockAuthEnabled,
}: {
  userId: string;
  mockAuthEnabled: boolean;
}) {
  const profile = await getUserProfile(userId, undefined, "server");

  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <EmptyState
          title="资料暂不可用"
          description="当前账号的用户资料不存在，请稍后重试。"
        />
      </div>
    );
  }

  return (
    <div className="flex-1 bg-page pb-10">
      <section className="mt-3 bg-surface px-4 py-4">
        <h2 className="mb-3 text-[13px] text-ink-3">账号信息</h2>
        <div className="flex items-center gap-3">
          <img
            src={profile.avatarUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded-full border border-line bg-page object-cover"
          />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium text-ink">{profile.nickname}</p>
            <p className="truncate text-[12px] text-ink-3" title={profile.displayId}>
              ID: {profile.displayId}
            </p>
          </div>
        </div>
      </section>

      <section className="mt-3 bg-surface">
        <Link
          href="/agreements"
          className="flex items-center justify-between px-4 py-3.5 text-[15px] text-ink"
        >
          <span>相关协议</span>
          <Chevron />
        </Link>
        <div className="flex items-center justify-between border-t border-line px-4 py-3.5">
          <span className="text-[15px] text-ink">关于平台</span>
          <span className="text-[14px] text-ink-3">{PLATFORM_NAME}</span>
        </div>
        <p className="border-t border-line px-4 py-3 text-[12px] leading-5 text-ink-3">
          平台名称取自集中配置的占位值；公司主体、备案号与客服联系方式待确认后补充，本阶段不填占位内容。
        </p>
      </section>

      {mockAuthEnabled ? (
        <section className="mt-3 flex flex-col gap-3 bg-surface px-4 py-4">
          <LogoutButton />
          <MockUserSwitchButton />
        </section>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-ink-3"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
