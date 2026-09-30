"use client";

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import {
  AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE,
  AGREEMENT_PARAGRAPH_MAX_LENGTH,
  AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT,
  AGREEMENT_PROFILE_FIELD_LABELS,
  AGREEMENT_SECTION_HEADING_MAX_LENGTH,
  AGREEMENT_SECTION_MAX_COUNT,
  AGREEMENT_TITLE_MAX_LENGTH,
  agreementProfileFieldErrors,
  containsMarkup,
  firstAgreementProfileErrorField,
  hasAgreementProfileError,
  normalizeAgreementProfilePatch,
  type AgreementProfileField,
  type AgreementProfileFieldErrors,
  type AgreementSectionInput,
} from "@/lib/constants/adminAgreements";
import { formatAgreementVersion } from "@/lib/constants/agreements";
import { saveAgreementProfile } from "@/lib/services/adminHttp";
import { countCharacters } from "@/lib/utils/text";
import type { AdminAgreementDetail } from "@/lib/types/agreement";

/**
 * 协议正文的编辑表单。
 *
 * ⚠️ **正文是结构化段落，不是 HTML 字符串**（`sections: { heading, paragraphs }[]`）。
 * 这不是「本阶段先这样」：页面按段落纯文本渲染，没有 sanitizer，因此一旦放行 HTML，
 * 就是直接把不受控内容送进用户端。因此：
 *
 * - 控件只有 `<input>` 与 `<textarea>`，**没有富文本编辑器、没有
 *   `dangerouslySetInnerHTML` / `innerHTML`**（§十一 的硬要求）；
 * - 校验直接用 `agreementProfileFieldErrors()`（与接口同一份），
 *   段落里出现 `<` 或 `>` 一律拒绝——**这里不重写这条规则**，
 *   只把它的结论显示出来（复制一份规则就等于给将来留一个不一致的分叉）；
 * - 提交前不做任何「顺手转义」：把 `<` 自动换成 `&lt;` 会让人以为自己写的标签
 *   生效了，而页面上显示的是转义后的原文。拒绝比悄悄改写更诚实。
 *
 * ⚠️ 保存后**版本号由服务端自动递增**（标题或正文真的变了才递增），
 * 因此表单不再自己算版本号、也不把版本号发给服务端：一次保存无法让版本号
 * 跳过一格，也无法让它退回去。
 *
 * ⚠️ 删除节与段落要二次确认，而且要说清「不可撤销」：删除本身是本地编辑，
 * 但**保存之后**后台没有任何「恢复上一版正文」的能力（审计快照只记
 * `sectionCount` / `paragraphCount`，不存正文），只能重新输入。
 */

export type AdminAgreementFormProps = {
  /** 必须带正文的详情：列表行里没有 `sections`，拿它拼出来的表单会是一个空正文 */
  record: AdminAgreementDetail;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (message: string) => void;
  onCancel: () => void;
};

/** 待确认的删除动作。删除的是**本地表单**里的内容，保存之后才不可撤销。 */
type PendingRemoval =
  | { kind: "section"; section: number }
  | { kind: "paragraph"; section: number; paragraph: number };

/**
 * 本地即时提示：`<` / `>` 是**唯一**能在提交前就断定会被服务端拒绝的输入
 * （空段落、超长都要等服务端那条统一的错误）。
 *
 * ⚠️ 用的判定函数就是服务端那一份（`containsMarkup()`），不是在这里再写一遍
 * 「像不像标签」的正则——那种写法对 `< p>`、`<script` 这类边角写法只能逐条猜。
 */
function markupIssue(value: string): string | null {
  return containsMarkup(value) ? AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE : null;
}

/** 服务端回执 → 给用户看的那句话（`AdminAgreementWriteResult` 只有 `changed`，没有 `replayed`）。 */
function describeAgreementWrite(
  changed: boolean,
  previousVersion: string,
  nextVersion: string,
): string {
  if (!changed) {
    // ⚠️ **不能**显示成「已保存」：服务端什么都没写，版本号与更新时间都没动
    return "内容没有变化，未写入。协议正文与版本号都没有变动，列表里显示的就是服务端当前的记录";
  }

  if (nextVersion !== previousVersion) {
    return `已保存。正文已更新，版本号自动递增为 ${formatAgreementVersion(nextVersion)}；用户端刷新即可看到新正文`;
  }

  // 只有启用状态变了：正文与标题一个字都没动，因此版本号**不动**——
  // 「停用再启用」不该让用户端看到一个从未存在过的新版本
  return `已保存。正文与标题没有变，版本号保持 ${formatAgreementVersion(nextVersion)}（这次只改了启用状态）`;
}

