import { redirect } from "next/navigation";
import AdminPageHeading from "@/components/admin/AdminPageHeading";
import AdminPasswordForm from "@/components/admin/AdminPasswordForm";
import { isRealAuthEnabled } from "@/lib/auth/realSession";
import { adminHasPassword } from "@/lib/services/adminCredentials";
import { getAdminSession } from "@/lib/services/adminAuth";

/**
 * 管理员账号安全（`/admin/account`）。
 *
 * 目前只有一件事：设置 / 修改本人的登录密码。客服密码由管理员在
 * `/admin/customer-service/[id]` 重置，不在本页——两种「改密码」的授权来源不同。
 *
 * 真实凭据未启用（Mock 数据源）时只说明能力未开放，不渲染表单：
 * 那个环境没有凭据表，表单提交必然 404。
 */
export default async function AdminAccountPage() {
  const admin = await getAdminSession();
  if (!admin) redirect("/admin/login");

  const realAuthEnabled = isRealAuthEnabled();
  const hasPassword = realAuthEnabled ? await adminHasPassword(admin.id) : false;

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeading title="账号安全" backHref="/admin" backLabel="返回概览" />

      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-admin-line px-3 py-2">
            <dt className="text-[12px] text-ink-3">显示名称</dt>
            <dd className="mt-0.5 text-[15px] font-medium text-ink">{admin.displayName}</dd>
          </div>
          <div className="rounded-lg border border-admin-line px-3 py-2">
            <dt className="text-[12px] text-ink-3">登录名</dt>
            <dd className="mt-0.5 font-mono text-[14px] text-ink">{admin.username}</dd>
          </div>
          <div className="rounded-lg border border-admin-line px-3 py-2">
            <dt className="text-[12px] text-ink-3">角色</dt>
            <dd className="mt-0.5 text-[15px] font-medium text-ink">{admin.roleLabel}</dd>
          </div>
        </dl>
      </section>

      {realAuthEnabled ? (
        <AdminPasswordForm hasPassword={hasPassword} />
      ) : (
        <p className="rounded-xl border border-admin-line bg-page px-4 py-3 text-[13px] leading-5 text-ink-3">
          当前为 Mock 数据源，不存在真实凭据，密码管理未开放。切换到 PostgreSQL 数据源后，
          这里可以设置或修改管理员登录密码。
        </p>
      )}
    </div>
  );
}
