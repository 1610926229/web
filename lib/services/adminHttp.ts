import { apiGet, apiPatch, apiPost } from "@/lib/api/client";
import {
  ADMIN_APPLICATION_PAGE_SIZE,
  type AdminApplicationStatusFilter,
} from "@/lib/constants/adminApplications";
import {
  ADMIN_COMPANION_PAGE_SIZE,
  type AdminCompanionRemovalFilter,
  type AdminCompanionStateFilter,
} from "@/lib/constants/adminCompanions";
import type { AdminLoginResult, AdminSessionUser } from "@/lib/types/admin";
import type {
  AdminCompanionDetail,
  AdminCompanionListData,
  AdminCompanionProfilePatch,
  AdminCompanionWriteResult,
} from "@/lib/types/companion";
import type {
  AdminApplicationListData,
  AdminApplicationReviewResult,
  AdminCompanionApplicationDetail,
} from "@/lib/types/companionApplication";

/**
 * 管理端的**浏览器端**取数。
 *
 * 与服务端模块 `lib/services/adminAuth.ts` / `adminCompanionApplications.ts` /
 * `adminCompanions.ts` 分开是必须的：那些模块依赖 `lib/data` 与 `lib/mocks`，
 * 一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 *
 * 本文件只做三件事，多一件都不做：拼地址、把请求发出去、把响应按 DTO 类型返回。
 * **没有任何权限判断、没有任何业务规则**——它们都在服务端：
 * 界面上藏起一个按钮不是权限，接口该 401 还是 401、该 403 还是 403。
 *
 * ⚠️ 本文件**不读也不写任何 Cookie**：会话由服务端下发 HttpOnly Cookie 维护，
 * 客户端连「我是谁」都不自己存一份。管理端身份因此不存在于任何页面状态里。
 *
 * ⚠️ 所有写接口都带 `idempotencyKey`，且由**调用方**生成（同一次用户意图内保持不变）。
 * 按钮禁用只能挡住手快，真正的防重在服务端按这个键做重放判定（§九）。
 */

// ——————————————————————————— 会话 ———————————————————————————

/** 当前管理端会话；未登录或没有权限时抛 401 / 403。 */
export function fetchAdminSession(): Promise<AdminSessionUser> {
  return apiGet<AdminSessionUser>("/api/admin/auth/session");
}

/** 模拟管理员登录。不传任何身份信息，登录对象由服务端固定。 */
export function mockLoginAdmin(): Promise<AdminLoginResult> {
  return apiPost<AdminLoginResult>("/api/admin/auth/mock-login");
}

/** 退出登录：服务端删除管理端 Cookie。 */
export function logoutAdmin(): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/api/admin/auth/logout");
}

// ——————————————————————————— 入驻审核 ———————————————————————————

export type AdminApplicationListRequest = {
  status?: AdminApplicationStatusFilter;
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 取一页入驻申请。
 *
 * 只有**筛选与分页**参数，没有任何用户标识：审核人是谁由服务端会话决定，
 * 不由调用方声明。空值不写进地址栏（`?keyword=&gameId=` 只会让日志更难读）。
 */
export function fetchAdminApplications(
  input: AdminApplicationListRequest = {},
): Promise<AdminApplicationListData> {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_APPLICATION_PAGE_SIZE));

  return apiGet<AdminApplicationListData>(`/api/admin/companion-applications?${params.toString()}`);
}

/** 取一条申请的详情（含正文、凭证、申请人摘要与服务端判定的可执行动作）。 */
export function fetchAdminApplication(id: string): Promise<AdminCompanionApplicationDetail> {
  return apiGet<AdminCompanionApplicationDetail>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}`,
  );
}

/**
 * 三个审核动作。都是 POST，请求体只有幂等键（拒绝另加审核意见）。
 *
 * ⚠️ 三个动作是**三个接口**，不是一个「把状态改成 X」的接口：通过会真的建出护航资料
 * 并发放资格，与「开始审核」这种只改一个状态的动作用途完全不同，
 * 合成一个接口就会出现「点错按钮直接把申请通过了」这种不可撤销的后果。
 */
export function startReviewApplication(
  id: string,
  idempotencyKey: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/start-review`,
    { idempotencyKey },
  );
}

export function approveApplication(
  id: string,
  idempotencyKey: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/approve`,
    { idempotencyKey },
  );
}

export function rejectApplication(
  id: string,
  idempotencyKey: string,
  reviewNote: string,
): Promise<AdminApplicationReviewResult> {
  return apiPost<AdminApplicationReviewResult>(
    `/api/admin/companion-applications/${encodeURIComponent(id)}/reject`,
    { idempotencyKey, reviewNote },
  );
}

// ——————————————————————————— 护航管理 ———————————————————————————

export type AdminCompanionListRequest = {
  keyword?: string;
  /** 空串表示全部游戏 */
  gameId?: string;
  state?: AdminCompanionStateFilter;
  removal?: AdminCompanionRemovalFilter;
  page?: number;
  pageSize?: number;
};

/** 取一页护航名单（含已停用与已移除的记录，公开接口看不到后者）。 */
export function fetchAdminCompanions(
  input: AdminCompanionListRequest = {},
): Promise<AdminCompanionListData> {
  const params = new URLSearchParams();
  if (input.keyword) params.set("keyword", input.keyword);
  if (input.gameId) params.set("gameId", input.gameId);
  if (input.state) params.set("state", input.state);
  if (input.removal) params.set("removal", input.removal);
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? ADMIN_COMPANION_PAGE_SIZE));

  return apiGet<AdminCompanionListData>(`/api/admin/companions?${params.toString()}`);
}

/** 取一条护航详情。**已移除的记录照样返回**：后台要能查到「这个人被移除过」。 */
export function fetchAdminCompanion(id: string): Promise<AdminCompanionDetail> {
  return apiGet<AdminCompanionDetail>(`/api/admin/companions/${encodeURIComponent(id)}`);
}

/**
 * 编辑护航资料。
 *
 * 请求体是**整份白名单**（§八）：昵称、头像、介绍、游戏、大区、服务标签、
 * 启用状态、可接单状态、不可接单原因、展示排序。统计、关联用户、来源申请、
 * 移除时间**没有可传的位置**——多传一个字段服务端也不会读。
 */
export function saveCompanionProfile(
  id: string,
  idempotencyKey: string,
  patch: AdminCompanionProfilePatch,
): Promise<AdminCompanionWriteResult> {
  return apiPatch<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}`, {
    idempotencyKey,
    ...patch,
  });
}

/**
 * 四个接单状态动作与移除。
 *
 * ⚠️ 走的是**窄写入**接口（只改状态字段），不是把资料整份写回去：
 * 「暂停接单」不该顺带把昵称、介绍、排序覆盖成按钮渲染时的旧值。
 *
 * 暂停需要给出原因（§八：不可接单必须有原因），其余动作的原因由服务端按规则处理。
 */
export function pauseCompanion(
  id: string,
  idempotencyKey: string,
  unavailableReason: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/pause`, {
    idempotencyKey,
    unavailableReason,
  });
}

export function resumeCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/resume`, {
    idempotencyKey,
  });
}

export function enableCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/enable`, {
    idempotencyKey,
  });
}

export function disableCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(
    `/api/admin/companions/${encodeURIComponent(id)}/disable`,
    { idempotencyKey },
  );
}

export function removeCompanion(
  id: string,
  idempotencyKey: string,
): Promise<AdminCompanionWriteResult> {
  return apiPost<AdminCompanionWriteResult>(`/api/admin/companions/${encodeURIComponent(id)}/remove`, {
    idempotencyKey,
  });
}
