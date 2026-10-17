# 批次最终报告 — `cmd_batch_p0-6.1_to_p0-9.md`

Batch: `docs/03-dev/rounds/cmd_batch_p0-6.1_to_p0-9.md`（P0-6.1 → P0-7 → P0-8 → P0-9）
Report Time: 2026-09-24
Report Author: Claude Code（AI）
**报告性质：批次「验收收口」** —— **四轮全部交付、统一人工验收已于 2026-09-24 全部通过**，
且**用户本人随后已完成 Git 提交（`eef4e62`）**：按「DONE 双门槛」两个条件均已满足，
四轮**已由 `AWAITING_ACCEPTANCE` 收口为 `DONE`**（**纯文档收口，2026-09-24**）。
详见 **§G 人工验收结果**。

---

## 摘要（先读这一节）

| 事实 | 值 |
|---|---|
| 交付了代码的轮次 | **4 轮**（P0-6.1 / P0-7 / P0-8 / P0-9），全部自动门禁绿 + reviewer 终局 `BLOCKER=0 / MAJOR=0` |
| 没有交付代码的轮次 | **0 轮**。P0-9 曾因 `Q1`（投诉窗口默认值未定义）**真停止在 `CLARIFYING`**，产品裁定后已于 2026-09-24 继续开发并交付；`CLARIFYING` 那一版是**中间状态**，不是本轮结论 |
| 领域链跑到哪 | `paid → accepted → serving → completed → Earning.frozen → Earning.available` **已真实跑通**；`settling` / `settled` 仍是**派生展示阶段**（`Earning.frozen` / `available`），**不进 `OrderStatus`** |
| 人工验收 | ✅ **2026-09-24 全部通过**（P0-6.1 / P0-7 / P0-8 / P0-9 四轮 `User Result` / `Final Result` = **`PASSED`**，`Issues Found` 无，见 §G） |
| 用户还需要做的事 | ✅ **没有了**。用户本人已于 2026-09-24 完成 Git 提交 **`eef4e62`**，四轮已由 `AWAITING_ACCEPTANCE` 收口为 **`DONE`** |
| Git | AI **零写操作**（批次期间未执行任何 Git 写命令）。**报告时点** HEAD = `249f7c1`；**用户本人的提交 `eef4e62` 随后到达**，当前 HEAD = `eef4e62`，四轮改动全部进入版本库 |

---

## A. 四轮状态表

### A.1 各轮交付时点的终轮读数

| Round | Status | Requirement Check | Test（离线 `pnpm test`） | HTTP（生产 `APP_BASE_URL` 全量） | typecheck | lint | build | Reviewer BLOCKER / MAJOR |
|---|---|---|---|---|---|---|---|---|
| **P0-6.1** | 🟣 `AWAITING_ACCEPTANCE` | 无 `OPEN`（D1–D8） | `1134 / pass 1013 / fail 0 / skipped 121` | `1134 / 1134 / fail 0 / **skipped 0**` | 0 | 0 | 0 | **0 / 0**（MINOR 已处置，NOTE 记录在案） |
| **P0-7** | 🟣 `AWAITING_ACCEPTANCE` | 无 `OPEN`（D1–D8） | `1154 / pass 1030 / fail 0 / skipped 124` | `1154 / 1154 / fail 0 / **skipped 0**` | 0 | 0 | 0 | 首轮 **0 / 1** → 修复 → 只读复核 **0 / 0**（复核轮另抓 2 条 MINOR，已修） |
| **P0-8** | 🟣 `AWAITING_ACCEPTANCE` | 无 `OPEN`（D1–D13） | `1222 / pass 1094 / fail 0 / skipped 128` | `1222 / 1222 / fail 0 / **skipped 0**` | 0 | 0 | 0 | 首轮 **0 / 2** → 修复 → 只读复核 **0 / 0**（2 条 MINOR 已处置） |
| **P0-9** | 🟣 `AWAITING_ACCEPTANCE` | 通过（D1–D15 + 产品裁定 D16–D24；`Q1` 已 `RESOLVED`） | `1255 / pass 1123 / fail 0 / skipped 132` | `1255 / 1255 / fail 0 / **skipped 0**` | 0 | 0 | 0 | 首轮 **0 / 2** → 修复 → 只读复核 **0 / 0**（3 条 MINOR 已处置，见 §B.4） |

> 📌 **`Status` 列是「交付时点」的读数**，留档不改。四轮在收到**用户本人**的提交 **`eef4e62`** 后，
> 已于 2026-09-24 全部由 `AWAITING_ACCEPTANCE` 收口为 `DONE`——见 **§G.1**。

### A.2 合并终态复跑（2026-09-24，P0-9 **reviewer 修复后**，**当前工作区**）

