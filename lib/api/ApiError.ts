import type { ApiErrorCode } from "@/lib/types/common";

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

  constructor(code: ApiErrorCode, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}
