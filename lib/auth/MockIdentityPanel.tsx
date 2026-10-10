"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MOCK_IDENTITY_CLOSE_LABEL,
  MOCK_IDENTITY_CURRENT_LABEL,
  MOCK_IDENTITY_GUEST_LABEL,
  MOCK_IDENTITY_LOGOUT_LABEL,
  MOCK_IDENTITY_NOTICE,
  MOCK_IDENTITY_TOOL_LABEL,
  MOCK_IDENTITY_TOOL_TITLE,
} from "@/lib/constants/mockUsers";
import { authAdapter } from "./MockAuthAdapter";
import MockUserPicker from "./MockUserPicker";

/**
 * DEV-1：用户端全局的**身份切换面板**（仅 Mock / 开发环境）。
 *
 * ## 它不是第二种登录方式
 *
 * 它做的只有两件事，各自复用既有链路，一行新协议都没有：
 *
 * ```
 * 点某个账号 → authAdapter.login(userId) → POST /api/auth/mock-login → 换掉同一个 Cookie
 * 点退出     → authAdapter.logout()      → POST /api/auth/logout      → 清掉同一个 Cookie
 * ```
 *
 * 因此它是**同一个会话的替换**，不是第二套登录态：没有新 Cookie、没有新会话模型、
 * 没有打手专用登录、没有新仓储。`mock_user_id` 仍然是唯一的用户会话 Cookie，
 * 打手资格仍然只由「这个用户名下有没有有效护航资料」在服务端查出来。
 *
 * ⚠️ 正因为如此，点完之后**不能**靠本地状态假装换成功了：必须 `router.refresh()`
 * 让服务端按新会话重新渲染，导航、「我的」、打手工作台资格才会跟着变
 * （与 `LoginGate` / `MockUserSwitchButton` 同一个做法）。
 *
 * ## 为什么不用 `useAuth()`
 *
 * `AuthProvider` 只长在 `RequireAuth` 保护的页面里，而本面板挂在**全局布局**上——
 * 首页、商品详情这些免登录页面也在内，那里没有 Provider，`useAuth()` 会直接抛错。
 * 因此与 `LoginGate` 一样直接调用 `authAdapter`：它才是「登录这件事」的唯一切口，
 * `useAuth()` 只是给页面用的上下文包装。
 *
 * ## 开关关闭时它根本不存在
 *
 * 渲染与否由**服务端**决定（`MockIdentitySwitcher` 先判 `isMockAuthEnabled()`，
 * 关闭时直接返回 `null`）。本组件连「开关」这个概念都不认识，因此客户端
 * 不可能通过任何手段把它调出来；名单也不会进入关闭状态的响应。
 *
 * ## 展示与遮挡
 *
 * 折叠时只占右下角一个两行小按钮，展开后是一块可滚动面板（`max-h-[70dvh]`），
 * 底边抬到 TabBar 之上，不压住底部导航。它**没有任何页面权限判断**：
 * 切到一个当前页面进不去的身份时，由现有权限体系照常处理（§九），本工具不绕路。
 *
 * ⚠️ 抬升的高度必须把**底部安全区**算进去，不能只减 `--tabbar-height`：
 * TabBar 外面套着 `SafeAreaContainer`（`pb-[env(safe-area-inset-bottom)]`），
 * 带 Home Indicator 的真机上它实际比我这一层看到的高一截。只减 56px 的话，
 * 折叠按钮会压住 TabBar 顶部、在结算页还会盖住「去支付」——而桌面模拟器里
 * `env()` 恒为 0，这个 bug 只在真机上出现。因此与仓库其它贴底元素用同一算法。
 */
