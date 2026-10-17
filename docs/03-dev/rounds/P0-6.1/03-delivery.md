# P0-6.1 · 03-delivery.md

Round ID: P0-6.1
交付时间: 2026-09-24
Status: AWAITING_ACCEPTANCE

> ⚠️ **交付不等于 DONE**。`development-workflow.md` §十七「DONE 的双重门槛」要求
> **用户明确说明验收通过** + **用户本人完成 Git 提交**，缺一不可。
> 在用户提交之前，`Status` 保持 `AWAITING_ACCEPTANCE`，本轮的 `Git Commit` 一列为空。

---

## 一、本轮改动（两个整改项，无新功能）

| 项 | 落点 | 性质 |
|---|---|---|
| FIX-1 工作台返回用户端 | `components/companion/CompanionHeader.tsx` + `lib/constants/companionConsole.ts` | 界面导航（无认证行为） |
| FIX-2 订单池「等待最久优先」 | `lib/services/companionDispatch.ts` | 只读排序（无状态迁移） |

**本轮不新增、不修改任何订单 / 派单状态迁移。** 派单状态机
（`exclusive` / `public` / `accepted` / `timed_out`）、`accepted → serving`、封禁回池、
客服换人、退款、P0-6 的取消逻辑、超时业务规则、护航资格判定、会话模型**一律未动**。

### 1.1 本轮 delta（batch §六：不得把总 diff 冒充成本轮产物）

**轮次起点**（batch §一 要求记录）：`branch = feat/order-lifecycle-alignment`、
`HEAD = 249f7c1`（`docs: close P0-6 and DEV-1 after acceptance`）。
**轮次开始时工作区是干净的**——只有用户刚放进来的 `cmd_batch_*.md` / `cmd_p0-6.1.md` 等
未跟踪文件，**没有任何前序 Round 遗留的未提交业务代码**，
因此本轮的 delta 就是下面这份清单，不需要从别轮的改动里剥离。

**本轮新增文件**

| 文件 | 说明 |
|---|---|
| `tests/companionPoolOrder.test.mjs` | FIX-2 回归（本轮新增） |
| `tests/companionConsoleNav.test.mjs` | FIX-1 源码结构门禁（本轮新增） |
| `docs/03-dev/rounds/P0-6.1/`（5 件 + `01-prompt-extended.md`） | 本轮 Round 档案 |

**本轮修改文件**

| 文件 | 本轮改了什么 |
|---|---|
| `lib/services/companionDispatch.ts` | 删 `compareByDeadline`；加 `PoolEntry` / `currentPoolEnteredAt` / `compareByWaitingSince`；收集与返回改为「带键收集 → 排序 → 取 DTO」 |
| `lib/constants/companionConsole.ts` | 追加 `COMPANION_BACK_TO_USER_LABEL` / `COMPANION_BACK_TO_USER_HREF` 与说明注释 |
| `components/companion/CompanionHeader.tsx` | 顶栏最上方左侧加一行 `← 返回用户端`；import 两个新常量；补文档注释 |
| `docs/02-tech-design/api-contract.md` | §8 新增 8.1（池子返回顺序契约） |
| `docs/02-tech-design/database-schema.md` | §7 补全 Dispatch 关键字段与两组时刻说明 |
| `docs/03-dev/rounds/README.md` | 索引新增 P0-6.1 行 |
| `docs/03-dev/总需求进度表.md` | 新增 P0-6.1 行；两条 `NEEDS_FIX` 行标注「已由 P0-6.1 实现，等待人工验收」 |

**本轮没有改动、且明确不属于本轮产物的东西**：`docs/01-requirements/**`、
`P0-6/`、`DEV-1/`、`P0-5.5/` 的历史档案（一个字节都没改）；
`tests/admin.test.mjs` 等既有测试；任何 `lib/data/**`、`app/api/**`、`app/(mobile)/**`。

