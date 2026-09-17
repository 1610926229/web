import { countCharacters } from "@/lib/utils/text";
import { isSafePath, validateSafePath } from "./safePath";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminAnnouncementProfilePatch,
  AdminBannerProfilePatch,
  AdminQuickEntryProfilePatch,
  QuickEntryIcon,
} from "@/lib/types/content";

/**
 * 运营内容（图片公告 / 活动 Banner / 快捷入口）的后台校验规则与错误文案。
 *
 * ⚠️ 本文件**只有 `import type` 与两个纯函数模块**（`lib/utils/text`、`./safePath`），
 * 没有任何运行时服务端依赖：客户端组件引用它不会把服务端模块打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * 三条贯穿全文件的判断：
 *
 * 1. **图片地址只能是站内路径**。本阶段不做图片上传（§三），图片来源是
 *    `public/mock/` 下的占位图。因此地址走的是与快捷入口**同一套** `validateSafePath()`：
 *    管理员不可能把一个外域 URL 填进来，用户端因此也不会去加载任意站外资源
 *    （那既是隐私问题——用户 IP 会落到第三方——也是混合内容与可用性问题）。
 *    将来接入对象存储时，这里改成「允许本站 CDN 域名的 https 地址」，
 *    而不是放宽成「任意地址」。
 * 2. **校验与写入看到的是同一个字符串**。所有 `normalize*()` 返回的都是
 *    `trim()` 之后的值，调用方不必再处理一遍——「校验的是 A、存的是 B」
 *    正是 `" /join "` 这类绕过校验的经典入口。
 * 3. **服务端字段在入参里没有位置**。`id` / `createdAt` / `updatedAt` / `removedAt`
 *    一个都不在这些 patch 里，客户端多传一个也不会有任何效果（§九）。
 */

export const CONTENT_TITLE_MAX_LENGTH = 40;
export const CONTENT_ALT_MAX_LENGTH = 60;
export const CONTENT_LABEL_MAX_LENGTH = 8;
export const CONTENT_SORT_ORDER_MIN = 0;
export const CONTENT_SORT_ORDER_MAX = 9999;

export const CONTENT_TITLE_EMPTY_MESSAGE = "请填写名称（仅后台可见，用于辨认素材）";
export const CONTENT_TITLE_TOO_LONG_MESSAGE = `名称不能超过 ${CONTENT_TITLE_MAX_LENGTH} 个字符`;

export const CONTENT_IMAGE_URL_EMPTY_MESSAGE = "请填写图片地址";
export const CONTENT_IMAGE_URL_INVALID_MESSAGE =
  "图片地址必须是站内路径（以 / 开头），本阶段不支持外域地址与图片上传";

export const CONTENT_ALT_EMPTY_MESSAGE = "请填写图片说明（读屏软件会读出来）";
export const CONTENT_ALT_TOO_LONG_MESSAGE = `图片说明不能超过 ${CONTENT_ALT_MAX_LENGTH} 个字符`;

export const CONTENT_LABEL_EMPTY_MESSAGE = "请填写入口名称";
export const CONTENT_LABEL_TOO_LONG_MESSAGE = `入口名称不能超过 ${CONTENT_LABEL_MAX_LENGTH} 个字符`;

export const CONTENT_SORT_ORDER_INVALID_MESSAGE = `排序值必须是 ${CONTENT_SORT_ORDER_MIN} 到 ${CONTENT_SORT_ORDER_MAX} 之间的整数`;

export const CONTENT_ICON_INVALID_MESSAGE = "请选择一个图标";

/**
 * 可选的图标。
 *
 * ⚠️ 与 `QuickEntryIcon` 类型**必须保持同步**：这里多一个值而类型里没有，
 * `tsc` 会立刻报错（`Record<QuickEntryIcon, string>` 少键）；类型里多一个值
 * 而这里没有，同样报错。因此这个表既是运行时的白名单，也是编译期的覆盖率检查。
 */
export const QUICK_ENTRY_ICON_LABELS: Record<QuickEntryIcon, string> = {
  service: "客服耳机",
  benefits: "权益星标",
  join: "入驻盾牌",
  complaint: "投诉喇叭",
};

export const QUICK_ENTRY_ICONS: readonly QuickEntryIcon[] = [
  "service",
  "benefits",
  "join",
  "complaint",
];

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** 字数口径全站统一按 code point 算（`lib/utils/text.ts`），不是 UTF-16 长度。 */
function validateText(raw: string, max: number, empty: string, tooLong: string): FieldResult<string> {
  const value = raw.trim();
  if (!value) return { ok: false, message: empty };
  if (countCharacters(value) > max) return { ok: false, message: tooLong };
  return { ok: true, value };
}

