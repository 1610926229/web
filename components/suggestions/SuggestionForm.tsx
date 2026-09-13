"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import EvidencePicker from "@/components/common/EvidencePicker";
import { ApiError } from "@/lib/api/client";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import {
  SUGGESTION_CONTACT_MAX_LENGTH,
  SUGGESTION_CONTENT_MAX_LENGTH,
  SUGGESTION_EVIDENCE_KINDS,
  SUGGESTION_EVIDENCE_MAX_COUNT,
  SUGGESTION_SUBMIT_NOTE,
  SUGGESTION_TYPES,
  SUGGESTION_TYPE_REQUIRED_MESSAGE,
  isSuggestionType,
  normalizeSuggestionContact,
  normalizeSuggestionContent,
  suggestionFieldErrors,
} from "@/lib/constants/suggestions";
import { submitSuggestion } from "@/lib/services/suggestionsHttp";
import { countCharacters } from "@/lib/utils/text";

/**
 * 提交反馈表单（类型 / 内容 / 联系方式 / Mock 图片凭证）。
 *
 * 三件事刻意不用 HTML 原生行为解决：
 *
 * 1. **字数不用 `maxLength` 静默截断**：可以一直输入，实时显示字符数（`countCharacters`，
 *    汉字 / 字母 / 普通 Emoji 都算 1 个），超限立刻变红并给出提示；提交时被拦住并把
 *    光标送到第一个出错的字段。静默截断的问题是「打不进去，却不知道为什么」。
 * 2. **防重复提交不只靠禁用按钮**：`submittingRef` 是同步闸门（`pending` 要等重渲染才生效，
 *    连点两下时第二次点击可能在重渲染之前到达）；同时一次「提交意图」一个幂等键，
 *    失败重试沿用同一个键——服务端因此只会产生一条反馈。
 * 3. **成功后用 `router.replace` 回列表**：不往历史里留一张已提交的表单，
 *    浏览器后退不会回到这里再提交一次。
 *
 * 表单里没有身份与状态字段：类型、内容、联系方式、凭证之外的东西（用户、状态、回复、
 * 提交时间）全部由服务端决定，请求体里也没有它们的位置。
 */
