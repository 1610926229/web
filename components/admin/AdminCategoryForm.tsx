"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  ADMIN_CATEGORY_ACTION_LABELS,
  ADMIN_CATEGORY_CONFIRM_TEXTS,
  ADMIN_CATEGORY_EDIT_TITLE,
  ADMIN_CATEGORY_NEW_TITLE,
  CATEGORY_DUPLICATE_NAME_MESSAGE,
  CATEGORY_FIELD_LABELS,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_NAME_TOO_LONG_MESSAGE,
  CATEGORY_SORT_ORDER_MAX,
  CATEGORY_SORT_ORDER_MIN,
  categoryProfileFieldErrors,
  firstCategoryProfileErrorField,
  hasCategoryProfileError,
  normalizeCategoryProfilePatch,
  type CategoryGameOption,
  type CategoryProfileField,
  type CategoryProfileFieldErrors,
  type CategoryProfileInput,
} from "@/lib/constants/adminCategories";
import { createCategory, saveCategoryProfile } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { AdminCategoryListItem, AdminCategoryWriteResult } from "@/lib/types/catalog";

/**
 * 类目表单 —— 新建与编辑共用一份。
 *
 * 能改的字段就是下面四个：所属游戏、名称、展示排序、启用状态。
 * `id`、`createdAt`、`updatedAt`、`removedAt` **在界面上没有输入框、
 * 在接口入参里也没有位置**：一次普通保存永远无法把一条已移除的类目改回未移除，
 * 也永远无法伪造归属或时间（§九）。
 *
 * 三条与其它管理端表单一致的做法：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红，
 *    由校验给出明确错误。截断会让人以为「我已经写完了」。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去——顺序与服务端的校验顺序一致。
 * 3. **校验与服务端共用同一份函数**（`categoryProfileFieldErrors()` /
 *    `normalizeCategoryProfilePatch()`），因此不会出现「前端说能提交、服务端却拒绝」。
 *
 * ⚠️ 重名**不在这里判**：重名要跟同游戏下的其它类目比，而客户端手上那份列表可能已经过期。
 * 服务端拒绝时返回的正是 `CATEGORY_DUPLICATE_NAME_MESSAGE`，这里把它映射到**名称字段**上，
 * 于是「重名」与「名称为空」看起来是同一种错误，位置也一样。
 *
 * ⚠️ 改启用状态要二次确认：停用会让这一类目从用户端导航里消失，
 * 并且不能再用于商品归属。
 */
