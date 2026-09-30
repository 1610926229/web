# DEV-1 交付记录

> Round: `DEV-1` — Mock 身份切换验收工具
> 性质：**开发 / 测试基础设施**，不是 P0 业务功能（`01-prompt.md` §一）
> Status: `DONE` · Git Commit: `53481ea`（**用户本人**提交）
> ✅ **`DEV-1 DONE — implementation committed in 53481ea`**
> ✅ **2026-09-24 人工验收已通过**（`User Result` / `Final Result` = `PASSED`，见 `04-acceptance.md`）。
> ⚠️ 本轮**不修改 P0-6 的任何行为，也不修改 P0-6 的验收结果**。
> ⚠️ **本文件正文是交付时点的记录，不回溯改写**。验收后发现的两个整改项（FIX-1 / FIX-2）属 P0-6 域，
> 记在 `04-acceptance.md` 的 `Issues Found` 与 `../总需求进度表.md`，**不回写本文件的实现描述**。

> **本文件是第二次交付的版本。** 第一次交付后用户在人工验收阶段**打回**：
> 「当前可切换用户中没有任何有效 Companion」，因此「在一个浏览器里验收 P0-6 的
> User → Companion A → Companion B 链路」这个**主要用途走不通**。
> 打回后的重做见 **§2.5**（改动）与 **§9.1**（被反转的那条断言）；
> 规则层面的裁定见 `02-decisions.md` 的 **D6 V2**（D6 V1 / D3 V1 已标 `SUPERSEDED`）。
> §2.1 / §2.2 / §4 / §5 / §9 / §10 / §11 / §13 的数字与结论**均已按重做后的状态更新**。
>
> 重做批之后又跑了一轮**独立 reviewer 审查**（见 **§13.2**），它给出的 1 个 BLOCKER
> （仓库根 `README.md` 仍在教人「先去后台审核成打手」）与 1 个 MAJOR（「首屏 HTML 不含
> `u-1xxx`」在开关打开时为假）**均已修复**，另 4 个 MINOR 也已处理。
> 连带更正了共享 fixture 变化导致的陈旧文档与注释，越界边界写在 **§2.6**。
> 因此 §2.1 / §2.2 的行数与 §10 的门禁数字是**修复之后**的最终值。

---

## 1. Requirement Check 结果

| 项 | 结论 |
|---|---|
| 是否存在 `OPEN` 决策 | **否**，未进入 `CLARIFYING` |
| 是否触发 `PRODUCT_DECISION_REQUIRED` | **否**，本轮不改任何产品规则 |
| 是否命中 §十三「唯一的例外」（规则替换） | **是，一处**：`api-contract.md:23` 的「用户端页面无切换入口」被本轮指令替换。三条要求（写进 `02-decisions.md` / 同步长期文档 / 保留 SUPERSEDED 历史）全部执行，见本文件 §8 与 `02-decisions.md` D1 |
| 是否存在 §十二 要求的复用对象 | **是，四个全部存在**，见 §5 |

---

## 2. 实际修改文件

### 2.1 新增（3 个源码 / 测试文件）