/**
 * 图片地址校验：先过 `validateSafePath()`，再确认它像一张图。
 *
 * ⚠️ 「像一张图」这一条不是多余的：`/join` 也是一个合法的站内路径，
 * 但把它填进公告的图片地址，用户端会渲染出一个碎图。扩展名判断不是安全措施
 * （它挡不住任何攻击），而是**给填表的人一条即时反馈**——真正保安全的是
 * `validateSafePath()`，那一条失败了就直接拒绝。
 */
function validateImageUrl(raw: string): FieldResult<string> {
  const path = validateSafePath(raw);
  if (!path.ok) {
    // 空值与格式错误分开报：空值是「还没填」，格式错误是「填得不对」
    return {
      ok: false,
      message: path.message.includes("请填写") ? CONTENT_IMAGE_URL_EMPTY_MESSAGE : CONTENT_IMAGE_URL_INVALID_MESSAGE,
    };
  }

  if (!/\.(svg|png|jpe?g|webp|gif)$/i.test(path.value)) {
    return { ok: false, message: CONTENT_IMAGE_URL_INVALID_MESSAGE };
  }

  return { ok: true, value: path.value };
}

function validateSortOrder(value: number): FieldResult<number> {
  if (!Number.isInteger(value) || value < CONTENT_SORT_ORDER_MIN || value > CONTENT_SORT_ORDER_MAX) {
    return { ok: false, message: CONTENT_SORT_ORDER_INVALID_MESSAGE };
  }
  return { ok: true, value };
}

function validateIcon(raw: string): FieldResult<QuickEntryIcon> {
  const value = raw.trim();
  if (!QUICK_ENTRY_ICONS.includes(value as QuickEntryIcon)) {
    return { ok: false, message: CONTENT_ICON_INVALID_MESSAGE };
  }
  return { ok: true, value: value as QuickEntryIcon };
}

// ————————————————————————— 图片公告 / 活动 Banner —————————————————————————

/**
 * 两者共用同一张字段表。
 *
 * ⚠️ 不是「顺便复用」：公告与 Banner 在数据形状上**确实是同一种东西**
 * ——一张图 + 一个后台标题 + 一句读屏说明 + 排序 + 启用。两者的差别只在
 * **用户端怎么用**（公告轮播全部启用的，Banner 只取排序最前的一条）。
 * 为这种差别复制一份字段表，只会得到两张会各自漂移的表。
 */

export const CONTENT_IMAGE_FIELD_LABELS = {
  title: "名称",
  imageUrl: "图片地址",
  alt: "图片说明",
  sortOrder: "排序",
  enabled: "启用状态",
} as const;

export type ContentImageField = keyof typeof CONTENT_IMAGE_FIELD_LABELS;

export type ContentImageFieldErrors = Record<ContentImageField, string | null>;

const NO_IMAGE_ERRORS: ContentImageFieldErrors = {
  title: null,
  imageUrl: null,
  alt: null,
  sortOrder: null,
  enabled: null,
};

/** 表单里可以填的原始值（文本都是字符串，勾选框是布尔）。 */
export type ContentImageInput = {
  title: string;
  imageUrl: string;
  alt: string;
  sortOrder: number;
  enabled: boolean;
};

/**
 * 推导表单各字段的错误。
 *
 * 与类目、护航编辑同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 *
 * ⚠️ `enabled` 在这个表里但**永远为 null**：它是一个勾选框，没有「填错」这种状态。
 * 留在表里是为了让页面的字段遍历与错误定位不必为它开一个特例。
 */
export function contentImageFieldErrors(input: ContentImageInput): ContentImageFieldErrors {
  const title = validateText(
    input.title,
    CONTENT_TITLE_MAX_LENGTH,
    CONTENT_TITLE_EMPTY_MESSAGE,
    CONTENT_TITLE_TOO_LONG_MESSAGE,
  );
  const imageUrl = validateImageUrl(input.imageUrl);
  const alt = validateText(
    input.alt,
    CONTENT_ALT_MAX_LENGTH,
    CONTENT_ALT_EMPTY_MESSAGE,
    CONTENT_ALT_TOO_LONG_MESSAGE,
  );
  const sortOrder = validateSortOrder(input.sortOrder);

  return {
    ...NO_IMAGE_ERRORS,
    title: title.ok ? null : title.message,
    imageUrl: imageUrl.ok ? null : imageUrl.message,
    alt: alt.ok ? null : alt.message,
    sortOrder: sortOrder.ok ? null : sortOrder.message,
  };
}