export default function AdminCategoryForm({
  record,
  games,
  message,
  onSaved,
}: {
  /**
   * 编辑时的原始记录；**新建时显式传 `null`**。
   *
   * 用「有没有记录」代替一个额外的 `mode` 字段：两个 prop 表达同一件事，
   * 就有它们互相矛盾的可能（`mode: "create"` + 一条真实记录），
   * 而那种矛盾只会在运行时暴露。
   */
  record: AdminCategoryListItem | null;
  games: CategoryGameOption[];
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (result: AdminCategoryWriteResult, message: string) => void;
}) {
  const isCreate = record === null;

  const [gameId, setGameId] = useState(record?.gameId ?? "");
  const [name, setName] = useState(record?.name ?? "");
  const [sortOrder, setSortOrder] = useState(
    record ? String(record.sortOrder) : String(CATEGORY_SORT_ORDER_MIN),
  );
  const [enabled, setEnabled] = useState(record?.enabled ?? true);

  const [errors, setErrors] = useState<CategoryProfileFieldErrors | null>(null);
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
   * 表单里每个字段都带 `data-category-field`；`role="radiogroup"` 的容器
   * 还要 `tabIndex={-1}` 才真的接得住焦点（div 默认不可聚焦）。
   */
  function focusField(field: CategoryProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-category-field="${field}"]`)?.focus();
  }

  const nameCount = countCharacters(name.trim());

  function currentInput(): CategoryProfileInput {
    const parsed = Number(sortOrder.trim());
    return {
      gameId,
      name,
      // 空串与非数字都变成 NaN：校验会给出「展示排序只能是…」，
      // 而不是静默当成 0 写进去
      sortOrder: sortOrder.trim() === "" ? Number.NaN : parsed,
      enabled,
    };
  }

  async function save(key: string) {
    const patch = normalizeCategoryProfilePatch(currentInput(), games);
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      const result =
        record === null
          ? await createCategory(key, patch)
          : await saveCategoryProfile(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);

      if (record === null) {
        onSaved(result, "已创建，用户端分类导航立即生效");
        return;
      }
      onSaved(result, result.changed ? "已保存，用户端分类导航立即生效" : "没有需要保存的改动");
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "保存失败，请稍后重试。";
      // 确认框开着时错误显示在框里，否则显示在表单底部
      if (confirming) setConfirmError(text);
      else setSubmitError(text);

      // 服务端的重名拒绝落到**名称字段**上，与本地校验的错误长得一样、位置也一样。
      // ⚠️ 只在确认框没开时这么做：确认框开着说明这次提交的是启用/停用，
      // 把焦点移到框后面的输入框上，人只会觉得「点了没反应」
      if (!confirming && text === CATEGORY_DUPLICATE_NAME_MESSAGE) {
        setErrors({ gameId: null, name: text, sortOrder: null, enabled: null });
        focusField("name");
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = categoryProfileFieldErrors(currentInput(), games);
    setErrors(next);
    setSubmitError(null);

    if (hasCategoryProfileError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstCategoryProfileErrorField(next));
      return;
    }

    keyRef.current = crypto.randomUUID();

    // 新建时「启用」是默认值，不是一个变更；只有编辑时改了启用状态才需要二次确认
    if (record !== null && enabled !== record.enabled) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void save(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: CategoryProfileField) {
    const message = errors?.[field] ?? null;
    return {
      id: `category-${field}`,
      "aria-invalid": message ? true : undefined,
      "aria-describedby": message ? `category-${field}-error` : undefined,
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
        <h2 className="text-[15px] font-medium text-ink">
          {isCreate ? ADMIN_CATEGORY_NEW_TITLE : ADMIN_CATEGORY_EDIT_TITLE}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          保存后会立即反映到用户端的分类导航与商品归属——两处读的是同一份数据。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 所属游戏：必须是真实存在的游戏，下拉里的选项由服务端给出 */}
        <AdminField
          label={CATEGORY_FIELD_LABELS.gameId}
          error={fieldProps("gameId").message}
          errorId="category-gameId-error"
          hint="类目必须挂在一个真实存在的游戏下"
          htmlFor="category-gameId"
        >
          <select
            id="category-gameId"
            data-category-field="gameId"
            value={gameId}
            onChange={(event) => setGameId(event.target.value)}
            aria-invalid={fieldProps("gameId")["aria-invalid"]}
            aria-describedby={fieldProps("gameId")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("gameId").className}`}
          >
            <option value="">请选择游戏</option>
            {games.map((game) => (
              <option key={game.id} value={game.id}>
                {game.name}
              </option>
            ))}
          </select>
        </AdminField>

        {/* 类目名称 */}
        <AdminField
          label={CATEGORY_FIELD_LABELS.name}
          error={fieldProps("name").message}
          errorId="category-name-error"
          counter={<AdminCharacterCounter current={nameCount} max={CATEGORY_NAME_MAX_LENGTH} />}
          htmlFor="category-name"
        >
          <input
            id="category-name"
            data-category-field="name"
            value={name}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              // 边写边说：超限立刻标红。服务端的重名错误在下次提交时才会替换掉它
              if (countCharacters(value.trim()) > CATEGORY_NAME_MAX_LENGTH) {
                setErrors((current) =>
                  current ? { ...current, name: CATEGORY_NAME_TOO_LONG_MESSAGE } : current,
                );
              }
            }}
            aria-invalid={fieldProps("name")["aria-invalid"]}
            aria-describedby={fieldProps("name")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("name").className}`}
          />
        </AdminField>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 展示排序 */}
        <AdminField
          label={CATEGORY_FIELD_LABELS.sortOrder}
          error={fieldProps("sortOrder").message}
          errorId="category-sortOrder-error"
          hint={`${CATEGORY_SORT_ORDER_MIN} 到 ${CATEGORY_SORT_ORDER_MAX}，越小越靠前`}
          htmlFor="category-sortOrder"
        >
          <input
            id="category-sortOrder"
            data-category-field="sortOrder"
            value={sortOrder}
            inputMode="numeric"
            onChange={(event) => setSortOrder(event.target.value)}
            aria-invalid={fieldProps("sortOrder")["aria-invalid"]}
            aria-describedby={fieldProps("sortOrder")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("sortOrder").className}`}
          />
        </AdminField>

        {/* 启用状态 */}
        <AdminField
          label={CATEGORY_FIELD_LABELS.enabled}
          hint="停用后用户端导航里没有它，也不能再用于商品归属"
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-category-field="enabled"
            aria-label={CATEGORY_FIELD_LABELS.enabled}
            className="flex gap-2"
          >
            <AdminToggleButton active={enabled} onClick={() => setEnabled(true)} label="启用" />
            <AdminToggleButton active={!enabled} onClick={() => setEnabled(false)} label="停用" />
          </div>
        </AdminField>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy
            ? "保存中…"
            : isCreate
              ? ADMIN_CATEGORY_ACTION_LABELS.create
              : ADMIN_CATEGORY_ACTION_LABELS.save}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          移除类目是另一个动作，在详情页里——它不能被一次普通保存顺带触发。
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
        title={`${enabled ? "启用" : "停用"}这条类目`}
        description={enabled ? ADMIN_CATEGORY_CONFIRM_TEXTS.enable : ADMIN_CATEGORY_CONFIRM_TEXTS.disable}
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
