import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { addFavoriteForUser, queryFavoritesForUser } from "@/lib/services/favorites";

/**
 * 商品收藏列表与新增收藏接口（浏览器端调用）。
 *
 * 权限：必须登录。用户身份只来自服务端会话，**接口不接受任何「查谁的收藏」参数**，
 * 因此改参数读不到别人的收藏；仓储查询本身也按 userId 过滤，两层都挡。
 *
 * `page` / `pageSize` 非数字或越界 → 规范化到安全范围（收藏列表没有筛选条件，
 * 不存在需要报错的业务取值，与订单 / 投诉列表的差异是有意的）。
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);

    return ok(await queryFavoritesForUser(user.id, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 新增收藏。
 *
 * 商品 id 只从请求体读；商品不存在 → 404，已下架 → 400。
 * 同一商品重复收藏是**幂等**的：返回第一次的结果（`created: false`），不会多出一条记录。
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const body = await readJsonBody(request);

    return ok(await addFavoriteForUser(user.id, body, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
