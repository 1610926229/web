# P0-9 — 交付记录

Round: P0-9
**Status: AWAITING_ACCEPTANCE**
Recorded At: 2026-09-24
Depends On: P0-8（两条完成来源已落地）· P0-1（平台参数真值源）· P0-5（投诉 / 售后）

> **本文件取代了本轮的早期版本。** 本轮第一次开工时停在 `CLARIFYING`
> （投诉窗口默认值的产品决定未定义），当时的交付记录写的是「代码 delta = 0 行」。
> 产品负责人于 2026-09-24 裁定 `Q1`（`02-decisions.md` §八 D16~D18）后本轮继续开发，
> 因此「未交付」那一版记录的**只是一个中间状态**，不是本轮结论。
> 中间状态的完整依据保留在 `02-decisions.md` §一~§七（提问原文、证据链、落点映射）。

---

## 一、本轮做了什么（`01-prompt.md` §二~§十一 逐节对照）

| `01-prompt.md` | 要求 | 落点 |
|---|---|---|
| §二 | 投诉窗口来自现有 `PlatformConfig`、后台可配置、订单进入 completed 时冻结 snapshot/deadline、改配置不追溯 | `lib/constants/platformConfig.ts`（第三个参数族）、`lib/data/adminPlatformConfigTransaction.ts`、`lib/services/adminPlatformConfig.ts`、`components/admin/AdminPlatformConfigConsole.tsx`；冻结发生在 `lib/data/mockPaymentRepository.ts` 的 `applyOrderCompletion` |
| §三 | 「投诉窗口快照 + Earning 创建」接入 staff approve 与 System auto approve 的**统一业务路径**，禁止两套 | `lib/data/earningTransaction.ts` 的 `settleOrderCompletion()` 是**唯一**结算入口；`approveCompletion` 与 `sweepCompletionAutoApprovals` 都只调用它 |
| §四 / §五 | Earning 独立领域；针对**实际履约打手**生成一条；金额**直接用** `Order.companionBaseIncome`；初始 `frozen`；同一 order 不得有第二条有效 Earning | `lib/types/earning.ts`、`lib/data/mockEarningRepository.ts`（`earningIdByOrder` 索引即唯一性）、`settleOrderCompletion` 的三道重复防线 |
| §六 | deadline 前允许普通投诉、deadline 后关闭；特殊人工申诉不做且不得写成「永远没有人工处理可能」 | `lib/constants/complaints.ts` 的 `isComplaintWindowClosed()` + `COMPLAINT_WINDOW_CLOSED_MESSAGE`；`lib/services/complaints.ts` 的写入门禁；`lib/services/orders.ts` 的 `canSubmitComplaint` |
| §七 | `sweepMaturedEarnings(at)` 同步、幂等；到期 + 无阻塞 → `available`；重复 sweep 不刷新 `availableAt`；阻塞解除后可释放；不接后台任务基础设施 | `lib/data/earningTransaction.ts` 的 `sweepMaturedEarnings()` |
| §九 | 最小「我的收益」读取（复用打手工作台、只看自己、不看平台净利润、不做提现） | `lib/services/companionEarnings.ts`、`app/api/companion/earnings/route.ts`（GET only）、`app/companion/(console)/earnings/page.tsx`、`components/companion/CompanionEarningList.tsx` |
| §十 | 平台参数管理加入投诉窗口，复用现有 service/repository/audit，不新建第二套配置表 | 同一个 `PlatformConfig` + 同一个 `/api/admin/platform-config` + 同一份审计；审计快照补 `complaintWindowMinutes` |
| §十一 | 三件事不得半写；伪事务区段不得 `await`；「一个 order → 一条有效 Earning」 | `settleOrderCompletion` / `sweepMaturedEarnings` 都是**同步函数**（没有 `async` 外壳，因此原子区段内不可能有 `await`——这是类型上的事实，不是注释约定） |

---

## 二、本轮新增文件（11 个，1950 行）

