import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
} from "@/lib/constants/platformConfig";
import type { PlatformConfig } from "@/lib/types/platformConfig";

/**
 * 预置的平台参数（建仓时的初始值）。
 *
 * ⚠️ P0-1 起这份配置**由管理后台维护**（`lib/data/adminPlatformConfigTransaction.ts`），
 * 本文件是**建仓时的初始值**：管理员改完之后，业务读到的就是改过的值。
 * 平台参数不能新增、不能移除——新增一项就在 `PlatformConfig` 上加一个**具名、
 * 有类型、有校验**的字段（本阶段三项：公共池超时、完成材料自动审核时长、投诉窗口），
 * 见 `lib/types/platformConfig.ts` 里对「不给配置表加预留字段」的说明。
 *
 * `updatedAt` 用一个**固定的过去时刻**，而不是 `new Date()`：建仓必须可重复且结果相同。
 * 取当前时间会让「预置数据」看起来像「刚刚被人改过」——而它按定义从来没被改过。
 *
 * `updatedByAdminId` 为 null，与上面同一条理由：这个字段是「最近一次是谁改的」，
 * 预置值不是任何管理员改出来的。**不要**在这里填一个管理员 id 来表示「系统」——
 * 那会让审计与记录对不上，而「系统」在本系统里不是一个账号。
 */
export const platformConfigSeed: PlatformConfig = {
  publicPoolTimeoutMinutes: PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  completionAutoApprovalMinutes: COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  complaintWindowMinutes: COMPLAINT_WINDOW_DEFAULT_MINUTES,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedByAdminId: null,
};
