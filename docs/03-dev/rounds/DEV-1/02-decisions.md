# DEV-1 Decisions

> 本轮**没有**向用户提问的 OPEN 决策（未进入 `CLARIFYING`）。下面 8 条是执行期
> 由 Coordinator 依 `01-prompt.md` + `docs/02-tech-design/` + 现有代码事实做的判定。
>
> 其中 **D1 是一处规则替换**（本轮指令覆盖了一条写在长期技术文档里的旧说法），
> 按 `development-workflow.md` §十三「唯一的例外」处理：写进本文件、同步长期文档、
> **保留旧规则被 `SUPERSEDED` 的历史**——三条都已执行。

## 索引

| 编号 | 主题 | 状态 |
|---|---|---|
| D1 | 「用户端页面无切换入口」被本轮替换为「开发环境专用切换面板」 | **V1 CURRENT**（旧说法 SUPERSEDED） |
| D2 | 面板落在用户端**全局布局**，不落在 `MobileShell`、不进另两端 | **V1 CURRENT** |
| D3 | 复用 `MockUserPicker` 与 `MOCK_LOGIN_USERS`，不新写列表 | V1 SUPERSEDED → **V2 CURRENT**（多**两个只用于显示**的可选参数：`accessLabels`、`currentUserId`；参数集合由测试钉成封闭集合） |
| D4 | 开关判定在服务端，且**先判开关再读会话** | **V1 CURRENT**（V2 起「资格派生也在早返回之后」并入本条） |
| D5 | 面板直接调 `authAdapter`，不用 `useAuth()` | **V1 CURRENT** |
| D6 | 预置数据里有几位打手 / 名单怎么标 | V1 SUPERSEDED → **V2 CURRENT**（新增 2 位预置打手 + 8 条名单） |
| D7 | §十三.7 不写成 HTTP 用例，改由数据层 + 人工验收覆盖 | **V1 CURRENT** |
| D8 | 已知代价：Mock 开关开启时用户端页面不再静态预渲染 | **V1 CURRENT** |

> ⚠️ **D3 / D6 在人工验收阶段被用户打回后重做过一次**（本轮第 2 次交付）。
> 旧版本一律保留在上面并标 `SUPERSEDED`，不覆盖——被打回的原因与修正过程在
> D6 的 `Decision V2` 里写清，`03-delivery.md` §2.5 是同一件事的交付视角。

---

## D1

### 背景

`docs/02-tech-design/api-contract.md:23` 的接口说明里写着：

> 模拟登录，写 Mock 会话 Cookie。由 `ENABLE_MOCK_AUTH` 控制，关闭时 404。
> **验收期可用 `{"userId":"u-1002"}` 切换身份；用户端页面无切换入口**

同一句话在别处还有三处：`README.md`（Mock 认证一节只教 curl）、
`app/api/auth/mock-login/route.ts` 的注释、`lib/auth/MockUserPicker.tsx` 的注释
（「选择器只出现在登录界面」「切换 = 退出 + 重新选，没有第三条路径」）。
`tests/mockUsers.test.mjs` 更把它钉成了结构约束：选择器**只允许**被 `LoginGate` 引用。

而本轮 `01-prompt.md` §三 / §六 / §十二 要求「在用户端全局布局提供一个方便的身份切换入口」，
§八/§九/§十 逐条规定它的行为。

### 判定

**按本轮指令执行，并把旧说法标为 SUPERSEDED。**

`development-workflow.md` §十三 的规则优先级里，**「用户最新明确裁定」高于
`docs/01-requirements/` 与 `docs/02-tech-design/`**。本轮指令对「用户端要有一个
开发环境专用的切换入口」是明确、具体、逐条规定的，不是「顺手改一下」。

更进一步：这条旧说法**不是产品规则，而是对当时界面现状的描述**。判据是
「换一种做法，业务结果会不会变」——不变：谁能看到（仅 Mock 开关打开时的开发环境）、
看到什么（测试账号名单，本来就在文档与 README 里公开）、能不能改（不能改任何业务数据）、
金额怎么算（无关）。因此这是技术组织 / 界面形态的变更，不是产品语义的裁定。

§十三 的例外要求三条，逐条落地：