**用户放入的指令文件（未跟踪，不属于本轮产物，也不属于本轮新增）**：
`docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md`——用户第一次给出的**长版**指令，
落盘时文件名被压扁成这个名字，且是 **GBK** 编码（用 UTF-8 读是乱码）。
它的内容已由本轮**逐字**转换归档为 `docs/03-dev/rounds/P0-6.1/01-prompt-extended.md`
（只读审查用 `iconv -f GBK -t UTF-8` 转换后 `diff` 结果为**完全相同**）。
**Claude 不删用户放进来的文件**，因此它仍在工作区里；⚠️ **建议用户在提交前删除它**，
否则一个乱码文件会随 `git add -A` 进入版本库。

**过程产物（已清理，不进提交）**：排查「Mock 时钟毫秒精度」时写过一次性探针
`tests/manual/probePool.mjs`，**已删除**（`tests/manual/` 下仍只有原本就在版本库里的
`browserChain.mjs`）。它测出的事实记在 `02-decisions.md` D6。

---

## 二、FIX-1 实现

### 2.1 落点

**入口写在共用顶栏组件 `components/companion/CompanionHeader.tsx` 里**，
该组件由 `app/companion/(console)/layout.tsx:69` 在 `granted` 分支渲染。
决策理由见 `02-decisions.md` **D1**。

**覆盖范围是结构上成立的**，不是靠人工检查：

```
app/companion/(console)/layout.tsx
  └── <CompanionHeader />            ← 唯一 import 点（全仓）
        ├── /companion             (console)/page.tsx
        ├── /companion/orders      (console)/orders/page.tsx
        ├── /companion/orders/[id] (console)/orders/[id]/page.tsx
        ├── /companion/exclusive   (console)/exclusive/page.tsx
        └── /companion/pool        (console)/pool/page.tsx
```

已核对：`CompanionHeader` 在整个仓库里**只有一处 import**
（`app/companion/(console)/layout.tsx:3`），且 `app/companion/**` 下**没有任何页面**
自己再写一个指向 `/` 的链接。因此「每页复制一个按钮」这一形态在结构上不可能出现，
将来新增 `(console)` 下的页面也会自动带上该入口。

### 2.2 文案与目标

```ts
// lib/constants/companionConsole.ts
export const COMPANION_BACK_TO_USER_LABEL = "返回用户端";
export const COMPANION_BACK_TO_USER_HREF = "/";
```

目标 `/` **就是用户端主入口**——底部 TabBar 的「首页」那一格指向同一个地址
（`components/common/TabBar.tsx` 的局部 `TABS`）。该常量**未导出**，本次**没有**为了共用
去改用户端组件（§十三 未允许），两处写同一个 `/` 由测试门禁盯着。

### 2.3 布局

入口单独占一行放在**最上方左侧**（`px-4 pt-2`），不与下面那一行
（平台名 + 四个导航项 + 打手头像）挤在一起：那一行在 375px 宽的手机上本来就要折行，
再塞进去会先把标题压变形。样式沿用仓库既有返回链接写法
（`components/admin/AdminPageHeading.tsx` 的同一套 `text-ink-3` / `hover:underline`）。

### 2.4 无认证副作用

入口就是一个 `<Link href="/">`，**没有**任何 logout / Cookie / 身份切换调用。
`/` 的用户端布局用**同一个** `mock_user_id` 解析会话，因此「点完仍在登录」不需要本入口做任何事
（决策见 **D3**）。测试门禁固定了这一点（见 §三 FIX-1 第 6 条）。

### 2.5 明确不在覆盖范围内的一处

两种「进不去工作台」的提示页（`CompanionAccessNotice`：还不是护航 / 资格已下架）
**不渲染工作台顶栏**，因此不带本入口——它们本来就有自己的 `返回我的` → `/mine`。
这是**有意保留**的（那两句话的场景是「去看自己的资料」，不是「继续逛用户端」），
已写进 `04-acceptance.md` 的 A 组说明，避免验收时被当成遗漏。

---

## 三、FIX-2 实现

### 3.1 排序真值

