# 目录结构（Directory Structure）

> 依据当前真实目录生成。状态标签：**CURRENT** / **TARGET**（`NOT IMPLEMENTED`）/ **TBD**（`DO NOT INVENT`）。
>
> **没有 `src/` 目录。** 路径别名 `@/*` 直接映射到仓库根（`tsconfig.json`）。

> **2026-09-23 需求重校准说明**：本文的文件数量/目录树仍是 CURRENT 源码快照；需求 V0.3 新增的取消接单、自动完成审核、封禁/客服换人回池等只在 TARGET 放置规则中描述，**不得因此修改 CURRENT 计数或假装目录已经存在**。

---

# 一、顶层

```
web/
├── app/                    Next.js App Router：页面与接口
├── components/             121 个 .tsx，按业务域分目录
├── lib/                    全部业务逻辑（无 src/）
├── tests/                  51 个 .test.mjs + 测试基础设施
├── docs/                   需求、技术设计、开发、测试文档
├── public/                 静态资源
├── .claude/agents/         项目级 Claude Agent 定义（4 个，见 agent-collaboration.md）
├── next.config.ts          空配置
├── tsconfig.json           路径别名 @/* → 仓库根
├── eslint.config.mjs       flat config
├── postcss.config.mjs      @tailwindcss/postcss
├── pnpm-workspace.yaml     allowBuilds 白名单
├── package.json
└── AGENTS.md / CLAUDE.md   Next 管理的规则块 + 项目说明
```

---

# 二、`app/` —— 页面与接口

```
app/
├── layout.tsx              仅文档骨架（<html> / <body> / metadata / viewport），无产品级布局、无 next/font
├── globals.css             Tailwind v4 @theme 设计令牌（233 行；含中文字体栈）
├── (mobile)/               用户端（34 个页面目录）
│   ├── layout.tsx          480px 移动壳层
│   ├── (tabs)/             五个底部 tab 的容器
│   │   ├── (protected)/    需登录的一级页：mine / orders / service
│   │   ├── category/
│   ├── orders/[id]/        订单详情（不显示底部导航，故在 (tabs) 之外）
│   ├── checkout/  pay/     下单与支付
│   ├── complaints/  refunds/  reviews/  coupons/  favorites/
│   ├── companions/  product/  rank/  tips/  suggestions/  agreements/
│   ├── service/chat/       客服会话
│   ├── join/               入驻申请
│   └── profile/  settings/  rights/  help/  activities/  placeholder/
├── admin/
│   ├── login/
│   └── (console)/          桌面后台（自己渲染布局，不复用移动壳层）
│       ├── (overview)/     概览
│       ├── (list)/         列表型模块的统一分组
│       ├── orders/  refunds/  complaints/  applications/
│       ├── companions/  products/  categories/  staff/
│       ├── content/{agreements,announcements,banners,quick-entries}/
│       └── platform-config/  customer-service/
├── staff/(console)/        客服工作台：complaints / conversations / refunds
├── companion/(console)/    打手工作台：orders（我的订单）/ orders/[id]（订单详情）
│                           / earnings（我的收益，P0-9）/ exclusive（专属池）/ pool（公共池）
└── api/                    125 个 route.ts（admin 62 · staff 20 · companion 8 · 其余为用户端）
```

## 路由组（Route Group）说明 —— CURRENT，必读

| 组 | 作用 |
|---|---|
| `(mobile)` | **用户端 480px 移动壳层**。壳层下移到路由组，就是为了**不让它罩住 `/admin`** |
| `(tabs)` | 底部导航容器 |
| `(protected)` | 需登录的一级页 |
| `(console)` | 后台壳层（admin / staff / companion 各一个） |
| `(overview)` / `(list)` | 管理后台的二级分组 |

**路由组只影响布局与文件组织，不产生 URL 段。**
`app/(mobile)/rights/page.tsx` 的 URL 是 `/rights`。
按文件路径硬编码去读源码是**错的**——用 `tests/app-path.mjs` 的 `findAppFile("rights/page.tsx")`。

## `app/api/` 分组

