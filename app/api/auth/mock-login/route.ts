import { setSessionUser } from "@/lib/auth/session";
import { isMockAuthEnabled } from "@/lib/config/env";
import { getUserRepository, toSessionUser } from "@/lib/data/userRepository";
import { mockLatency } from "@/lib/mocks/debug";
import { userSeed } from "@/lib/mocks/fixtures/seed";

/**
 * 模拟登录接口。
 *
 * ⚠️ Mock 实现：只写入一个 Mock 会话 Cookie，不调用任何真实微信接口，
 * 不使用 AppID / AppSecret / 商户号 / 密钥 / 回调地址。
 *
 * 默认以第一个 Mock 用户登录；**验收期**可用 `{"userId":"u-1002"}` 切换身份。
 * 注意这个切换只在接口层（自动化测试与命令行验收使用），**用户端页面没有任何切换入口**：
 * 正式产品的账号由微信登录决定，给用户一个「换个身份」的按钮既不合理也不安全。
 *
 * 返回的是**会话用户 DTO**（`id / nickname / avatarUrl`），不是仓储记录整体——
 * 用户资料将来多出任何字段都不会顺势从这里漏出去。
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

  // 走用户仓储（而不是直接查种子常量）：与「我的」页、编辑资料共用同一份数据，
  // 改过的昵称/头像登录后立刻生效。
  const user = await getUserRepository().findUserById(userId);
  if (!user) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Mock 用户不存在" } },
      { status: 404 },
    );
  }

  await setSessionUser(user.id);
  return Response.json({ data: toSessionUser(user) });
}
