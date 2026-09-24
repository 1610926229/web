# P0-8 — 实现结果与验证记录

Round: P0-8
Status: AWAITING_ACCEPTANCE
Recorded At: 2026-09-24
Git: **本轮不产生任何提交**（batch §十二：Claude 禁止一切 Git 写操作，只读）

> 本文件在实现过程中增量填写。最终数字以「全部门禁跑完」后的记录为准。

---

## 一、本轮 delta（batch §六：不得把累计 diff 当成本轮 delta）

### 1.1 本轮开始前的工作区 baseline（**不是本轮 delta**）

```
HEAD = 249f7c1adefc2c9d9e7f37bb26adde0bc45808df
tracked 改动：17 files changed, 848 insertions(+), 101 deletions(-)
untracked  ：14 项
```

该 baseline 是 **P0-6.1 + P0-7 的累计产物**（批次的第二站），明细见
`docs/03-dev/rounds/P0-7/03-delivery.md` 与 `P0-6.1/03-delivery.md`。

⚠️ **归因的诚实边界**：batch §十二 禁止一切 Git 写操作，因此 P0-6.1 / P0-7 / P0-8
**都没有提交**，三个轮次的改动同时躺在同一个工作区里。`git diff` 无法区分某一行是谁写的。
下面 §1.2 的归属是**推断**出来的，依据是两份前轮记录里各自声明的文件清单
（P0-7：9 个项目文件 + 4 份文档；P0-6.1：4 份文件），二者相加**恰好等于** baseline 的
17 个 tracked 文件——这条自洽是归因的主要证据，但它仍是推断，不是 Git 证据。

### 1.2 本轮实际改动清单

#### （a）本轮新建的文件 —— 代码与测试 24 个，共 4865 行

| # | 文件 | 行 | 内容 |
|---|---|---|---|
| 1 | `lib/constants/completions.ts` | 167 | `COMPLETION_TRANSITIONS` 四态状态机、`normalizeCompletionSummary`（5–50 字）、`isUnresolvedComplaintStatus`、`isCompletionAutoApprovalBlocked`、`buildCompanionCompletionInfo` |
| 2 | `lib/types/completion.ts` | 221 | `CompletionSubmission` / `CompanionCompletionInfo` / `StaffCompletionListItem` / `StaffCompletionDetail` / `StaffCompletionWriteResult` 等 DTO |
| 3 | `lib/constants/staffCompletions.ts` | 321 | 客服端文案、`staffCompletionAutoApprovalBlockedReason`（退款优先于投诉） |
| 4 | `lib/data/completionRepository.ts` | 46 | 仓储接口（读取为主 + 三个写入） |
| 5 | `lib/data/mockCompletionRepository.ts` | 143 | mock 实现 + `globalThis` store（`submissions` / `pendingSubmissionIdByOrder`） |
| 6 | `lib/data/completionTransaction.ts` | 387 | 伪事务 `submitCompletion` / `approveCompletion` / `rejectCompletion` + **同步** `sweepCompletionAutoApprovals(at)` |
| 7 | `lib/services/companionCompletions.ts` | 128 | 打手端服务：提交、完成材料信息 |
| 8 | `lib/services/staffCompletions.ts` | 332 | 客服端服务：列表 / 详情 / 通过 / 驳回（读路径先做惰性清扫） |
| 9 | `lib/services/staffCompletionsHttp.ts` | 82 | 客服端浏览器客户端 |
| 10 | `app/api/companion/orders/[id]/completion/route.ts` | 41 | `POST` 提交完成材料 |
| 11 | `app/api/staff/completions/route.ts` | 34 | `GET` 客服端列表 |
| 12 | `app/api/staff/completions/[id]/route.ts` | 37 | `GET` 客服端详情 |
| 13 | `app/api/staff/completions/[id]/approve/route.ts` | 41 | `POST` 通过（**不读请求体**） |
| 14 | `app/api/staff/completions/[id]/reject/route.ts` | 34 | `POST` 驳回（读 `reviewNote`） |
| 15 | `components/companion/CompanionCompletionPanel.tsx` | 205 | 打手端「提交完成材料」面板 |
| 16 | `components/staff/StaffCompletionTable.tsx` | 300 | 客服端完成材料表格（筛选 / 分页 / 刷新） |
| 17 | `components/staff/StaffCompletionConsole.tsx` | 235 | 客服端详情控制台（通过 / 驳回） |
| 18 | `app/staff/(console)/completions/(list)/page.tsx` | 55 | 列表页（`strict: false` 宽松解析地址栏） |
| 19 | `app/staff/(console)/completions/(list)/loading.tsx` | 17 | 列表骨架 |
| 20 | `app/staff/(console)/completions/[id]/page.tsx` | 217 | 详情页 |
| 21 | `app/staff/(console)/completions/[id]/not-found.tsx` | 28 | 详情页 404 |
| 22 | `tests/completions.test.mjs` | 1007 | 本轮主回归（含 23 条门禁 + 读取路径惰性物化的行为用例，见 §5.3.1） |
| 23 | `tests/staffCompletions.test.mjs` | 618 | 客服端服务层回归 |
| 24 | `tests/completionHttp.test.mjs` | 169 | HTTP 契约（无 `APP_BASE_URL` 时整体 skip） |

