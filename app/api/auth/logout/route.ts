import { clearSessionUser } from "@/lib/auth/session";
import { isMockAuthEnabled } from "@/lib/config/env";

/**
 * 退出登录：清除 Mock 会话 Cookie，调用方随即回到游客态。
 *
 * 与模拟登录接口一样由 `ENABLE_MOCK_AUTH` 控制，未开启时返回 404——
 * 此时本就不存在任何 Mock 会话，没有可登出的对象。
 */
export async function POST() {
  if (!isMockAuthEnabled()) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "退出登录接口未启用" } },
      { status: 404 },
    );
  }

  await clearSessionUser();
  return Response.json({ data: { ok: true } });
}
