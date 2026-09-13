import { COMPANION_SERVICE_TAGS } from "@/lib/constants/companionApplications";
import { EVIDENCE_PLACEHOLDER_URL } from "@/lib/constants/evidence";
import type {
  CompanionApplication,
  CompanionApplicationStatus,
} from "@/lib/types/companionApplication";
import type { EvidenceKind } from "@/lib/types/evidence";
import { gameSeed } from "./catalogSeed";
import { getMockSeedNow } from "./mockClock";
import { userSeed } from "./seed";

/**
 * 预置的护航入驻申请种子。
 *
 * 用途：把用户自己造不出来的状态补齐。用户端能造出来的只有「待查看」（提交）与
 * 「已撤销」（撤销）两种；`reviewing` / `approved` / `rejected` **只能来自预置数据**
 * （或将来后台的返回）。没有这份种子，「审核中 / 已通过 / 未通过」三个状态页
 * 就只能靠改代码才能看到一次。
 *
 * 覆盖范围（§13）：
 * - **没有申请**：`u-1001`（默认 Mock 登录用户）故意没有申请，
 *   打开 `/join` 看到的是表单，提交后才有记录；
 * - `u-1002` 待查看、`u-1003` 审核中、`u-1004` 已通过、`u-1005` 未通过、`u-1006` 已撤销。
 *
 * 三条不变量在 `build` 里强制校验，任何一条不成立就直接抛错（宁可起不来，
 * 也不要让一份自相矛盾的数据跑到页面上）：
 *
 * 1. **用户、游戏、大区、标签都必须是真实存在的取值**：大区必须属于所选的某个游戏，
 *    否则详情页会出现「选了三角洲行动，却写着无畏契约的大区」这种无法解释的数据；
 * 2. **状态与时间必须自洽**：还没出结果的状态不能有审核时间与审核备注，
 *    出了结果的状态必须两者都有；
 * 3. **审核备注不承诺平台没承诺过的东西**：这里逐条检查备注里不出现
 *    「免单 / 补偿 / 赔偿 / 退款 / 返现 / 赔付 / 开通 / 权限 / 佣金 / 分成 / 收益」——
 *    通过申请不等于变成护航，也不等于获得接单权限或收益。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用。接入真实后端后随 lib/mocks 一并移除。
 */

type PresetEvidence = { kind: EvidenceKind; name: string };

type PresetApplicationInput = {
  id: string;
  applicationNo: string;
  userId: string;
  status: CompanionApplicationStatus;
  displayName: string;
  gameIds: string[];
  regions: string[];
  serviceTags: string[];
  experience: string;
  introduction: string;
  contactNote?: string;
  evidence?: PresetEvidence[];
  /** 提交于几天前 */
  submittedDaysAgo: number;
  /** 状态变更于几天前；待查看时忽略 */
  updatedDaysAgo?: number;
  reviewNote?: string;
};