本轮档案 5 个：`docs/03-dev/rounds/P0-8/` 下 `README.md` / `01-prompt.md` /
`02-decisions.md` / `03-delivery.md` / `04-acceptance.md`。

#### （b）本轮修改的文件

**（b-1）本轮首次触及的 tracked 文件 —— 18 个**

| 文件 | 本轮改了什么 |
|---|---|
| `lib/types/platformConfig.ts` | 新增 `completionAutoApprovalMinutes`（**仍是同一份 PlatformConfig，没有第二份配置**） |
| `lib/constants/platformConfig.ts` | 新参数文案与边界；`PLATFORM_CONFIG_NOTICE` 改为同时覆盖两个参数 |
| `lib/data/adminPlatformConfigTransaction.ts` | 写入器带上新字段（快照语义） |
| `lib/data/mockStore.ts` | store 挂上 completion 仓储 |
| `lib/mocks/fixtures/platformConfigSeed.ts` | 种子补 `completionAutoApprovalMinutes` |
| `lib/services/adminPlatformConfig.ts` | 后台参数服务：读 / 部分 PATCH |
| `lib/services/adminOrders.ts` | 两个读路径挂自动审核清扫 |
| `lib/services/orders.ts` | 用户端读路径挂自动审核清扫 |
| `lib/constants/adminAudit.ts` | 平台参数审计对象文案 |
| `lib/data/complaintRepository.ts` | 只读访问器（供阻塞判定） |
| `lib/data/mockComplaintRepository.ts` | 同上，mock 侧 |
| `components/admin/AdminPlatformConfigConsole.tsx` | 后台配置台接入第二个参数（部分 PATCH） |
| `components/admin/AdminStatusBadge.tsx` | 新状态角标 |
| `components/staff/StaffHeader.tsx` | 导航新增「完成材料」入口 |
| `tests/http-smoke.test.mjs` | 生产烟测：`/rank` 的可见文本断言误把构建产物当业务文案（见 §六） |
| `tests/platformConfig.test.mjs` | 新参数回归 |
| `tests/staff.test.mjs` | 客服端接口清单门禁扩充 |
| `tests/staffTableRefresh.test.mjs` | 刷新契约 |

**（b-2）与前轮共享、本轮又改过的 tracked 文件 —— 12 个**
（这些文件的 diff 里**同时**含有前轮的行，不能整份算作本轮）

| 文件 | 本轮新增的部分 |
|---|---|
| `lib/services/companionOrders.ts` | 打手端两条读路径挂清扫（复核项 A 的落点） |
| `lib/services/companionHttp.ts` | 新增 `submitCompanionCompletionRequest` |
| `lib/data/mockPaymentRepository.ts` | 新增第 5 个订单写入器 `applyOrderCompletion` |
| `lib/types/order.ts` | 打手端 DTO 增 `completion` 字段 |
| `app/companion/(console)/orders/[id]/page.tsx` | 接入完成材料面板 |
| `tests/companion.test.mjs` | 打手端接口清单 6 → 7；负向门禁改写 |
| `tests/companionOrders.test.mjs` | DTO 白名单增字段 |
| `docs/02-tech-design/api-contract.md` | §2.8 / §2.11 / §3.1 / §3.2 同步（复核项 C） |
| `docs/02-tech-design/database-schema.md` | 写入点四处 → 五处、行号修正（复核项 C） |
| `docs/02-tech-design/directory-structure.md` | A / B / D 三段进度同步（复核项 C） |
| `docs/03-dev/rounds/README.md` | 索引新增 P0-8 行 |
| `docs/03-dev/总需求进度表.md` | 新增 P0-8 行 |

#### （c）行数口径

| 口径 | 值 |
|---|---|
| 全工作区 tracked diff（含 P0-6.1 / P0-7 的行） | 35 files, +1628 −191 |
| baseline（§1.1，非本轮） | 17 files, +848 −101 |
| **相减得到本轮在 tracked 文件上新增的行** | **+780 −90** |
| 本轮新建的 24 个代码 / 测试文件 | 4865 行（untracked，**完全不计入上面的 tracked diff**） |

⚠️ 因此「本轮 delta」若只报 `+780 −90` 会**严重低估**（新文件一行都不在里面）；
若报 +1628 −191 则**高估**（把 P0-6.1 / P0-7 的 848 行算进来了）。两个数字都必须带口径说明。

### 1.3 本轮未改动的既有文件（边界证据）

- **中央状态机未动**：`lib/constants/orders.ts` 的 `ORDER_TRANSITIONS` / `OrderStatus`
  枚举**零改动**（本轮唯一新增的迁移 `serving → completed` 是**表里本来就有**的边）。
- **金额未动**：没有任何一处改动分账 / 抽成 / 到手金额的计算。
- **通知未新增**：`lib/data/notificationRepository.ts` 与
  `lib/data/mockNotificationRepository.ts` **均未出现在本轮 diff 中**，
  本轮新增产品通知 **0** 条（需求未为「提交完成材料 / 审核通过 / 审核驳回」冻结任何通知）。
- **第二个真相源未引入**：没有第二份 PlatformConfig、第二个订单仓储、第二个退款或投诉系统。
- 前轮的三个文件 `lib/constants/dispatch.ts` / `lib/data/companionOrderTransaction.ts` /
  `lib/services/companionDispatch.ts` 本轮**一个字节都没碰**（diff 中 0 行与本轮相关）。

