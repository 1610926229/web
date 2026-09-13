import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 管理端页面标题区：标题 + 口径说明（+ 可选的操作区、返回链接）。
 *
 * 每个模块的标题与说明都从 `lib/constants/admin*.ts` 取，页面不自己编文案：
 * 同一句话在列表页与详情页必须是同一句，否则运维读到的规则会有两个版本。
 *
 * 这是个**服务端组件**，没有任何交互；被客户端组件引用时也只是变成客户端渲染的一部分。
 */
export default function AdminPageHeading({
  title,
  description,
  backHref,
  backLabel,
  children,
}: {
  title: string;
  description?: string;
  /** 详情页的返回列表入口 */
  backHref?: string;
  backLabel?: string;
  /** 右侧操作区（可选） */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {backHref ? (
          <Link
            href={backHref}
            className="text-[13px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
          >
            ← {backLabel ?? "返回列表"}
          </Link>
        ) : null}
        <h1 className="mt-1 text-[20px] font-semibold text-ink">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-4xl text-[13px] leading-5 text-ink-3">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}