| 池子 | 排序键 | 方向 |
|---|---|---|
| 专属池 `exclusive` | `DispatchRecord.exclusiveEnteredAt` | ASC |
| 公共池 `public` | `DispatchRecord.publicPoolEnteredAt` | ASC |

取键方式：按 **`record.state`** 取「当前池」的那一个
（`currentPoolEnteredAt`，形状与既有 `companionDispatchTransaction.currentDeadlineAt` 一致）。
⚠️ **不能**按 `exclusiveCompanionId` 取——`public` 记录可以带**非空**的
`exclusiveCompanionId` / `exclusiveEnteredAt`（用户指定过、对方超时转池），
那是历史事实而不是当前池；取错会把一张早就超时转过来的单顶到最前面。决策见 **D4**。

并列：`dispatchId` ASC（沿用本文件原有的 tie-break）。`waitingSince` 为 `null` 时按最旧处理，
排在前面而不是丢弃。决策见 **D6**。

### 3.2 接口契约零改动

排序键**不进 DTO**：内部收集的是局部类型 `PoolEntry = { item, waitingSince }`，
`sort` 之后 `map((entry) => entry.item)` 才输出。因此 `CompanionPoolItem` 的字段集合
**一个都没变**——打手仍然看不到「这单是什么时候进的池子」。决策见 **D5**。

### 3.3 旧 comparator 已删除

`compareByDeadline`（`deadlineAt` ASC + `dispatchId` tie-break）**已删除**，
不做「保留但不用」——一个不再被调用的旧 comparator 留在文件里，唯一的实际作用是
诱导下一个人把它接回去。**它为什么「看起来也对」**（时长没被改过时两者恰好同序）
已写进 `compareByWaitingSince` 的注释，并由测试用例 11.6 专门守卫。决策见 **D7**。

### 3.4 客户端无重复排序

已核对：**没有任何消费者**对池子做二次排序——两张页面的组件
（`CompanionDispatchTable`）按给定顺序 `items.map(...)` 渲染，
接口 `GET /api/companion/dispatches` 直接透出服务端结果。
全仓 `components/` 与 `app/` 下没有针对池子的 `.sort(` 调用。
因此本轮**没有**需要收敛的重复排序逻辑（§九 的要求本来就是满足的，
本轮把「服务端排完、下游不再排」写进了文档与测试）。

### 3.5 只改顺序，不改可见性

专属池只对 `exclusiveCompanionId` 本人可见、公共池在暂停接单时一条都不返回、
自己下的单不进池子（EX-DISPATCH-08）、`canAccept` 与 `notice` 的判定——
**全部保持原样**，一行过滤逻辑未动。决策见 **D8**。

已核对下游没有「取第一条当最重要的一条」的用法（没有 `pool[0]` / `.public[0]` 之类），
因此顺序变化**只影响显示**，不改变任何业务判定。

---

## 四、技术文档同步

| 文档 | 改动 |
|---|---|
| `docs/02-tech-design/api-contract.md` | §8 新增 **8.1 `GET /api/companion/dispatches` 的返回顺序（P0-6.1）**：把两个排序真值、取键规则、禁止项、重新回池按新时刻、并列规则、「只在服务端排一次」「排序键不进 DTO」写成接口契约的一部分 |
| `docs/02-tech-design/database-schema.md` | §7 Dispatch 的「关键字段」一行**补全** `publicPoolEnteredAt` / `publicTimeoutMinutesSnapshot` / `publicDeadlineAt` / `acceptedByCompanionId`，并新增两组「进入时刻 + 到点时刻」的说明、排序真值指向 `api-contract.md` §8.1 |
| `docs/03-dev/总需求进度表.md` | 新增 `P0-6.1` 行；两条 `NEEDS_FIX` 行（FIX-1 / FIX-2）**保持在 `NEEDS_FIX`**（本轮止于 `AWAITING_ACCEPTANCE`），并标明「已由 P0-6.1 实现，等待人工验收」；FIX-2 行里「当前实现为 `compareByDeadline`」改为「**发现时**的实现为……」 |
| `docs/03-dev/rounds/README.md` | Round 索引新增 `P0-6.1` 行（`AWAITING_ACCEPTANCE`，`Git Commit` 留空） |