---

## 二、实现（按数据流：常量 → 类型 → 仓储 → 写入器 → 伪事务 → 服务 → 接口 → 客户端 → 页面）

1. **常量层** `lib/constants/completions.ts` — 四态状态机（`pending` 只有
   `approved` / `rejected` 两条出边，其余皆为终态）、完成说明 5–50 字归一化、
   阻塞判定（退款进行中 / 投诉未完结，**退款优先**）。
2. **类型层** `lib/types/completion.ts` — 五组 DTO；`CompanionCompletionInfo.canSubmit`
   由服务层算好下发，客户端**不自行推导**。
3. **仓储层** `lib/data/completionRepository.ts`（接口）+ `mockCompletionRepository.ts`
   （mock 实现 + `globalThis` store）。store 里两张表：`submissions` 与
   `pendingSubmissionIdByOrder`（每单至多一份 pending）。
4. **订单写入器** `lib/data/mockPaymentRepository.ts` 新增 `applyOrderCompletion` ——
   订单侧唯一新增的写入点，写 `status: "completed"` 与 `completedAt ?? at`。
   至此订单写入点**恰好五处**（Accepted / AcceptanceReleased / Serving / Completion / Refund）。
5. **伪事务** `lib/data/completionTransaction.ts` —— 三个公开伪事务
   `submitCompletion` / `approveCompletion` / `rejectCompletion`，
   以及**同步**函数 `sweepCompletionAutoApprovals(at)`。
   原子区段内**没有 `await`**（由「门禁 21」用源码断言保护）。
6. **服务层** `lib/services/companionCompletions.ts`（打手端）、
   `lib/services/staffCompletions.ts`（客服端）。
   四条读路径（用户端 / 管理端 / 客服端 / 打手端）**全部**在读取前调用惰性清扫。
7. **接口层** 5 条路由（见 §1.2(a) 第 10–14 行）。打手端 `requireCompanion()` 是第一动作。
8. **浏览器客户端** `staffCompletionsHttp.ts` + `companionHttp.ts` 的新增函数，
   只依赖 `lib/types` 与 `lib/constants`。
9. **页面 / 组件** 打手端详情页接入 `CompanionCompletionPanel`；
   客服端新增「完成材料」列表页与详情页。

---

## 三、设计决策（详见 `02-decisions.md`）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 自动审核时长放进**现有的** PlatformConfig，不新建配置域 | batch §十一 禁止第二份 PlatformConfig |
| D2 | 幂等用**状态自身即判据**，不引入幂等键字段 | 与 `acceptDispatch` / `startCompanionOrder` 同一机制（`api-contract.md` §2.8 第 4 类） |
| D3 | 截止时刻**惰性物化**（读路径调用同步清扫），不引入定时器 | 无真实调度器；将来真实调度器调**同一个**函数 |
| D4 | 退款 / 投诉阻塞自动审核 | 已在 `02-decisions.md` 记为**待产品确认**项（见 §八） |
| D5 | 新参数边界（上下限） | 同上，待产品确认（见 §八） |
| D6 | 不扩展 `OrderStatus` 枚举 | batch §十一 明文禁止把 `completion_review` / `settling` / `settled` 塞进状态枚举 |
| D7 | 四条读路径都要挂清扫 | 打手端**列表**也展示订单状态，只挂详情会让列表卡片停在 `serving`（本轮复核项 A 的依据） |

---

## 四、明确不做（`01-prompt.md` §十二）

- 不做作废 / 失效（`invalidated`）：状态机里预留了态与边，**本轮不产生任何写入**（属 P0-9）。
- 不做投诉窗口参数 `complaintWindowMinutes`（属 P0-9）。
- 不做结算 / 分账 / 打手收益（`Earning` 在仓库里**尚不存在**）。
- 不做通知（本轮新增通知 0 条）。
- 不改金额、不改订单状态枚举、不新建第二份订单仓储 / 退款系统 / 平台配置。

---

## 五、测试

### 5.1 本轮新增的测试文件

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `tests/completions.test.mjs` | **31** | 状态机、提交（字数边界 / 幂等 / 归属）、审核（通过 / 驳回 / 重放）、自动审核清扫（到点、未到点、退款阻塞、投诉阻塞）、**读取路径惰性物化的行为用例**（§5.3.1）、**源码门禁 1–23** |
| `tests/staffCompletions.test.mjs` | **22** | 客服端列表筛选 / 关键词 / 分页、详情字段、通过 / 驳回、权限与 DTO 隐私 |
| `tests/completionHttp.test.mjs` | **4** | HTTP 契约（无 `APP_BASE_URL` 时**整体 skip**，生产模式下必跑） |

### 5.2 被保护的关键不变量（摘）

- 提交：完成说明 5–50 字（按**字符数**计，不是字节）；同一单同一打手至多一份 pending；
  非 `serving` 订单不可提交。
- 审核：只有 `pending` 可被审；重复通过是**重放**（不报错、不刷新 `reviewedAt`）；
  驳回必须带原因。
- 自动审核：**只在 deadline 到点后**才成立；有进行中退款或未完结投诉时**阻塞**。
- DTO 隐私：打手端拿不到他人订单的完成材料；客服端列表项不含审核凭证细节。
- `OrderStatus` 枚举**未被扩展**（源码门禁）。

