"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import Link from "next/link";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminCompanionEditForm from "@/components/admin/AdminCompanionEditForm";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminStatusBadge, { COMPANION_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_COMPANION_ACTION_LABELS,
  ADMIN_COMPANION_CONFIRM_TEXTS,
  ADMIN_COMPANION_DETAIL_FORBIDDEN_EDIT_NOTICE,
  ADMIN_COMPANION_REMOVED_MESSAGE,
  COMPANION_PROFILE_REASON_MAX_LENGTH,
  COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE,
  adminCompanionStatus,
  normalizeCompanionReason,
} from "@/lib/constants/adminCompanions";
import {
  disableCompanion,
  enableCompanion,
  fetchAdminCompanion,
  pauseCompanion,
  removeCompanion,
  resumeCompanion,
} from "@/lib/services/adminHttp";
import type { AdminCompanionDetail, CompanionGameOption } from "@/lib/types/companion";
import { countCharacters } from "@/lib/utils/text";

/** 需要二次确认的状态动作。 */
type FlagIntent = "pause" | "resume" | "disable" | "enable" | "remove";

const FLAG_SUCCESS_MESSAGE: Record<FlagIntent, string> = {
  pause: "已暂停接单：该护航仍在公开名单与详情页里，但结算时不可选",
  resume: "已恢复接单：该护航可以在结算页被选择",
  disable: "已停用：用户端名单与结算页不再出现这条资料",
  enable: "已启用：该护航重新出现在用户端名单里",
  remove: "已移除：用户端不再可见，历史订单、评价与鸡腿记录均已保留",
};

/**
 * 护航详情的**唯一写入口**：状态动作 + 资料编辑表单。
 *
 * 为什么两件事放在一个组件里：它们写的是同一条记录，而且都要在写成功后
 * 拿到**服务端的最新值**。分成两个组件各自刷新，就会出现「按钮已经把状态改成
 * 停用了，编辑表单里还写着启用」——表单提交时会把状态又改回去。
 * 这里统一成一条刷新路径：**任何一次写成功都重新取一次详情**，
 * 表单用 `key` 重挂载，因此永远以服务端为准，而不是以「刚才那次请求的返回值」为准。
 *
 * ⚠️ 快捷动作走**窄写入**接口（只改状态三个字段），不是把整份资料写回去：
 * 「暂停接单」不该顺带把昵称、介绍、排序覆盖成按钮渲染时的旧值。
 * 编辑表单则是**整份资料的覆盖写**（§八 白名单就是它的入参），
 * 两种语义对应两个接口，互不冒充。
 *
 * ⚠️ 所有危险动作都要二次确认，但确认框**不是防重手段**：
 * 真正的防重是每次提交带上的幂等键 + 服务端的状态判断（§九：不能依赖按钮禁用防重）。
 */