export default function AdminAgreementForm({
  record,
  message,
  onSaved,
  onCancel,
}: AdminAgreementFormProps) {
  const [title, setTitle] = useState(record.title);
  const [enabled, setEnabled] = useState(record.enabled);
  /**
   * 工作副本，**深拷贝**：直接引用 `record.sections` 会把 props 里的数组
   * 当成可变状态来改（React 不允许，而且父组件手上那份也会被改到）。
   */
  const [sections, setSections] = useState<AgreementSectionInput[]>(() =>
    record.sections.map((section) => ({ heading: section.heading, paragraphs: [...section.paragraphs] })),
  );

  const [errors, setErrors] = useState<AgreementProfileFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);

  /** 幂等键：**一次「提交意图」一个键**。改动任何输入都会作废它，见 `invalidateKey()` */
  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  /** 任何输入变化都作废当前的幂等键：下一次提交是新的一次意图（§九） */
  function invalidateKey() {
    keyRef.current = null;
  }

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * 一次 DOM 查询而不是「每字段一个 ref 回调」：后者等于在渲染期改 ref。
   * 「正文」这一位指向的是整块编辑区（容器带 `tabIndex={-1}`），
   * 因为正文的错误是一条整体判断（哪一节哪一段超长由服务端那条文案说明）。
   */
  function focusField(field: AgreementProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-agreement-field="${field}"]`)?.focus();
  }

  function currentInput() {
    return { title, sections, enabled };
  }

  /** 段落总数：与列表里的 `paragraphCount` 同一套口径，用于顶部的一句「正文有多长」。 */
  const paragraphTotal = sections.reduce((total, section) => total + section.paragraphs.length, 0);

  // ————————————————————— 编辑正文：全部走不可变更新 —————————————————————
  // 每次都换一个新数组/新对象，React 才认得出「这一节变了」；
  // 直接改 `section.heading = …` 界面上不一定重渲染，而且与服务端数据共享引用。

  function updateHeading(sectionIndex: number, value: string) {
    setSections((prev) =>
      prev.map((section, index) => (index === sectionIndex ? { ...section, heading: value } : section)),
    );
    invalidateKey();
  }

  function updateParagraph(sectionIndex: number, paragraphIndex: number, value: string) {
    setSections((prev) =>
      prev.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              paragraphs: section.paragraphs.map((paragraph, i) =>
                i === paragraphIndex ? value : paragraph,
              ),
            }
          : section,
      ),
    );
    invalidateKey();
  }

  /** 新加的一节给一段空正文：一节的段数下限就是 1，给 0 段等于一加出来就是错的。 */
  function addSection() {
    setSections((prev) => [...prev, { heading: "", paragraphs: [""] }]);
    invalidateKey();
  }

  function addParagraph(sectionIndex: number) {
    setSections((prev) =>
      prev.map((section, index) =>
        index === sectionIndex ? { ...section, paragraphs: [...section.paragraphs, ""] } : section,
      ),
    );
    invalidateKey();
  }

  function applyRemoval(pending: PendingRemoval) {
    if (pending.kind === "section") {
      setSections((prev) => prev.filter((_, index) => index !== pending.section));
    } else {
      setSections((prev) =>
        prev.map((section, index) =>
          index === pending.section
            ? {
                ...section,
                paragraphs: section.paragraphs.filter((_, i) => i !== pending.paragraph),
              }
            : section,
        ),
      );
    }

    invalidateKey();
  }

  // ——————————————————————————— 提交 ———————————————————————————

  async function submit(key: string) {
    const patch = normalizeAgreementProfilePatch(currentInput());
    if (!patch) {
      // 正常路径上不会到这里：提交前已经校验过。留一条兜底，避免把未校验的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      // ⚠️ 「这次到底写没写、版本号有没有变」由**服务端回执**说了算（`changed` + `version`）：
      // 本地那份 `record` 是打开表单时的快照，拿它比出来的只是「与那时相同」
      const result = await saveAgreementProfile(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);
      onSaved(describeAgreementWrite(result.changed, record.version, result.version));
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

    const next = agreementProfileFieldErrors(currentInput());
    setErrors(next);
    setSubmitError(null);

    if (hasAgreementProfileError(next)) {
      // 第一条出错的字段：错误顺序与服务端的校验顺序一致，因此「最靠上的那条」就是它
      focusField(firstAgreementProfileErrorField(next));
      return;
    }

    // 重试沿用同一个键：上一次点击已经把请求发出去了，换一个键就等于让服务端
    // 把它当成第二次写入（§九）。只有改了输入才会作废它
    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    // 启用状态是一个独立的状态迁移（服务端按它记 enable / disable），改了要确认
    if (enabled !== record.enabled) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void submit(keyRef.current);
  }

  /** 字段级的公共属性：错误 → `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: AgreementProfileField) {
    const error = errors?.[field] ?? null;
    return {
      error,
      errorId: `agreement-${field}-error`,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        error ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
    };
  }

  const headingAtCap = sections.length >= AGREEMENT_SECTION_MAX_COUNT;

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">
          编辑正文 · {record.typeLabel}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          用户端「相关协议」页读的就是这一份数据：
          <span className="text-ink-2">
            保存后版本号自动递增，用户端刷新即可看到新正文
          </span>
          。当前 {formatAgreementVersion(record.version)}，{sections.length} 节 /{" "}
          {paragraphTotal} 段。
        </p>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">{AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE}</p>
        <p className="mt-1 font-mono text-[12px] text-ink-3">{record.id}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={AGREEMENT_PROFILE_FIELD_LABELS.title}
          error={fieldProps("title").error}
          errorId={fieldProps("title").errorId}
          hint="显示在用户端协议页顶部的标题"
          counter={
            <AdminCharacterCounter
              current={countCharacters(title.trim())}
              max={AGREEMENT_TITLE_MAX_LENGTH}
            />
          }
          htmlFor="agreement-title"
        >
          <input
            id="agreement-title"
            data-agreement-field="title"
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
          label={AGREEMENT_PROFILE_FIELD_LABELS.enabled}
          hint={
            enabled
              ? "用户端「相关协议」页会显示这一份"
              : "用户端改为显示同类型里版本号最高的那份启用内容；正文与版本号都保留，随时可以重新启用"
          }
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-agreement-field="enabled"
            aria-label={AGREEMENT_PROFILE_FIELD_LABELS.enabled}
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

      {/* 正文编辑区：容器可聚焦，好让「第一条错误是正文」时焦点有地方落 */}
      <div
        data-agreement-field="sections"
        tabIndex={-1}
        className="flex flex-col gap-3 rounded-xl border border-admin-line p-3"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] text-ink-2">{AGREEMENT_PROFILE_FIELD_LABELS.sections}</h3>
          <span className="text-[12px] text-ink-3">
            共 {sections.length} 节 / {paragraphTotal} 段
          </span>
        </div>

        {/* 正文整体的错误：空段落、超长、超节数、含标签都由服务端那条统一的判断给出 */}
        {fieldProps("sections").error ? (
          <p
            id={fieldProps("sections").errorId}
            role="alert"
            className="text-[12px] leading-4 text-brand-red"
          >
            {fieldProps("sections").error}
          </p>
        ) : null}

        {sections.map((section, sectionIndex) => {
          const headingError = markupIssue(section.heading);
          const atParagraphCap =
            section.paragraphs.length >= AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT;

          return (
            // 用下标做 key：段落编辑器的行没有稳定 id——段落的身份就是「第几节第几段」，
            // 给它们造一套 id 只会多一份要同步的状态。输入框全是受控的，
            // 因此用下标做 key 不会出现值串行
            <div
              key={sectionIndex}
              className="flex flex-col gap-3 rounded-lg border border-admin-line bg-page p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-ink-3">
                  第 {sectionIndex + 1} 节 · {section.paragraphs.length} 段
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingRemoval({ kind: "section", section: sectionIndex })}
                  className="text-[12px] text-status-danger underline-offset-2 hover:underline disabled:opacity-40"
                >
                  删除这一节
                </button>
              </div>

              <AdminField
                label="小标题"
                error={headingError}
                errorId={`agreement-heading-${sectionIndex}-error`}
                hint="可以留空——留空表示这一节直接开始写正文"
                counter={
                  <AdminCharacterCounter
                    current={countCharacters(section.heading.trim())}
                    max={AGREEMENT_SECTION_HEADING_MAX_LENGTH}
                  />
                }
                htmlFor={`agreement-heading-${sectionIndex}`}
              >
                <input
                  id={`agreement-heading-${sectionIndex}`}
                  value={section.heading}
                  onChange={(event) => updateHeading(sectionIndex, event.target.value)}
                  aria-invalid={headingError ? true : undefined}
                  aria-describedby={headingError ? `agreement-heading-${sectionIndex}-error` : undefined}
                  className={`h-9 w-full ${
                    headingError
                      ? "rounded-lg border border-status-danger px-3 text-[13px] text-ink outline-none"
                      : "rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
                  }`}
                />
              </AdminField>

              {section.paragraphs.map((paragraph, paragraphIndex) => {
                const paragraphError = markupIssue(paragraph);
                const errorId = `agreement-paragraph-${sectionIndex}-${paragraphIndex}-error`;

                return (
                  <AdminField
                    key={paragraphIndex}
                    label={`第 ${sectionIndex + 1} 节 · 第 ${paragraphIndex + 1} 段`}
                    error={paragraphError}
                    errorId={errorId}
                    counter={
                      <AdminCharacterCounter
                        current={countCharacters(paragraph.trim())}
                        max={AGREEMENT_PARAGRAPH_MAX_LENGTH}
                      />
                    }
                    htmlFor={`agreement-paragraph-${sectionIndex}-${paragraphIndex}`}
                  >
                    <textarea
                      id={`agreement-paragraph-${sectionIndex}-${paragraphIndex}`}
                      value={paragraph}
                      rows={4}
                      onChange={(event) =>
                        updateParagraph(sectionIndex, paragraphIndex, event.target.value)
                      }
                      aria-invalid={paragraphError ? true : undefined}
                      aria-describedby={paragraphError ? errorId : undefined}
                      className={`w-full ${
                        paragraphError
                          ? "rounded-lg border border-status-danger p-3 text-[13px] leading-5 text-ink outline-none"
                          : "rounded-lg border border-admin-line p-3 text-[13px] leading-5 text-ink outline-none focus:border-admin-accent"
                      }`}
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setPendingRemoval({
                            kind: "paragraph",
                            section: sectionIndex,
                            paragraph: paragraphIndex,
                          })
                        }
                        className="text-[12px] text-status-danger underline-offset-2 hover:underline disabled:opacity-40"
                      >
                        删除这一段
                      </button>
                    </div>
                  </AdminField>
                );
              })}

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy || atParagraphCap}
                  onClick={() => addParagraph(sectionIndex)}
                  className="rounded-lg border border-admin-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface disabled:opacity-40"
                >
                  在本节末尾添加一段
                </button>
                {atParagraphCap ? (
                  <span className="text-[12px] leading-4 text-ink-3">
                    每一节最多 {AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT} 段，已经到上限
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || headingAtCap}
            onClick={addSection}
            className="rounded-lg border border-admin-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-page disabled:opacity-40"
          >
            在末尾添加一节
          </button>
          {headingAtCap ? (
            <span className="text-[12px] leading-4 text-ink-3">
              正文最多 {AGREEMENT_SECTION_MAX_COUNT} 节，已经到上限
            </span>
          ) : null}
          <span className="text-[12px] leading-4 text-ink-3">
            新加的一节会自带一段空正文——每一节至少要有一段，交空段落会被拒绝。
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存正文"}
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
          协议没有新建与移除：五类内容是固定的，要下架请用「停用」——那是可逆的。
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

      {/* 删除的二次确认：说清「本地删掉」与「保存之后找不回来」是两件事 */}
      <AdminConfirmDialog
        open={pendingRemoval !== null}
        title={pendingRemoval?.kind === "section" ? "删除这一节" : "删除这一段"}
        description={
          pendingRemoval?.kind === "section"
            ? `这一节连同它下面的 ${
                sections[pendingRemoval.section]?.paragraphs.length ?? 0
              } 段正文会从这份表单里去掉。**这一步不可撤销**：保存之后后台没有「恢复上一版正文」的功能（审计只记节数与段数，不存正文），需要重新输入。`
            : "这一段正文会从这份表单里去掉。**这一步不可撤销**：保存之后后台没有「恢复上一版正文」的功能（审计只记节数与段数，不存正文），需要重新输入。"
        }
        confirmLabel="确认删除"
        tone="danger"
        pending={busy}
        error={null}
        onConfirm={() => {
          if (pendingRemoval) applyRemoval(pendingRemoval);
          setPendingRemoval(null);
        }}
        onCancel={() => setPendingRemoval(null)}
      />

      <AdminConfirmDialog
        open={confirming}
        title={`${enabled ? "启用" : "停用"}这份协议`}
        description={
          enabled
            ? "启用后用户端「相关协议」页立即显示这一份。同类型有多份启用内容时，用户端取版本号最高的那一份。"
            : "停用后用户端改为显示同类型里版本号最高的那份启用内容；一份启用的都没有时显示「内容暂未配置」。正文与版本号都保留，随时可以重新启用。"
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