⚠️ **`database-schema.md` §7 的补全是本轮 Requirement Check 的副产品**：
该行此前没有列出 public 侧三个字段，而本轮排序真值正是 `publicPoolEnteredAt`——
一份查不到该字段的数据模型文档会让人以为排序键不存在。字段本身一直是真实的，
只是文档漏列，本轮补齐。

⚠️ **`docs/01-requirements/` 与已 `DONE` 轮次的历史档案（`P0-6/`、`DEV-1/`）一个字都没改。**
`P0-6/04-acceptance.md` 里记录的 FIX-1 / FIX-2 是**已冻结的历史验收发现**，本轮不改写它。

---

## 五、测试

### 5.1 新增

| 文件 | 覆盖 |
|---|---|
| `tests/companionPoolOrder.test.mjs` | FIX-2：§十一 的 11.1–11.6（含 deadline ≠ enteredAt 的反例守卫） |
| `tests/companionConsoleNav.test.mjs` | FIX-1：§十 的 10 条（源码结构门禁，JSX 行为由人工验收覆盖） |

**没有新建测试框架**，沿用 `node --test` + 既有源码扫描 / 数据层断言方式。

（详细用例清单与各自断言见 §六；文件行数与门禁结果见 §七。）

---

## 六、用例清单

沿用仓库既有的 `node --test` 与「源码扫描 / 数据层断言」方式，**未引入任何测试框架**。

### 6.1 `tests/companionPoolOrder.test.mjs`（811 行）——FIX-2

进程内用例全部走**真实业务链路**造素材（下单 → 支付 → 接单 / 取消 / 转池），
再用两种**已被批准**的机制把关键时刻钉开（不是绕过业务规则，只是无法用真实时钟造出确定的先后）：

- 夹具布置：`dispatchStore()` 导出的记录是 `listOpenDispatches()` 返回的**活引用**，
  测试直接写 `publicPoolEnteredAt` / `exclusiveEnteredAt`，排序与清扫仍然真实执行；
- 真实入口 `cancelAcceptedOrder({ at })`：它把 `publicPoolEnteredAt` **逐字写成** `at`，
  这是唯一能在真实链路里稳定造出「并列」的办法。

| # | 用例 | 钉住的不变量 | 反空转守卫（缺了它用例可能碰巧通过） |
|---|---|---|---|
| 11.1 | 公共池按 `publicPoolEnteredAt` ASC | 三单钉在 −30 / −20 / −10 分钟 → 返回 `[A, B, C]` | 先断言夹具真的写进去了，且三者**严格递增**且两两不同 |
| 11.2 | 运行期新进池的单排最后 | 「谁先被写进 Map」不决定顺序 | 断言新单的真实进入时刻**晚于**已布置的单，否则视为空转 |
| 11.3 | **P0-6 回池用新时刻** | 取消后的 `publicPoolEnteredAt` **等于** `cancelAt`、**不等于**原来的进池时刻、**不等于** `Order.createdAt`；期望 `[B, C, A]` | 显式写出反例：A 是三单里创建最早的那单，按 `createdAt` 排会把它顶到最前 |
| 11.4 | 专属池按 `exclusiveEnteredAt` ASC | 三单都指定同一位护航（−6 / −4 / −2 分钟，落在 10 分钟窗口内） | 同 11.1 |
| 11.5 | **并列契约** | 两单经真实取消链路被写成**逐字相同**的时刻 → 顺序 = `dispatchId` ASC，且连读三次逐字相同 | 先断言两个时刻确实逐字相同；再断言结果等于 `dispatchId` 排序后的顺序（否则本条退化成随机） |
| 11.6 | **deadline ≠ enteredAt 的反例守卫** | 后台把公共池时长从 30 改到 10 之后：B 比 A 晚进池却更早到点；列表仍必须是 `[A, B]`，且**排在最上面的那单截止时间反而最晚** | 两个不等式（`A.enteredAt < B.enteredAt`、`B.deadlineAt < A.deadlineAt`）必须先成立 |
| 11.7 | **取键按 `state`，不按「有没有指定过护航」** | 指定过护航、专属池超时转入公共池的单，按其**转入**时刻排序，而不是当初进专属池的时刻 | 断言 X 的历史时刻早于 Y、当前时刻晚于 Y，两个键给出相反顺序 |
| DTO | 契约不变 | `CompanionPoolItem` 字段集与 P0-5 **逐字相同**（12 个字段），且没有任何字段名匹配 `/enter/i` | 逐个字段点名说明「排序键留在服务端」的理由 |
| HTTP | 服务端原样透出新顺序 | 新支付成功的单必须出现在服务端公共池里、不在专属池里，并排在「我下单前就在池里」的每一单**之后**；连读三次的稳定子序逐字相同 | 断言 `canAccept === true`；先确认「我这一单」真的被返回（这一句同时是「接口真的从服务端取数」的证据） |
| 唯一真值源 | **下游不得再排一次** | 扫 `components/companion/**`、`app/companion/**`、`lib/services/companionHttp.ts`，断言 `.sort(` / `.toSorted(` **零命中**（先剥注释；附一张今天为空的显式豁免清单） | 先断言扫描到的文件数 > 5，避免扫空目录静默变绿；**已实测**：往 `companionHttp.ts` 里临时塞一句 `.sort()` 时这条门禁**当场变红**，剥掉后文件 sha1 与塞之前逐字相同 |

