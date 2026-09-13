"use client";

/* eslint-disable @next/next/no-img-element -- Mock 头像是本地 SVG 占位图，不经 next/image 优化器 */
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api/client";
import {
  BIO_MAX_LENGTH,
  MOCK_AVATAR_OPTIONS,
  NICKNAME_MAX_LENGTH,
  countProfileCharacters,
  normalizeBio,
  normalizeNickname,
  profileFieldErrors,
} from "@/lib/constants/profile";
import { updateMyProfile } from "@/lib/services/profileHttp";
import type { UserProfile } from "@/lib/types/user";

/**
 * 编辑资料表单（昵称 / 头像 / 简介）。
 *
 * 只改这三个字段。**身份字段不在表单里**：`id` 与 `displayId` 不参与提交，
 * 请求体里也不带任何用户标识——「改谁的资料」由服务端会话决定，
 * 因此本页既改不了别人的资料，也改不了自己的平台 ID。
 *
 * 头像：当前是 **Mock 方案**——从 `MOCK_AVATAR_OPTIONS` 这几个本地占位头像里挑一个。
 * 不接对象存储、不做真实上传，因此既不会把用户机器的完整文件路径存进资料，
 * 也不会伪造一个并不存在的远程图片地址。接入真实上传后，这里换成上传得到的资源地址，
 * 服务端 `isAllowedAvatar` 的白名单校验不变。
 *
 * 长度反馈：**不用 HTML `maxLength` 静默截断**。用户能一直输入下去，字数实时显示、
 * 超限立刻变红并给出提示；提交时被拦住并聚焦第一个出错的字段。
 * 静默截断的问题在于「打不进去，却不知道为什么」——那是最难自查的一类问题。
 *
 * 校验与服务端共用 `lib/constants/profile.ts` 的同一份实现（连同 `countCharacters`
 * 这一套字符计数规则），前端拦下的与服务端拒绝的是同一批输入，不会出现两套说法。
 */
