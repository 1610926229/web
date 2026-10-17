"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  CONTENT_LABEL_MAX_LENGTH,
  CONTENT_SORT_ORDER_MAX,
  CONTENT_SORT_ORDER_MIN,
  QUICK_ENTRY_FIELD_LABELS,
  QUICK_ENTRY_ICON_LABELS,
  QUICK_ENTRY_ICONS,
  firstQuickEntryErrorField,
  hasQuickEntryError,
  normalizeQuickEntryProfilePatch,
  quickEntryFieldErrors,
  type QuickEntryField,
  type QuickEntryFieldErrors,
  type QuickEntryInput,
} from "@/lib/constants/adminContent";
import type { AdminQuickEntryProfilePatch } from "@/lib/types/content";
import type { AdminContentWriteAck } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { QuickEntryRow } from "@/components/admin/AdminQuickEntryTable";

/**
 * 快捷入口的编辑 / 新建表单。
 *
 * 能改的字段就是下面五个：入口名称、图标、目标地址、排序、启用状态。
 * `id`、`createdAt`、`updatedAt`、`removedAt` **在界面上没有输入框、
 * 在接口入参里也没有位置**——一次普通保存永远无法把一条已移除的入口改回未移除。
 *
 * ⚠️ **目标地址的校验不是这里写的**：规则只有一处
 * （`lib/constants/safePath.ts` 的 `validateSafePath()`，经
 * `quickEntryFieldErrors()` 映射成入口语境的文案），这里只负责把它的结论显示出来。
 * 在表单里另写一遍「必须 / 开头且不能 // 开头」，早晚会出现两处不一致，
 * 而不一致的那一侧就是漏洞所在（§九）。
 *
 * ⚠️ 这个地址会被直接放进用户端的 `<Link href>`，所以它必须过安全校验——
 * 一次误填、一次复制粘贴，用户端首页就会多一个指向站外（或 `javascript:`）的入口。
 */

export type QuickEntryFormProps = {
  /**
   * 编辑时的原始记录；**新建时显式传 `null`**。
   *
   * 用「有没有记录」代替一个额外的 `mode` 字段：两个 prop 表达同一件事，
   * 就有它们互相矛盾的可能，而那种矛盾只会在运行时暴露。
   */
  record: QuickEntryRow | null;
  create: (
    idempotencyKey: string,
    patch: AdminQuickEntryProfilePatch,
  ) => Promise<AdminContentWriteAck>;
  save: (
    id: string,
    idempotencyKey: string,
    patch: AdminQuickEntryProfilePatch,
  ) => Promise<AdminContentWriteAck>;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (message: string) => void;
  onCancel: () => void;
};

/**
 * 服务端回执 → 给用户看的那句话。
 *
 * ⚠️ 四句话必须分开，因为它们是四件不同的事（与公告表单同一套判断，理由见
 * `AdminAnnouncementForm.tsx` 的 `describeImageWrite()`）：重试命中（`replayed`）
 * 与「一个字段都没改」（`changed:false`）都**没有**写入，把它们显示成「已保存」
 * 会让人以为自己刚才的改动生效了——而真正的改动人可能是另一位管理员。
 */
const QUICK_ENTRY_WRITE_MESSAGES = {
  created: "已创建。用户端首页四宫格里立即会出现这个入口",
  saved: "已保存。用户端下一次刷新就是新入口",
  unchanged: "内容没有变化，未写入。列表里显示的就是服务端当前的记录",
  replayed: "这次提交与刚才那次是同一次操作，服务端没有重复写入；用户端看到的就是刚才那次的结果",
} as const;

function describeQuickEntryWrite(ack: AdminContentWriteAck, created: boolean): string {
  if (ack.replayed) return QUICK_ENTRY_WRITE_MESSAGES.replayed;
  if (!ack.changed) return QUICK_ENTRY_WRITE_MESSAGES.unchanged;
  return created ? QUICK_ENTRY_WRITE_MESSAGES.created : QUICK_ENTRY_WRITE_MESSAGES.saved;
}