**⚠️ 11.1 / 11.4 不是「改回 deadline」的守卫**（只读审查指出，值得下一个动这段代码的人知道）：
它们的三单时长一律 60 分钟，因此 `enteredAt` 序与 `deadlineAt` 序**恰好相同**，
comparator 被改回 `deadlineAt`、甚至**完全不排序**（Map 插入序恰好等于期望序）时它们仍会通过。
真正拦住回归的是 **11.6**（构造两个键**相反**的顺序并断言服从 `enteredAt`）、
**11.3**（`createdAt` / 不排序会得到 `[a,b,c]` ≠ 期望 `[b,c,a]`）与 **11.7**（取错键会把 X 顶到最前）。
**这三条不要因为「看起来和 11.1 重复」而删掉**——删掉之后这一批就只剩空转的守卫了。

HTTP 用例的实测输出（`t.diagnostic`，取第二次全量运行）：
`公共池：下单前 21 条 → 读完 22 条；我这一单在第 21 位；参照单里最靠后的是第 20 位（共 21 条）；三次读的稳定子集 21 条`
—— 即新单**恰好**排在所有更早进池的单之后、且是当前列表的最后一位。

### 6.2 `tests/companionConsoleNav.test.mjs`（275 行）——FIX-1

FIX-1 是 JSX 行为，而 `node --test` 不剥离 JSX（`CLAUDE.md` 已记录），因此这里做的是**源码结构门禁**：
用既有未改动的 `tests/source-text.mjs`（`collectFiles` / `readSource` / `stripComments`）扫源码，
把「只在一页出现」「偷偷 logout」「引入第二套认证」这类**结构性错误**钉死；页面观感由人工验收覆盖。

