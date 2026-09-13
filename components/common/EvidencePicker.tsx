"use client";

/* eslint-disable @next/next/no-img-element -- 凭证预览统一使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import {
  EVIDENCE_KINDS,
  EVIDENCE_KIND_LABELS,
  EVIDENCE_MAX_COUNT,
  EVIDENCE_NAME_MAX_LENGTH,
  EVIDENCE_NAME_TOO_LONG_MESSAGE,
  EVIDENCE_PLACEHOLDER_URL,
  evidenceTooManyMessage,
  type EvidenceDraft,
} from "@/lib/constants/evidence";
import type { EvidenceKind } from "@/lib/types/evidence";

/**
 * 售后凭证选择器（退款申请、投诉、评价与建议共用）。
 *
 * ⚠️ **只取文件名，不真的上传**：
 * - 选中的文件不会被读取、不会被上传、也不会产生任何地址；
 * - 提交给服务端的只有「类型 + 文件名」，凭证地址一律由服务端写成
 *   `EVIDENCE_PLACEHOLDER_URL` 指向的本地占位图。
 *
 * 这样处理的两个原因：当前阶段没有对象存储；同时**绝不把用户机器上的本地路径当成
 * 正式地址**存进数据里（那会在别的设备上变成一个打不开的地址）。
 *
 * 数量与文件名长度在提交前就按服务端的同一套常量校验，用户不会等到点了提交才被告知超限。
 *
 * `kinds` 决定显示哪几个「添加」入口：评价与建议只收图片（与服务端的
 * `parseEvidenceInput(raw, maxCount, kinds)` 传的是同一份取值），
 * 因此不会出现界面上能加视频、提交却被服务端拒掉的情况。
 */
export default function EvidencePicker({
  value,
  onChange,
  disabled = false,
  maxCount = EVIDENCE_MAX_COUNT,
  kinds = EVIDENCE_KINDS,
}: {
  value: EvidenceDraft[];
  onChange: (next: EvidenceDraft[]) => void;
  disabled?: boolean;
  /** 数量上限。评价与建议各有一个更小的上限，与服务端校验用的是同一个数。 */
  maxCount?: number;
  /** 允许添加的凭证类型。默认图片 + 视频（退款申请与投诉的现状）。 */
  kinds?: readonly EvidenceKind[];
}) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");

  function add(kind: EvidenceKind, file: File | undefined) {
    if (!file) return;

    const name = file.name.trim();
    if (!name || name.length > EVIDENCE_NAME_MAX_LENGTH) {
      // 与表单里的其他提示一样只显示在当前区域，不清空已经选好的凭证
      setError(EVIDENCE_NAME_TOO_LONG_MESSAGE);
      return;
    }
    // 同名同类型只算一条：重复点「添加」不会把同一张图算成多份
    if (value.some((item) => item.kind === kind && item.name === name)) {
      setError("");
      return;
    }
    if (value.length >= maxCount) {
      setError(evidenceTooManyMessage(maxCount));
      return;
    }

    setError("");
    onChange([...value, { kind, name }]);
  }

  function remove(index: number) {
    setError("");
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-2">凭证（选填）</span>
        <span className="text-[12px] text-ink-3">
          {value.length}/{maxCount}
        </span>
      </div>

      {value.length > 0 ? (
        <ul className="mt-2 grid grid-cols-3 gap-2">
          {value.map((item, index) => (
            <li key={`${item.kind}-${item.name}`} className="relative">
              <img
                src={EVIDENCE_PLACEHOLDER_URL}
                alt=""
                className="h-20 w-full rounded-[8px] border border-line object-cover"
              />
              <span className="mt-1 block truncate text-[11px] text-ink-3">
                {EVIDENCE_KIND_LABELS[item.kind]} · {item.name}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => remove(index)}
                aria-label={`移除凭证 ${item.name}`}
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-ink-3 text-[11px] leading-none text-white disabled:opacity-60"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex gap-2">
        {kinds.includes("image") ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => imageInputRef.current?.click()}
            className="flex-1 rounded-[8px] border border-dashed border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
          >
            ＋ 添加图片
          </button>
        ) : null}
        {kinds.includes("video") ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => videoInputRef.current?.click()}
            className="flex-1 rounded-[8px] border border-dashed border-line py-2 text-[13px] text-ink-2 disabled:opacity-60"
          >
            ＋ 添加视频
          </button>
        ) : null}
      </div>

      {/* 隐藏的 file input：只用来取文件名，选中后立刻清空，便于重复选择同一个文件 */}
      {kinds.includes("image") ? (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            add("image", event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      ) : null}
      {kinds.includes("video") ? (
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(event) => {
            add("video", event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      ) : null}

      <p className="mt-1.5 text-[11px] leading-4 text-ink-3">
        凭证仅保存在本地 Mock 数据中，不会真实上传；提交后以占位图展示。
      </p>

      {error ? (
        <p role="alert" className="mt-1 text-[12px] leading-4 text-brand-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
