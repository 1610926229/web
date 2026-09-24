import type { UserRecord } from "@/lib/data/userRepository";
import type { Companion } from "@/lib/types/companion";
import { getMockSeedNow } from "./mockClock";

/**
 * Mock 用户与陪玩名单的种子。
 *
 * ⚠️ 全部为 Mock 数据，仅用于打通取数链路与版式验证：
 * - 图片均为 public/mock 下的本地占位图，待管理端与对象存储就绪后替换；
 * - 用户为虚构的 Mock 身份，不含 openid 等任何真实微信标识。
 *
 * ⚠️ **两份数据在 P8B / P8E-1 搬走了**，各自单独一份文件——
 * 「哪些东西后台改得动」因此一眼看得出来：
 * - 目录数据（游戏 / 类目 / 增值服务 / 商品 / 首页商品分组）在 `./catalogSeed.ts`；
 * - 首页运营内容（图片公告 / 活动 Banner / 快捷入口）在 `./contentSeed.ts`。
 *
 * 两者都是**仓储的初始记录**，后台能改、用户端读的是改过之后的那份。
 * 本文件剩下的两样都不由后台直接编辑：用户由登录流程产生、
 * 陪玩名单由审核与后台管理产生（走各自的仓储与事务）。
 *
 * 接入真实后端后，本目录随 lib/mocks 一并移除。
 */

/**
 * Mock 用户。
 *
 * 前两位（老板A / 老板B）用于验证「切换用户后个人信息展示随之变化」与订单归属隔离；
 * 其余八位是为**消费排行榜**补的：两个人排不出前三名与普通列表，也造不出
 * 「金额相同的两个人」「有订单但有效消费为 0 的人」这类必须被验收到的边界。
 *
 * `displayId` 是**平台展示给用户的 ID**（原型资料卡上那一行），形如 UUID 但纯属虚构，
 * 与微信 OpenID / UnionID 没有任何关系——真实身份标识只在服务端保存，不进任何 DTO。
 *
 * `bio` 故意留一个为空：资料卡「暂未填写个人简介」的占位状态要能被验收看到。
 *
 * 昵称一律带「（占位）」后缀：排行榜会把这些昵称直接展示给用户，
 * 不标清楚就会被当成真实用户。
 */