| 要求 | 落点 |
|---|---|
| 写进 `02-decisions.md` | 本条 |
| 同步长期文档 | `api-contract.md:23`、`README.md`、`directory-structure.md` 已同步；代码注释四处已改 |
| 保留旧规则 SUPERSEDED 的历史 | 本节；被替换的**测试断言**按新规则重写而不是删除（见下） |

### 替换前后

| | 旧规则（SUPERSEDED） | 新规则（CURRENT） |
|---|---|---|
| 用户端切换入口 | 只有「退出 + 在登录界面重选」一条路 | 多一个已登录侧的悬浮面板，点一下直接换 |
| 宿主数量 | 1（`LoginGate`） | 2（`LoginGate` + `MockIdentityPanel`），**显式清单** |
| 开关保护 | `LoginGate` 收 `mockAuthEnabled` prop | 同上 + `MockIdentitySwitcher` 服务端先判开关 |
| 权限边界 | 不变 | **不变**：本工具不做任何页面级放行 |

### 没有削弱的既有边界（本轮逐条复验）

- `/api/auth/mock-login` 与 `/api/auth/logout` 在开关关闭时**仍然 404**（实测，见 `03-delivery.md` §6）；
- `mock_user_id` 仍然是**唯一**的用户会话 Cookie（`tests/devIdentity.test.mjs` 钉死三套 Cookie）；
- 打手身份仍然只由「这个用户名下有没有有效护航资料」在服务端算出（`requireCompanion()` 一个字节没改）；
- 工具**不绕过页面权限**：切到一个进不去的身份，由现有守卫照常处理（§九）。

### Final Execution Rule

用户端可以有一个**开发环境专用**的身份切换面板；它必须由服务端开关控制、
关闭时整块不渲染、只做「换掉当前会话」、不引入任何新的身份来源。
**「用户端页面无切换入口」这句话作废**，长期文档与代码注释一律改口。

---

## D2

### 背景

§六 说「可以放在用户端全局布局中」，§十二 说「接入一个合适的现有 layout」。

### 判定

挂在 `app/(mobile)/layout.tsx`（用户端路由组的布局）。

**为什么不挂在 `MobileShell`**：它还被 `app/companion/(console)/layout.tsx` 复用。
挂在壳层上等于顺着壳层漏进打手工作台，而 §十五 明确把「Companion Login」列为不做的事。

**为什么不挂在 `(tabs)/layout.tsx`**：那只覆盖五个一级 Tab 页。订单详情、支付结果、
商品详情这些二级页恰恰是验收时要切换身份的地方（§十一 的链路会经过 `/companion/orders` 之外的多个二级页）。

**为什么不挂进打手工作台**，让切换更近一步：§十五 的禁止清单里有「Admin / Staff 身份切换器」，
没有点名 Companion，但 §六 只说了用户端全局布局，§十五 又要求不做「与 Mock 身份切换无关的
扩展」。挂到第二个端属于扩大范围，因此不做。代价写进 `04-acceptance.md`：在打手工作台里
要换身份，先回到任一用户端页面（同一浏览器，不需要无痕窗口）。

### Final Execution Rule

面板只挂在 `app/(mobile)/layout.tsx`，一端一处；不进管理端、客服端、打手工作台。

---

## D3

### 背景

§十二 的优先顺序第 1 条是「复用现有 `MockUserPicker`」，第 3 条是「复用现有 User fixtures」；
§六 的示例面板里有「当前身份」与「退出登录」，而 `MockUserPicker` 两者都没有。

### 判定

**`MockUserPicker` 原样复用，不扩参数**；外层新写一个薄壳组件
（`lib/auth/MockIdentityPanel.tsx`）负责「当前身份 + 折叠/展开 + 退出」三件事，
把账号列表整块交给 `MockUserPicker` 渲染。

理由：`MockUserPicker` 的入参恰好是它需要的全部（`busyId` + `onPick`），
它本来就不认识登录态——因此「登录界面」与「已登录侧面板」两种用法可以共用同一个组件，
不需要为面板加一个新分支。名单仍然只有 `lib/constants/mockUsers.ts` 一份
（`tests/devIdentity.test.mjs` 断言面板里不出现任何 `u-1xxx` 字面量）。

### Final Execution Rule

面板不得自带名单、不得自己画列表；账号行一律由 `MockUserPicker` 渲染。

### Decision V2

Status: **CURRENT**（V1 被取代——用户要求「切换列表里能一眼分辨普通 User / 打手 A / 打手 B」，
V1 的「不扩参数」挡住了这条要求的落点；同时 D6 的 V2 推翻了 V1 的另一条前提）

