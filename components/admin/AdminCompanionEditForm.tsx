"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import { COMPANION_SERVICE_TAGS } from "@/lib/constants/companionApplications";
import {
  ADMIN_COMPANION_CONFIRM_TEXTS,
  ADMIN_COMPANION_ACTION_LABELS,
  ADMIN_COMPANION_EDIT_TITLE,
  COMPANION_AVATAR_OPTIONS,
  COMPANION_PROFILE_FIELD_LABELS,
  COMPANION_PROFILE_INTRO_MAX_LENGTH,
  COMPANION_PROFILE_NAME_MAX_LENGTH,
  COMPANION_PROFILE_REASON_MAX_LENGTH,
  COMPANION_SORT_ORDER_MAX,
  COMPANION_SORT_ORDER_MIN,
  companionProfileFieldErrors,
  firstCompanionProfileErrorField,
  hasCompanionProfileError,
  normalizeCompanionProfilePatch,
  type CompanionProfileField,
  type CompanionProfileFieldErrors,
  type CompanionProfileInput,
} from "@/lib/constants/adminCompanions";
import { saveCompanionProfile } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { AdminCompanionDetail, CompanionGameOption } from "@/lib/types/companion";

/**
 * 护航资料编辑表单（§八 的**白名单**）。
 *
 * 能改的就是下面这十个字段：昵称、头像、介绍、游戏、大区、服务标签、启用状态、
 * 可接单状态、不可接单原因、展示排序。统计、关联用户、来源申请、移除时间
 * **在界面上没有输入框，在接口入参里也没有位置**——不是「暂时没做校验」。
 *
 * 三条与用户端表单一致的做法：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红，
 *    由校验给出明确错误。截断会让人以为「我已经写完了」。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去——顺序与服务端的校验顺序一致。
 * 3. **校验与服务端共用同一份函数**（`companionProfileFieldErrors()` /
 *    `normalizeCompanionProfilePatch()`），因此不会出现「前端说能提交、服务端却拒绝」。
 *
 * ⚠️ 这是一次**整份资料的覆盖写**（PATCH 的语义就是如此）：它不冒充
 * 「只改一个字段」的接口，那类改动走详情页的窄写入快捷动作。
 * 改动启用状态要二次确认——停用会让这条资料从用户端彻底消失。
 */
