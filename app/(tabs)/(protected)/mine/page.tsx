import EmptyState from "@/components/common/EmptyState";
import MineMenu from "@/components/mine/MineMenu";
import ProfileCard from "@/components/mine/ProfileCard";
import RequireAuth from "@/lib/auth/RequireAuth";
import { getUserProfile } from "@/lib/services/profile";

/**
 * 我的（需登录）。
 *
 * 结构照 `docs/prototype/MinePage.jpg`：顶部深紫点阵渐变的信息卡，下接一张圆角白纸，
 * 纸上是「全部功能」（四个主入口 + 分隔线 + 小宫格）。**不自行重新设计信息架构**：
 * 入口的名称、数量与排列顺序都取自原型，清单集中配置在 `lib/constants/mine.ts`。
 *
 * 几处刻意的决定：
 * - **没有 NavBar**：原型里信息卡直接顶到最上沿，标题栏会把它压下去。
 * - 这是**一级 Tab 页**，保留底部 TabBar；二级页（编辑资料 / 设置 / 收藏）在别的路由组，不带 TabBar。
 * - 资料由服务端取（不通过 HTTP 请求自己的接口），首屏就没有加载闪烁；
 *   同一份取数也供 `/api/me` 使用，两条链路的字段与规则只有一套。
 * - 这里**不注入 Mock 故障参数**：服务端首屏被一个查询参数打成错误页不是想要的调试体验，
 *   故障注入只在浏览器端请求时生效（与订单页一致）。
 */
export default function MinePage() {
  return (
    <RequireAuth>
      {(user) => <MineBody userId={user.id} />}
    </RequireAuth>
  );
}

async function MineBody({ userId }: { userId: string }) {
  const profile = await getUserProfile(userId, undefined, "server");

  // 会话有效但资料已不存在：如实说明，不编一份假资料出来
  if (!profile) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-16">
        <EmptyState
          title="资料暂不可用"
          description="当前账号的用户资料不存在，可在设置页退出登录后重新登录。"
        />
      </div>
    );
  }

  return (
    <>
      <ProfileCard profile={profile} />

      {/* 圆角白纸上浮，压住信息卡下沿，形成原型里「纸张盖在背景上」的分层 */}
      <div className="-mt-6 flex-1 rounded-t-[24px] bg-surface px-4 pb-8 pt-2">
        <SheetHandle />
        <MineMenu />
      </div>
    </>
  );
}

/** 白纸顶部的抓手（原型样式：短横线 + 向下的小三角）。 */
function SheetHandle() {
  return (
    <div className="flex flex-col items-center gap-1 pb-3 pt-1" aria-hidden>
      <span className="h-1 w-10 rounded-full bg-line" />
      <svg viewBox="0 0 12 6" className="h-1.5 w-3 text-ink-3/40">
        <path d="M0 0h12L6 6z" fill="currentColor" />
      </svg>
    </div>
  );
}