| # | 门禁 | 钉住的不变量 |
|---|---|---|
| 1 | 返回目标 | `COMPANION_BACK_TO_USER_HREF === "/"`，并与 `components/common/TabBar.tsx` 里「首页」那一格的 href **交叉校验**为同一地址 |
| 2 | 渲染方式 | 顶栏渲染 `<Link href={COMPANION_BACK_TO_USER_HREF}>` + `{COMPANION_BACK_TO_USER_LABEL}`，**不是**硬编码 `"/"` |
| 3 | 覆盖范围 | `CompanionHeader` **全仓恰好一处 import**（`(console)/layout.tsx`）；`(console)` 页面集**恰好是那 5 页**；`app/companion` 恰好只有一个 layout；入口出现在 `access.kind !== "granted"` 早退之后 |
| 4 | 不重复 | 工作台各页**没有**自己再写指向 `/` 的返回链接 |
| 5 | 不泄漏到用户端 | `app/(mobile)/**` 没有任何文件提到 `CompanionHeader`（并先守卫该目录非空，避免扫空目录假绿） |
| 6 | 不是退出登录 | `app/companion/**` 与 `components/companion/**` 里**没有** `logout` / `/api/auth/logout` / `signOut` / `cookies(` / 三个会话 Cookie 名 |
| 7 | 没有第二套认证 | 按**内容特征**断言 `lib/api/companionRoute.ts` 仍是 `await requireUser()` + **恰好两个** `new ApiError("FORBIDDEN"` 分支且无 `cookies(`；`companionAccess.ts` 仍导出 `resolveCompanionAccess`；layout 委托给它而非自己查 `findCompanionByUser` |
| 8 | 无认证符号 | 常量文件与顶栏**没有**引用任何 `@/lib/auth` / Cookie / session 符号；常量文件是纯字符串 |

### 6.3 覆盖不到的部分（如实记录）

- **页面渲染观感**（入口是否遮挡标题、窄屏是否折行、点完是否真的落在首页）**没有自动化覆盖**，
  必须由人工验收 —— 已写进 `04-acceptance.md` A 组。
- **真实数据库下不成立**：11.1~11.7 依赖内存里的活引用与「支付那一刻的毫秒级时刻」，
  HTTP 用例依赖服务端时钟。两者都是 Mock 伪事务的性质，将来接真库时这些**构造方式**要重写
  （业务规则本身不变）。
- **亚毫秒并列**：若别的用例文件在**同一毫秒**把另一单写进服务端的公共池，那条单的先后会落到
  随机 `dispatchId` 上，HTTP 用例的「我排在更早进池的单之后」理论上可能因此变红。概率极低，
  且加固手段（连续下两单再断言先后）正是文件头明确禁止的伪断言，因此**不加固**。

---

## 七、门禁结果

| 门禁 | 结果 |
|---|---|
| 定向：`tests/companionPoolOrder.test.mjs` + `tests/companionConsoleNav.test.mjs` | 全绿（含 HTTP 单跑） |
| `pnpm test`（不设 `APP_BASE_URL`） | `tests 1133 · pass 1012 · fail 0 · skipped 121`（121 条即被跳过的 HTTP 批次） |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit **0** |
| `pnpm lint`（ESLint CLI） | exit **0**，无输出 |
| `pnpm build`（Turbopack，生产构建） | exit **0** |
| **HTTP 全量** `APP_BASE_URL=http://localhost:3211 pnpm test`（第 1 次） | `tests 1133 · pass 1133 · fail 0 · skipped 0` ✅ |
| **HTTP 全量**（第 2 次） | `tests 1133 · pass 1133 · fail 0 · skipped 0` ✅ |

生产服务器：`npx next start -p 3211`，PID **15708**，`Ready`，`netstat` 确认 `LISTENING`。
两次全量 HTTP 运行**都全绿**，`fail 0 / skipped 0`，满足 batch §四 第 7 条。

### 7.1 门禁暴露并修掉的一个缺陷（本轮的真实过程）

第一次 HTTP 全量**通过**，第二次**变红**：`actual` 比 `expected` 多出 8 条专属派单。
根因是**测试**（不是实现）——两个独立缺陷：

1. HTTP 用例原来拿**服务端**返回的池子与本**进程**的 store `deepEqual`。
   服务端是另一个进程、另一份 store，而 `tests/adminProducts.test.mjs` 等文件会在**同一台服务器上真的下单**，
   于是服务端池子里出现本进程没有的派单。`filter(id => serverIds.has(id))` 挡不住：
   它只保证不比「服务端多出来的」，而 `deepEqual` 比的是**整个数组**。第一次能过只是当时服务端还没多出那一单。
2. 逐字比对「整张列表」同样脆：`node --test` **并行跑文件**，两次读之间别的文件随时可能新增/清扫。

