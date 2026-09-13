"use client";

import { useId, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  AGREEMENT_MISSING_DESCRIPTION,
  AGREEMENT_MISSING_MESSAGE,
  formatAgreementVersion,
} from "@/lib/constants/agreements";
import type { AgreementType, AgreementsDto } from "@/lib/types/agreement";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 协议与版本介绍（四类内容用页签切换）。
 *
 * 四类内容**一次全部取回**，页签切换纯客户端完成：协议正文是少量文本，
 * 每切一次就发一次请求既没有必要，也会让「切页签」变成一个可能失败的异步动作。
 *
 * 正文渲染方式：`sections` → 小标题 + 若干段落。**没有**富文本编辑器、没有
 * `dangerouslySetInnerHTML`，段落按纯文本渲染，因此 Mock 文案里不可能夹带可执行内容。
 *
 * 某一类没有内容时**只让那一块显示「内容暂未配置」**，其余页签照常可切换、
 * 照常显示——缺一类内容不该把整页变成错误页。
 *
 * 页面本身也没有任何编辑入口：正文将来只有管理者能在 PC 管理后台修改，
 * 普通用户只能查看。
 */
export default function AgreementTabs({ dto }: { dto: AgreementsDto }) {
  // 默认停在第一个**有内容**的类型：四类都缺时退回第一类，由内容区说明未配置
  const firstAvailable = dto.tabs.find((tab) => tab.agreement)?.type ?? dto.tabs[0]?.type ?? "user";
  const [active, setActive] = useState<AgreementType>(firstAvailable);
  const panelId = useId();

  const current = dto.tabs.find((tab) => tab.type === active) ?? null;

  return (
    <div className="flex flex-1 flex-col bg-surface">
      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="协议类型">
          {dto.tabs.map((tab) => {
            const selected = tab.type === active;
            return (
              <button
                key={tab.type}
                type="button"
                role="tab"
                id={`${panelId}-tab-${tab.type}`}
                aria-selected={selected}
                aria-controls={`${panelId}-panel`}
                onClick={() => setActive(tab.type)}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] leading-5 ${
                  selected ? "seg-tab-active font-medium" : "bg-page text-ink-2"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={`${panelId}-panel`}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${active}`}
        className="flex flex-1 flex-col px-4 py-4"
      >
        {/* 内容性质说明：示例文案，不是正式生效的法律协议。这句话在四类内容上都出现 */}
        <p className="rounded-[10px] bg-page px-3 py-2 text-[12px] leading-5 text-ink-3">
          {dto.notice}
        </p>

        {current && current.agreement ? (
          <AgreementContent agreement={current.agreement} />
        ) : (
          <div className="flex flex-1 items-center justify-center py-12">
            <EmptyState title={AGREEMENT_MISSING_MESSAGE} description={AGREEMENT_MISSING_DESCRIPTION} />
          </div>
        )}
      </div>
    </div>
  );
}

function AgreementContent({
  agreement,
}: {
  agreement: NonNullable<AgreementsDto["tabs"][number]["agreement"]>;
}) {
  return (
    <article className="mt-3 flex flex-col gap-4 pb-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-ink">{agreement.title}</h2>
        <p className="text-[12px] leading-5 text-ink-3">
          版本 {formatAgreementVersion(agreement.version)} · 更新于{" "}
          {formatDateTime(agreement.updatedAt)}
        </p>
      </header>

      {/* 段落按纯文本渲染，不走 HTML 注入 */}
      {agreement.sections.map((section, sectionIndex) => (
        <section key={`${agreement.id}-${sectionIndex}`} className="flex flex-col gap-1.5">
          {section.heading ? (
            <h3 className="text-[14px] font-medium text-ink">{section.heading}</h3>
          ) : null}
          {section.paragraphs.map((paragraph, paragraphIndex) => (
            <p
              key={`${agreement.id}-${sectionIndex}-${paragraphIndex}`}
              className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-2"
            >
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
