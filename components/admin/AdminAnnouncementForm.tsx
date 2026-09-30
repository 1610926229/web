"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  CONTENT_ALT_MAX_LENGTH,
  CONTENT_IMAGE_FIELD_LABELS,
  CONTENT_SORT_ORDER_MAX,
  CONTENT_SORT_ORDER_MIN,
  CONTENT_TITLE_MAX_LENGTH,
  contentImageFieldErrors,
  firstContentImageErrorField,
  hasContentImageError,
  type ContentImageField,
  type ContentImageFieldErrors,
  type ContentImageInput,
} from "@/lib/constants/adminContent";
import type { AdminAnnouncementProfilePatch } from "@/lib/types/content";
import type { AdminContentWriteAck } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { ImageMaterialRow } from "@/components/admin/AdminAnnouncementTable";

/**
 * 图片公告的编辑 / 新建表单。
 *
 * ⚠️ 真正的实现在同目录的 `AdminAnnouncementForm.tsx` 导出的 `ImageMaterialForm`：
 * 公告与活动 Banner 的字段完全相同（见 `lib/constants/adminContent.ts`）。
 * Banner 的这一份只绑定它自己的服务函数与文案。
 *
 * 三条与其它管理端表单一致的做法（与 `AdminCategoryForm` 同源）：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红。
 *    截断会让人以为「我已经写完了」，而真相是后面那半句根本没进去。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去——顺序与服务端一致。
 * 3. **校验与服务端共用同一份函数**（`contentImageFieldErrors()` /
 *    `normalize*ProfilePatch()`），因此不会出现「前端说能提交、服务端却拒绝」。
 */

/** 表单要绑的服务函数。公告与 Banner 各有一组，形状相同。 */
export type ImageMaterialBinding = {
  /** DOM id 前缀（`announcement` / `banner`），避免同页两组控件撞车 */
  slug: string;
  /** 校验通过后的 patch 构造。两个模块各有一个函数，规则是同一份。 */
  normalize: (input: ContentImageInput) => AdminAnnouncementProfilePatch | null;
  create: (
    idempotencyKey: string,
    patch: AdminAnnouncementProfilePatch,
  ) => Promise<AdminContentWriteAck>;
  save: (
    id: string,
    idempotencyKey: string,
    patch: AdminAnnouncementProfilePatch,
  ) => Promise<AdminContentWriteAck>;
};

export type ImageMaterialFormCopy = {
  createTitle: string;
  editTitle: string;
  /** 表单顶部：这一组内容在用户端是怎么用的 */
  usageNotice: string;
  createdMessage: string;
  savedMessage: string;
  /** 一个字段都没改时的提示。**不能显示成「保存成功」** */
  unchangedMessage: string;
  /** 重试命中第一次写入时的提示。同样**不能**显示成「又保存了一次」 */
  replayedMessage: string;
};

/**
 * 服务端回执 → 给用户看的那句话。
 *
 * ⚠️ 四句话必须分开，因为它们是四件不同的事：
 *
 * - `replayed`：这个幂等键早就做过了，服务端**没有**第二次写入（重试命中第一次的结果）；
 * - `changed: false`：提交的内容与现状一模一样，同样什么都没写；
 * - 其余两种情况才是真的写进去了（新建 / 编辑）。
 *
 * 把前两种显示成「已保存」是**误导**：人会以为自己刚才的改动生效了，
 * 而实际上他什么都没改——真正的改动人可能是另一位管理员，列表里那一行也还是他的值。
 * 判断依据是**服务端的回执**而不是客户端的比较：本地那份 `record` 可能是几分钟前的快照，
 * 拿它比出来的「没改」与「服务端没写」不是同一件事。
 */
function describeImageWrite(
  ack: AdminContentWriteAck,
  created: boolean,
  copy: ImageMaterialFormCopy,
): string {
  if (ack.replayed) return copy.replayedMessage;
  if (!ack.changed) return copy.unchangedMessage;
  return created ? copy.createdMessage : copy.savedMessage;
}

/**
 * 图片地址的即时说明。
 *
 * 三张占位图是仓库里真实存在的文件（`public/mock/`），把路径直接写出来，
 * 运营不必去翻代码或问开发。最后一句是**边界**：本阶段不做上传、不接外链
 * （`validateSafePath()` 会直接拒绝外域地址），说出来比让人试一次再被拒绝好。
 */