| 门禁 | 读数 | 退出码 |
|---|---|---|
| `pnpm test`（离线） | `tests 1255 · pass 1123 · fail **0** · cancelled 0 · skipped 132 · todo 0` | 0 |
| `APP_BASE_URL=http://127.0.0.1:3100 pnpm test`（**生产构建 + 真实 HTTP**） | `tests 1255 · pass **1255** · fail **0** · **skipped 0** | 0 |
| `pnpm typecheck`（`next typegen && tsc --noEmit`） | `Types generated successfully`，无输出 | 0 |
| `pnpm lint`（ESLint CLI） | 无输出（0 error / 0 warning） | 0 |
| `pnpm build`（Turbopack） | 构建完成，路由表打印完整（新增的 `api/companion/earnings` 与 `companion/(console)/earnings` 都出现在表里） | 0 |

⚠️ 生产服务器跑在**端口 3100**（不是 3000——3000 上是用户自己的 `pnpm dev`，PID 31540，**未触碰**）。
测完已按 PID 终止并**复核端口已释放**（`netstat` 无 LISTENING），无残留进程。
⚠️ 132 条 `APP_BASE_URL` 门控用例在离线模式下 `skipped`、在生产模式下 `pass`——**两套读数都要看**：
只看离线读数会漏掉全部 HTTP 契约（含 P0-9 新增的 `GET /api/companion/earnings`）。
（这 132 条比 P0-8 时点多 4 条：P0-9 新增的 `tests/earningsHttp.test.mjs`。）

---

## B. 每轮实际交付

### B.1 P0-6.1 — 验收后整改（**不是新功能**）

| 项 | 内容 |
|---|---|
| 来源 | P0-6 / DEV-1 人工验收期间登记的**两个整改项**；**不推翻** P0-6 / DEV-1 的 `DONE` |
| **FIX-1** | 打手工作台加「返回用户端」入口。落点 `components/companion/CompanionHeader.tsx`（`(console)` 路由组共用的**唯一**顶栏 → 结构上覆盖 `pool` / `exclusive` / `orders` / `orders/[id]` 与概览页），目标固定 `/`。**纯导航**：不 logout、不清 Cookie、不切身份、不新建第二套 Auth、不动护航资格 |
| **FIX-2** | 订单池排序改为「**等待最久优先**」。`compareByDeadline` **已删除**，替换为 `compareByWaitingSince`：取**当前池**的进入时刻（专属池 `exclusiveEnteredAt` / 公共池 `publicPoolEnteredAt`）ASC，并列按 `dispatchId` ASC。取键按 `record.state` 而非 `exclusiveCompanionId`；排序键**不进 DTO**（契约零改动）；服务端是唯一排序真值源 |
| 新增文件 | `tests/companionConsoleNav.test.mjs`（FIX-1）· `tests/companionPoolOrder.test.mjs`（FIX-2） |
| 明确不动 | 任何订单 / 派单**状态迁移**、封禁回池、客服换人、退款、取消逻辑、超时业务规则 |

### B.2 P0-7 — `accepted → serving`（打手点「开始服务」）

| 项 | 内容 |
|---|---|
| 需求依据 | **BF-17**：只有当前 `actualCompanionId` 能点；**显式禁止**按时间 / 预约备注 / 打开页面 / 聊天自动开始，且不允许客服代打 |
| 接口 | `POST /api/companion/orders/[id]/start`（`api-contract.md` §3.1 早已冻结为 TARGET，本轮**照抄落地**，同步 manifest 门禁 5 → 6 条路由） |
| 新增文件 | `app/api/companion/orders/[id]/start/route.ts` · `components/companion/CompanionOrderStartPanel.tsx` · `tests/companionServing.test.mjs` |
| 改动文件 | `lib/data/companionOrderTransaction.ts`（伪事务 `startCompanionOrder`，与取消**同文件、同一份原子性依据**）· `lib/services/companionOrders.ts` · `lib/services/companionHttp.ts` · `lib/types/order.ts`（新增 `canStart` 进列表项、`servingAt` **只进详情**）· `app/companion/(console)/orders/[id]/page.tsx` |
| 幂等 | **不用幂等键**：「已经是 `serving` 且归本人」即重放，`servingAt` **不刷新**。因此这个接口**没有请求体** |
| 通知 | **不新增产品通知**（需求未为「开始服务」冻结通知） |
| 交付时点被改写的断言 | `tests/companionOrders.test.mjs` 里 P0-6 的两条断言被改成**更精确**的形式（不是放宽；前后对照见该轮 `03-delivery.md`） |

### B.3 P0-8 — 完成材料提交 + 客服审核 + 到期自动通过（`serving → completed` 的**唯一**入口）

| 项 | 内容 |
|---|---|
| 需求依据 | **BF-19 / BF-19A** + **EX-COMPLETE-01..05 / EX-CONFIG-06** |
| 主迁移 | `serving → completed`，由完成材料的通过**唯一**驱动 |
| 副状态机 | `CompletionSubmission: pending → approved / rejected`（`invalidated` **只保留类型、零写入路径**） |
| 接口（5 个） | `POST /api/companion/orders/[id]/completion` · `GET /api/staff/completions` · `GET /api/staff/completions/[id]` · `POST .../approve` · `POST .../reject`（§3.2 早已冻结为 TARGET，照抄落地） |
| 新增文件（24 个 / 4865 行） | 3 个新 API 目录（6 个 `route.ts`）· `app/staff/(console)/completions/(list)/{page,loading}.tsx` · `.../[id]/{page,not-found}.tsx` · `components/staff/StaffCompletionConsole.tsx` · `components/staff/StaffCompletionTable.tsx` · `components/companion/CompanionCompletionPanel.tsx` · `lib/types/completion.ts` · `lib/constants/completions.ts` · `lib/constants/staffCompletions.ts` · `lib/data/{completionRepository,completionTransaction,mockCompletionRepository}.ts` · `lib/services/{companionCompletions,staffCompletions,staffCompletionsHttp}.ts` · 3 个测试文件 |
| 幂等 | **不用幂等键**：判据是**状态本身**（`completedAt` / `reviewedAt` 都是 `xxx ?? at`，**重放不刷新**）；审核人三个字段直接写在 submission 上，那就是审计踪迹 |
| 到期自动通过 | `sweepCompletionAutoApprovals(at)`：**同步**函数挂在**读取路径**上做惰性物化（与 `sweepExpiredDispatches` 同形）。真实 Scheduler 上线后复用**同一个**函数，本轮不接后台任务基础设施。挂载点 4 处 × 列表+详情 = 8 处 |
| `OrderStatus` | **不扩展**：派生展示阶段 `completion_review` 只在 DTO / 展示层拼出，**不进枚举**（结构门禁 19 钉住） |
| reviewer 首轮 | 2 条 MAJOR（自动审核清扫**漏挂打手端读路径**；`approveCompletion` **未走中央状态机**）+ 2 条 MINOR，**已全修**；并补**结构门禁 22 / 23** 钉死 |
| reviewer 复核 | **0 / 0**；另处置 2 条 MINOR（门禁 23 挡不住「调用被挪到读取之后」→ 补**行为用例** + 受控 mutation 复核；门禁失败信息会指错方向 → 改写） |
| 已标注**待产品确认**（不阻塞验收） | ① 阻塞自动通过的「投诉」口径取**未完结**（`pending` / `processing`）才算，已 `resolved` / `closed` 不算（D4）；② 自动审核时长沿用平台时长的 `1~1440` 分钟上下限、**未发明新数字**（D5） |

### B.4 P0-9 — Earning.frozen + 可配置投诉窗口 + `frozen → available`

| 项 | 内容 |
|---|---|
| 需求依据 | `cmd_p0-9.md` §二~§十一 + **EX-CONFIG-06**（配置变更不追溯） |
| 产品裁定 | **`Q1`（曾 `OPEN`，现 `RESOLVED`）**：投诉窗口默认 **24 小时**、单位**分钟**、默认 **1440**、范围 **60~10080**（7 天）。记录于 `P0-9/02-decisions.md` §八 **D16~D18**，并已同步进 `01-requirements` / `02-tech-design` 五份权威文档 |
| 主迁移 | **`Earning.frozen → Earning.available`**（`Earning` 是**独立领域**，**不进 `OrderStatus`**——`OrderStatus` 仍然恰好五个取值） |
| 核心不变量 | `completed` + `complaintWindowMinutesSnapshot` + `complaintDeadlineAt` + `Earning.frozen` **由同一个写入器一次写成**：`settleOrderCompletion()` 是唯一把订单变成 `completed` 的路径，客服 approve 与 System 到期自动通过**共用**它。因此不存在「订单完成了但收益没冻结」的半写状态 |
| 收益金额 | **不重算**：直接取订单已冻结的 `Order.companionBaseIncome`。`availableAt` 直接**复制**订单的 `complaintDeadlineAt`，不重新做一次加法 |
| 幂等 | **不用幂等键**：判据是**状态本身**（`settleOrderCompletion` 见 `status === "completed"` 即早返回；`frozenAt` / `availableAt` 写成 `xxx ?? at`，**重放不刷新**）。`earningIdByOrder` 是第二道防线 |
| 阻塞判定 | `sweepMaturedEarnings` 与 P0-8 的 `sweepCompletionAutoApprovals` **共用** `isCompletionAutoApprovalBlocked()` + `readOrderBlockingFacts()`（`lib/data/orderBlocking.ts`）——口径只有一处 |
| 不追溯 | P0-9 之前就 `completed` 的历史订单**不回填**（`complaintDeadlineAt = null`）。理由有两条且互相独立：① 回填等于让新配置追溯历史；② 用一条早已过去的 `completedAt` 倒推 deadline，会在今天立刻凭空生成可提现余额 |
| 新增文件（11 个 / 1950 行） | `lib/types/earning.ts`(157) · `lib/constants/earnings.ts`(109) · `lib/data/earningRepository.ts`(44) · `lib/data/mockEarningRepository.ts`(124) · `lib/data/earningTransaction.ts`(194) · `lib/data/orderBlocking.ts`(57) · `lib/services/companionEarnings.ts`(125) · `app/api/companion/earnings/route.ts`(29) · `app/companion/(console)/earnings/page.tsx`(96) · `components/companion/CompanionEarningList.tsx`(102) · `tests/earning.test.mjs`(913) |
| 改动文件（18 个，均标 P0-9 区段） | 见本轮 `03-delivery.md` §三（每个文件都注明「哪一段是本轮的」与「哪些来自前序 Round」） |
| 接口 | `GET /api/companion/earnings`（**只导出 `GET`**）——打手收益列表 + 汇总（冻结 / 可提现），`requireCompanion` 守卫 |
| reviewer | 见本轮 `03-delivery.md` §七（终局 `BLOCKER / MAJOR` 读数） |

### B.5 工作区累计 delta（`development-workflow.md` §六）

```
tracked 改动：46 files changed, 2247 insertions(+), 281 deletions(-)
untracked   ：46 条（git status 默认折叠模式）/ 69 个文件（-uall 展开模式）
```

| 分组 | 本轮自己的 delta（**按档案逐文件列出**，不按总 diff 摊派） |
|---|---|
| P0-6.1 | 新增 2 个测试文件（`companionConsoleNav` / `companionPoolOrder`）+ `CompanionHeader` / `companionDispatch` 的 FIX-1 / FIX-2 区段 |
| P0-7 | 新增 `start/route.ts` · `CompanionOrderStartPanel.tsx` · `companionServing.test.mjs` + 5 个改动文件 |
| P0-8 | 新增 24 个文件 / 4865 行 + 18 个改动文件 |
| **P0-9** | **新增 11 个文件 / 1950 行**（`P0-9/03-delivery.md` §二）+ **18 个共享文件的 P0-9 区段**（同文件 §三，逐文件写明「本轮改了哪一段」与「哪些属于前序 Round」） |
| 合计 | 46 tracked（2247 / 281）+ 69 untracked |

⚠️ **诚实标注**：批次 §十二 禁止一切 Git 写操作，四轮**都没有提交**，
所以**任何**「逐轮行数归属」都不可能是 Git 证据——包括本表。
本表因此**不使用摊派出来的行数**，而是逐轮引用该轮 `03-delivery.md` 里**具名的文件清单**：
新增文件按行数、修改文件按**区段**（一个共享文件可以同时属于四轮，行数不可加）。
**这不是把最终总 diff 冒充成本轮 delta**：P0-9 的 delta 有自己的名单与行数，总 diff 只作旁证。

⚠️ **更正一处旧计数**：P0-8 那份报告写的「untracked = 56 项」**没有声明计数模式**，
和现在的读数不可比（默认折叠 46 条 / `-uall` 展开 69 个文件是同一批文件）。
本报告改用**名单法**（上一列），不再给一个没有口径的单一数字。

---

## C. 最终领域链

```
paid → accepted → serving → completion_review → completed → settling → settled
```

| 环节 | 真实状态 | 依据 |
|---|---|---|
| `paid → accepted` | ✅ **跑通**（P0-5 已有；P0-6 加了 `accepted → paid` 取消回池） | `ORDER_TRANSITIONS` + 领域 Guard |
| `accepted → serving` | ✅ **跑通**（P0-7） | `POST /api/companion/orders/[id]/start` |
| `serving → completion_review` | ✅ **跑通，但它是「派生展示阶段」** | 订单**仍然是** `serving`；「审核中」由 `CompletionSubmission.status === "pending"` + 客服完成审核台表达。**它不是、也永远不会是 `OrderStatus` 的取值**（结构门禁 19：全仓代码里 `completion_review` 不得出现在状态定义中） |
| `completion_review → completed` | ✅ **跑通**（P0-8 的两条路径：客服 approve / System 到期自动 approve） | `CompletionSubmission` 通过是 `serving → completed` 的**唯一**入口 |
| `completed → settling → settled` | ✅ **跑通**（P0-9：`Earning.frozen → Earning.available`） | 订单进入 `completed` 的同一次写入生成 `Earning.frozen`（`settleOrderCompletion()`，唯一入口）；`complaintDeadlineAt`（= `completedAt` + 本单冻结的 `complaintWindowMinutesSnapshot`）到期且**无阻塞**时，`sweepMaturedEarnings(at)` 把它变成 `available`。⚠️ 它是**派生展示阶段**，**不是 `OrderStatus`**——`Earning` 是独立领域，`OrderStatus` 仍然恰好五个取值 |

**明确声明（批次 §十三 要求）**：
- `completion_review` / `settling` / `settled` **都是派生展示阶段，不是 `OrderStatus`**；
- 三者**均已按此实现**：`completion_review` 由 `CompletionSubmission.status === "pending"` 表达（P0-8）；
  `settling` / `settled` 由 `Earning.status === "frozen" / "available"` 表达（P0-9）。
  `OrderStatus` 自始至终**恰好五个取值**（结构门禁 19 钉住），四轮**没有**扩展过它。

---

## D. 统一人工验收清单（一套端到端流程，覆盖四轮）

### D.0 三个身份与三个会话（先理解这个，能省一半时间）

| 身份 | 怎么切 | 会话 |
|---|---|---|
| 用户端 / 打手端 | **同一个 Session**。用户端右下角、底部 TabBar 之上的 `Mock 身份（开发工具）` 按钮 → 点账号名 | Cookie A |
| 客服 | `/staff/login` → 选「客服小雨（占位）」（`kefu-xiaoyu`） | Cookie B（独立） |
| 管理端 | `/admin/login` → 管理账号 | Cookie C（独立） |

**最小切换方案：开 2 个标签页**（Tab1 = 用户/打手会话，Tab2 = 客服会话）。
管理端（Tab3）在 **§D.4（可选）** 与 **§D.7A 第一步（P0-9 必做）** 需要——
§D.4 可以整节跳过，但 **§D.7A 的第一步跳不过去**（那三条是 P0-9 的配置门禁）。

**前置**：`pnpm dev`（`.env.local` 需 `ENABLE_MOCK_AUTH=true`），浏览器设成手机模拟器宽度。

---

### D.1 基础门禁（先做，5 分钟）

| # | 操作 | 预期 |
|---|---|---|
| 1 | `pnpm test` | `tests 1255 · pass 1123 · fail 0 · skipped 132` |
| 2 | `pnpm build`，然后 `pnpm exec next start -p 3100`，再 `APP_BASE_URL=http://127.0.0.1:3100 pnpm test` | `1255 / 1255 / fail 0 / **skipped 0**` |
| 3 | `pnpm typecheck` | 退出码 0 |
| 4 | `pnpm lint` | 退出码 0 |