export default function SuggestionForm() {
  const router = useRouter();

  const [typeKey, setTypeKey] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);
  /** 提交过一次之后才提示「请填写反馈内容」：没点过就先不报错 */
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const typeRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);

  /** 单飞闸门：成功后不复位——那时正在跳转，复位反而会给出二次提交的机会。 */
  const submittingRef = useRef(false);
  /**
   * 幂等键：一次「提交意图」一个键。内容被改动时清空——改了内容就是另一次意图，
   * 沿用旧键会让服务端返回上一次的结果，用户会看到「提交成功但内容还是旧的」。
   * 提交失败则保留同一个键，于是重试不会产生第二条反馈。
   */
  const submitKeyRef = useRef<string | null>(null);

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  const contentCount = countCharacters(content);
  const contentTooLong = contentCount > SUGGESTION_CONTENT_MAX_LENGTH;
  const contactCount = countCharacters(contact);
  const contactTooLong = contactCount > SUGGESTION_CONTACT_MAX_LENGTH;

  /**
   * 错误全部从当前输入**推导**出来（规则见 `suggestionFieldErrors`），不额外存一份状态：
   * 超限是实时的，还没点提交就显示；「请填写反馈内容」只在点过提交之后出现。
   */
  const { content: contentError, contact: contactError } = suggestionFieldErrors({
    content,
    contact,
    attempted,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    setAttempted(true);
    setFormError(null);

    // 与服务端同一套规则：本地先判一次，不合格就一个字节都不发出去
    if (!isSuggestionType(typeKey)) {
      typeRef.current?.focus();
      return;
    }
    const parsedContent = normalizeSuggestionContent(content);
    if (!parsedContent.ok) {
      contentRef.current?.focus();
      return;
    }
    const parsedContact = normalizeSuggestionContact(contact);
    if (!parsedContact.ok) {
      contactRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setPending(true);

    submitKeyRef.current ??= crypto.randomUUID();

    try {
      await submitSuggestion({
        typeKey,
        content: parsedContent.content,
        contact: parsedContact.contact,
        evidence,
        idempotencyKey: submitKeyRef.current,
      });
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace("/suggestions");
      router.refresh();
    } catch (cause) {
      // 失败时类型、内容、联系方式、凭证全部保留，用户改一下就能重试
      setFormError(cause instanceof ApiError ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col bg-page pb-8" noValidate>
      {/* 反馈类型：必选 */}
      <section className="bg-surface px-4 py-3">
        <h2 className="text-[14px] font-medium text-ink">
          反馈类型 <span className="text-brand-red">*</span>
        </h2>
        <div
          ref={typeRef}
          role="group"
          aria-label="反馈类型"
          aria-describedby={attempted && !isSuggestionType(typeKey) ? "suggestion-type-error" : undefined}
          className="mt-2 flex flex-col"
        >
          {SUGGESTION_TYPES.map((type) => {
            const active = type.key === typeKey;
            return (
              <button
                key={type.key}
                type="button"
                disabled={pending}
                aria-pressed={active}
                onClick={() => {
                  invalidateSubmitKey();
                  setTypeKey(type.key);
                  setFormError(null);
                }}
                className="flex items-center gap-2.5 border-b border-line py-2.5 text-left text-[14px] last:border-b-0 disabled:opacity-60"
              >
                <span
                  aria-hidden
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? "border-brand-red" : "border-line"
                  }`}
                >
                  {active ? <span className="h-2 w-2 rounded-full bg-brand-red" /> : null}
                </span>
                <span className={active ? "text-ink" : "text-ink-2"}>{type.label}</span>
              </button>
            );
          })}
        </div>
        {attempted && !isSuggestionType(typeKey) ? (
          <p
            id="suggestion-type-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {SUGGESTION_TYPE_REQUIRED_MESSAGE}
          </p>
        ) : null}
      </section>

      {/* 反馈内容：必填，长度受限但不静默截断 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-medium text-ink">
            反馈内容 <span className="text-brand-red">*</span>
          </h2>
          {/* 字数实时可见：超限后计数自己变红，不需要用户猜「为什么打不进去」 */}
          <span className={`text-[12px] ${contentTooLong ? "text-brand-red" : "text-ink-3"}`}>
            {contentCount}/{SUGGESTION_CONTENT_MAX_LENGTH}
          </span>
        </div>
        <textarea
          ref={contentRef}
          value={content}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setContent(event.target.value);
          }}
          rows={5}
          placeholder="说说是哪一页、什么场景，以及你希望变成什么样"
          aria-label="反馈内容"
          aria-invalid={contentError !== null}
          aria-describedby={contentError ? "suggestion-content-error" : undefined}
          className={`mt-2 w-full resize-none rounded-[8px] border px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            contentError ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {contentError ? (
          <p
            id="suggestion-content-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {contentError}
          </p>
        ) : null}

        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
          <span className="shrink-0 text-[13px] text-ink-2">联系方式</span>
          <input
            ref={contactRef}
            value={contact}
            disabled={pending}
            onChange={(event) => {
              invalidateSubmitKey();
              setContact(event.target.value);
            }}
            placeholder="选填，便于平台回复你"
            aria-label="联系方式"
            aria-invalid={contactError !== null}
            aria-describedby={contactError ? "suggestion-contact-error" : "suggestion-contact-hint"}
            className="h-8 min-w-0 flex-1 bg-transparent text-right text-[13px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />
          {/* 与正文同一个做法：超限的计数自己变红，边界对用户是可见的 */}
          <span className={`shrink-0 text-[12px] ${contactTooLong ? "text-brand-red" : "text-ink-3"}`}>
            {contactCount}/{SUGGESTION_CONTACT_MAX_LENGTH}
          </span>
        </div>
        {contactError ? (
          <p
            id="suggestion-contact-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {contactError}
          </p>
        ) : (
          <p id="suggestion-contact-hint" className="mt-1 text-[11px] leading-4 text-ink-3">
            选填。本阶段只收集一个便于回复的联系方式，不会采集更敏感的信息。
          </p>
        )}
      </section>

      {/* 凭证：只收图片，最多 4 张；与提交给服务端的上限、类型是同一份常量 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <EvidencePicker
          value={evidence}
          disabled={pending}
          maxCount={SUGGESTION_EVIDENCE_MAX_COUNT}
          kinds={SUGGESTION_EVIDENCE_KINDS}
          onChange={(next) => {
            invalidateSubmitKey();
            setEvidence(next);
          }}
        />
      </section>

      <div className="mt-2 px-4">
        <p className="text-[12px] leading-4 text-ink-3">{SUGGESTION_SUBMIT_NOTE}</p>

        {formError ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {formError}
          </p>
        ) : null}

        {/*
          按钮随表单在文档流内，不用 fixed/sticky，因此不会遮挡上面的输入项。
          超限时**不禁用**它：禁用之后点击不再触发任何反馈，用户只会觉得「按钮坏了」。
          保持可点，由 handleSubmit 拦住请求并把焦点送到出错的字段。
        */}
        <button
          type="submit"
          disabled={pending}
          className="mt-3 h-11 w-full rounded-full bg-brand-red text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "提交中…" : "提交反馈"}
        </button>
      </div>
    </form>
  );
}