export default function ProfileEditForm({ initialProfile }: { initialProfile: UserProfile }) {
  const router = useRouter();

  const [nickname, setNickname] = useState(initialProfile.nickname);
  const [bio, setBio] = useState(initialProfile.bio);
  const [avatarUrl, setAvatarUrl] = useState(initialProfile.avatarUrl);
  /** 提交过一次之后才提示「请输入昵称」：没点过保存就先不出错，避免页面一打开就报错 */
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const nicknameRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  /**
   * 单飞闸门。`pending` 要等重渲染才生效，连点两下时第二次点击可能在重渲染之前到达，
   * 因此用一个同步的 ref 兜住；保存过程中它**不会**被复位——成功后正在跳转，
   * 复位反而会给出二次提交的机会。
   */
  const submittingRef = useRef(false);

  /**
   * 字数按**保存后的值**算（去首尾空格）：结尾多敲几个空格不会把计数顶上去，
   * 否则用户会看到 15/15 却还能再打一个空格。
   */
  const nicknameCount = countProfileCharacters(nickname);
  const bioCount = countProfileCharacters(bio);

  const nicknameTooLong = nicknameCount > NICKNAME_MAX_LENGTH;
  const bioTooLong = bioCount > BIO_MAX_LENGTH;

  /**
   * 错误全部从当前输入**推导**出来（规则见 `profileFieldErrors`），不额外存一份状态：
   * 超限是实时的，还没点保存就显示；「请输入昵称」只在点过保存之后出现。
   * 用户一旦改到合法长度，提示自动消失，不会留下过期的旧错误。
   */
  const { avatar: avatarError, nickname: nicknameError, bio: bioError } = profileFieldErrors({
    nickname,
    bio,
    avatarUrl,
    attempted,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;

    setAttempted(true);
    setFormError(null);

    // 与服务端同一套规则：本地先判一次，不合格就一个字节都不发出去
    const parsedAvatar = avatarUrl.trim();
    const parsedNickname = normalizeNickname(nickname);
    const parsedBio = normalizeBio(bio);

    // 按页面上的先后顺序检查，停在第一个出错的字段上——不发请求，只把光标送过去
    if (!parsedAvatar) {
      avatarRef.current?.querySelector("button")?.focus();
      return;
    }
    if (!parsedNickname.ok) {
      nicknameRef.current?.focus();
      return;
    }
    if (!parsedBio.ok) {
      bioRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    setPending(true);

    try {
      await updateMyProfile({
        nickname: parsedNickname.nickname,
        avatarUrl: parsedAvatar,
        bio: parsedBio.bio,
      });
      // 回到「我的」并让服务端重新取一次资料：新昵称/头像/简介立刻可见
      router.replace("/mine");
      router.refresh();
    } catch (cause) {
      setFormError(cause instanceof ApiError ? cause.message : "保存失败，请稍后重试");
      submittingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6 px-4 py-5" noValidate>
      <section className="flex flex-col gap-3">
        <h2 className="text-[14px] font-medium text-ink">头像</h2>
        <div
          ref={avatarRef}
          role="group"
          aria-label="头像"
          aria-describedby={avatarError ? "profile-avatar-error" : undefined}
          className="flex flex-wrap gap-3"
        >
          {MOCK_AVATAR_OPTIONS.map((option, index) => {
            const selected = option === avatarUrl;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setAvatarUrl(option)}
                aria-pressed={selected}
                aria-label={`头像 ${index + 1}`}
                className={`h-14 w-14 rounded-full bg-page p-0.5 ${
                  avatarError
                    ? "ring-2 ring-brand-red"
                    : selected
                      ? "ring-2 ring-tab-from"
                      : "ring-1 ring-line"
                }`}
              >
                <img src={option} alt="" className="h-full w-full rounded-full object-cover" />
              </button>
            );
          })}
        </div>
        {avatarError ? (
          <p id="profile-avatar-error" role="alert" className="text-[12px] leading-5 text-brand-red">
            {avatarError}
          </p>
        ) : null}
        <p className="text-[12px] leading-5 text-ink-3">
          当前为 Mock 头像：只能从上面的占位头像中选择，尚未接入真实上传与微信头像。
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="profile-nickname" className="text-[14px] font-medium text-ink">
          昵称
        </label>
        <input
          id="profile-nickname"
          ref={nicknameRef}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="请输入昵称"
          aria-invalid={nicknameError !== null}
          aria-describedby={
            nicknameError
              ? "profile-nickname-error profile-nickname-count"
              : "profile-nickname-count"
          }
          className={`rounded-[10px] border px-3 py-2.5 text-[15px] text-ink outline-none ${
            nicknameError ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {nicknameError ? (
          <p
            id="profile-nickname-error"
            role="alert"
            className="text-[12px] leading-5 text-brand-red"
          >
            {nicknameError}
          </p>
        ) : null}
        {/* 字数实时可见：超限后计数自己变红，不需要用户猜「为什么打不进去」 */}
        <p
          id="profile-nickname-count"
          className={`text-right text-[12px] ${
            nicknameTooLong ? "text-brand-red" : "text-ink-3"
          }`}
        >
          {nicknameCount}/{NICKNAME_MAX_LENGTH}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="profile-bio" className="text-[14px] font-medium text-ink">
          个人简介
        </label>
        <textarea
          id="profile-bio"
          ref={bioRef}
          value={bio}
          onChange={(event) => setBio(event.target.value)}
          rows={3}
          placeholder="选填，介绍一下自己"
          aria-invalid={bioError !== null}
          aria-describedby={bioError ? "profile-bio-error profile-bio-count" : "profile-bio-count"}
          className={`resize-none rounded-[10px] border px-3 py-2.5 text-[15px] leading-6 text-ink outline-none ${
            bioError ? "border-brand-red" : "border-line focus:border-brand-blue-border"
          }`}
        />
        {bioError ? (
          <p id="profile-bio-error" role="alert" className="text-[12px] leading-5 text-brand-red">
            {bioError}
          </p>
        ) : null}
        <p
          id="profile-bio-count"
          className={`text-right text-[12px] ${bioTooLong ? "text-brand-red" : "text-ink-3"}`}
        >
          {bioCount}/{BIO_MAX_LENGTH}
        </p>
      </section>

      {formError ? (
        <p role="alert" className="rounded-[10px] bg-page px-3 py-2 text-[13px] text-brand-red">
          {formError}
        </p>
      ) : null}

      {/*
        按钮随表单在文档流内，不用 fixed/sticky，因此不会遮挡上面的输入项。
        超限时**不禁用**它：禁用之后点击不再触发任何反馈，用户只会觉得「按钮坏了」。
        保持可点，由 handleSubmit 拦住请求并把光标送到出错的字段。
      */}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-ink py-3 text-[15px] font-medium text-white disabled:opacity-60"
      >
        {pending ? "保存中…" : "保存"}
      </button>
    </form>
  );
}