> 这四条的读数我在 2026-09-24 已经复跑过（见 §A.2，生产端口 3100，**不是 3000**——3000 上是你的 `pnpm dev`），
> 四项全绿；你可以直接采信，也可以自己再跑一遍。
> ⚠️ 第 2 条里 `next start` **必须另起端口**，否则会撞上你自己在 3000 上的 dev server。
> **`pnpm start -- -p 3100` 这种写法在本仓库不可用**：`pnpm` 会把 `--` 原样透传，
> 于是 `-p` 被当成项目目录，报 `Invalid project directory provided, no such directory: …\-p`。
> 可用写法是 `pnpm exec next start -p 3100`（或先 `pnpm build` 再 `pnpm exec next start -p 3100`）。

---

### D.2 打手侧：接单 → 开始服务 → 提交完成材料（P0-7 + P0-8 + FIX-1/FIX-2）

在 **Tab1**。

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 5 | 右下角 Mock 身份面板 → 点「**夜航（占位）**」（`u-1022`） | 标签显示「有效打手」；当前身份那一行有蓝色描边 | DEV-1 |
| 6 | 访问 `/companion` | **放行**进入工作台 | P0-4 |
| 7 | 顶栏确认有「**← 返回**」，点它 | 回到用户端 `/` | **FIX-1** |
| 8 | 回 `/companion/pool` | 至少有 1 单可接；**从上到下 = 在当前池等待最久 → 最新**（顶部那单最老） | **FIX-2** |
| 9 | 接一单 → 进 `/companion/orders/[id]` | 状态「已接单」，有「开始服务」按钮 | P0-7 |
| 10 | 点「**开始服务**」 | 状态变「护航中」，出现开始服务时间；**按钮消失**（`canStart` 由服务端算）；刷新后时间**不变** | P0-7 D2 |
| 11 | 在详情页找「提交完成材料」 | 有说明输入框 + 凭证入口 | P0-8 |
| 12 | 先试**空内容**、再试 **4 个字**、再试 **51 个字** | 三种都**报错**（边界 5~50 字） | P0-8 |
| 13 | 填合法说明（如 `已完成护航服务`）→ 提交 | 成功；订单**仍是**「护航中」，展示为「**审核中**」；列表卡片也显示该阶段 | P0-8 |
| 14 | 再试着提交一次 | **不能**再提交（同一订单最多一个 pending） | P0-8 |
| 15 | 按 F5 刷新详情 | 状态与「审核中」**保持一致**（不因刷新而变回/错乱） | P0-8 |

