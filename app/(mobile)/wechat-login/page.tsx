import Link from "next/link";
import EmptyState from "@/components/common/EmptyState";
import NavBar from "@/components/common/NavBar";
import { toSearchParams } from "@/lib/utils/query";

/**
 * 微信登录结果页：只用于展示**失败 / 未配置**的明确原因。
 *
 * 成功登录不会经过这里——回调直接 302 回发起登录的站内地址。
 *
 * ⚠️ 页面只读取固定的 `error` 枚举，不展示任何 `errcode` / `errmsg` / code。
 * 微信返回的原文可能包含 openid 片段或内部描述，放进页面等于泄漏。
 */

const MESSAGES: Record<string, { title: string; description: string }> = {
  "not-configured": {
    title: "微信登录尚未配置",
    description:
      "需要微信开放平台网站应用 AppID、AppSecret 与已登记的回调地址。配置完成前，平台不会伪造登录成功，也不会改用模拟身份代替真实微信。",
  },
  "state-invalid": {
    title: "登录请求已失效",
    description:
      "这次微信登录的校验信息不存在、已被使用或来源不匹配。请返回原页面重新发起登录。",
  },
  "state-expired": {
    title: "登录请求已过期",
    description: "微信登录请求超过 10 分钟未完成。请返回原页面重新扫码。",
  },
  "code-invalid": {
    title: "微信授权码无效",
    description: "授权码可能已被使用或已经过期。请返回原页面重新扫码。",
  },
  cancelled: {
    title: "已取消微信登录",
    description: "你取消了微信授权，当前仍是未登录状态。可以重新发起登录，或使用邮箱密码登录。",
  },
  network: {
    title: "暂时无法连接微信服务",
    description: "网络或微信接口暂时不可用，请稍后重试。",
  },
  failed: {
    title: "微信登录未完成",
    description: "登录过程中出现问题，请返回原页面重新尝试。",
  },
};

export default async function WechatLoginResultPage({
  searchParams,
}: PageProps<"/wechat-login">) {
  const query = toSearchParams(await searchParams);
  const reason = (query.get("error") ?? "failed").trim();
  const message = MESSAGES[reason] ?? MESSAGES.failed;

  return (
    <>
      <NavBar title="微信登录" showBack />

      <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-surface px-4 py-16">
        <EmptyState title={message.title} description={message.description} />

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/mine"
            className="flex h-11 items-center justify-center rounded-full bg-brand-red px-6 text-[15px] font-medium text-white"
          >
            返回登录
          </Link>
          <Link
            href="/"
            className="flex h-11 items-center justify-center rounded-full border border-line px-6 text-[15px] text-ink-2"
          >
            返回首页
          </Link>
        </div>
      </div>
    </>
  );
}
