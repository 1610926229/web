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
 * 手工验收 P0-5 / P0-6 的完整链路要**同时扮演多个用户**（老板下单、打手 B 接单、打手 C 抢单）。
 * 在此之前，用户端登录按钮固定登录第一个预置用户，验收期只能靠手改 Cookie 或 curl
 * 换身份——那不是「人工走完整链路」。名单把这件事变成点两下。
 *
 * DEV-1 起用户端有**两个**入口读这份名单，都在未登录 / 已登录两侧覆盖到：
 * - 已登录：全局布局右下角的悬浮面板（`lib/auth/MockIdentityPanel.tsx`）——
 *   点一下直接换成另一个账号，不用先退出；
 * - 未登录：登录界面上的选择器（`lib/auth/MockUserPicker.tsx`，由 `LoginGate` 渲染），
 *   设置页的「切换 Mock 用户」退出之后落到这里。
 *
 * 两个入口共用同一份名单与同一条登录链路（`authAdapter` → `/api/auth/mock-login`），
 * 名单因此只此一份：谁都不是「另一套 Mock 身份系统」。
 *
 * ## 名单里的三件事都必须能被验证
 *
 * 1. **`userId` 与 `nickname` 与真实 Seed 一致**——写错了会让人以为登录失败；
 * 2. **`applicationState` 与预置的入驻申请状态一致**——它决定这个账号该走哪条路
 *    变成打手（新提交一条 / 后台直接通过已有的一条 / 不用走，因为已经是了）；
 * 3. **名单里不出现「未通过 / 已撤销」的用户**——那两种状态下这个账号既提交不了
 *    新申请（一人一条），后台也没有可批的申请，点进去只会卡在半路。
 *    ⚠️ `approved` **不在这条禁令里**（DEV-1 起）：一个已经通过、并且**名下真有护航资料**
 *    的账号是可以直接用的——它是「现成的打手」，不是死路。但「已通过」本身不算数，
 *    测试会再核对这个账号是不是真的有效打手，见第 4 条。
 * 4. **名单里标成 `approved` 的账号必须真的是打手**——由服务端资格判定
 *    （`resolveCompanionAccess`）现算，不是名单自己说了算。
 *
 * 四条都由 `tests/mockUsers.test.mjs` / `tests/devIdentity.test.mjs` 拿**真实 Seed** 核对，
 * 名单不是「写了就算」。因此 Seed 一改，这里就会红，而不是安静地对不上。
 *
 * ## 关闭时不可见
 *
 * `ENABLE_MOCK_AUTH=false` 时：本名单**根本不进入页面**（登录界面不渲染选择器、
 * DEV-1 的悬浮面板整个不渲染）、`/api/auth/mock-login` 继续返回 404、
 * 设置页也不出现切换入口。
 * 组件层的开关判定见 `lib/auth/LoginGate.tsx`、`lib/auth/MockIdentitySwitcher.tsx`
 * 与 `app/(mobile)/settings/page.tsx`。
 */

/**
 * 预置数据里这个账号的入驻申请状态。
 *
 * - `none`：没有申请，可以直接提交一条新的；
 * - `pending` / `reviewing`：已提交，后台可以直接通过它；
 * - `approved`：已经通过（因此这个账号**已经**是打手，不必也不能再申请）。
 *   名单里出现它，是因为 DEV-1 的验收需要「一启动就是打手」的账号。
 */
export type MockLoginApplicationState = "none" | "pending" | "reviewing" | "approved";

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
 *
 * DEV-1 起还有第三种账号：**已经是打手**（名下真有护航资料）。它不在这两条路里，
 * 也要说清楚——否则验收的人会以为「已通过」是个走不通的状态。
 */
export const MOCK_LOGIN_PICKER_NOTICE =
  "这是开发阶段的测试账号名单，点一下即以该账号登录（没有密码，也不会调用真实微信接口）。" +
  "名单标注了每个账号名下的入驻申请状态：没有申请的可以先提交一条再由后台通过，" +
  "已有「待查看 / 审核中」申请的后台可以直接通过，两条路都能把人变成打手；" +
  "标着「入驻已通过」的账号已经是打手，可以直接切过去接单。";

export const MOCK_LOGIN_PICKER_TITLE = "选择测试账号";

/**
 * 名单本身。顺序即页面顺序：第一个是默认登录的那位，排在前面方便直接用。
 *
 * ⚠️ 只放 **8 个**，不是「把所有预置用户列出来」：名单长了之后，验收的人要先读一遍
 * 才知道该点谁。这里只保留验收链路上真正需要的角色：
 *
 * - `u-1022` / `u-1023`：**一启动就已经是打手**（有护航资料），用来直接跑
 *   「老板下单 → 打手 A 接单/取消 → 打手 B 抢单」这条链，不必先走一遍审核；
 * - `u-1002` / `u-1003` / `u-1008` / `u-1009`：**还不是打手**，用来走
 *   「提交申请 → 后台通过」或「后台直接通过已有申请」这两条产生打手的路；
 * - `u-1001` / `u-1010`：下单的老板。
 *
 * ⚠️ 上面那两条「已经是打手」的判断**不由这份名单声明**：名单里只写 userId 与用途，
 * 谁是打手由服务端读护航资料现算（`resolveCompanionAccess`），见
 * `lib/auth/MockIdentitySwitcher.tsx`。名单本身不是权限来源，也不是资格来源。
 */