export default function AdminCompanionConsole({
  record: initialRecord,
  games,
}: {
  record: AdminCompanionDetail;
  games: CompanionGameOption[];
}) {
  const [record, setRecord] = useState(initialRecord);
  /** 每次写成功后自增：编辑表单以它为 key 重挂载，从而以服务端最新值重新填表 */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 状态动作的结果（显示在状态卡片里） */
  const [actionFlash, setActionFlash] = useState("");
  /** 编辑表单的保存结果（作为 prop 传给表单，它重挂载后仍然拿得到） */
  const [formFlash, setFormFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<FlagIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const reasonCount = countCharacters(reason.trim());
  const [reasonError, setReasonError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const status = adminCompanionStatus(record);
  const removed = record.removedAt !== null;

  async function runWrite(intent: FlagIntent, key: string, unavailableReason?: string) {
    setBusy(true);
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");

    try {
      const call = {
        pause: () => pauseCompanion(record.id, key, unavailableReason ?? ""),
        resume: () => resumeCompanion(record.id, key),
        disable: () => disableCompanion(record.id, key),
        enable: () => enableCompanion(record.id, key),
        remove: () => removeCompanion(record.id, key),
      }[intent];

      const result = await call();
      keyRef.current = null;
      setPendingIntent(null);

      // 无论服务端说「改了」还是「已经是这个状态」，都重新取一次详情：
      // 前端不拿响应里的几个字段自己拼出新状态，那会和真实记录分叉
      const fresh = await fetchAdminCompanion(record.id);
      setRecord(fresh);
      setVersion((value) => value + 1);
      setActionFlash(
        result.changed ? FLAG_SUCCESS_MESSAGE[intent] : "该护航已处于这个状态，未产生新的变更",
      );
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function openIntent(intent: FlagIntent) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");
    if (intent === "pause") {
      setReason("");
      setReasonError(null);
    }
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
    setReasonError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    if (!key || !pendingIntent || busy) return;

    if (pendingIntent === "pause") {
      // 与服务端**同一个函数**校验（必填 + 长度上限）：界面没有 `maxLength`，
      // 超长必须在提交时被明确拒绝，而不是被悄悄截断
      const checked = normalizeCompanionReason(reason);
      if (!checked.ok) {
        setReasonError(checked.message);
        reasonRef.current?.focus();
        return;
      }
      void runWrite("pause", key, checked.value);
      return;
    }

    void runWrite(pendingIntent, key);
  }

  // 各动作的前置条件：与 §八 的规则一一对应，且与服务端的判断同向。
  // 已移除是终态——不是「按钮变灰」，而是这一页没有可执行的动作。
  const can = {
    pause: !removed && record.enabled && record.available,
    resume: !removed && record.enabled && !record.available,
    disable: !removed && record.enabled,
    enable: !removed && !record.enabled,
    remove: !removed,
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src={record.avatarUrl}
              alt=""
              className="h-14 w-14 shrink-0 rounded-full border border-admin-line object-cover"
            />
            <div className="min-w-0">
              <p className="text-[16px] font-medium text-ink">{record.displayName}</p>
              <p className="font-mono text-[12px] text-ink-3">{record.id}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <AdminStatusBadge
              label={status.label}
              description={status.description}
              tone={COMPANION_STATUS_TONE[status.key]}
            />
            {!record.available && record.unavailableReason ? (
              <span className="text-[12px] text-ink-3">不可接单原因：{record.unavailableReason}</span>
            ) : null}
            {record.removedAt ? (
              <span className="text-[12px] text-ink-3">移除时间：{record.removedAt}</span>
            ) : null}
          </div>
        </div>

        {/* 状态动作 */}
        <h2 className="mt-5 text-[15px] font-medium text-ink">状态操作</h2>
        {removed ? (
          <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_COMPANION_REMOVED_MESSAGE}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => openIntent("pause")}
              disabled={!can.pause}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {ADMIN_COMPANION_ACTION_LABELS.pause}
            </button>
            <button
              type="button"
              onClick={() => openIntent("resume")}
              disabled={!can.resume}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {ADMIN_COMPANION_ACTION_LABELS.resume}
            </button>
            <button
              type="button"
              onClick={() => openIntent("disable")}
              disabled={!can.disable}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_COMPANION_ACTION_LABELS.disable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("enable")}
              disabled={!can.enable}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {ADMIN_COMPANION_ACTION_LABELS.enable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("remove")}
              disabled={!can.remove}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {ADMIN_COMPANION_ACTION_LABELS.remove}
            </button>
          </div>
        )}

        <p className="mt-3 text-[12px] leading-4 text-ink-3">
          暂停接单 = 仍在名单与详情页里、结算时不可选；停用 = 用户端名单与结算页都不出现，直链详情为只读；
          移除 = 软删除，历史订单、评价与鸡腿记录一条都不删。
        </p>

        {actionFlash ? (
          <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
            {actionFlash}
          </p>
        ) : null}
      </section>

      {/* 只读区块：这些数字由系统维护，页面只能看 */}
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">统计与关联（只读）</h2>
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          {ADMIN_COMPANION_DETAIL_FORBIDDEN_EDIT_NOTICE}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatItem
            label="评分"
            value={record.rating === null ? "—" : record.rating.toFixed(1)}
            hint={record.rating === null ? "还没有评价" : undefined}
          />
          <StatItem label="完成订单" value={String(record.completedOrderCount)} />
          <StatItem label="评价数" value={String(record.reviewCount)} />
          <StatItem label="鸡腿数" value={String(record.tipsCount)} />
          <StatItem label="展示排序" value={String(record.sortOrder)} />
        </dl>

        <div className="mt-4 flex flex-col gap-1 text-[13px]">
          <div className="flex gap-3">
            <span className="w-24 shrink-0 text-ink-3">关联用户</span>
            <span className="min-w-0 flex-1 break-words text-ink-2">
              {record.linkedUserId ?? "无（平台早期预置数据）"}
            </span>
          </div>
          <div className="flex gap-3">
            <span className="w-24 shrink-0 text-ink-3">来源申请</span>
            <span className="min-w-0 flex-1 break-words text-ink-2">
              {record.applicationId ? (
                <Link
                  href={`/admin/applications/${record.applicationId}`}
                  className="text-admin-accent underline-offset-2 hover:underline"
                >
                  {record.applicationId}
                </Link>
              ) : (
                "无（平台早期预置数据）"
              )}
            </span>
          </div>
        </div>
      </section>

      <AdminCompanionEditForm
        key={version}
        record={record}
        games={games}
        message={formFlash}
        onSaved={(message) => {
          setFormFlash(message);
          setActionFlash("");
          void fetchAdminCompanion(record.id).then((fresh) => {
            setRecord(fresh);
            setVersion((value) => value + 1);
          });
        }}
      />

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${ADMIN_COMPANION_ACTION_LABELS[pendingIntent]}这条护航` : ""}
        description={pendingIntent ? ADMIN_COMPANION_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${ADMIN_COMPANION_ACTION_LABELS[pendingIntent]}` : ""}
        tone={pendingIntent === "disable" || pendingIntent === "remove" ? "danger" : "primary"}
        pending={busy}
        error={confirmError}
        initialFocusRef={pendingIntent === "pause" ? reasonRef : undefined}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      >
        {pendingIntent === "pause" ? (
          <label className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
              <span>不可接单原因（必填，用户端会看到）</span>
              {/* 不用 `maxLength` 截断：可以一直写，超限在这里说清楚。 */}
              <AdminCharacterCounter current={reasonCount} max={COMPANION_PROFILE_REASON_MAX_LENGTH} />
            </span>
            <input
              ref={reasonRef}
              value={reason}
              onChange={(event) => {
                const value = event.target.value;
                setReason(value);
                // 边写边说：超限立刻标红；「必填」留给提交时提示
                setReasonError(
                  countCharacters(value.trim()) > COMPANION_PROFILE_REASON_MAX_LENGTH
                    ? COMPANION_PROFILE_REASON_TOO_LONG_MESSAGE
                    : null,
                );
              }}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? "pause-reason-error" : undefined}
              className={`h-9 rounded-lg border px-3 text-[13px] text-ink outline-none ${
                reasonError ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
              }`}
            />
            {reasonError ? (
              <span id="pause-reason-error" role="alert" className="text-[12px] text-brand-red">
                {reasonError}
              </span>
            ) : null}
          </label>
        ) : null}
      </AdminConfirmDialog>
    </div>
  );
}

function StatItem({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-admin-line px-3 py-2">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[18px] font-semibold tabular-nums text-ink">{value}</dd>
      {hint ? <p className="text-[11px] text-ink-3">{hint}</p> : null}
    </div>
  );
}
