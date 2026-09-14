"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import AdminStaffEditForm from "@/components/admin/AdminStaffEditForm";
import AdminStatusBadge, { STAFF_STATE_TONE } from "@/components/admin/AdminStatusBadge";
import {
  ADMIN_STAFF_CREDENTIAL_NOTICE,
  ADMIN_STAFF_REMOVED_MESSAGE,
  staffLoginabilityNotice,
} from "@/lib/constants/adminStaff";
import {
  disableAdminStaff,
  enableAdminStaff,
  fetchAdminStaff,
  removeAdminStaff,
} from "@/lib/services/adminHttp";
import type { AdminStaffDetail } from "@/lib/types/staff";
import { formatDateTime } from "@/lib/utils/format";

/** 需要二次确认的两个动作。启用不在其中——理由见下面的组件注释。 */
type ConfirmIntent = "disable" | "remove";
/** 三个状态动作。启用是可逆的，停用与移除会让账号当场失去访问权。 */
type FlagIntent = "enable" | ConfirmIntent;

const FLAG_LABELS: Record<FlagIntent, string> = {
  enable: "启用",
  disable: "停用",
  remove: "移除",
};

/**
 * 二次确认的说明文字。
 *
 * 每一句都要落在**后果**上，而不是「确定要停用吗？」这种复述按钮的同义句：
 * 运营点确认之前要知道的是「哪些人会因此进不去、东西会不会丢」。
 */
const FLAG_CONFIRM_TEXTS: Record<ConfirmIntent, string> = {
  disable:
    "停用后该账号立即失去客服工作台权限，浏览器里已有的客服端 Cookie 也随即失效；" +
    "已发送的历史消息不受影响，仍按发送时的名称与头像显示。可以再次启用。",
  remove:
    "移除是**软删除，不可撤销**：该账号不能再登录，也不能再被启用。" +
    "记录与历史消息全部保留，可以在列表里用「已移除」筛出来查看。",
};

const FLAG_SUCCESS_MESSAGE: Record<FlagIntent, string> = {
  enable: "已启用：该账号可以登录客服工作台",
  disable: "已停用：该账号立即失去工作台权限，已有客服端 Cookie 也已失效",
  remove: "已移除：不能再登录，历史消息与记录均已保留",
};

/**
 * 客服详情的**唯一写入口**：状态动作 + 资料编辑表单。
 *
 * 与护航详情同一个理由：两件事写的是同一条记录，必须共用一条刷新路径。
 * 任何一次写成功都重新取一次详情，编辑表单以 `key` 重挂载——
 * 页面永远显示服务端的最新值，而不是「刚才那次请求的返回值拼出来的值」。
 *
 * ⚠️ **启用不弹确认框**。这不是省事：启用是可逆的、不让任何人失去访问权。
 * 给一个无害的动作也套一层确认，只会训练出「看到确认框就点确定」的习惯，
 * 等真正的停用 / 移除弹出来时，那一下也变成了习惯性点击。
 * 停用与移除则**必须**确认（§二：禁用和删除需要二次确认）。
 *
 * ⚠️ 确认框不是防重手段：真正的防重是每次提交带上的幂等键 + 服务端的状态判断。
 * 重复点一次「停用」，服务端返回 `changed: false`，不报错也不写第二条审计。
 */