**V2 裁定**：`MockUserPicker` 增加**一个可选入参** `accessLabels?: Record<string, string>`，
在每一行右侧渲染一个资格芯片。三条边界不变：

1. **它只是显示**。组件不拿它做禁用、不做跳转、不做任何判断——传错只会让标签写错，
   不会放行谁。页面放行仍然只由打手守卫决定。这一点写进了组件注释与
   `tests/devIdentity.test.mjs`（面板与选择器里不出现任何守卫 import）；
2. **它不是第二份名单**。标签的键是 `userId`，值由服务端现算，组件里没有任何
   `u-1xxx` 字面量（`tests/devIdentity.test.mjs` 断言这条）；
3. **未登录侧不传**，那一行就不显示。这不是「暂时没有」，而是**本来就无从判定**
   （登录界面此时没有任何会话，也就没有「谁是谁」）。因此 `LoginGate` 的调用一个字没改。

**为什么「不扩参数」这条会被推翻，而它当初是对的**：V1 写下「不扩参数」时，
需求是「复用同一个列表渲染」；`busyId` + `onPick` 确实恰好够用。V2 起多了一条
**新的、独立于本组件的**需求（列表要能分辨资格），它必须由某个组件渲染，
而唯一合理的落点就是这个列表。**扩的是「显示什么」，不是「点了会怎样」**——
后者（`onPick` 只交出 userId）一个字节没变，这也是它能被接受的原因。

### Final Execution Rule

`MockUserPicker` 只允许增加**显示用**的可选参数；任何影响行为（禁用 / 跳转 / 校验）的
参数一律不加——那是权限，权限不在这里。

**这条规则现在由测试执行，而不是靠自觉**（审查后补）：`tests/mockUsers.test.mjs`
把参数集合断言为**封闭集合** `["accessLabels","busyId","currentUserId","onPick"]`，
并断言每一处 `disabled={…}` 的表达式里必须含 `busy`。加第四个参数、或让资格标签 /
「当前身份」影响能不能点，都会在测试里先红。

### 补充（V2 之后）：第二个显示参数 `currentUserId`

`01-prompt.md` §六 要求「当前身份应有视觉区分」。V2 当时只做到了面板头部那一行文字
（`当前身份：昵称（userId）`），名单行内没有任何区分——这是审查阶段发现的**提示词要求
未完全落地**，不是新需求。

按同一条 Final Execution Rule 处理：给 `MockUserPicker` 加第二个**显示用**的可选参数
`currentUserId?: string | null`，渲染为蓝边框 + 「当前身份」文案（并带 `aria-current`）。

⚠️ 两个刻意的选择：

1. **那一行照样可点**，不置灰。点它就是「以同一身份重新登录」，不产生副作用；
   「当前」不是一种权限，因此不该长得像权限——这是与 `disabled` 划清界限的地方；
2. **未登录侧不传**，登录界面没有会话，也就没有哪一行是「当前」。

---

## D4

### 背景

§七 是本轮「最重要的安全约束」：`ENABLE_MOCK_AUTH !== true` 时 UI **完全不可使用**，
优先「不渲染」而不是 disabled；且不得削弱接口层已有的 404 保护。

### 判定

开关判定放在**服务端**组件 `lib/auth/MockIdentitySwitcher.tsx`：

```ts
if (!isMockAuthEnabled()) return null;   // ← 先
const user = await getSessionUser();     // ← 后
```

三条理由：

1. **客户端读不到环境变量**，因此这件事只能由服务端回答；把 `MOCK_LOGIN_USERS` 交给一个
   客户端判定渲染与否，等于把名单发给了所有人；
2. **顺序不能调换**。先返 null 意味着开关关闭时**连 `cookies()` 都不会被调用**——
   本组件挂在用户端全局布局上，若顺序反过来，正式部署的每一个用户端页面都会因为
   一次无谓的会话读取而变成按请求渲染（这正是 D8 的另一半）；
3. 「开关是唯一判据」在源码里看得见：门禁文件里那句早返回由
   `tests/devIdentity.test.mjs` 按**位置**（早返回的下标小于读会话的下标）钉住。

面板组件本身**完全不认识开关**，因此客户端没有任何办法把它调出来。

### Final Execution Rule

