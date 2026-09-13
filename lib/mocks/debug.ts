import { ApiError } from "@/lib/api/ApiError";
import { isMockDebugEnabled } from "@/lib/config/env";
import type { HomeData } from "@/lib/types/content";

/**
 * Mock 调试装置（仅服务端使用，由 `ENABLE_MOCK_DEBUG` 总开关控制）。
 *
 * 首页 Server Component 与 `/api/home` 都调用 `withMockHomeDebug`，保证
 * 「页面看到的」与「接口返回的」永远一致，不会出现只在某一条链路上生效的特例。
 *
 * 关闭开关时本模块全部退化为直通：不加延迟、不改数据、不抛错。
 * 真实后端不存在这一层，接入后整个文件删除。
 */

export const MOCK_LATENCY_MS = 400;
const MOCK_LATENCY_MAX_MS = 5000;

export const MOCK_FAULT_MESSAGE = "Mock 故障注入：服务端返回错误（?mockError=1）";

/**
 * 空数据注入的作用范围。首页各模块是独立的视觉段落，因此空态也按模块区分，
 * 而不是「一处为空 = 整页为空」。
 */
export type MockEmptyScope =
  | "none"
  | "sections"
  | "announcements"
  | "activity"
  | "shortcuts"
  | "all";

const SCOPE_VALUES: readonly MockEmptyScope[] = [
  "sections",
  "announcements",
  "activity",
  "shortcuts",
  "all",
];

function mockEmptyScope(params?: URLSearchParams): MockEmptyScope {
  if (!isMockDebugEnabled()) return "none";

  const raw = params?.get("mockEmpty");
  if (raw === null || raw === undefined) return "none";

  // `?mockEmpty=1` 是最早的写法，含义固定为「只清空商品分组」，保持不变
  if (raw === "1") return "sections";

  return SCOPE_VALUES.includes(raw as MockEmptyScope)
    ? (raw as MockEmptyScope)
    : "none";
}

/** 仅当 `?mockError=1` 且调试开关打开时返回 true。 */
function mockErrorRequested(params?: URLSearchParams): boolean {
  if (!isMockDebugEnabled()) return false;
  return params?.get("mockError") === "1";
}

/** 模拟网络延迟；`?mockDelay=<ms>` 可覆盖，上限 5 秒。调试关闭时不延迟。 */
export async function mockLatency(params?: URLSearchParams): Promise<void> {
  if (!isMockDebugEnabled()) return;

  // 注意：参数缺失时 get() 返回 null，而 Number(null) === 0，
  // 若直接 Number(...) 会被当成「显式要求 0 延迟」，默认延迟就永远不生效。
  const raw = params?.get("mockDelay");
  const parsed = raw === null || raw === undefined ? Number.NaN : Number(raw);
  const ms =
    Number.isFinite(parsed) && parsed >= 0
      ? Math.min(parsed, MOCK_LATENCY_MAX_MS)
      : MOCK_LATENCY_MS;

  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按作用范围清空首页的对应模块，其余模块原样保留。 */
function applyMockEmpty(data: HomeData, scope: MockEmptyScope): HomeData {
  if (scope === "none") return data;

  const all = scope === "all";
  return {
    announcements: all || scope === "announcements" ? [] : data.announcements,
    activityImageUrl: all || scope === "activity" ? "" : data.activityImageUrl,
    shortcuts: all || scope === "shortcuts" ? [] : data.shortcuts,
    sections: all || scope === "sections" ? [] : data.sections,
  };
}

/**
 * 按调试参数执行一次首页取数：延迟 → 抛错 / 置空 → 返回数据。
 *
 * 错误以 `ApiError` 抛出：Route Handler 据此生成错误信封，页面交给 error.tsx 展示。
 * 返回空数据集时**不抛错**——空数据不是错误，各模块自行决定隐藏还是显示局部空态。
 */
export async function withMockHomeDebug(
  params: URLSearchParams | undefined,
  load: () => Promise<HomeData>,
): Promise<HomeData> {
  await mockLatency(params);

  if (mockErrorRequested(params)) {
    throw new ApiError("SERVER_ERROR", MOCK_FAULT_MESSAGE, 500);
  }

  return applyMockEmpty(await load(), mockEmptyScope(params));
}