---

### D.3 客服侧：人工驳回 → 打手重新提交（P0-8）

在 **Tab2**（`/staff/login` → 客服小雨）。

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 16 | 进 `/staff/completions` | 看到刚才那条 **pending**，打手名与订单号可对上 | P0-8 |
| 17 | 打开详情 → 点「**驳回**」，填理由 → 提交 | submission 变 `rejected`；**订单仍是「护航中」** | P0-8 |
| 18 | 回 **Tab1** 打手刷新该单 | **可以重新提交**（且计时重新开始） | P0-8 |
| 19 | 重新提交一次 | 再次进入「审核中」 | P0-8 |

---

### D.4 【可选】自动通过 —— 想省 10 分钟就做这节，否则跳到 D.5

需要 **Tab3**（`/admin/login` → `/admin/platform-config`）。**整节可以跳过**，
跳过时 D.5 的「客服通过」就是唯一的完成路径。

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 20 | `/admin/platform-config` → 把「**完成材料自动审核时长**」改成 **1** 分钟 → 保存 | 保存成功；管理审计里多一条记录 | P0-1 / P0-8 §十 |
| 21 | 试填 **0**、再试 **1441** | 两种都**被拒绝**（1~1440 分钟） | P0-8 D5 |
| 22 | 回 **Tab1**，等约 **70 秒**，期间**什么都不要点**，然后**只刷新打手订单详情** | 状态变「**已完成**」 | P0-8 **惰性物化** |
| 23 | 回 Tab3 把自动审核时长**改回 10** | 保存成功 | —— |
| 24 | 说明这一条在验什么 | 自动通过**不是定时器**触发的：「deadline 到点就已经成立」，读路径只是恰好把它写下来。所以**不需要任何人停留在页面上**，也不存在「后台任务没跑起来」这种失败模式 | P0-8 D7 |

