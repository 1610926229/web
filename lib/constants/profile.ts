import { countCharacters } from "@/lib/utils/text";

/**
 * 个人资料的校验与文案，服务端与浏览器共用。
 *
 * ⚠️ 本文件除 `lib/utils/text.ts` 这个纯函数外没有运行时依赖：客户端组件引用它不会把
 * 服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 长度一律用 `countCharacters`（见 `lib/utils/text.ts`）计算，**不是 `String.length`**：
 * 一个汉字、一个字母、一个普通 Emoji 都算 1 个字符。前端计数、服务端校验与测试用的是
 * 同一个函数，所以不会出现「输入框说 15/15、服务端却说超了」的错配。
 */

/** 昵称长度上限。必填，去首尾空格后至少 1 个字符。 */
export const NICKNAME_MAX_LENGTH = 15;

export const NICKNAME_REQUIRED_MESSAGE = "请输入昵称";
export const NICKNAME_TOO_LONG_MESSAGE = `昵称不能超过${NICKNAME_MAX_LENGTH}个字符`;

/** 个人简介：选填，长度上限。 */
export const BIO_MAX_LENGTH = 50;

export const BIO_TOO_LONG_MESSAGE = `个人简介不能超过${BIO_MAX_LENGTH}个字符`;

/** 简介为空时「我的」页显示的占位（与原型一致）。 */
export const BIO_EMPTY_PLACEHOLDER = "暂未填写个人简介";

/**
 * 可选头像（Mock）。
 *
 * ⚠️ 当前**没有对象存储、没有真实上传**：用户只能从这里挑一个本地占位头像，
 * 存下来的是 public 下的资源地址。因此既不会保存用户机器的完整文件路径
 * （`C:\Users\...\a.png` 这类），也不会伪造一个并不存在的远程图片地址。
 *
 * 接入真实上传后，这里的选项改为「上传得到的资源地址」，校验规则不变
 * （见 `isAllowedAvatar`）——服务端永远只接受白名单内的头像地址。
 */
export const MOCK_AVATAR_OPTIONS: readonly string[] = [
  "/mock/avatar-1.svg",
  "/mock/avatar-2.svg",
  "/mock/avatar-3.svg",
  "/mock/avatar-4.svg",
];

export const AVATAR_REQUIRED_MESSAGE = "请选择头像";
export const AVATAR_INVALID_MESSAGE = "头像地址无效，请重新选择";

/**
 * 头像地址是否可接受：必须是选项之一，或者就是该用户**当前**已经存着的地址。
 *
 * 放行当前值是为了「换昵称时不必先换头像」，同时它也覆盖了将来微信授权带来的初始头像——
 * 那种地址不在选项列表里，但确实是系统写入的合法值。除此之外一律拒绝，
 * 避免把任意字符串（本地路径、编造的远程地址）存进资料里。
 */
export function isAllowedAvatar(url: string, currentAvatarUrl: string): boolean {
  if (MOCK_AVATAR_OPTIONS.includes(url)) return true;
  return url !== "" && url === currentAvatarUrl;
}

/**
 * 解析昵称：去首尾空格后必须非空且不超长。
 * **返回去掉空格后的结果**，避免只敲了几个空格就当成昵称存下来——
 * 全是空格的输入与空串走同一条分支，提示「请输入昵称」。
 */
export function normalizeNickname(
  raw: string,
): { ok: true; nickname: string } | { ok: false; message: string } {
  const nickname = raw.trim();
  if (!nickname) return { ok: false, message: NICKNAME_REQUIRED_MESSAGE };
  if (countCharacters(nickname) > NICKNAME_MAX_LENGTH) {
    return { ok: false, message: NICKNAME_TOO_LONG_MESSAGE };
  }
  return { ok: true, nickname };
}

/** 解析个人简介：选填，去首尾空格后不超长；空串是合法值（表示不填）。 */
export function normalizeBio(
  raw: string,
): { ok: true; bio: string } | { ok: false; message: string } {
  const bio = raw.trim();
  if (countCharacters(bio) > BIO_MAX_LENGTH) return { ok: false, message: BIO_TOO_LONG_MESSAGE };
  return { ok: true, bio };
}

/**
 * 表单字数的统一计数：**按保存后的值算**（昵称与简介都会去掉首尾空格），
 * 因此结尾多敲几个空格不会把计数顶上去，输入框上的 `12/15` 与实际存下来的值永远对得上。
 */
export function countProfileCharacters(raw: string): number {
  return countCharacters(raw.trim());
}

/** 编辑资料表单三个字段的即时错误提示，null 表示合法。 */
export type ProfileFieldErrors = {
  avatar: string | null;
  nickname: string | null;
  bio: string | null;
};

/**
 * 由当前输入推导出各字段的错误提示。
 *
 * 抽成纯函数而不是写在组件里，有两个原因：
 *
 * 1. **可测**。「全空格」这类状态在浏览器里要靠手点，写成纯函数就能被持续测试盯住；
 * 2. **不存第二份状态**。错误是**推导**出来的，用户把内容改回合法长度，提示自然消失，
 *    不会留下过期的旧错误——这正是不把错误塞进 `useState` 的原因。
 *
 * `attempted` 表示「用户已经点过保存」：`请输入昵称` 这类「你还没填」的提示要等点过保存
 * 才出现，否则页面一打开就是一片红。长度超限则**不**等提交，输入时立刻提示。
 */
export function profileFieldErrors(input: {
  nickname: string;
  bio: string;
  avatarUrl: string;
  attempted: boolean;
}): ProfileFieldErrors {
  const nicknameCount = countProfileCharacters(input.nickname);
  const bioCount = countProfileCharacters(input.bio);

  return {
    avatar: input.attempted && !input.avatarUrl.trim() ? AVATAR_REQUIRED_MESSAGE : null,
    nickname:
      nicknameCount > NICKNAME_MAX_LENGTH
        ? NICKNAME_TOO_LONG_MESSAGE
        : input.attempted && nicknameCount === 0
          ? NICKNAME_REQUIRED_MESSAGE
          : null,
    bio: bioCount > BIO_MAX_LENGTH ? BIO_TOO_LONG_MESSAGE : null,
  };
}
