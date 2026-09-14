import { redirect } from "next/navigation";
import StaffLoginPanel from "@/components/staff/StaffLoginPanel";
import { isMockStaffEnabled } from "@/lib/config/env";
import { STAFF_MOCK_NOTICE, STAFF_LOGIN_PAGE_TITLE, STAFF_CONSOLE_NAME } from "@/lib/constants/staff";
import { getStaffLoginOptions, getStaffSession } from "@/lib/services/staffAuth";

/**
 * 客服登录页（`/staff/login`）。
 *
 * ⚠️ **本页在 `(console)` 路由组之外**，因此不套工作台壳层：登录页既不该有导航栏，
 * 也不该在「还没登录」的时候先要求登录——那会变成一个转到自己的死循环。
 *
 * 两个分支：
 * - 已经有客服端会话（且是启用的客服）→ 转到 `/staff`，不让人停在登录页；
 * - 没有会话 → 渲染账号选择面板。开关由服务端读取后以 props 传入（客户端读不到环境变量），
 *   开关关闭时面板不渲染任何控件。
 *
 * ⚠️ `getStaffSession()` 判定的是**客服端**会话（`mock_staff_id`）。带着用户端 Cookie
 * 或管理端 Cookie 访问本页，会正常看到这份测试账号名单——另外两套身份在这里
 * 不构成任何权限，也不会被换算成客服身份。
 *
 * ⚠️ 名单在**服务端**过滤（只含启用中且未移除的账号）。前端过滤不算数：
 * 被过滤掉的数据那时已经在响应里了。
 */
export default async function StaffLoginPage() {
  const staff = await getStaffSession();
  if (staff) redirect("/staff");

  const enabled = isMockStaffEnabled();

  return (
    <div className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <main className="w-full max-w-lg rounded-xl border border-admin-line bg-surface p-6">
        <h1 className="text-[20px] font-semibold text-ink">{STAFF_LOGIN_PAGE_TITLE}</h1>
        <p className="mt-1 text-[13px] text-ink-3">{STAFF_CONSOLE_NAME}</p>

        <div className="mt-5">
          <StaffLoginPanel
            options={enabled ? await getStaffLoginOptions() : []}
            enabled={enabled}
            notice={STAFF_MOCK_NOTICE}
          />
        </div>

        <p className="mt-5 border-t border-admin-line pt-4 text-[12px] leading-5 text-ink-3">
          这个入口只用于客服。普通用户请在用户端的「客服」页里发起沟通；
          管理员请在 /admin/login 登录后台。
        </p>
      </main>
    </div>
  );
}
