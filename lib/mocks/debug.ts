import { ApiError } from "@/lib/api/ApiError";
import { isMockDebugEnabled } from "@/lib/config/env";
import type { HomeData } from "@/lib/types/content";

/**
 * Mock 调试装置（仅服务端使用，由 `ENABLE_MOCK_DEBUG` 总开关控制）。
 *
 * 同一条取数链路（`lib/services/*`）被两侧调用：页面在服务端直接取数渲染，浏览器则经
 * Route Handler 取数。两侧传入同一组调试参数、共用同一套实现，因此「页面看到的」与
 * 「接口返回的」不会分叉。
 *
 * 关闭开关时本模块全部退化为直通：不加延迟、不改数据、不抛错。
 * 真实后端不存在这一层，接入后整个文件删除。
 */

export const MOCK_LATENCY_MS = 400;
const MOCK_LATENCY_MAX_MS = 5000;

/**
 * 取数发生在哪一侧。
 *
 * 存在的意义是支持 `?mockError=api`：只让**浏览器端请求**失败，从而观察列表等局部
 * 区域的错误态与重试，而不把整个服务端渲染的页面打挂。`?mockError=1` 则两侧都失败。
 */
export type MockSurface = "server" | "http";

/**
 * 空数据注入的作用范围。首页各模块是独立的视觉段落，因此空态也按模块区分，
 * 而不是「一处为空 = 整页为空」。
 *
 * `levels` / `agreements` / `rankings` / `companions` 不属于首页，而是给消费等级、
 * 协议、排行榜与陪玩列表四个页面用的：它们的空态是**整块功能没有数据**
 * （等级配置为空、协议全部未配置、榜单无人上榜、陪玩名单为空），
 * 既不可能靠改一条数据造出来，也不该为了验收去删预置数据。
 */
export type MockEmptyScope =
  | "none"
  | "sections"
  | "announcements"
  | "activity"
  | "shortcuts"
  | "levels"
  | "agreements"
  | "rankings"
  | "companions"
  | "applications"
  // 管理后台：类目与商品两组列表分别清空（P8B）
  | "categories"
  | "products"
  // 管理后台：订单、退款、投诉三张列表分别清空（P8C）。
  // 三者分开而不是合成一个 `admin`：验收时要看的是「这一张列表的空态」，
  // 一次清空三张只会让人分不清是空态生效了还是页面坏了
  | "orders"
  | "refunds"
  | "complaints"
  // 管理后台：客服账号列表清空（P8D-1）。
  // 单独一个范围而不是并进 `all` 之外的某个已有值：客服账号与订单、退款、投诉
  // 不在同一张列表上，混在一起会让「空态是生效了还是页面坏了」变得说不清
  | "staff"
  | "all";

const SCOPE_VALUES: readonly MockEmptyScope[] = [
  "sections",
  "announcements",
  "activity",
  "shortcuts",
  "levels",
  "agreements",
  "rankings",
  "companions",
  // 管理后台概览：把申请与护航两组数字分别清零，用来验证「全部为 0」时的安全降级
  "applications",
  "categories",
  "products",
  "orders",
  "refunds",
  "complaints",
  "staff",
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

/** 返回本次请求要注入的错误写法（`1` / `api`），未要求注入时返回 null。 */
function mockErrorScope(
  params: URLSearchParams | undefined,
  surface: MockSurface,
): "1" | "api" | null {
  if (!isMockDebugEnabled()) return null;

  const raw = params?.get("mockError");
  if (raw === "1") return "1";
  if (raw === "api" && surface === "http") return "api";
  return null;
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
 * 按调试参数执行一次取数：延迟 → （必要时）抛错 → 返回真实数据。
 *
 * 错误以 `ApiError` 抛出：Route Handler 据此生成错误信封，页面交给 error.tsx
 * 或调用方的局部错误态展示。
 */
export async function withMockDebug<T>(
  params: URLSearchParams | undefined,
  surface: MockSurface,
  load: () => Promise<T>,
): Promise<T> {
  await mockLatency(params);

  const scope = mockErrorScope(params, surface);
  if (scope) {
    throw new ApiError(
      "SERVER_ERROR",
      `Mock 故障注入：取数失败（?mockError=${scope}）`,
      500,
    );
  }

  return load();
}

/**
 * 首页取数：在通用调试包装之上，再叠加按模块的空数据注入。
 *
 * 返回空数据集时**不抛错**——空数据不是错误，各模块自行决定隐藏还是显示局部空态。
 */
export async function withMockHomeDebug(
  params: URLSearchParams | undefined,
  surface: MockSurface,
  load: () => Promise<HomeData>,
): Promise<HomeData> {
  return withMockDebug(params, surface, async () =>
    applyMockEmpty(await load(), mockEmptyScope(params)),
  );
}

/**
 * 本次请求是否要求把 `scope` 清空（`?mockEmpty=all` 视为清空全部范围）。
 *
 * 首页之外的空态不是「某个字段为空」，而是**整块数据一条不剩**，所以这里给的是
 * 一个判定函数而不是改写数据的函数：由各服务自己决定空数据长什么样——
 * 消费等级要变成「配置暂不可用」，协议要变成「内容暂未配置」，排行榜要变成空列表。
 */
export function mockEmptyApplies(
  params: URLSearchParams | undefined,
  scope: Exclude<MockEmptyScope, "none" | "all">,
): boolean {
  const current = mockEmptyScope(params);
  return current === "all" || current === scope;
}

/**
 * 在通用调试包装之上叠加一次「按范围清空」的取数：命中范围时返回空数组。
 *
 * 与首页空态一致：**空数据不是错误**，不抛错，由调用方渲染各自的空态文案。
 */
export async function withMockEmptyDebug<T>(
  params: URLSearchParams | undefined,
  surface: MockSurface,
  scope: Exclude<MockEmptyScope, "none" | "all">,
  load: () => Promise<readonly T[]>,
): Promise<T[]> {
  return withMockDebug(params, surface, async () => {
    const rows = await load();
    return mockEmptyApplies(params, scope) ? [] : [...rows];
  });
}
