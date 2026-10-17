"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import {
  STAFF_ORDER_ACTIONS_NOTICE,
  STAFF_ORDER_ACTIONS_TITLE,
  STAFF_ORDER_ACTIONS_UNAVAILABLE_NOTICE,
  STAFF_ORDER_RELEASE_CONFIRM_LABEL,
  STAFF_ORDER_RELEASE_CONFIRM_NOTICE,
  STAFF_ORDER_RELEASE_LABEL,
  STAFF_ORDER_RELEASE_REASON_LABEL,
  STAFF_ORDER_RELEASE_REASON_PLACEHOLDER,
  STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE,
  STAFF_ORDER_RELEASE_SUCCESS_LABEL,
  STAFF_ORDER_REPLACE_CANDIDATES_COUNT_LABEL,
  STAFF_ORDER_REPLACE_CANDIDATES_NOTICE,
  STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE,
  STAFF_ORDER_REPLACE_CONFIRM_LABEL,
  STAFF_ORDER_REPLACE_CONFIRM_NOTICE,
  STAFF_ORDER_REPLACE_EMPTY_TITLE,
  STAFF_ORDER_REPLACE_LABEL,
  STAFF_ORDER_REPLACE_SELECT_LABEL,
  STAFF_ORDER_REPLACE_SUCCESS_LABEL,
} from "@/lib/constants/staff";
import {
  fetchStaffOrderReplaceCandidates,
  releaseStaffOrder,
  replaceStaffOrderCompanion,
} from "@/lib/services/staffHttp";
import type {
  StaffOrderAllowedActions,
  StaffOrderReplaceCandidate,
  StaffOrderReplaceCandidateListData,
} from "@/lib/types/staff";

/** 当前打开的确认框对应哪个动作；`null` 表示没有确认框。 */
type PendingAction = "release" | "replace" | null;

/**
 * 客服订单详情的**唯一写入口**（P0-11）：换人 / 退回公共池。
 *
 * ## 哪些按钮出现，由服务端决定
 *
 * 完全按 `allowedActions` 渲染，本组件**不拿 `order.status` 自己写 `if`**。
 * 判据只有一处（`staffOrderAllowedActions`），事务层的两个入口用的是同一条——
 * 界面显示的按钮与接口接受的请求一旦分叉，客服就会遇到一个「看得见、点不动」的按钮。
 * 没有可用动作时这一块**不留灰按钮**，而是显示一句说明（`STAFF_ORDER_ACTIONS_UNAVAILABLE_NOTICE`）。
 *
 * ## 写成功之后：`router.refresh()`，不自己拼新状态
 *
 * 首屏那一份详情由**服务端组件**渲染（`getStaffOrderDetail()`）。写成功之后调一次
 * `router.refresh()`，服务端重新渲染整页：状态、时间轴、派单进度、退出历史、
 * `allowedActions` 一起更新——本组件不拿响应里的几个字段自己推算「下一步还能做什么」。
 *
 * ⚠️ 订单详情**刻意没有浏览器端的取数函数**（`staffHttp.ts` 的说明）：
 * 详情只有这一条读取路径，因此这里也不可能与页面口径分叉。
 *
 * ⚠️ `router.refresh()` 没有 Promise，因此**不存在**「写入成功但刷新失败」这种要
 * 单独措辞的状态（完成材料那一处有，因为它自己重新取了一次详情）。
 * 反馈文案在写入成功后就地给出，刷新在后台进行。
 *
 * ## 没有幂等键
 *
 * 两个动作的幂等判据都是**状态本身**：订单已经不在履约中时服务端回 400
 * （而不是重放）。因此这里既不生成键，也不在重试时复用键——与
 * `StaffCompletionConsole` 同一条机制，与 `AdminApplicationActions`（幂等键）刻意不同。
 */