```
app/api/
├── auth/  admin/auth/  staff/auth/       三类登录（+ companion 无自己的 auth）
├── home/  catalog/  companions/  rankings/  agreements/  公开读取
├── me/  favorites/  coupons/  notifications/  tips/  suggestions/  reviews/
├── orders/  payments/  refunds/  complaints/  service/
├── companion/                             打手接口（当前 2 个）
├── companion-applications/                入驻申请
├── staff/                                 客服接口（16 个）
└── admin/                                 管理接口（62 个，含 admin/auth 3 个）
```

---

# 三、`components/` —— 展示组件

**按业务域分目录**，共 28 个子目录、121 个 `.tsx`：

```
components/
├── common/       跨域复用（PriceText、空态、加载…）
├── admin/        后台组件（体量最大）
├── companion/    打手工作台（CompanionHeader、CompanionDispatchTable/Card…）
├── staff/        客服工作台
├── orders/ refunds/ complaints/ reviews/ coupons/ favorites/
├── checkout/ payment/ catalog/ product/ home/ category/
├── companions/   陪玩列表与入驻表单
├── mine/ profile/ settings/ rank/ rights/ service/ tips/ suggestions/ agreements/
└── auth/
```

**约定**：`components/` 不 import `lib/data`，不直接 `fetch`，不做金额计算。

---

# 四、`lib/` —— 全部业务逻辑

| 目录 | 文件数 / 行数 | 职责 |
|---|---:|---|
| `lib/types/` | 29 / 4784 | **纯类型声明**。禁止业务逻辑 |
| `lib/constants/` | 47 / 12645 | **领域规则**：状态机表、校验、固定文案、DTO 映射 |
| `lib/data/` | 59 / 9834 | 仓储接口 + Mock 实现 + 伪事务 |
| `lib/services/` | 62 / 12229 | 服务端业务 + 浏览器 HTTP 客户端 |
| `lib/auth/` | 11 / 771 | 会话、登录门、适配器、Mock 身份切换面板 |
| `lib/api/` | 6 / 381 | 四个路由守卫 + 响应信封 + 浏览器 HTTP 出口 |
| `lib/mocks/` | 22 | 种子数据与调试工具 |
| `lib/config/` | 1 / 62 | Mock 环境开关 |
| `lib/utils/` | 3 / 114 | `format.ts`（金额/日期）、`query.ts`、`text.ts` |

## 4.1 `lib/types/`

29 个文件，每个业务域一个。**纯类型，无逻辑。**
`common.ts` 定义全站通用类型：`ApiErrorCode`、`ApiSuccessBody<T>`、`ApiErrorBody`、`PageResult<T>`。

## 4.2 `lib/constants/`

**这一层承载业务规则是刻意的，不是偶然。**

- **状态机**：`adminRefunds.ts` / `adminComplaints.ts` / `adminApplications.ts` / `orders.ts` 各自声明 `Record<Status, readonly Status[]>` 转移表 + 派生 `canTransitionXxx`（`orders.ts` 的 `allowedOrderActions` 尚无需求）。
  **P0-5.5 已实现**：`orders.ts` 的 `ORDER_TRANSITIONS` / `canTransitionOrder`（此前不存在）。见 `architecture-rules.md` §2.6。
- **校验**：`checkout.ts`（`validateGameAccount`）、`safePath.ts`、`complaints.ts`（`validateComplaintText`）…
- **金额规则**：`orderAmount.ts` —— 唯一合成点。
- **集中配置**：`site.ts`（`PLATFORM_NAME = "超哥电竞"`、`PLACEHOLDER_NOTICE`）。**禁止在页面内硬编码平台名**。

## 4.3 `lib/data/` —— 仓储与伪事务

```
lib/data/
├── xxxRepository.ts        接口 + getXxxRepository()（硬编码返回 mock 单例）  ← 23 个
├── mockXxxRepository.ts    唯一实现，通过 getMockStore 拿 store             ← 23 个
├── *Transaction.ts         伪事务（原子区段）                              ← 9 个
├── adminWriteSupport.ts    幂等重放 / 审计写入 / id 生成（公共支持）
├── mockStore.ts            globalThis 挂载，23 个 store 名
└── source.ts + mockSource.ts   服务端只读门面（11 个方法）
```

