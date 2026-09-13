import {
  LEVEL_ALL_TITLE,
  LEVEL_LIST_EMPTY_MESSAGE,
  formatThresholdText,
} from "@/lib/constants/levels";
import type { ConsumptionLevelView } from "@/lib/types/level";
import { formatYuan } from "@/lib/utils/format";
import PrivilegeList from "./PrivilegeList";

/**
 * 全部启用等级一览（含门槛与权益）。
 *
 * 数据是服务端排好序的 `ConsumptionLevelView[]`：**只有启用等级**、按阈值升序、
 * 内部配置字段（`enabled` / `createdAt` / `updatedAt`）根本不在类型里，
 * 因此停用等级不可能从这里漏出去。
 *
 * 当前等级用**文字标记**「当前」而不是只换颜色：颜色单靠自己是读不出来的信息。
 */
export default function LevelListView({
  levels,
  currentLevelId,
}: {
  levels: readonly ConsumptionLevelView[];
  /** 当前等级 id；配置不可用或没有当前等级时为 null */
  currentLevelId: string | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold text-ink">{LEVEL_ALL_TITLE}</h2>

      {levels.length === 0 ? (
        // 空列表就如实说空：**不补一个默认等级**来把页面填满
        <p className="rounded-[10px] border border-line bg-surface px-3 py-4 text-[13px] leading-5 text-ink-3">
          {LEVEL_LIST_EMPTY_MESSAGE}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {levels.map((level) => {
            const current = level.id === currentLevelId;
            return (
              <li
                key={level.id}
                className={`rounded-[10px] border bg-surface p-3 ${
                  current ? "border-mine-grid-icon" : "border-line"
                }`}
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <p className="text-[15px] font-semibold text-ink">{level.name}</p>
                  {current ? (
                    <span className="rounded-full border border-mine-grid-icon px-2 py-0.5 text-[11px] leading-4 text-mine-grid-icon">
                      当前
                    </span>
                  ) : null}
                  <span className="ml-auto text-[12px] text-ink-3">
                    {formatThresholdText(`¥${formatYuan(level.thresholdAmount)}`)}
                  </span>
                </div>

                <div className="mt-2">
                  {/* 权益只列名称与说明，不带任何可执行入口 */}
                  <PrivilegeList privileges={level.privileges} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
