"use client";

import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import { AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  PRODUCT_FIELD_LABELS,
  PRODUCT_SPEC_TOO_MANY_MESSAGE,
  SPEC_MAX_COUNT,
  SPEC_NAME_MAX_LENGTH,
  type ProductSpecRowErrors,
} from "@/lib/constants/adminProducts";
import { countCharacters } from "@/lib/utils/text";
import type { ProductSpecInput, ProductSpecRecord } from "@/lib/types/product";

/**
 * 表单里的一行规格。
 *
 * ⚠️ `key` 是**行标识**，与规格实体的 `id` 分开：
 * - 已有规格的行，`key` 就是它的 `id`（稳定身份，实体永远不重新签发 id）；
 * - 还没保存过的新行没有 id，`key` 是一个本地随机串。
 *
 * 两者分开是必须的：React 的 `key` 只能是本地概念（新行在保存前没有身份），
 * 而实体的 `id` 必须跨越保存保持稳定。用下标当 `key` 会让「删掉中间一行」
 * 把后面所有行的输入框内容错位——这也是**规格身份绝不用下标**的同一个道理。
 */
export type AdminSpecRow = {
  key: string;
  id: string;
  name: string;
  priceYuan: string;
  sortOrder: string;
  enabled: boolean;
  removed: boolean;
};

/** 实体规格 → 表单行。价格在这里从**整数分**回到「元」文本，只用于显示与编辑。 */
export function toAdminSpecRow(spec: ProductSpecRecord): AdminSpecRow {
  return {
    key: spec.id,
    id: spec.id,
    name: spec.name,
    priceYuan: (spec.price / 100).toFixed(2),
    sortOrder: String(spec.sortOrder),
    enabled: spec.enabled,
    removed: spec.removedAt !== null,
  };
}

/** 新增一行：**没有 id**，由服务端在保存时签发。 */
export function createAdminSpecRow(nextSortOrder: number): AdminSpecRow {
  return {
    key: crypto.randomUUID(),
    id: "",
    name: "",
    priceYuan: "",
    sortOrder: String(nextSortOrder),
    enabled: true,
    removed: false,
  };
}

/**
 * 表单行 → 校验与提交用的入参。
 *
 * 空串与非数字都变成 `NaN`，让校验给出「排序只能是整数」而不是静默当成 0；
 * 价格保持**元字符串**原样，`normalizeProductProfilePatch()` 也只去空白，
 * 转整数分由服务端（`toProductDraft()`）完成——
 * 这一层不做任何金额运算，浮点因此不可能从这里进来。
 */
export function toProductSpecInput(row: AdminSpecRow): ProductSpecInput {
  const sortOrder = Number(row.sortOrder.trim());
  return {
    id: row.id,
    name: row.name,
    priceYuan: row.priceYuan,
    sortOrder: row.sortOrder.trim() === "" ? Number.NaN : sortOrder,
    enabled: row.enabled,
    removed: row.removed,
  };
}

/**
 * 单组规格编辑器（单选，不是组合 SKU）。
 *
 * 三条规则在界面上是可见的，而不是等到提交才被拒绝：
 * 1. **价格输入的是元**（`29.90`），服务端严格转成整数分；界面上不出现「分」，
 *    也不做任何金额计算。
 * 2. **移除是软删除**：勾掉的行保留在表单里、标成「已移除」，保存前还能撤销。
 *    规格**从不被物理删除**——订单快照里记着它的 id。还没保存过的新行
 *    （`id` 为空）是例外：它还不是实体，直接删掉这一行不产生任何历史问题。
 * 3. **已上架商品的最后一个有效规格不能被停用或移除**：这里只标红，
 *    真正的拒绝在服务端原子区段里（§原子性）。
 *
 * ⚠️ 不用 HTML `maxLength` 静默截断：名称可以一直输入，字数实时显示、超限变红。
 */
