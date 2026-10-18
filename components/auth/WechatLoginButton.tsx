"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  getWechatLoginStatus,
  type WechatLoginStatus,
} from "@/lib/services/wechatAuthHttp";

/**
 * 登录界面的微信入口。
 *
 * 三种状态**必须互相可见**，不能把「未配置」伪装成「可用」：
 *
 * | 状态 | 界面 |
 * |---|---|
 * | 真实微信已配置 | 「微信扫码登录」→ `/api/auth/wechat/start` |
 * | 未配置、私有 Staging 开着 Mock | 「模拟微信登录（Staging）」→ `/wechat-mock`，并明确标注不调用真实微信 |
 * | 两者都不可用 | 一句「微信登录尚未配置」和需要的配置项，**不放按钮** |
 *
 * 状态由服务端 `/api/auth/wechat/status` 给出（只含布尔值）。
 * 客户端不读环境变量——那样会在构建期把开关固化成常量。
 */
export default function WechatLoginButton() {
  const pathname = usePathname();
  const [status, setStatus] = useState<WechatLoginStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    getWechatLoginStatus()
      .then((value) => {
        if (alive) setStatus(value);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const redirect = encodeURIComponent(pathname || "/");

  if (failed) {
    return (
      <p className="text-center text-[12px] leading-5 text-ink-3">
        微信登录状态获取失败，请刷新页面后重试。
      </p>
    );
  }

  if (!status) {
    return <div className="h-11 w-full animate-pulse rounded-full bg-page" aria-hidden />;
  }

  if (status.realConfigured) {
    return (
      <a
        href={`/api/auth/wechat/start?redirect=${redirect}`}
        className="flex h-11 w-full items-center justify-center rounded-full bg-[#07c160] text-[15px] font-medium text-white"
      >
        微信扫码登录
      </a>
    );
  }

  if (status.mockAvailable) {
    return (
      <div className="flex w-full flex-col gap-1.5">
        <a
          href={`/wechat-mock?redirect=${redirect}`}
          className="flex h-11 w-full items-center justify-center rounded-full border border-[#07c160] text-[15px] font-medium text-[#07c160]"
        >
          模拟微信登录（Staging）
        </a>
        <p className="text-center text-[11px] leading-4 text-ink-3">
          仅供私有环境验收，不会调用真实微信接口，也不会产生真实账号。
        </p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-lg border border-line bg-page px-3 py-2.5 text-center">
      <p className="text-[13px] font-medium text-ink-2">微信登录尚未配置</p>
      <p className="mt-1 text-[11px] leading-4 text-ink-3">
        需要微信开放平台网站应用 AppID、AppSecret 与已登记的回调域名。配置完成前不会伪造登录。
      </p>
    </div>
  );
}