### 5.3 门禁 22 / 23（本轮为复核项 A / B 补的结构门禁）

- **门禁 22** —— `approveCompletion` 的 `serving → completed` 必须走中央状态机：
  断言 `canTransitionOrder` 从 `@/lib/constants/orders` 导入（唯一真相源）、
  函数体内**真的调用**它、且**排在**领域 Guard `order.status !== "serving"` **之前**
  （用 `indexOf` 相对位置，不是 `includes`——把它挪到 Guard 之后必然变红）。与
  `tests/companionOrders.test.mjs:995/:1011` 的 P0-7 同形门禁同构。
- **门禁 23** —— 自动审核清扫的调用点**集合相等**：剥注释后扫 `lib/services/*.ts`，
  恰好是 `["adminOrders.ts", "companionOrders.ts", "orders.ts", "staffCompletions.ts"]`。
  漏挂一处或多挂一处都会红。失败信息**同时点明两种可能**：漏挂/多挂，
  以及「把各端调用收敛成一个公共物化函数」——后者是**行为保持型的重构、不是缺陷**，
  但必须在同一次改动里同步更新这条白名单（否则报出来的方向恰好说反）。

#### 5.3.1 ⚠️ 门禁 23 的一条**覆盖缝隙**与补上的**行为用例**

门禁 23 的判据是 `includes(...)`——它钉的是**引用出现**，不是**调用点**、更不是**顺序**。
两个反例都不变红：**删掉** `companionOrders.ts:132`/`:168` 两行调用只留包装函数
（缺陷 A 原样复活）；把两行调用**挪到**读仓储**之后**（列表卡片照样停在 `serving`）。

补的行为用例（`tests/completions.test.mjs`，紧接「自动 17」之后）：

- 造一张 `serving` 单，把 `submitCompletion` 的 `at` 拨到**真实 now 之前 30 分钟**
  （deadline 因此落在真实当前时刻的过去；`materializeCompletionAutoApprovals()` 取的是
  真实 `new Date()`，只有 deadline 已越过真实现在才会被惰性物化）；
- **不显式调用 `sweepCompletionAutoApprovals`**，直接 `getCompanionOrderDetail` 与
  `listCompanionOrders`，断言两边的状态都已是 `completed`。

**协调者的受控 mutation 复核**（不是只采信测试 agent 的推理）：把
`lib/services/companionOrders.ts` 备份（md5 `65dacd28…`）后做两次改写，各跑一次该用例：

| 改法 | 结果 |
|---|---|
| (a) **删掉**两处调用、只留包装函数 | **红** —— `AssertionError: 详情读路径必须把过期的自动审核物化成 completed`，`actual: 'serving'` / `expected: 'completed'` |
| (b) 把两处调用**挪到读仓储之后** | **红** —— 同一条断言，`actual: 'serving'` |

两次都**为正确的理由而红**（正是缺陷 A 的症状：状态停在 `serving`），不是无关报错。
随后从备份精确还原，`md5sum` 与备份一致（`65dacd28…`），两处调用回到 `:132` / `:168`。
**文件已回到原状，没有残留任何 mutation 痕迹。**

机制上为什么 (b) 也会红：`queryOrdersByCompanion` 返回的是
`[...store().orders.values()]`——一个装着**当时那些对象引用**的新数组；
而 `applyOrderCompletion` 写的是 `current.orders.set(id, updated)`，**换成一个新对象**。
所以先读后写时，已捕获的数组仍指向旧的 `serving` 对象。

### 5.4 测试总量

| 口径 | 值 |
|---|---|
| 测试文件 | **63**（`ls tests/*.test.mjs`） |
| 用例总数 | **1222** |
| 通过（进程内） | 1094 |
| 跳过（进程内） | 128（全部是 `completionHttp` 等 HTTP 用例，无 `APP_BASE_URL` 时 skip） |
| 失败 | **0** |

⚠️ `CLAUDE.md` 里「Tests \| 51 files, 1011 cases」是**过期数字**（该文件另有若干
过期计数：`page.tsx` 现为 77、`route.ts` 现为 124）。本轮**没有**改 `CLAUDE.md`
——它不在本轮范围内，列为跨轮事项（§8.2）。

### 5.5 已知测试缺口（诚实记录）

- `tests/*.mjs` 跑在 node 内置 runner 上，**JSX 不被剥离**，因此
  `components/**` 与 `app/**/page.tsx`（客户端组件部分）**没有自动化测试**，
  只能靠手工验收路径覆盖（见 `04-acceptance.md`）。
- `completionHttp.test.mjs` 的 4 条用例在**进程内**恒 skip——它们只在
  `APP_BASE_URL` 指向真实服务时才有意义（§六 第二张表）。

---

## 六、门禁（两轮：修复前 / 修复后）

两轮都**只读**、都以**重定向到文件后读退出码**的方式取得（不经过管道）。

### 6.1 第一轮 —— 本轮开发完成、reviewer 首轮审查之后，**修复之前**

| # | 门禁 | 命令 | 结果 |
|---|---|---|---|
| 1 | 单元 / 回归 | `pnpm test` | **exit 0** — tests 1219 / pass 1091 / fail **0** / skipped 128 |
| 2 | 路由类型生成 | `npx next typegen` | **exit 0** |
| 3 | 类型 | `npx tsc --noEmit` | **exit 0** |
| 4 | Lint | `pnpm lint` | **exit 0** — 0 error，**4 warning**（两个新测试文件里的无用变量） |
| 5 | 生产构建 | `pnpm build` | **exit 0** |
| 6 | **生产 HTTP 全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **exit 0** — **fail 0 / skipped 0**，1219 全通过 |