export default function AdminSpecEditor({
  rows,
  errors,
  groupError,
  disabled,
  onChange,
}: {
  rows: AdminSpecRow[];
  /** 与 `rows` 一一对应的逐行错误 */
  errors: ProductSpecRowErrors;
  /** 规格组整体的错误（空、超条数、重名、在架却没有有效规格） */
  groupError: string | null;
  /** 整份表单正在提交时禁用输入，避免提交中途改出「发出的和看到的不一致」 */
  disabled: boolean;
  onChange: (rows: AdminSpecRow[]) => void;
}) {
  function patchRow(key: string, patch: Partial<AdminSpecRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  const effectiveCount = rows.filter((row) => row.enabled && !row.removed).length;
  // 下一个排序值：取已用最大值 +1，让人加的行落在最后一行的下面而不是挤在中间
  const nextSortOrder =
    rows.reduce((max, row) => {
      const value = Number(row.sortOrder.trim());
      return Number.isInteger(value) && value > max ? value : max;
    }, 0) + 1;

  return (
    /*
     * `data-product-field="specs"` 与 `tabIndex={-1}` 是给商品表单的「第一条错误自动聚焦」
     * 用的：规格的整组错误（一条都没有 / 超条数 / 在架却没有有效规格）没有单独的输入框，
     * 焦点只能落在这一整块上。少了 `tabIndex`，`focus()` 会静默失败——
     * 表现就是「点了保存，什么都没发生，也没滚动到出问题的地方」。
     */
    <div
      data-product-field="specs"
      tabIndex={-1}
      aria-label={PRODUCT_FIELD_LABELS.specs}
      aria-describedby={groupError ? "product-specs-error" : undefined}
      className="flex flex-col gap-2 outline-none"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-ink-2">{PRODUCT_FIELD_LABELS.specs}</span>
        <span className="text-[12px] text-ink-3">
          有效 {effectiveCount} 条 / 共 {rows.length} 条
        </span>
      </div>

      <p className="text-[12px] leading-4 text-ink-3">
        单组规格、单一选择：用户下单时只能选其中一条。价格填写的是元（如 29.90），
        保存时由服务端转成整数分；改价只影响之后的试算与支付，历史订单读的是下单快照。
      </p>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-admin-line px-3 py-4 text-center text-[13px] text-ink-3">
          还没有规格。上架的商品至少要有一条启用且未移除的规格。
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const error = errors[index] ?? { name: null, price: null, sortOrder: null };
          const invalid =
            error.name !== null || error.price !== null || error.sortOrder !== null;

          return (
            <li
              key={row.key}
              className={`flex flex-col gap-3 rounded-lg border p-3 ${
                row.removed ? "border-admin-line bg-page" : "border-admin-line bg-surface"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-ink-3">
                  第 {index + 1} 条
                  {row.id ? (
                    <span className="ml-2 font-mono">{row.id}</span>
                  ) : (
                    <span className="ml-2">（还没保存，保存后由服务端签发 id）</span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {row.removed ? (
                    <span className="text-[12px] font-medium text-status-muted">已移除</span>
                  ) : (
                    <span
                      className={`text-[12px] ${row.enabled ? "text-status-success" : "text-status-danger"}`}
                    >
                      {row.enabled ? "已启用" : "已停用"}
                    </span>
                  )}

                  <AdminToggleButton
                    active={row.enabled && !row.removed}
                    disabled={disabled || row.removed}
                    label="启用"
                    onClick={() => patchRow(row.key, { enabled: true })}
                  />
                  <AdminToggleButton
                    active={!row.enabled && !row.removed}
                    disabled={disabled || row.removed}
                    label="停用"
                    onClick={() => patchRow(row.key, { enabled: false })}
                  />

                  {row.id ? (
                    // 已有规格：移除是**软删除**，保存后才生效，且可以撤销
                    <AdminToggleButton
                      active={row.removed}
                      disabled={disabled}
                      label={row.removed ? "撤销移除" : "移除"}
                      onClick={() => patchRow(row.key, { removed: !row.removed })}
                    />
                  ) : (
                    // 还没保存过的行不是实体，直接从这里删掉即可——它没有 id，
                    // 也不会有任何订单快照引用它
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
                      className="rounded-lg border border-admin-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface disabled:opacity-40"
                    >
                      删除这一行
                    </button>
                  )}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {/* 规格名称 */}
                <label className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2 text-[12px] text-ink-3">
                    <span>规格名称</span>
                    <AdminCharacterCounter
                      current={countCharacters(row.name.trim())}
                      max={SPEC_NAME_MAX_LENGTH}
                    />
                  </span>
                  <input
                    value={row.name}
                    disabled={disabled}
                    onChange={(event) =>
                      patchRow(row.key, { name: event.target.value })
                    }
                    aria-label={`第 ${index + 1} 条规格名称`}
                    aria-invalid={error.name ? true : undefined}
                    aria-describedby={error.name ? `spec-${row.key}-name-error` : undefined}
                    className={`h-9 rounded-lg border px-3 text-[13px] text-ink outline-none ${
                      error.name ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
                    }`}
                  />
                  {error.name ? (
                    <span
                      id={`spec-${row.key}-name-error`}
                      role="alert"
                      className="text-[12px] leading-4 text-brand-red"
                    >
                      {error.name}
                    </span>
                  ) : null}
                </label>

                {/* 价格（元） */}
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-ink-3">单价（元）</span>
                  <input
                    value={row.priceYuan}
                    disabled={disabled}
                    inputMode="decimal"
                    onChange={(event) => patchRow(row.key, { priceYuan: event.target.value })}
                    aria-label={`第 ${index + 1} 条规格单价，单位元`}
                    aria-invalid={error.price ? true : undefined}
                    aria-describedby={error.price ? `spec-${row.key}-price-error` : undefined}
                    className={`h-9 rounded-lg border px-3 text-[13px] tabular-nums text-ink outline-none ${
                      error.price ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
                    }`}
                  />
                  {error.price ? (
                    <span
                      id={`spec-${row.key}-price-error`}
                      role="alert"
                      className="text-[12px] leading-4 text-brand-red"
                    >
                      {error.price}
                    </span>
                  ) : null}
                </label>

                {/* 组内排序：与商品级的「展示排序」不是一回事，只影响这条规格在组内的位置 */}
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] text-ink-3">组内排序（越小越靠前）</span>
                  <input
                    value={row.sortOrder}
                    disabled={disabled}
                    inputMode="numeric"
                    onChange={(event) => patchRow(row.key, { sortOrder: event.target.value })}
                    aria-label={`第 ${index + 1} 条规格排序`}
                    aria-invalid={error.sortOrder ? true : undefined}
                    aria-describedby={
                      error.sortOrder ? `spec-${row.key}-sortOrder-error` : undefined
                    }
                    className={`h-9 rounded-lg border px-3 text-[13px] tabular-nums text-ink outline-none ${
                      error.sortOrder
                        ? "border-status-danger"
                        : "border-admin-line focus:border-admin-accent"
                    }`}
                  />
                  {error.sortOrder ? (
                    <span
                      id={`spec-${row.key}-sortOrder-error`}
                      role="alert"
                      className="text-[12px] leading-4 text-brand-red"
                    >
                      {error.sortOrder}
                    </span>
                  ) : null}
                </label>
              </div>

              {invalid ? null : row.removed ? (
                <p className="text-[12px] leading-4 text-ink-3">
                  保存后这条规格不再可选，记录保留——历史订单的快照里记着它的 id。
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || rows.length >= SPEC_MAX_COUNT}
          onClick={() => onChange([...rows, createAdminSpecRow(nextSortOrder)])}
          className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
        >
          添加规格
        </button>
        {rows.length >= SPEC_MAX_COUNT ? (
          <span className="text-[12px] text-brand-red">{PRODUCT_SPEC_TOO_MANY_MESSAGE}</span>
        ) : null}
      </div>

      {groupError ? (
        <p id="product-specs-error" role="alert" className="text-[12px] leading-4 text-brand-red">
          {groupError}
        </p>
      ) : null}

      <p className="text-[12px] leading-4 text-ink-3">
        同一条规格在保存前后是同一条：它的 id 由服务端签发，之后改价、改名、调序都只改字段。
        行序本身不代表任何含义——顺序由「组内排序」决定。
      </p>
    </div>
  );
}