export default function AdminCompanionEditForm({
  record,
  games,
  message,
  onSaved,
}: {
  record: AdminCompanionDetail;
  /** 游戏目录（含每个游戏的大区）：大区必须属于所选游戏 */
  games: CompanionGameOption[];
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (message: string) => void;
}) {
  const [displayName, setDisplayName] = useState(record.displayName);
  const [avatarUrl, setAvatarUrl] = useState(record.avatarUrl);
  const [intro, setIntro] = useState(record.intro);
  const [gameIds, setGameIds] = useState<string[]>(record.games.map((game) => game.id));
  const [regions, setRegions] = useState<string[]>(record.regions);
  const [serviceTags, setServiceTags] = useState<string[]>(record.serviceTags);
  const [enabled, setEnabled] = useState(record.enabled);
  const [available, setAvailable] = useState(record.available);
  const [unavailableReason, setUnavailableReason] = useState(record.unavailableReason);
  const [sortOrder, setSortOrder] = useState(String(record.sortOrder));

  const [errors, setErrors] = useState<CompanionProfileFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * ⚠️ 这里**不**用「每个字段一个 ref 回调、渲染期往 map 里写」的写法：
   * 那等于在渲染期改 ref，React 明确不允许。改成一次 DOM 查询——
   * 表单里每个字段都带 `data-companion-field`；`role="group"` 的容器
   * 还要 `tabIndex={-1}` 才真的接得住焦点（div 默认不可聚焦）。
   */
  function focusField(field: CompanionProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-companion-field="${field}"]`)?.focus();
  }

  const nameCount = countCharacters(displayName.trim());
  const introCount = countCharacters(intro.trim());
  const reasonCount = countCharacters(unavailableReason.trim());
  const reasonRequired = enabled && !available;
  // 停用时可接单状态必然为 false（服务端也会强制归零），因此勾选框跟着禁用并说明原因
  const availableChecked = enabled ? available : false;

  const selectedRegions = games
    .filter((game) => gameIds.includes(game.id))
    .flatMap((game) => game.regions);
  const regionOptions = Array.from(new Set(selectedRegions));

  function currentInput(): CompanionProfileInput {
    const parsed = Number(sortOrder.trim());
    return {
      displayName,
      avatarUrl,
      intro,
      gameIds,
      regions,
      serviceTags,
      enabled,
      available: availableChecked,
      unavailableReason,
      // 空串与非数字都变成 NaN：校验会给出「展示排序只能是…」，
      // 而不是静默当成 0 写进去
      sortOrder: sortOrder.trim() === "" ? Number.NaN : parsed,
    };
  }

  async function save(key: string) {
    const input = currentInput();
    const patch = normalizeCompanionProfilePatch(input, games);
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      const result = await saveCompanionProfile(record.id, key, patch);
      keyRef.current = null;
      setConfirming(false);
      onSaved(result.changed ? "已保存，用户端列表、详情与结算页立即生效" : "没有需要保存的改动");
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

    const next = companionProfileFieldErrors(currentInput(), games);
    setErrors(next);
    setSubmitError(null);

    if (hasCompanionProfileError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstCompanionProfileErrorField(next));
      return;
    }

    keyRef.current = crypto.randomUUID();

    if (enabled !== record.enabled) {
      // 改启用状态是危险动作：停用会让这条资料从用户端彻底消失
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void save(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: CompanionProfileField) {
    const message = errors?.[field] ?? null;
    return {
      id: `companion-${field}`,
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `companion-${field}-error` : undefined,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        message ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
      message,
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
        <h2 className="text-[15px] font-medium text-ink">{ADMIN_COMPANION_EDIT_TITLE}</h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          保存后会立即反映到用户端的陪玩列表、详情页与结算页——三处读的是同一份数据。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 昵称 */}
        <AdminField
          label={COMPANION_PROFILE_FIELD_LABELS.displayName}
          error={fieldProps("displayName").message}
          errorId="companion-displayName-error"
          counter={
            <AdminCharacterCounter current={nameCount} max={COMPANION_PROFILE_NAME_MAX_LENGTH} />
          }
          htmlFor="companion-displayName"
        >
          <input
            id="companion-displayName"
            data-companion-field="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={fieldProps("displayName")["aria-invalid"]}
            aria-describedby={fieldProps("displayName")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("displayName").className}`}
          />
        </AdminField>

        {/* 介绍 */}
        <AdminField
          label={COMPANION_PROFILE_FIELD_LABELS.intro}
          error={fieldProps("intro").message}
          errorId="companion-intro-error"
          counter={<AdminCharacterCounter current={introCount} max={COMPANION_PROFILE_INTRO_MAX_LENGTH} />}
          htmlFor="companion-intro"
        >
          <textarea
            id="companion-intro"
            data-companion-field="intro"
            value={intro}
            onChange={(event) => setIntro(event.target.value)}
            rows={3}
            aria-invalid={fieldProps("intro")["aria-invalid"]}
            aria-describedby={fieldProps("intro")["aria-describedby"]}
            className={`w-full resize-y py-2 ${fieldProps("intro").className}`}
          />
        </AdminField>
      </div>

      {/* 头像：白名单 Mock 占位图，不能填任意地址 */}
      <AdminField
        label={COMPANION_PROFILE_FIELD_LABELS.avatarUrl}
        error={fieldProps("avatarUrl").message}
        errorId="companion-avatarUrl-error"
        hint="只能从平台提供的占位图里选"
      >
        <div
          role="radiogroup"
          tabIndex={-1}
          data-companion-field="avatarUrl"
          aria-label={COMPANION_PROFILE_FIELD_LABELS.avatarUrl}
          aria-invalid={fieldProps("avatarUrl")["aria-invalid"]}
          aria-describedby={fieldProps("avatarUrl")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {COMPANION_AVATAR_OPTIONS.map((option, index) => {
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

      {/* 游戏 */}
      <AdminField
        label={COMPANION_PROFILE_FIELD_LABELS.gameIds}
        error={fieldProps("gameIds").message}
        errorId="companion-gameIds-error"
      >
        {/* `aria-invalid` 放在每个勾选框上：`role="group"` 不支持这个属性，
            真正「无效」的是这一组控件本身；容器只负责用 `aria-describedby` 关联错误。 */}
        <div
          role="group"
          tabIndex={-1}
          data-companion-field="gameIds"
          aria-label={COMPANION_PROFILE_FIELD_LABELS.gameIds}
          aria-describedby={fieldProps("gameIds")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {games.map((game) => {
            const active = gameIds.includes(game.id);
            return (
              <label
                key={game.id}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] ${
                  active ? "border-admin-accent text-ink" : "border-admin-line text-ink-2"
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  aria-invalid={fieldProps("gameIds")["aria-invalid"]}
                  onChange={() => {
                    const next = active
                      ? gameIds.filter((id) => id !== game.id)
                      : [...gameIds, game.id];
                    setGameIds(next);
                    // 去掉的大区不再属于任何所选游戏：留着必然被服务端判为「不属于已选游戏」
                    const allowed = new Set(
                      games.filter((item) => next.includes(item.id)).flatMap((item) => item.regions),
                    );
                    setRegions((current) => current.filter((region) => allowed.has(region)));
                  }}
                />
                {game.name}
              </label>
            );
          })}
        </div>
      </AdminField>

      {/* 大区：只能从所选游戏的大区里选 */}
      <AdminField
        label={COMPANION_PROFILE_FIELD_LABELS.regions}
        error={fieldProps("regions").message}
        errorId="companion-regions-error"
        hint={
          gameIds.length === 0
            ? "先选择擅长游戏，大区只能从所选游戏里挑"
            : `可选大区来自：${games
                .filter((game) => gameIds.includes(game.id))
                .map((game) => game.name)
                .join("、")}`
        }
      >
        <div
          role="group"
          tabIndex={-1}
          data-companion-field="regions"
          aria-label={COMPANION_PROFILE_FIELD_LABELS.regions}
          aria-describedby={fieldProps("regions")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {regionOptions.length === 0 ? (
            <span className="text-[13px] text-ink-3">暂无可选大区</span>
          ) : (
            regionOptions.map((region) => {
              const active = regions.includes(region);
              return (
                <label
                  key={region}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] ${
                    active ? "border-admin-accent text-ink" : "border-admin-line text-ink-2"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    aria-invalid={fieldProps("regions")["aria-invalid"]}
                    onChange={() =>
                      setRegions((current) =>
                        active ? current.filter((item) => item !== region) : [...current, region],
                      )
                    }
                  />
                  {region}
                </label>
              );
            })
          )}
        </div>
      </AdminField>

      {/* 服务标签 */}
      <AdminField
        label={COMPANION_PROFILE_FIELD_LABELS.serviceTags}
        error={fieldProps("serviceTags").message}
        errorId="companion-serviceTags-error"
      >
        <div
          role="group"
          tabIndex={-1}
          data-companion-field="serviceTags"
          aria-label={COMPANION_PROFILE_FIELD_LABELS.serviceTags}
          aria-describedby={fieldProps("serviceTags")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {COMPANION_SERVICE_TAGS.map((tag) => {
            const active = serviceTags.includes(tag);
            return (
              <label
                key={tag}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] ${
                  active ? "border-admin-accent text-ink" : "border-admin-line text-ink-2"
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  aria-invalid={fieldProps("serviceTags")["aria-invalid"]}
                  onChange={() =>
                    setServiceTags((current) =>
                      active ? current.filter((item) => item !== tag) : [...current, tag],
                    )
                  }
                />
                {tag}
              </label>
            );
          })}
        </div>
      </AdminField>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 启用状态 */}
        <AdminField label={COMPANION_PROFILE_FIELD_LABELS.enabled} hint="停用后用户端完全看不到这条资料">
          <div
            role="radiogroup"
            tabIndex={-1}
            data-companion-field="enabled"
            aria-label={COMPANION_PROFILE_FIELD_LABELS.enabled}
            className="flex gap-2"
          >
            <AdminToggleButton active={enabled} onClick={() => setEnabled(true)} label="启用" />
            <AdminToggleButton
              active={!enabled}
              onClick={() => {
                setEnabled(false);
                setAvailable(false);
              }}
              label="停用"
            />
          </div>
        </AdminField>

        {/* 可接单状态 */}
        <AdminField
          label={COMPANION_PROFILE_FIELD_LABELS.available}
          hint={enabled ? "暂停接单仍会出现在名单里，只是结算时不可选" : "停用状态下强制不可接单"}
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-companion-field="available"
            aria-label={COMPANION_PROFILE_FIELD_LABELS.available}
            className="flex gap-2"
          >
            <AdminToggleButton
              active={availableChecked}
              disabled={!enabled}
              onClick={() => setAvailable(true)}
              label="可接单"
            />
            <AdminToggleButton
              active={!availableChecked}
              disabled={!enabled}
              onClick={() => setAvailable(false)}
              label="暂停接单"
            />
          </div>
        </AdminField>

        {/* 展示排序 */}
        <AdminField
          label={COMPANION_PROFILE_FIELD_LABELS.sortOrder}
          error={fieldProps("sortOrder").message}
          errorId="companion-sortOrder-error"
          hint={`${COMPANION_SORT_ORDER_MIN} 到 ${COMPANION_SORT_ORDER_MAX}，越小越靠前`}
          htmlFor="companion-sortOrder"
        >
          <input
            id="companion-sortOrder"
            data-companion-field="sortOrder"
            value={sortOrder}
            inputMode="numeric"
            onChange={(event) => setSortOrder(event.target.value)}
            aria-invalid={fieldProps("sortOrder")["aria-invalid"]}
            aria-describedby={fieldProps("sortOrder")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("sortOrder").className}`}
          />
        </AdminField>
      </div>

      {/* 不可接单原因：只在「启用但不可接单」时必填 */}
      <AdminField
        label={COMPANION_PROFILE_FIELD_LABELS.unavailableReason}
        error={fieldProps("unavailableReason").message}
        errorId="companion-unavailableReason-error"
        hint={
          reasonRequired
            ? "当前不可接单，必须给出原因——用户端会看到这句话"
            : "可接单或已停用时不需要填写"
        }
        counter={<AdminCharacterCounter current={reasonCount} max={COMPANION_PROFILE_REASON_MAX_LENGTH} />}
        htmlFor="companion-unavailableReason"
      >
        <input
          id="companion-unavailableReason"
          data-companion-field="unavailableReason"
          value={unavailableReason}
          onChange={(event) => setUnavailableReason(event.target.value)}
          aria-invalid={fieldProps("unavailableReason")["aria-invalid"]}
          aria-describedby={fieldProps("unavailableReason")["aria-describedby"]}
          className={`h-9 w-full ${fieldProps("unavailableReason").className}`}
        />
      </AdminField>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy ? "保存中…" : ADMIN_COMPANION_ACTION_LABELS.save}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          统计、关联用户与来源申请不在这里，它们由系统维护。
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
        title={`${enabled ? "启用" : "停用"}这条护航`}
        description={enabled ? ADMIN_COMPANION_CONFIRM_TEXTS.enable : ADMIN_COMPANION_CONFIRM_TEXTS.disable}
        confirmLabel={`确认${enabled ? "启用" : "停用"}`}
        tone={enabled ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key) void save(key);
        }}
        onCancel={() => {
          if (busy) return;
          keyRef.current = null;
          setConfirming(false);
          setConfirmError(null);
        }}
      />
    </form>
  );
}
