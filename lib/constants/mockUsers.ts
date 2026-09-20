/**
 * Mock 登录的**测试账号名单**（仅开发 / Mock 环境使用）。
 *
 * ## 这不是账号系统
 *
 * 本文件只是一份**给人看的名单**：一串 userId 与昵称，用来在登录界面上点一下选中身份。
 * 它**不构成任何身份来源**——
 *
 * ```
 * 点一下 → POST /api/auth/mock-login { userId } → 服务端查仓储 → 写 mock_user_id Cookie
 * ```
 *
 * 身份始终由**服务端**根据 Cookie 里那个 id 去仓储查出来（`lib/auth/session.ts`），
 * 名单里写了什么不改变任何人的权限。因此这里既没有凭据、没有密码、没有角色，
 * 也没有第二套会话：`mock_user_id` 仍然是**唯一**的用户会话 Cookie，
 * 打手资格仍然只由「这个用户名下有没有有效护航资料」决定。
 *
 * ## 为什么需要它
 *
 * 手工验收 P0-5 的完整链路要**同时扮演多个用户**（老板下单、打手 B 接单、打手 C 抢单）。
 * 在此之前，用户端登录按钮固定登录第一个预置用户，验收期只能靠手改 Cookie 或 curl
 * 换身份——那不是「人工走完整链路」。名单把这件事变成点两下：
 * 设置页「切换 Mock 用户」→ 在登录界面选另一个账号。
 *
 * ## 名单里的三件事都必须能被验证
 *
 * 1. **`userId` 与 `nickname` 与真实 Seed 一致**——写错了会让人以为登录失败；
 * 2. **`applicationState` 与预置的入驻申请状态一致**——验收的第一步是「把自己变成打手」，
 *    点进一个已经没有申请可提交、也没有申请可审核的账号会白费一轮；
 * 3. **名单里不出现预置状态为「已通过 / 未通过 / 已撤销」的用户**——
 *    那几种状态下这个账号既提交不了新申请（一人一条），后台也没有可批的申请。
 *
 * 三条都由 `tests/mockUsers.test.mjs` 拿**真实 Seed** 核对，名单不是「写了就算」。
 * 因此 Seed 一改，这里就会红，而不是安静地对不上。
 *
 * ## 关闭时不可见
 *
 * `ENABLE_MOCK_AUTH=false` 时：本名单**根本不进入页面**（登录界面不渲染选择器）、
 * `/api/auth/mock-login` 继续返回 404、设置页也不出现切换入口。
 * 组件层的开关判定见 `lib/auth/LoginGate.tsx` 与 `app/(mobile)/settings/page.tsx`。
 */

/** 预置数据里这个账号的入驻申请状态；`none` 表示没有申请，可以直接提交一条新的。 */
export type MockLoginApplicationState = "none" | "pending" | "reviewing";

export type MockLoginUserOption = {
  userId: string;
  /** 与 `userSeed` 一致；不一致会被测试抓住 */
  nickname: string;
  /** 与 `companionApplicationSeed` 一致；不一致会被测试抓住 */
  applicationState: MockLoginApplicationState;
  /** 用途提示：这个账号在验收里干什么用 */
  purpose: string;
};

/**
 * 预置用户名下**没有**申请时，验收第一步就是「提交一条入驻申请 → 后台通过」；
 * 已经有「待查看 / 审核中」的申请时，后台可以直接通过那一条，不必再提交。
 * 这句话要把两条路都讲清楚，否则测试者会先去提交、然后撞上「你已经有一条申请了」。
 */
export const MOCK_LOGIN_PICKER_NOTICE =
  "这是开发阶段的测试账号名单，点一下即以该账号登录（没有密码，也不会调用真实微信接口）。" +
  "名单标注了每个账号名下的入驻申请状态：没有申请的可以先提交一条再由后台通过，" +
  "已有「待查看 / 审核中」申请的后台可以直接通过，两条路都能把人变成打手。";

export const MOCK_LOGIN_PICKER_TITLE = "选择测试账号";

/**
 * 名单本身。顺序即页面顺序：第一个是默认登录的那位，排在前面方便直接用。
 *
 * ⚠️ 只放 **6 个**，不是「把所有预置用户列出来」：名单长了之后，验收的人要先读一遍
 * 才知道该点谁。这里只保留验收链路上真正需要的角色——一个下单的老板、
 * 两个能变成打手的账号（一个已有可批的申请、一个需要新提交），以及一个备用的老板身份。
 */
export const MOCK_LOGIN_USERS: MockLoginUserOption[] = [
  {
    userId: "u-1001",
    nickname: "老板A（占位）",
    applicationState: "none",
    purpose: "下单用户（老板 A）",
  },
  {
    userId: "u-1002",
    nickname: "老板B（占位）",
    applicationState: "pending",
    purpose: "打手 B 候选（后台可直接通过它的申请）",
  },
  {
    userId: "u-1003",
    nickname: "星野（占位）",
    applicationState: "reviewing",
    purpose: "打手 C 候选（后台可直接通过它的申请）",
  },
  {
    userId: "u-1008",
    nickname: "小满（占位）",
    applicationState: "none",
    purpose: "打手候选（需先提交入驻申请）",
  },
  {
    userId: "u-1009",
    nickname: "青柠（占位）",
    applicationState: "none",
    purpose: "打手候选（需先提交入驻申请）",
  },
  {
    userId: "u-1010",
    nickname: "未消费（占位）",
    applicationState: "none",
    purpose: "备用下单用户",
  },
];

/**
 * 申请状态在名单上的显示名。
 *
 * 与客服端账号名单同一个取舍：**状态由数据决定、文案由这里决定**，
 * 页面上不出现手写的「可提交申请」这类断言——那种句子没人能验证它是不是还成立。
 */
export const MOCK_LOGIN_APPLICATION_STATE_LABELS: Record<MockLoginApplicationState, string> = {
  none: "无入驻申请",
  pending: "已提交申请（待查看）",
  reviewing: "已提交申请（审核中）",
};

// ————————————————————————— 设置页的切换入口 —————————————————————————

export const MOCK_USER_SWITCH_LABEL = "切换 Mock 用户";

/**
 * 切换入口下面那句说明。
 *
 * 必须写清「点完之后会怎样」：这个按钮会**退出当前账号并停在设置页**，
 * 而设置页会立刻变成登录界面让选下一个账号。不写的话，点下去看到「需要登录」
 * 会以为是自己把账号弄丢了。
 */
export const MOCK_USER_SWITCH_NOTICE =
  "仅开发环境可见：退出当前账号并停在设置页，随后在登录界面选择另一个测试账号。" +
  "不同浏览器窗口（含无痕窗口）各自保留自己的登录态，可以同时用两个身份验收接单。";
