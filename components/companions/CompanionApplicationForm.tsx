"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import EvidencePicker from "@/components/common/EvidencePicker";
import { ApiError } from "@/lib/api/client";
import {
  COMPANION_APPLICATION_CONTACT_NOTE_HINT,
  COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH,
  COMPANION_APPLICATION_EVIDENCE_KINDS,
  COMPANION_APPLICATION_EVIDENCE_MAX_COUNT,
  COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH,
  COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH,
  COMPANION_APPLICATION_MOCK_NOTICE,
  COMPANION_APPLICATION_NAME_MAX_LENGTH,
  COMPANION_APPLICATION_SUBMIT_NOTE,
  COMPANION_SERVICE_TAGS,
  companionApplicationFieldErrors,
  normalizeCompanionApplicationContactNote,
  normalizeCompanionApplicationExperience,
  normalizeCompanionApplicationIntroduction,
  normalizeCompanionApplicationName,
} from "@/lib/constants/companionApplications";
import type { EvidenceDraft } from "@/lib/constants/evidence";
import { submitCompanionApplication } from "@/lib/services/companionApplicationsHttp";
import { countCharacters } from "@/lib/utils/text";
import type { CompanionApplicationGameOption } from "@/lib/types/companionApplication";

/**
 * 护航入驻申请表单。
 *
 * 与「编辑资料 / 评价 / 反馈」表单同一套做法，四点刻意不用 HTML 原生行为解决：
 *
 * 1. **不用 `maxLength` 静默截断**：可以一直输入，实时显示字符数（`countCharacters`），
 *    超限立刻变红；提交时被拦住，并**滚动 + 聚焦**到第一个出错的字段。
 *    「打不进去却不知道为什么」比一条错误提示难查得多。
 * 2. **防重复提交不只靠禁用按钮**：`submittingRef` 是同步闸门（`pending` 要等重渲染才生效，
 *    连点两下时第二次点击可能在重渲染之前到达）；一次「提交意图」一个幂等键，
 *    失败重试沿用同一个键——服务端因此只会产生一条申请。
 * 3. **成功后 `router.replace("/join/status")`**：不往历史里留一张已提交的表单，
 *    后退不会回到这里再提交一次。
 * 4. **大区跟着游戏走**：取消一个游戏时，只属于它的大区会一并取消，
 *    因此不会出现「选了三角洲行动的大区，却又把三角洲行动取消掉」这种提交必被拒的状态。
 *
 * 表单里**没有**身份与状态字段：昵称以外的 userId、申请单号、状态、提交时间、审核时间、
 * 审核备注全部由服务端决定，请求体里也没有它们的位置。
 *
 * 字段与原型表单的差别是刻意的：原型里的真实姓名 / 性别 / 所在城市 / QQ / 微信 /
 * 手机号 / 联系邮箱**一律没有实现**，联系方式只留一个明确标注为 Mock 的纯文本
 * 「联系说明」。
 */