export default function MockIdentityPanel({
  current,
  accessLabels,
}: {
  /** 当前会话用户；`null` 表示游客。由服务端从会话读出后传入，客户端不自己拉。 */
  current: { userId: string; nickname: string } | null;
  /**
   * 按 userId 给出的**服务端派生**资格标签（可选），原样透传给选择器。
   *
   * 本组件**只转发、不解释**：它自己既不判断谁是打手，也不拿标签做禁用或跳转。
   * 判定发生在 `MockIdentitySwitcher`（服务端），依据是 `resolveCompanionAccess`——
   * 也就是打手守卫用的同一个函数。想改「谁是打手」，改 Data，不改这里。
   */
  accessLabels?: Record<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /** 正在登录的那个账号 id（不是布尔值：选择器要指出是哪一行在转圈） */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = pendingId !== null || loggingOut;

  const handlePick = (userId: string) => {
    if (busy) return;
    setPendingId(userId);
    setError(null);

    void authAdapter
      .login(userId)
      .then(() => {
        // ⚠️ 面板**不关闭**：连续换两三个身份时，关掉再展开是多余动作。
        // 刷新后 `current` 由服务端给出新身份，面板上的「当前身份」随之更新。
        router.refresh();
      })
      .catch(() => setError("切换失败，请重试"))
      .finally(() => setPendingId(null));
  };

  const handleLogout = () => {
    if (busy) return;
    setLoggingOut(true);
    setError(null);

    void authAdapter
      .logout()
      .then(() => {
        router.refresh();
      })
      .catch(() => setError("退出失败，请重试"))
      .finally(() => setLoggingOut(false));
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center">
      <div className="w-full max-w-[var(--shell-width)] px-3 pb-[calc(var(--tabbar-height)+0.75rem+env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-stretch gap-2">
          {open ? (
            <section
              aria-label={MOCK_IDENTITY_TOOL_TITLE}
              className="pointer-events-auto max-h-[70dvh] overflow-y-auto rounded-2xl border border-line bg-surface p-4 shadow-[0_8px_28px_rgba(0,0,0,0.16)]"
            >
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-ink">{MOCK_IDENTITY_TOOL_TITLE}</p>
                  <p className="mt-1 truncate text-[12px] text-ink-3">
                    {MOCK_IDENTITY_CURRENT_LABEL}：
                    {current ? `${current.nickname}（${current.userId}）` : MOCK_IDENTITY_GUEST_LABEL}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-3"
                >
                  {MOCK_IDENTITY_CLOSE_LABEL}
                </button>
              </header>

              <p className="mt-2 text-[12px] leading-5 text-ink-3">{MOCK_IDENTITY_NOTICE}</p>

              {/*
                退出进行中时账号行也要看得出「忙」：`MockUserPicker` 的忙碌信号只有
                `busyId`（选择器本来就只认识「正在登录哪个账号」），而退出没有对应的
                账号行。这里不去扩选择器的忙碌参数，改用一层与禁用态同款的视觉表达，
                避免出现「按钮看起来能点、点下去没反应」的中间态。
              */}
              <div
                className={`mt-3 ${loggingOut ? "pointer-events-none opacity-60" : ""}`}
                aria-busy={loggingOut}
              >
                <MockUserPicker
                  busyId={pendingId}
                  onPick={handlePick}
                  accessLabels={accessLabels}
                  currentUserId={current?.userId ?? null}
                />
              </div>

              {error ? (
                <p role="alert" className="mt-2 text-[13px] text-brand-red">
                  {error}
                </p>
              ) : null}

              <button
                type="button"
                onClick={handleLogout}
                disabled={busy}
                className="mt-3 w-full rounded-[10px] border border-line py-2.5 text-[14px] text-ink-2 disabled:opacity-60"
              >
                {loggingOut ? "退出中…" : MOCK_IDENTITY_LOGOUT_LABEL}
              </button>
            </section>
          ) : null}

          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="pointer-events-auto self-end rounded-xl border border-line bg-surface px-3 py-2 text-left shadow-[0_4px_14px_rgba(0,0,0,0.14)]"
          >
            <span className="flex flex-col leading-tight">
              <span className="text-[11px] text-ink-3">{MOCK_IDENTITY_TOOL_LABEL}（开发工具）</span>
              <span className="max-w-[180px] truncate text-[13px] font-medium text-ink">
                {current ? current.nickname : MOCK_IDENTITY_GUEST_LABEL}
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