开关只在服务端判定；关闭时整块 `return null`，不渲染、不读 Cookie、名单不进响应。

### 补充（D6 V2 之后）：资格派生也必须排在早返回之后

D6 V2 让门禁组件多做一件事——对名单里每个人现算资格标签。它属于**同一类东西**
（「开关关闭时不得进入响应的内容」），因此必须满足同一条位置约束：

```ts
if (!isMockAuthEnabled()) return null;   // ← 必须在最前
const user = await getSessionUser();     // ← 会话
for (…) await resolveCompanionAccess(…)  // ← 资格派生，同样在后面
```

判据由 `tests/devIdentity.test.mjs` 按**位置**钉住：截取早返回之后的源码，
断言其中必须出现 `resolveCompanionAccess(` 与 `MOCK_LOGIN_ACCESS_LABELS`。
把它挪到早返回之前，开关关闭时标签照样会被算出来并渲染。

（开关关闭 **且** 无人登录时，门禁不读 Cookie、不查仓储、名单与标签都不进响应——
这是「不泄露」在关闭态下的完整形态。）

---

## D5

### 背景

仓库里读登录态的客户端钩子是 `useAuth()`，但它由 `AuthProvider` 提供，而
`AuthProvider` 只长在 `RequireAuth` 保护的页面里。面板挂在**全局**布局上，
首页、商品详情这些免登录页面也在内——那里没有 Provider，`useAuth()` 会直接抛错。

### 判定

面板直接调用 `authAdapter`（`login` / `logout`），并在成功后 `router.refresh()`。

这是 **`LoginGate` 已经在用的写法**（`lib/auth/LoginGate.tsx` 同样直接调 `authAdapter`），
不是新开的路：`AuthAdapter` 的契约本来就写着「页面只依赖这个接口」，
`authAdapter` 是「登录」在全仓的唯一切口，`useAuth()` 只是给页面用的上下文包装。

分层上也干净：面板是 `components`→`lib/auth` 方向（与 `MockUserSwitchButton` 一致），
`lib/auth` 不认识任何页面。

### Final Execution Rule

切换走 `authAdapter.login(userId)`、退出走 `authAdapter.logout()`，
之后必须 `router.refresh()`；组件内不得出现 `fetch(` / `document.cookie` / `api_post` 之类。

---

## D6

### 背景

§八 要求名单「至少覆盖一个普通 User 与**至少两个具备有效 Companion 资格的 User**」，
并明确指示：「如果当前 seed 已有 u-1001 / u-1002…，**先检查各自真实资格，不要凭名字猜测**」。

### Decision V1

Status: **SUPERSEDED**（被本轮的 V2 取代——V1 **满足的是「要求」的字面，不是它的意图**，
用户在人工验收阶段据此打回）

**V1 的核查结果（当时是事实）**：预置数据里没有任何用户具备打手资格。
`companionSeed` 里每条记录的 `userId` 都是 `null`，`companionIdByUser` 索引启动时是空的；
对 `u-1001`…`u-1010` 逐个实跑 `findCompanionByUser`，十个全是 `not-a-companion`。

**V1 的判定**：名单保持不变（六个账号），并**不给面板加「谁是打手」的实时徽标**——
理由是把 `resolveCompanionAccess` 引进用户端布局会为每个页面多出六次资格读取，
「收益只是省掉一次 `/companion` 跳转」；判断自己是不是打手的权威入口是 `/companion`。
同时把「名单里没有人是打手」这条事实**正面钉进** `tests/devIdentity.test.mjs`。

**V1 错在哪**：它把 `§八` 里的「至少两个**具备有效 Companion 资格的** User」
读成了「至少两个**可以变成**打手的 User」，于是用「候选」这个措辞把要求绕过去了。
用户指出的是后果，而不是措辞：

> 「§5 明确核查：当前可切换用户中没有任何有效 Companion… 因此当前 DEV-1 虽然能『切 User』，
> 但还不能完成它最重要的用途：在一个浏览器里验收 P0-6 的 User → Companion A → Companion B
> 链路。这也违反了 DEV-1 原始要求。」

也就是说：**DEV-1 的交付物不是一个「能切身份的工具」，而是「一启动就能在本机跑通
P0-6 换身份链路的环境」**。工具只是那件事的一半；另一半是**环境里得真的有两个人可切**。
V1 把这一半判成了「不需要做」，于是一个只能切到「都不是打手」的身份列表，
在验收时必然要求先绕去后台审核——而那正是 §十二 里明令要避免的一步。