**⚠️ 新增实体时的标准做法**：加一对 `xxxRepository.ts` + `mockXxxRepository.ts`，在 `mockStore.ts` 的 `MockStoreName` 里加一个 store 名。
**不要**新建第二套 Order / Refund / Notification。

## 4.4 `lib/services/` —— 服务端业务 + 浏览器客户端

62 个文件，**两类混放在同一目录**：

| 类型 | 命名 | 数量 | 例子 |
|---|---|---|---|
| 服务端业务 | 无后缀 | ~42 | `orders.ts`、`checkout.ts`、`adminRefunds.ts` |
| 浏览器 HTTP 客户端 | `*Http.ts` | 20 | `ordersHttp.ts`、`staffHttp.ts` |
| **管理端聚合** | `adminHttp.ts` | 1（1163 行） | 承载全部 62 个管理接口的客户端 |

**⚠️ 服务端与浏览器必须分开**，否则 Mock 存储与种子数据会被打进浏览器产物。
**⚠️ `adminHttp.ts` 是 Observed Current，不是规范**——新管理接口不必须往里塞。见 `architecture-rules.md` §六。

## 4.5 `lib/api/`

| 文件 | 内容 |
|---|---|
| `route.ts` | `ok()` / `fail()` / `toApiError()` / `readJsonBody()` / `requireUser()` |
| `ApiError.ts` | `ApiError` 类 + 错误码 → HTTP 状态映射 |
| `client.ts` | **浏览器唯一 HTTP 出口**：`apiGet` / `apiPost` / `apiPatch` / `apiDelete` |
| `adminRoute.ts` | `requireAdmin()` |
| `staffRoute.ts` | `requireStaff()` |
| `companionRoute.ts` | `requireCompanion()`（组合 `requireUser()` + `resolveCompanionAccess()`） |

## 4.6 `lib/mocks/`

```
lib/mocks/
├── debug.ts                调试参数（mockError / mockEmpty / mockDelay）
└── fixtures/               21 个文件（20 个种子 + mockClock 可控时钟）
    ├── orderSeed.ts (1000) catalogSeed.ts (601) seed.ts (557) …
    ├── mockClock.ts        可控时钟
    └── *Seed.ts
```

**约定**：预置数据在**建仓时**写入同一个 Map，与运行时新建的数据走同一条查询路径。
这样「新订单立刻出现在列表/池子里」才是可验证的。
**禁止**为预置数据开旁路查询。

## 4.7 `lib/auth/`

`session.ts`（用户）/ `adminSession.ts` / `staffSession.ts` 三套 + `AuthAdapter.ts` / `MockAuthAdapter.ts` / `useAuth.tsx` / `LoginGate.tsx` / `RequireAuth.tsx` / `MockUserPicker.tsx` / `MockIdentitySwitcher.tsx` / `MockIdentityPanel.tsx`。

后两个是 **DEV-1 的开发工具**：服务端门禁（`MockIdentitySwitcher`，判 `ENABLE_MOCK_AUTH`
并读会话）+ 客户端面板（`MockIdentityPanel`，复用 `MockUserPicker` 与 `authAdapter`）。

⚠️ `MockIdentitySwitcher` 还多做一件事：它**逐个现算**名单里每个账号的打手资格
（`lib/services/companionAccess.ts` 的 `resolveCompanionAccess`，与打手工作台、打手接口守卫
同一个入口），把结果作为**显示用**标签传给面板。这只是显示——面板不拿它做禁用或跳转，
页面放行仍只由守卫决定。这段计算在开关早返回**之后**，因此正式形态不执行、也不进响应。
它们只换掉**当前**会话，不构成身份来源，也不出现在管理端 / 客服端 / 打手工作台。

**⚠️ 打手没有自己的会话模块**——复用用户会话。**禁止新增第二套打手认证。**

---

# 五、`tests/`

```
tests/
├── *.test.mjs                 57 个测试文件
├── alias-hook.mjs             node --import 入口，注册下面的 hook
├── alias-loader.mjs           ~20 行，教会 node「@/ 别名」与「无扩展名相对导入」
├── app-path.mjs               按**路由**（忽略路由组）查找 app/ 下源文件
└── manual/
    └── browserChain.mjs       手工浏览器链路脚本（不在自动测试内）
```

