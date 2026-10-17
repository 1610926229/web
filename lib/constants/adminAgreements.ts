import { countCharacters } from "@/lib/utils/text";
import { agreementTypeLabel, compareAgreementVersion } from "./agreements";
import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminAgreementDetail,
  AdminAgreementListItem,
  AdminAgreementProfilePatch,
  AdminAgreementWriteResult,
  Agreement,
  AgreementSection,
  AgreementType,
} from "@/lib/types/agreement";

/**
 * 协议正文的**后台**校验规则、错误文案与 DTO 转换（**纯逻辑，服务端与浏览器共用**）。
 *
 * ⚠️ 本文件只有 `import type` 与两个纯函数模块（`lib/utils/text`、`./agreements`），
 * 没有任何运行时服务端依赖：管理端表单可以在浏览器里直接用它做字段级提示，
 * node 也能直接加载它做纯逻辑测试，两边看到的是**同一份**规则。
 *
 * 三条贯穿全文件的判断：
 *
 * 1. **正文只能是纯文本**。不是「接受 HTML 再清洗」，而是**根本不接受 HTML**：
 *    页面按段落纯文本渲染，没有任何 sanitizer，因此校验这边一旦放行，
 *    就是直接把不受控内容送进用户端。含 `<` 或 `>` 一律判非法，
 *    理由与 `lib/types/agreement.ts` 里的模型选择是同一条。
 * 2. **校验与写入看到的是同一个字符串**。所有 `normalize*()` 返回的都是
 *    `trim()` 之后的值，「校验的是 A、存的是 B」正是 `" <p> "` 这类绕过校验的入口。
 * 3. **服务端字段在入参里没有位置**。`id` / `type` / `version` / `updatedAt`
 *    一个都不在这里，客户端多传一个也不会有任何效果（§九）。
 *
 * 版本号**不在**这里计算：它由写入的那一刻的原子区段决定
 * （见 `lib/data/adminAgreementTransaction.ts`），本文件只提供「内容变了没有」这个判断。
 */

// ——————————————————————————— 上限与文案 ———————————————————————————

/**
 * 上限常量集中在这里，不散落到服务层与表单里各写一遍数字：
 * 「表单说没超、服务端说超了」这种错配的根源就是两处各有一份上限。
 */
export const AGREEMENT_TITLE_MAX_LENGTH = 40;

/** 一节的小标题。可以为空串（表示该块没有小标题），但填了就不能太长。 */
export const AGREEMENT_SECTION_HEADING_MAX_LENGTH = 60;

export const AGREEMENT_SECTION_MAX_COUNT = 60;
export const AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT = 60;
export const AGREEMENT_PARAGRAPH_MAX_LENGTH = 2000;

/**
 * 正文至少要有一节。
 *
 * ⚠️ 有下限而不只有上限，是因为协议**保存即生效**：一个启用的协议如果没有正文，
 * 用户端打开就是一个只有标题的空白页。要「下架」一份协议应当走**停用**
 * （用户端显示「内容暂未配置」，可逆），而不是把正文清空——后者看起来同样是
 * 「页面空了」，但后台里那条记录仍然显示「已启用」，两边对不上。
 */
export const AGREEMENT_SECTION_MIN_COUNT = 1;

export const AGREEMENT_TITLE_EMPTY_MESSAGE = "请填写协议标题";
export const AGREEMENT_TITLE_TOO_LONG_MESSAGE = `协议标题不能超过 ${AGREEMENT_TITLE_MAX_LENGTH} 个字符`;
export const AGREEMENT_SECTIONS_EMPTY_MESSAGE = "正文至少要有一节";
export const AGREEMENT_SECTIONS_TOO_MANY_MESSAGE = `正文不能超过 ${AGREEMENT_SECTION_MAX_COUNT} 节`;
export const AGREEMENT_HEADING_TOO_LONG_MESSAGE = `小标题不能超过 ${AGREEMENT_SECTION_HEADING_MAX_LENGTH} 个字符`;
export const AGREEMENT_PARAGRAPHS_EMPTY_MESSAGE = "每一节至少要有一段正文";
export const AGREEMENT_PARAGRAPHS_TOO_MANY_MESSAGE = `每一节不能超过 ${AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT} 段`;
export const AGREEMENT_PARAGRAPH_EMPTY_MESSAGE = "正文段落不能为空，请删除空白段落";
export const AGREEMENT_PARAGRAPH_TOO_LONG_MESSAGE = `单段正文不能超过 ${AGREEMENT_PARAGRAPH_MAX_LENGTH} 个字符`;

