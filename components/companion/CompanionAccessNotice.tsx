import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import {
  COMPANION_BACK_TO_MINE_LABEL,
  COMPANION_CONTACT_SERVICE_LABEL,
  COMPANION_DISABLED_DESCRIPTION,
  COMPANION_DISABLED_TITLE,
  COMPANION_JOIN_LABEL,
  COMPANION_NOT_A_COMPANION_DESCRIPTION,
  COMPANION_NOT_A_COMPANION_TITLE,
} from "@/lib/constants/companionConsole";
import type { CompanionAccessState } from "@/lib/types/companionWorkspace";

/**
 * 「进不去工作台」的两种提示页。
 *
 * ⚠️ 两种情形**必须分开说**，因为使用者下一步该做的事完全不同：
 * - `not-a-companion`：还没通过入驻审核 → 给一条「去申请成为护航」；
 * - `disabled`：资料被下架 → 给一条「联系客服」。
 *
 * 两句提示都**只说事实、指一条路**，不解释平台内部的原因：下架的具体理由属于
 * 平台侧信息，页面上写不出来，写一半反而让人以为要自己去猜。
 *
 * ⚠️ 这里**不是登录页**：能走到这一页的人已经登录了（会话由布局层的 `RequireAuth`
 * 保证）。因此不提供任何账号输入或切换控件——打手没有第二个账号。
 */
export default function CompanionAccessNotice({
  state,
}: {
  /** 只接受两种「不通过」的状态：`granted` 在这里没有意义 */
  state: Exclude<CompanionAccessState, { kind: "granted" }>;
}) {
  const disabled = state.kind === "disabled";

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-16">
      <EmptyState
        title={disabled ? COMPANION_DISABLED_TITLE : COMPANION_NOT_A_COMPANION_TITLE}
        description={disabled ? COMPANION_DISABLED_DESCRIPTION : COMPANION_NOT_A_COMPANION_DESCRIPTION}
      />

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href={disabled ? "/service" : "/join"}
          className="flex h-11 items-center justify-center rounded-full bg-brand-blue px-6 text-[15px] font-medium text-white"
        >
          {disabled ? COMPANION_CONTACT_SERVICE_LABEL : COMPANION_JOIN_LABEL}
        </Link>

        {/* 工作台不在底部 TabBar 里，因此必须给一条明确的退路 */}
        <Link
          href="/mine"
          className="flex h-11 items-center justify-center rounded-full border border-line px-6 text-[15px] text-ink-2"
        >
          {COMPANION_BACK_TO_MINE_LABEL}
        </Link>
      </div>
    </div>
  );
}
