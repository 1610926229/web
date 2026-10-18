import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import MockWechatLoginPanel from "@/components/auth/MockWechatLoginPanel";
import { isMockWechatLoginEnabled } from "@/lib/auth/wechat/config";
import { MOCK_WECHAT_IDENTITIES } from "@/lib/auth/wechat/mockProvider";
import { sanitizeRedirectPath } from "@/lib/auth/wechat/state";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 模拟微信登录页（私有 Staging）。
 *
 * ⚠️ 这不是真实微信登录，也不是登录后门：
 * - 只在 `DATA_SOURCE=postgres` 且 `ENABLE_MOCK_AUTH=true` 时渲染身份选择器；
 * - 选择身份后走与真实微信相同的身份解析与会话创建；
 * - 公网请求在 Nginx 与 `proxy.ts` 两层被拒绝（本地址不在只读白名单里）。
 *
 * 页面文案明确写出「模拟」与「不会自动获得角色」，避免验收者把这里
 * 当成真实微信能力。
 */
export default async function WechatMockPage({ searchParams }: PageProps<"/wechat-mock">) {
  const query = toSearchParams(await searchParams);
  const redirectTo = sanitizeRedirectPath(query.get("redirect"));

  return (
    <>
      <NavBar title="模拟微信登录" showBack />

      <div className="flex flex-1 flex-col gap-4 bg-page px-4 py-5">
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-[13px] font-medium text-ink-2">私有 Staging · 模拟身份</p>
          <p className="mt-1 text-[12px] leading-5 text-ink-3">
            这里模拟的是「微信返回哪个 openid」，用于在尚未取得微信开放平台资质前，
            验收登录、订单与打手绑定流程。真实微信扫码需要 AppID、AppSecret 与已备案回调域名。
          </p>
        </div>

        {isMockWechatLoginEnabled() ? (
          <MockWechatLoginPanel identities={MOCK_WECHAT_IDENTITIES} redirectTo={redirectTo} />
        ) : (
          <EmptyState
            title="模拟微信登录未启用"
            description="只有在 PostgreSQL 数据源且 ENABLE_MOCK_AUTH=true 的私有环境中才可用。"
          />
        )}

        <Link
          href="/"
          className="mt-2 flex h-11 w-full items-center justify-center rounded-full border border-line text-[15px] text-ink-2"
        >
          返回首页
        </Link>
      </div>
    </>
  );
}