---

### D.5 客服通过 → 订单完成（P0-8 主路径）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 25 | 若**没做** D.4：Tab2 打开那条 pending → 点「**通过**」 | submission 变 `approved`；订单变「**已完成**」 | P0-8 |
| 26 | Tab1 打手刷新该单 | 状态「已完成」，完成时间有值 | P0-8 |
| 27 | Tab1 切回「**老板A（占位）**」（`u-1001`）→ 我的订单里找到该单（若该单归属别人，就换用下单人的身份） | 订单详情时间轴出现「已完成」节点 | P0-5 / P0-8 |

---

### D.6 取消 → 回公共池 + 排序（P0-6 / P0-6.1 FIX-2）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 28 | Tab1 切回「夜航」→ 再接一单 → **在点「开始服务」之前**点「取消接单」 | 必须**填原因**，空原因应报错 | P0-6 |
| 29 | 填原因 → 确认 | 取消成功，订单离开自己的列表 | P0-6 |
| 30 | `/companion/pool` 刷新 | 该单**重新出现在池里**，且**排在靠后 / 底部**——它刚刚才重新进池，是「最新进入当前池」的那一单（`publicPoolEnteredAt` 取**本次**回池时刻，不是最初下单时刻，所以排的是**等待最久优先**，它理应最后） | **FIX-2** |
| 31 | Tab1 切回「老板A」→ 用户端该单 | 回到「待接单」一档，且能看到**取消原因** | P0-6 D6 |

> 📌 **本表第 30 行已于 2026-09-24 更正。** 初版把它写成「排在**最上面**」，那是**错的**：
> 正式排序是 `publicPoolEnteredAt` / `exclusiveEnteredAt` **ASC**（= 等待最久优先，顶部最老、底部最新），
> 而刚被取消回池的订单拿的是**本次**回池时刻，所以它是「最新进入当前池」的一单，**应该排在靠后 / 底部**。
> 更正时已核对代码与测试：`lib/services/companionDispatch.ts:254` 的 `compareByWaitingSince`
> 确实是 `waitingSince` **升序**（并列按 `dispatchId` 升序），
> `tests/companionPoolOrder.test.mjs:11.3` 也断言 `[b, c, a]`——**刚回池的 A 在最后**。
> **实现与测试本来就是对的，错的只是本报告的验收文案**，因此只改文档，未动任何代码。

---

### D.7 边界抽查（挑 2~3 条即可）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 32 | 用**另一位打手**（栖迟 `u-1023`）的身份，手工访问夜航那张单的详情 URL | **404**（归属是真正的安全边界，不靠列表隐藏） | P0-6/7 |
| 33 | 打手端订单详情 | **不出现**平台净利润、分账比例、用户联系方式 | DTO 隐私 |
| 34 | 用户端订单详情 | ⚠️ **当前仍可见 `companionRateBp`**（已登记的上线前技术债，见 §E.2） | 已知 |
| 35 | `/staff/completions` 里点开一条 **rejected** 的记录 | 能看到驳回理由与审核人（审计踪迹） | P0-8 D3 |

---

### D.7A P0-9：投诉窗口配置 + 我的收益 + 冻结收益释放

> 🕐 **先读这条，否则会白等**：投诉窗口的**最小值是 60 分钟**（产品裁定 D17），
> 所以「等它自己到期解冻」在人工验收里**不可能在合理时间内观察到**。
> 因此本节的验法是：**冻结状态 + 到期时间用眼睛看**，**释放动作由自动化测试覆盖**
> （`tests/earning.test.mjs` 用**注入的未来 `at`** 直接调 `sweepMaturedEarnings(at)`）。
> 这不是「没验」，而是把「等 24 小时」换成了「把时钟拨到 24 小时后」。
> 验收时**不要**试图改小窗口来加速——最小就是 60，改了也快不了。

#### 第一步：后台配置（Tab3：`/admin/login` → `/admin/platform-config`）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 36 | 看「**投诉窗口**」输入框 | **已经存在**，且**默认值显示 1440**（分钟 = 24 小时） | P0-9 §十 |
| 37 | 试填 **59** → 保存 | **被拒绝**（提示范围 60~10080） | D17 |
| 38 | 试填 **10081** → 保存 | **被拒绝** | D17 |
| 39 | 试填 **10080** → 保存 | 保存成功（上界**含**） | D17 |
| 40 | 管理审计里看这一条 | 审计快照里有 `complaintWindowMinutes` 的值 | P0-9 §十 |
| 41 | 改回 **1440** 并保存 | 成功 | —— |

#### 第二步：确认「历史订单不被追溯」（最容易被做错的一条）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 42 | 用 §D.5 已经完成的**那张订单**（它在 P0-9 之前/或之前就完成），在**不重启 dev server** 的前提下看它的完成时间与投诉入口 | 该单**没有** `complaintDeadlineAt`（历史 completed 订单**不回填**） | D19 |
| 43 | 上面第 39 步把窗口改成 **10080** 之后，重新打开那张**已完成**订单 | 它的行为**没有任何变化**（不因为改了配置就突然多出一个投诉窗口） | **EX-CONFIG-06** |

#### 第三步：走一遍「完成 → 冻结」（Tab1 打手 / Tab2 客服，复用 §D.2–D.5 的链路）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 44 | 用 §D.5 的方式**再完成一单**（打手提交 → 客服通过） | 订单「已完成」 | P0-8 |
| 45 | 切回打手 → `/companion` 顶栏导航应出现「**我的收益**」→ 点进去 | 页面打开，**不报 403** | P0-9 §九 |
| 46 | 看这一单的收益记录 | 有一条**冻结**记录，金额 = 该单的分账基数；**看不到**平台净利润 / 分账比例 / 对方联系方式 | DTO 隐私 |
| 47 | 记录页面上显示的「**预计可提现时间**」 | **有具体值**，且约等于「完成时间 + 1440 分钟」 | D18 |
| 48 | **对第 44 步那单发起一条投诉**（用户端 → 客服 → 投诉，走 §D.5 那单的下单人身份） | 投诉**提交成功**（窗口开放中）——这就是「窗口内允许普通投诉」 | P0-9 §六 |
| 49 | 回「我的收益」刷新 | 该笔**仍然是冻结**（有未完结投诉时不得释放） | P0-9 §七 |

