/**
 * 接口通用类型。
 *
 * 统一响应信封：成功 `{ data }`，失败 `{ error: { code, message } }`。
 * 前端只认这一套结构，具体后端由 Mock Route Handler 或未来的真实服务实现。
 */

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "NETWORK_ERROR";

export type ApiSuccessBody<T> = { data: T };

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
  };
};
