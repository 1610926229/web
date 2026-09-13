import { fail, ok, toApiError } from "@/lib/api/route";
import { getHomeData } from "@/lib/services/home";

/**
 * 首页数据接口（浏览器端调用）。
 *
 * 取数逻辑与首页 Server Component **共用** `lib/services/home`，
 * 本文件只负责两件事：把调试查询参数透传给 service、把结果或错误包成统一信封。
 *
 * 调试参数 `?mockError=1` / `?mockEmpty=1` / `?mockDelay=<ms>` 仅在
 * `ENABLE_MOCK_DEBUG=true` 时生效。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return ok(await getHomeData(searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