| 文件 | 行 | 职责 |
|---|---:|---|
| `lib/types/earning.ts` | 157 | `Earning` + `EarningStatus`（四态）+ 打手端 DTO（`CompanionEarningItem` / `CompanionEarningSummary` / `CompanionEarningListData`） |
| `lib/constants/earnings.ts` | 109 | 状态文案 / 颜色 / 一句话说明、`isEarningMatured()`、无数字的说明文案、页面标题 |
| `lib/data/earningRepository.ts` | 44 | **只读**仓储接口（`listEarningsForCompanion` / `findEarningByOrderId`） |
| `lib/data/mockEarningRepository.ts` | 124 | Mock Store（`earning` 域，**无种子数据**）+ 同步原语 `appendEarning` / `applyEarningRelease` |
| `lib/data/earningTransaction.ts` | 194 | **唯一结算入口** `settleOrderCompletion` + 到期解冻 `sweepMaturedEarnings` |
| `lib/data/orderBlocking.ts` | 57 | `readOrderBlockingFacts()`——「有没有进行中退款 / 未完结投诉」的**唯一读取处**，P0-8 与 P0-9 共用 |
| `lib/services/companionEarnings.ts` | 125 | DTO 拼装 + 两条 sweep 的惰性物化（先完成、后解冻） |
| `app/api/companion/earnings/route.ts` | 29 | `GET` only |
| `app/companion/(console)/earnings/page.tsx` | 96 | 「我的收益」页（Server Component 直连服务层） |
| `components/companion/CompanionEarningList.tsx` | 102 | 收益卡片列表（纯展示、无写操作） |
| `tests/earning.test.mjs` | 913 | 27 条用例，覆盖 §十五 的九个审查面 |

---

## 三、本轮修改的**共享文件**（18 个）——逐文件写清「本轮改了哪一段」

⚠️ 工作区里同时躺着 P0-6.1 / P0-7 / P0-8 的未提交改动，因此下面每个文件都**只列本轮的区段**。

