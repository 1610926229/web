import type { ApiErrorCode } from "@/lib/types/common";

/**
 * 错误码到 HTTP 状态码的默认映射。
 *
 * 有这个映射，调用方只需要说清「是什么错」（`code`），不必每次再重复一遍状态码；
 * 少数想刻意区分的场合（例如「模拟支付未启用」用 404 而不是 403）仍然可以显式传入。
 *
 * ⚠️ 缺了它就会出现「业务校验失败却回 500」：客户端拿到的错误码是 BAD_REQUEST，
 * 状态码却是 500，重试策略与日志都会把它当成服务端故障。
 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
  // 只在浏览器侧产生（请求没能到达服务端），不参与 HTTP 状态映射
  NETWORK_ERROR: 0,
};

/**
 * 带业务错误码的异常。
 *
 * 单独成文件，是因为它同时被两侧使用：
 * - 浏览器侧：`lib/api/client.ts` 在非 2xx / 网络异常时抛出；
 * - 服务端侧：`lib/services/*` 与 Route Handler 共用同一套错误词汇。
 *
 * 页面只关心 `message`（交给 error.tsx 展示），Route Handler 关心 `code` 与 `status`
 * （转成错误信封）。
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** HTTP 状态码；非 HTTP 来源（网络层失败）时为 0 */
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
  }
}