#### 第四步：确认收益接口的权限边界（改 URL 试，不是点页面）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 50 | 用**普通用户**（`u-1001`，已登录但不是护航）的会话直接访问 `/api/companion/earnings` | **403** | 权限守卫 |
| 51 | 开一个**无 Cookie 的隐身窗口**访问同一 URL | **401** | 权限守卫 |
| 51b | 用**只带客服 Cookie** 的会话访问同一 URL | **401**（**不是 403**） | 权限守卫 |
| 52 | 用 `PATCH` / `POST` 请求同一 URL | **405**（该路由**只导出 `GET`**） | 只读契约 |

> 📌 **第 51b 条于 2026-09-24 更正（reviewer `m2`）。** 初版把「客服会话」写成预期 **403**，**那是错的**：
> 客服是**另一套 Cookie**（`mock_staff_id`），而打手复用**用户**会话（`mock_user_id`）——
> 所以「只带客服 Cookie」在这个接口上就是**未登录**，正确答案是 **401**。
> 已用真实服务实测确认（`curl` 一次 401、一次 403 对照），并新增
> `tests/earningsHttp.test.mjs` 第 2 条把这个区别钉成**自动化**断言，
> 免得下一次再有人按 403 去判「验收失败」。

#### 第五步：释放（**不用等**，看测试）

| # | 操作 | 预期 | 覆盖 |
|---|---|---|---|
| 53 | `node --test tests/earning.test.mjs` | 全绿。其中覆盖：窗口未到期**不**释放、无阻塞到期**释放**、`availableAt` **不重复刷新**、有投诉**继续冻结**、阻塞解除后**下次 sweep 释放**、重复 sweep **幂等** | P0-9 §七 |

> 💡 第 53 条就是「第四步里我不能等 24 小时」的补偿：测试把 `at` 直接注入到 deadline 之后，
> 走的是**和线上完全同一个** `sweepMaturedEarnings()`。

---

### D.8 本轮**不验**的东西（避免白找）

- ❌ **提现 / 钱包完整账本 / 人工余额调整 / 会费批扣 / 部分退款冲正 / 已提现退款追偿** —— 批次 §十一 与 P0-9 §十三 明确排除；
- ❌ **真 Scheduler** —— 所有「到点自动」仍是**读路径上的惰性物化**（`sweepExpiredDispatches` / `sweepCompletionAutoApprovals` / `sweepMaturedEarnings`），上线前是 production blocker；
- ❌ **封禁回池 / 客服换人 / 特殊过期申诉** —— 未实现；
- ❌ **`Earning.withdrawn` / `reversed` 的任何界面** —— 只有类型，**零写入路径**（P0-9 明确不做）；
- ❌ **历史 completed 订单的收益回填** —— **刻意不做**（见第 42 条与 D19）。

---

## E. 遗留

### E.1 尚未实现 —— **没有需要你现在做决定的问题了（`Q1` 已裁定）**

#### E.1.1 `Q1` —— **已 `RESOLVED`**（保留提问原文作为历史）

> **`Q1`（曾 `Status: OPEN`，现 `Status: RESOLVED`，`docs/03-dev/rounds/P0-9/02-decisions.md`）**
> **投诉窗口的 Mock 默认值取多少？单位是什么？上下限是多少？**
>
> **产品裁定（2026-09-24，记为 D16~D18）**：默认 **24 小时** / 单位 **分钟** / 默认 **1440** /
> 范围 **60~10080**（7 天）；订单进入 `completed` 时冻结 `complaintWindowMinutesSnapshot`，
> `complaintDeadlineAt = completedAt + snapshot`，**后续改配置不追溯历史订单**，新完成订单用新值。
>
> **为什么当初必须问**：它决定用户的**售后权利窗口长度**，也决定打手的**冻结收益多久可提现**；
> 它会**冻结进每一张 completed 订单**（快照不追溯，改起来要动数据）。
> 需求文档里「48 小时」的每一次出现说的都是「**不要再硬编码它**」，**没有一处说默认值就是 48 小时**；
> 而同类的另一个参数（完成材料自动审核时长）在需求里**明确写了「默认 10 分钟」**——
> 投诉窗口这一项**恰恰没有这一行**，所以也不能靠模仿推导。
>
> **已同步**：该裁定已写入 `P0-9/02-decisions.md` §八，并同步进
> `01-requirements`（业务流程表 / 特殊情况与异常处理表）与 `02-tech-design`
> （architecture-rules §5.3 / api-contract §3.7 / database-schema PlatformConfig 与 T2·T3.1 / directory-structure §D·§E）五份权威文档。

#### E.1.2 其它尚未实现（不需要现在决定）

| 能力 | 状态 | 说明 |
|---|---|---|
| `Earning` 领域 + 「我的收益」 | ✅ **已实现（P0-9）** | `/companion/earnings` + `GET /api/companion/earnings`（只读） |
| 可配置投诉窗口 + `complaintDeadlineAt` | ✅ **已实现（P0-9）** | 后台第三个参数；订单完成时冻结快照与 deadline |
| `Earning.frozen → available` 释放 | ✅ **已实现（P0-9）** | `sweepMaturedEarnings(at)`，同步 + 幂等 + 复用 P0-8 的阻塞判定 |
| 提现 / 钱包账本 / 人工余额调整 / 会费批扣 / 部分退款冲正 / 已提现退款追偿 | ❌ | 批次 §十一 / P0-9 §十三 明确排除 |
| 封禁回池（`serving → paid` 的入口） | ❌ **结构表里有这条边，但零调用** | 见 `E.2` 的 D14 |
| 客服换人 / 重新派单 | ❌ | 需求已冻结，尚无实现 |
| 未开始服务直接退款（`paid` / `accepted` 用户自助全额退款） | 🟠 `NEEDS_FIX` | 需求已定，实现未做 |
| 特殊过期申诉 | ❌ | 需求自己标为后续 TBD（P0-9 明确不做） |
| 真 Scheduler | ❌ | **生产阻塞项**（见 E.3） |

### E.2 MINOR / NOTE（已知，不阻塞验收）