export const userSeed: UserRecord[] = [
  {
    id: "u-1001",
    displayId: "3f2a9c14-6b7d-4e58-9c21-8d4f0b7a5e63",
    nickname: "老板A（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "",
  },
  {
    id: "u-1002",
    displayId: "9c4e1d78-2a53-47f6-b0c8-5e7d3a91f204",
    nickname: "老板B（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "对局节奏轻一点，谢谢（占位）",
  },
  {
    id: "u-1003",
    displayId: "b7d2f0a5-3e18-4c96-8a37-1f6c9e2b4d70",
    nickname: "星野（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "只打巴克什（占位）",
  },
  {
    id: "u-1004",
    displayId: "c1e8a473-5b26-4d19-9f83-0a7b2c5e6d91",
    nickname: "日落（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    bio: "",
  },
  {
    id: "u-1005",
    displayId: "d4a91b62-7c35-4e08-b1f6-2d8e5a3c9047",
    nickname: "叶缘（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "周末白天在线（占位）",
  },
  {
    id: "u-1006",
    displayId: "e8b3c507-9d41-4a72-8e05-6f1b4d2a9375",
    nickname: "阿柴（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "",
  },
  {
    id: "u-1007",
    displayId: "f2c7d861-1e94-4b30-a5d7-8c3f6e0b2749",
    nickname: "白露（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "开麦就行（占位）",
  },
  {
    id: "u-1008",
    displayId: "a5e1f739-4b62-4c85-9d20-7e8a3b1f6504",
    nickname: "小满（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    bio: "",
  },
  {
    // 有订单但**有效消费为 0**：一单已退款、一单还在进行中 → 不应进入排行榜
    id: "u-1009",
    displayId: "b9d6a204-8f13-4e57-92c8-5a0d7b3e4618",
    nickname: "青柠（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "第一次来（占位）",
  },
  {
    // 完全没有订单 → 同样不应进入排行榜
    id: "u-1010",
    displayId: "c3f8b152-6a74-4d09-8b31-9e2c5f7a0d86",
    nickname: "未消费（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "",
  },
  {
    // ————— 以下十一人只服务周期榜 —————
    // 他们的订单不在 `orderSeed` 里，而是由 `buildRankingPeriodOrders(now)` **相对当前时间**生成，
    // 分摊在六个周期上（今日 / 昨日 / 本周 / 本月 / 上月 / 累计）。
    // 见 `orderSeed.ts` 里的预置表。
    //
    // 这样拆开的原因有两个：
    // 1. 周期榜要的是「相对今天」的订单，写死绝对日期的话第二天「今日」就永远是空的；
    // 2. 既有种子的绝对日期一旦被改成相对时间，P4/P5 的订单列表与售后用例就会跟着一起漂。
    //
    // 最后五位（u-1017…u-1021）是给「上月」补的：只靠一位用户不足以让人工验收看出
    // 同额并列排序，也不足以证明这一档在任意月份都自给自足。
    id: "u-1011",
    displayId: "d7a2e945-1c68-4b03-9e52-8f1a6d4c7b20",
    nickname: "惊蛰（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "",
  },
  {
    id: "u-1012",
    displayId: "e1c5b073-8d29-4a61-9f47-2b6e8c0a5d31",
    nickname: "长夏（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    bio: "",
  },
  {
    id: "u-1013",
    displayId: "f4b8d216-3a95-4c07-8e1b-7d0c5a9f2e68",
    nickname: "陈屿（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "",
  },
  {
    id: "u-1014",
    displayId: "a8f3c650-2e17-4d94-b5a3-6c9e1b7d0f42",
    nickname: "南栀（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "",
  },
  {
    id: "u-1015",
    displayId: "b2d9a784-5c31-42e8-8f60-3a1d7e4b9c05",
    nickname: "远山（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "",
  },
  {
    id: "u-1016",
    displayId: "c6e1f408-7b52-4a39-9d18-5f2c0a8e3b71",
    nickname: "微凉（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    bio: "",
  },
  {
    // 以下五位：昨日 / 本周 / 本月 / 上月 各自的第二位用户，
    // 其中 u-1021 与 u-1016 在「上月」金额完全相同（137.00），用来验证周期榜内同额并列的稳定排序。
    id: "u-1017",
    displayId: "d9b4e257-8f13-4a60-9c75-3e1b8d0a2f94",
    nickname: "归舟（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "",
  },
  {
    id: "u-1018",
    displayId: "e3a7c918-4b62-4d80-a517-6f0c9e2b3d48",
    nickname: "云开（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "",
  },
  {
    id: "u-1019",
    displayId: "f8c2d643-1e95-4a07-b380-2d5f7c9e1a60",
    nickname: "拾光（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "",
  },
  {
    id: "u-1020",
    displayId: "a5e9b174-6c28-4f93-8d61-0b7a3e5c9f82",
    nickname: "泊野（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    bio: "",
  },
  {
    id: "u-1021",
    displayId: "b7f3a805-2d49-4c16-9e52-8a1c6b4d7e03",
    nickname: "听澜（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    bio: "",
  },
  {
    // ————— 以下两人只服务 DEV-1 的多角色人工验收 —————
    // 他们**已经**是有效打手：名下有一条 `approved` 入驻申请（`ca-1008` / `ca-1009`）
    // 与一条绑定了 `userId` 的护航资料（`cp-10` / `cp-11`）。
    //
    // 为什么不能拿现成的 `u-1002` / `u-1003` 顶替：那两位的申请预置是「待查看 / 审核中」，
    // 是「后台直接通过一条申请」这个验收场景唯一的样本，改成已通过等于把那一步弄没。
    // 为什么不去把 `u-1004`（`ca-1004` 已通过）补一条护航：同一份理由——那一条是
    // 「申请已通过」这个状态的样本，动它会让后台申请列表少一个可看的终态。
    // 因此验收需要的「现成的打手」单独造，不动既有样本。
    //
    // ⚠️ 昵称与护航展示名保持一致，但**不用昵称做关联**：关联是 `Companion.userId`。
    id: "u-1022",
    displayId: "c8a4f169-3b72-4d58-8e04-9a1f5c7b2d63",
    nickname: "夜航（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    bio: "晚上八点后在线（占位）",
  },
  {
    id: "u-1023",
    displayId: "d2b7e408-5c91-4a63-b7f2-6e8d3a0c5f19",
    nickname: "栖迟（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    bio: "端游排位为主（占位）",
  },
];

