import type { StaffAccount } from "@/lib/types/staff";
import { mockStaffRepository } from "./mockStaffRepository";

/**
 * 客服账号的可替换仓储。
 *
 * ⚠️ 与用户仓储（`userRepository.ts`）、管理端仓储（`adminRepository.ts`）
 * **是三个仓储**，这一点是刻意的：合成一个仓储再加一个 `role` 字段，就等于让
 * 用户端那条链路拿到了角色信息，而「用户端读不到角色」正是权限无法从用户侧伪造的
 * 原因之一。客服账号还有用户名与头像白名单这些用户记录里根本没有的字段，
 * 混进去只会让两份数据的语义都变模糊。
 *
 * ⚠️ 本层只负责存取与**唯一性**，不做任何权限判断——「这个角色能不能进工作台」
 * 是业务规则，在 `lib/constants/staff.ts` 的 `canEnterStaffConsole()` 与
 * `lib/services/staffAuth.ts` 里判断。
 *
 * ⚠️ 写操作**不在这个接口上**。新增 / 编辑 / 启用 / 停用 / 移除由
 * `lib/data/adminStaffTransaction.ts` 在「业务写入 + 审计写入」同一段不可打断的
 * 同步区段里完成，仓储只提供被它调用的同步原语（见 `mockStaffRepository.ts`）。
 */
export type StaffRepository = {
  /** 按 id 取客服账号；不存在返回 null。**已移除的也返回**（后台要能查到）。 */
  findStaffById(id: string): Promise<StaffAccount | null>;

  /**
   * 按登录名取客服账号，**大小写不敏感**。
   *
   * 唯一性检查用它：`Kefu-Xiaoyu` 与 `kefu-xiaoyu` 是同一个登录名，
   * 否则「大小写不敏感唯一」这条规则只在输入恰好同大小写时才成立。
   */
  findStaffByUsername(username: string): Promise<StaffAccount | null>;

  /** 全部客服账号（含停用与已移除）。仅供管理端与本地 Mock 使用，不进用户端任何响应。 */
  listStaff(): Promise<StaffAccount[]>;

  /**
   * 记录一次成功登录的时间。
   *
   * ⚠️ 这是**审计信息**，不是权限依据：写入失败不应该让登录失败，
   * 因此调用方不依赖它的返回结果。
   */
  markLoggedIn(id: string, at: string): Promise<StaffAccount | null>;
};

export function getStaffRepository(): StaffRepository {
  return mockStaffRepository;
}
