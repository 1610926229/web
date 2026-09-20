"use client";

import {
  MOCK_LOGIN_APPLICATION_STATE_LABELS,
  MOCK_LOGIN_PICKER_NOTICE,
  MOCK_LOGIN_PICKER_TITLE,
  MOCK_LOGIN_USERS,
} from "@/lib/constants/mockUsers";

/**
 * 登录界面上的**测试账号选择器**（仅 Mock 环境）。
 *
 * ## 它做的是「选一个 id」，不是「登录」
 *
 * 这里没有密码框、没有验证码、没有角色开关：本阶段不存在任何真实凭据，
 * 画一个密码框会让人以为它真的验了密码。点一下只做一件事——
 * 把选中的 userId 交给 `LoginGate`，由它调用 `/api/auth/mock-login`，
 * 服务端据此**去仓储查这个人是谁**，然后写 `mock_user_id` Cookie。
 *
 * 因此提交一个不在名单里的 id 不会得到「以这个身份登录」，只会得到 404。
 * 名单是**给人挑的**，不是权限的边界；权限边界在服务端（`lib/auth/session.ts`）。
 *
 * ## 为什么它不在「我的」页面
 *
 * ⚠️ 选择器**只出现在登录界面**，而登录界面只在**未登录**时出现。
 * 已登录的页面（「我的」「设置」）里没有第二处账号切换——除了设置页那个
 * 同样受开关控制的「切换 Mock 用户」入口，它做的事是**退出登录**，
 * 然后停在同一页看这个选择器。切换 = 退出 + 重新选，没有第三条路径。
 *
 * 这样安排是因为：正式产品的账号由微信登录决定，用户前台不该有「换个身份」的按钮。
 * 把切换收敛成「退出后重新登录」，正式环境（开关关闭）下这个组件根本不会被渲染，
 * 无需为它再写一套「上线前记得删掉」的代码。
 *
 * ## 关闭时不可见
 *
 * 渲染与否由 `LoginGate` 的 `mockAuthEnabled` 决定，那个值来自**服务端**
 * （`isMockAuthEnabled()`，客户端读不到环境变量）。开关关闭时本组件不渲染任何内容，
 * 名单也不会出现在响应里。
 */
export default function MockUserPicker({
  busyId,
  onPick,
}: {
  /** 正在登录的账号；非空时全部行禁用，避免连点两个账号 */
  busyId: string | null;
  onPick: (userId: string) => void;
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
          return (
            <li key={option.userId}>
              <button
                type="button"
                onClick={() => onPick(option.userId)}
                disabled={busyId !== null}
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left disabled:opacity-60"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-ink">
                    {option.nickname}
                  </span>
                  <span className="truncate font-mono text-[12px] text-ink-3">{option.userId}</span>
                  <span className="mt-0.5 truncate text-[12px] text-ink-3">{option.purpose}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-3">
                    {MOCK_LOGIN_APPLICATION_STATE_LABELS[option.applicationState]}
                  </span>
                  <span className="text-[13px] text-ink-2">{busy ? "登录中…" : "登录"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