⚠️ 第 6 项**第一次跑是红的**（fail 1），暴露了 `tests/http-smoke.test.mjs` 的一处
**测试自身缺陷**：`/rank` 的「页面上不得出现 `\d+k` / `\d+w` 这类数量级文本」断言，
在剥离 `<script>` 后仍会命中构建产物——唯一的命中来自
`/_next/static/chunks/3k-j_e9-s-66i.css`，其中的 `3k` 被当成业务文案。
**这不是产品缺陷**：进程内跑（无 `APP_BASE_URL`）时该用例整体 skip，**永远碰不到**这条路径。
已把剥离函数从 `stripScripts` 扩为 `stripBuildArtifacts`（追加剥 `<link>`），
两条断言的**判据本身一字未改**。这条独立的生产门禁因此证明了它的价值。

### 6.2 第三轮（终态）—— A / B / M1 / M2 修复 + 门禁 22 / 23 + 行为用例 + 清掉 4 个 warning 之后

| # | 门禁 | 命令 | 结果 |
|---|---|---|---|
| 1 | 单元 / 回归 | `pnpm test` | **exit 0** — tests **1222** / pass **1094** / fail **0** / skipped 128 |
| 2 | 路由类型生成 | `npx next typegen` | **exit 0** |
| 3 | 类型 | `npx tsc --noEmit` | **exit 0** |
| 4 | Lint | `pnpm lint` | **exit 0** — **0 error、0 warning** |
| 5 | 生产构建 | `pnpm build` | **exit 0** |
| 6 | **生产 HTTP 全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **exit 0** — tests **1222** / pass **1222** / **fail 0 / skipped 0** |

用例数 1219 → 1222：+2 是门禁 22 / 23，+1 是 §5.3.1 的行为用例。

生产服务起在 **3105**，跑完后**按 PID 结束进程树并复核端口已释放**（`netstat` 确认
`LISTENING` 消失），避免留下陈旧进程污染下一次测量。

### 6.3 batch §四 十项继续条件逐条核对

| # | 条件 | 状态 |
|---|---|---|
| 1 | 无未决 OPEN decision | ✅（D4 / D5 已记为**待产品确认**，不是本轮阻塞；见 §八） |
| 2 | 本轮范围已实现 | ✅ |
| 3 | `pnpm test` fail=0 | ✅ 0 |
| 4 | typecheck 0 | ✅ |
| 5 | lint 0 | ✅（0 error 0 warning） |
| 6 | build 0 | ✅ |
| 7 | 生产 `APP_BASE_URL` 全量 fail=0 **且 skipped=0** | ✅ 1222/1222，skipped 0 |
| 8 | reviewer 最终 BLOCKER=0 / MAJOR=0 | ✅ **BLOCKER=0 / MAJOR=0**（MINOR=2，均已处置，见 §七） |
| 9 | 无未解释的工作区改动 | ✅（§九；含一条**已记录**的历史垃圾文件名） |
| 10 | 下一轮（P0-9）前置**真的**存在 | ✅ 本轮交付的 `serving → completed` 通过路径、`CompletionSubmission.invalidated` 类型、投诉仓储与 `complaintWindowMinutes` 字段都已就位 |

⚠️ 第 10 项**是 ✅**（P0-9 需要的**能力**都在），但这**不等于** P0-9 能一路做完：
它会在自己的 Requirement Check 里撞上 batch §五 的另一条停止条件
——**「投诉窗口的 Mock 默认值」是一处「需要自行发明默认时间」的产品决定**（见 §8.1）。
因此本 batch 的实际终点是：**P0-9 进入后停在 `CLARIFYING`，向产品负责人要一个数**，
而不是悄悄拍一个 48 或 24 写进种子。

---

## 七、Reviewer

### 7.1 首轮审查结论与处置

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| A | MAJOR | 自动审核清扫**漏挂打手端读路径**，与 D7 / `completionTransaction.ts` 注释 / `04-acceptance.md` 三处声明矛盾 | ✅ 已修：`lib/services/companionOrders.ts` 新增包装函数并挂在**列表 + 详情两处** |
| B | MAJOR | `approveCompletion` **未走中央状态机**，违反「`OrderStatus` 迁移唯一真值源」 | ✅ 已修：`completionTransaction.ts` 第 6 步插入 `canTransitionOrder(order.status, "completed")`，排在重放判定之后、领域 Guard 之前 |
| C | MAJOR | 三份技术设计文档与实现不同步 | ✅ 已修（由协调者本人改，见 §1.2(b-2)） |
| M1 | MINOR | `applyCompletionReview` 无条件刷新 `reviewedAt`，与注释声明的「不刷新」不符 | ✅ 已修：`reviewedAt: submission.reviewedAt ?? input.at` |
| M2 | MINOR | `PLATFORM_CONFIG_NOTICE` 只覆盖一个参数 | ✅ 已修：新文案同时说明两个参数各自的快照语义 |

