import type { Companion, CompanionDetail, CompanionListItem } from "@/lib/types/companion";
import type { OrderCompanionSnapshot } from "@/lib/types/order";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 陪玩列表 / 详情的筛选规则与对外 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除 `./pagination`（纯函数）外没有运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * 三条规则写在这里，页面与接口共用同一份实现：
 *
 * 1. **筛选枚举的契约是明确的**：`availability` 只能是 `all` / `available` / `unavailable`，
 *    `gameId` 必须是真实存在的游戏。**接口收到非法值回 400**，不静默当成默认值——
 *    调用方拿着「不知道筛了什么」的列表继续往下用，比报错难查得多。
 *    页面地址栏里的非法值则**规范化**到默认值（见 `normalizeCompanionAvailability` /
 *    `normalizeCompanionGameId`）：一个手改坏了的地址不该变成错误页。
 * 2. **分页参数规范化**，与订单 / 投诉 / 评价 / 反馈列表同一套规则。
 * 3. **DTO 显式挑字段**：`toCompanionListItem` / `toCompanionDetail` 是内部实体
 *    走向浏览器的唯一出口，`sortOrder` / `enabled` / `rankLabel` / `reviews`
 *    与任何身份字段都不会被顺手带出去。
 */

export const COMPANION_LIST_PAGE_TITLE = "寻找陪玩";
export const COMPANION_DETAIL_PAGE_TITLE = "陪玩资料";

/** 列表默认每页条数。 */
export const COMPANION_PAGE_SIZE = 10;
export const COMPANION_MAX_PAGE_SIZE = 20;
export const COMPANION_MAX_PAGE = 1000;

/** 列表卡片上自我介绍截断到多少个字符。完整内容在详情页。 */
export const COMPANION_INTRO_BRIEF_LENGTH = 40;

/** 详情页最多展示多少条评价摘要。 */
export const COMPANION_DETAIL_REVIEW_LIMIT = 3;

/**
 * 列表顶部的 Mock 标注。
 *
 * 陪玩名单是 Mock 数据，且**陪玩与订单的绑定规则尚未确认**——这两句话必须在页面上
 * 说清楚，否则用户会以为「选择这位陪玩」真的预约到了人。
 */
export const COMPANION_MOCK_NOTICE =
  "陪玩名单与评价均为本地 Mock 数据，头像为占位图。陪玩与订单的绑定、定价与排班规则待确认，本页只提供浏览与查看资料。";

/** 详情页选择面板里的说明。**只解释规则未定，不使用「已预约 / 已锁定 / 已分配」这类词**。 */
export const COMPANION_SELECTION_NOTICE =
  "陪玩与订单的最终绑定规则待确认。本阶段的选择只是一个本地演示：不会创建订单、不会产生支付请求、不会写入任何陪玩关系，也不会把陪玩带进结算页。";

/** 不可选陪玩的统一说明收尾语（前面接 `unavailableReason`）。 */
export const COMPANION_DETAIL_DISABLED_TITLE = "该陪玩当前不可提供服务";

/** 下架陪玩详情页的说明：只读，没有选择或下单入口。 */
export const COMPANION_DETAIL_DISABLED_NOTICE =
  "这位陪玩目前不在名单中。此页仅供查看已公开的资料，没有选择或下单入口。";

/** 不存在（或已下架且无资料）的陪玩 ID 提示。 */
export const COMPANION_NOT_FOUND_TITLE = "陪玩不存在";
export const COMPANION_NOT_FOUND_DESCRIPTION = "该陪玩可能已下线，或链接已失效。";

// ——————————————————————————— 可用状态筛选 ———————————————————————————

/**
 * 可用状态筛选。`all` 表示不限。
 *
 * 与「是否上架」是两回事：下架的陪玩不进列表，因此这个筛选只在
 * 上架陪玩里区分「当前可接单」与「暂不可用」。
 */
export type CompanionAvailability = "all" | "available" | "unavailable";

export const COMPANION_AVAILABILITY_VALUES: readonly CompanionAvailability[] = [
  "all",
  "available",
  "unavailable",
];

export const COMPANION_AVAILABILITY_LABELS: Record<CompanionAvailability, string> = {
  all: "全部",
  available: "当前可接单",
  unavailable: "暂不可用",
};

export const DEFAULT_COMPANION_AVAILABILITY: CompanionAvailability = "all";

export const COMPANION_AVAILABILITY_INVALID_MESSAGE =
  "筛选条件 availability 只能是 all / available / unavailable";

export const COMPANION_GAME_INVALID_MESSAGE = "筛选条件 gameId 不是有效的游戏";

