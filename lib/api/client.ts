import { ApiError } from "./ApiError";
import type { ApiErrorBody, ApiErrorCode } from "@/lib/types/common";

/**
 * **浏览器端**唯一的 HTTP 出口。
 *
 * 页面与组件不得直接 `fetch`，一律经 `lib/services/*` 调用这里；换后端时只改本文件。
 * 不配置任何远端 baseURL：Mock 接口与页面同源，也为将来同源部署预留。
 *
 * 服务端读取不经过本文件——Server Component 若通过 HTTP 请求本项目自身的 Route Handler，
 * 会带来构建期自请求、依赖部署地址和多一次网络跳转，因此服务端走 `lib/data/source.ts`。
 */

export { ApiError };

const TIMEOUT_MS = 10_000;

/** 服务端错误码缺失时按 HTTP 状态兜底归类。 */
function normalizeCode(code: string | undefined, status: number): ApiErrorCode {
  const known: ApiErrorCode[] = [
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "SERVER_ERROR",
    "NETWORK_ERROR",
  ];
  if (code && (known as string[]).includes(code)) return code as ApiErrorCode;
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  return "SERVER_ERROR";
}

/**
 * Mock 阶段的故障注入参数透传（`mockError` / `mockEmpty` / `mockDelay`）。
 *
 * 这三个参数只被 Mock Route Handler 读取，真实后端会直接忽略，
 * 因此这里无条件透传，不额外加环境判断。Mock 层移除时一并删除本函数。
 */
const MOCK_PARAM_KEYS = ["mockError", "mockEmpty", "mockDelay"] as const;

function withMockParams(path: string): string {
  if (typeof window === "undefined") return path;

  const current = new URLSearchParams(window.location.search);
  const extra = new URLSearchParams();
  for (const key of MOCK_PARAM_KEYS) {
    const value = current.get(key);
    if (value !== null) extra.set(key, value);
  }

  const query = extra.toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(withMockParams(path), {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new ApiError(
      "NETWORK_ERROR",
      timedOut ? "请求超时，请稍后重试" : "网络异常，请检查网络后重试",
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON 响应（如网关错误页）按下面的状态码分支处理
  }

  if (!response.ok) {
    const failure = (body as ApiErrorBody | null)?.error;
    throw new ApiError(
      normalizeCode(failure?.code, response.status),
      failure?.message ?? "服务暂时不可用，请稍后重试",
      response.status,
    );
  }

  return (body as { data: T }).data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 部分更新（如编辑资料只提交昵称 / 头像 / 简介三个字段）。 */
export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 删除（如取消收藏）。不带请求体：要删什么由路径决定。 */
export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}
