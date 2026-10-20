"use client";

import LoginGate from "@/lib/auth/LoginGate";
import NavBar from "@/components/common/NavBar";
import { PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION } from "@/lib/config/publicPreview";

/**
 * 受限操作的登录浮层。
 *
 * 用于**免登录可浏览、但部分操作需登录**的页面（当前是商品详情页的收藏 / 客服 /
 * 立即购买）。它本身不含任何登录判断，只是把统一的 `LoginGate` 装进一个全屏浮层：
 * 登录与否的判断、登录动作、失败提示全部沿用同一份实现。
 *
 * 用浮层而不是跳转到登录页，是为了不丢掉用户当前的浏览位置——登录成功后
 * `onSuccess` 关闭浮层，调用方接着执行原来的操作。
 */
export default function LoginSheet({
  open,
  mockAuthEnabled,
  realAuthEnabled = false,
  publicPreview = false,
  onClose,
  onSuccess,
}: {
  open: boolean;
  mockAuthEnabled: boolean;
  /** PROD-4：真实邮箱密码登录是否可用 */
  realAuthEnabled?: boolean;
  /** 公网只读预览：不提供登录入口，必须明确说明「暂不可用」而不是提示模拟登录。 */
  publicPreview?: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  if (!open) return null;

  return (
    // 覆盖整个视口，避免被详情页底部操作栏盖住
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <NavBar title={publicPreview ? "暂不可用" : "登录"} showBack />
      <div className="flex flex-1 flex-col overflow-y-auto">
        <LoginGate
          mockAuthEnabled={mockAuthEnabled}
          realAuthEnabled={realAuthEnabled && !publicPreview}
          title={publicPreview ? "该功能暂不可用" : "登录后继续"}
          description={
            publicPreview
              ? PUBLIC_PREVIEW_UNAVAILABLE_DESCRIPTION
              : realAuthEnabled
                ? "收藏、联系客服与购买都需要先登录。请使用邮箱与密码登录，或先注册一个账号。"
                : "收藏、联系客服与购买都需要先登录。当前为开发阶段的模拟登录，不会调用真实微信接口。"
          }
          onSuccess={onSuccess}
        />
      </div>

      <div className="shrink-0 px-4 pb-6">
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-full border border-line py-3 text-[14px] text-ink-2"
        >
          {publicPreview ? "返回" : "暂不登录"}
        </button>
      </div>
    </div>
  );
}
