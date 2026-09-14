"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import { AdminField } from "@/components/admin/AdminFormField";
import {
  ADMIN_STAFF_CREATE_LABEL,
  ADMIN_STAFF_CREATE_TITLE,
  ADMIN_STAFF_CREDENTIAL_NOTICE,
  ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH,
  ADMIN_STAFF_PROFILE_FIELD_LABELS,
  ADMIN_STAFF_USERNAME_MAX_LENGTH,
  firstAdminStaffProfileErrorField,
  hasStaffProfileError,
  staffProfileFieldErrors,
  type AdminStaffProfileField,
  type AdminStaffProfileFieldErrors,
  type AdminStaffProfileInput,
} from "@/lib/constants/adminStaff";
import { MOCK_AVATAR_OPTIONS } from "@/lib/constants/profile";
import { createAdminStaff } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";

/**
 * 新增客服账号表单。
 *
 * ⚠️ **请求体里只有三个资料字段与一个幂等键**，没有 `role`、没有 `enabled`、没有密码：
 *
 * - 角色由服务端写死为 `customer_service`。表单上**没有角色选择器**，
 *   因此「建一个管理员 / 建一个护航」在界面上没有入口，在接口请求体里也没有落脚的字段；
 * - 新账号一律是启用、未移除；
 * - 本阶段不保存任何真实密码（§二），所以这里**没有密码框**——
 *   画一个密码框会让人以为它真的存了密码。这件事由页面上的 Mock 标注说清楚。
 *
 * 校验、错误关联与「第一条错误自动聚焦」的做法与编辑表单完全一致，
 * 两份表单调的是同一组校验函数（`lib/constants/adminStaff.ts`）。
 */
export default function AdminStaffCreateForm() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  // 白名单为空时给空串：校验会明确报「头像只能是白名单里的 Mock 占位图」，
  // 而不是悄悄塞一张并不存在的图进去
  const [avatarUrl, setAvatarUrl] = useState(MOCK_AVATAR_OPTIONS[0] ?? "");

  const [errors, setErrors] = useState<AdminStaffProfileFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  function focusField(field: AdminStaffProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-staff-field="${field}"]`)?.focus();
  }

  const usernameCount = countCharacters(username.trim());
  const nameCount = countCharacters(displayName.trim());

  function fieldProps(field: AdminStaffProfileField) {
    const text = errors?.[field] ?? null;
    return {
      "aria-invalid": text ? true : undefined,
      "aria-describedby": text ? `staff-new-${field}-error` : undefined,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        text ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
      message: text,
    };
  }

  async function submit(key: string) {
    const input: AdminStaffProfileInput = { username, displayName, avatarUrl };
    setBusy(true);
    setSubmitError(null);

    try {
      const result = await createAdminStaff(key, input);
      keyRef.current = null;
      // 成功后跳详情页：新账号的状态按钮、登录能力提示都在那一页，
      // 留在表单上会让人不确定「到底建成了没有」
      router.push(`/admin/customer-service/${result.staff.id}`);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "创建失败，请稍后重试。");
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = staffProfileFieldErrors({ username, displayName, avatarUrl });
    setErrors(next);
    setSubmitError(null);

    if (hasStaffProfileError(next)) {
      focusField(firstAdminStaffProfileErrorField(next));
      return;
    }

    // ⚠️ 重复点击「创建」会创建出两条账号吗？不会：同一个幂等键第二次进来时，
    // 服务端从审计索引里查出首次创建的那条记录并原样返回（`takeCreateReplay`），
    // 不新建、不重复审计。键在**提交的这一刻**领，重试（改完再点）会换新键。
    keyRef.current = crypto.randomUUID();
    void submit(keyRef.current);
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">{ADMIN_STAFF_CREATE_TITLE}</h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          新账号创建后就是启用状态，创建者可以在 /staff/login 的测试账号列表里选它进入工作台。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 登录名 */}
        <AdminField
          label={ADMIN_STAFF_PROFILE_FIELD_LABELS.username}
          error={fieldProps("username").message}
          errorId="staff-new-username-error"
          counter={
            <AdminCharacterCounter current={usernameCount} max={ADMIN_STAFF_USERNAME_MAX_LENGTH} />
          }
          hint="字母、数字、连字符与下划线；不区分大小写唯一"
          htmlFor="staff-new-username"
        >
          <input
            id="staff-new-username"
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
          errorId="staff-new-displayName-error"
          counter={
            <AdminCharacterCounter
              current={nameCount}
              max={ADMIN_STAFF_DISPLAY_NAME_MAX_LENGTH}
            />
          }
          hint="显示在工作台顶部与客服发出的消息上"
          htmlFor="staff-new-displayName"
        >
          <input
            id="staff-new-displayName"
            data-staff-field="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={fieldProps("displayName")["aria-invalid"]}
            aria-describedby={fieldProps("displayName")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("displayName").className}`}
          />
        </AdminField>
      </div>

      {/* 头像 */}
      <AdminField
        label={ADMIN_STAFF_PROFILE_FIELD_LABELS.avatarUrl}
        error={fieldProps("avatarUrl").message}
        errorId="staff-new-avatarUrl-error"
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

      {/* 角色与密码：**没有输入框**，这里明说为什么 */}
      <p className="rounded-xl border border-admin-line bg-page px-4 py-3 text-[12px] leading-5 text-ink-3">
        {ADMIN_STAFF_CREDENTIAL_NOTICE}
        <br />
        角色由服务端固定为「客服」，页面上没有角色选择器，也没有启用开关——新账号一律启用。
      </p>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy ? "创建中…" : ADMIN_STAFF_CREATE_LABEL}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          创建后不会自动跳进工作台：那是客服自己的入口。
        </span>
      </div>

      {submitError ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {submitError}
        </p>
      ) : null}
    </form>
  );
}