| 文件 | 本轮的区段 / 职责 | 哪些属于前序 Round（不算本轮） |
|---|---|---|
| `lib/types/order.ts` | 新增 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt` 两个字段与它们的语义注释 | `actualCompanionId` / `servingAt` / `companionBaseIncome` 等（P0-4~P0-8） |
| `lib/data/mockPaymentRepository.ts` | `applyOrderCompletion()` 的签名加第三个入参 `complaintWindowMinutes`，并在**同一个写入点**写下 `completedAt` / 快照 / `complaintDeadlineAt`；`plusMinutes` import | 派单超时退款、接单、开始服务、完成材料等原语（P0-1~P0-8） |
| `lib/data/completionTransaction.ts` | `approveCompletion` 的第 9 步改为调用 `settleOrderCompletion`；`sweepCompletionAutoApprovals` 改用 `readOrderBlockingFacts` + `settleOrderCompletion`；import 清单增删 | 提交 / 驳回 / 自动审核的主体逻辑（P0-8） |
| `lib/constants/complaints.ts` | 文件末尾新增 `isComplaintWindowClosed()` 与 `COMPLAINT_WINDOW_CLOSED_MESSAGE` | 投诉状态、类型、列表规则 |
| `lib/services/complaints.ts` | `createComplaintForUser` 在归属校验之后、任何写入之前加窗口门禁 | 原有提交 / 查询逻辑 |
| `lib/services/orders.ts` | `canSubmitComplaint` 由恒 `true` 改为 `!isComplaintWindowClosed(...)` | 列表 / 详情 / 时间轴 |
| `lib/constants/platformConfig.ts` | 第三个参数族：默认 `1440`、上下界 `60~10080`、`isValidComplaintWindowMinutes`、非法提示、`PLATFORM_CONFIG_NOTICE` 改写 | `publicPoolTimeoutMinutes`（P0-1）、`completionAutoApprovalMinutes`（P0-8） |
| `lib/types/platformConfig.ts` | `PlatformConfig.complaintWindowMinutes` + `AdminPlatformConfigPatch` 的第三个可选字段 | 前两个字段 |
| `lib/mocks/fixtures/platformConfigSeed.ts` | 种子加 `complaintWindowMinutes` | 前两个字段 |
| `lib/data/adminPlatformConfigTransaction.ts` | `PlatformConfigInput` 第三个字段；**`PATCHABLE_FIELDS: Record<keyof PlatformConfigInput, true>`** 新写法 + 遍历式 no-op 判定 | 幂等键 / 审计 / 单例写入 |
| `lib/constants/adminAudit.ts` | `toPlatformConfigAuditSnapshot` 带上 `complaintWindowMinutes` | 审计条目结构 |
| `lib/services/adminPlatformConfig.ts` | `readComplaintWindowMinutes()` 解析 + 空 PATCH 判定 + 传给事务 | 前两个参数的解析 |
| `lib/data/mockStore.ts` | `MockStoreName` 新增 `"earning"` | 其余 25 个域 |
| `lib/mocks/fixtures/orderSeed.ts` | 订单构造器写两个 `null` 字段（**刻意不回填**历史订单） | 种子订单数据 |
| `lib/services/checkout.ts` | `buildOrder` 写两个 `null`（冻结发生在完成，不在下单） | 下单 / 分账快照 |
| `components/admin/AdminPlatformConfigConsole.tsx` | 第三个独立保存的输入框（草稿 / 错误 / 保存 / 放弃） | 前两个输入框 |
| `app/companion/(console)/page.tsx` | 删掉「后续开放」清单，改为只含 `COMPANION_SCOPE_NOTICE` 的说明卡 | 工作台概览其余部分 |
| `lib/constants/companionConsole.ts` | 导航加「我的收益」（排在「我的订单」之后）；`COMPANION_SCOPE_NOTICE` 改为如实文案；**删除** `COMPANION_COMING_SOON_*` | 导航其余项、身份说明 |

---

## 四、本轮修改的测试文件

| 文件 | 本轮改动 | 性质 |
|---|---|---|
| `tests/earning.test.mjs` | **新建**（见上表） | 新覆盖 |
| `tests/platformConfig.test.mjs` | 三处：空 PATCH 断言补第三个字段；**新增**「只带池超时 → 保留投诉窗口原值」；no-op 判据用例扩到三个字段 | **加密** |
| `tests/companion.test.mjs` | 清单 7 → 8 条（`earnings/route.ts`，GET / `requireCompanion` / `listCompanionEarnings`）+ 数量断言与标题同步 | **加密** |
| `tests/completions.test.mjs` | 门禁 23 的调用方白名单四条 → 五条（`companionEarnings.ts`），失败文案补因果说明 | **加密** |
| `tests/companionAccess.test.mjs` | 资格调用点显式清单五处 → 六处（收益页） | **加密** |
| `tests/companionConsoleNav.test.mjs` | `(console)` 页面集合五页 → 六页 | **加密** |

⚠️ 五处清单门禁**全部是补进逐字清单**（`assert.deepEqual` 的完整数组），
**没有一处**改成「包含 / 至少 / 长度 ≥」——这一点请 reviewer 单独核对，见 §七。

---

## 五、本轮**刻意不做**的事

- **不回填历史**：P0-9 之前已 completed 的订单**不补**窗口快照、**不建** Earning（`02-decisions.md` D19）。
  补窗口等于用今天的配置改历史订单；补收益等于用历史的 `completedAt` 造出一笔「早该解冻」的钱。
- **不留假记录**：没有 `actualCompanionId` 时不建 `companionId: ""` / 金额 0 的占位（D23）。
- **不做提现**：收益页没有任何写入口，也没有「敬请期待」按钮；`withdrawn` / `reversed` 只有类型占位。
- **不接 Scheduler**：三条 sweep 仍挂在读取路径上惰性触发（与 P0-1 / P0-8 同一条机制），
  真实调度器仍是上线前阻塞项（`architecture-rules.md` §5.3 / §7.1）。
- **不新增产品通知**：`01-prompt.md` 未要求（沿用 P0-8 的 D6 口径）。
- **不动 `OrderStatus`**：`Earning` 是独立领域（`01-prompt.md` §十一 与批次 §十一）。
- §十三 的 out of scope 项（钱包账本 / 人工余额调整 / 会费批扣 / 部分退款冲正 /
  已提现退款追偿 / 封禁回池 / 客服换人 / 特殊过期申诉 / DB / ORM）一项未做。

---

## 六、门禁结果（2026-09-24，**reviewer 修复后复跑**）

> ⚠️ 下表是**修复两条 MAJOR 之后**重跑的读数（见 §七）。修复前的旧读数是
> `1250 / 1122 / 0 / 128`——两处差异有明确来源：新增 `tests/earningsHttp.test.mjs`（4 条 HTTP，
> 离线时归入 skip）+ 新增 `结算 21d`（1 条离线用例）。**文件数 64 → 65。**

| 门禁 | 命令 | 结果 |
|---|---|---|
| targeted | `node --test tests/earning.test.mjs`（修复 M1 后单独复跑） | **28 tests / pass 28 / fail 0 / skip 0** |
| 全量 | `pnpm test` | **1255 tests / pass 1123 / fail 0 / skip 132** |
| 类型 | `pnpm typecheck`（`next typegen && tsc --noEmit`） | exit 0 |
| 静态 | `pnpm lint`（ESLint CLI） | exit 0，0 error 0 warning |
| 构建 | `pnpm build` | exit 0；路由表含 `ƒ /api/companion/earnings` 与 `ƒ /companion/earnings` |
| **生产全量** | `APP_BASE_URL=http://127.0.0.1:3100 pnpm test`（`next start` 生产构建） | **1255 tests / pass 1255 / fail 0 / skipped 0** |

