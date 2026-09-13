import { ApiError } from "@/lib/api/ApiError";
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
  const { searchParams } = new URL(request.url);
  const query = parseQuery(searchParams);

  if (!query.gameId) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "缺少参数 gameId" } },
      { status: 400 },
    );
  }

  try {
    return Response.json({ data: await queryProducts(query, searchParams, "http") });
  } catch (cause) {
    const error =
      cause instanceof ApiError
        ? cause
        : new ApiError("SERVER_ERROR", "服务暂时不可用，请稍后重试");

    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status > 0 ? error.status : 500 },
    );
  }
}