export function isCompanionAvailability(value: string): value is CompanionAvailability {
  return (COMPANION_AVAILABILITY_VALUES as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按「未筛选」处理。 */
export function readCompanionAvailability(raw: string | null): CompanionAvailability | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_COMPANION_AVAILABILITY;
  const value = raw.trim();
  if (value === "") return DEFAULT_COMPANION_AVAILABILITY;
  return isCompanionAvailability(value) ? value : null;
}

/** 宽松规范化：非法值回到默认值（页面地址栏用）。 */
export function normalizeCompanionAvailability(raw: string | null): CompanionAvailability {
  return readCompanionAvailability(raw) ?? DEFAULT_COMPANION_AVAILABILITY;
}

/**
 * 严格读取游戏筛选：空值表示「全部游戏」，未知 id 返回 null（由接口抛 400）。
 *
 * `knownGameIds` 必须来自**真实的游戏数据**，而不是在筛选栏里写死一份：
 * 写死两份迟早出现「界面上能选、数据里没有」的空结果。
 */
export function readCompanionGameId(
  raw: string | null,
  knownGameIds: readonly string[],
): string | null {
  if (raw === null || raw === undefined) return "";
  const value = raw.trim();
  if (value === "") return "";
  return knownGameIds.includes(value) ? value : null;
}

/** 宽松规范化：未知游戏回到「全部游戏」（页面地址栏用）。 */
export function normalizeCompanionGameId(
  raw: string | null,
  knownGameIds: readonly string[],
): string {
  return readCompanionGameId(raw, knownGameIds) ?? "";
}

/** 搜索关键词：只去首尾空格。搜索词不是业务枚举，过长不会造成危害，也不静默截断。 */
export function readCompanionKeyword(raw: string | null): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 陪玩列表查询条件（已解析、已校验）。 */
export type CompanionListQuery = {
  /** 空串表示不搜索 */
  keyword: string;
  /** 空串表示全部游戏 */
  gameId: string;
  availability: CompanionAvailability;
  page: number;
  pageSize: number;
};

/**
 * 组装查询条件。
 *
 * 调用方**必须先把枚举解析好**再传进来（接口用 `read*` 严格解析，页面用 `normalize*`
 * 规范化），因此这里不再有「非法值怎么办」的分支——两处口径的差别只存在于调用侧，
 * 数据层的过滤规则只有这一份。
 */
export function buildCompanionListQuery(input: {
  params: URLSearchParams;
  gameId: string;
  availability: CompanionAvailability;
}): CompanionListQuery {
  return {
    keyword: readCompanionKeyword(input.params.get("keyword")),
    gameId: input.gameId,
    availability: input.availability,
    page: clampPage(input.params.get("page"), COMPANION_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      COMPANION_PAGE_SIZE,
      COMPANION_MAX_PAGE_SIZE,
    ),
  };
}

/**
 * 这条陪玩**是否在公开名单里**。公开列表、详情页与结算页共用这一个判断。
 *
 * `enabled`（是否上架）与 `removedAt`（是否被后台移除）是两件事，但对外是同一个结果：
 * 用户端两处都不该看到。分成两个判断，迟早会出现「列表里过滤了移除、详情页忘了」，
 * 而那正是「移除了却还能从直链下单」的来源。
 *
 * ⚠️ 判定放在常量层而不是数据层：公开 DTO 转换（本文件）与结算页校验
 * （`lib/services/checkout.ts`）都要用它，两边 import 的都是这一个函数。
 */
export function isCompanionListed(
  companion: Pick<Companion, "enabled" | "removedAt">,
): boolean {
  return companion.enabled && companion.removedAt === null;
}

/**
 * 这位护航**此刻能不能接新的单**（P0-5 手工验收时冻结的语义）。
 *
 * ## 为什么它与 `isCompanionListed()` 是两件事
 *
 * | 字段 | 回答的问题 | 关掉之后 |
 * |---|---|---|
 * | `enabled` | 这个 User 还有没有**打手工作资格** | 进不去工作台（`disabled`） |
 * | `available` | 现在**允不允许接新的订单** | 进得去，但接不了单 |
 *
 * ⚠️ **禁止把 `available` 并进 `isCompanionListed()`**，也**禁止**并进
 * `resolveCompanionAccess()`（`lib/services/companionAccess.ts`）。
 * 并进去等于说「暂停接单 = 被取消打手资格」：一位想歇两天的护航会连自己的工作台
 * 都进不去、看不到自己的资料，以为资格没了，转头去重新提交入驻申请——
 * 而他要的只是暂时不接单。**资格与接单能力必须分开。**
 *
 * ## 谁该用它
 *
 * 一切「这个人现在能不能接新单」的判断：
 * - 结算页指定护航（`lib/services/checkout.ts` 里同一条规则的既有写法）；
 * - 公共池列表是否给他返回可接订单（`lib/services/companionDispatch.ts`）；
 * - 原子接单区段的最后一道检查（`lib/data/companionDispatchTransaction.ts`）。
 *
 * ⚠️ 历史事实**不因它改变**：已经被他接下的单、用户指定给他的专属派单，
 * 都不会因为 `available` 变成 false 而被改写或隐藏。它只回答「**新的**单能不能接」。
 */
export function isCompanionAcceptingOrders(
  companion: Pick<Companion, "enabled" | "available" | "removedAt">,
): boolean {
  return isCompanionListed(companion) && companion.available;
}

/**
 * 默认排序：`sortOrder` 升序，相等时按 id 兜底。
 *
 * 兜底那一层不是可有可无的：顺序不确定时，同一条陪玩可能在第一页出现过、
 * 翻到第二页又出现一次。
 */
export function compareCompanionsForList(
  a: Pick<Companion, "sortOrder" | "id">,
  b: Pick<Companion, "sortOrder" | "id">,
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 关键词是否命中：昵称 / 自我介绍 / 服务标签三处任一包含即可。 */
export function companionMatchesKeyword(
  companion: Pick<Companion, "displayName" | "intro" | "serviceTags">,
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  if (companion.displayName.toLowerCase().includes(needle)) return true;
  if (companion.intro.toLowerCase().includes(needle)) return true;
  return companion.serviceTags.some((tag) => tag.toLowerCase().includes(needle));
}

// ——————————————————————————— DTO 转换 ———————————————————————————

/** 自我介绍摘要：按字符数截断并加省略号。列表与详情的差别只在这里。 */
export function toCompanionIntroBrief(intro: string): string {
  const trimmed = intro.trim();
  // Array.from 按 code point 切分，与全站的字数口径（lib/utils/text.ts）一致
  const characters = Array.from(trimmed);
  if (characters.length <= COMPANION_INTRO_BRIEF_LENGTH) return trimmed;
  return `${characters.slice(0, COMPANION_INTRO_BRIEF_LENGTH).join("")}…`;
}

/**
 * 护航资料 → **订单上的护航公开信息快照**（P0-5）。
 *
 * 两个写入点共用这一处转换：**接单那一刻**写进订单
 * （`companionDispatchTransaction.acceptDispatch`），以及管理端回看
 * 「用户当初指定的是谁」（`lib/services/adminOrders.ts`）。
 * 各写一遍的话，两边迟早会对「哪些字段算公开信息」给出不同答案——
 * 而其中一边一旦多带一个 `userId`，那位护航的账号就会出现在后台订单详情里。
 *
 * ⚠️ 只有 id / 昵称 / 头像：`enabled` / `removedAt` / `rankLabel` 与任何身份字段都不进快照。
 */
export function toOrderCompanionSnapshot(companion: Companion): OrderCompanionSnapshot {
  return {
    id: companion.id,
    name: companion.displayName,
    avatarUrl: companion.avatarUrl,
  };
}

/**
 * 列表项与详情**共有**的那部分字段。
 *
 * 显式列举，**不是** `{ ...companion }` 再删几个：新增内部字段时默认不会外流，
 * 只有在这里写上去的字段才会被浏览器看到。
 *
 * 列表项与详情的差别只有两处（前者的自我介绍是截断的、后者是完整的，且多一段评价摘要），
 * 因此两份 DTO 从这一份共有字段出发，不会出现「同一个字段在两张表里写法不一样」。
 */
function toCompanionBase(
  companion: Companion,
  gameNameById: Readonly<Record<string, string>>,
): Omit<CompanionListItem, "introBrief"> {
  return {
    id: companion.id,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
    games: companion.gameIds.map((id) => ({ id, name: gameNameById[id] ?? id })),
    regions: [...companion.regions],
    serviceTags: [...companion.serviceTags],
    rating: companion.rating,
    completedOrderCount: companion.completedOrderCount,
    tipsCount: companion.tipsCount,
    reviewCount: companion.reviewCount,
    available: companion.available,
    unavailableReason: companion.available ? "" : companion.unavailableReason,
  };
}

/** 内部实体 → 列表项。自我介绍只给截断后的摘要。 */
export function toCompanionListItem(
  companion: Companion,
  gameNameById: Readonly<Record<string, string>>,
): CompanionListItem {
  return {
    ...toCompanionBase(companion, gameNameById),
    introBrief: toCompanionIntroBrief(companion.intro),
  };
}

/** 内部实体 → 详情。在列表项之上补完整自我介绍与有限的评价摘要。 */
export function toCompanionDetail(
  companion: Companion,
  gameNameById: Readonly<Record<string, string>>,
): CompanionDetail {
  return {
    ...toCompanionBase(companion, gameNameById),
    intro: companion.intro,
    // 评价只给前若干条，且只带昵称 / 星级 / 正文 / 时间四项
    reviews: companion.reviews.slice(0, COMPANION_DETAIL_REVIEW_LIMIT).map((review) => ({
      id: review.id,
      nickname: review.nickname,
      rating: review.rating,
      content: review.content,
      createdAt: review.createdAt,
    })),
    reviewsTruncated: companion.reviews.length > COMPANION_DETAIL_REVIEW_LIMIT,
    // 是否在公开名单里：下架与被移除的陪玩都不进列表，直链打开只有一页只读资料。
    // 「不在名单里」与「在名单里但暂不可用」对用户是两件事，而 `available` 在两种情况下
    // 都是 false，因此这一项必须单独给出——页面不能靠 available 去猜是哪一种。
    listed: isCompanionListed(companion),
    // 「能不能选」由服务端算，前端不自己推断
    selectable: isCompanionListed(companion) && companion.available,
  };
}
