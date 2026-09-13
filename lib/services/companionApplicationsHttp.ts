import { apiGet, apiPost } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import type {
  CompanionApplicationCreateResult,
  CompanionApplicationDetail,
  CompanionApplicationWithdrawResult,
} from "@/lib/types/companionApplication";

/**
 * 护航入驻申请的**浏览器端**取数（提交、撤销、读取自己的申请）。
 *
 * 与服务端模块 `lib/services/companionApplications.ts` 分开是必须的：那个模块依赖
 * `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，Mock 层与内存存储就会被打进浏览器产物。
 * 进度页与 `/join` 的首屏由 Server Component 直接取数，不经过本文件。
 *
 * ⚠️ 请求里**没有用户标识**：查谁的申请、以谁的身份提交，都由服务端会话决定，
 * 调用方改不动。
 */

/** 提交申请时提交给服务端的字段，**全部是用户填写的表单内容**。 */
export type CompanionApplicationSubmitInput = {
  displayName: string;
  gameIds: string[];
  regions: string[];
  serviceTags: string[];
  experience: string;
  introduction: string;
  /** Mock 专用的联系说明（纯文本） */
  contactNote: string;
  evidence: EvidenceDraft[];
  idempotencyKey: string;
};

/**
 * 提交入驻申请。
 *
 * 请求体里**只有**表单内容与幂等键：`userId` / 单号 / 状态 / 审核时间 / 审核备注
 * 都由服务端写，客户端塞什么都不算。同一个幂等键重复提交不会报错，返回第一次的结果。
 */
export function submitCompanionApplication(
  input: CompanionApplicationSubmitInput,
): Promise<CompanionApplicationCreateResult> {
  return apiPost<CompanionApplicationCreateResult>("/api/companion-applications", {
    displayName: input.displayName,
    gameIds: input.gameIds,
    regions: input.regions,
    serviceTags: input.serviceTags,
    experience: input.experience,
    introduction: input.introduction,
    contactNote: input.contactNote,
    evidence: input.evidence,
    idempotencyKey: input.idempotencyKey,
  });
}

/** 读当前用户的入驻申请；没有申请时 `application` 为 null（不是错误，也不是 404）。 */
export function fetchMyCompanionApplication(): Promise<{
  application: CompanionApplicationDetail | null;
}> {
  return apiGet<{ application: CompanionApplicationDetail | null }>(
    "/api/me/companion-application",
  );
}

/**
 * 撤销一条入驻申请。
 *
 * 只有「待查看」可以撤销；重复撤销返回同一条记录。申请不存在、或不属于当前用户时
 * 接口返回**同一个 404**。
 */
export function withdrawCompanionApplication(
  applicationId: string,
): Promise<CompanionApplicationWithdrawResult> {
  return apiPost<CompanionApplicationWithdrawResult>(
    `/api/companion-applications/${applicationId}/withdraw`,
  );
}