修法（只改 `tests/companionPoolOrder.test.mjs` 的这**一条**用例与其常量/段落说明，业务代码与 11.1~11.7 逐字未动）：
改为**自证式相对断言** —— 用例自己在服务端造一单（`POST /api/orders/pay` + `/api/payments/mock-confirm`），
断言它**排在「下单前就在池里」的每一单之后**（相对结论，对并发新增免疫，**不**断言自己是最后一名、
**不**断言池子长度），稳定性只比「三次读都还在的稳定子集」的子序列。

### 7.2 我（Coordinator）自己做的独立复核

不采信报告，另外用一次**独立 HTTP 探针**（写在仓库外，已删除）验证「服务端真的按进入时刻升序」：
同一老板账号**间隔 1.2 秒**下两单支付（保证两者落在**不同毫秒**，绕开并列 tie-break），结果

```
first  index: 23      second index: 24      pool public size: 25
exclusive contains first : false            exclusive contains second: false
DTO keys: deadlineAt,dispatchId,gameName,orderId,orderNo,paidAt,pool,poolLabel,productTitle,quantity,remainingSeconds,specName
OK：先进入公共池的那一单排在更上面（i < j）
```

—— 先进入的那单在更上面；两张单都不在专属池；DTO 仍是 12 个字段且**没有任何 `enter` 字样**的键
（排序键确实没有泄漏到接口）。

### 7.3 副作用（Mock 数据，不是泄漏）

HTTP 用例与探针每次运行都会在服务端留下**真实的 Mock 订单**（与 `tests/adminProducts.test.mjs` 同类行为），
因此公共池条数随每轮运行单调增长（本次从 19 涨到 26）。按
`PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES = 60`，这些单会在 60 分钟后自然超时退场；服务已终止，store 随之丢弃。

### 7.4 处理完只读审查的 MINOR 之后**重跑**的全部门禁（本轮最终状态）

审查提出 3 条 MINOR（见 §八），其中 2 条当场修掉、1 条按纪律不改；改动只落在
**测试文件与文档**上，业务代码一个字节未动。因此**重跑了全部五道门禁**：

| 门禁 | 结果 |
|---|---|
| `pnpm test`（不设 `APP_BASE_URL`） | `tests 1134 · pass 1013 · fail 0 · skipped 121`（+1 即新增的「唯一真值源」门禁） |
| `pnpm typecheck` | exit **0** |
| `pnpm lint` | exit **0** |
| `pnpm build` | exit **0**（`Compiled successfully` / 103 个静态页） |
| **HTTP 全量** `APP_BASE_URL=http://localhost:3211 pnpm test` | `tests 1134 · pass 1134 · fail 0 · skipped 0` ✅ |

`t.diagnostic` 实测：`公共池：下单前 25 条 → 读完 26 条；我这一单在第 25 位；参照单里最靠后的是第 24 位（共 25 条）`
—— 与 §7.2 的独立探针结论一致。

⚠️ 本轮 HTTP 全量**累计三次全绿**（两次在 MINOR 修复前、`1133/1133`；一次在修复后、`1134/1134`），
三次都是 `fail 0 / skipped 0`。修复前那条会「第二次才红」的用例已不复现。

---

## 八、Reviewer

**只读审查（`reviewer-agent`，未修改任何文件、未执行任何 Git 写操作）结论：**

```
BLOCKER=0  MAJOR=0  MINOR=3  NOTE=5
```

满足 batch §四 第 8 条（reviewer 最终 BLOCKER=0、MAJOR=0）。审查明确核过：
排序取键按 `record.state`（不是 `exclusiveCompanionId`）、旧 comparator 无残留调用点、
池子 DTO 与 `toDispatchProgress` 零改动、FIX-1 无任何认证副作用、
`(console)` 5 页结构上全覆盖、`lib/data/**` 与 `app/api/**` 零改动（未越界）、
批次 §十一 的架构硬约束全部未触碰（无第二套 Order / Refund / Notification / PlatformConfig / Auth，
原子区段无 `await`，`OrderStatus` 未动，`completion_review` / `settling` / `settled` 全仓零命中）、
文档同步与代码逐条一致、`01-prompt.md` 与 `cmd_p0-6.1.md` `cmp` 一致。