V1 的第二个错误是**用一个成本理由否掉了一条需求**：六次 Map 查找的开销，
与「验收链路的第二步走不通」不在一个量级上。成本判断不能推翻需求。

### Decision V2

Status: **CURRENT**

**裁定**：给 Mock 环境**补两位真实存在的打手**，让「启动即有 2 个有效 Companion」成为
预置数据的事实，而不是一份需要人工制造的状态。

落点（三处，都在既有 fixture 体系内，**不创建第二套角色模型**）：

| 文件 | 新增 | 为什么 |
|---|---|---|
| `lib/mocks/fixtures/seed.ts` | `u-1022` / `u-1023` 两个用户 + `cp-10` / `cp-11` 两条护航资料 | 两人 `userId` 有值、`applicationId` 指向真实申请、`enabled` 与 `available` 都为 `true` |
| `lib/mocks/fixtures/companionApplicationSeed.ts` | `ca-1008` / `ca-1009` 两条 `approved` 申请 | 让「护航资料由入驻审核产生」有据可查，而不是凭空出现 |
| `lib/constants/mockUsers.ts` | 名单 6 → 8，新增 `approved` 状态与 `MOCK_LOGIN_ACCESS_LABELS` | 名单里出现「已经是打手」的账号 |

**为什么新建用户，而不是把 `u-1002` / `u-1003` / `u-1004` 改成打手**：

- `u-1002`（`ca-1002`）与 `u-1003`（`ca-1003`）是「待查看 / 审核中」两个状态页的**唯一**样本，
  也是「后台可直接通过」这条产生打手的路径的样本——改掉它们等于弄没两条验收路径；
- `u-1004`（`ca-1004` 已通过）是「申请已通过、但护航资料另行产生」这个**中间态**的唯一样本，
  给它补一条护航就等于把这个状态从数据里删掉；
- 这三条都被 `tests/companionApplications.test.mjs` / `tests/mockUsers.test.mjs` 钉着。
  新建两位用户不触碰任何既有断言。

**为什么不需要写「资格」数据**：`lib/services/companionAccess.ts:19` 明确写着
`UserQualificationRecord` 是**审核历史与审计记录，不是第二道运行时闸门**。
资格的真值源就是「这个用户名下有没有一条未移除的护航资料」——因此补护航资料即可，
这与既有预置数据的做法一致（`ca-1004` 没有资格记录，一样是合法状态）。

**四个条件缺一不可（写进种子的注释，也被测试钉住）**：

| 字段 | 值 | 改错的后果 |
|---|---|---|
| `userId` | `u-1022` / `u-1023` | 没有它，`findCompanionByUser` 查不到，判定仍是不打手 |
| `removedAt` | `null` | 非 null 即「已移除」，不登记进索引 |
| `enabled` | `true` | 判定变成 `disabled`：进不了工作台（BR-01） |
| `available` | `true` | 进得去但公共池一单不给，「接单」这一步当场卡住（BR-01） |

**标签改为服务端派生**（这也推翻了 V1 的「不给面板加实时徽标」）：
`MockIdentitySwitcher`（服务端）对名单里每个人现算 `resolveCompanionAccess`，
把 `kind` 映射成 `MOCK_LOGIN_ACCESS_LABELS` 交给面板显示。
用户明确许可了这个做法（「标签可以由服务端基于真实资格派生，但不要把标签本身当权限依据」），
而它恰好消除了 V1 那种失败模式：**标签与真实判定用同一份数据、同一个函数，没有脱节的可能**。

### Final Execution Rule

Mock 环境**启动即有**：1 个普通下单 User（`u-1001`）+ 2 个 `resolveCompanionAccess()`
判定为 `granted` 的 User（`u-1022` / `u-1023`）。这三个身份必须能被 Mock 身份工具
直接切到，且**验收链路中途不得要求去后台把 A / B 审核成打手**。
资格标签由服务端基于真实资格派生，**只用于显示**，不作为任何权限依据。

---

## D7

### 背景

§十三 的清单里第 7 条是「普通 User 切换到 Companion User 后可以通过现有 Companion Guard」。

### 判定

**这一条不写成 HTTP 用例。** 两个理由：

