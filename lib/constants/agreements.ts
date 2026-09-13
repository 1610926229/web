/**
 * 协议与版本介绍的页签、版本选择与 DTO 转换规则（**纯逻辑，服务端与浏览器共用**）。
 *
 * ⚠️ 本文件只有 `import type`，没有任何运行时依赖：客户端组件引用它不会把服务端模块
 * 打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三件必须在明处的事：
 *
 * 1. **平台主体信息尚未提供**。正文里凡是出现主体名称、联系方式的位置一律使用明显的
 *    占位变量，**不编造**公司名称、注册地址、电话或统一社会信用代码。
 * 2. **内容是示例文案**。开发阶段的协议正文不构成正式生效的法律文件，
 *    页面上必须让用户看到这句话（`AGREEMENT_MOCK_NOTICE`）。
 * 3. **正文是结构化段落**，不是 HTML 字符串，因此页面没有不受控的注入面。
 */

import type {
  Agreement,
  AgreementDetail,
  AgreementSection,
  AgreementTab,
  AgreementType,
  AgreementsDto,
} from "@/lib/types/agreement";

/** 平台主体名称占位。取得正式工商名称前，正文里一律用它，不自行编造主体。 */
export const PLATFORM_ENTITY_PLACEHOLDER = "【平台主体名称待配置】";

/** 联系方式占位。电话、邮箱、地址同样属于尚未提供的法律信息。 */
export const PLATFORM_CONTACT_PLACEHOLDER = "【平台联系方式待配置】";

/**
 * 内容性质说明。页面上原样展示——把 Mock 文案呈现成正式法律协议是误导。
 */
export const AGREEMENT_MOCK_NOTICE =
  "以下内容为开发阶段的示例文案，不是正式生效的法律协议；平台主体名称、联系方式等信息尚未配置，正式版本以平台公布为准。";

/** 某个类型还没有配置启用内容时的说法。 */
export const AGREEMENT_MISSING_MESSAGE = "内容暂未配置";

/** 缺失类型的补充说明。 */
export const AGREEMENT_MISSING_DESCRIPTION =
  "该类型的协议内容尚未配置，其他类型不受影响。正式内容将在平台配置后展示。";

/** 四类内容的名称。**唯一一份**，页签与详情标题都用它，避免两边文案漂移。 */
export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  user: "用户协议",
  companion: "陪玩协议",
  platform: "平台协议",
  version: "版本介绍",
};

/** 页签顺序：与原型一致（用户协议 / 陪玩协议 / 平台协议 / 版本介绍）。 */
export const AGREEMENT_TYPES: readonly AgreementType[] = [
  "user",
  "companion",
  "platform",
  "version",
];

export const AGREEMENT_PAGE_TITLE = "相关协议";

export function agreementTypeLabel(type: AgreementType): string {
  return AGREEMENT_TYPE_LABELS[type];
}

/**
 * 版本号比较。
 *
 * 逐段按数字比较（`1.10.0` > `1.9.0`，这是字典序会搞错的地方）；
 * 段数不同时缺失段按 0 处理（`1.2` 与 `1.2.0` 等价）；
 * 无法解析成数字的段退化为字符串比较，保证仍有一个确定的顺序。
 * 完全相同时返回 0，让调用方用更新时间或 id 兜底。
 */
export function compareAgreementVersion(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? "0";
    const r = right[index] ?? "0";

    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln < rn ? -1 : 1;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }

  return 0;
}

/**
 * 挑出每个类型**当前启用**的那一版。
 *
 * 规则：只看 `enabled`；同类型有多个启用版本时取版本号最高的一版，
 * 版本号相同再用更新时间、最后用 id 兜底——顺序必须确定，
 * 否则同一份数据在两次请求里可能返回两个不同的版本。
 *
 * 历史版本（已停用）与较低版本都不会出现在结果里。
 */
export function pickCurrentAgreements(records: readonly Agreement[]): Map<AgreementType, Agreement> {
  const current = new Map<AgreementType, Agreement>();

  for (const record of records) {
    if (!record.enabled) continue;

    const existing = current.get(record.type);
    if (!existing || isNewerThan(record, existing)) current.set(record.type, record);
  }

  return current;
}

function isNewerThan(candidate: Agreement, incumbent: Agreement): boolean {
  const byVersion = compareAgreementVersion(candidate.version, incumbent.version);
  if (byVersion !== 0) return byVersion > 0;
  if (candidate.updatedAt !== incumbent.updatedAt) return candidate.updatedAt > incumbent.updatedAt;
  return candidate.id > incumbent.id;
}

/** 协议记录 → 对外详情。**显式挑字段**：`enabled` 不会外泄。 */
export function toAgreementDetail(record: Agreement): AgreementDetail {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    sections: cloneSections(record.sections),
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

/** 段落深拷贝：DTO 与仓储数据不共享可变对象，页面改不动服务端数据。 */
function cloneSections(sections: readonly AgreementSection[]): AgreementSection[] {
  return sections.map((section) => ({
    heading: section.heading,
    paragraphs: [...section.paragraphs],
  }));
}

/**
 * 组装接口 DTO：**固定四项**，缺内容的类型 `agreement` 为 null。
 *
 * 固定四项而不是「有几项返回几项」：页面页签是固定的四档，
 * 某类型缺失时显示「内容暂未配置」，其他类型照常可读，不会整页失败。
 */
export function buildAgreementsDto(records: readonly Agreement[]): AgreementsDto {
  const current = pickCurrentAgreements(records);

  const tabs: AgreementTab[] = AGREEMENT_TYPES.map((type) => {
    const record = current.get(type);
    return {
      type,
      label: agreementTypeLabel(type),
      agreement: record ? toAgreementDetail(record) : null,
    };
  });

  return { tabs, notice: AGREEMENT_MOCK_NOTICE };
}

/** 版本号的展示形式：`1.2.0` → `v1.2.0`。 */
export function formatAgreementVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
