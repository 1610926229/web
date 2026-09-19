/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { COMPANION_ROLE_LABEL } from "@/lib/constants/companionConsole";
import type { CompanionSessionUser } from "@/lib/types/companionWorkspace";

/**
 * 工作台身份卡：这条记录与用户端「陪玩详情」里的那个人是**同一条**。
 *
 * ⚠️ 这是一个**纯展示组件**：`companion` 与 `rankLabel` 都由调用方传进来，
 * 它自己不读会话、不查仓储、不认识 `userId`。
 *
 * 之所以把这一点写成硬约束（有测试逐字扫描本文件，禁止出现任何读取入口）：
 * 工作台的布局与页面在 React 里是**并行渲染**的，如果两边各自去查一次资格，
 * 两次 `await` 之间资格一旦变化，就会出现「布局按旧记录渲染了工作台壳、
 * 内容却取不到资料」的中间态。展示数据只能来自**已经得到的那一份结果**。
 *
 * 本组件由**壳层**渲染（见 `app/companion/(console)/layout.tsx`），
 * 因此拿到的正是那次唯一读取的结果。
 */
export default function CompanionIdentityCard({
  companion,
  rankLabel,
}: {
  companion: CompanionSessionUser;
  /** 与 `companion` 出自同一次读取，不是再查一次得到的 */
  rankLabel: string;
}) {
  return (
    <section className="flex items-center gap-3 rounded-2xl border border-line px-4 py-4">
      <img
        src={companion.avatarUrl}
        alt=""
        className="h-14 w-14 shrink-0 rounded-full border border-line object-cover"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[16px] font-semibold text-ink">{companion.displayName}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-blue-soft px-2 py-0.5 text-[11px] text-brand-blue">
            {COMPANION_ROLE_LABEL}
          </span>
          {rankLabel ? <span className="text-[12px] text-ink-3">{rankLabel}</span> : null}
        </span>
      </div>
    </section>
  );
}