export default function AdminQuickEntryForm({
  record,
  create,
  save,
  message,
  onSaved,
  onCancel,
}: QuickEntryFormProps) {
  const isCreate = record === null;

  const [label, setLabel] = useState(record?.label ?? "");
  const [icon, setIcon] = useState<string>(record?.icon ?? QUICK_ENTRY_ICONS[0]);
  const [path, setPath] = useState(record?.path ?? "");
  const [sortOrder, setSortOrder] = useState(
    record ? String(record.sortOrder) : String(CONTENT_SORT_ORDER_MIN),
  );
  const [enabled, setEnabled] = useState(record?.enabled ?? true);

  const [errors, setErrors] = useState<QuickEntryFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /** 幂等键：**一次「提交意图」一个键**。改动任何输入都会作废它，见 `invalidateKey()` */
  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const fieldId = (field: QuickEntryField) => `quick-entry-${field}`;

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * 一次 DOM 查询而不是「每字段一个 ref 回调」：后者等于在渲染期改 ref，
   * React 明确不允许。字段靠 `data-quick-entry-field` 定位；
   * `role="radiogroup"` 的容器还要 `tabIndex={-1}` 才真的接得住焦点。
   */
  function focusField(field: QuickEntryField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-quick-entry-field="${field}"]`)?.focus();
  }

  /** 任何输入变化都作废当前的幂等键：下一次提交是新的一次意图 */
  function invalidateKey() {
    keyRef.current = null;
  }

  function currentInput(): QuickEntryInput {
    const parsed = Number(sortOrder.trim());
    return {
      label,
      icon,
      path,
      // 空串与非数字都变成 NaN：校验会给出「排序值必须是…」，
      // 而不是静默当成 0 写进去
      sortOrder: sortOrder.trim() === "" ? Number.NaN : parsed,
      enabled,
    };
  }

  async function submit(key: string) {
    const patch = normalizeQuickEntryProfilePatch(currentInput());
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      // ⚠️ 「这次到底写没写」由**服务端说了算**（`changed` / `replayed`），
      // 客户端不拿手上那份快照自己比。确认后的那条记录刻意不接：
      // 页面显示的那一行由父组件**重新取一份列表**决定，读响应拼一行出来会和真实记录分叉
      const ack = isCreate
        ? await create(key, patch)
        : await save(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);
      onSaved(describeQuickEntryWrite(ack, isCreate));
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "保存失败，请稍后重试。";
      // 确认框开着时错误显示在框里，否则显示在表单底部
      if (confirming) setConfirmError(text);
      else setSubmitError(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = quickEntryFieldErrors(currentInput());
    setErrors(next);
    setSubmitError(null);

    if (hasQuickEntryError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstQuickEntryErrorField(next));
      return;
    }

    // 重试沿用同一个键：上一次点击已经把请求发出去了，换一个键就等于让服务端
    // 把它当成第二次写入（§九）。只有改了输入才会作废它
    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    // 新建时「启用」是默认值，不是一个变更；只有编辑时改了启用状态才需要二次确认
    if (record !== null && enabled !== record.enabled) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void submit(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: QuickEntryField) {
    const error = errors?.[field] ?? null;
    return {
      error,
      errorId: `${fieldId(field)}-error`,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        error ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
    };
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">
          {isCreate ? "新增快捷入口" : "编辑快捷入口"}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          用户端首页是**四宫格**：每格很窄，名称建议不超过 6 个字，超过{" "}
          {CONTENT_LABEL_MAX_LENGTH} 个字会被拦下。排序值决定它排在第几格。
        </p>
        {record ? <p className="mt-1 font-mono text-[12px] text-ink-3">{record.id}</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={QUICK_ENTRY_FIELD_LABELS.label}
          error={fieldProps("label").error}
          errorId={fieldProps("label").errorId}
          hint="显示在图标下面的那行字"
          counter={
            <AdminCharacterCounter
              current={countCharacters(label.trim())}
              max={CONTENT_LABEL_MAX_LENGTH}
            />
          }
          htmlFor={fieldId("label")}
        >
          <input
            id={fieldId("label")}
            data-quick-entry-field="label"
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              invalidateKey();
            }}
            aria-invalid={fieldProps("label").error ? true : undefined}
            aria-describedby={fieldProps("label").error ? fieldProps("label").errorId : undefined}
            className={`h-9 w-full ${fieldProps("label").className}`}
          />
        </AdminField>

        <AdminField
          label={QUICK_ENTRY_FIELD_LABELS.icon}
          error={fieldProps("icon").error}
          errorId={fieldProps("icon").errorId}
          hint="图标是内置的几个图形之一，不是图片地址——本阶段不做图片上传"
          htmlFor={fieldId("icon")}
        >
          <select
            id={fieldId("icon")}
            data-quick-entry-field="icon"
            value={icon}
            onChange={(event) => {
              setIcon(event.target.value);
              invalidateKey();
            }}
            aria-invalid={fieldProps("icon").error ? true : undefined}
            aria-describedby={fieldProps("icon").error ? fieldProps("icon").errorId : undefined}
            className={`h-9 w-full ${fieldProps("icon").className}`}
          >
            {QUICK_ENTRY_ICONS.map((value) => (
              <option key={value} value={value}>
                {QUICK_ENTRY_ICON_LABELS[value]}
              </option>
            ))}
          </select>
        </AdminField>
      </div>

      <AdminField
        label={QUICK_ENTRY_FIELD_LABELS.path}
        error={fieldProps("path").error}
        errorId={fieldProps("path").errorId}
        hint="必须是以 / 开头的站内路径，例如 /join、/categories；不支持站外地址（http:// 或 // 开头的一律被拒绝）"
        htmlFor={fieldId("path")}
      >
        <input
          id={fieldId("path")}
          data-quick-entry-field="path"
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            invalidateKey();
          }}
          placeholder="/join"
          aria-invalid={fieldProps("path").error ? true : undefined}
          aria-describedby={fieldProps("path").error ? fieldProps("path").errorId : undefined}
          className={`h-9 w-full font-mono ${fieldProps("path").className}`}
        />
      </AdminField>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={QUICK_ENTRY_FIELD_LABELS.sortOrder}
          error={fieldProps("sortOrder").error}
          errorId={fieldProps("sortOrder").errorId}
          hint={`${CONTENT_SORT_ORDER_MIN} 到 ${CONTENT_SORT_ORDER_MAX}，越小越靠前（越靠左）`}
          htmlFor={fieldId("sortOrder")}
        >
          <input
            id={fieldId("sortOrder")}
            data-quick-entry-field="sortOrder"
            value={sortOrder}
            inputMode="numeric"
            onChange={(event) => {
              setSortOrder(event.target.value);
              invalidateKey();
            }}
            aria-invalid={fieldProps("sortOrder").error ? true : undefined}
            aria-describedby={
              fieldProps("sortOrder").error ? fieldProps("sortOrder").errorId : undefined
            }
            className={`h-9 w-full ${fieldProps("sortOrder").className}`}
          />
        </AdminField>

        <AdminField
          label={QUICK_ENTRY_FIELD_LABELS.enabled}
          hint={enabled ? "用户端四宫格里有它" : "用户端四宫格里没有它；记录保留，随时可以重新启用"}
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-quick-entry-field="enabled"
            aria-label={QUICK_ENTRY_FIELD_LABELS.enabled}
            className="flex gap-2"
          >
            <AdminToggleButton
              active={enabled}
              onClick={() => {
                setEnabled(true);
                invalidateKey();
              }}
              label="启用"
            />
            <AdminToggleButton
              active={!enabled}
              onClick={() => {
                setEnabled(false);
                invalidateKey();
              }}
              label="停用"
            />
          </div>
        </AdminField>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy ? "保存中…" : isCreate ? "新建" : "保存"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-admin-line px-4 py-2 text-[13px] text-ink-2 hover:bg-page disabled:opacity-60"
        >
          取消
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          「移除」是另一个动作，在列表里——它不能被一次普通保存顺带触发。
        </span>
      </div>

      {message ? (
        <p role="status" className="text-[13px] leading-5 text-status-success">
          {message}
        </p>
      ) : null}

      {submitError ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {submitError}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={confirming}
        title={`${enabled ? "启用" : "停用"}这个快捷入口`}
        description={
          enabled
            ? "启用后用户端首页的四宫格里立即会出现它；如果同一个位置已经有四个入口，它会按排序值挤进去。"
            : "停用后用户端首页的四宫格里立即没有它。记录与配置都保留，随时可以重新启用。"
        }
        confirmLabel={`确认${enabled ? "启用" : "停用"}`}
        tone={enabled ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key) void submit(key);
        }}
        onCancel={() => {
          if (busy) return;
          // 取消这次改变启用状态的意图：键作废，下次提交是新的一次
          invalidateKey();
          setConfirming(false);
          setConfirmError(null);
        }}
      />
    </form>
  );
}