1. 要造出一个打手，唯一的真实路径是「后台通过入驻申请」——即必须在 HTTP 用例里
   写一条 admin approve。而 `tests/adminCompanionManagement.test.mjs` 明确记录了本仓库的
   既有约定：「这台服务的**内存是整轮 HTTP 用例共享的**…矩阵如果真去『通过一条申请』，
   同一轮里读这些记录的用例就会跟着失败——测试互相污染，报错却指向别处。所以矩阵一个字节都不写。」
   而 `node --test` 按文件并行跑，新建的护航记录可能出现在**同时运行**的其它文件的断言里；
2. 「切到打手就能进工作台」的真正机制**不在** DEV-1 里：它是
   `requireCompanion() = requireUser() + resolveCompanionAccess(userId)`，本轮一个字节没改。
   值得为 DEV-1 保护的命题是「切换身份不会引入第二个身份来源」，这件事有更结实的证明方式。

因此第 7/8 条改由两条**数据层 + 源码级**用例承担（`tests/devIdentity.test.mjs`）：

- 造一位绑定 `userId` 的护航 → 该 userId 判定 `granted`；同进程里另一个普通 userId 判定
  `not-a-companion` → **判定只吃 userId，不吃任何会话级 / 工具级状态**；
- `lib/api/companionRoute.ts` 必须只走 `requireUser()` + `resolveCompanionAccess()`，
  且源码里**不得出现任何 Cookie 名或 `cookies()` 调用** → 打手身份没有第二个来源。

剩下的那一步（真在浏览器里点一下面板、再看 `/companion` 放行）进人工验收清单，
这正是 §十三 允许的「UI 行为进入人工验收」。

### Final Execution Rule

不为 DEV-1 在 HTTP 用例里造打手；第 7 条由数据层用例 + 人工验收共同覆盖，并在
`04-acceptance.md` 里给出可直接照做的两步（管理端开一个标签页批准，用户端面板切过去）。

### 补充（D6 V2 之后）

D6 V2 补了预置打手之后，这条规则**没有变**，但第 4/5/6 条多了一种**不违反它**的证法：
用 `u-1022` / `u-1023` 这两个**预置**身份直接打到真接口上（登录 → `GET /api/companion/orders`
→ `GET /api/companion/dispatches`），全程只读、一个字节都不写。
因此 `tests/devIdentity.test.mjs` 的 HTTP 节现在多一条
「打手 A / B 的会话真的能过 `requireCompanion()`」——它验的是**守卫真的放行**
（401 / 403 的分支逻辑），与数据层的「判定为 granted」不是同一件事。
造打手仍然不做；这条规则守的正是「不写」。

---

## D8

### 背景

`app/(mobile)/layout.tsx` 现在会（在开关打开时）调用 `cookies()`。
Next 的 App Router 里，动态 API 一旦在某次预渲染中被调用，该路由就是按请求渲染。

### 实测

| 构建时的 `ENABLE_MOCK_AUTH` | 用户端页面（如 `/help`、`/activities`） | 说明 |
|---|---|---|
| `true`（本地 `.env.local` 的取值） | `ƒ (Dynamic)` | 门禁读到开关为真 → 读会话 → 动态 |
| `false`（正式部署形态） | `○ (Static)` | 门禁**先返回 null**，`cookies()` 根本没被调用 → 静态化不受影响 |

两种都实测过（`ENABLE_MOCK_AUTH=false pnpm build` vs 默认构建，见 `03-delivery.md` §7）。

### 判定

接受。理由：

- 受影响的是**开发形态**；正式形态（开关关闭）行为逐字不变——这正是 D4 里
  「先判开关再读会话」那一行顺序换来的；
- 这个项目当前跑在 `globalThis` Mock 存储上，用户端页面的数据本来就不缓存，
  按请求渲染不会改变任何可见行为，只多一点服务端开销；
- 反过来（为避免动态化而把面板改成客户端拉会话）会引入一次额外的 `/api/me`
  请求与一次「先空白后出现」的闪烁，代价更大。

**明确不接受的做法**：把面板挂成一个「始终渲染、由 CSS 隐藏」的元素。那正是 §七
点名不要的形态。

### Final Execution Rule

用户端全局布局允许因本工具而按请求渲染；但**开关关闭时必须仍走静态化路径**
（即 D4 的顺序约束），回退办法只有一条：把 `cookies()` 挪到开关判定之前——
那是回归，不是优化。