**命名惯例**：`<域>.test.mjs`（`orders`、`refunds`）、`admin<域>.test.mjs`、`staff<域>.test.mjs`、`<域>Http.test.mjs`、跨角色用 `<A>CrossRole.test.mjs`。

**测试只覆盖非组件模块**（Node 不剥离 JSX）。
组件行为通过 `docs/superpowers/plans/` 里的「手工验收」步骤验证。

**三类特殊测试**：

1. **接口清单门禁**：`admin.test.mjs`（62 条）、`staff.test.mjs`（16 条）、`companion.test.mjs`（5 条，产品裁定 2026-09-19，**P0-5.5 建立 / P0-6 扩充**）。三者都扫描对应端口的 `app/api/**` 与预期清单比对，沿用现有源码扫描方式，**不新建测试框架**。
2. **路由门禁**：`routes.test.mjs` 真实扫描 `app/` 并与页面配置里的入口地址比对。
3. **HTTP 冒烟**：`http-smoke.test.mjs`，需 `APP_BASE_URL`。

---

# 六、`docs/`

```
docs/
├── 01-requirements/        ★ 权威需求（三份，超哥电竞_业务/权限/异常）
├── 02-tech-design/         ★ 本目录：架构规则与技术设计
│   └── agent-collaboration.md  4 个项目级 Agent 的职责边界与协作协议
├── 03-dev/                 ★ 开发轮次记录协议 + 全局进度真值源
│   ├── development-workflow.md   Development Round Protocol（强制，见 CLAUDE.md 入口）
│   ├── 总需求进度表.md           ★ 全局项目进度唯一真值源（禁止另建 PROJECT_PROGRESS）
│   └── rounds/                  每个批次的决策档案：README / 01-prompt / 02-decisions / 03-delivery / 04-acceptance
├── 04-testing/             测试文档（当前为空）
├── superpowers/plans/
│   └── 2026-09-17-order-lifecycle-alignment.md   1281 行，P0-1…P0-9 与 P1 的批次定义
└── ui-reference/prototype/ 18 张原型图（1260×2750，中文 UI，微信内置浏览器截图）
```

**⚠️ 原型图位置**：`docs/ui-reference/prototype/`。
**`docs/prototype/` 已不存在**（旧的 `CLAUDE.md` 里的路径是错的）。

**⚠️ 原型图是 UI 的唯一真值源**，但**不是业务完成度的证据**——
「页面上看得到」不等于「功能已经实现」。

---

# 七、`public/`

```
public/
├── mock/                   12 个 Mock 图片资源（头像、商品封面、公告图、凭证占位）
└── *.svg                   脚手架自带的 5 个图标（next / vercel / file / globe / window）
```

生产图片资源尚未接入。**TBD**：真实图片存储方案。

---

# 八、新功能放置规则

## 8.1 生命周期类 P0 功能通常跨越的位置

> 旧文档用“P0-6 开始服务”作示例。2026-09-23 需求重排后编号已由用户重新分配：
> **P0-6 = `accepted` 主动取消接单 + 重新进入公共池（含打手「我的订单」最小入口）**。
>
> **CURRENT（P0-6 / P0-7 落地）**：A 段的 `lib/types/order.ts`、`lib/constants/orders.ts`、
> `lib/data/mockPaymentRepository.ts`、`lib/services/companionOrders.ts`、
> `lib/services/companionHttp.ts`、`app/api/companion/orders/**`（**四件套**）、
> `app/companion/(console)/orders/**`、`components/companion/*Order*.tsx`、
> `tests/companionOrders.test.mjs` 均已落地；伪事务落在
> `lib/data/companionOrderTransaction.ts`（新增，A 段原文未列出该文件名，实现时新增）。
> **TARGET — NOT IMPLEMENTED**：D 段（lifecycle 配置扩展）剩下的部分。
> 完成材料提交（`orders/[id]/completion`）与 B 段（CompletionSubmission / 人工审核 / 自动审核）
> **已于 P0-8 落地**——见下方 B 段。

### A. 打手“我的订单 / 取消接单 / 开始服务”