| # | 事项 | 来源 | 建议 |
|---|---|---|---|
| 1 | **`servingAt` 在「换人 / 回池后重新开始服务」时该保留还是改写** | P0-7 reviewer `n1`（「最重要的一条」）· 已登记为 P0-9 的 **D14（DEFERRED）** | **不必现在决定**。任何轮次准备给 `serving → paid` 接入口**之前**必须先裁定 |
| 2 | **`applyCompletionReview` 不校验起始状态**，且 pending 索引只在它内部清除 → 「作废」路径**不得复用它** | P0-8 reviewer `N1` · 已登记为 P0-9 的 **D15（DEFERRED）** | 技术约束，不需产品决定；约束已写入 `api-contract.md` §2.8 |
| 3 | 阻塞自动通过的「投诉」口径取「未完结才算」 | P0-8 `D4` | **待产品确认**（口径已实现并测试，若改判定只动一处纯函数） |
| 4 | 自动审核时长沿用平台时长的 `1~1440` 分钟上下限 | P0-8 `D5` | **待产品确认**（未发明新数字） |
| 5 | 结构门禁 23 只扫 `lib/services/` | P0-8 `n2` | **已处置**：P0-9 实现 `sweepMaturedEarnings` 时，该门禁的期望集合已同步长大 |
| 6 | 门禁 23 挡不住「调用被挪到读取之后」→ 已补**行为用例** + 受控 mutation 复核 | P0-8 `m1` | 已处置 |
| 7 | 打手端写路由的 **HTTP 200 happy-path 覆盖不足** | P0-8 §8.2(b) | 技术债 |
| 8 | 列表页 `<h1>` 用了一个命名偏「详情」的常量 | P0-8 §8.2(b) | MINOR，未改 |
| 9 | `docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md` —— 未跟踪、**文件名被 GBK 破坏**的 P0-6.1 指令副本 | P0-7 `n3`（**归属 P0-6.1**） | **建议提交前删除**（内容已逐字保存在 `P0-6.1/01-prompt-extended.md`）。AI 不做 Git 写操作 |
| 10 | `CLAUDE.md` 事实表过期 | P0-6.1 `NOTE-4` | **已于 P0-9 修正**（并在 reviewer 修复后二次同步）：现为 **65 files / 1255 cases**、`page.tsx` **78**、`route.ts` **125**（`admin` 62 · `staff` 20 · `companion` 8 · 其它 35）、仓储 **26**；`tech-stack.md` 的测试计数同步 |
| 11 | 用户端**仍可见** `companionRateBp`（分账比例） | 既有技术债 | **上线前必须移除** |
| 12 | **投诉表单的订单选择器不认「窗口已关闭」**：`/complaints/new` 的选项来自**全部**在售订单，页面不读 `isComplaintWindowClosed`，用户会填完 5~100 字才被接口 400 拒掉 | P0-9 reviewer **`m1`**（对应 P0-9 的 **D21** 想要的效果） | **本轮刻意不改**（见下方说明），已登记为独立待办 |
| 13 | 用户端**看不到投诉截止时刻**：订单详情只给一个布尔，窗口关闭后是「提交时才被告知」 | P0-9 reviewer **`n3`** | **需要产品决定**（D18 只裁定了单位呈现）。本轮不作为缺陷 |
| 14 | **未关联订单的投诉**既不构成阻塞、也不受窗口限制（`readOrderBlockingFacts` 只认 `complaint.orderId === orderId`） | P0-9 reviewer **`n2`**（继承 P0-8 的 `D4` 口径） | **待产品确认**，已在 `P0-9/02-decisions.md` §五登记。不自行收紧 |

> 📌 **关于第 12 条（`m1`）为什么本轮不改**：它的最小修法要在**订单列表 DTO 上加一个字段**
> （`OrderListItem` 目前不带窗口信息，页面无从判断），而 P0-9 §八 明文要求
> 「现有投诉/退款模块只做**必要最小联动**，不重构整个售后系统」。
> 那个 DTO 被用户端多处消费、且多个测试套件对 DTO 键集有断言，本轮改动会外溢到
> 与「收益 / 投诉窗口」无关的页面。**它是一条真实的体验瑕疵，但不是资金或权限问题**，
> 因此按 §八 的边界留在原地，登记为下一轮的小改动（评测口径：`isComplaintWindowClosed` 仍只有一处出处）。

### E.3 Production blockers（Mock 阶段可以继续，上线前必须解决）

1. **真 Scheduler 缺失** —— 所有「到点自动」都是**读路径上的惰性物化**，
   现在共 **三处**：`sweepExpiredDispatches` / `sweepCompletionAutoApprovals` / `sweepMaturedEarnings`（P0-9）。
   上线后必须有真实调度器调用**同一个**函数，否则「到点」只有在有人打开页面时才成立。
   其中第三条最重：它决定**打手什么时候能提到钱**，比「派单超时」更不能依赖用户恰好来访。
2. **没有数据库** —— 全部跑在 `globalThis` Mock Store 上，**重启即清空**。
3. **没有真实支付通道** —— 支付是 Mock 的。
4. **用户端暴露 `companionRateBp`**（见 E.2 #11）。
5. **真实微信认证**未接入。

### E.4 后续 Round 候选（**仅建议，编号由用户 / ChatGPT 分配**）

| 候选 | 内容 | 前置 |
|---|---|---|
| 提现 / 钱包账本 | `Earning.available` 之后的下游（提现入口、账本、余额调整） | P0-9 ✅ |
| 打手收益的**结算单 / 明细导出** | 现在是列表 + 汇总，没有对账视图 | P0-9 ✅ |
| 真 Scheduler 接入 | 给三个 sweep 函数接上定时调用（`sweepExpiredDispatches` / `sweepCompletionAutoApprovals` / `sweepMaturedEarnings`） | P0-9 ✅，且是**上线前必须** |
| 封禁回池 / 客服换人 | `serving → paid` 的入口 + pending submission 作废 | **先裁定 D14 与 D15** |
| 未开始服务直接退款 | `paid` / `accepted` 用户自助全额退款 | 需求已冻结 |
| 打手端 HTTP happy-path 补齐 | `completionHttp.test.mjs` 目前只 4 条 | 独立小轮 |

---

## F. Git

```
HEAD = 249f7c1adefc2c9d9e7f37bb26adde0bc45808df
       "docs: close P0-6 and DEV-1 after acceptance"

git status --short: 46 modified（tracked）+ 46 untracked 条目（`-uall` 展开为 69 个文件）
git diff --shortstat: 46 files changed, 2247 insertions(+), 281 deletions(-)
```

**声明**：整个批次（P0-6.1 → P0-7 → P0-8 → P0-9）期间，
**未执行任何 Git 写操作**——没有 `add` / `commit` / `push` / `reset` / `restore` / `checkout` /
`rebase` / `amend`。只执行过只读命令：`git status` / `git diff` / `git log` / `git rev-parse` / `git show`。
**所有四轮的改动都未提交，全部躺在工作区，由用户本人决定如何提交。**

