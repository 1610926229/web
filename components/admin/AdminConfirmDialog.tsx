"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * 管理端危险操作的**二次确认**框（§八 / §十一）。
 *
 * ⚠️ 它**不是防重手段**：同一个人在两台设备上同时点「停用」，两次请求都会到达服务端。
 * 真正的防重是幂等键加服务端的状态判断（§九：不能依赖按钮禁用防重）。
 * 这个框只负责一件事——让人在动手前看清后果。
 *
 * 无障碍上的四条硬要求，都在这里一次做好，调用方不必各自实现：
 * - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向标题；
 * - 打开时焦点移到**取消**按钮（危险动作的默认焦点不落在「确定」上，回车不会误触发）；
 * - `Esc` 关闭（等于取消），关闭后焦点还给触发按钮（由调用方在 `onCancel` 里处理）；
 * - 失败信息用 `role="alert"` 播报，且**不关闭对话框**——关掉它等于把错误也关掉了。
 *
 * 确认按钮在 `pending` 时禁用只是避免连点；即便连点成功，服务端也会按同一个幂等键
 * 重放第一次的结果，不会产生第二次写入。
 */
export default function AdminConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  tone = "danger",
  pending = false,
  error = null,
  size = "md",
  children,
  initialFocusRef,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` 用于停用 / 移除 / 拒绝这类不可撤销或影响面大的动作 */
  tone?: "danger" | "primary";
  pending?: boolean;
  error?: string | null;
  /**
   * 面板宽度。默认 `md`（`max-w-md`）。
   *
   * `lg` 是给**内容本身就是一张表**的确认框用的（退款资金决策：金额表 + 实时预览 +
   * 口径说明）。不给这个选项的话，调用方只能自己撑破布局，或者把金额挤成一列读不清。
   * 默认值不变，因此既有调用方的排版一个字都不动。
   */
  size?: "md" | "lg";
  /** 确认框里的补充内容（如「暂停接单」需要填的原因）。 */
  children?: ReactNode;
  /**
   * 打开时把焦点放到哪个元素。不给就放到「取消」按钮上。
   *
   * 有输入框时（拒绝要写审核意见、暂停要写原因）必须先落到输入框：
   * 否则打字会落在框外，用户会以为输入没生效。
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    (initialFocusRef?.current ?? cancelRef.current)?.focus();
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      // 正在提交时不允许用 Esc 关掉：请求已经发出去了，关掉框只会让人以为没执行
      if (event.key === "Escape" && !pending) onCancel();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        /* `flex-col + max-h-full`：标题与底部两个按钮**钉住**，只有中间的说明与
           补充内容滚动。不加这一条时，内容一长（退款资金决策那张表），
           确认按钮会被推到视口外面——而它正是这个框存在的理由 */
        className={`flex max-h-full w-full flex-col rounded-xl bg-surface p-5 shadow-xl ${
          size === "lg" ? "max-w-lg" : "max-w-md"
        }`}
      >
        <h2 id="admin-confirm-title" className="text-[16px] font-semibold text-ink">
          {title}
        </h2>

        <div className="mt-2 min-h-0 overflow-y-auto">
          <p className="text-[13px] leading-5 text-ink-2">{description}</p>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-[13px] leading-5 text-brand-red">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-lg px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60 ${
              tone === "danger" ? "bg-status-danger" : "bg-admin-accent"
            }`}
          >
            {pending ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
