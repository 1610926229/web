import { EVIDENCE_PLACEHOLDER_URL } from "@/lib/constants/evidence";
import { SUGGESTION_TYPE_LABELS } from "@/lib/constants/suggestions";
import type { SupportEvidence } from "@/lib/types/evidence";
import type { Suggestion, SuggestionStatus, SuggestionTypeKey } from "@/lib/types/suggestion";

/**
 * 预置意见反馈种子。
 *
 * ⚠️ 全部为 Mock 数据：正文统一带「（Mock 文案）」，凭证指向 `public/mock` 下的本地占位图。
 * 任何人都能一眼看出这不是真实用户反馈。
 *
 * **平台回复只能出现在这里**（或将来后台的返回）：`reply` 与 `repliedAt` 是平台侧的字段，
 * 用户端没有任何入口能写入。回复内容刻意**不含**奖励、补偿、返现、排期承诺——
 * 那些结论平台还没有确认，写进预置数据就会被当成已经答应过用户的事。
 *
 * 种子要覆盖的边界：
 * - 三个状态各至少一条（已提交 / 已回复 / 已关闭）；
 * - 有一条**没有回复**（已提交、已关闭各有一种「没有回复」的样子）；
 * - 有一条**没有凭证**（凭证是选填）；
 * - 有一条带联系方式、一条不带；
 * - 老板B 一条反馈都没有 → 空态不需要额外的调试开关就能看到（原型就是空态）。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

type PresetSuggestionInput = {
  id: string;
  userId: string;
  typeKey: SuggestionTypeKey;
  content: string;
  createdAt: string;
  status: SuggestionStatus;
  /** 平台回复；不填表示还没有回复 */
  reply?: string;
  /** 回复时间；填了 reply 就必须填它 */
  repliedAt?: string;
  contact?: string;
  /** 凭证文件名；地址一律写成占位图 */
  evidenceNames?: string[];
};

function build(input: PresetSuggestionInput): Suggestion {
  const reply = input.reply ?? "";

  // 两条不变量：有回复就必须有回复时间，没有回复就不能留下回复时间。
  // 少了这两句，列表上就会出现「已回复但没有时间」或「没有回复却有回复时间」这种无法解释的卡片。
  if (reply && !input.repliedAt) throw new Error(`预置反馈 ${input.id} 有回复但没有回复时间`);
  if (!reply && input.repliedAt) throw new Error(`预置反馈 ${input.id} 没有回复却有回复时间`);
  if (input.repliedAt && Date.parse(input.repliedAt) < Date.parse(input.createdAt)) {
    throw new Error(`预置反馈 ${input.id} 的回复时间早于提交时间`);
  }

  const evidence: SupportEvidence[] = (input.evidenceNames ?? []).map((name, index) => ({
    id: `${input.id}-ev-${index + 1}`,
    kind: "image",
    name,
    url: EVIDENCE_PLACEHOLDER_URL,
  }));

  return {
    id: input.id,
    userId: input.userId,
    typeKey: input.typeKey,
    typeLabel: SUGGESTION_TYPE_LABELS[input.typeKey] ?? input.typeKey,
    content: input.content,
    contact: input.contact ?? "",
    evidence,
    status: input.status,
    reply,
    repliedAt: input.repliedAt ?? null,
    createdAt: input.createdAt,
  };
}

export const suggestionSeed: Suggestion[] = [
  build({
    id: "sug-seed-1001-01",
    userId: "u-1001",
    typeKey: "feature",
    content:
      "希望订单列表可以按打手筛选，常找的那几个能直接选出来，不用每次翻。另外如果能记住上次的筛选条件就更好了。（Mock 文案）",
    createdAt: "2026-09-09T10:20:00.000Z",
    status: "replied",
    // 回复只描述「记下了、会评估」，不承诺排期，也不承诺任何回报
    reply: "谢谢建议，需求已记录并转给产品评估。具体是否有排期会在版本说明里同步。（Mock 回复）",
    repliedAt: "2026-09-11T02:30:00.000Z",
    evidenceNames: ["order-filter.png"],
  }),
  build({
    id: "sug-seed-1001-02",
    userId: "u-1001",
    typeKey: "experience",
    content:
      "在商品详情页上下滑动时，底部的下单按钮偶尔会挡住规格的最后一行，希望留一点间距。（Mock 文案）",
    createdAt: "2026-09-12T08:05:00.000Z",
    status: "submitted",
    // 没有凭证：凭证是选填的，这一条用来验证列表在无凭证时的版式
  }),
  build({
    id: "sug-seed-1001-03",
    userId: "u-1001",
    typeKey: "other",
    content: "想问问有没有大屏端的入口，手机上看得有点费劲。（Mock 文案）",
    createdAt: "2026-05-18T13:40:00.000Z",
    status: "closed",
    reply: "目前只有手机端，大屏端暂时没有计划，本次反馈先关闭；后续如果有变化会再同步。（Mock 回复）",
    repliedAt: "2026-05-20T01:10:00.000Z",
    contact: "见账号绑定手机",
    evidenceNames: ["screen-note.png"],
  }),
];