/** 审核备注里不允许出现的承诺性字眼。 */
const FORBIDDEN_REVIEW_WORDS = [
  "免单",
  "补偿",
  "赔偿",
  "退款",
  "返现",
  "赔付",
  "开通",
  "权限",
  "佣金",
  "分成",
  "收益",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_NOW_MS = getMockSeedNow().getTime();

/** 相对基准时间往前推若干天。写绝对日期的话，过一段时间打开进度页全是几个月前的记录。 */
function daysAgo(days: number): string {
  return new Date(SEED_NOW_MS - days * DAY_MS).toISOString();
}

function build(input: PresetApplicationInput): CompanionApplication {
  if (!userSeed.some((user) => user.id === input.userId)) {
    throw new Error(`预置入驻申请 ${input.id} 引用了不存在的用户：${input.userId}`);
  }

  if (input.gameIds.length === 0) {
    throw new Error(`预置入驻申请 ${input.id} 没有选择任何游戏`);
  }
  for (const gameId of input.gameIds) {
    if (!gameSeed.some((game) => game.id === gameId)) {
      throw new Error(`预置入驻申请 ${input.id} 引用了不存在的游戏：${gameId}`);
    }
  }

  if (input.regions.length === 0) {
    throw new Error(`预置入驻申请 ${input.id} 没有选择任何大区`);
  }
  // 不变量 1：大区必须属于所选游戏之一
  const allowedRegions = new Set(
    gameSeed.filter((game) => input.gameIds.includes(game.id)).flatMap((game) => game.regions),
  );
  for (const region of input.regions) {
    if (!allowedRegions.has(region)) {
      throw new Error(`预置入驻申请 ${input.id} 的大区 ${region} 不属于所选游戏`);
    }
  }

  if (input.serviceTags.length === 0) {
    throw new Error(`预置入驻申请 ${input.id} 没有选择任何服务标签`);
  }
  for (const tag of input.serviceTags) {
    if (!COMPANION_SERVICE_TAGS.includes(tag)) {
      throw new Error(`预置入驻申请 ${input.id} 的服务标签无效：${tag}`);
    }
  }

  // 不变量 2：状态与审核时间 / 备注必须自洽
  const settled = input.status === "approved" || input.status === "rejected";
  const reviewNote = input.reviewNote ?? "";

  if (settled) {
    if (input.updatedDaysAgo === undefined) {
      throw new Error(`预置入驻申请 ${input.id} 处于 ${input.status}，必须有结果时间`);
    }
    if (!reviewNote) {
      throw new Error(`预置入驻申请 ${input.id} 处于 ${input.status}，必须有审核备注`);
    }
  } else if (reviewNote) {
    throw new Error(`预置入驻申请 ${input.id} 还没有结果，不该有审核备注`);
  }

  // 不变量 3：审核备注不承诺平台没有承诺过的结论
  for (const word of FORBIDDEN_REVIEW_WORDS) {
    if (reviewNote.includes(word)) {
      throw new Error(`预置入驻申请 ${input.id} 的审核备注出现了承诺性字眼：${word}`);
    }
  }

  const submittedAt = daysAgo(input.submittedDaysAgo);
  const updatedAt = daysAgo(input.updatedDaysAgo ?? input.submittedDaysAgo);

  return {
    id: input.id,
    applicationNo: input.applicationNo,
    userId: input.userId,
    displayName: input.displayName,
    gameIds: [...input.gameIds],
    regions: [...input.regions],
    serviceTags: [...input.serviceTags],
    experience: input.experience,
    introduction: input.introduction,
    contactNote: input.contactNote ?? "",
    // 凭证只有「类型 + 文件名」，地址一律写成占位图（与退款 / 投诉 / 反馈同一套规则）
    evidence: (input.evidence ?? []).map((item, index) => ({
      id: `${input.id}-ev-${index + 1}`,
      kind: item.kind,
      name: item.name,
      url: EVIDENCE_PLACEHOLDER_URL,
    })),

    status: input.status,
    submittedAt,
    updatedAt,
    reviewedAt: settled ? updatedAt : null,
    reviewNote,
  };
}

export const companionApplicationSeed: CompanionApplication[] = [
  // —— 待查看：用户提交后的默认状态 ——
  build({
    id: "ca-1002",
    applicationNo: "RA-MOCK-0002",
    userId: "u-1002",
    status: "pending",
    displayName: "老板B（占位）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["护航", "陪练"],
    experience: "三角洲行动玩了一年多，机密单跑过两百把左右，主要跑长弓和航天基地。（Mock 文案）",
    introduction: "白天要上班，晚上八点以后在线，周末全天可以打。不接加急单。（Mock 文案）",
    contactNote: "晚上八点后回消息比较快。（Mock 说明）",
    evidence: [{ kind: "image", name: "level-screenshot-1.png" }],
    submittedDaysAgo: 2,
  }),

  // —— 审核中：平台已开始看，还没出结果 ——
  build({
    id: "ca-1003",
    applicationNo: "RA-MOCK-0003",
    userId: "u-1003",
    status: "reviewing",
    displayName: "星野（占位）",
    gameIds: ["g-valorant"],
    regions: ["端游"],
    serviceTags: ["上分", "语音开黑"],
    experience: "无畏契约端游两年，场均稳定，之前在小平台接过排位单。（Mock 文案）",
    introduction: "只打端游排位，语音全程可开。掉段保险这类加急单不接。（Mock 文案）",
    evidence: [
      { kind: "image", name: "rank-1.png" },
      { kind: "image", name: "rank-2.png" },
    ],
    submittedDaysAgo: 5,
    updatedDaysAgo: 1,
  }),

  // —— 已通过：有审核时间与备注。备注只描述这一次审核做了什么，不承诺角色与权限 ——
  build({
    id: "ca-1004",
    applicationNo: "RA-MOCK-0004",
    userId: "u-1004",
    status: "approved",
    displayName: "日落（占位）",
    gameIds: ["g-delta", "g-valorant"],
    regions: ["手游", "端游"],
    serviceTags: ["护航", "上分", "语音开黑"],
    experience: "两个游戏都在打，三角洲行动以机密单为主，无畏契约打排位。（Mock 文案）",
    introduction: "时间比较自由，工作日白天也能接。可以先聊两句再决定。（Mock 文案）",
    contactNote: "随时可以留言，看到就回。（Mock 说明）",
    evidence: [{ kind: "image", name: "level-screenshot-2.png" }],
    submittedDaysAgo: 12,
    updatedDaysAgo: 9,
    reviewNote: "资料已查看，截图与大区对得上。名单展示与接单方式的规则确认后会再联系你。（Mock 备注）",
  }),

  // —— 未通过：备注说明原因，不替平台给出补偿或重新申请的口子 ——
  build({
    id: "ca-1005",
    applicationNo: "RA-MOCK-0005",
    userId: "u-1005",
    status: "rejected",
    displayName: "叶缘（占位）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["陪练"],
    experience: "最近刚开始玩，想先试试陪练。（Mock 文案）",
    introduction: "时间比较多，愿意学。请多担待。（Mock 文案）",
    evidence: [{ kind: "image", name: "level-screenshot-3.png" }],
    submittedDaysAgo: 8,
    updatedDaysAgo: 6,
    reviewNote: "这次提交的截图看不清当前水平，不方便判断。等资料齐全后再看。（Mock 备注）",
  }),

  // —— 已撤销：用户自己撤销的，和「未通过」是两件事 ——
  build({
    id: "ca-1006",
    applicationNo: "RA-MOCK-0006",
    userId: "u-1006",
    status: "withdrawn",
    displayName: "阿柴（占位）",
    gameIds: ["g-delta"],
    regions: ["手游", "端游"],
    serviceTags: ["护航"],
    experience: "断断续续接了一年左右，主要跑手游。（Mock 文案）",
    introduction: "最近时间不太固定，先提交看看。（Mock 文案）",
    submittedDaysAgo: 20,
    updatedDaysAgo: 15,
  }),

  // —— 已撤销（无凭证）：凭证是选填，进度页要能处理「一条凭证都没有」 ——
  build({
    id: "ca-1007",
    applicationNo: "RA-MOCK-0007",
    userId: "u-1007",
    status: "withdrawn",
    displayName: "青柠（占位）",
    gameIds: ["g-valorant"],
    regions: ["端游"],
    serviceTags: ["陪练"],
    experience: "端游排位带过朋友上分，没有正式接过单。（Mock 文案）",
    introduction: "先了解一下流程，暂时不接了。（Mock 文案）",
    submittedDaysAgo: 30,
    updatedDaysAgo: 28,
  }),
];