### 8.1 MINOR 的处理

| # | MINOR | 处理 |
|---|---|---|
| 1 | 未跟踪的乱码长版指令文件仍在 `rounds/` 下，而 §1.1 没列它（两处口径不一致） | **已按纪律处理**：不删用户放进来的文件，改为在 §1.1 显式列出并标注「不属于本轮产物、建议提交前删除」；乱码长版的内容已逐字归档为 `01-prompt-extended.md`（审查用 `iconv` + `diff` 验证完全相同），删除它不会丢信息 |
| 2 | `总需求进度表.md` 的 P0-6.1 行用了 `🟡`（图例里 `🟡 = PARTIAL`、`🟣 = AWAITING_ACCEPTANCE`） | **已修**：改为 `🟣 AWAITING_ACCEPTANCE`。英文码本来就对，emoji 与图例不符会让按 emoji 过滤 `PARTIAL` 的人误读 |
| 3 | 「客户端不得再排一次」只有人工核对，没有门禁 | **已修**：`tests/companionPoolOrder.test.mjs` 新增一条结构门禁（扫 `components/companion/**`、`app/companion/**`、`lib/services/companionHttp.ts`，断言 `.sort(` / `.toSorted(` 零命中，附今天为空的显式豁免清单）；**并实测它能红**（临时塞 `.sort()` → 变红；还原后文件 sha1 逐字相同） |

**另外自查出并修掉的一条**（审查未提，属本轮自己新写的文字）：
`总需求进度表.md` 的 FIX-2 行把 `lib/types/dispatch.ts:71` / `:80` 与两个字段名**对错了**
（实际是 `exclusiveEnteredAt` = `:71`、`publicPoolEnteredAt` = `:80`）。已按正确顺序改写。
该句是本轮新增的文字（`git show HEAD` 里没有），不是改写历史行的既有描述。

### 8.2 NOTE 的处理（不要求动作，记录在案）

- **NOTE-2（最重要的一条）**：11.1 / 11.4 **不是** deadline 回归守卫（改回 `deadlineAt`
  甚至完全不排序时它们仍通过），真正的守卫是 11.6 / 11.3 / 11.7。已写进 §六末的显式警告。
- **NOTE-3**：HTTP 用例在「服务端公共池此刻一单都没有」时会**如实 `t.skip`** 而不是伪装通过，
  那会体现为 `skipped 1`，正好能被本轮的 `skipped 0` 要求看见。三次全量实测均为 `skipped 0`。
- **NOTE-4**：`CLAUDE.md` 的事实表仍写「Tests | 51 files, 1011 cases」，而 `tests/` 下现有
  59 个 `*.test.mjs`（本轮 +2）。**该漂移早于本轮**（P0-6 / DEV-1 期间就已产生），
  且提交允许清单（§十三）里没有 `CLAUDE.md`，因此**本轮不动它**，登记为批次遗留，
  由用户在批次收尾时一并更正。
- **NOTE-1 / NOTE-5（布局观感、门禁是否真的全绿）**：前者本来就是组件行为的既定人工验收范围
  （`04-acceptance.md` A 组）；后者已由 §七 的**实测数字**补上（审查自身受只读约束无法跑门禁，
  因此把这一条标成「需要 Coordinator 补证据」——证据已在 §七/§7.4 落盘）。

---

## 九、Git

**本轮 Claude 未执行任何 Git 写操作。** 未执行 `git add` / `git commit` / `git push` /
`git reset` / `git restore` / `git checkout` / `git rebase` / `git amend`。
所有 Git 写操作由**用户本人**执行。

`Git Commit` 一列**留空是正确状态**——在用户提交之前，本轮必须停在 `AWAITING_ACCEPTANCE`。
