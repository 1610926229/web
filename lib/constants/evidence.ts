import type { EvidenceKind, SupportEvidence } from "@/lib/types/evidence";

/**
 * 售后凭证的约束与解析（退款申请与投诉共用）。
 *
 * ⚠️ 本文件只有 `import type`，没有任何运行时依赖，因此可以被客户端组件引用，
 * 也可以被 node 直接加载做纯逻辑测试。
 *
 * 关键规则：**客户端只提交「类型 + 文件名」**，`id` 与 `url` 一律由服务端生成。
 * 这样客户端既不能塞进任意外链，也不会把用户机器上的本地路径当成正式地址写入数据。
 */

export const EVIDENCE_MAX_COUNT = 6;

export const EVIDENCE_NAME_MAX_LENGTH = 60;

/** 凭证占位地址：接入对象存储前，所有凭证都指向这张本地 Mock 图。 */
export const EVIDENCE_PLACEHOLDER_URL = "/mock/evidence-placeholder.svg";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["image", "video"];

export const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  image: "图片",
  video: "视频",
};

export const EVIDENCE_INVALID_KIND_MESSAGE = "凭证类型只支持图片或视频";
export const EVIDENCE_TOO_MANY_MESSAGE = `最多上传 ${EVIDENCE_MAX_COUNT} 个凭证`;
export const EVIDENCE_NAME_TOO_LONG_MESSAGE = `凭证文件名不能超过 ${EVIDENCE_NAME_MAX_LENGTH} 个字符`;

/**
 * 数量上限的提示文案。
 *
 * 评价与建议各有一个更小的上限（见 `REVIEW_EVIDENCE_MAX_COUNT` /
 * `SUGGESTION_EVIDENCE_MAX_COUNT`），文案因此必须跟着实际上限走——
 * 否则会出现「最多上传 6 个凭证」而实际第 5 个就被拦下来的自相矛盾提示。
 */
export function evidenceTooManyMessage(maxCount: number): string {
  return `最多上传 ${maxCount} 个凭证`;
}

/**
 * 「这种类型这里不收」的提示文案。
 *
 * 与 `EVIDENCE_INVALID_KIND_MESSAGE` 的区别：那一句是**根本不存在的类型**（比如 `audio`），
 * 这一句是类型本身合法、但这个表单不收（评价与建议只收图片）。
 * 两句话必须分开，否则用户会以为是自己传错了格式。
 */
export function evidenceKindNotAllowedMessage(kinds: readonly EvidenceKind[]): string {
  return `凭证只支持${kinds.map((kind) => EVIDENCE_KIND_LABELS[kind]).join("或")}`;
}

/** 规范化后的凭证：还没有 id 与地址，这两项由服务端补。 */
export type EvidenceDraft = { kind: EvidenceKind; name: string };

export type EvidenceParseResult =
  | { ok: true; items: EvidenceDraft[] }
  | { ok: false; message: string };

export function isEvidenceKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/**
 * 解析并校验凭证输入。
 *
 * 缺省（`null` / 非数组）按「没有上传凭证」处理——凭证本来就是选填。
 * 类型不合法、数量超限、文件名过长一律失败：这些是明确写错的内容，静默丢弃会让用户
 * 以为凭证已经上传成功。
 *
 * `maxCount`：评价与建议各有一个更小的上限，传入后**前后端与提示文案用的是同一个数**。
 * `kinds`：这个表单收哪些类型（评价与建议只收图片）。界面上的「添加」入口用的是同一份取值，
 * 因此正常操作不可能提交到这里被拒；这一层挡的是绕过界面直接调接口的请求。
 */
export function parseEvidenceInput(
  raw: unknown,
  maxCount: number = EVIDENCE_MAX_COUNT,
  kinds: readonly EvidenceKind[] = EVIDENCE_KINDS,
): EvidenceParseResult {
  if (raw === null || raw === undefined) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, message: EVIDENCE_INVALID_KIND_MESSAGE };
  if (raw.length > maxCount) return { ok: false, message: evidenceTooManyMessage(maxCount) };

  const seen = new Set<string>();
  const items: EvidenceDraft[] = [];

  for (const entry of raw) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind.trim() : "";
    if (!isEvidenceKind(kind)) return { ok: false, message: EVIDENCE_INVALID_KIND_MESSAGE };
    if (!kinds.includes(kind)) return { ok: false, message: evidenceKindNotAllowedMessage(kinds) };

    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || name.length > EVIDENCE_NAME_MAX_LENGTH) {
      return { ok: false, message: EVIDENCE_NAME_TOO_LONG_MESSAGE };
    }

    // 同名同类型只保留一条，避免用户重复点「添加」把同一张图算成多份
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, name });
  }

  // 去重后仍可能超限（同名同类型的重复项不占额度，因此这里再判一次是必要的）
  if (items.length > maxCount) return { ok: false, message: evidenceTooManyMessage(maxCount) };
  return { ok: true, items };
}

/** 凭证草稿 → 存储用凭证：`id` 与占位地址在这里生成，客户端无从指定。 */
export function toStoredEvidence(items: EvidenceDraft[]): SupportEvidence[] {
  return items.map((item) => ({
    id: `ev_${crypto.randomUUID()}`,
    kind: item.kind,
    name: item.name,
    url: EVIDENCE_PLACEHOLDER_URL,
  }));
}