```text
lib/types/order.ts
lib/constants/orders.ts                          ← TARGET 新结构状态机
lib/data/mockPaymentRepository.ts                ← 同步 Order 写原语（按现有历史归属，不强行重构 Repository）
lib/data/companionOrderTransaction.ts            ← 跨 Order / Dispatch / release history / notification 的伪事务
lib/services/companionOrders.ts
lib/services/companionHttp.ts                    ← 浏览器客户端可继续复用/扩展
app/api/companion/orders/route.ts                 ← GET 我的订单；**已落地并已在 manifest**（P0-6）
app/api/companion/orders/[id]/route.ts            ← GET 详情；**已落地并已在 manifest**（P0-6）
app/api/companion/orders/[id]/cancel/route.ts     ← POST accepted 主动取消 + reason；**已落地并已在 manifest**（P0-6）
app/api/companion/orders/[id]/start/route.ts      ← POST accepted → serving；**已落地并已在 manifest**（P0-7）
                                                     ⚠️ 它**不读请求体**（没有 reason、没有幂等键），
                                                        因此该文件里不出现 `readJsonBody`
app/api/companion/orders/[id]/completion/route.ts ← POST 提交完成材料；**已落地并已在 manifest**（P0-8）
app/api/companion/earnings/route.ts               ← GET 我的收益；**已落地并已在 manifest**（P0-9）
                                                     ⚠️ **只导出 GET**——收益的写入没有 HTTP 入口
app/companion/(console)/orders/page.tsx
app/companion/(console)/orders/[id]/page.tsx
components/companion/*Order*.tsx
tests/companionOrders.test.mjs
docs/02-tech-design/api-contract.md
```

同一个 `/companion/orders/[id]` 详情页继续承载 `serving` 的“提交完成材料”（`accepted` 的「开始服务」已于 P0-7 落在这个页面上），不得为 completion 再造第二套订单详情。
**完成材料提交已于 P0-8 落在同一个详情页上**（`CompanionCompletionPanel`），没有第二套订单详情。

### B. CompletionSubmission + 自动审核

> **已于 P0-8 落地。** 实际落点与下面的草图**基本一致**，差异只有三处，均为新增文件
> （草图未列出而未违反草图）：`lib/constants/staffCompletions.ts`（客服端筛选 / 排序 /
> 文案 / DTO 转换）、`lib/services/staffCompletionsHttp.ts`（客服浏览器客户端）、
> 以及 `app/staff/(console)/completions/**` 四个页面文件。
> 另外**没有**独立的「作废」原子区段——`invalidated` 按 P0-8 D3 保留类型但零写入路径。

```text
lib/types/completion.ts
lib/constants/completions.ts                     ← 5~50 字、状态/动作校验
lib/data/completionRepository.ts
lib/data/mockCompletionRepository.ts
lib/data/completionTransaction.ts                ← 提交/人工审核/自动审核/作废的原子区段
lib/services/companionCompletions.ts
lib/services/staffCompletions.ts
app/api/companion/orders/[id]/completion/route.ts
app/api/staff/completions/**/route.ts
components/companion/*                           ← 复用打手订单详情
components/staff/*                                ← 客服完成审核 UI（若该 Round 包含 UI）
tests/completions.test.mjs
```

规则：同一订单最多一个 pending；默认自动审核 10 分钟但由平台配置；每次 pending 冻结 snapshot/deadline；封禁回池时旧 pending 必须失效。真实 Scheduler 以后只调用同一 domain sweep，不另写逻辑。

### C. 最小“履约退出历史 / 回公共池”

P0 明确不先建设复杂 Assignment 聚合。若实现需要独立持久事实，按 `database-schema.md` T4 的最小 `CompanionReleaseRecord` 放置：

```text
lib/types/companionRelease.ts                    ← 仅最小历史字段
lib/data/companionReleaseRepository.ts
lib/data/mockCompanionReleaseRepository.ts
```

它由以下事务消费，不自己拥有业务状态机：

- 打手 accepted 主动取消 —— **CURRENT（P0-6）**：`lib/data/companionOrderTransaction.ts` 的 `cancelAcceptedOrder`；底层「写退出历史 → 清当前履约绑定 → Order 回 paid → Dispatch 回 public → 通知」抽成一个**非导出**的私有出口（`writeAcceptanceRelease`），只有 `cancelAcceptedOrder` 调用它。
  同一个文件另有 P0-7 的 `startCompanionOrder`（`accepted → serving`，**不产生退出历史、不动派单、不发通知**）：两个动作同属「打手对自己这一单做什么」这一个域，因此共用文件与同一份原子性依据，该文件当前共**两个**公开入口；
