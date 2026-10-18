import { clearSessionUser } from "@/lib/auth/session";
import { destroyRealSession, isRealAuthEnabled } from "@/lib/auth/realSession";
import { isMockAuthEnabled } from "@/lib/config/env";

/**
 * 退出登录：清除用户端会话。
 *
 * PROD-4 起有两套会话，按**当前启用的是哪一套**处理：
 * - `DATA_SOURCE=postgres`：吊销 `auth_sessions` 里这一条记录（若存在），
 *   并删除真实 Cookie 与 Mock Cookie。只删 Cookie 不吊销的话，被偷走的令牌
 *   在 7 天内仍然可用；
 * - Mock 数据源：沿用原有行为（`ENABLE_MOCK_AUTH` 控制，未开启时 404）。
 *
 * 退出是幂等的：没有会话也返回成功。
 */
export async function POST() {
  if (isRealAuthEnabled()) {
    await destroyRealSession("user");
    return Response.json({ data: { ok: true } });
  }

  if (!isMockAuthEnabled()) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "退出登录接口未启用" } },
      { status: 404 },
    );
  }

  await clearSessionUser();
  return Response.json({ data: { ok: true } });
}