export default function AdminStaffConsole({
  record: initialRecord,
}: {
  record: AdminStaffDetail;
}) {
  const [record, setRecord] = useState(initialRecord);
  /** 每次写成功后自增：编辑表单以它为 key 重挂载，从而以服务端最新值重新填表 */
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 状态动作的结果 */
  const [actionFlash, setActionFlash] = useState("");
  /** 编辑表单的保存结果（作为 prop 传给表单，它重挂载后仍然拿得到） */
  const [formFlash, setFormFlash] = useState("");
  const [pendingIntent, setPendingIntent] = useState<ConfirmIntent | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /** 幂等键在**动作开始时**领一次，重试（关掉再点开）会换一个新键 */
  const keyRef = useRef<string | null>(null);

  // 状态用**服务端算好的** `record.state`，不自己拿 `enabled` / `removedAt` 推：
  // 「已移除优先于已停用」这条判断只在 `staffStateOf()` 里写一次
  const state = record.state;
  const removed = record.removedAt !== null;

  /** 写成功后统一刷新：不拿响应里的几个字段自己拼状态，那会和真实记录分叉 */
  async function refresh() {
    const fresh = await fetchAdminStaff(record.id);
    setRecord(fresh);
    setVersion((value) => value + 1);
  }

  async function runWrite(intent: FlagIntent, key: string) {
    setBusy(true);
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");

    try {
      const result = await {
        enable: () => enableAdminStaff(record.id, key),
        disable: () => disableAdminStaff(record.id, key),
        remove: () => removeAdminStaff(record.id, key),
      }[intent]();

      keyRef.current = null;
      setPendingIntent(null);
      await refresh();
      setActionFlash(
        result.changed ? FLAG_SUCCESS_MESSAGE[intent] : "该账号已处于这个状态，未产生新的变更",
      );
    } catch (cause) {
      // 失败不关确认框：错误要留在原地，关掉它等于把错误也关掉了
      setConfirmError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  /** 启用不需要确认：领好幂等键直接提交。 */
  function runEnable() {
    if (busy) return;
    keyRef.current = crypto.randomUUID();
    void runWrite("enable", keyRef.current);
  }

  function openIntent(intent: ConfirmIntent) {
    keyRef.current = crypto.randomUUID();
    setConfirmError(null);
    setActionFlash("");
    setFormFlash("");
    setPendingIntent(intent);
  }

  function closeIntent() {
    if (busy) return;
    keyRef.current = null;
    setPendingIntent(null);
    setConfirmError(null);
  }

  function confirmIntent() {
    const key = keyRef.current;
    if (!key || !pendingIntent || busy) return;
    void runWrite(pendingIntent, key);
  }

  // 前置条件与服务端同向：已移除是终态，这一页就没有可执行的动作。
  const can = {
    enable: record.state === "disabled",
    disable: record.state === "enabled",
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
              <p className="font-mono text-[12px] text-ink-3">
                {record.username} · {record.id}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <AdminStatusBadge
              label={record.stateLabel}
              tone={STAFF_STATE_TONE[state]}
              description={record.roleLabel}
            />
            <span className="text-[12px] text-ink-3">{staffLoginabilityNotice(record)}</span>
            {record.removedAt ? (
              <span className="text-[12px] text-ink-3">
                移除时间：{formatDateTime(record.removedAt)}
              </span>
            ) : null}
          </div>
        </div>

        {/* 状态动作 */}
        <h2 className="mt-5 text-[15px] font-medium text-ink">状态操作</h2>
        {removed ? (
          <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_STAFF_REMOVED_MESSAGE}</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runEnable}
              disabled={!can.enable || busy}
              className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
            >
              {FLAG_LABELS.enable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("disable")}
              disabled={!can.disable}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {FLAG_LABELS.disable}
            </button>
            <button
              type="button"
              onClick={() => openIntent("remove")}
              disabled={!can.remove}
              className="rounded-lg border border-status-danger px-4 py-2 text-[13px] text-status-danger hover:bg-page disabled:opacity-40"
            >
              {FLAG_LABELS.remove}
            </button>
          </div>
        )}

        <p className="mt-3 text-[12px] leading-4 text-ink-3">
          停用 = 立即失去工作台权限、已有客服端 Cookie 失效，可以再次启用；
          移除 = 软删除、不可撤销，记录与历史消息一条都不删。
        </p>

        {actionFlash ? (
          <p role="status" className="mt-2 text-[13px] leading-5 text-status-success">
            {actionFlash}
          </p>
        ) : null}
      </section>

      {/* 只读区块：这些时间由服务端维护，页面只能看 */}
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">账号信息（只读）</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatItem label="上次登录" value={record.lastLoginAt ? formatDateTime(record.lastLoginAt) : "从未登录"} />
          <StatItem label="创建时间" value={formatDateTime(record.createdAt)} />
          <StatItem label="更新时间" value={formatDateTime(record.updatedAt)} />
          <StatItem
            label="可进工作台"
            value={record.canEnterStaffConsole ? "是" : "否"}
            hint={record.canEnterStaffConsole ? undefined : "由服务端判定，页面不自己判角色"}
          />
        </dl>
      </section>

      <AdminStaffEditForm
        key={version}
        record={record}
        message={formFlash}
        onSaved={(message) => {
          setFormFlash(message);
          setActionFlash("");
          void refresh();
        }}
      />

      <p className="rounded-xl border border-admin-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
        {ADMIN_STAFF_CREDENTIAL_NOTICE}
      </p>

      <AdminConfirmDialog
        open={pendingIntent !== null}
        title={pendingIntent ? `${FLAG_LABELS[pendingIntent]}这个客服账号` : ""}
        description={pendingIntent ? FLAG_CONFIRM_TEXTS[pendingIntent] : ""}
        confirmLabel={pendingIntent ? `确认${FLAG_LABELS[pendingIntent]}` : ""}
        tone="danger"
        pending={busy}
        error={confirmError}
        onConfirm={confirmIntent}
        onCancel={closeIntent}
      />
    </div>
  );
}

function StatItem({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-admin-line px-3 py-2">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium tabular-nums text-ink">{value}</dd>
      {hint ? <p className="mt-0.5 text-[11px] leading-4 text-ink-3">{hint}</p> : null}
    </div>
  );
}