**skip 132 条的构成**：全部是 `APP_BASE_URL` 门控的 HTTP 套件（未起服务时跳过，本轮新增 4 条），
与既有口径一致；生产模式下**归零**（上表最后一行）。

⚠️ 生产模式那一跑用的是 **3100** 端口：用户自己的 dev server 占着 3000（PID 31540），
本轮全程**没有**碰它。3100 的进程已按 `netstat` + `taskkill //T //F` 收干净
（`netstat` 复查无 `:3100` LISTENING，且 3000 上的 PID 31540 仍在）。

⚠️ **受控 mutation 复核在门禁之外单独做了一次**（见 §7.4）：临时把 M1 新增的 Guard 改成
`if (false)` → `tests/earning.test.mjs` **变红 1 条**（`结算 21d`，失败点 `true !== false`），
恢复后复跑 `28 / 28 / 0`。这一步改过**工作区源码**并已**按备份原样恢复**，
**不是** Git 写操作。

---

## 七、reviewer 结论

**审查方式**：`reviewer-agent` 只读审查（Read / Grep / 只读 Bash），**未修改任何文件、未执行 Git 写操作**，
也**没有复跑门禁**（只读约束）——它核对的是**磁盘事实**与**门禁文本**，门禁读数按交付方声明对待。

**首轮结论：`BLOCKER = 0 / MAJOR = 2 / MINOR = 5 / NOTE = 5`。**

### 7.1 两条 MAJOR（**已全部修复**）