const IMAGE_URL_HINT =
  "可用占位图：/mock/announcement-1.svg、/mock/announcement-2.svg、/mock/promo-activity.svg。" +
  "本阶段只支持站内路径（以 / 开头），不支持外链与图片上传。";

export type ImageMaterialFormProps = {
  /**
   * 编辑时的原始记录；**新建时显式传 `null`**。
   *
   * 用「有没有记录」代替一个额外的 `mode` 字段：两个 prop 表达同一件事，
   * 就有它们互相矛盾的可能，而那种矛盾只会在运行时暴露（与 `AdminCategoryForm` 同）。
   */
  record: ImageMaterialRow | null;
  binding: ImageMaterialBinding;
  copy: ImageMaterialFormCopy;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (message: string) => void;
  /** 收起表单。新建时取消等于什么都不做；编辑时取消等于放弃这次改动 */
  onCancel: () => void;
};

export function ImageMaterialForm({
  record,
  binding,
  copy,
  message,
  onSaved,
  onCancel,
}: ImageMaterialFormProps) {
  const isCreate = record === null;

  const [title, setTitle] = useState(record?.title ?? "");
  const [imageUrl, setImageUrl] = useState(record?.imageUrl ?? "");
  const [alt, setAlt] = useState(record?.alt ?? "");
  const [sortOrder, setSortOrder] = useState(
    record ? String(record.sortOrder) : String(CONTENT_SORT_ORDER_MIN),
  );
  const [enabled, setEnabled] = useState(record?.enabled ?? true);

  const [errors, setErrors] = useState<ContentImageFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  /** 幂等键：**一次「提交意图」一个键**。提交前不动它，改动输入即作废 */
  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const fieldId = (field: ContentImageField) => `${binding.slug}-${field}`;

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * 一次 DOM 查询而不是「每字段一个 ref 回调」：后者等于在渲染期改 ref，
   * React 明确不允许。字段靠 `data-material-field` 定位。
   */
  function focusField(field: ContentImageField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-material-field="${field}"]`)?.focus();
  }

  /** 任何输入变化都作废当前的幂等键：下一次提交是新的一次意图 */
  function invalidateKey() {
    keyRef.current = null;
  }

  function currentInput(): ContentImageInput {
    const parsed = Number(sortOrder.trim());
    return {
      title,
      imageUrl,
      alt,
      // 空串与非数字都变成 NaN：校验会给出「排序值必须是…」，
      // 而不是静默当成 0 写进去
      sortOrder: sortOrder.trim() === "" ? Number.NaN : parsed,
      enabled,
    };
  }

  async function save(key: string) {
    const patch = binding.normalize(currentInput());
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      // ⚠️ 「这次到底写没写」由**服务端说了算**（`changed` / `replayed`），
      // 客户端不拿手上那份快照自己比——那比出来的是「与几分钟前的记录相同」，
      // 不是「服务端没有写」。响应里确认后的那条记录刻意不接：页面显示的那一行
      // 由父组件**重新取一份列表**决定，读响应拼一行出来会和真实记录分叉
      const ack =
        record === null
          ? await binding.create(key, patch)
          : await binding.save(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);
      onSaved(describeImageWrite(ack, record === null, copy));
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

    const next = contentImageFieldErrors(currentInput());
    setErrors(next);
    setSubmitError(null);

    if (hasContentImageError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstContentImageErrorField(next));
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

    void save(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: ContentImageField) {
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
          {isCreate ? copy.createTitle : copy.editTitle}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{copy.usageNotice}</p>
        {!isCreate ? (
          <p className="mt-1 font-mono text-[12px] text-ink-3">{record.id}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={CONTENT_IMAGE_FIELD_LABELS.title}
          error={fieldProps("title").error}
          errorId={fieldProps("title").errorId}
          hint="仅后台可见，用来在列表里认出这张素材；用户端不显示这段文字"
          counter={<AdminCharacterCounter current={countCharacters(title.trim())} max={CONTENT_TITLE_MAX_LENGTH} />}
          htmlFor={fieldId("title")}
        >
          <input
            id={fieldId("title")}
            data-material-field="title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              invalidateKey();
            }}
            aria-invalid={fieldProps("title").error ? true : undefined}
            aria-describedby={fieldProps("title").error ? fieldProps("title").errorId : undefined}
            className={`h-9 w-full ${fieldProps("title").className}`}
          />
        </AdminField>

        <AdminField
          label={CONTENT_IMAGE_FIELD_LABELS.imageUrl}
          error={fieldProps("imageUrl").error}
          errorId={fieldProps("imageUrl").errorId}
          hint={IMAGE_URL_HINT}
          htmlFor={fieldId("imageUrl")}
        >
          <input
            id={fieldId("imageUrl")}
            data-material-field="imageUrl"
            value={imageUrl}
            onChange={(event) => {
              setImageUrl(event.target.value);
              invalidateKey();
            }}
            aria-invalid={fieldProps("imageUrl").error ? true : undefined}
            aria-describedby={
              fieldProps("imageUrl").error ? fieldProps("imageUrl").errorId : undefined
            }
            className={`h-9 w-full ${fieldProps("imageUrl").className}`}
          />
        </AdminField>
      </div>

      <AdminField
        label={CONTENT_IMAGE_FIELD_LABELS.alt}
        error={fieldProps("alt").error}
        errorId={fieldProps("alt").errorId}
        hint="读屏软件会把这句话念出来，写清楚这张图在说什么；它不出现在页面上"
        counter={<AdminCharacterCounter current={countCharacters(alt.trim())} max={CONTENT_ALT_MAX_LENGTH} />}
        htmlFor={fieldId("alt")}
      >
        <input
          id={fieldId("alt")}
          data-material-field="alt"
          value={alt}
          onChange={(event) => {
            setAlt(event.target.value);
            invalidateKey();
          }}
          aria-invalid={fieldProps("alt").error ? true : undefined}
          aria-describedby={fieldProps("alt").error ? fieldProps("alt").errorId : undefined}
          className={`h-9 w-full ${fieldProps("alt").className}`}
        />
      </AdminField>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={CONTENT_IMAGE_FIELD_LABELS.sortOrder}
          error={fieldProps("sortOrder").error}
          errorId={fieldProps("sortOrder").errorId}
          hint={`${CONTENT_SORT_ORDER_MIN} 到 ${CONTENT_SORT_ORDER_MAX}，越小越靠前`}
          htmlFor={fieldId("sortOrder")}
        >
          <input
            id={fieldId("sortOrder")}
            data-material-field="sortOrder"
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
          label={CONTENT_IMAGE_FIELD_LABELS.enabled}
          hint={
            enabled
              ? "用户端可以看到这张图"
              : "用户端看不到这张图；记录与图片都保留，随时可以重新启用"
          }
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-material-field="enabled"
            aria-label={CONTENT_IMAGE_FIELD_LABELS.enabled}
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
        title={`${enabled ? "启用" : "停用"}这张素材`}
        description={
          enabled
            ? "启用后用户端立即可以看到它；如果它是活动 Banner 且排序最靠前，用户端首页那张活动图会当场换成它。"
            : "停用后用户端立即看不到它；如果它是活动 Banner 且本来排在第一位，用户端首页的活动图会换成排序最前的另一张启用图——一张都没有时活动位会整个消失。"
        }
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
          // 取消这次改变启用状态的意图：键作废，下次提交是新的一次
          invalidateKey();
          setConfirming(false);
          setConfirmError(null);
        }}
      />
    </form>
  );
}

/** 公告表单自己的四句话：每一句都落在「用户端会怎么变」上。 */
export const ANNOUNCEMENT_FORM_COPY: ImageMaterialFormCopy = {
  createTitle: "新增公告",
  editTitle: "编辑公告",
  usageNotice:
    "公告在用户端是首页顶部自动轮播的图片，**只展示、不响应点击**——" +
    "它没有目标地址可填，也不要指望用户能点进去。排序值决定它在轮播里的位置。",
  createdMessage: "已新增。用户端下一次刷新就会轮播到它",
  savedMessage: "已保存。用户端下一次刷新就是新素材",
  unchangedMessage: "内容没有变化，未写入。列表里显示的就是服务端当前的记录",
  replayedMessage: "这次提交与刚才那次是同一次操作，服务端没有重复写入；用户端看到的就是刚才那次的结果",
};

/**
 * 公告表单的**注入形状**：调用方只给记录、结果回执与取消动作，
 * 四句文案由各模块自己补——它们说的是用户端会怎么变，只有模块自己知道。
 */
export type ImageMaterialFormBodyProps = Omit<ImageMaterialFormProps, "copy">;

/** 公告表单：把公告自己的四句文案绑上去（实现只有一份，理由见文件头）。 */
export default function AdminAnnouncementForm(props: ImageMaterialFormBodyProps) {
  return <ImageMaterialForm {...props} copy={ANNOUNCEMENT_FORM_COPY} />;
}