**对 A 的一处判断偏离**：reviewer 建议只挂详情页，协调者判定**列表也必须挂**
（列表项带 `status` / `statusLabel`，只挂详情会让列表卡片停在过期的 `serving`），
已按列表 + 详情两处落地；门禁 23 用**集合相等**把四条读路径钉死。

### 7.2 协调者自查（不止看 agent 报告）

A / B / M1 / M2 四条**逐条读代码核对**，不是凭 agent 汇报：

- A：`companionOrders.ts:20` import、`:117-119` 包装函数、`:132` list 调用、`:168` detail 调用，均在读订单之前。
- B：`:202` 结构校验、`:210` 领域 Guard，顺序正确；且**独立验证了「今天两者等价」这个前提**——
  读 `lib/constants/orders.ts:94-100` 的 `ORDER_TRANSITIONS`，能到 `completed` 的状态
  **只有 `serving`**（`serving: ["paid","completed","refunded"]`，且表里无自环），
  故 `canTransitionOrder(x,"completed")` ⟺ `x === "serving"`，注释里的声明属实。
- M1：`mockCompletionRepository.ts:103` 已是 `?? input.at`。
- M2：`platformConfig.ts:89-90` 文案与报告逐字一致。

### 7.3 最终复核（针对修复增量）—— 已回填

只读 reviewer 对**修复增量本身**独立复核完毕，**最终计数：BLOCKER = 0 / MAJOR = 0 / MINOR = 2**。

**A / B / M1 / M2 四条均被明确判定「已确认修复，且没有引入新的行为变化」**（reviewer 逐条表态，
不以沉默表示同意）：

| 项 | reviewer 的独立核对要点 |
|---|---|
| A | `:20` / `:117-119` / `:132`（在 `queryOrdersByCompanion` 之前）/ `:168`（在 `findOrderById` 之前）位置全部正确；`materializeCompletionAutoApprovals` 是**同步 `void`**，未把 `await` 塞进原子区段；并**独立复核了「列表也必须挂」**——`toCompanionOrderListItem`（`:84-86`）确实把 `status`/`statusLabel` 放进列表 DTO，`ORDER_STATUS_LABELS` 把 `serving` 渲成「护航中」，只挂详情会让卡片过期；D7（`02-decisions.md:229`）本就写明「打手订单读」在四条路径内。**结论：没有漏掉的第五条路径** |
| B | 顺序正确（`approveCompletion` 的重放判定在它之前，故合法重复点击仍返回 `replayed` 而非 400）；reviewer **独立枚举了 `ORDER_TRANSITIONS` 并得出与协调者相同的结论**——`"completed"` 只出现在 `serving` 的出边里、表内无自环，故 `canTransitionOrder(x,"completed")` ⟺ `x === "serving"`，**这次插入不改变任何一次可达调用的结果**；`kind` 复用不产生混淆，因为对外文案 `STAFF_COMPLETION_ORDER_NOT_SERVING_MESSAGE` 描述的是**订单当前状态**，与「哪一道门拦下」无关 |
| M1 | reviewer **全仓确认 `applyCompletionReview` 只有 3 个调用方**（`completionTransaction.ts:230` / `:296` / `:376`），三者都已被前置步骤钉住 `pending`；唯一写入 pending 的入口 `appendCompletionSubmission`(`:122`) 写死 `reviewedAt: null`，且 store 无种子数据、无 delete 原语 → **不存在任一路径带着非空 `reviewedAt` 来改状态**，`?? ` 与旧写法完全等价 |
| M2 | 新文案与 BF-19A / EX-COMPLETE-05 及 D4 的阻塞判据一致，快照句同时对上 **EX-CONFIG-01** 与 **EX-CONFIG-06**；**判定不构成过度承诺**（既没说成「立即生效」也没承诺历史订单重算），且对 D4 那条待产品确认的取舍保持中性——产品将来改成「永久转人工」也不需要改这句话 |

**文档同步（复核项 C）抽查全部准确**：`database-schema.md` 的五个写入行号逐条对代码
（`:241` / `:290` / `:341` / `:393` / `:442`，**五对全中**；并确认第 6 个 `current.orders.set`
在 `:140`，属支付成功建单、不是状态写入器，表格已用「五个都是同步写入器」划清口径）；
`api-contract.md` §2.11 的客服端 20 与 `tests/staff.test.mjs` 清单逐项相等、打手端 7 与
`app/api/companion/**` 的 7 个 `route.ts` 相等；`directory-structure.md` 三处表述回读核对无误。

**门禁 22 已核实是真门禁**：`tests/completions.test.mjs:206-211` 的 `functionBody` 用
`export\s+(?:async\s+)?function\s+approveCompletion\b` 定位、切到下一个导出之前；
`approveCompletion`(`:165`) 之后第一个导出是 `rejectCompletion`(`:264`)，中间无 `export`，
故取到的函数体**非空且完整**，`indexOf` 不会退化成 `-1 < -1`。删掉第 6 步或把它挪到
领域 Guard 之后**都会红**。

#### 两条 MINOR 的处置

