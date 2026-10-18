import { ApiError } from "@/lib/api/ApiError";
import { PASSWORD_MIN_LENGTH, hashPassword, isValidPassword, verifyPassword } from "@/lib/auth/password";
import { destroyRealSession, isRealAuthEnabled } from "@/lib/auth/realSession";
import {
  findAdminCredentialById,
  hasAdminPassword,
  setAdminPasswordWithAudit,
  setStaffPasswordWithAudit,
} from "@/lib/data/pg/authRepository";
import { getStaffRepository } from "@/lib/data/staffRepository";
import type { AdminSessionUser } from "@/lib/types/admin";

/**
 * 管理员 / 客服的凭据管理（**仅服务端**）。
 *
 * ## 三种写入，同一个原则
 *
 * 1. **管理员首次设置自己的密码**：账号还没有凭据行，允许直接设置。
 * 2. **管理员修改自己的密码**：必须验证当前密码。修改成功后该管理员的**全部会话**
 *    被吊销（包括当前这一个），调用方必须重新登录——「改密码」与「旧会话失效」
 *    是同一个事实，不能只做一半。
 * 3. **管理员重置客服密码**：管理员已通过 `requireAdmin()`，无需旧密码；
 *    目标客服的全部会话在同一个事务里被吊销并写审计。
 *
 * ⚠️ 密码只在 `hashPassword()` 之后进入数据库与函数参数，审计的 before/after
 * 只记时间事实。任何错误信息、返回值里都不出现密码或哈希。
 * ⚠️ 所有函数在 `DATA_SOURCE` 不是 postgres 时按「接口不存在」返回 404。
 */

export const PASSWORD_TOO_SHORT_MESSAGE = `密码长度需为 ${PASSWORD_MIN_LENGTH}–128 个字符`;
export const CURRENT_PASSWORD_WRONG_MESSAGE = "当前密码不正确";
export const CREDENTIALS_DISABLED_MESSAGE = "密码管理尚未开放";
export const STAFF_NOT_FOUND_MESSAGE = "客服账号不存在";

export function assertCredentialManagementEnabled(): void {
  if (!isRealAuthEnabled()) {
    throw new ApiError("NOT_FOUND", CREDENTIALS_DISABLED_MESSAGE, 404);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireValidNewPassword(value: unknown): string {
  const password = asString(value);
  if (!isValidPassword(password)) {
    throw new ApiError("BAD_REQUEST", PASSWORD_TOO_SHORT_MESSAGE);
  }
  return password;
}

/**
 * 当前管理员是否已经设置过密码（仅用于**呈现**：首次设置不需要旧密码）。
 *
 * ⚠️ 这不是授权判断：能不能改密码由 `requireAdmin()` 与 `setOwnAdminPassword()`
 * 决定。Mock 数据源下恒为 `false`——那个环境里根本没有凭据表。
 */
export async function adminHasPassword(adminId: string): Promise<boolean> {
  if (!isRealAuthEnabled()) return false;
  return hasAdminPassword(adminId);
}

export type SetOwnPasswordResult = {
  ok: true;
  /** 改密会吊销当前会话；客户端必须清掉本地状态并回登录页 */
  reLoginRequired: true;
};

/**
 * 管理员设置 / 修改**本人**密码。
 *
 * 首次设置（还没有凭据行）不需要旧密码；已经有密码时 `currentPassword` 必填。
 * 这里不区分「账号没有凭据」与「读取失败」之外的情形——账号来自有效会话，
 * 其存在性已由守卫保证。
 */
export async function setOwnAdminPassword(
  admin: AdminSessionUser,
  input: { currentPassword: unknown; newPassword: unknown },
): Promise<SetOwnPasswordResult> {
  assertCredentialManagementEnabled();

  const newPassword = requireValidNewPassword(input.newPassword);
  const existing = await findAdminCredentialById(admin.id);

  if (existing) {
    const currentPassword = asString(input.currentPassword);
    if (!currentPassword) {
      throw new ApiError("BAD_REQUEST", "请输入当前密码");
    }
    const matches = await verifyPassword(currentPassword, existing.passwordHash);
    if (!matches) {
      throw new ApiError("FORBIDDEN", CURRENT_PASSWORD_WRONG_MESSAGE, 403);
    }
  }

  await setAdminPasswordWithAudit({
    adminId: admin.id,
    passwordHash: await hashPassword(newPassword),
    at: new Date().toISOString(),
  });

  // 事务里已经吊销了这个管理员的全部会话；这里把当前请求的 Cookie 也清掉。
  await destroyRealSession("admin");

  return { ok: true, reLoginRequired: true };
}

/**
 * 管理员重置某位客服的登录密码。
 *
 * ⚠️ 目标账号必须存在（未移除或已移除的都算存在——管理员可能需要先设密码再启用）。
 * 事务会吊销该客服的全部会话并写一条 `staff.reset-password` 审计。
 */
export async function resetStaffPassword(
  admin: AdminSessionUser,
  staffId: string,
  newPasswordInput: unknown,
): Promise<{ ok: true }> {
  assertCredentialManagementEnabled();

  const newPassword = requireValidNewPassword(newPasswordInput);

  const staff = await getStaffRepository().findStaffById(staffId);
  if (!staff) {
    throw new ApiError("NOT_FOUND", STAFF_NOT_FOUND_MESSAGE, 404);
  }

  await setStaffPasswordWithAudit({
    staffId: staff.id,
    passwordHash: await hashPassword(newPassword),
    adminId: admin.id,
    at: new Date().toISOString(),
  });

  return { ok: true };
}
