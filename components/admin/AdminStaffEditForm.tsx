"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import { AdminField } from "@/components/admin/AdminFormField";
import {
  ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH,
  ADMIN_STAFF_EDIT_TITLE,
  ADMIN_STAFF_EDIT_TITLE_HINT,
  ADMIN_STAFF_PROFILE_FIELD_LABELS,
  ADMIN_STAFF_REMOVED_MESSAGE,
  ADMIN_STAFF_SAVE_LABEL,
  ADMIN_STAFF_USERNAME_MAX_LENGTH,
  firstAdminStaffProfileErrorField,
  hasStaffProfileError,
  staffProfileFieldErrors,
  type AdminStaffProfileField,
  type AdminStaffProfileFieldErrors,
  type AdminStaffProfileInput,
} from "@/lib/constants/adminStaff";
import { MOCK_AVATAR_OPTIONS } from "@/lib/constants/profile";
import { saveAdminStaffProfile } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { AdminStaffDetail } from "@/lib/types/staff";

/**
 * 客服资料编辑表单。
 *
 * 能改的就是三样：登录名、客服名称、头像。
 * **状态不在这里**——启用、停用、移除各有自己的接口（详情页的状态按钮）。
 * 「编辑时顺手把状态一起写回去」看着省事，实际上会在两个人同时操作时
 * 让后写的那次把刚停用的账号重新启用：那个表单里带着渲染时的旧状态。
 *
 * 三条与其它管理端表单一致的做法：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红，
 *    由校验给出明确错误。截断会让人以为「我已经写完了」。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去——顺序与校验顺序一致，即页面上最靠上的那条。
 * 3. **校验与服务端共用同一份函数**（`staffProfileFieldErrors()`），
 *    因此不会出现「前端说能提交、服务端却拒绝」。
 *
 * ⚠️ **唯一性不在这里判**：它要查仓储，属于服务端的活。表单可能显示「已被占用」，
 * 但那是提交之后服务端返回的结果，不是前端猜出来的——前端猜不准，也不该猜。
 */
export default function AdminStaffEditForm({
  record,
  message,
  onSaved,
}: {
  record: AdminStaffDetail;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (message: string) => void;
}) {
  const [username, setUsername] = useState(record.username);
  const [displayName, setDisplayName] = useState(record.displayName);
  const [avatarUrl, setAvatarUrl] = useState(record.avatarUrl);

  const [errors, setErrors] = useState<AdminStaffProfileFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  /**
   * 把焦点移到出错的字段上。
   *
   * ⚠️ 不用「每个字段一个 ref 回调、渲染期往 map 里写」的写法：那等于在渲染期改 ref，
   * React 明确不允许。改成一次 DOM 查询——表单里每个字段都带 `data-staff-field`；
   * `role="radiogroup"` 的容器还要 `tabIndex={-1}` 才真的接得住焦点。
   */
  function focusField(field: AdminStaffProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-staff-field="${field}"]`)?.focus();
  }

  const usernameCount = countCharacters(username.trim());
  const nameCount = countCharacters(displayName.trim());

  function currentInput(): AdminStaffProfileInput {
    return { username, displayName, avatarUrl };
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: AdminStaffProfileField) {
    const text = errors?.[field] ?? null;
    return {
      "aria-invalid": text ? true : undefined,
      "aria-describedby": text ? `staff-${field}-error` : undefined,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        text ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
      message: text,
    };
  }

  async function save(key: string) {
    setBusy(true);
    setSubmitError(null);

    try {
      const result = await saveAdminStaffProfile(record.id, key, currentInput());
      keyRef.current = null;
      onSaved(
        result.changed
          ? "已保存：该账号的登录名与名称立即生效，历史消息仍按发送时的名称显示"
          : "没有需要保存的改动",
      );
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = staffProfileFieldErrors(currentInput());
    setErrors(next);
    setSubmitError(null);

    if (hasStaffProfileError(next)) {
      focusField(firstAdminStaffProfileErrorField(next));
      return;
    }

    // 幂等键每次提交领一个新的：真正的防重靠它 + 服务端的状态判断，
    // 不靠「按钮禁用了就点不到」——网络慢的时候按钮还没禁用，第二次点击已经发出去了
    keyRef.current = crypto.randomUUID();
    void save(keyRef.current);
  }

  // 已移除是终态：服务端会拒绝任何写入，表单**不渲染成可编辑**——
  // 让人填完一整张表再告诉他「已移除，不能编辑」是最没必要的一次挫败
  if (record.removedAt !== null) {
    return (
      <section className="rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[15px] font-medium text-ink">{ADMIN_STAFF_EDIT_TITLE}</h2>
        <p className="mt-2 text-[13px] leading-5 text-ink-3">{ADMIN_STAFF_REMOVED_MESSAGE}</p>
      </section>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">{ADMIN_STAFF_EDIT_TITLE}</h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{ADMIN_STAFF_EDIT_TITLE_HINT}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 登录名 */}
        <AdminField
          label={ADMIN_STAFF_PROFILE_FIELD_LABELS.username}
          error={fieldProps("username").message}
          errorId="staff-username-error"
          counter={
            <AdminCharacterCounter current={usernameCount} max={ADMIN_STAFF_USERNAME_MAX_LENGTH} />
          }
          hint="字母、数字、连字符与下划线；不区分大小写唯一"
          htmlFor="staff-username"
        >
          <input
            id="staff-username"
            data-staff-field="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={fieldProps("username")["aria-invalid"]}
            aria-describedby={fieldProps("username")["aria-describedby"]}
            className={`h-9 w-full font-mono ${fieldProps("username").className}`}
          />
        </AdminField>

        {/* 客服名称 */}
        <AdminField
          label={ADMIN_STAFF_PROFILE_FIELD_LABELS.displayName}
          error={fieldProps("displayName").message}
          errorId="staff-displayName-error"
          counter={
            <AdminCharacterCounter
              current={nameCount}
              max={ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH}
            />
          }
          hint="显示在工作台顶部与客服发出的消息上"
          htmlFor="staff-displayName"
        >
          <input
            id="staff-displayName"
            data-staff-field="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={fieldProps("displayName")["aria-invalid"]}
            aria-describedby={fieldProps("displayName")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("displayName").className}`}
          />
        </AdminField>
      </div>

      {/* 头像：白名单 Mock 占位图，不能填任意地址 */}
      <AdminField
        label={ADMIN_STAFF_PROFILE_FIELD_LABELS.avatarUrl}
        error={fieldProps("avatarUrl").message}
        errorId="staff-avatarUrl-error"
        hint="只能从平台提供的占位图里选"
      >
        <div
          role="radiogroup"
          tabIndex={-1}
          data-staff-field="avatarUrl"
          aria-label={ADMIN_STAFF_PROFILE_FIELD_LABELS.avatarUrl}
          aria-invalid={fieldProps("avatarUrl")["aria-invalid"]}
          aria-describedby={fieldProps("avatarUrl")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {MOCK_AVATAR_OPTIONS.map((option, index) => {
            const active = option === avatarUrl;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`头像 ${index + 1}`}
                onClick={() => setAvatarUrl(option)}
                className={`rounded-full border-2 p-0.5 ${
                  active ? "border-admin-accent" : "border-transparent"
                }`}
              >
                <img
                  src={option}
                  alt=""
                  className="h-10 w-10 rounded-full border border-admin-line object-cover"
                />
              </button>
            );
          })}
        </div>
      </AdminField>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy ? "保存中…" : ADMIN_STAFF_SAVE_LABEL}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          启用、停用与移除不在这里，它们在页面的状态操作里。
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
    </form>
  );
}