/**
 * 陪玩名单 —— 全站**唯一**的一份。
 *
 * 结算页的「推荐陪玩」面板（P4）与公开的陪玩列表 / 陪玩详情读的都是这份数据，
 * 因此同一位陪玩在三处的昵称、头像与可用状态必然一致，不存在第二套名单。
 *
 * ⚠️ 全部为 Mock 身份：昵称一律带「（占位）」后缀，头像复用 `public/mock` 下的四张占位图。
 * 名单里没有价格、佣金、排期与联系方式——陪玩定价与订单绑定规则尚未确认，
 * 这里就不留「先填个数字」的字段。
 *
 * 覆盖的边界（缺一个就会有某个界面状态看不到）：
 * - `cp-1`…`cp-3`、`cp-8`、`cp-9` 当前可选；其中 `cp-3` 与 `cp-8` **没有任何评价**
 *   （详情页显示「暂无评分」而不是 0 分）；
 * - `cp-4`（休息中）与 `cp-6`（已排满）**在架但当前不可选**：仍然出现在列表里并标注原因，
 *   不静默隐藏——直接消失会让人以为名单里没有这个人；
 *   `cp-4` 同时是「不可用陪玩不能被写入支付请求」这条服务端规则的验证用例；
 * - `cp-7` **已下架**（`enabled: false`）：不进公开列表，直链打开只有一页只读资料，
 *   没有任何选择或下单入口；
 * - `cp-5` 是超长昵称 + 超长自我介绍，`cp-9` 是超长自我介绍 + 4 条评价
 *   （详情页因此能看到「评价只展示前几条」的状态）；
 * - 游戏覆盖 g-delta 与 g-valorant 两个游戏、手游与端游两个大区，
 *   服务标签覆盖目录里的五项。
 * - `cp-10` / `cp-11` 是**唯一两条由入驻审核产生**的记录（`userId` / `applicationId` 都有值），
 *   也是 Mock 身份切换工具里「打手 A / 打手 B」两个身份对应的资料（DEV-1）。
 *
 * 评价时间相对**进程内冻结的基准时间**构造（`getMockSeedNow()`），不写绝对日期：
 * 写死日期的话，过一段时间打开详情页看到的全是几个月前的评价。
 *
 * P8A 给每条记录补上了三个**平台侧**字段：
 * - `cp-1`…`cp-9` 的 `userId: null` / `applicationId: null`：这批陪玩是平台早期数据，
 *   不由任何入驻申请产生；
 * - **`cp-10` / `cp-11` 是例外，两者都有值**：他们由虚构的入驻申请 `ca-1008` / `ca-1009`
 *   审核通过产生（DEV-1 的多角色人工验收需要「一启动就已经是打手」的账号，
 *   否则每轮验收都要先手工走一遍审核）。因此「这份名单里有没有人是审核进来的」
 *   一眼看得出来，`cp-10` / `cp-11` 就是那两个样本，不必去后台翻申请；
 * - `removedAt: null`：都没有被移除。软移除是后台动作，预置数据不该一上来就有一条移除记录
 *   ——那样「筛选出已移除的护航」这一条筛选项就没有一个干净的空态可看。
 * 三个字段都**不进任何公开 DTO**。
 *
 * ⚠️ `cp-10` / `cp-11` 的 `enabled` 与 `available` **都必须是 `true`**：
 * 前者决定他们进不进得了打手工作台（`disabled` 态），后者决定公共池给不给他们单
 * （`BR-01`：`available=false` 时公共池一条都不返回）。DEV-1 的验收正是要他们能直接接单。
 * 顺带一提，`available: false` 的那两条既有样本是 `cp-4` / `cp-6`，`enabled: false` 的只有 `cp-7`
 * ——`tests/companions.test.mjs` 与 `tests/adminCompanionManagement.test.mjs` 按 id 写死了这三条，
 * 新增记录保持 `available: true && enabled: true` 就不会撞上它们。
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANION_SEED_NOW_MS = getMockSeedNow().getTime();

/** 评价时间：相对基准时间往前推若干天。 */
function reviewDaysAgo(days: number): string {
  return new Date(COMPANION_SEED_NOW_MS - days * DAY_MS).toISOString();
}

