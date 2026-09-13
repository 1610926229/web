import { getSessionUser } from "@/lib/auth/session";
import type { User } from "@/lib/types/user";
import { ApiError } from "./ApiError";

/**
 * Route Handler 的公共部分：统一响应信封、错误归一、请求体解析、登录校验。
 *
 * 抽出来的理由不是「少写几行」，而是让所有接口对错误和鉴权的处理**只有一套**：
 * 任何一处漏掉 try/catch，都会把一个内部异常直接变成 500 页面而不是错误信封，
 * 客户端就会拿到无法解析的响应。
 */

/** 成功响应：`{ data }`。 */
export function ok<T>(data: T): Response {
  return Response.json({ data });
}

/** 失败响应：`{ error: { code, message } }`，状态码取 ApiError 自带的。 */
export function fail(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status > 0 ? error.status : 500 },
  );
}

/**
 * 把任意异常归一成 `ApiError`。
 * 非 `ApiError` 一律按服务端错误处理，不把内部异常信息暴露给客户端。
 */
export function toApiError(cause: unknown, fallbackMessage = "服务暂时不可用，请稍后重试"): ApiError {
  return cause instanceof ApiError ? cause : new ApiError("SERVER_ERROR", fallbackMessage);
}

/** 读取 JSON 请求体；不是对象时抛 `BAD_REQUEST`。 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "请求体格式无效");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("BAD_REQUEST", "请求体格式无效");
  }
  return body as Record<string, unknown>;
}

/**
 * 要求已登录，返回当前用户；未登录抛 `UNAUTHORIZED`。
 *
 * 判断登录与否只走服务端会话（`lib/auth/session.ts`），不接受请求体或查询参数里的
 * 任何用户标识——「我是谁」只能由会话决定，不能由调用方声明。
 */
export async function requireUser(): Promise<User> {
  const user = await getSessionUser();
  if (!user) throw new ApiError("UNAUTHORIZED", "请先登录", 401);
  return user;
}