| # | 问题 | 处置 |
|---|---|---|
| m1 | **门禁 23 挡不住「调用被挪到读取之后」**：判据是 `includes(...)`，钉的是**引用**不是**调用点**、更不是**顺序**。删掉 `:132`/`:168` 两行只留包装函数 → 门禁全绿而缺陷 A 复活；把两行移到读之后 → 同样全绿而列表卡片照样过期 | ✅ **已补行为用例**（不显式 sweep、直接读、断言已物化为 `completed`，列表与详情都断言）。**协调者做了受控 mutation 复核**：删调用 → 红、挪到读之后 → 红，两次都是 `actual: 'serving'` vs `expected: 'completed'`（正是缺陷 A 的症状），随后从备份精确还原并 `md5sum` 校验一致。详见 §5.3.1 |
| m2 | 门禁 23 的**失败信息会指错方向**：若有人把两处私有包装收敛成一个公共物化函数（行为完全不变的重构），门禁报的是「漏挂一处」——方向恰好说反了 | ✅ **保留集合相等判据**（它抓真正的漏挂/偷挂），只改**失败信息**，同时点明「漏挂/多挂」与「收敛成公共物化函数（不是缺陷，但必须同批更新这条断言）」两种可能 |

**reviewer 另给 5 条 NOTE**，处置：`n2`（门禁 23 只扫 `lib/services/`，`app/api/**` 或
`lib/data/**` 里偷加清扫不会红）与 `n5`（平台参数 notice 未写「尚未被人工处理」，
判定**不构成过度承诺**——已人工通过时结果同样是 completed、已驳回时字段级提示已覆盖）
**记录在案、不动**；`n1`（门禁 22 是真门禁）**已并入上表**；`n3`（`reviewedAt` 未进
`api-contract.md` §2.8 的「重放不刷新时间戳」清单）与 `n4`（§3.2 声明「本节不重复」却仍留表，
与 §3.1 处理不一致）**均已修**。

⚠️ reviewer 也明说它**无法判断**的：D4（已完结投诉是否阻塞）与 D5（自动审核时长上下限）
是**产品裁定**，它不给建议方案。两条继续挂在 §8.2(c) 与 `04-acceptance.md` 待用户表态。

#### 为什么这份 reviewer 结论对**终态**依然成立

reviewer 的复核发生在 A/B/M1/M2 落地**并清掉 4 个 warning 之后**（它自己实跑 `npx eslint`
得到「无输出（exit 0）」，说明它看到的就是清理后的状态）。复核**之后**只发生了两类改动，
**都不触及它复核过的产品代码**：

1. **`tests/completions.test.mjs` 的增量**——新增 §5.3.1 那条行为用例 + 改门禁 23 的失败信息。
   这两件事**正是 reviewer 的 m1 / m2 两条处置建议本身**，且只改测试；
2. **协调者的 mutation 复核**——临时改写 `lib/services/companionOrders.ts` 后**已精确还原**，
   还原后 `md5sum` 为 `65dacd28d840700b86ef1cbf4a3747c4`，与改写前**逐字节一致**。

因此**被复核过的产品代码在终态没有变化**，`BLOCKER=0 / MAJOR=0` 这一结论直接适用于终态；
**没有**在 reviewer 之后引入未经复核的 `lib/` 改动。（唯一此后新增的产品侧行为是**测试**，
不是运行时逻辑。）

---

## 八、已知局限与跨轮事项

### 8.1 ⚠️ P0-9 前置预检：投诉窗口的 Mock 默认值**在权威文档中没有定义**

本轮结束前做了一次面向下一轮的**只读预检**，结论是 **P0-9 会停在 CLARIFYING**，
且这正是 batch §五 / §十 预先定义的**真停止条件**。证据链如下：

| 来源 | 原文 | 是否给出默认值 |
|---|---|---|
| `docs/03-dev/rounds/cmd_p0-9.md` §二 | 「如果最新权威 requirements / tech-design 已定义当前 Mock 默认值，严格使用；**如果没有定义默认值，不得自行拍值，进入 CLARIFYING**。」 | —— （本条的判据） |
| `docs/01-requirements/超哥电竞_业务流程表.md` BF-22（`:693-722`） | 「投诉窗口时长来自后台平台配置，**不再把“48 小时”写死为不可变规则**」 | **否**——只说明 48h 不再是不可变规则，**没有**说默认值是 48h |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` EX-CONFIG-05（`:781-790`） | 只写「已 completed 订单 `complaintDeadlineAt` 不变 / 新 completed 订单使用新配置」 | **否** |
| `docs/02-tech-design/database-schema.md:520` | 「后续至少扩展：exclusive pool timeout、**CompletionSubmission 自动审核时长（默认 10 分钟）**、投诉窗口时长」 | **否**——同一句里给了一项默认值、**投诉窗口这项刻意没给** |
| `docs/02-tech-design/api-contract.md` §3.4（`:581`） | 列出 `complaintWindowMinutes`：进入 completed 时冻结本单 snapshot/deadline | **否** |
| `docs/02-tech-design/architecture-rules.md:278-280` 的生命周期参数表 | 三行相邻：`exclusive Dispatch timeout` = 「后台可配置」、`CompletionSubmission 自动审核` = 「后台可配置，**默认 10 分钟**」、`completed 投诉窗口` = 「后台可配置」 | **否**——同一张表里，**有默认值就写出来、没有就不写**；投诉窗口那行与 dispatch 超时那行一样只有「后台可配置」 |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md:781-789` EX-CONFIG-05 全表 | 五行：已 completed 订单 / 新 completed 订单 / Earning·Chat / 审计 / 状态 | **否** |
| 同表紧邻的 EX-CONFIG-06（`:793` 起） | **有一行 `\| 默认值 \| 10 分钟 \|`** | 对照项——**同一份文档、相邻两节、同样的表格形状，一节写了默认值一节没写** |