/**
 * 拒绝 HTML 的文案。
 *
 * ⚠️ 这句话要说清「为什么不接受」：填写的人多半是**以为**后台支持富文本，
 * 只回一句「格式错误」他会继续试各种各样的写法。说明「只收纯文本」之后，
 * 他知道该把 `<p>` 删掉。
 */
export const AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE =
  "协议正文只支持纯文本，请勿填写 HTML 标签（如 <p>、<br>、<strong>）；小标题与段落都按纯文本展示。";

/**
 * 列表页顶部的一句话。
 *
 * ⚠️ 这不是装饰文案：后台最容易犯的错是以为「这里的改动只影响后台」，
 * 而实际上用户端协议页读的就是这一份数据。
 */
export const ADMIN_AGREEMENT_LIST_NOTICE =
  "这里的改动会立即影响用户端「相关协议」页——后台与用户端读的是同一份数据；保存正文会递增版本号，用户端显示的版本随之更新。";

// ——————————————————————————— 管理端服务错误文案 ———————————————————————————

/**
 * 与类目管理同一套写法：错误文案是常量，服务层只负责把它们映射成 `ApiError`。
 * 前端拿到 message 时看到的与后台表单里写的是同一句话。
 */
export const ADMIN_AGREEMENT_NOT_FOUND_MESSAGE = "协议不存在";
export const ADMIN_AGREEMENT_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_AGREEMENT_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";

/** 「校验没过但拿不到具体字段」时的兜底文案：正常路径上不会走到，走到说明接线错了。 */
export const ADMIN_AGREEMENT_PROFILE_INVALID_MESSAGE = "协议内容校验未通过，请检查表单";

// ——————————————————————————— 入参形状与校验 ———————————————————————————

/** 表单/接口里的一节正文（原始值都是字符串，校验后才收窄）。 */
export type AgreementSectionInput = {
  heading: string;
  paragraphs: string[];
};

export type AgreementProfileInput = {
  title: string;
  sections: readonly AgreementSectionInput[];
  enabled: boolean;
};

/** 表单字段名。与页面的 `aria-invalid` / 聚焦定位一一对应。 */
export const AGREEMENT_PROFILE_FIELD_LABELS = {
  title: "协议标题",
  sections: "正文",
  enabled: "启用状态",
} as const;

export type AgreementProfileField = keyof typeof AGREEMENT_PROFILE_FIELD_LABELS;

export type AgreementProfileFieldErrors = Record<AgreementProfileField, string | null>;

/**
 * 纯文本判定：出现 `<` 或 `>` 即判为非法。
 *
 * ⚠️ 刻意**不写成「匹配 HTML 标签的正则」**。那种写法要判断「像不像一个标签」，
 * 于是 `<p`、`< p>`、`<script` 这些边角写法就得逐条猜——而本阶段的规则根本不需要猜：
 * 正文是纯文本，`<` 与 `>` 这两个字符在纯文本里就没有出现的理由
 * （中文正文里的书名号是《》，不是 <>）。因此宁可错杀一个想写「1<2」的人，
 * 也不能放过一个 `<img onerror=…>`。
 *
 * 小标题与段落**用同一把尺**：两者都是按纯文本渲染的用户可见文本，
 * 标题能写 HTML 而段落不能，只会让人以为正文支持富文本。
 */
export function containsMarkup(text: string): boolean {
  return text.includes("<") || text.includes(">");
}

/**
 * 单段正文的校验：非空、不含标签、不超长。
 *
 * ⚠️ **空段落一律非法**，没有「允许为空」的选项：空段落在页面上会渲染出一个空行块。
 * 小标题那一位才允许空串（表示该块没有小标题），它是另一条判断，不共用这个函数。
 */
function validateParagraph(raw: string): string | null {
  const value = raw.trim();
  if (!value) return AGREEMENT_PARAGRAPH_EMPTY_MESSAGE;
  if (containsMarkup(value)) return AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE;
  if (countCharacters(value) > AGREEMENT_PARAGRAPH_MAX_LENGTH) {
    return AGREEMENT_PARAGRAPH_TOO_LONG_MESSAGE;
  }
  return null;
}

