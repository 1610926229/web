import { setSessionUser } from "@/lib/auth/session";
import { isMockAuthEnabled } from "@/lib/config/env";
import { mockLatency } from "@/lib/mocks/debug";
import { userSeed } from "@/lib/mocks/fixtures/seed";

/**
 * 模拟登录接口。
 *
 * ⚠️ Mock 实现：只写入一个 Mock 会话 Cookie，不调用任何真实微信接口，
 * 不使用 AppID / AppSecret / 商户号 / 密钥 / 回调地址。
 *
 * 默认以第一个 Mock 用户登录；验收期可用 `{"userId":"u-1002"}` 切换身份。
 *
 * 整个接口由 `ENABLE_MOCK_AUTH` 控制，未开启时按「接口不存在」返回 404，
 * 正式部署不设置该变量即可，无需改动任何代码。
 */
export async function POST(request: Request) {
  if (!isMockAuthEnabled()) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "模拟登录接口未启用" } },
      { status: 404 },
    );
  }

  await mockLatency(new URL(request.url).searchParams);

  let userId = userSeed[0].id;
  try {
    const body = (await request.json()) as { userId?: unknown };
    if (typeof body.userId === "string") userId = body.userId;
  } catch {
    // 无请求体时按默认用户处理
  }

  const user = userSeed.find((item) => item.id === userId);
  if (!user) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Mock 用户不存在" } },
      { status: 404 },
    );
  }

  await setSessionUser(user.id);
  return Response.json({ data: user });
}
