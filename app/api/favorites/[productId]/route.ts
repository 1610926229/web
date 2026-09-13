import { fail, ok, requireUser, toApiError } from "@/lib/api/route";
import { isFavoritedForUser, removeFavoriteForUser } from "@/lib/services/favorites";

/**
 * 单个商品的收藏状态与取消收藏接口（浏览器端调用）。
 *
 * 路径里只有**商品 id**：既不是收藏记录 id，也不含任何用户标识——
 * 「谁的收藏」永远由服务端会话决定，地址里不出现用户数据。
 *
 * 权限：必须登录。读到 / 改到的都只可能是自己的收藏，两家用户的数据完全隔离。
 */
export async function GET(request: Request, { params }: RouteContext<"/api/favorites/[productId]">) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const { productId } = await params;

    return ok({
      productId: productId ?? "",
      favorited: await isFavoritedForUser(user.id, productId ?? "", searchParams, "http"),
    });
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

/**
 * 取消收藏。**幂等**：本来就没收藏也返回成功——用户想要的状态已经达到了。
 *
 * 刻意**不校验商品是否存在**：商品被删除后，用户更需要能把这条收藏清掉。
 */
export async function DELETE(
  request: Request,
  { params }: RouteContext<"/api/favorites/[productId]">,
) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const { productId } = await params;

    return ok(await removeFavoriteForUser(user.id, productId ?? "", searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