| # | 问题 | 为什么是 MAJOR | 修法 |
|---|---|---|---|
| **M1** | `settleOrderCompletion` 只有「已是 `completed`」这一条短路，**没有起始状态 Guard**。函数头注释声明「只发生在 `serving → completed` 那一次迁移上」，但函数自己**不守这条不变量**：对一张 `paid` 订单直接调用，会把订单写成 `completed`、写下 `completedAt` / 快照 / deadline，并在 `actualCompanionId` 有值时**当场铸出一条 `frozen` 收益**。今天不可达（两个调用点都在同步区段内先判过 `serving`），但「将来多一个调用方」（真 Scheduler、退款冲正、封禁回池）不会有任何测试变红。**且本轮自己的测试 `结算 21b` 正是拿 `paid` 订单走的这条非法路径，却只断言收益、对「订单已被改成 completed」一字未提** | 它守的是「资金事实只能由授权路径产生」，不变量没有强制力就等于没有 | ① `lib/data/earningTransaction.ts`：补一条与 `completed` 分支**对称**的短路——不是 `serving` 就一个字都不写、原样返回既有事实；② 测试 `结算 21b` 改从**合法来源状态**构造 D23 场景（直接写 store 造一张 `serving` 且 `actualCompanionId` 为 null 的单），并**新增 `结算 21d`**：`paid` / `accepted` / `refunded` 三种起始状态**各带一个有值的 `actualCompanionId`**，断言状态不被改写、`completedAt` / 快照 / deadline 都不产生、一条收益都不写。⚠️ `applyOrderCompletion` **故意不加**这条判定——`apply*` 系列与 `applyApplicationReview` 同约定「只写不判」，已把这个取舍写进函数头注释 |
| **M2** | 本轮新增的受保护接口 `GET /api/companion/earnings` **没有自动化权限矩阵**。清单门禁（`tests/companion.test.mjs`）是**源码结构**断言，不是运行时状态码断言；前三轮为每个新增打手接口都配了 `APP_BASE_URL` 门控的 HTTP 矩阵，这是**唯一缺的一个**。当时 §A.2 的生产读数 `1250 / 1250` 隐含「新接口也在 HTTP 面上跑过」，而离线读数里看不到它的任何运行时断言 | `用户权限表` §13 第 8 条要求**测试**覆盖 401 / 403 / 正常结果；手工步骤跑一次就过、不随代码演进回归 | 新增 **`tests/earningsHttp.test.mjs`**（4 条，`APP_BASE_URL` 门控，未设则整批 skip）：① 未登录 / 伪造 Cookie / 不存在的用户 id / 带查询参数 → **401**；② 普通用户 `u-1001` → **403**，**只带客服 Cookie → 401（不是 403）**；③ 有效打手 `u-1022` → **200**，信封恰好三个键、`summary` 恰好三个键、`count === items.length`、两个桶恒为整数分、桶之和 = 列表之和，且**信封与每一项都不带** 10 个禁用键（`companionId` / `clubNetIncome` / `userPaidAmount` / `companionRateBp` / `withdrawnAt` / `reversedAmount` / `fineAmount` / `userId` / `order` / `earning`）；④ `POST` / `PUT` / `PATCH` / `DELETE` → **405**，且写尝试前后条数不变。⚠️ **刻意不在 HTTP 用例里造一笔真的完成**（会污染共享内存），因此「有新收益时字段恰好八个」仍由 `tests/earning.test.mjs` 在服务层钉住 |

### 7.2 五条 MINOR

| # | 问题 | 处置 |
|---|---|---|
| **m1** | `/complaints/new` 的订单选择器不认「窗口已关闭」，用户会填完 5~100 字才被接口 400 拒掉——这正是 `D21` 想避免的 | **本轮刻意不改**，见 `02-decisions.md` **D25**：最小修法要在订单列表 DTO 上加字段，而 §八 要求投诉模块只做「必要最小联动」。已登记为独立待办 |
| **m2** | 批次报告 §D.7A 第 50 条把「客服会话 → **403**」写成了预期，**实际是 401**（客服是另一套 Cookie，打手上这个接口看到的是「未登录」） | **已修**：批次报告 §D.7A 改为「普通用户 → 403 / 只带客服 Cookie → 401」，`04-acceptance.md` §E 同步更正，**并由 `tests/earningsHttp.test.mjs` 第 2 条钉成自动化断言**（实测确认：403 与 401 各一次对照） |
| **m3** | `api-contract.md` §3.2 的「打手端 **7** 条」与 §2.11 门禁表的「**8**」不一致（清单已是 8 条、磁盘也是 8 个路由文件） | **已修**：§3.2 改为 **8** |
| **m4** | `BF-22` 里的字段名 `complaintWindowSnapshot` 与实现 / 技术设计 / 产品裁定用的 `complaintWindowMinutesSnapshot` 不一致；且该条状态仍标 `⏳`（语义是「依赖前置、暂未实现」） | **已修**：需求文档改为实现所用的名字，状态 `⏳` → **`🟡 已实现（P0-9），待统一人工验收`**（按该文件 §1 图例）。⚠️ `cmd_p0-9.md` 与 `P0-9/01-prompt.md` 里的旧名**不改**——那是原始指令的逐字档案 |
| **m5** | `04-acceptance.md` 仍是 `CLARIFYING` 那一版「无内容可验收」，与已交付的事实矛盾（reviewer 读到的正是旧版） | **已修**（**在 reviewer 出具结论之前**即已重写）：现为真实的 P0-9 验收清单，`CLARIFYING` 那一版按「追加历史、不覆盖历史」降级为本文件 §五 |

### 7.3 五条 NOTE（**不要求动作**，已登记）