export function hasContentImageError(errors: ContentImageFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstContentImageErrorField(
  errors: ContentImageFieldErrors,
): ContentImageField | null {
  for (const field of Object.keys(CONTENT_IMAGE_FIELD_LABELS) as ContentImageField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 原始输入 → 公告的可编辑字段（**服务端写操作的唯一入口形状**）。
 *
 * 返回 `null` 表示**校验没过**，调用方必须先 `contentImageFieldErrors()` 拿到
 * 逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能写进脏数据。
 */
export function normalizeAnnouncementProfilePatch(
  input: ContentImageInput,
): AdminAnnouncementProfilePatch | null {
  const fields = normalizeContentImageInput(input);
  return fields ? { ...fields } : null;
}

/** 同上，用于活动 Banner（字段完全相同，类型别名不同）。 */
export function normalizeBannerProfilePatch(
  input: ContentImageInput,
): AdminBannerProfilePatch | null {
  const fields = normalizeContentImageInput(input);
  return fields ? { ...fields } : null;
}

function normalizeContentImageInput(input: ContentImageInput): AdminAnnouncementProfilePatch | null {
  const errors = contentImageFieldErrors(input);
  if (hasContentImageError(errors)) return null;

  return {
    title: input.title.trim(),
    // 与校验看到的是同一个值：`validateImageUrl` 内部已经 trim 过，
    // 这里再 trim 一次是幂等的，写出来只是为了让「存进去的就是校验过的」看得见
    imageUrl: input.imageUrl.trim(),
    alt: input.alt.trim(),
    sortOrder: input.sortOrder,
    enabled: input.enabled,
  };
}

// ——————————————————————————— 快捷入口 ———————————————————————————

export const QUICK_ENTRY_FIELD_LABELS = {
  label: "入口名称",
  icon: "图标",
  path: "目标地址",
  sortOrder: "排序",
  enabled: "启用状态",
} as const;

export type QuickEntryField = keyof typeof QUICK_ENTRY_FIELD_LABELS;

export type QuickEntryFieldErrors = Record<QuickEntryField, string | null>;

const NO_QUICK_ENTRY_ERRORS: QuickEntryFieldErrors = {
  label: null,
  icon: null,
  path: null,
  sortOrder: null,
  enabled: null,
};

export type QuickEntryInput = {
  label: string;
  /** 原始值可能是任意字符串（来自表单），校验后才收窄成 `QuickEntryIcon` */
  icon: string;
  path: string;
  sortOrder: number;
  enabled: boolean;
};

/**
 * 目标地址的校验**直接复用 `validateSafePath()`**，只把错误文案换成入口语境。
 *
 * ⚠️ 刻意不在这里重写一遍「以 `/` 开头且不以 `//` 开头」：那是一条安全规则，
 * 全站只能有一处定义。复制一份到表单里，早晚会出现两处不一致，
 * 而不一致的那一侧就是漏洞所在。这里只做文案映射。
 */
function validateEntryPath(raw: string): FieldResult<string> {
  const result = validateSafePath(raw);
  if (result.ok) return result;

  if (result.message.includes("请填写")) {
    return { ok: false, message: "请填写目标地址" };
  }
  // `http:` / `data:` / `javascript:` 与 `//evil.example` 归为「必须是站内地址」，
  // 因为对填表的人来说，这几种填错的**修法是一样的**：改成一个以 / 开头的本站地址
  if (result.message.includes("站内")) {
    return { ok: false, message: "目标地址必须是本站路径（以 / 开头）" };
  }
  return { ok: false, message: "目标地址包含不允许的字符" };
}

export function quickEntryFieldErrors(input: QuickEntryInput): QuickEntryFieldErrors {
  const label = validateText(
    input.label,
    CONTENT_LABEL_MAX_LENGTH,
    CONTENT_LABEL_EMPTY_MESSAGE,
    CONTENT_LABEL_TOO_LONG_MESSAGE,
  );
  const icon = validateIcon(input.icon);
  const path = validateEntryPath(input.path);
  const sortOrder = validateSortOrder(input.sortOrder);

  return {
    ...NO_QUICK_ENTRY_ERRORS,
    label: label.ok ? null : label.message,
    icon: icon.ok ? null : icon.message,
    path: path.ok ? null : path.message,
    sortOrder: sortOrder.ok ? null : sortOrder.message,
  };
}

export function hasQuickEntryError(errors: QuickEntryFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

export function firstQuickEntryErrorField(errors: QuickEntryFieldErrors): QuickEntryField | null {
  for (const field of Object.keys(QUICK_ENTRY_FIELD_LABELS) as QuickEntryField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/** 原始输入 → 快捷入口的可编辑字段。校验没过返回 null。 */
export function normalizeQuickEntryProfilePatch(
  input: QuickEntryInput,
): AdminQuickEntryProfilePatch | null {
  const errors = quickEntryFieldErrors(input);
  if (hasQuickEntryError(errors)) return null;

  const icon = validateIcon(input.icon);
  const path = validateEntryPath(input.path);
  if (!icon.ok || !path.ok) return null;

  return {
    label: input.label.trim(),
    icon: icon.value,
    path: path.value,
    sortOrder: input.sortOrder,
    enabled: input.enabled,
  };
}

// ——————————————————————————— 共用规则 ———————————————————————————

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 启用状态变了就记「启用 / 停用」，否则记「编辑」。
 * 「停用」既可能来自列表上的开关，也可能来自编辑表单里把勾去掉，
 * 两者记的都是同一件事——审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」。
 *
 * ⚠️ 用**目标类型前缀**拼出动作名（`announcement.enable`），而不是让三个模块各写一遍
 * 三个分支：三组内容的动作名形状完全一致，写三遍就是给将来留三个会漂移的位置。
 */
export function contentActionFromEnabled(
  target: "announcement" | "banner" | "quickEntry",
  previousEnabled: boolean,
  nextEnabled: boolean,
): AdminAuditAction {
  if (previousEnabled === nextEnabled) return `${target}.update` as AdminAuditAction;
  return `${target}.${nextEnabled ? "enable" : "disable"}` as AdminAuditAction;
}

/** 图片类内容的编辑是否什么都没改。没改就不写数据、也不写审计。 */
export function isContentImageUnchanged(
  previous: { title: string; imageUrl: string; alt: string; sortOrder: number; enabled: boolean },
  patch: AdminAnnouncementProfilePatch,
): boolean {
  return (
    previous.title === patch.title &&
    previous.imageUrl === patch.imageUrl &&
    previous.alt === patch.alt &&
    previous.sortOrder === patch.sortOrder &&
    previous.enabled === patch.enabled
  );
}

/** 快捷入口的编辑是否什么都没改。 */
export function isQuickEntryUnchanged(
  previous: QuickEntryInput & { enabled: boolean },
  patch: AdminQuickEntryProfilePatch,
): boolean {
  return (
    previous.label === patch.label &&
    previous.icon === patch.icon &&
    previous.path === patch.path &&
    previous.sortOrder === patch.sortOrder &&
    previous.enabled === patch.enabled
  );
}

/**
 * 一条运营内容在后台眼里的状态。**三个取值互斥且有序**：
 * 已移除 > 已停用 > 已启用。
 *
 * §十一 要求**状态不能只靠颜色表达**，因此每一条记录都必然带一句可读的文字。
 */
export type AdminContentStatusKey = "removed" | "disabled" | "enabled";

export type AdminContentStatus = {
  key: AdminContentStatusKey;
  label: string;
  description: string;
};

const CONTENT_STATUS_TEXT: Record<
  AdminContentStatusKey,
  { label: string; description: string }
> = {
  removed: { label: "已移除", description: "用户端不可见，记录保留可回查" },
  disabled: { label: "已停用", description: "用户端看不到，随时可以重新启用" },
  enabled: { label: "已启用", description: "用户端可见" },
};

export function adminContentStatus(record: {
  enabled: boolean;
  removedAt: string | null;
}): AdminContentStatus {
  const key: AdminContentStatusKey =
    record.removedAt !== null ? "removed" : record.enabled ? "enabled" : "disabled";

  return { key, ...CONTENT_STATUS_TEXT[key] };
}

/** 列表角标：全部 / 已启用 / 已停用 / 已移除。四个数加起来等于记录总数。 */
export function countAdminContentStates(
  records: readonly { enabled: boolean; removedAt: string | null }[],
): { all: number; enabled: number; disabled: number; removed: number } {
  let enabled = 0;
  let disabled = 0;
  let removed = 0;

  for (const record of records) {
    if (record.removedAt !== null) {
      removed += 1;
      continue;
    }
    if (record.enabled) enabled += 1;
    else disabled += 1;
  }

  return { all: records.length, enabled, disabled, removed };
}

/** 后台列表筛选：是否包含已移除的记录（默认不包含，要看得显式选）。 */
export type ContentRemovalFilter = "active" | "removed";

export function resolveContentRemovalFilter(raw: string | null): ContentRemovalFilter {
  return raw === "removed" ? "removed" : "active";
}

export function filterContentForAdmin<
  T extends { enabled: boolean; removedAt: string | null },
>(records: readonly T[], removal: ContentRemovalFilter): T[] {
  return records.filter((record) => (removal === "removed") === (record.removedAt !== null));
}

/** 快捷入口地址是否可用。后台表单与测试共用，避免各处自己判一遍。 */
export { isSafePath };