- Admin 封禁/移除当前打手 —— **TARGET — NOT IMPLEMENTED**（§十四 out of scope）；
- Staff 直接换人 —— **TARGET — NOT IMPLEMENTED**（§十四 out of scope）。

三者统一复用上面那条底层能力；**accepted 用户直接退款是终态退款，保留 actualCompanionId，不走回池清绑定语义。**

### D. 平台 lifecycle 配置

继续复用现有 `PlatformConfig` / `/api/admin/platform-config`，不要新建第二套配置域。TARGET 增加 exclusive timeout、Completion 自动审核时长、投诉窗口；进入对应生命周期阶段时冻结 snapshot/deadline。

**进度**：`completionAutoApprovalMinutes`（Completion 自动审核时长）**已于 P0-8 落地**——
加在同一个 `PlatformConfig` 上（`lib/types/platformConfig.ts`）、走同一个
`/api/admin/platform-config` 的 PATCH 与同一份审计，**没有**新建第二套配置域。
`AdminPlatformConfigPatch` 的三个字段都是**可选**的，PATCH 只带改动的那一项。
`complaintWindowMinutes`（投诉窗口时长）**已于 P0-9 落地**，同样加在同一个实体上
（默认 1440、取值 60~10080）。
仍属 TARGET：`exclusivePoolTimeoutMinutes`。

⚠️ **新增第四个参数时要动的地方（P0-9 的实际改动面）**：
`lib/constants/platformConfig.ts`（默认值 / 上下界 / `isValidXxx` / 提示文案 / `PLATFORM_CONFIG_NOTICE`）、
`lib/types/platformConfig.ts`、`lib/mocks/fixtures/platformConfigSeed.ts`、
`lib/data/adminPlatformConfigTransaction.ts`（`PlatformConfigInput` + **`PATCHABLE_FIELDS`**——
这个 `Record<keyof PlatformConfigInput, true>` 会让「忘了把字段加进 no-op 判定」变成 `tsc` 报错）、
`lib/constants/adminAudit.ts`（审计快照）、`lib/services/adminPlatformConfig.ts`（输入解析）、
`components/admin/AdminPlatformConfigConsole.tsx`（第三个独立保存的输入框）。
**四处都要改，漏一处不会静默**——但漏掉审计快照不会有类型错误，那是唯一需要靠人记住的一处。

### E. Earning / 结算域（P0-9 落地）

```text
lib/types/earning.ts                    ← Earning + 打手端 DTO（不含 clubNetIncome / reversedAmount / fineAmount）
lib/constants/earnings.ts               ← 状态文案/颜色、isEarningMatured、无数字的说明文案
lib/data/earningRepository.ts           ← **只读**接口（写入必须在伪事务里）
lib/data/mockEarningRepository.ts       ← Mock Store（无种子数据）+ appendEarning / applyEarningRelease
lib/data/earningTransaction.ts          ← settleOrderCompletion（唯一结算入口）+ sweepMaturedEarnings
lib/services/companionEarnings.ts       ← DTO 拼装 + 两条 sweep 的惰性物化
app/api/companion/earnings/route.ts     ← GET only（**不得出现任何写方法**）
app/companion/(console)/earnings/**     ← 打手「我的收益」页
tests/earning.test.mjs
```

**三条落点规则（本轮确认，后续沿用）：**

1. **写入只能在伪事务里**，因此 `earningRepository` 是只读接口：如果仓储暴露 `createEarning`，
   调用方就能绕开「订单必须已是 completed」这条路，直接造一笔收益。
2. **结算入口只有一个** `settleOrderCompletion()`：P0-8 的两条完成路径都必须经它，
   `approveCompletion` / `sweepCompletionAutoApprovals` **不允许**再自己调 `applyOrderCompletion`
   （那会写出「订单 completed 了、快照和收益却没建」的一半状态）。