| # | 提醒 | 处置 |
|---|---|---|
| **n1** | 完成后被全额退款的订单，其 `Earning` 不会作废 / 冲正（`sweepMaturedEarnings` 只在**进行中**退款存在时挡一下） | 属 `EX-REFUND-05`（⏳ 后续批次），P0-9 §十三 已明文排除。已写入批次报告 §E.2 与 `02-decisions.md` **D26**：将来接这条迁移时必须复用 `settleOrderCompletion` 的同一原子区段，**不要另起一条只改 `Earning` 的路径** |
| **n2** | **未关联订单的投诉**既不构成阻塞、也不受窗口限制（`readOrderBlockingFacts` 只认 `complaint.orderId === orderId`） | 继承自 P0-8 `D4` 的口径，已在该文件 §五登记为待产品确认项。**本轮不自行收紧** |
| **n3** | 用户端**看不到投诉截止时刻**（详情只给布尔），窗口关闭后是「提交时才被告知」 | `D18` 只裁定了「单位在 UI 上怎么呈现」，未裁定是否展示截止时刻 → **需要产品决定**，本轮不作为缺陷。已登记 |
| **n4** | reviewer **未复跑门禁**（只读约束） | 已如实记录；本文件的 §六 读数是交付方自己跑的，reviewer 独立核对的是磁盘计数与门禁文本 |
| **n5** | 审查期间文档仍在被修改（批次报告 §D.8 / §E.1 已由「Q1 OPEN」更正为「已裁定」），`04-acceptance.md` 当时是唯一没跟上的 | 已全部跟上；本轮**没有并行改同一文件**的多个写入者 |

### 7.4 M1 的**受控 mutation 复核**（交付方自己做的，2026-09-24）

「新增了守卫」和「测试真的能锁住这条守卫」是两件事。因此把 `earningTransaction.ts` 里
新加那一行的条件从 `order.status !== "serving"` 改成 `false`（= 等价于**把守卫删掉**），
只跑 `tests/earning.test.mjs`：

```
✖ 结算 21d：起始状态不是 serving 时一个字都不写——未开始服务的订单不可能被结算函数变成已完成
  AssertionError [ERR_ASSERTION]: [paid] 这不是一次合法迁移，不允许有写入
  true !== false
ℹ tests 28 · pass 27 · fail 1
```

**结论**：守卫被删掉时测试**确实变红**，且失败点正是「发生了写入」（`changed: true`）。
恢复后重新跑：`28 / 28 / fail 0`。

> ⚠️ 这一条是本轮**唯一**一处「用修改代码来验证测试」的动作，改的是**工作区里的源码**，
> 已在同一步内**按备份原样恢复**并复跑确认（不是靠记忆改回来）。
> 该动作**不是 Git 写操作**：没有 `add` / `commit` / `stash` / `checkout` / `restore`。

### 7.5 第二轮只读复核（**终局结论**）

把 §7.1 的两条修复连同新增的 `tests/earningsHttp.test.mjs` 送回**同一个** reviewer 复核
（只读：Read / Grep / 只读 Bash，未修改文件、未复跑门禁）。

**终局：`BLOCKER = 0 / MAJOR = 0`，`MINOR = 3`（下表三条，全部处置）；NOTE 均为对既有技术债的复述、
不要求动作，其中唯一一条带动作建议的列在下表最后一行，其余不逐条转述（沿用 §7.3 的 `n1`–`n4` 口径）。**

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| **M1 / M2** | ~~MAJOR~~ | 首轮两条 MAJOR | ✅ **已确认修复**。reviewer 独立确认：把新加的那条起始状态 Guard 删掉后，`结算 21d` **确实变红**——与我在 §7.4 自己做的受控 mutation 复核**结论一致**（两条独立证据指向同一件事：这条守卫是被测试锁住的，不是只写在注释里的） |
| **m-a** | MINOR | 「交付文档里的门禁读数还是修复前的旧数」 | ✅ **已修**——即 §六 本次改写（`1250 / 1122 / 128` → `1255 / 1123 / 132`；生产 `1250/1250` → `1255/1255`） |
| **m-b** | MINOR | reviewer 读到的 `02-decisions.md` 里没有 `D25` / `D26`（当时尚未写下） | ✅ **已消解**——`D25`（投诉选择器本轮刻意不改 + 理由 + 将来怎么修）与 `D26`（全额退款后 `Earning` 不作废，将来接这条迁移必须复用同一原子区段）现已写入该文件 |
| **m-c** | MINOR | 我在 `tests/earningsHttp.test.mjs` 里新加的「客服 Cookie → 401」断言**没有 `else` 分支**：一旦客服端开关关闭或预置被改，这整段断言会**静默蒸发**而用例仍然绿着——这正是它唯一要防的事 | ✅ **已修**：照 `completionHttp.test.mjs` 的写法补上 `else` 分支（开关关闭时改用**伪造** `mock_staff_id` Cookie 断言同样的 401），并在文件内注明「两条分支都必须有断言」。生产模式复跑该套件 **4 / 4 pass** |
| **n-a** | NOTE | 可选的结构门禁：给 `applyOrderCompletion` 的**调用点**再加一条「只有 `settleOrderCompletion` 可以调它」的源码断言 | **本轮不加**（记为 NOT）。已有三层保护：① 两条完成路径**都**走 `settleOrderCompletion`（`tests/completions.test.mjs` 门禁 23 已钉住清扫函数的调用顺序）；② 函数自身的起始状态 Guard（M1 已补）；③ `earningIdByOrder` 的「一单一条」约束。再加一层源码扫描，收益低于它的脆弱性（会随文件搬迁误报） |