export default function StaffOrderActionsConsole({
  orderId,
  allowedActions,
}: {
  orderId: string;
  allowedActions: StaffOrderAllowedActions;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // 退回公共池的原因
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  // 换人：候选名单的三种状态（加载中 / 加载失败 / 结果）
  const [candidates, setCandidates] = useState<StaffOrderReplaceCandidateListData | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selectedCompanionId, setSelectedCompanionId] = useState("");

  const hasAction = allowedActions.canRelease || allowedActions.canReplace;

  /**
   * 打开确认框。换人时要先取候选名单——**名单由服务端筛过**，
   * 本组件不拿「全部护航」自己过滤（那等于把资格规则抄进浏览器）。
   */
  function openIntent(action: Exclude<PendingAction, null>) {
    setConfirmError(null);
    setFlash("");

    if (action === "release") {
      setReason("");
      setReasonError(null);
    } else {
      setCandidates(null);
      setCandidatesError(null);
      setSelectedCompanionId("");
      void loadCandidates();
    }

    setPendingAction(action);
  }

  function closeIntent() {
    if (busy) return;
    setPendingAction(null);
    setConfirmError(null);
    setReasonError(null);
  }

  async function loadCandidates() {
    try {
      setCandidates(await fetchStaffOrderReplaceCandidates(orderId));
    } catch (cause) {
      // 这一句说的是「名单没取到」，不是「你不能换人」——两者对客服的下一步不同：
      // 前者重试即可，后者要去看这一单的状态
      setCandidatesError(cause instanceof Error ? cause.message : "候选名单加载失败，请重试。");
    }
  }

  /**
   * 写入 → 成功后关框、给反馈、让服务端重渲染。
   *
   * ⚠️ 失败时**不关确认框**：错误要留在原地，关掉它等于把错误也关掉了
   * （与 `StaffCompletionConsole` / `AdminApplicationActions` 同一条约定）。
   */
  async function runWrite(action: Exclude<PendingAction, null>) {
    setBusy(true);
    setConfirmError(null);

    try {
      const call = {
        release: () => releaseStaffOrder(orderId, { reason: reason.trim() }),
        replace: () => replaceStaffOrderCompanion(orderId, { companionId: selectedCompanionId }),
      }[action];

      await call();

      setPendingAction(null);
      // 服务端重新渲染这一页：状态、时间轴、派单与按钮一起更新
      router.refresh();
      setFlash(action === "release" ? STAFF_ORDER_RELEASE_SUCCESS_LABEL : STAFF_ORDER_REPLACE_SUCCESS_LABEL);
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function confirmIntent() {
    if (!pendingAction || busy) return;

    if (pendingAction === "release") {
      // 只判**非空**：服务端也只判这一条（需求没有冻结字数）。
      // 这里造一个长度上限，就会出现「界面不让你提交、接口其实接受」的分叉
      if (!reason.trim()) {
        setReasonError(STAFF_ORDER_RELEASE_REASON_REQUIRED_MESSAGE);
        reasonRef.current?.focus();
        return;
      }
      void runWrite("release");
      return;
    }

    if (!selectedCompanionId) {
      setConfirmError(STAFF_ORDER_REPLACE_COMPANION_REQUIRED_MESSAGE);
      return;
    }
    void runWrite("replace");
  }

  return (
    <section className="rounded-xl border border-admin-line bg-surface p-4">
      <h2 className="text-[15px] font-medium text-ink">{STAFF_ORDER_ACTIONS_TITLE}</h2>

      {hasAction ? (
        <>
          <p className="mt-2 text-[12px] leading-5 text-ink-3">{STAFF_ORDER_ACTIONS_NOTICE}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openIntent("release")}
              disabled={!allowedActions.canRelease}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink hover:bg-page disabled:opacity-40"
            >
              {STAFF_ORDER_RELEASE_LABEL}
            </button>
            <button
              type="button"
              onClick={() => openIntent("replace")}
              disabled={!allowedActions.canReplace}
              className="rounded-lg bg-admin-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {STAFF_ORDER_REPLACE_LABEL}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 text-[13px] leading-5 text-ink-3">
          {STAFF_ORDER_ACTIONS_UNAVAILABLE_NOTICE}
        </p>
      )}

      {flash ? (
        <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
          {flash}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={pendingAction !== null}
        title={pendingAction === "release" ? STAFF_ORDER_RELEASE_LABEL : STAFF_ORDER_REPLACE_LABEL}
        description={
          pendingAction === "release"
            ? STAFF_ORDER_RELEASE_CONFIRM_NOTICE
            : STAFF_ORDER_REPLACE_CONFIRM_NOTICE
        }
        confirmLabel={
          pendingAction === "release"
            ? STAFF_ORDER_RELEASE_CONFIRM_LABEL
            : STAFF_ORDER_REPLACE_CONFIRM_LABEL
        }
        // 两个动作都不销毁数据，因此都不是 danger：退回公共池会立刻换掉履约人，
        // 但它**不取消订单、不退款**，用红色确认键会把这件事说得比实际重
        tone="primary"
        pending={busy}
        error={confirmError}
        initialFocusRef={pendingAction === "release" ? reasonRef : undefined}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingAction === "release" ? (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-ink-3">
              {STAFF_ORDER_RELEASE_REASON_LABEL}（必填）
            </span>
            <textarea
              ref={reasonRef}
              value={reason}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
                // 边写边清错误：「必填」在提交时提示，不打断输入
                setReasonError(null);
              }}
              placeholder={STAFF_ORDER_RELEASE_REASON_PLACEHOLDER}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? "staff-order-release-reason-error" : undefined}
              className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-ink outline-none ${
                reasonError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {reasonError ? (
              <span
                id="staff-order-release-reason-error"
                role="alert"
                className="text-[12px] text-brand-red"
              >
                {reasonError}
              </span>
            ) : null}
          </label>
        ) : null}

        {pendingAction === "replace" ? (
          <div className="flex flex-col gap-2">
            <span className="text-[12px] text-ink-3">{STAFF_ORDER_REPLACE_SELECT_LABEL}</span>

            {candidatesError ? (
              <p role="alert" className="text-[12px] leading-5 text-status-danger">
                {candidatesError}
              </p>
            ) : null}

            {!candidates && !candidatesError ? (
              <p className="text-[12px] text-ink-3">候选名单加载中…</p>
            ) : null}

            {candidates && candidates.items.length === 0 ? (
              <div className="text-[12px] leading-5 text-ink-3">
                <p className="font-medium text-ink-2">{STAFF_ORDER_REPLACE_EMPTY_TITLE}</p>
                <p>{candidates.notice}</p>
              </div>
            ) : null}

            {candidates && candidates.items.length > 0 ? (
              <>
                <p className="text-[12px] leading-5 text-ink-3">{candidates.notice}</p>
                <ul className="max-h-64 overflow-y-auto rounded-lg border border-admin-line">
                  {candidates.items.map((candidate: StaffOrderReplaceCandidate) => (
                    <li key={candidate.companionId} className="border-b border-admin-line last:border-b-0">
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-page">
                        <input
                          type="radio"
                          name="staff-order-replace-candidate"
                          value={candidate.companionId}
                          checked={selectedCompanionId === candidate.companionId}
                          onChange={() => {
                            setSelectedCompanionId(candidate.companionId);
                            setConfirmError(null);
                          }}
                          className="shrink-0"
                        />
                        {/* Mock 阶段的头像是 public/mock 下的本地 SVG 占位图，
                            与管理端列表同一写法（不经 next/image 优化器） */}
                        <img
                          src={candidate.avatarUrl}
                          alt=""
                          className="h-8 w-8 shrink-0 rounded-full border border-admin-line object-cover"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-ink">
                            {candidate.displayName}
                          </span>
                          {/* 这一列数字不是装饰：把一单换给已经压了五单的人，
                              是把问题从一位护航挪到另一位身上 */}
                          <span className="block text-[12px] text-ink-3">
                            {STAFF_ORDER_REPLACE_CANDIDATES_COUNT_LABEL}
                            {candidate.activeOrderCount}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="text-[12px] leading-5 text-ink-3">
                  {STAFF_ORDER_REPLACE_CANDIDATES_NOTICE}
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </AdminConfirmDialog>
    </section>
  );
}
