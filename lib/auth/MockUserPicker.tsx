"use client";

import {
  MOCK_LOGIN_APPLICATION_STATE_LABELS,
  MOCK_LOGIN_PICKER_NOTICE,
  MOCK_LOGIN_PICKER_TITLE,
  MOCK_LOGIN_USERS,
} from "@/lib/constants/mockUsers";

/**
 * **测试账号选择器**（仅 Mock 环境）。
 *
 * ## 它做的是「选一个 id」，不是「登录」
 *
 * 这里没有密码框、没有验证码、没有角色开关：本阶段不存在任何真实凭据，
 * 画一个密码框会让人以为它真的验了密码。点一下只做一件事——
 * 把选中的 userId 交给调用方（`LoginGate` 或 DEV-1 的 `MockIdentityPanel`），
 * 由它们走 `authAdapter` 打到 `/api/auth/mock-login`，服务端据此
 * **去仓储查这个人是谁**，然后写 `mock_user_id` Cookie。
 *
 * 因此提交一个不在名单里的 id 不会得到「以这个身份登录」，只会得到 404。
 * 名单是**给人挑的**，不是权限的边界；权限边界在服务端（`lib/auth/session.ts`）。
 *
 * ## 两个宿主，一份名单
 *
 * 选择器本身**不认识登录态**：它只把 userId 交出去。因此同一个组件被两处复用——
 *
 * | 宿主 | 何时出现 | 点了之后 |
 * |---|---|---|
 * | `LoginGate`（登录拦截界面） | **未登录**时 | 登录 |
 * | `MockIdentityPanel`（DEV-1 悬浮面板） | **已登录**时 | 换掉当前会话 |
 *
 * 已登录侧此前只有「退出后重选」一条路（设置页的「切换 Mock 用户」，它只做退出）；
 * DEV-1 起多了一个直接换身份的入口，仍然**只有这一份名单、这一条登录链路**，
 * 不是第二套 Mock 身份系统。两个宿主都在**服务端开关**之下，关闭时整块不渲染。
 *
 * ## 关闭时不可见
 *
 * 渲染与否由宿主决定，而两个宿主的开关值都来自**服务端**
 * （`isMockAuthEnabled()`，客户端读不到环境变量）：`LoginGate` 收 `mockAuthEnabled` prop，
 * `MockIdentitySwitcher` 先判开关再读会话。开关关闭时本组件不渲染任何内容，
 * 名单也不会出现在响应里。
 */
export default function MockUserPicker({
  busyId,
  onPick,
  accessLabels,
  currentUserId,
}: {
  /** 正在登录的账号；非空时全部行禁用，避免连点两个账号 */
  busyId: string | null;
  onPick: (userId: string) => void;
  /**
   * 按 userId 给出的**服务端派生**资格标签（可选）。
   *
   * 只有已登录侧的 DEV-1 面板会传：那里有服务端组件可以现算
   * `resolveCompanionAccess`。未登录的登录界面不传，那一行就不显示——
   * 不是「暂时没有」，而是**它本来就无从判定**（此时没有任何会话）。
   *
   * ⚠️ 它**只是显示**：本组件不拿它做禁用、不做跳转、不做任何判断，
   * 页面放行仍然只由打手守卫决定。传错只会让标签写错，不会放行谁。
   */
  accessLabels?: Record<string, string>;
  /**
   * 当前会话所在的账号（可选），用于「当前身份应有视觉区分」这条要求。
   *
   * 只有已登录侧的 DEV-1 面板会传；登录界面没有会话，因此不传、也就没有哪一行被标出来。
   * ⚠️ 同样**只是显示**：被标出来的那一行**照样可点**（点它就是重新以同一身份登录，
   * 不产生任何副作用），不置灰、不挡点击——「当前」不是一种权限，也不该看起来像权限。
   */
  currentUserId?: string | null;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <div>
        <p className="text-[14px] font-medium text-ink">{MOCK_LOGIN_PICKER_TITLE}</p>
        <p className="mt-1 text-[12px] leading-5 text-ink-3">{MOCK_LOGIN_PICKER_NOTICE}</p>
      </div>

      <ul className="flex flex-col gap-2">
        {MOCK_LOGIN_USERS.map((option) => {
          const busy = busyId === option.userId;
          const accessLabel = accessLabels?.[option.userId];
          const current = currentUserId === option.userId;
          return (
            <li key={option.userId}>
              <button
                type="button"
                onClick={() => onPick(option.userId)}
                disabled={busyId !== null}
                aria-current={current ? "true" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl border bg-surface px-4 py-3 text-left disabled:opacity-60 ${
                  current ? "border-brand-blue-border ring-1 ring-brand-blue-border" : "border-line"
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-ink">
                    {option.nickname}
                  </span>
                  <span className="truncate font-mono text-[12px] text-ink-3">{option.userId}</span>
                  <span className="mt-0.5 truncate text-[12px] text-ink-3">{option.purpose}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {accessLabel ? (
                    <span className="rounded-full border border-brand-blue-border bg-brand-blue-soft px-2 py-0.5 text-[11px] text-brand-blue">
                      {accessLabel}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3">
                    {MOCK_LOGIN_APPLICATION_STATE_LABELS[option.applicationState]}
                  </span>
                  <span className="text-[13px] text-ink-2">
                    {busy ? "登录中…" : current ? "当前身份" : "登录"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