> 📌 **本节只列 reviewer 明确指出、且本轮需要作答的条目。** 其余 NOTE 是对 §7.3 已登记技术债的复述
> （投诉选择器 `m1`、未关联订单投诉不受窗口限制、用户端看不到截止时刻、`companionRateBp` 上线前移除等），
> 本轮不重复转述、也不改变各自既有的处置结论。
> 📌 reviewer **未复跑门禁**（只读约束）——§六 的读数是交付方自己跑的；reviewer 独立核对的是磁盘计数与门禁文本，
> 并对 M1 做了**独立的删守卫验证**（与 §7.4 我的受控 mutation 复核结论一致）。

**修复内容见 §7.1，重跑门禁读数见 §六。** 至此 P0-9 的两条 MAJOR 已修复、
三条 MINOR 已全部处置，终局 `BLOCKER = 0 / MAJOR = 0`。

---

## 八、与文档的同步（本轮同时完成）

| 文档 | 同步内容 |
|---|---|
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md` | `EX-CONFIG-05` 补默认值与取值范围（前置窗口，与 D16 一致） |
| `docs/01-requirements/超哥电竞_业务流程表.md` | `BF-22` 的投诉窗口默认值 |
| `docs/02-tech-design/database-schema.md` | §19 PlatformConfig 三参数与冻结规则；§T2 由 TARGET 翻为 **CURRENT**；§T3.1 同样翻为 CURRENT；store / 仓储计数 23 → 26 |
| `docs/02-tech-design/api-contract.md` | §3.7 由 TARGET 翻为 **CURRENT**（含实现要点）；§三 打手端清单 7 → 8 条与负向门禁改写；§2.11 门禁表 |
| `docs/02-tech-design/architecture-rules.md` | §5.3 deadline 表的四项状态；§7.1 的 P0-7/P0-8/P0-9 行由「未实现」改为「已实现」；store 计数 |
| `docs/02-tech-design/directory-structure.md` | 新增 §E（收益域落点与三条规则）；§D 补第四个参数的改动面；打手端路由清单补两条 |
| `CLAUDE.md` | 事实表（route / page / layout / test 文件计数） |
| `docs/03-dev/总需求进度表.md` | P0-9 行与「打手收益」行 |
| `docs/03-dev/rounds/README.md` | P0-9 行状态 |
| `docs/03-dev/rounds/BATCH_p0-6.1_to_p0-9_最终报告.md` | §B.4 / §C / §D / §E.1 由「P0-9 未交付」改为交付事实 |

---

## 九、中间状态的历史（不覆盖）

本轮第一次开工停在 `CLARIFYING`，那一版的交付记录写的是「代码 delta = 0 行」。
`Q1` 由产品负责人裁定后本轮继续开发，**该中间状态不是本轮结论**；
提问原文、证据链与「为什么必须问」保留在 `02-decisions.md` §三 / §八。
批次纪律上仍成立的一点：**那一版的停止符合 `cmd_p0-9.md` §二 与批次 §五 的停止条件**，
不是失败，也不是被推翻的决定。
