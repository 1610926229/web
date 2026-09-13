import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, toApiError } from "@/lib/api/route";
import { queryProducts } from "@/lib/services/catalog";
import type { ProductListQuery } from "@/lib/types/catalog";

/**
 * 商品列表接口（浏览器端调用）。
 *
 * 分类页切换类目、搜索、加载更多都走这里。取数逻辑与分类页首屏**共用**
 * `lib/services/catalog` 的 `queryProducts`，本文件只负责解析查询条件、
 * 透传 Mock 调试参数、把结果或错误包成统一信封。
 */
function parseQuery(searchParams: URLSearchParams): ProductListQuery {
  const pageRaw = Number(searchParams.get("page"));

  return {
    gameId: searchParams.get("gameId") ?? "",
    categoryId: searchParams.get("categoryId") ?? undefined,
    keyword: searchParams.get("keyword") ?? undefined,
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.trunc(pageRaw) : 1,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = parseQuery(searchParams);

    if (!query.gameId) throw new ApiError("BAD_REQUEST", "缺少参数 gameId", 400);

    return ok(await queryProducts(query, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