export default function CompanionApplicationForm({
  games,
}: {
  /** 游戏与大区选项：来自服务端真实游戏目录，前端不维护第二份 */
  games: CompanionApplicationGameOption[];
}) {
  const router = useRouter();

  const [displayName, setDisplayName] = useState("");
  const [gameIds, setGameIds] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [serviceTags, setServiceTags] = useState<string[]>([]);
  const [experience, setExperience] = useState("");
  const [introduction, setIntroduction] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [evidence, setEvidence] = useState<EvidenceDraft[]>([]);

  /** 提交过一次之后才提示「请填写…」：刚打开表单不该是一片红 */
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const gamesRef = useRef<HTMLDivElement>(null);
  const regionsRef = useRef<HTMLDivElement>(null);
  const tagsRef = useRef<HTMLDivElement>(null);
  const experienceRef = useRef<HTMLTextAreaElement>(null);
  const introductionRef = useRef<HTMLTextAreaElement>(null);
  const contactRef = useRef<HTMLInputElement>(null);

  /** 单飞闸门：成功后不复位——那时正在跳转，复位反而给出二次提交的机会。 */
  const submittingRef = useRef(false);
  /**
   * 幂等键：一次「提交意图」一个键。内容被改动时清空——改了内容就是另一次意图，
   * 沿用旧键会让服务端返回上一次的结果。提交失败则保留同一个键，重试不会产生第二条申请。
   */
  const submitKeyRef = useRef<string | null>(null);

  function invalidateSubmitKey() {
    submitKeyRef.current = null;
  }

  // 可服务大区 = 已选游戏的大区并集。没有选游戏时没有大区可选，这是正确的结果
  const availableRegions = [
    ...new Set(games.filter((game) => gameIds.includes(game.id)).flatMap((game) => game.regions)),
  ];

  const errors = companionApplicationFieldErrors({
    displayName,
    gameIds,
    regions,
    serviceTags,
    experience,
    introduction,
    contactNote,
    attempted,
  });

  const nameCount = countCharacters(displayName.trim());
  const experienceCount = countCharacters(experience.trim());
  const introductionCount = countCharacters(introduction.trim());
  const contactNoteCount = countCharacters(contactNote.trim());

  function toggleGame(id: string) {
    invalidateSubmitKey();
    const next = gameIds.includes(id) ? gameIds.filter((item) => item !== id) : [...gameIds, id];
    setGameIds(next);

    // 取消某个游戏后，只属于它的大区必须一并去掉：留着会让服务端以
    // 「大区不属于已选游戏」拒绝，而用户在界面上找不到原因
    const allowed = new Set(
      games.filter((game) => next.includes(game.id)).flatMap((game) => game.regions),
    );
    setRegions((current) => current.filter((region) => allowed.has(region)));
    setFormError(null);
  }

  function toggleRegion(region: string) {
    invalidateSubmitKey();
    setRegions((current) =>
      current.includes(region) ? current.filter((item) => item !== region) : [...current, region],
    );
    setFormError(null);
  }

  function toggleTag(tag: string) {
    invalidateSubmitKey();
    setServiceTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
    setFormError(null);
  }

  /** 滚动并聚焦到第一个出错的字段：错误提示可能不在当前视口内，只 focus 是不够的。 */
  function focusFirstInvalid(): void {
    const order: [string | null, RefObject<HTMLElement | null>][] = [
      [errors.displayName, nameRef],
      [errors.gameIds, gamesRef],
      [errors.regions, regionsRef],
      [errors.serviceTags, tagsRef],
      [errors.experience, experienceRef],
      [errors.introduction, introductionRef],
      [errors.contactNote, contactRef],
    ];

    const first = order.find(([message]) => message !== null);
    if (!first) return;

    const element = first[1].current;
    element?.scrollIntoView({ block: "center" });
    element?.focus();
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    setAttempted(true);
    setFormError(null);

    // 与服务端同一套规则：本地先判一次，不合格就一个字节都不发出去
    const parsedName = normalizeCompanionApplicationName(displayName);
    const parsedExperience = normalizeCompanionApplicationExperience(experience);
    const parsedIntroduction = normalizeCompanionApplicationIntroduction(introduction);
    const parsedContactNote = normalizeCompanionApplicationContactNote(contactNote);

    if (
      !parsedName.ok ||
      gameIds.length === 0 ||
      regions.length === 0 ||
      serviceTags.length === 0 ||
      !parsedExperience.ok ||
      !parsedIntroduction.ok ||
      !parsedContactNote.ok
    ) {
      focusFirstInvalid();
      return;
    }

    submittingRef.current = true;
    setPending(true);

    submitKeyRef.current ??= crypto.randomUUID();

    try {
      await submitCompanionApplication({
        displayName: parsedName.value,
        gameIds,
        regions,
        serviceTags,
        experience: parsedExperience.value,
        introduction: parsedIntroduction.value,
        contactNote: parsedContactNote.value,
        evidence,
        idempotencyKey: submitKeyRef.current,
      });
      // 用 replace：提交完再回退不该回到一张已经提交过的表单
      router.replace("/join/status");
      router.refresh();
    } catch (cause) {
      // 失败时所有内容都保留，用户改一下就能重试
      setFormError(cause instanceof ApiError ? cause.message : "提交失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col bg-page pb-8" noValidate>
      <p className="bg-surface px-4 py-2.5 text-[12px] leading-4 text-ink-3">
        {COMPANION_APPLICATION_MOCK_NOTICE}
      </p>

      {/* 陪玩昵称：必填 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <label htmlFor="join-display-name" className="text-[14px] font-medium text-ink">
            陪玩昵称 <span className="text-brand-red">*</span>
          </label>
          {/* 字数实时可见：超限后计数自己变红，不需要用户猜「为什么打不进去」 */}
          <span className={`text-[12px] ${nameCount > COMPANION_APPLICATION_NAME_MAX_LENGTH ? "text-brand-red" : "text-ink-3"}`}>
            {nameCount}/{COMPANION_APPLICATION_NAME_MAX_LENGTH}
          </span>
        </div>
        <input
          id="join-display-name"
          ref={nameRef}
          value={displayName}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setDisplayName(event.target.value);
          }}
          placeholder="这是展示在陪玩名单上的名字"
          aria-invalid={errors.displayName !== null}
          aria-describedby={errors.displayName ? "join-name-error" : undefined}
          className={`mt-2 h-10 w-full rounded-[8px] border px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            errors.displayName ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {errors.displayName ? (
          <p id="join-name-error" role="alert" className="mt-1 text-[12px] leading-5 text-brand-red">
            {errors.displayName}
          </p>
        ) : null}
      </section>

      {/* 擅长游戏：必选，可多选 */}
      <MultiSelectSection
        title="擅长游戏"
        required
        hint="至少选一个。大区选项会跟着已选的游戏变化。"
        error={errors.gameIds}
        errorId="join-games-error"
        groupRef={gamesRef}
      >
        {games.map((game) => (
          <Chip
            key={game.id}
            value={game.id}
            label={game.name}
            active={gameIds.includes(game.id)}
            disabled={pending}
            onSelect={toggleGame}
          />
        ))}
      </MultiSelectSection>

      {/* 可服务大区：必选，选项来自已选游戏 */}
      <MultiSelectSection
        title="可服务大区"
        required
        hint={gameIds.length === 0 ? "先选择擅长游戏，这里才会出现对应的大区。" : undefined}
        error={errors.regions}
        errorId="join-regions-error"
        groupRef={regionsRef}
      >
        {availableRegions.length === 0 ? (
          <li className="text-[12px] text-ink-3">暂无可选大区</li>
        ) : (
          availableRegions.map((region) => (
            <Chip
              key={region}
              value={region}
              label={region}
              active={regions.includes(region)}
              disabled={pending}
              onSelect={toggleRegion}
            />
          ))
        )}
      </MultiSelectSection>

      {/* 服务标签：必选 */}
      <MultiSelectSection
        title="服务标签"
        required
        hint="标签取值是开发阶段的 Mock 规则，不是平台已确认的服务分类。"
        error={errors.serviceTags}
        errorId="join-tags-error"
        groupRef={tagsRef}
      >
        {COMPANION_SERVICE_TAGS.map((tag) => (
          <Chip
            key={tag}
            value={tag}
            label={tag}
            active={serviceTags.includes(tag)}
            disabled={pending}
            onSelect={toggleTag}
          />
        ))}
      </MultiSelectSection>

      {/* 经验说明：必填 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <label htmlFor="join-experience" className="text-[14px] font-medium text-ink">
            经验说明 <span className="text-brand-red">*</span>
          </label>
          <span
            className={`text-[12px] ${experienceCount > COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH ? "text-brand-red" : "text-ink-3"}`}
          >
            {experienceCount}/{COMPANION_APPLICATION_EXPERIENCE_MAX_LENGTH}
          </span>
        </div>
        <textarea
          id="join-experience"
          ref={experienceRef}
          value={experience}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setExperience(event.target.value);
          }}
          rows={4}
          placeholder="打过哪些段位、带过多少单、擅长什么位置"
          aria-invalid={errors.experience !== null}
          aria-describedby={errors.experience ? "join-experience-error" : undefined}
          className={`mt-2 w-full resize-none rounded-[8px] border px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            errors.experience ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {errors.experience ? (
          <p
            id="join-experience-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {errors.experience}
          </p>
        ) : null}
      </section>

      {/* 自我介绍：必填 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <label htmlFor="join-introduction" className="text-[14px] font-medium text-ink">
            自我介绍 <span className="text-brand-red">*</span>
          </label>
          <span
            className={`text-[12px] ${introductionCount > COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH ? "text-brand-red" : "text-ink-3"}`}
          >
            {introductionCount}/{COMPANION_APPLICATION_INTRODUCTION_MAX_LENGTH}
          </span>
        </div>
        <textarea
          id="join-introduction"
          ref={introductionRef}
          value={introduction}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setIntroduction(event.target.value);
          }}
          rows={5}
          placeholder="接单时间、沟通风格、能提供的服务"
          aria-invalid={errors.introduction !== null}
          aria-describedby={errors.introduction ? "join-introduction-error" : undefined}
          className={`mt-2 w-full resize-none rounded-[8px] border px-3 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            errors.introduction ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {errors.introduction ? (
          <p
            id="join-introduction-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {errors.introduction}
          </p>
        ) : null}
      </section>

      {/* 联系说明：选填，纯文本 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <label htmlFor="join-contact-note" className="text-[14px] font-medium text-ink">
            联系说明
          </label>
          <span
            className={`text-[12px] ${contactNoteCount > COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH ? "text-brand-red" : "text-ink-3"}`}
          >
            {contactNoteCount}/{COMPANION_APPLICATION_CONTACT_NOTE_MAX_LENGTH}
          </span>
        </div>
        <input
          id="join-contact-note"
          ref={contactRef}
          value={contactNote}
          disabled={pending}
          onChange={(event) => {
            invalidateSubmitKey();
            setContactNote(event.target.value);
          }}
          placeholder="例如：晚上八点后在线"
          aria-invalid={errors.contactNote !== null}
          aria-describedby={
            errors.contactNote ? "join-contact-note-error" : "join-contact-note-hint"
          }
          className={`mt-2 h-10 w-full rounded-[8px] border px-3 text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 ${
            errors.contactNote ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {errors.contactNote ? (
          <p
            id="join-contact-note-error"
            role="alert"
            className="mt-1 text-[12px] leading-5 text-brand-red"
          >
            {errors.contactNote}
          </p>
        ) : (
          <p id="join-contact-note-hint" className="mt-1 text-[11px] leading-4 text-ink-3">
            {COMPANION_APPLICATION_CONTACT_NOTE_HINT}
          </p>
        )}
      </section>

      {/* 凭证：只收图片，最多 4 张，与提交给服务端的上限、类型是同一份常量 */}
      <section className="mt-2 bg-surface px-4 py-3">
        <EvidencePicker
          value={evidence}
          disabled={pending}
          maxCount={COMPANION_APPLICATION_EVIDENCE_MAX_COUNT}
          kinds={COMPANION_APPLICATION_EVIDENCE_KINDS}
          onChange={(next) => {
            invalidateSubmitKey();
            setEvidence(next);
          }}
        />
      </section>

      <div className="mt-2 px-4">
        <p className="text-[12px] leading-4 text-ink-3">{COMPANION_APPLICATION_SUBMIT_NOTE}</p>

        {formError ? (
          <p role="alert" className="mt-2 text-[12px] leading-4 text-brand-red">
            {formError}
          </p>
        ) : null}

        {/*
          按钮随表单在文档流内，不用 fixed/sticky，因此不会遮挡上面的输入项。
          超限或漏填时**不禁用**它：禁用之后点击不再触发任何反馈，用户只会觉得「按钮坏了」。
          保持可点，由 handleSubmit 拦住请求并把视口带到第一个出错的字段。
        */}
        <button
          type="submit"
          disabled={pending}
          className="mt-3 h-11 w-full rounded-full bg-brand-blue text-[15px] font-medium text-white disabled:opacity-60"
        >
          {pending ? "提交中…" : "提交入驻申请"}
        </button>
      </div>
    </form>
  );
}

/** 多选分组：标题 + 必填标记 + 胶囊组 + 错误提示。 */
function MultiSelectSection({
  title,
  required = false,
  hint,
  error,
  errorId,
  groupRef,
  children,
}: {
  title: string;
  required?: boolean;
  hint?: string;
  error: string | null;
  errorId: string;
  groupRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <section className="mt-2 bg-surface px-4 py-3">
      <h2 className="text-[14px] font-medium text-ink">
        {title} {required ? <span className="text-brand-red">*</span> : null}
      </h2>

      {/*
        错误用 `aria-describedby` 关联（`role="group"` 不支持 `aria-invalid`），
        `tabIndex={-1}` 让「滚动并聚焦到第一个出错的字段」有落点。
      */}
      <div
        ref={groupRef}
        role="group"
        aria-label={title}
        tabIndex={-1}
        aria-describedby={error ? errorId : undefined}
        className="mt-2 outline-none"
      >
        <ul className="flex flex-wrap gap-1.5">{children}</ul>
      </div>

      {hint ? <p className="mt-1.5 text-[11px] leading-4 text-ink-3">{hint}</p> : null}

      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-[12px] leading-5 text-brand-red">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * 多选胶囊。选中态带 `aria-pressed`：颜色不是唯一的选中标志。
 *
 * 取值与回调分开传（而不是在调用处写 `onClick={() => toggle(x)}`）：
 * 这样映射列表时不需要在渲染过程中新建闭包，`onSelect` 直接就是那个已经定义好的处理函数。
 */
function Chip({
  value,
  label,
  active,
  disabled,
  onSelect,
}: {
  value: string;
  label: string;
  active: boolean;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={active}
        disabled={disabled}
        onClick={() => onSelect(value)}
        className={`rounded-full px-3 py-1.5 text-[13px] disabled:opacity-60 ${
          active ? "seg-tab-active font-medium" : "border border-line bg-surface text-ink-2"
        }`}
      >
        {label}
      </button>
    </li>
  );
}