/**
 * 正文整体的校验，返回**第一条**错误。
 *
 * 顺序即页面的字段顺序（节 → 该节的小标题 → 该节的段落），
 * 因此「第一条错误」就是「最靠上的那条」，与表单的字段级提示一致。
 */
function validateSections(sections: readonly AgreementSectionInput[]): string | null {
  if (sections.length < AGREEMENT_SECTION_MIN_COUNT) return AGREEMENT_SECTIONS_EMPTY_MESSAGE;
  if (sections.length > AGREEMENT_SECTION_MAX_COUNT) return AGREEMENT_SECTIONS_TOO_MANY_MESSAGE;

  for (const section of sections) {
    const heading = section.heading.trim();
    if (heading) {
      if (containsMarkup(heading)) return AGREEMENT_MARKUP_NOT_ALLOWED_MESSAGE;
      if (countCharacters(heading) > AGREEMENT_SECTION_HEADING_MAX_LENGTH) {
        return AGREEMENT_HEADING_TOO_LONG_MESSAGE;
      }
    }

    if (section.paragraphs.length === 0) return AGREEMENT_PARAGRAPHS_EMPTY_MESSAGE;
    if (section.paragraphs.length > AGREEMENT_SECTION_PARAGRAPH_MAX_COUNT) {
      return AGREEMENT_PARAGRAPHS_TOO_MANY_MESSAGE;
    }

    for (const paragraph of section.paragraphs) {
      const error = validateParagraph(paragraph);
      if (error) return error;
    }
  }

  return null;
}

/**
 * 推导表单各字段的错误。
 *
 * `enabled` 在这个表里但**永远为 null**：它是一个勾选框，没有「填错」这种状态。
 * 留在表里是为了让页面的字段遍历与错误定位不必为它开一个特例
 * （与 `lib/constants/adminContent.ts` 的 `contentImageFieldErrors` 同）。
 */
export function agreementProfileFieldErrors(
  input: AgreementProfileInput,
): AgreementProfileFieldErrors {
  const title = input.title.trim();

  return {
    title: !title
      ? AGREEMENT_TITLE_EMPTY_MESSAGE
      : countCharacters(title) > AGREEMENT_TITLE_MAX_LENGTH
        ? AGREEMENT_TITLE_TOO_LONG_MESSAGE
        : null,
    sections: validateSections(input.sections),
    enabled: null,
  };
}