**这张表里最硬的一条是 EX-CONFIG-05 与 EX-CONFIG-06 的对照**：两者是同一份文件里
紧邻的两节、表格形状相同、都由「管理员改配置而历史单据已在途」触发，唯一的结构差异就是
EX-CONFIG-06 多了一行 `| 默认值 | 10 分钟 |`。一行之差把「故意不写」和「漏写」区分开了
——**如果默认值是 48h，这里就是写 48h 的地方**。

**因此 P0-9 的 Requirement Check 将判定：投诉窗口的 Mock 默认值属于「文档未定义的默认时间」，
按 batch §五 / §十 与 `cmd_p0-9.md` §二 的明文要求，不自行拍值，停下来向产品负责人要一个数。**

补充佐证：`grep -rn "48" lib/ app/ components/` 在**代码里找不到任何 48 小时的硬编码**——
即「48h」既不是文档默认值，也不是既有实现值，凭空取它没有任何依据。

⚠️ 该预检**没有触碰任何文件**，只是读文档。

### 8.2 其它跨轮事项

**（a）必须在 P0-9 前/中裁决的两件事**

1. **`applyOrderServing` 的 `servingAt: order.servingAt ?? at`** —— P0-7 reviewer 的
   n1 问题（"开始服务时间"被重复调用时是否应刷新）。本轮**未裁决、未改动**该语义。
2. **`applyCompletionReview` 不校验起始状态**（reviewer 的 N1 隐患）：它只按 id 改状态，
   **不检查**当前态是否允许这次迁移；`pendingSubmissionIdByOrder` 索引也**只在它内部清除**。
   P0-9 的作废（`invalidated`）**不得直接复用它**——作废需要一个走中央状态机、
   并明确处理 pending 索引的新入口。此约束已写入 `api-contract.md` §2.8 的 ⚠️。

**（b）本轮记录在案、但不属本轮范围的事项**

| # | 事项 | 建议 |
|---|---|---|
| 1 | `docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md`（未跟踪，**文件名被 GBK 破坏**的 P0-6.1 指令副本，内容已逐字保存在 `P0-6.1/01-prompt-extended.md`） | 用户提交前**删除**；AI 不做 Git 写操作，故未删 |
| 2 | `CLAUDE.md` 过期计数：「Tests \| 51 files, 1011 cases」应为 63 / 1221；`page.tsx` 73 → **77**；`route.ts` 115 → **124** | 由用户决定何时更新（本轮范围外） |
| 3 | 打手端写路由的 **HTTP 200 happy-path 覆盖不足**（`completionHttp.test.mjs` 只 4 条） | 列为技术债 |
| 4 | 列表页 `<h1>` 用了 `STAFF_COMPLETION_DETAIL_TITLE` 这个常量（命名偏详情） | MINOR，未改 |
| 5 | P0-6 的两条断言在本轮被改写成更强的形式 | 已记录，无需动作 |
| 6 | 生产烟测剥离函数改名 `stripScripts` → `stripBuildArtifacts` | 已修，见 §六 第一轮说明 |

**（c）两处待产品确认（不阻塞本轮，但需在验收时确认）**

- **D4**：退款 / 投诉进行中时**阻塞**自动审核的语义（`02-decisions.md`）。
- **D5**：新参数 `completionAutoApprovalMinutes` 的**上下限**（`02-decisions.md`）。

**（d）⚠️ 给 P0-9 的一个具体预警：门禁 23 的期望集合会需要长大**

门禁 23 断言 `sweepCompletionAutoApprovals(` 的调用点**恰好**是那四个文件。
P0-9 要新增 `sweepMaturedEarnings(at)` 并把它挂到读取路径上——而**完成材料的自动通过
正是产生 Earning 的那一步**，所以 P0-9 的收益读取路径很可能需要**同时**物化两件事。
届时门禁 23 会**如期变红**，这是**预期行为**而不是回归：正确处理是
**同时扩充门禁 23 的期望集合**（把新增的调用文件加进去），而**不是**放宽成 `includes`、
更不是**不挂**清扫（后者会让「deadline 已到但没人读过订单」时收益永远不释放）。
已在 `04-acceptance.md` 与 `api-contract.md` §2.8 记录同一件事的两个侧面。

---

## 九、Git 状态（只读）

```
HEAD            = 249f7c1adefc2c9d9e7f37bb26adde0bc45808df
分支            = feat/order-lifecycle-alignment
tracked 改动    = 35 files changed, 1628 insertions(+), 191 deletions(-)
untracked       = 51 项（其中本轮新增 29 项：24 个代码/测试 + 5 个本轮档案）
```

- 本轮**未执行任何 Git 写操作**（batch §十二）：无 `add` / `commit` / `push` /
  `reset` / `restore` / `checkout` / `rebase` / `amend`。只用了
  `git status` / `git diff` / `git log` / `git rev-parse`（皆只读）。
- untracked 里的**非本轮产物**：`docs/03-dev/rounds/cmd_*.md` 与
  `cmd_batch_p0-6.1_to_p0-9.md`（**用户提供的指令原件，只读不改**）、
  `docs/03-dev/rounds/docs03-devroundscmd_p0-6.1.md`（见 §8.2(b) 第 1 条）。
