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

/**
 * 分页结果。
 *
 * 只在确实有分页列表时才使用（P3 的分类页商品列表）；详情等单条读取不使用本类型。
 * `page` 从 1 开始；`hasMore` 由服务端算好，前端不自行用 total 推导，避免两侧口径不一致。
 */
export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};