行数为**第二次交付后**的最终值。

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/auth/MockIdentitySwitcher.tsx` | 81 | **服务端门禁**。`isMockAuthEnabled()` 为假 → `return null`；为真 → 读用户会话、**现算每人资格标签**，一起交给面板 |
| `lib/auth/MockIdentityPanel.tsx` | 196 | **客户端面板**。折叠 / 展开、显示当前身份、渲染 `MockUserPicker`、退出登录。完全不认识开关，也不解释标签（只转发） |
| `tests/devIdentity.test.mjs` | 683 | DEV-1 的 20 条回归（16 条离线 + 4 条 HTTP） |

### 2.2 修改（6 个已跟踪文件）

DEV-1 自身的改动量（不含 P0-6 在同一批未提交工作区里的改动）：

| 文件 | DEV-1 的改动 |
|---|---|
| `app/(mobile)/layout.tsx` | 挂载 `<MockIdentitySwitcher />` + 说明为什么挂在路由组而不是 `MobileShell` |
| `lib/constants/mockUsers.ts` | 面板文案常量 7 条；两处「谁在读这份名单」的注释更新；**重做批**：`approved` 状态、`MOCK_LOGIN_ACCESS_LABELS`、名单 6 → 8（见 §2.5） |
| `lib/auth/MockUserPicker.tsx` | 从「只出现在登录界面」改写为「测试账号选择器 + 两个宿主」；**重做批**：多两个**只用于显示**的可选入参——`accessLabels`（资格标签）与 `currentUserId`（当前身份的行内标记，`01-prompt.md` §六 的要求）。两者都不影响点击 / 跳转 / 禁用，参数集合由测试钉成封闭集合（见 §2.5 与 §13.2） |
| `app/api/auth/mock-login/route.ts` | **仅注释**：改口说明 DEV-1 面板调用同一个接口，404 保护不变 |
| `lib/services/user.ts` | **仅注释**：`login()` 的两个调用方 |
| `tests/mockUsers.test.mjs` | 结构约束由「只允许 `LoginGate` 引用」**重写**为显式的宿主清单；文件顶部的模块说明同步改口（见 §2.4）；**重做批**：`approved` 不再是死路但必须真是打手，「可被后台通过」的判据收紧（见 §2.5） |
| `lib/auth/MockIdentityPanel.tsx` | 底部偏移补安全区；退出中给账号列表忙碌态（见 §2.4）；**重做批**：透传 `accessLabels` |
| `tests/devIdentity.test.mjs` | 「没有新会话模型」那条补强为 `cookies()` 调用点清单（见 §2.4）；**重做批**：整节重写（见 §2.5） |

### 2.2.1 修改（fixture，重做批新增）

| 文件 | 改动 |
|---|---|
| `lib/mocks/fixtures/seed.ts` | `+u-1022` / `+u-1023` 两个用户；`+cp-10` / `+cp-11` 两条护航资料（`userId` / `applicationId` 都有值，`enabled` 与 `available` 都为 `true`）；`companionSeed` 的 P8A 说明段落改写（原文写着「每条记录 `userId` 都是 `null`」，重做后不再成立） |
| `lib/mocks/fixtures/companionApplicationSeed.ts` | `+ca-1008` / `+ca-1009` 两条 `approved` 申请（对应上面两位的审核来源）；`ca-1004` 的「已通过但没有护航」中间态**刻意保留**，注释写明 |
| `lib/data/mockCompanionRepository.ts` | **仅注释**：建仓注释原写「这条循环当前不会登记任何东西」——重做后 `cp-10` / `cp-11` 正是靠它登记的 |

> ⚠️ **本工作的 `git status` 里同时躺着 P0-6 的未提交改动**（两个 Round 共用一个工作区）。
> 上表的「改动」一列是逐 hunk 核对出来的 DEV-1 部分；`docs/02-tech-design/api-contract.md`
> 的整份 diff 是 `+52 / −15`，其中**属于 DEV-1 的只有第 23 行那一行**（`+1 / −1`），
> 其余全部是 P0-6 的接口文档改动。汇报时不要把整份 diff 记在 DEV-1 名下。

### 2.3 修改（长期文档，属规则替换的 §十三 义务）

| 文件 | 改动 |
|---|---|
| `docs/02-tech-design/api-contract.md` | 第 23 行 `POST /api/auth/mock-login` 的说明改口（**1 行**） |
| `docs/02-tech-design/directory-structure.md` | `lib/auth/` 行 `9 / 552` → `11 / 771`；§4.7 补两个新文件与一段说明 |
| `README.md` | Mock 认证一节补「浏览器里换身份」的用法与关闭态行为 |
| `docs/03-dev/rounds/README.md` | Round 索引新增 DEV-1 行 |
| `docs/03-dev/总需求进度表.md` | 全局进度表新增 DEV-1 行 + 主线补一行 |

### 2.4 审查后修复批次（reviewer 提出，均属本轮自身范围）

独立 reviewer 对 DEV-1 的改动集做了只读审查，结论 `BLOCKER 0 / MAJOR 1 / MINOR 3 / NOTE 4`。
四条已处理，**没有一条扩大本轮范围**：

| # | 级别 | 问题 | 处理 |
|---|---|---|---|
| M1 | MAJOR | `tests/mockUsers.test.mjs` 的**模块级说明**仍在陈述已被 D1 作废的旧规则（「只在登录界面出现」「必须收敛在一处：未登录时的登录界面」），与同一文件已被改写的测试体、与 `02-decisions.md` D1 的裁定直接冲突 | 已改口为「谁可以读这份名单」+ 显式宿主清单 + 「面板只能经服务端门禁进入」。这是 D1「一律改口」义务的**第 5 处**，此前漏了 |
| m1 | MINOR | 面板的底部偏移只减 `--tabbar-height`，**没算底部安全区**；而 TabBar 外套着 `SafeAreaContainer`。带 Home Indicator 的真机上按钮会压住 TabBar 顶部约 22px，结算页还会盖住「去支付」——桌面模拟器 `env()` 恒为 0，所以验收看不出来 | 偏移改为 `calc(var(--tabbar-height)+0.75rem+env(safe-area-inset-bottom))`，与仓库其它贴底元素同一算法 |
| m2 | MINOR | 「全仓只有三套会话 Cookie」那条只认「导出常量 + 双引号字面量」一种写法，`cookies().set("companion_session", …)` / 模板串 / 不导出的常量都能绕过 | 在同一条用例里补上**调用点清单**：`app`/`components`/`lib` 里出现 `cookies()` 的文件必须恰好是 `lib/auth/{session,adminSession,staffSession}.ts`。新增一套会话必然要调 `cookies()`，因此这条堵住了原写法的全部绕法 |
| m3 | MINOR | 退出进行中账号行仍是可点外观，点下去被 `busy` 静默丢弃 | 退出中给列表容器加禁用态视觉（`pointer-events-none opacity-60` + `aria-busy`）。**没有**给 `MockUserPicker` 加参数——D3 已冻结「原样复用，不扩参数」 |

未处理的 NOTE（不阻塞验收，记此备查）：

- **N1** `devIdentity.test.mjs` 第 9 条（名单账号都不是打手）与第 10 条（现造一位绑定 `userId` 的护航）
  之间有隐式顺序耦合。两条的注释都已写明顺序是刻意的，Node 在同一文件内按声明顺序串行执行，当前稳定。
- **N2** 三条 HTTP 用例在默认门禁里是 `skip`（全仓 119 条 skip 中的 3 条），
  与仓库既有约定一致；它们只在 `APP_BASE_URL` 全量跑里执行。
- **N3** D1 用的是「V1 CURRENT（旧说法 SUPERSEDED）+ 替换前后对照表」，
  不是 `Decision V1 / V2` 的两段式。旧句原文与出处都在，历史可追溯。
- **N4** 面板与结算页既有的 toast 同为 `z-40`，被面板晚渲染覆盖（该 toast 是一闪而过的反馈）。
  m1 的偏移修好后两者已错开。

> ⚠️ **N1 / N2 在重做批里都已失效或被取代**：第 9 条被整节重写成 6 条验收身份用例（§9.1），
> 顺序耦合不再存在；HTTP 用例从 3 条变成 4 条。上面两条保留为**第一次交付时的事实记录**。

### 2.5 重做批：用户打回后的修复（第二次交付的核心）

#### 打回理由（用户原话摘要）

> 「§5 明确核查：当前可切换用户中没有任何有效 Companion，`u-1001...u-1010` 全部 `not-a-companion`」，
> 而 §12 人工验收却要求「`u-1001` 下单 → `u-1002` 接单/取消 → `u-1003` 再接单」。
> 「因此当前 DEV-1 虽然能『切 User』，但还不能完成它最重要的用途：在一个浏览器里验收
> P0-6 的 User → Companion A → Companion B 链路。这也违反了 DEV-1 原始要求：至少一个普通
> User；至少两个具备有效 Companion 资格的 User。」

修复目标（用户逐字给出）：**启动后无需先人工走入驻审核流程，就直接存在 1 个普通下单 User
与 2 个 `resolveCompanionAccess()` 能真实识别为有效 Companion 的 User**，
Mock 身份工具能直接切到这三个身份。

#### 做了什么

| # | 改动 | 落点 |
|---|---|---|
| 1 | 新增两位用户 | `userSeed` `+u-1022`（夜航）/ `+u-1023`（栖迟） |
| 2 | 新增两条**由审核产生**的护航资料 | `companionSeed` `+cp-10`（`userId: u-1022`，`applicationId: ca-1008`）/ `+cp-11`（`u-1023` / `ca-1009`），`removedAt: null`、`enabled: true`、`available: true` |
| 3 | 新增两条 `approved` 入驻申请 | `companionApplicationSeed` `+ca-1008` / `+ca-1009`，让「由审核产生」有据可查 |
| 4 | 名单 6 → 8，新增 `approved` 状态与显示名 | `MOCK_LOGIN_USERS` / `MOCK_LOGIN_APPLICATION_STATE_LABELS` / `MOCK_LOGIN_PICKER_NOTICE` |
| 5 | **服务端派生**的资格标签 | `MOCK_LOGIN_ACCESS_LABELS`（`granted` → 「有效打手」等）+ `MockIdentitySwitcher` 逐个现算 + `MockUserPicker` 一个只用于显示的芯片 |
| 6 | 测试重写 | `tests/devIdentity.test.mjs` 第三节整节重写 + 新增 1 条 HTTP；`tests/mockUsers.test.mjs` 规则更新 |
| 7 | 一处既有断言**改为与数据无关** | `tests/companions.test.mjs` 的分页用例原写死「三页」，见下 |
| 8 | 「当前身份」的行内视觉区分 | `MockUserPicker` 多一个**显示用**的 `currentUserId` 入参（蓝边框 + 「当前身份」文案，那一行**照样可点**）。补的是 `01-prompt.md` §六「当前身份应有视觉区分」，之前只有面板头部那一行文字 |
| 9 | 审查后修复 | 见 §13.2：1 个 BLOCKER（根 `README.md` 仍教人先去做后台审核）+ 1 个 MAJOR（「首屏 HTML 不含 `u-1xxx`」在开关打开时为假）+ 4 个 MINOR |

#### 为什么是「新增」而不是「改造现成的」

用户明确要求「如果把现有 `u-1002 / u-1003` 直接改成有效 Companion 会破坏当前
『待查看 / 审核中』的申请 fixture 或既有测试，不要为了省事破坏这些场景」。
逐条核对后，**三个候选全都不该动**：

| 候选 | 身份 | 为什么不动 |
|---|---|---|
| `u-1002` | `ca-1002` 待查看 | 「待查看」状态页 + 「后台可直接通过」路径的唯一样本 |
| `u-1003` | `ca-1003` 审核中 | 「审核中」状态页 + 同上 |
| `u-1004` | `ca-1004` 已通过 | 「申请已通过、护航资料另行产生」这个**中间态**的唯一样本；补一条护航等于把它删掉 |

且三者的状态都被 `tests/companionApplications.test.mjs` / `tests/mockUsers.test.mjs` 钉着。
新建 `u-1022` / `u-1023` 不触碰任何既有断言——实测：`pnpm test` 从 `1108 / 989 / 0 / 119`
变成 `1116 / 996 / 0 / 120`，**唯一需要改的既有断言是下面这一条**。

#### 唯一被改动的既有断言：`tests/companions.test.mjs` 的分页用例

它把「三页正好翻完」写死：

```js
for (const pageNumber of [1, 2, 3]) { … assert.equal(one.hasMore, pageNumber < 3); }
```

在架陪玩从 8 位变成 10 位后，第三页不再是最后一页，用例变红。**它红的原因与
「分页对不对」毫无关系**，只是在说「列表恰好是 8 条」。因此改成由**数据**决定页数：
翻到 `hasMore` 为假为止，并逐步断言 `hasMore` 与实际剩余条数一致。
这比原写法**更强**（顺带钉住了「翻页入口不会凭空停住或多出一页空白」），
而且以后再往种子里加陪玩也不会误报。

#### 明确没做的事（用户禁止清单，逐条对照）

| 禁止项 | 实际 |
|---|---|
| 在前端伪造 Companion 标签 | 未做。标签由服务端 `resolveCompanionAccess` 现算，组件只渲染字符串 |
| 绕过 `requireCompanion()` | 未做。`lib/api/companionRoute.ts` **一个字节没改** |
| 为 DEV-1 添加特殊 Companion Guard | 未做。打手接口仍只有 `requireCompanion()` 一个守卫 |
| 新增第二套 Session / Cookie | 未做。`cookies()` 调用点仍然恰好 3 个（测试钉住） |
| 修改生产身份模型 | 未做。新增的只是 Mock fixture；`lib/types/*` 无改动 |
| 开发正式账号系统 | 未做。没有新接口，`app/api/**/auth/**` 仍然恰好 8 个 |

#### 真机链路实测（不是推断）

起生产服务后按人工验收的步骤实跑了一遍，**全程没有任何后台审核动作**：

```
[1] u-1001 / u-1022 / u-1023 三个会话都可用；A / B 打订单池都是 200 且 canAccept=true
[2] A 打开打手「我的订单」是 200（requireCompanion 放行）
[3] U 下单：/api/orders/preview → /api/orders/pay → /api/payments/mock-confirm → orderId
[4] 公共池里有这一单 → A 接单 kind=ok → A 的「我的订单」出现该单 → U 看到 status=accepted
[5] A 主动取消：kind=ok，status 回到 paid（订单回到公共池）
[6] B 在公共池重新看到同一张单 → B 接单 kind=ok
[7] 切回 U：status=accepted；通知里有「订单已被接单」「护航已取消接单」「订单已被接单」
```

#### 关闭态复验（重做批新增内容不得进入关闭态响应）

`ENABLE_MOCK_AUTH=false` 的形态由两条源码位置断言守住：

1. 早返回 `if (!isMockAuthEnabled()) return null;` 必须在 `await getSessionUser()` **之前**（原有）；
2. 截取早返回**之后**的源码，其中必须出现 `resolveCompanionAccess(` 与 `MOCK_LOGIN_ACCESS_LABELS`
   （重做批新增）——把资格派生挪到早返回之前，开关关闭时标签照样会被算出来。

加上「标签只能经 `MockIdentitySwitcher` → `MockIdentityPanel` → `MockUserPicker`
这条链进 UI」的宿主清单，关闭态下新的身份信息同样不进响应。

#### 2.6 重做批的连带更正（**越界声明**）

DEV-1 开头承诺「不修改 P0-6 的任何内容」。重做批动了共享 fixture（`lib/mocks/fixtures/seed.ts`
新增 `cp-10` / `cp-11`），这让 **`P0-6/04-acceptance.md` 里一句事实描述不再成立**：

> 原文（第 70 行）：「预置护航的 `userId` 全是 `null`，没有任何预置用户能进打手工作台。」

这是一句**现在为假**的话，而人工验收 P0-6 时正好会读到它。权衡后**改了**，改法限定为：

| 改了什么 | 没改什么 |
|---|---|
| 那一句事实描述，改成「预置数据里现在有 `u-1022` / `u-1023` 两位可用的打手」 | **验收步骤本身**（第 13 步的命令逐字保留） |
| 加了一句脚注，说明这句是 DEV-1 更新的、以及原句为什么不再成立 | **`User Result` / `Issues Found` / `Rework` / `Final Result` 四个结论区**（一个字节没动） |
| 第 13 步后补一句「或用 DEV-1 的预置打手 `u-1022`，跳过两步」 | P0-6 的 `02-decisions.md` / `03-delivery.md` / `README.md` |

理由与 `README.md` 那个 BLOCKER 同源：**留着「照着这句话就做不成」的文档，等于把验收人引向错路**，
而这正是 DEV-1 首轮被打回的病根。故此处选择**改事实描述、不动结论**，并把越界写在交付文档里。

其余同类陈旧注释一并随本轮更新（都是「文档声称的与代码事实不符」这一个病根）：
`lib/types/companion.ts`、`lib/services/companionDispatch.ts`、`lib/data/companionDispatchTransaction.ts`、
`lib/data/mockQualificationRepository.ts`、`README.md`（用户端 Mock 认证一节）、
`tests/{companionAccess,companionOrders,staff,staffComplaints,staffRefunds}.test.mjs` 的注释，
以及 `docs/02-tech-design/directory-structure.md` 的测试文件数与 `lib/auth/` 一节。

⚠️ **其中三处测试注释的结论也一并说清了**：`staff*.test.mjs` 里「非空的退出历史在 HTTP 层造不出来」
这个**理由**已经失效（预置打手让接口层可以造出退出历史），断言为空数组的**原因**改为
「这几张预置订单从未被取消过，且 HTTP 用例不写共享内存」——结论不变，理由改成真的。

---

## 3. 新增组件

### 3.1 `MockIdentitySwitcher`（服务端门禁）

```tsx
export default async function MockIdentitySwitcher() {
  if (!isMockAuthEnabled()) return null;   // ← 先：开关关闭时不渲染
  const user = await getSessionUser();     // ← 后：关闭时这一行根本不会执行

  // 重做批：逐个现算资格标签（D6 V2）。同样在早返回之后。
  const accessLabels: Record<string, string> = {};
  for (const option of MOCK_LOGIN_USERS) {
    const access = await resolveCompanionAccess(option.userId);
    const label = MOCK_LOGIN_ACCESS_LABELS[access.kind];
    if (label) accessLabels[option.userId] = label;
  }

  return (
    <MockIdentityPanel
      current={user ? { userId: user.id, nickname: user.nickname } : null}
      accessLabels={accessLabels}
    />
  );
}
```

三件事由这一段承担（`02-decisions.md` D4 / D6 V2 / D8）：

1. 开关关闭时**连 `cookies()` 都不会被调用**，因此正式形态的用户端页面**仍然静态预渲染**（实测见 §7）；
2. 「开关是唯一判据」在源码里可见——`tests/devIdentity.test.mjs` 按**位置**钉住（早返回的下标 < 读会话的下标），而不只是断言那句字符串存在；
3. **资格派生也在早返回之后**（重做批新增）——同一条位置断言，判据是「截取早返回之后的源码，其中必须出现 `resolveCompanionAccess(` 与 `MOCK_LOGIN_ACCESS_LABELS`」。

`resolveCompanionAccess` 由 `React.cache` 包着，且每次调用只是一次 Map 查找；
开关打开时每个用户端页面多出 8 次这样的查询，开关关闭时一次都不执行。

### 3.2 `MockIdentityPanel`（客户端面板）

- **折叠态**：右下角一个自绘的 `Mock 身份（开发工具）` 按钮，带 `aria-expanded`，显示当前昵称；
- **展开态**：一张卡片，含标题、`当前身份：昵称（userId）`、`MOCK_IDENTITY_NOTICE`、由 `MockUserPicker` 渲染的账号列表、错误文案、退出登录按钮；
- **切换**：点账号 → `authAdapter.login(userId)` → `router.refresh()`；
- **退出**：`authAdapter.logout()` → `router.refresh()`；
- **重做批**：把服务端给的 `accessLabels` 与当前身份的 `userId` **原样转发**给 `MockUserPicker`。面板自己既不判断谁是打手，也不拿标签或「当前」做禁用或跳转；
- 位置：`fixed inset-x-0 bottom-0 z-40`，内层限宽 `var(--shell-width)` 并让出 `var(--tabbar-height)`，因此**不遮挡底部五 Tab**；
- 外层的 `pointer-events-none` + 卡片自身的 `pointer-events-auto`，保证折叠态那一小块不挡住底下的页面点击。

`MockUserPicker` 的重做批改动是两个**可选**入参：

| 入参 | 渲染 | 是否影响行为 |
|---|---|---|
| `accessLabels?: Record<string, string>` | 资格芯片（`border-brand-blue-border bg-brand-blue-soft text-brand-blue`，色值取自 `app/globals.css` 的 `@theme`） | **否** |
| `currentUserId?: string \| null` | 当前行蓝边框 + 「当前身份」文案，带 `aria-current` | **否**——那一行照样可点（点它就是以同一身份重新登录），不置灰 |

它的 `onPick` 契约与禁用条件（只看 `busyId`）一个字节没变——
**扩的是「显示什么」，不是「点了会怎样」**（D3 V2）。这条规则现在由测试守着：
参数集合被断言为**封闭集合** `["accessLabels","busyId","currentUserId","onPick"]`，
且每处 `disabled={…}` 表达式中必须含 `busy`——加第四个参数或让标签影响点击，都会先红。

`tests/devIdentity.test.mjs` 对面板的源码级约束：不得出现 `fetch(` / `document.cookie` / `mock_user_id` / `apiPost` / `XMLHttpRequest`；必须出现 `authAdapter.login(` / `authAdapter.logout(` / `router.refresh()`；不得出现任何 `u-1xxx` 字面量（名单只有 `lib/constants/mockUsers.ts` 一份）。

---

## 4. 新增 / 修改的 API 与数据

**接口与数据模型零变化；fixture 有新增（重做批）。**

| 项 | DEV-1 的变化 |
|---|---|
| 新增 API Route | **0 个**。`tests/devIdentity.test.mjs` 枚举 `app/api/**` 里路径含 `auth` 的 `route.ts` 并与既有 8 个做 `deepEqual` |
| 修改 API 行为 | **0 处**。`/api/auth/mock-login` 与 `/api/auth/logout` 一个字节没动；`lib/api/companionRoute.ts` 同样一个字节没动 |
| 新增 Cookie / 会话模型 | **0 个**。测试扫描 `lib/` 里的 `*_COOKIE*` 常量并 `deepEqual` 为 `["mock_admin_id","mock_staff_id","mock_user_id"]`；另有 `cookies()` 调用点清单（恰好三处） |
| 新增 / 修改数据结构（`lib/types`） | **0 个** |
| 新增 Repository | **0 个** |
| 修改 Repository 逻辑 | **0 处**（`mockCompanionRepository.ts` 只有注释改动） |
| 新增用户名单 | **0 份**。面板不含任何 id 字面量，列表由 `MockUserPicker` 独占渲染 |
| **新增 Mock fixture 记录（重做批）** | `+2` 用户（`u-1022` / `u-1023`）、`+2` 护航资料（`cp-10` / `cp-11`）、`+2` 入驻申请（`ca-1008` / `ca-1009`）、名单 `6 → 8` |

新增的 fixture 全部落在既有 fixture 体系内（`userSeed` / `companionSeed` /
`companionApplicationSeed`），**没有创建第二套「测试角色」模型**：
`u-1022` / `u-1023` 就是普通用户，他们的打手身份来自
`Companion.userId` ——与「后台审核通过」产生的记录是同一张表、同一套字段。

---

## 5. 复用情况（§十二 的优先顺序逐条核对）

| §十二 的优先项 | 实际做法 | 是否新建了第二套 |
|---|---|---|
| 1 复用现有 `MockUserPicker` | **原样复用**：它的 `onPick` / `busyId` 契约未变，本就不认识登录态。重做批只多了一个**只用于显示**的可选入参 `accessLabels`（D3 V2） | 否 |
| 2 扩展现有 Mock Auth HTTP service | 面板直接调 `authAdapter.login/logout`（`LoginGate` 已在用同一写法），**没有新写任何 HTTP 客户端** | 否 |
| 3 复用现有 User fixtures | 名单仍是 `MOCK_LOGIN_USERS` 一份（重做批 6 → 8）；新用户加在既有 `userSeed` 上，打手身份走既有 `Companion` 真值源，**没有 qualification seed、没有第二套资格模型** | 否 |
| 4 接入一个合适的现有 layout | 挂 `app/(mobile)/layout.tsx`（用户端路由组），一端一处 | 否 |
| 5 Companion 资格必须真的通过 `resolveCompanionAccess()` | **是**：`u-1022` / `u-1023` 判定 `granted`，`requireCompanion()` 放行（数据层 + 真服务两层各一条用例，§2.5 有实跑记录） | 否 |

分层方向：面板是 `lib/auth` → `lib/auth`（同层）+ `lib/auth` → `components`（既有允许方向，`LoginGate` 早已如此），**没有**跨层、没有从组件里碰 `lib/data`。
重做批新增的一处 `lib/auth` → `lib/services`（`MockIdentitySwitcher` 引 `resolveCompanionAccess`）
是**既有允许方向**：`lib/services` 是服务端模块，`lib/auth` 是服务端会话层，且这条调用只在
`ENABLE_MOCK_AUTH` 打开时执行。

---

## 6. 关闭态实测（§七 的「完全不可使用」，实跑，非源码推断）

`ENABLE_MOCK_AUTH=false` 起生产服务后实测：

| 检查 | 结果 |
|---|---|
| `/`（首页）HTML 里 `Mock 身份` 出现次数 | **0** |
| `/` HTML 里面板标题 / 账号列表出现次数 | **0**（页面仍是 47 KB，说明不是被截断） |
| `POST /api/auth/mock-login` | **404**（接口层既有保护未被削弱） |
| `POST /api/auth/logout` | **404** |
| `/` HTML 里新增的资格标签文案「有效打手」出现次数（重做批） | **0** |
| 手工伪造 `mock_user_id=u-1002` Cookie 访问 `/mine` | 渲染「需要登录」；响应与**不带 Cookie** 时**逐字节相同**（14263 B）——会话没有任何旁路被打开 |

`ENABLE_MOCK_AUTH=true` 时（对照）：触发器渲染出 `aria-expanded="false"`；游客态显示「游客（未登录）」，登录后显示昵称（`u-1003` → 星野（占位）），`/` 与 `/help` 两处一致。

⚠️ **一处曾经写过头、已按实测改正的断言（重做批）**：首轮与本文件此前都写着「首屏 HTML 里不出现任何 `u-1xxx` id——名单在折叠分支里，不展开就不下发」。**这在开关打开时不成立**：
重做批新增的 `accessLabels` 是以 `userId` 为键的对象，作为 prop 传给客户端组件 `MockIdentityPanel`，
Server → Client 的 prop 会被序列化进 HTML 内联的 RSC flight payload，因此**开关打开时 8 个 id 全部出现在首屏 HTML 里**。
实测（`ENABLE_MOCK_AUTH=true` 起生产服务，`curl /`）：`u-1001`…`u-1023` 各出现 **1 次**，
形态是 `accessLabels":{"u-1001":"普通用户","u-1022":"有效打手",…}`。

准确的表述是：

| 形态 | 首屏 HTML 里的 `u-1xxx` | 说明 |
|---|---|---|
| `ENABLE_MOCK_AUTH=false`（**正式形态**） | **0 处**（`/`、`/mine`、`/help` 三页实测，且「有效打手」也是 0 处） | 早返回在 `getSessionUser()` 与标签计算之前，名单与标签都不进响应 |
| `ENABLE_MOCK_AUTH=true`（开发形态） | **8 处**，全部来自 `accessLabels` 的键 | 这一形态下工具本身就渲染在页面上，id 不是秘密 |

> 结论：**开关关闭时，UI 是「不存在」而不是「存在但禁用」，且名单与标签都不进响应**——这是本轮真正的安全约束，实测成立。
> 开关打开时 id 会进响应，是开发形态的既成事实，不再声称相反的话。

---

## 7. 动态 / 静态构建对比（D8 的代价实测）

| 构建时的 `ENABLE_MOCK_AUTH` | 用户端页面（`/help`、`/activities`） | 说明 |
|---|---|---|
| `true`（本地 `.env.local`） | `ƒ (Dynamic)` | 门禁读到开关为真 → 读会话 → 按请求渲染 |
| `false`（正式部署形态） | `○ (Static)` | 门禁**先返回 null**，`cookies()` 未被调用 → 静态化不受影响 |

两种都实跑过。**接受**这个代价（理由见 D8）：受影响的是开发形态，正式形态逐字不变；且本项目当前跑在 `globalThis` Mock 存储上，用户端页面本来就不缓存数据，按请求渲染不改变任何可见行为。

**明确不接受**的替代做法：把面板做成「始终渲染、由 CSS 隐藏」——那正是 §七 点名不要的形态。

---

## 8. 规则替换的执行证据（§十三「唯一的例外」三条）

| 要求 | 落点 |
|---|---|
| ① 写进 `02-decisions.md` | `02-decisions.md` D1（含背景、判定、替换前后对照表、未削弱的既有边界） |
| ② 同步长期文档 | `api-contract.md:23`、`README.md`、`directory-structure.md`、`docs/03-dev/rounds/README.md`、`docs/03-dev/总需求进度表.md`；代码注释 5 处（`mock-login/route.ts`、`MockUserPicker.tsx`、`mockUsers.ts`、`user.ts`，以及 **`tests/mockUsers.test.mjs` 的模块级说明**——最后一处是 reviewer 指出后补上的，见 §2.4 M1） |
| ③ 保留旧规则被 `SUPERSEDED` 的历史 | D1 里保留原句原文与「替换前后」对照；被替换的**测试断言不是删掉**，而是重写成更强的形式（见下） |

### 8.1 被替换的那条测试断言

`tests/mockUsers.test.mjs` 原先断言「选择器只允许被 `LoginGate` 引用」。这条**没有删除**，改写为显式的宿主清单：

```js
// 宿主清单：新增一处就必须在这里写清楚，并确认它同样受开关控制
["lib/auth/LoginGate.tsx", "lib/auth/MockIdentityPanel.tsx", "lib/auth/MockUserPicker.tsx"]
```

并新增一条更严的断言，把「面板只应被服务端门禁引用」也钉住：

```js
// DEV-1 面板只应被服务端门禁引用：直接挂到页面上的话，开关就只挡 UI 不挡数据了
["lib/auth/MockIdentityPanel.tsx", "lib/auth/MockIdentitySwitcher.tsx"]
```

即：**旧约束的原因（防止 Mock 名单漏进不该出现的地方）被保留并加强**，只是宿主从 1 个变成 2 个、且第 2 个必须是服务端门禁。

---

## 9. 测试新增数量

| 文件 | 条数 | 说明 |
|---|---|---|
| `tests/devIdentity.test.mjs`（重写批） | **20** | 16 条离线 + 4 条 HTTP（无 `APP_BASE_URL` 时 `skip`） |
| `tests/mockUsers.test.mjs`（改写） | **+3** | ①「标着 approved 的账号必须真的是有效打手」；②「资格标签的键必须与真实的判定取值一一对应」（键是手写字面量，拼错只会让标签**静默消失**）；③「选择器的参数只允许是显示用的」（D3 V2 的最终执行规则，参数集合封闭）。覆盖用例另拆成三段 |
| `tests/companions.test.mjs`（改写） | ±0 | 分页断言由写死的三页改为按数据翻到底（见 §2.5） |

`tests/devIdentity.test.mjs` 的 20 条对应 `01-prompt.md` §十三 的清单，
**加粗的 7 条**是重做批新增 / 反转的：

| # | 主题 | 对应 |
|---|---|---|
| 1 | `ENABLE_MOCK_AUTH` 恰为字符串 `"true"` 才为真（`"1"`/`"TRUE"`/`"yes"`/`""`/`undefined` 一律为假） | §十三.1 |
| 2 | 门禁**先判开关再读会话**（按位置断言，不是按字符串存在） | §十三.2 |
| 3 | 开关关闭时面板不进入渲染树（宿主清单 + `<MockIdentitySwitcher` 在用户端布局 + `MobileShell` 里没有它） | §十三.2 |
| 4 | 切换复用既有登录链路（禁 `fetch(` / `document.cookie` / `mock_user_id`；要求 `authAdapter.login/logout` + `router.refresh()`） | §十三.3 |
| 5 | 切换与退出都打到既有接口（stub `fetch`，断言 2 次调用的 URL / method / body / `credentials`） | §十三.3 |
| 6 | 面板不自带用户名单（无 `u-1xxx` 字面量；必须有 `<MockUserPicker`） | §十三.4 |
| 7 | 没有新增任何认证接口（枚举 `app/api/**` 与 8 个既有 auth 路由 `deepEqual`） | §十三.9 |
| 8 | 没有新会话模型（扫描 `lib/` 的 Cookie 名常量，`deepEqual` 为既有三个） | §十三.9 |
| **9** | **打手 A / B 是预置的有效打手**：`resolveCompanionAccess` 判定 `granted`，且 `userId` / `removedAt===null` / `enabled===true` / `available===true` 四个条件一个不缺，`applicationId` 指向本人名下的 `approved` 申请 | **§八.2 / 3** |
| **10** | **普通 User 不是打手**：名单第一位（默认登录身份）必须是 `not-a-companion` | **§八.1** |
| **11** | **名单不声明资格**：名单里判为 `granted` 的集合，与标着 `approved` 的集合 `deepEqual`——文案与代码事实不许脱节 | **§八.7** |
| **12** | **A / B 真的能进工作台并参与接单链**：`listCompanionPools(record.id).canAccept === true` 且 `notice === COMPANION_POOL_NOTICE`，不是「进得去但没有单」 | **§八.4 / 5 / 6** |
| **13** | **既有入驻申请场景一个都没被破坏**：`ca-1002`…`ca-1007` 六种状态（提交/审核中/通过/驳回/撤回）逐一核对，且 `u-1004`（有 approved 申请、无护航资料）仍是 `not-a-companion` | **§八.8** |
| **13b** | **资格标签表的键必须与判定取值一一对应**（reviewer MINOR 的修复）：三档键齐全、文案互不相同、`granted` / `not-a-companion` 的文案被单独钉住、不得有多余档位——键是手写字面量，拼错只会让标签**静默消失**而测试全绿 | **§八.7** |
| 14 | 资格只吃会话里的 `userId`（现造一位绑定 `userId` 的护航 → `granted`；同进程另一个普通 id 仍 `not-a-companion`） | §十三.7 / 8 |
| 15 | 打手接口守卫只从用户会话取身份（`companionRoute.ts` 必须只有 `requireUser()` + `resolveCompanionAccess()`，不得出现 `cookies()` 或任何 Cookie 名字面量） | §十三.7 / 8 |
| 16 | HTTP：切换**替换**同一个 Cookie，且 `/api/me` 跟着变（断言恰好一个 `Set-Cookie: mock_user_id`） | §十三.5 |
| 17 | HTTP：退出由**服务端**下发清空 Cookie（`Max-Age=0` / 过期时间），而不是客户端自己删 | §十三.6 |
| 18 | HTTP：普通用户打 `/api/companion/orders` 与 `/api/companion/dispatches` → 403，匿名 → 401 | §十三.8 |
| **19** | **HTTP：A / B 的会话真的能过 `requireCompanion()`**——以真实 Cookie 打两个打手接口得到 **200 而不是 403**，且 `canAccept === true` | **§八.4 / 5 / 6** |

### 9.1 原第 9 条为什么被**反转**了（值得单独记一笔）

首轮交付里，第 9 条是一条**否定**断言：

> 「名单里的账号在预置数据里全都不是打手」（对每个 `MOCK_LOGIN_USERS` 断言 `not-a-companion`）

它当时被写成「这条事实不是我选的，是核出来的」：`companionSeed` 每条记录 `userId` 都是 `null`，
实跑 `findCompanionByUser` 对 `u-1001`…`u-1010` 逐个核对**十个全是 `not-a-companion`**。
于是首轮把 §八 读成「名单里要有候选身份」，用**申请状态**去贴「至少两个」的字面要求。

**人工验收驳回了这个读法**（原话见 `02-decisions.md` D6 V1 的「V1 错在哪」）：

> 「当前 DEV-1 虽然能『切 User』，但还不能完成它最重要的用途：在一个浏览器里验收 P0-6 的
> User → Companion A → Companion B 链路。」——并且明确给出了修复目标：
> 启动后**无需先人工走入驻审核流程**，就直接存在 1 个普通 User 与 2 个
> `resolveCompanionAccess()` 能真实识别为有效 Companion 的 User。

所以这条断言不是被删掉，是**被用户裁定为反了**：DEV-1 要的不是「如实记录没有打手」，
而是「把打手造出来」。重做批走的是 D6 V2 的路子——在既有 fixture 体系里新增
`u-1022` / `u-1023` 两位真实拥有护航资料的用户，**没有**把 `u-1002` / `u-1003` 改掉
（那会毁掉「审核中 / 待查看」这两个样本）。

新第 9 / 10 / 11 / 12 / 13 / 13b / 19 条把**新的事实**钉住，而且比原来强：
原第 9 条只断言「没有」，新的第 11 条断言「标着 approved 的**恰好**是判为 granted 的那两个」——
集合相等。名单文案与代码事实一旦脱节，任何一侧多一个少一个都会立刻变红，
这正是首轮被打回的那个病根（§八.7）。

---

## 10. 门禁结果（全部实跑，重做批之后）

| 门禁 | 结果 |
|---|---|
| `pnpm test` | `tests 1116` / `pass 996` / **`fail 0`** / `skipped 120` |
| 生产服务 + `APP_BASE_URL=http://localhost:3214 pnpm test` | `tests 1116` / **`pass 1116`** / `fail 0` / **`skipped 0`** |
| `pnpm typecheck`（含 `next typegen`） | 退出码 **0** |
| `pnpm lint` | 退出码 **0** |
| `pnpm build` | 退出码 **0** |

变化量核对（**基线是 DEV-1 开始时的 `1094 / 978 / 0 / 116`**，不是首轮交付后的 `1108`）：

| 来源 | 条数 | pass | skip |
|---|---|---|---|
| `tests/devIdentity.test.mjs`（新文件） | +19 | +15 | +4 |
| `tests/mockUsers.test.mjs`（新增 3 条：qualification / 标签表键 / 选择器参数集合） | +3 | +3 | 0 |
| `tests/companions.test.mjs`（**改写**，条数不变） | ±0 | ±0 | 0 |
| **合计** | **+22** | **+18** | **+4** |

`1094 + 22 = 1116`、`978 + 18 = 996`、`116 + 4 = 120`，三项都对得上。
⚠️ 交付文档里出现过两组数字，都是对的，混淆点在于基线不同：`1108 / 989 / 0 / 119` 是
**首轮交付后**的中间态（§2.5 用它算重做批的变化量），`1094 / 978 / 0 / 116` 是**本轮开始前**的基线
（本节用它算整轮的变化量）。`tests/devIdentity.test.mjs` 从未进过 git，因此无法用 git 回溯，
只能靠这里写明。**`fail` 始终为 0。**

端口卫生：321x 段起服务前确认空闲，HTTP 全量跑完后 `taskkill //PID <pid> //T //F` 收两个进程
（含 `next start` 拉起的子进程），再 `netstat` 复核为 `ALL_321x_FREE`——避免下一轮测到旧进程。

---

## 11. 明确的实现取舍（备查）

| 取舍 | 理由 | 记录 |
|---|---|---|
| 面板挂在用户端**路由组**，不挂 `MobileShell` | `MobileShell` 还被 `app/companion/(console)/layout.tsx` 复用，挂上去等于漏进打手工作台 | D2 |
| 不挂 `(tabs)/layout.tsx` | 只覆盖五个一级 Tab；验收要切换的恰恰是订单详情等二级页 | D2 |
| **给**面板加「谁是打手」的资格标签，但只由服务端现算、只作显示 | ~~「只省一次跳转」~~ —— 首轮用这个理由拒绝过，被人工验收驳回：验收要的恰恰是**一眼认出** A / B 是谁。标签由 `resolveCompanionAccess` 现算，**不作为权限依据**；代价是开关打开时每页 N 次 Map 查找（N=8），开关关闭时不执行 | D6 V2 |
| 面板直接调 `authAdapter`，不用 `useAuth()` | `AuthProvider` 只长在 `RequireAuth` 里，首页等免登录页没有 Provider；且这本就是 `LoginGate` 的写法 | D5 |
| 用户端页面因此按请求渲染 | 换静态化就要把 `cookies()` 挪到开关判定之前——那是回归 | D8 |
| ~~第 7 条不写成 HTTP 用例~~ **重做批已补上 HTTP 用例** | 「造打手必须写 admin approve、而矩阵一个字节都不写」这个两难，**在重做批消失了**：A / B 是预置数据，登录即用，无需任何后台写操作。于是新增第 19 条——以真实 Cookie 打两个打手接口断言 **200 而非 403**，把「真的过得了 `requireCompanion()`」钉进 HTTP 层 | D7 补充 |

---

## 12. 未实现内容（明确列表）

按 `01-prompt.md` §十五 的禁止清单，**本轮一条都没做**：

- 微信 OAuth / 手机号登录 / 用户名密码 / 注册 / 账号绑定 / Token Refresh；
- 多设备登录、多 Session 并行、Companion 独立 Session 或独立登录；
- **Admin / Staff 身份切换器**；打手工作台内的切换入口（D2 的代价，写进验收清单）；
- P0-6 的任何新业务功能；`accepted → serving`；`CompletionSubmission`；任何后续 P0；
- 与 Mock 身份切换无关的大规模 UI；auth 重构；第二套认证系统。

另有一处**顺手修正**（重做批）：`docs/02-tech-design/directory-structure.md` 里
「`51 个测试文件`」这句早已过时——DEV-1 之前实际就是 56 个（P0-6 与本轮各新增过测试文件），
现在是 **57 个**。这属于「文档写的与代码事实不符」，正是首轮被打回的那类病根，
因此本轮既然已在改动该文件，就一并改成 57，而不是留一个已知错误的数字在仓库里。

---

## 13. Reviewer 结论

独立 reviewer-agent（只读，未修改任何文件）对本轮改动集做了**两轮**审查。

### 13.1 第一轮（首轮交付，已归档）

> **结论：可以交付人工验收。** DEV-1 是一件范围极小、越界风险已被结构断言钉住的基础设施改动，
> 逐条核查后没有 BLOCKER……

`BLOCKER 0 / MAJOR 1 / MINOR 3 / NOTE 4`；M1 与 m1 / m2 / m3 均在首轮交付前修复（见 §2.4）。
⚠️ **这一轮的结论后来被人工验收推翻**——reviewer 与 Coordinator 当时都只核对了「工具是否越界」，
**没有核对「工具能不能完成它存在的理由」**。这正是首轮被打回的原因，记此备查。

### 13.2 第二轮（重做批，本次交付）

`BLOCKER 1 / MAJOR 1 / MINOR 4 / NOTE 2`。逐条处置如下：

| 级别 | 事项 | 处置 |
|---|---|---|
| **BLOCKER** | 仓库根 `README.md` 的「用户端 Mock 认证」一节仍写着「名单里**没有任何一位天生就是打手**，要验收打手链路请先用管理端通过一条申请」 | **已修**。这与 `04-acceptance.md` §H「全程不需要进管理端……若你发现自己想去后台点『通过』，说明哪里不对」直接冲突，**也正是首轮被打回的病根**（文档声称的与代码事实不符，并把验收人引向被打回的那条路）。改成如实说明预置的 `u-1022` / `u-1023` 两位打手，以及另外几位各自该走哪条路 |
| **MAJOR** | 本文件 §6 与 `04-acceptance.md` 声称「首屏 HTML 里不出现任何 `u-1xxx` id」；但重做批新增的 `accessLabels` 以 userId 为键，作为 prop 序列化进 RSC payload，**开关打开时该断言为假** | **已修，且 Coordinator 实测确认**（reviewer 只做了机制推导，未起服务）。实测：开关打开时 `/` 首屏 HTML 里 8 个 id 各出现 1 次；开关关闭时 `/`、`/mine`、`/help` 三页均为 **0 处**。文档改为一张两行对照表，明确写清**关闭态**才是安全约束、打开态 id 进响应是开发形态的既成事实 |
| MINOR | 多处陈旧注释（`lib/types/companion.ts`、`lib/services/companionDispatch.ts`、`lib/data/companionDispatchTransaction.ts`、`lib/data/mockQualificationRepository.ts` + 5 个测试文件）仍说「预置护航的 `userId` 全是 `null`」 | **已修**（见 §2.6）。其中三个 staff 测试的**理由**已失效，一并改成真的理由（结论不变） |
| MINOR | `MOCK_LOGIN_ACCESS_LABELS` 的键是手写字面量、无编译期约束，拼错会让标签**静默消失** | **已修**，新增测试：三档键必须齐、文案必须互不相同、`granted` / `not-a-companion` 的文案被单独钉住、不得有多余档位 |
| MINOR | `MockUserPicker` 没有「当前身份」的行内视觉区分（`01-prompt.md` §六 的要求） | **已修**：新增**显示用的**可选参数 `currentUserId`（蓝边框 + 「当前身份」文案）。⚠️ 那一行**照样可点**，不置灰；同时新增测试把参数集合钉成封闭集合，并断言禁用条件只能由 `busyId` 决定——把 D3 V2 的最终执行规则变成可执行的约束 |
| MINOR | `directory-structure.md` §4.7 未说明 `MockIdentitySwitcher` 会现算资格标签 | **已修** |
| NOTE | `P0-6/04-acceptance.md` 里一句事实描述因共享 fixture 变更而失效 | **已改**，改法与边界见 §2.6（**结论区一个字节没动**） |
| NOTE | 交付文档里两组基线数字（`1108/989/0/119` 与 `1094/978/0/116`）表面上矛盾 | **不是缺陷**：前者是「首轮交付后」的中间态（§2.5 用它算重做批的变化量），后者是「本轮开始前」的基线（§10 用它算整轮）。§10 已补一张来源分解表写明，因为 `tests/devIdentity.test.mjs` 未进 git、无法回溯 |

Reviewer 明确声明**无能力验证**的部分（转述，供验收时注意）：

- **首屏 HTML 的逐字节内容**（MAJOR 那条）：它只做机制推导。**Coordinator 已实跑确认**，
  两态的数字都写进了 §6。
- `pnpm typecheck` / `pnpm build` / `pnpm lint` / HTTP 全量（`1116 / 1116`、`skipped 0`）：
  按只读纪律未复跑，**由 Coordinator 实跑**，见 §10。
- **D8 的静态 / 动态构建对照**：未重跑，只核对机制。
- **真机 / 微信内浏览器的视觉项**（面板是否压住 TabBar、`env(safe-area-inset-bottom)`、
  结算页遮挡、以及新增的「当前身份」标记是否够醒目）：需要真机，只能由人工验收确认。
- `03-delivery.md` 的改动前基线数字：因测试文件未进 git，无法回溯，由交付人自证——本轮已用
  §10 的来源分解表补齐。

---

## 14. 建议提交信息

```
feat(dev): mock identity switcher panel + preset companion fixtures (DEV-1)

Reuse the existing mock auth stack end to end: /api/auth/mock-login,
/api/auth/logout, authAdapter, MockUserPicker and MOCK_LOGIN_USERS.
No second cookie, session, login route or user list.

The ENABLE_MOCK_AUTH gate lives on the server and returns null before
cookies() is called, so the production build (flag off) keeps its static
rendering and the account list never reaches the response.

Preset two genuinely qualified companions (cp-10/u-1022, cp-11/u-1023,
backed by approved applications ca-1008/ca-1009) so the P0-6
User -> Companion A -> Companion B chain can be walked in one browser
without a manual approval step first. Qualification stays derived:
resolveCompanionAccess() and requireCompanion() are untouched, and the
panel's "有效打手 / 普通用户" chip is computed server-side from that same
call, never asserted by the list and never used as a permission.

Supersedes "用户端页面无切换入口" (api-contract.md) per the round prompt;
the replaced test assertion was rewritten into a stricter host manifest,
not deleted.
```

（提交由用户执行。本轮**未执行任何 Git 写操作**。）