3. **阻塞判据复用 `lib/data/orderBlocking.ts`**：它是 `isCompletionAutoApprovalBlocked`
   的**唯一数据读取处**，P0-8 与 P0-9 共用。不要在收益域里再写一遍「有没有进行中的退款/投诉」。

**⚠️ 不要为了一个功能把所有代码写进 `route.ts` 或 `page.tsx`。** Route Handler 仍只做 guard / 参数解析 / service / response；页面只做取数与渲染。

**⚠️ 也不要为了目录纯洁强制创建没有职责的空层。** 上述是落点参考；若实现 Round 能在现有模块内清晰完成，就复用现有模块，尤其禁止借需求变更顺手重构 PaymentRepository / adminHttp / Session。

## 8.2 各目录的「该放什么」

| 目录 | 放 | 不放 |
|---|---|---|
| `lib/types/` | 类型、联合类型、DTO 结构 | 任何函数（映射函数放 constants） |
| `lib/constants/` | 状态机表、校验、固定文案、DTO 映射、领域公式 | 数据访问、异步 |
| `lib/data/` | 仓储接口、Mock 实现、伪事务、同步写原语 | 业务编排、DTO 裁剪 |
| `lib/services/` | 服务端业务编排、DTO 裁剪、浏览器 HTTP 客户端 | 直接操作 store |
| `app/api/` | 守卫、参数解析、调 service、response | 业务规则 |
| `app/**/page.tsx` | 取数 + 渲染 | 直接 `fetch`、直接 import `lib/data` |
| `components/` | 展示与交互 | 金额计算、直接 `fetch`、`lib/data` |

## 8.3 新增一个业务实体的检查清单

以「新增一个实体 `Xxx`」为例（**不含数据库，当前阶段**）：

- [ ] `lib/types/xxx.ts` —— 类型
- [ ] `lib/constants/xxx.ts` —— 规则 + 状态机表（若有状态）
- [ ] `lib/data/xxxRepository.ts` —— 接口 + `getXxxRepository()`
- [ ] `lib/data/mockXxxRepository.ts` —— 实现
- [ ] `lib/data/mockStore.ts` —— `MockStoreName` 加一个名字
- [ ] `lib/mocks/fixtures/xxxSeed.ts` —— 预置数据
- [ ] `lib/services/xxx.ts` —— 服务端业务
- [ ] `lib/services/xxxHttp.ts` —— 浏览器客户端（若需要）
- [ ] `app/api/...` —— Route Handler
- [ ] `components/...` + `app/.../page.tsx` —— 界面
- [ ] `tests/xxx.test.mjs` —— 测试
- [ ] **`tests/admin.test.mjs` / `staff.test.mjs` / `companion.test.mjs` 的清单数组**（按新增接口所属边界同步扩充；未实现的 TARGET 不得预登记）
- [ ] `docs/02-tech-design/api-contract.md` + `database-schema.md` —— 同步文档

**⚠️ 若涉及金额**：必须复用 `lib/constants/orderAmount.ts`，不得新写公式。
**⚠️ 若涉及跨实体写入**：必须走 `*Transaction.ts` 的原子区段，区段内**不得有 `await`**。
**⚠️ 若涉及幂等**：业务键必须可推导（如 `orderId` / `orderId + eventType`），不得照抄通知的随机 UUID 方案。
**⚠️ 若涉及 lifecycle timeout**：配置放既有 PlatformConfig，进入阶段时冻结 snapshot/deadline；真实 Scheduler 只调用同一 domain sweep。
**⚠️ 若涉及回池**：必须同时处理 Order 当前履约绑定、Dispatch public deadline、最小退出历史、通知，以及旧 pending completion 的失效（若存在）。

---

# 九、TBD — DO NOT INVENT

| 项 | 说明 |
|---|---|
| `docs/04-testing/` 的内容 | 目录存在但为空。**不要自行填充**，等产品负责人定义 |
| Round 档案的具体内容 | 每个批次的决策历史由该批次的 `docs/03-dev/rounds/<ROUND_ID>/` 承载，**不在本文件展开** |
| 真实图片 / 文件存储位置 | 当前只有 `public/mock/` 的占位 SVG |
| 部署目录约定 | 未确认 |