> ✅ **已收口（2026-09-24）**：上面「未提交、躺在工作区」是**报告时点**的事实。**用户本人**随后完成提交
> **`eef4e62`**（`115 files changed, 19741 insertions(+), 282 deletions(-)`，含四轮全部档案），
> 工作区随之 clean；四轮已由 `AWAITING_ACCEPTANCE` 收口为 `DONE`。**AI 至今零 Git 写操作。**

⚠️ 提交前建议先处理 §E.2 #9（那个 GBK 文件名损坏的文件）。
✅ **该文件的核对已于 2026-09-24 完成**，结论见 §G.3：它是 `P0-6.1/01-prompt-extended.md`
的**逐字重复副本**（GBK 编码，转码后 `md5` 完全相同），确认可安全删除——**由用户本人决定是否删除**，
AI 不执行任何删除 / Git 写操作。

---

## G. 人工验收结果（**2026-09-24，批次统一验收**）

### G.1 结论

> ✅ **四轮全部通过。** 用户本人于 **2026-09-24** 按 §D 的统一人工验收清单完整走了一遍，
> 覆盖 P0-6.1 / P0-7 / P0-8 / P0-9 四轮（含 §D.7A 的 P0-9 段），
> 并回复「**P0-6.1、P0-7、P0-8、P0-9 人工验收全部通过**」。

| Round | `User Result` | `Final Result` | `Accepted At` | `Issues Found` | `Git Commit` | Status |
|---|---|---|---|---|---|---|
| **P0-6.1** | **PASSED** | **PASSED** | 2026-09-24 | 无 | **`eef4e62`** | `DONE` |
| **P0-7** | **PASSED** | **PASSED** | 2026-09-24 | 无 | **`eef4e62`** | `DONE` |
| **P0-8** | **PASSED** | **PASSED** | 2026-09-24 | 无 | **`eef4e62`** | `DONE` |
| **P0-9** | **PASSED** | **PASSED** | 2026-09-24 | 无 | **`eef4e62`** | `DONE` |

✅ **「DONE 双门槛」两个条件均已满足，四轮已收口为 `DONE`。**
按 `development-workflow.md` §十七，收口需要
① 用户本人说明验收通过 **且** ② 用户本人完成该项目相关的 Git 提交。
**条件 ① 于 2026-09-24 满足；条件 ② 由用户本人提交 `eef4e62` 满足**——
本批次（AI 侧）全程**零 Git 写操作**，因此该提交**不是** AI 代提交（见 §F）。
⚠️ **本次收口是纯文档动作**：`User Result` / `Final Result` / `Accepted At` / `Issues Found`
与全部验收结论、业务代码、测试**一律未改动**。

### G.2 验收覆盖（逐轮要点）

| Round | 验收文档 | 覆盖要点 |
|---|---|---|
| P0-6.1 | `P0-6.1/04-acceptance.md` A–E | FIX-1 统一顶栏返回入口且**保持同一会话**（无 logout / 身份切换 / 第二套认证）；FIX-2 公共池「等待最久在最上」、专属池 `exclusiveEnteredAt` ASC、**取消回池后按新的 `publicPoolEnteredAt` 排在靠后 / 底部** |
| P0-7 | `P0-7/04-acceptance.md` A–F | `accepted → serving` 本人入口；进入 `serving` 后两个动作入口同时消失；归属 **404** / 状态 **400** / 未登录 **401**；重复点击 `changed: false`、`servingAt` 不刷新；**未新增产品通知** |
| P0-8 | `P0-8/04-acceptance.md` A–G | 提交完成材料（5~50 字 + 凭证）；客服 approve / reject + 重提不覆盖审核历史；到期 System 自动通过（**不伪装成人工审核**）；投诉 / 退款阻塞；**订单状态恰好五个值**；DTO 隐私；前四轮回归 |
| P0-9 | `P0-9/04-acceptance.md` A–G | 投诉窗口后台配置（`59` / `10081` 拒、`60` / `10080` 收、审计可见）；**不追溯**历史 completed 订单；完成即生成 `frozen` 收益（两桶汇总）；窗口内投诉**阻止释放**；收益接口权限边界 **403 / 401 / 401 / 405**；端到端回归 |

### G.3 附带核对：GBK 文件名损坏的未跟踪文件（§E.2 #9）

| 项 | 结果 |
|---|---|
| 路径 | `docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md` |
| 性质 | **重复副本 + 编码损坏**（文件名与内容均为 GBK，在 UTF-8 仓库里显示为乱码） |
| 核对方法 | `iconv -f GBK -t UTF-8` 转码后与 `P0-6.1/01-prompt-extended.md` 逐字节比对 |
| 结论 | **转码后 `md5` 完全相同（`0c2ad16a…`）→ 内容逐字重复**，与 `cmd_p0-6.1.md` / `P0-6.1/01-prompt.md` 属**同一份指令的长版**（短版是它的收敛表述） |
| 处置 | **建议删除**（内容已被 `01-prompt-extended.md` 完整保存，删除不丢信息）。**由用户本人决定并执行**——AI 不执行任何删除或 Git 写操作 |

### G.4 验收未覆盖 / 无法覆盖的（如实声明）

| # | 项 | 原因 |
|---|---|---|
| 1 | **真 Scheduler 到点自动解冻 / 自动通过** | 仓库里没有调度器，所有「到点」都是读路径上的**惰性物化**（`sweepMaturedEarnings` / `sweepCompletionAutoApprovals`）。验收用「把未来的 `at` 注入同一个函数」代替。**上线前 production blocker**，见 §E.3 |
| 2 | 提现 · 钱包账本 · 人工余额调整 · 部分退款冲正 · 已提现退款追偿 | P0-9 §十三 明确排除，属后续批次 |
| 3 | 封禁回池 · 客服换人 · 特殊过期申诉 | 同上（`Earning.withdrawn` / `reversed` 只有类型、零写入路径） |
| 4 | 历史 completed 订单的收益**回填** | `D19` 刻意不回填（回填 = 用今天的配置改历史订单） |
| 5 | 投诉窗口**自然到期**的人工观察 | 最小窗口 60 分钟，无法在验收中观察到；见 §D.7A 的 🕐 说明 |
| 6 | 用户端**投诉截止时刻的展示** | `D18` 只裁定了单位呈现，**是否展示截止时刻仍需产品决定**（§E.2 #13） |

---

**报告结束。按批次 §十三：完成后停止，不开始 P0-10。**
