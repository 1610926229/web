import type { AdminAccount } from "@/lib/types/admin";
import { mockAdminRepository } from "./mockAdminRepository";

/**
 * 管理端账号的可替换仓储。
 *
 * ⚠️ 与用户仓储（`userRepository.ts`）**是两个仓储**，这一点是刻意的：
 * 合成一个仓储、加一个 `role` 字段，就等于让用户端那条链路拿到了角色信息，
 * 而「用户端读不到角色」正是管理权限无法从用户侧伪造的原因之一。
 *
 * ⚠️ 本层只负责存取，不做任何权限判断——「这个角色能不能进后台」是业务规则，
 * 在 `lib/constants/admin.ts` 的 `canEnterAdminConsole()` 与
 * `lib/services/adminAuth.ts` 里判断。
 */
export type AdminRepository = {
  /** 按 id 取管理端账号；不存在返回 null。 */
  findAdminById(id: string): Promise<AdminAccount | null>;

  /** 全部管理端账号（含停用的）。仅供本地 Mock 与测试使用，不进任何响应。 */
  listAdmins(): Promise<AdminAccount[]>;

  /**
   * 记录一次成功登录的时间。
   *
   * ⚠️ 这是**审计信息**，不是权限依据：写入失败不应该让登录失败，
   * 因此调用方不依赖它的返回结果。
   */
  markLoggedIn(id: string, at: string): Promise<AdminAccount | null>;
};

export function getAdminRepository(): AdminRepository {
  return mockAdminRepository;
}