export const MOCK_LOGIN_USERS: MockLoginUserOption[] = [
  {
    userId: "u-1001",
    nickname: "老板A（占位）",
    applicationState: "none",
    purpose: "下单用户（老板 A）",
  },
  {
    userId: "u-1022",
    nickname: "夜航（占位）",
    applicationState: "approved",
    purpose: "打手 A（已是有效打手，可直接接单）",
  },
  {
    userId: "u-1023",
    nickname: "栖迟（占位）",
    applicationState: "approved",
    purpose: "打手 B（已是有效打手，可直接接单）",
  },
  {
    userId: "u-1002",
    nickname: "老板B（占位）",
    applicationState: "pending",
    purpose: "打手候选（后台可直接通过它已有的申请）",
  },
  {
    userId: "u-1003",
    nickname: "星野（占位）",
    applicationState: "reviewing",
    purpose: "打手候选（后台可直接通过它已有的申请）",
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
  approved: "入驻已通过",
};

/**
 * **服务端按真实资格派生**的身份标签，用于让验收的人一眼分辨三种身份。
 *
 * ⚠️ 这份标签**只是显示**，不是权限依据：面板不拿它做任何判断，
 * 页面放行仍然只由 `requireCompanion()` / 打手接口守卫决定。
 * 键是 `resolveCompanionAccess` 的 `kind`，因此标签天然不可能与真实判定脱节——
 * 谁把这里改错，页面上就会出现「写着有效打手、进不去工作台」的自相矛盾。
 *
 * 键写成字符串字面量而不是 import 那个联合类型：本文件是**纯常量、没有任何 import**
 * （`tests/mockUsers.test.mjs` 钉住这一点），`lib/services/companionAccess` 是服务端模块，
 * 不能被它引进来。
 */
export const MOCK_LOGIN_ACCESS_LABELS: Record<string, string> = {
  granted: "有效打手",
  disabled: "打手已下架",
  "not-a-companion": "普通用户",
};

// ————————————————————————— 设置页的切换入口 —————————————————————————

export const MOCK_USER_SWITCH_LABEL = "切换 Mock 用户";

/**
 * 切换入口下面那句说明。
 *
 * 必须写清「点完之后会怎样」：这个按钮会**退出当前账号并停在设置页**，
 * 而设置页会立刻变成登录界面让选下一个账号。不写的话，点下去看到「需要登录」
 * 会以为是自己把账号弄丢了。
 *
 * ⚠️ 第二句必须与**真实行为**一致：会话是同一个**同域、`path=/` 的 httpOnly Cookie**
 * （`lib/auth/session.ts`），因此同一浏览器 profile 下的普通窗口与普通标签页
 * **共享**登录态——在第二个普通窗口登录另一个账号，会把第一个窗口一起顶掉。
 * 说成「不同窗口各自保留登录态」，验收的人就会把「我的另一个身份掉线了」
 * 当成接单逻辑出了问题。真正彼此隔离的只有无痕窗口 / 另一个浏览器 / 另一个浏览器 Profile。
 */
export const MOCK_USER_SWITCH_NOTICE =
  "仅开发环境可见：退出当前账号并停在设置页，随后在登录界面选择另一个测试账号。" +
  "登录态保存在同一个 Cookie 里，同一浏览器的普通窗口与普通标签页共享它——" +
  "在第二个普通窗口登录另一个账号，会把第一个窗口一起顶掉。" +
  "要在同一个窗口里连续换身份（DEV-1 的悬浮面板），用不着无痕窗口；" +
  "要**同时**看到两个身份，才需要无痕窗口 / 另一个浏览器 / 另一个浏览器 Profile。";

// ————————————————————— DEV-1：身份切换面板（开发 / 测试工具） —————————————————————
//
// 面板本身的实现在 `lib/auth/MockIdentityPanel.tsx`（客户端）与
// `lib/auth/MockIdentitySwitcher.tsx`（服务端开关）。这里只放**文案**，
// 与设置页的切换入口同一个取舍：文案是常量，行为在组件里。
//
// ⚠️ 这几条常量**只在面板被渲染时才进入响应**。面板由服务端开关控制，
// `ENABLE_MOCK_AUTH !== "true"` 时根本不渲染（见 `MockIdentitySwitcher`），
// 因此正式部署的 HTML 里不会出现任何 Mock 用户线索。

/** 悬浮按钮上的小标题：明确标识这是开发工具，不是产品功能。 */
export const MOCK_IDENTITY_TOOL_LABEL = "Mock 身份";

/** 面板标题。带「开发工具」四个字，避免被误当成正式功能。 */
export const MOCK_IDENTITY_TOOL_TITLE = "Mock Identity（开发工具）";

export const MOCK_IDENTITY_CURRENT_LABEL = "当前身份";

/** 没有会话时面板上显示的当前身份。 */
export const MOCK_IDENTITY_GUEST_LABEL = "游客（未登录）";

/**
 * 面板顶部那句说明。
 *
 * 必须写清**它替换的是当前会话**：DEV-1 的定位就是「把一个会话从 A 换成 B」，
 * 不是「同时登录两个账号」。不写的话，验收的人会以为点完之后另一个身份还留着。
 */
export const MOCK_IDENTITY_NOTICE =
  "点一下即以该账号登录，替换当前会话（同一个 Cookie，没有第二套登录态）。" +
  "切换后页面按新身份重新渲染：上方的导航、「我的」、打手工作台的资格都会跟着变。";

export const MOCK_IDENTITY_LOGOUT_LABEL = "退出登录";

export const MOCK_IDENTITY_CLOSE_LABEL = "收起";
