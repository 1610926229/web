import { getDataSource } from "@/lib/data/source";
import { withMockHomeDebug, type MockSurface } from "@/lib/mocks/debug";
import type { HomeData } from "@/lib/types/content";

/**
 * 首页数据服务 —— 服务端与接口共用的唯一取数入口。
 *
 * - 首页 Server Component 以 `"server"` 直接 `await getHomeData()`，数据随 SSR 一起输出；
 * - `/api/home` 以 `"http"` 复用同一个函数，再包一层 JSON 信封供浏览器端调用。
 *
 * `params` 是 Mock 阶段的调试参数（由 `ENABLE_MOCK_DEBUG` 控制，关闭时完全直通），
 * `surface` 用于区分两侧，以便支持只让接口失败的 `?mockError=api`。
 * 两者都只影响 Mock 链路，真实后端接入后随 `lib/mocks` 一起删除。
 */
export function getHomeData(
  params: URLSearchParams | undefined,
  surface: MockSurface,
): Promise<HomeData> {
  return withMockHomeDebug(params, surface, () => getDataSource().getHomeData());
}