export const companionSeed: Companion[] = [
  {
    id: "cp-1",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "阿泽（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    rankLabel: "钻石打手",
    intro:
      "三角洲行动机密单常驻，主打稳扎稳打，掉线重连也算我的。（占位文案）",
    gameIds: ["g-delta"],
    regions: ["手游", "端游"],
    serviceTags: ["护航", "上分"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 128,
    rating: 4.8,
    tipsCount: 21,
    reviewCount: 3,
    sortOrder: 10,
    enabled: true,
    reviews: [
      {
        id: "cp-1-r1",
        nickname: "老板A（占位）",
        rating: 5,
        content: "全程在线，节奏很好。（Mock 评价）",
        createdAt: reviewDaysAgo(4),
      },
      {
        id: "cp-1-r2",
        nickname: "老板B（占位）",
        rating: 5,
        content: "沟通顺畅，按时交付。（Mock 评价）",
        createdAt: reviewDaysAgo(11),
      },
      {
        id: "cp-1-r3",
        nickname: "星野（占位）",
        rating: 4,
        content: "整体不错，中间等了十分钟。（Mock 评价）",
        createdAt: reviewDaysAgo(26),
      },
    ],
  },
  {
    id: "cp-2",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "小北（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    rankLabel: "星耀打手",
    intro: "偏爱新手带打，会讲思路不会只报点。（占位文案）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["陪练", "新手带打"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 29,
    rating: 5,
    tipsCount: 4,
    reviewCount: 1,
    sortOrder: 20,
    enabled: true,
    reviews: [
      {
        id: "cp-2-r1",
        nickname: "日落（占位）",
        rating: 5,
        content: "讲得很细，第二把就能自己走了。（Mock 评价）",
        createdAt: reviewDaysAgo(2),
      },
    ],
  },
  {
    id: "cp-3",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "老K（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    rankLabel: "王者打手",
    intro: "无畏契约排位常驻，端游只打排位。（占位文案）",
    gameIds: ["g-valorant"],
    regions: ["端游"],
    serviceTags: ["上分", "语音开黑"],
    available: true,
    unavailableReason: "",
    // 没有任何评价：详情页要能显示「暂无评分」，而不是用 0 分冒充
    completedOrderCount: 31,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 30,
    enabled: true,
    reviews: [],
  },
  {
    id: "cp-4",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "临时工（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    rankLabel: "休息中",
    intro: "接单时间不固定，来之前先问一句。（占位文案）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["护航"],
    available: false,
    unavailableReason: "该陪玩当前休息中，暂不接单",
    completedOrderCount: 12,
    rating: 4.1,
    tipsCount: 2,
    reviewCount: 2,
    sortOrder: 40,
    enabled: true,
    reviews: [
      {
        id: "cp-4-r1",
        nickname: "叶缘（占位）",
        rating: 4,
        content: "打完了，中间换过一次大区。（Mock 评价）",
        createdAt: reviewDaysAgo(9),
      },
      {
        id: "cp-4-r2",
        nickname: "阿柴（占位）",
        rating: 4,
        content: "还行，回复稍慢。（Mock 评价）",
        createdAt: reviewDaysAgo(38),
      },
    ],
  },
  {
    id: "cp-5",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "有目•凌晨三点还在打巴克什的占位陪玩（占位）",
    avatarUrl: "/mock/avatar-1.svg",
    rankLabel: "钻石打手",
    intro:
      "夜里在线，白天大概率在睡。三角洲行动机密单打了两年，巴克什、长弓、航天基地都能带；无畏契约端游排位也接，语音优先。不接加急，打不完的单会提前说清楚，不会拖着不做。（占位长文案，用于验证长昵称与长自我介绍在列表卡片、详情页和结算页选择面板里的换行与截断）",
    gameIds: ["g-delta", "g-valorant"],
    regions: ["手游", "端游"],
    serviceTags: ["护航", "陪练", "语音开黑"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 306,
    rating: 4.6,
    tipsCount: 57,
    reviewCount: 2,
    sortOrder: 50,
    enabled: true,
    reviews: [
      {
        id: "cp-5-r1",
        nickname: "晚风（占位）",
        rating: 5,
        content: "凌晨两点还接单，很难得。（Mock 评价）",
        createdAt: reviewDaysAgo(1),
      },
      {
        id: "cp-5-r2",
        nickname: "拾光（占位）",
        rating: 4,
        content: "单子有点多，等了一会儿。（Mock 评价）",
        createdAt: reviewDaysAgo(16),
      },
    ],
  },
  {
    id: "cp-6",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "星野（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    rankLabel: "星耀打手",
    intro: "只打无畏契约，排位护航为主。（占位文案）",
    gameIds: ["g-valorant"],
    regions: ["端游"],
    serviceTags: ["护航", "上分"],
    available: false,
    unavailableReason: "该陪玩本周已排满，暂不接单",
    completedOrderCount: 74,
    rating: 4.9,
    tipsCount: 13,
    reviewCount: 1,
    sortOrder: 60,
    enabled: true,
    reviews: [
      {
        id: "cp-6-r1",
        nickname: "云开（占位）",
        rating: 5,
        content: "很稳，一晚上上了两段。（Mock 评价）",
        createdAt: reviewDaysAgo(6),
      },
    ],
  },
  {
    id: "cp-7",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "云开（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    rankLabel: "已下线",
    intro: "暂时不再接单，资料留档。（占位文案）",
    gameIds: ["g-delta"],
    regions: ["手游"],
    serviceTags: ["护航"],
    available: false,
    unavailableReason: "该陪玩已下线",
    completedOrderCount: 58,
    rating: 4.4,
    tipsCount: 9,
    reviewCount: 1,
    sortOrder: 70,
    // 已下架：不进公开列表，直链详情只有只读资料页
    enabled: false,
    reviews: [
      {
        id: "cp-7-r1",
        nickname: "听澜（占位）",
        rating: 4,
        content: "已经是最后一单了。（Mock 评价）",
        createdAt: reviewDaysAgo(52),
      },
    ],
  },
  {
    id: "cp-8",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "归舟（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    rankLabel: "青铜打手",
    intro: "刚开始接单，手游端游都学。（占位文案）",
    gameIds: ["g-delta"],
    regions: ["手游", "端游"],
    serviceTags: ["陪练"],
    available: true,
    unavailableReason: "",
    // 刚接单：既没有评价也没有鸡腿，列表卡片要能显示「暂无评分」
    completedOrderCount: 3,
    rating: null,
    tipsCount: 0,
    reviewCount: 0,
    sortOrder: 80,
    enabled: true,
    reviews: [],
  },
  {
    id: "cp-9",
    userId: null,
    applicationId: null,
    removedAt: null,
    displayName: "泊野（占位）",
    avatarUrl: "/mock/avatar-2.svg",
    rankLabel: "王者打手",
    intro:
      "三角洲行动全职护航，机密单、开业特惠单都接；主打不换人、不加价、不拖单。每天在线 10 小时以上，语音全程可开。新手可以先聊两句再决定要不要下单，不勉强。（占位长文案）",
    gameIds: ["g-delta", "g-valorant"],
    regions: ["手游", "端游"],
    serviceTags: ["护航", "上分", "语音开黑", "新手带打"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 512,
    rating: 4.9,
    tipsCount: 96,
    reviewCount: 4,
    sortOrder: 90,
    enabled: true,
    // 4 条评价 > 详情页上限，用于验证「只展示前几条」的提示确实会出现
    reviews: [
      {
        id: "cp-9-r1",
        nickname: "老板A（占位）",
        rating: 5,
        content: "第三次找他了，还是稳。（Mock 评价）",
        createdAt: reviewDaysAgo(3),
      },
      {
        id: "cp-9-r2",
        nickname: "老板B（占位）",
        rating: 5,
        content: "全程没换人，体验很好。（Mock 评价）",
        createdAt: reviewDaysAgo(13),
      },
      {
        id: "cp-9-r3",
        nickname: "星野（占位）",
        rating: 5,
        content: "响应很快，半夜也在。（Mock 评价）",
        createdAt: reviewDaysAgo(21),
      },
      {
        id: "cp-9-r4",
        nickname: "阿柴（占位）",
        rating: 4,
        content: "价格没变，速度稍慢一点。（Mock 评价）",
        createdAt: reviewDaysAgo(45),
      },
    ],
  },
  {
    // DEV-1 验收用：**由入驻审核产生**的打手 A。
    // `userId` / `applicationId` 都指向真实存在的预置记录（`u-1022` / `ca-1008`），
    // `enabled` 与 `available` 都为 true —— 因此 `resolveCompanionAccess("u-1022")`
    // 判定 `granted`、`requireCompanion()` 放行、公共池给他单、接单区段的
    // `isCompanionAcceptingOrders()` 也放行。四个条件缺一不可，别为了「看着像休息中」改掉。
    id: "cp-10",
    userId: "u-1022",
    applicationId: "ca-1008",
    removedAt: null,
    displayName: "夜航（占位）",
    avatarUrl: "/mock/avatar-3.svg",
    rankLabel: "星耀打手",
    intro:
      "工作日晚上八点后在线，周末全天可以打。三角洲行动机密单跑得多，端游排位也接。（占位文案）",
    gameIds: ["g-delta", "g-valorant"],
    regions: ["手游", "端游"],
    serviceTags: ["护航", "上分", "语音开黑"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 76,
    rating: 4.7,
    tipsCount: 12,
    reviewCount: 2,
    sortOrder: 100,
    enabled: true,
    reviews: [
      {
        id: "cp-10-r1",
        nickname: "老板A（占位）",
        rating: 5,
        content: "约的时间很准，全程没换人。（Mock 评价）",
        createdAt: reviewDaysAgo(6),
      },
      {
        id: "cp-10-r2",
        nickname: "青柠（占位）",
        rating: 4,
        content: "打得不急不躁，适合新手。（Mock 评价）",
        createdAt: reviewDaysAgo(19),
      },
    ],
  },
  {
    // DEV-1 验收用：由入驻审核产生的打手 B。
    // 与 cp-10 打**不同的游戏**（只打无畏契约端游），用来证明公共池**不按游戏过滤**：
    // 打手 A 取消接单后回池的那张单，打手 B 照样接得到（`lib/services/companionDispatch.ts`
    // 明确不做游戏 / 商品 / 等级过滤）。这一点在 04-acceptance.md 的 §G 会走到。
    id: "cp-11",
    userId: "u-1023",
    applicationId: "ca-1009",
    removedAt: null,
    displayName: "栖迟（占位）",
    avatarUrl: "/mock/avatar-4.svg",
    rankLabel: "钻石打手",
    intro: "只打无畏契约端游排位，语音全程可开，不接加急单。（占位文案）",
    gameIds: ["g-valorant"],
    regions: ["端游"],
    serviceTags: ["上分", "语音开黑", "新手带打"],
    available: true,
    unavailableReason: "",
    completedOrderCount: 41,
    rating: 4.6,
    tipsCount: 5,
    reviewCount: 1,
    sortOrder: 110,
    enabled: true,
    reviews: [
      {
        id: "cp-11-r1",
        nickname: "星野（占位）",
        rating: 5,
        content: "排位稳，语音一直在。（Mock 评价）",
        createdAt: reviewDaysAgo(9),
      },
    ],
  },
];