export function hasAgreementProfileError(errors: AgreementProfileFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstAgreementProfileErrorField(
  errors: AgreementProfileFieldErrors,
): AgreementProfileField | null {
  for (const field of Object.keys(AGREEMENT_PROFILE_FIELD_LABELS) as AgreementProfileField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 原始输入 → 可写入的协议字段（**服务端写操作的唯一入口形状**）。
 *
 * 返回 `null` 表示**校验没过**，调用方必须先 `agreementProfileFieldErrors()`
 * 拿到逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能写进脏数据。
 *
 * ⚠️ 返回的段落是**深拷贝**：调用方之后改自己手上的数组，不会动到要写进去的那一份。
 */
export function normalizeAgreementProfilePatch(
  input: AgreementProfileInput,
): AdminAgreementProfilePatch | null {
  if (hasAgreementProfileError(agreementProfileFieldErrors(input))) return null;

  return {
    title: input.title.trim(),
    sections: input.sections.map((section) => ({
      heading: section.heading.trim(),
      paragraphs: section.paragraphs.map((paragraph) => paragraph.trim()),
    })),
    enabled: input.enabled,
  };
}

// ——————————————————————————— 内容是否变过 ———————————————————————————

/**
 * 标题与正文是否与现状完全一致。
 *
 * ⚠️ **不比较 JSON 字符串**：字符串比较会把字段顺序也算进差异，于是「同一个值的两种
 * 拼法」看起来像一次改动，凭空多出一条审计、并把版本号推高一格
 * （与 `lib/constants/adminContent.ts` 的 `isContentImageUnchanged` 同）。
 *
 * ⚠️ 也**不把 `enabled` 算进「内容」**：启用状态不是正文的一部分，
 * 只改它不该递增版本号（见 `lib/data/adminAgreementTransaction.ts`）。
 */
export function isAgreementContentUnchanged(
  previous: Pick<Agreement, "title" | "sections">,
  patch: Pick<AdminAgreementProfilePatch, "title" | "sections">,
): boolean {
  if (previous.title !== patch.title) return false;
  if (previous.sections.length !== patch.sections.length) return false;

  return previous.sections.every((section, index) => {
    const next = patch.sections[index];
    if (!next) return false;
    if (section.heading !== next.heading) return false;
    if (section.paragraphs.length !== next.paragraphs.length) return false;
    return section.paragraphs.every((paragraph, i) => paragraph === next.paragraphs[i]);
  });
}

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 启用状态变了就记「启用 / 停用」，否则记「编辑」；**两者同时变时以启停为准**——
 * 与 `lib/constants/adminContent.ts` 的 `contentActionFromEnabled` 同一个口径。
 * 理由也相同：「停用」既可能来自列表上的开关，也可能来自编辑表单里把勾去掉，
 * 两者记的都是同一件事。审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」。
 *
 * ⚠️ 不直接复用 `contentActionFromEnabled()`：它的目标类型收窄在
 * `"announcement" | "banner" | "quickEntry"` 三个取值上，协议不在其中。
 * 与其把那个联合类型改宽（动的是别人已经交付的文件），不如在这里写一个
 * **同样的判断**——三个分支的形状是稳定的，而跨模块的参数类型不是。
 */
export function agreementActionFromEnabled(
  previousEnabled: boolean,
  nextEnabled: boolean,
): AdminAuditAction {
  if (previousEnabled === nextEnabled) return "agreement.update";
  return nextEnabled ? "agreement.enable" : "agreement.disable";
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 段落总数。列表与审计快照用的是同一个口径。 */
function countParagraphs(sections: readonly AgreementSection[]): number {
  return sections.reduce((total, section) => total + section.paragraphs.length, 0);
}

/** 段落深拷贝：DTO 与仓储数据不共享可变对象，调用方改不动服务端数据。 */
function cloneSections(sections: readonly AgreementSection[]): AgreementSection[] {
  return sections.map((section) => ({
    heading: section.heading,
    paragraphs: [...section.paragraphs],
  }));
}

/** 仓储实体 → 管理端列表行。**显式挑字段**：正文不在这里。 */
export function toAdminAgreementListItem(record: Agreement): AdminAgreementListItem {
  return {
    id: record.id,
    type: record.type,
    typeLabel: agreementTypeLabel(record.type),
    title: record.title,
    version: record.version,
    enabled: record.enabled,
    updatedAt: record.updatedAt,
    sectionCount: record.sections.length,
    paragraphCount: countParagraphs(record.sections),
  };
}

/** 仓储实体 → 管理端详情（列表行 + 正文副本）。编辑表单读的是它。 */
export function toAdminAgreementDetail(record: Agreement): AdminAgreementDetail {
  return { ...toAdminAgreementListItem(record), sections: cloneSections(record.sections) };
}

/** 写入结果 → 接口结果。界面据此就地更新那一行，不必重拉整页。 */
export function toAdminAgreementWriteResult(
  agreementId: string,
  updated: Pick<Agreement, "version" | "enabled" | "updatedAt">,
  changed: boolean,
): AdminAgreementWriteResult {
  return {
    agreementId,
    version: updated.version,
    enabled: updated.enabled,
    updatedAt: updated.updatedAt,
    changed,
  };
}

/**
 * 列表排序：按 `types` 给出的顺序（即页签顺序）。
 *
 * ⚠️ 不能依赖仓储的返回顺序：那里是 Map 的插入顺序，也就是**预置数据在种子文件里
 * 被书写的顺序**，它恰好与页签顺序一致纯属巧合——种子文件里加一条、挪一行，
 * 后台列表的顺序就会莫名其妙地变。页签顺序是产品规则，必须显式排一次。
 *
 * 同类型有多条时（历史版本）**高版本在前**：后台一眼就能看到「当前生效的是哪一版」。
 * 版本相同再按 id 兜底，让顺序在任何输入下都确定——不确定的顺序会让
 * 「列表第 2 行是哪一个」变成一个没人能复现的问题。
 */
export function sortAgreementsForAdmin(
  records: readonly Agreement[],
  types: readonly AgreementType[],
): Agreement[] {
  return [...records].sort((left, right) => {
    const byType = types.indexOf(left.type) - types.indexOf(right.type);
    if (byType !== 0) return byType;

    const byVersion = compareAgreementVersion(right.version, left.version);
    if (byVersion !== 0) return byVersion;

    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
