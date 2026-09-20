import { apiGet, apiPost } from "@/lib/api/client";
import type { CompanionPoolData, DispatchAcceptOutcome } from "@/lib/types/dispatch";

/**
 * 打手工作台的**浏览器端**取数（P0-5）。
 *
 * 与服务端模块 `lib/services/companionDispatch.ts` 分开是必须的：那个模块依赖
 * `lib/data` 与 `lib/mocks`，一旦被客户端组件引用，Mock 存储与种子数据就会被打进
 * 浏览器产物。池子页的首屏由 Server Component 直接取数，不经过本文件；
 * 本文件只服务于「接单」这一个交互，以及接单成功后的整页刷新。
 *
 * ⚠️ 请求里**没有打手标识**：以谁的身份接单由服务端会话决定（`requireCompanion()`），
 * 调用方改不动。因此这里也没有「接谁的班」这种参数。
 */

/** 读当前打手能看到的两张池子。返回的 `exclusive` 只包含指定给他的单。 */
export function fetchCompanionPools(): Promise<CompanionPoolData> {
  return apiGet<CompanionPoolData>("/api/companion/dispatches");
}

/**
 * 接单。
 *
 * ⚠️ 返回的是**业务结果**而不是「成功 / 抛错」：`{ kind: "not-open" }`
 * （被别人先接走了）是正常的抢单结果，客户端必须按 `kind` 决定说什么话，
 * 而不是把所有失败都塞进一个 `catch`——那里分不出「被抢了」与「网断了」。
 * 只有鉴权失败（未登录 401 / 不是打手或资格已下架 403）才会抛 `ApiError`。
 */
export function acceptDispatchRequest(dispatchId: string): Promise<DispatchAcceptOutcome> {
  return apiPost<DispatchAcceptOutcome>(
    `/api/companion/dispatches/${encodeURIComponent(dispatchId)}/accept`,
  );
}
