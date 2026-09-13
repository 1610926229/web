import type { ConsumptionPrivilege } from "@/lib/types/level";

/**
 * 权益清单（**说明性展示**）。
 *
 * ⚠️ 这里只把名称与一句说明画出来，**没有任何可执行动作**：没有「立即使用」按钮、
 * 没有折扣率、没有次数、没有金额。本阶段不实现自动折扣、优先派单、专属客服、
 * 赠券或返现，因此界面上也不应该出现任何暗示这些动作存在的东西。
 *
 * 权益条目本身来自 Mock 等级配置（`lib/mocks/fixtures/levelSeed.ts`），
 * 不是写死在组件里的常量：将来管理者改配置，这里跟着变。
 */
export default function PrivilegeList({
  privileges,
  tone = "light",
  emptyText = "该等级暂未配置权益。",
}: {
  privileges: readonly ConsumptionPrivilege[];
  tone?: "hero" | "light";
  emptyText?: string;
}) {
  if (privileges.length === 0) {
    return (
      <p className={`text-[12px] leading-5 ${tone === "hero" ? "text-mine-hero-ink-soft" : "text-ink-3"}`}>
        {emptyText}
      </p>
    );
  }

  const labelClass = tone === "hero" ? "text-mine-hero-ink" : "text-ink";
  const descClass = tone === "hero" ? "text-mine-hero-ink-soft" : "text-ink-3";
  const bulletClass = tone === "hero" ? "bg-mine-hero-ink-soft" : "bg-mine-grid-icon";

  return (
    <ul className="flex flex-col gap-2">
      {privileges.map((privilege) => (
        <li key={privilege.id} className="flex gap-2">
          <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${bulletClass}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className={`text-[13px] leading-5 ${labelClass}`}>{privilege.label}</p>
            <p className={`text-[12px] leading-4 ${descClass}`}>{privilege.description}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
