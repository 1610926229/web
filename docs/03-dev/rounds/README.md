# Round 目录说明

本目录保存**每一个开发批次的完整决策档案**。

**协议正文见 [`../development-workflow.md`](../development-workflow.md)。**

---

## 目录命名

```
docs/03-dev/rounds/<ROUND_ID>/
```

`<ROUND_ID>` = 批次编号，与全局进度表一致：`P0-5.5` / `P0-6` / `P1-1` …

## 每个 Round 固定五个文件

| 文件 | 职责 |
|---|---|
| `README.md` | 快速索引：Round ID、状态、依赖、时间、commit |
| `01-prompt.md` | **原始开发指令档案**——原样保存，不总结不改写 |
| `02-decisions.md` | 问题、用户回答、最终执行口径 |
| `03-delivery.md` | 实现结果、文件变更、测试、验证记录 |
| `04-acceptance.md` | 人工验收结果 |

**不要额外创建没有明确职责的文档。**

---

## 状态

```
PLANNED → CLARIFYING → READY → IN_PROGRESS → AWAITING_ACCEPTANCE → DONE
                                                                    ↑
                                            （另：BLOCKED）
```

**⚠️ Claude 完成编码后只能标 `AWAITING_ACCEPTANCE`。**
**`DONE` 需要两个条件同时满足：用户明确说验收通过 + 用户已自行 Git commit。**

---

## 两条不可协商的规则

1. **`02-decisions.md` 是追加历史，不覆盖历史。**
   决定改变时保留 `Decision V1 (SUPERSEDED)` 与 `Decision V2 (CURRENT)`。

2. **存在 `Status: OPEN` 的决策时，禁止开始业务编码。**
   停在 `CLARIFYING`，向用户提问，等待回答。

---

## Round 索引

| Round | Title | Status | Git Commit |
|---|---|---|---|
| [`P0-5.5`](./P0-5.5/README.md) | 小型架构稳定化 | `DONE` | `6bd10fc` |
| [`P0-6`](./P0-6/README.md) | accepted 主动取消接单 + 重新进入公共池 | `DONE` | `53481ea` |
| [`DEV-1`](./DEV-1/README.md) | Mock 身份切换验收工具（开发 / 测试基础设施） | `DONE` | `53481ea` |
| [`P0-6.1`](./P0-6.1/README.md) | 验收后整改：FIX-1 工作台返回用户端 + FIX-2 订单池「等待最久优先」 | `DONE` | `eef4e62` |
| [`P0-7`](./P0-7/README.md) | `accepted → serving` —— 由当前实际打手点击「开始服务」 | `DONE` | `eef4e62` |
| [`P0-8`](./P0-8/README.md) | CompletionSubmission + 客服审核 + 10 分钟自动审核 | `DONE` | `eef4e62` |
| [`P0-9`](./P0-9/README.md) | Earning.frozen + 可配置投诉窗口 + `frozen → available` | `DONE` | `eef4e62` |
| [`P0-10`](./P0-10/README.md) | 客服全量订单查询工作台（`/staff/orders` + `/staff/orders/[id]`） | `AWAITING_ACCEPTANCE` | —— |
| [`P0-11`](./P0-11/README.md) | 客服换打手 + 打手禁用回池 + pending `CompletionSubmission` 失效 | `AWAITING_ACCEPTANCE` | —— |
| [`P0-12`](./P0-12/README.md) | `paid` / `accepted` 用户免审批全额退款（`Order → refunded`） | `AWAITING_ACCEPTANCE` | —— |
| [`P0-13`](./P0-13/README.md) | `serving` / `completed` 售后 + Admin 最终退款金额 + Earning 联动 | `AWAITING_ACCEPTANCE` | —— |

> 🔵 **`P0-10` 是批次 [`cmd_batch_p0-10_to_p0-13.md`](./cmd_batch_p0-10_to_p0-13.md) 的第一站**
> （P0-10 → P0-11 → P0-12 → P0-13），2026-09-24 交付。
> 开发完成 + 自动门禁全绿 + 只读 reviewer 复核**已结束并整改完毕**，**等用户本人验收**（`04-acceptance.md`）。
> ✅ reviewer 初判 **BLOCKER 0 / MAJOR 1 / MINOR 4 / NOTE 7**，那 1 条 MAJOR 是**回归保护缺失**
> （两条新接口此前没有任何 HTTP 级测试，`null → 404` 这条映射在全仓无覆盖），
> 行为本身经 reviewer 手工复验**都是对的**；MAJOR 与 4 条 MINOR **已全部修完**，
> 新增 5 条 HTTP 用例（`tests/staffOrders.test.mjs` 17 → **22** 条）并做受控 mutation 验证，
> 门禁复跑：`pnpm test` **1278** / fail 0 · 生产全量 **1278/1278** / fail 0 / skipped 0。
> **现为 BLOCKER 0 / MAJOR 0**，满足批次自动继续条件（`03-delivery.md` §七）。
> ⚠️ 该批次**禁止任何 Git 写操作**，因此 `Git Commit` 一列**留空**是正确的当前状态
> （「DONE 双门槛」第二条只能由用户本人完成提交后填写）。
> ✅ **验收前整改 A0 已完成（2026-09-25）**：产品负责人裁定 `P0-10/02-decisions.md` §九 **A9-9**
> 选**方案 B**——`/staff/orders` **新增**平台展示 ID（`displayId`）一路，**既参与搜索、也展示在页面上**；
> 旧的内部标识（`u-1001`）**继续可搜**（新增一路，不是替换）。
> 改 3 个业务文件 + 2 条既有用例的断言（`tests/staffOrders.test.mjs` **22 条不变**——
> A0 修的是**既有用例宣言覆盖、实际没盖住**的地方），记录见 `P0-10/03-delivery.md` §十一。
> ⚠️ 会话 / 退款 / 投诉 / 完成材料四页按裁定「不扩展业务范围」**一个字没改**，
> 由此产生的「客服工作台内部有两种平台 ID」已由 A9-11 登记为**遗留项**（**不是缺陷**）。

> ✅ **`P0-11` 曾经停在 `CLARIFYING`（已解除，2026-09-24）。** 两个阻塞问题均由产品负责人裁定，
> 批次（`cmd_batch_p0-10_to_p0-13.md`）据此**继续**执行：
>
> - **Q1（已裁定）** — `Order.servingAt` 采用「**改写为本次 assignment 的时刻**」。
>   落点两行：释放写入器 `applyOrderAcceptanceReleased` 多写 `servingAt: null`；
>   `applyOrderServing` 的 `?? at` 保留（它防的是历史脏数据，不是语义）。
>   这是 `P0-9/02-decisions.md:229` 的 **D14（`DEFERRED`）** 的解除——
>   它写明「**任何轮次准备给 `serving → paid` 接入口之前必须先裁定**」，**P0-11 正是那一轮**。
> - **Q2（已裁定）** — 「客服直接指定新打手」**在 P0 范围内**，做法是**最小 direct-replace**
>   （复用既有原语与字段，**不新增聚合 / 字段 / `OrderStatus`**）。
>   `database-schema.md` 的 `TBD — DO NOT INVENT` 与「指定新打手仍可后置」**已被该裁定覆盖**，
>   该文档已按裁定**收窄**：仍然禁止自行设计「**完整的** Assignment / 指定改派模型」。
>
> 裁定原文、实现口径与逐条理由见 [`P0-11/02-decisions.md`](./P0-11/02-decisions.md) §九。
> ⚠️ **`CLARIFYING` 期间没有写过任何业务代码**——这句仍然成立；本轮全部实现都发生在裁定之后。
> 开发完成 + 自动门禁全绿 + 只读 reviewer 复核**已结束并整改完毕**，**等用户本人验收**
> （[`P0-11/04-acceptance.md`](./P0-11/04-acceptance.md)）。
> ✅ reviewer 初判 **BLOCKER 0 / MAJOR 2 / MINOR 4 / NOTE 2**，**现为 0 / 0**：
> ① 三条新写接口没有任何 HTTP **正例**（权限矩阵缺「正常结果」那一格）→ 补 2 条 HTTP 正例，
> 用 HTTP 现场造一单、打完**回读只读接口自证**，各做一次**受控 mutation** 证明咬得动；
> ② 本轮档案与计数没有回填 → 已回填 `需求功能点进度表.md` / `CLAUDE.md`（`130 route.ts`、
> `67 files, 1324 cases`）/ `api-contract.md` / `directory-structure.md`。
> 4 条 MINOR 亦全部修完（`可用性 6` / `作废 6` / 去掉回读 / 三处注释更正）。
> 门禁复跑：`pnpm test` **1324** / pass 1181 / fail 0 / skip 143 · 生产全量
> **1324/1324 / fail 0 / skipped 0** · `tests/staffOrderActions.test.mjs` **46 / 46** ·
> typegen + `tsc --noEmit` / `eslint` / `next build` 全部 exit 0（[`03-delivery.md`](./P0-11/03-delivery.md) §六 / §七）。
> ⚠️ 整改中**自查出一个自己的缺陷**：两条 HTTP 正例最初**是假绿的**（探测逻辑把「支付通道关着」
> 与「支付请求不存在」两个 404 混为一谈，导致每次提前 `return`、零断言），
> 是**受控 mutation 没变红**才暴露出来的（[`03-delivery.md`](./P0-11/03-delivery.md) §4.3）。
> ⚠️ 验收清单 §四 有 **4 条需要产品追认**（不是验收）：候选资格多一条 `available`（暂停接单的护航
> **不可**被指派）· 客服回池 / 换人**也发通知**（cmd 只对封禁明文要求）· 「重复停用不补做释放」·
> 「移除是否应释放」登记为遗留。**四条都已实现，但都超出 `cmd_p0-11.md` 的字面。**

> 🔵 **`P0-12` 是批次 [`cmd_batch_p0-10_to_p0-13.md`](./cmd_batch_p0-10_to_p0-13.md) 的第三站**，
> 2026-09-24 交付。开发完成 + 自动门禁全绿 + **两轮**只读复核（**0 BLOCKER / 0 MAJOR**），
> **等用户本人验收**（[`P0-12/04-acceptance.md`](./P0-12/04-acceptance.md)）。
> 门禁：`pnpm test` **1346** / pass 1200 / fail 0 / skip 146 · 生产全量 **1346/1346 / fail 0 / skipped 0** ·
> typegen + `tsc --noEmit` / `eslint` / `next build` 全部 exit 0。
> ⚠️ 本轮**顺带修正了一处 P0-9 遗留的测试缺陷**（不是放宽断言）：
> `tests/platformConfig.test.mjs` 的时间戳断言拿了一份**写之前**取的基线去比**写之后**的值，
> 只在两次写入落在同一毫秒时才碰巧成立——空闲机器上绿、满载跑法下红，P0-12 的门禁上真实红过一次。
> 该文件对批次 baseline `3fbae62` 的 diff 当时是**空的**，故属既有缺陷。
> ⚠️ 验收清单 §五 有 **2 条需要产品追认**（R1 存量退款记录原样不动 / R2 同），
> 且二者在**接入真实支付前**是**硬门禁**，不只是待追认项。
> ⚠️ 该批次**禁止任何 Git 写操作**，`Git Commit` 一列留空是**正确的当前状态**。

> ⛔→✅ **`P0-13` 曾经停在 `CLARIFYING`（2026-09-25 上午），产品裁定后已全部解除并交付，现为 `AWAITING_ACCEPTANCE`。**
>
> **当初为什么停**：Requirement Check 命中 `cmd_p0-13.md:30` 与批次文件 `:34-39` 的**特别停止条件**——
> Q1（`completed` 部分退款如何影响打手 Earning）的责任子问题、
> 与 Q2（Earning 已 `available` 但尚未提现时如何处理退款）**整体**，在全仓权威文档里**没有答案**。
> 三处单点证据：① `EX-REFUND-05:612` 的状态栏**只有 `⏳`，没有 `✅`**，
> 而同文件 `EX-REFUND-03:584` 明写「✅ 公式已确认，功能 ⏳」——**文档自己会区分「规则已定」与「功能未写」**；
> ② `grep "打手责任\|平台责任\|责任归属\|责任划分\|责任认定\|责任方" docs/` **只命中问题本身**
> （`cmd_p0-13.md:21`），需求与技术设计文档下 **0 命中**；
> ③ `EX-WITHDRAW-03:917`「❓ 完全未拍板」· `业务流程表.md:763`「TBD — DO NOT INVENT」。
> ⚠️ 特别提醒 `EX-REFUND-05:609` 正文里那个**斜杠**：「available **部分减少/生成 reversal**」——
> 它把两种做法并列、没说选哪个，而两者在代码里指向完全不同的落点
> （改 `Earning.incomeAmount` 会撞上 `lib/types/earning.ts:14-19` 已写死的「快照只搬运、不重算」原则）。
> ✅ **`CLARIFYING` 期间零业务代码改动**，只新增 `docs/03-dev/rounds/P0-13/` 下的 5 件档案；
> 停轮时复测确认树未腐坏：`pnpm test` **1346 / pass 1200 / fail 0 / skip 146** · typecheck / lint exit 0。
>
> **产品裁定（2026-09-25，照录于 `P0-13/02-decisions.md` §十）**：
> **Q1-a** 选择**责任制**——责任由 Admin 在最终退款决策时认定，最小类型 `platform` / `companion` / `shared`；
> `platform` → 冲回 0；`companion` → `floor(分账基数 × 退款比例)`；
> `shared` → `floor(分账基数 × 退款比例 × 打手责任比例)`；金额整数**分**。
> **Q1-b** 责任认定权**属于 Admin**；Staff 只能调查、记录、提出处理意见。
> **Q1-c** 平台承担部分必须留下**明确、可审计**的业务记录，不能仅靠「没有 reversal」间接推断。
> **Q2-a** **不得修改**原始 `Earning.incomeAmount`；**不建余额桶**；退款用独立 reversal / adjustment 表达；
> `netAvailableAmount = incomeAmount − cumulativeReversalAmount`。
> **Q2-b** 新增**最小**独立 `EarningAdjustment`（关联 `earningId` / `orderId` / `refundId` / type / amount /
> responsibility / createdAt），**不得**建完整钱包或会计总账。
> **Q2-c** 部分冲回 `status = available`；累计冲满 `incomeAmount` → `status = reversed`、净额 0。
> **Q2-d** 同一 Earning 允许**多次**冲减，必须保证 `0 ≤ 累计冲减 ≤ incomeAmount`，每次**幂等**。
> **Q3** **继续 DEFER**（已提现后的追偿 / 负余额）。
>
> **交付**：开发完成 + 自动门禁全绿 + 只读 reviewer 复核**已整改完毕**，
> **等用户本人验收**（[`P0-13/04-acceptance.md`](./P0-13/04-acceptance.md)）。
> ✅ reviewer 初判 **BLOCKER 1 / MAJOR 2 / MINOR 3**，**现为 0 / 0**，逐条见 `P0-13/03-delivery.md` §六：
> ① **BLOCKER B-1**（真缺陷，复核时在磁盘上独立复现）：`applyOrderRefund` 的第三个参数
> 语义从「覆盖成这个值」改成「本次的增量」之后，两条全额路径**仍然传实付全额**——
> 叠加「部分退款不改订单状态」与「P0-11 回池不动累计已退」，一张 `serving` 单可以带着
> `refundedAmount = 300` 被打回 `paid`，再退 1000 ⇒ **累计 1300 > 实付 1000**。
> 修法是**三层**：两条调用方改传差额 + 写入器**自己钳一次**（把不变量钉在**唯一写入点**）
> + 界面**报出本次实际金额**。② **MAJOR M-1（回归保护缺失）**：既有套件**全都从
> `refundedAmount === 0` 的干净订单出发**，因此没有任何用例咬得住 B-1——
> 新增 3 条组合路径用例并做**受控 mutation** 证明它们真会红
> （去掉写入器钳制 → 仍绿，证明调用方是对的；再去掉两处调用方 → **26 pass / 3 fail**）。
> ③ **M-2** 一条测试标题与它自己断言的事实**相反**（称不暴露内部用户主键，而同一条用例
> 正在断言该主键**存在**），`P0-10/02-decisions.md` 一并更正——**保留 D4 的口径**（那才是对的）。
> ④ **NOTE-4**：本档案里两处已被证伪的陈述按「追加不覆盖」**划线更正**并追加 **D18**。
> 门禁复跑（整改 B-1 后的树）：`pnpm test` **1377** / pass 1231 / fail 0 / skip 146 ·
> 生产 `APP_BASE_URL` 全量 **1377 / 1377 / fail 0 / skipped 0** ·
> typegen + `tsc --noEmit` / `eslint` / `next build` 全部 exit 0。
> ⑤ **2026-09-25 人工验收第 1 项整改（D19）**：验收方先要求答清「退款比例 30% 的基准是谁」
> 等三个口径问题，再整改管理端退款确认界面的 A–E（比例基准说明 / 「按比例分担」的含义与两个基数 /
> 订单金额表含**剩余可退款** / **改比例即时出预计金额** / 5 问答折叠块）。
> 整改**未改任何金额口径**——只把写入路径里的两段算术**提取成共享纯函数**供预览复用
> （`resolveFinalDecisionAmounts` / `sumApprovedCompanionReversal`），被取代的只有
> D15 的「确认框不预览金额」这半句。**最终树读数**：`pnpm test` **1385** / pass 1239 / fail 0 / skip 146 ·
> 生产 `APP_BASE_URL` 全量 **1385 / 1385 / fail 0 / skipped 0** · typegen + `tsc --noEmit` /
> `eslint` / `next build` 全部 exit 0。明细见 `P0-13/03-delivery.md` §十与 `P0-13/02-decisions.md` §十一 D19。
> ⚠️ 验收清单 §五 有 **1 条需要产品追认**（**R3**）：部分退款过的订单再走全额直退时
> **退的是「剩余可退额」**——P0-12 只写了「未全额退款」这个前置，**没写「部分已退」怎么办**。
> 与 P0-12 的 R1/R2 同类：**已按具体口径实现，但没有权威文本冻结**。
> ⚠️ 该批次**禁止任何 Git 写操作**，`Git Commit` 一列**留空**是正确的当前状态。
> 📌 **未开始 P0-14。**
>
> 📋 **批次最终报告见 [`BATCH_p0-10_to_p0-13_最终报告.md`](./BATCH_p0-10_to_p0-13_最终报告.md)**
> （A 四轮状态表 · B 每轮交付 · **C 异常链真实跑通情况**（含 BLOCKER B-1 的完整根因与三层修法）·
> **D 统一人工验收清单**（含 **§D.6 组合路径**——B-1 的人工对应物）· E 遗留 / TBD / MINOR / NOTE / CLARIFYING ·
> F Git · G 验收结果待填）。

> ✅ **`P0-6.1` / `P0-7` / `P0-8` / `P0-9` 四轮均已 `DONE` 收口**：它们都在批次
> [`cmd_batch_p0-6.1_to_p0-9.md`](./cmd_batch_p0-6.1_to_p0-9.md) 之内（P0-6.1 → P0-7 → P0-8 → P0-9）。
> 批次模式要求**每轮自动门禁全绿 + reviewer 无 BLOCKER/MAJOR 后不等待逐轮确认、自动进入下一轮**。
>
> ✅ **2026-09-24：四轮的统一人工验收已全部通过**——用户本人走完批次报告 §D 的完整清单，
> 确认 P0-6.1 / P0-7 / P0-8 / P0-9 **四轮全部 `User Result = PASSED` / `Final Result = PASSED`**，
> `Issues Found` 无。四轮的 `Accepted At` 均为 **2026-09-24**。
> ✅ **2026-09-24 收口**：「DONE 双门槛」（`development-workflow.md` §十七）的两个条件**均已满足** ——
> ① 用户本人说明验收通过；② **用户本人完成 Git 提交 `eef4e62`**（四轮实现随该提交进入版本库）。
> 因此四轮的 `Status` 已由 `AWAITING_ACCEPTANCE` 收口为 `DONE`，`Git Commit` 一列填为 `eef4e62`。
> ⚠️ 此前该列留空是**当时正确的状态**（提交尚未发生，Claude 全程零 Git 写操作）；
> 现在填的是**用户本人**的提交，不是 Claude 代为提交——Claude 至今**零 Git 写操作**。

> 🔵 **`P0-9` 曾经停在 `CLARIFYING`（已解除）。** 本轮第一次开工时，「投诉窗口的 Mock 默认值」
> 在**所有权威文档里都没有定义**，因此按 `cmd_p0-9.md` §二 / 批次 §五 / §十 的**真停止条件**
> 停在 `CLARIFYING` 向产品提问（`Q1`），**当时没有交付任何代码**。
> 产品负责人于 **2026-09-24** 裁定 `Q1`（默认 24 小时 / 单位分钟 / 取值 60~10080 分钟，
> 见 [`P0-9/02-decisions.md`](./P0-9/02-decisions.md) §八 D16~D18）后，本轮继续开发并**已交付**，
> 现已完成验收并收口为 `DONE`（提交 **`eef4e62`**）。⚠️ **`CLARIFYING` 那一版记录的是中间状态，不是本轮结论**；
> 提问原文与证据链按「追加历史、不覆盖历史」保留在该文件 §三 / §八。
>
> 📋 **批次最终报告见 [`BATCH_p0-6.1_to_p0-9_最终报告.md`](./BATCH_p0-6.1_to_p0-9_最终报告.md)**
> （A 四轮状态表 · B 每轮交付 · C 最终领域链 · **D 统一人工验收清单** · E 遗留 · F Git）。
> ✅ 该报告 §D 的清单已于 **2026-09-24** 由用户本人走完，四轮**全部通过**；
> 报告 §A.1 / §A.2 与摘要已同步记录最终验收结果（见该文件 §G）。

> ✅ **`P0-6.1` 已 `DONE` 收口**：它是 P0-6 / DEV-1 人工验收通过后登记的
> **两个整改项**（FIX-1 / FIX-2）的落地轮，**不是新功能**，也**不推翻** P0-6 / DEV-1 的 `DONE`。
> 「DONE 的双重门槛」的两个条件**均已满足**：人工验收通过（2026-09-24）+ **用户本人提交 `eef4e62`**。

> ✅ **P0-6 与 DEV-1 均已 `DONE` 收口**（两个独立 Round，互不阻塞）。
> 两者的 `User Result` / `Final Result` 均为 `PASSED`（2026-09-24 人工验收通过），
> 且由**用户本人**在同一个提交 **`53481ea`** 中完成提交——「DONE 的双重门槛」
> （`development-workflow.md` §十七）两个条件均已满足。
>
> ⚠️ **验收期间另发现两个独立整改项**（**均属 P0-6 域**，**不推翻 P0-6 的 `DONE` 结论**）：
> **FIX-1** 打手工作台缺少返回普通用户主界面的入口；**FIX-2** 订单池排序应改为
> 「等待最久优先」（公共池 `publicPoolEnteredAt` ASC / 专属池 `exclusiveEnteredAt` ASC）。
> 二者已登记为 `../总需求进度表.md` 中的独立 `NEEDS_FIX` 待办（**Round 编号仍为 `UNASSIGNED`**，
> 由用户 / ChatGPT 在正式启动时分配），明细见 [`P0-6/04-acceptance.md`](./P0-6/04-acceptance.md)
> 的 `Issues Found`。**它们不回写 P0-6 的历史实现描述。**
>
> `DEV-1` 是 2026-09-24 用户分配编号的开发 / 测试基础设施轮次，**不是产品功能**：
> 它只提供用户端的 Mock 身份切换面板，让 P0-6 的多角色人工验收在同一个窗口里完成。
> 验收清单见 [`DEV-1/04-acceptance.md`](./DEV-1/04-acceptance.md)。
> ⚠️ **DEV-1 曾被打回一次**（2026-09-24）：首轮把「至少两个具备有效 Companion 资格的 User」
> 读成了「名单里要有候选身份」，工具能切 User 却跑不完 P0-6 的 User → Companion A →
> Companion B 链路。重做批在既有 fixture 体系里**真的预置了两位有效打手**
> （`cp-10`/`u-1022`、`cp-11`/`u-1023`），验收链路从此不需要任何后台审核动作；
> 决策反转为 D6 **V2**，见 [`DEV-1/02-decisions.md`](./DEV-1/02-decisions.md)。
> ⚠️ **DEV-1 不修改 P0-6 的任何行为，也不修改 P0-6 的验收结果**；两者的验收各自独立记录，
> 只是按用户指令在同一个提交（`53481ea`）中一起收口。
>
> **P0-6**（2026-09-23 需求重校准后的第一轮，
> 编号由用户分配）。Requirement Check 已完成，无 `OPEN` 决策，见
> [`P0-6/02-decisions.md`](./P0-6/02-decisions.md)；实现与门禁结果见
> [`P0-6/03-delivery.md`](./P0-6/03-delivery.md)；验收清单见
> [`P0-6/04-acceptance.md`](./P0-6/04-acceptance.md)。
>
> ⚠️ 本轮**曾被用户打回一次**：首次交付把「客服查看取消历史」记成了待产品裁定的缺口，
> 用户裁定该需求**已冻结、必须补齐**。已按最小实现补齐（不新增任何 Staff 接口），
> 决策反转为 `02-decisions.md` D6 **V3 (CURRENT)**。E 组验收项已改写为可执行步骤。
>
> ⚠️ **`AWAITING_ACCEPTANCE` 不是完成**，`DONE` 需用户人工验收通过 + 用户自行提交。
>
> **不要提前创建空目录**——某轮真正准备开始时才创建。
> 上一轮 P0-5 建于本协议之前（`PRE-PROTOCOL`），不倒填历史档案。

全局进度真值源：[`../总需求进度表.md`](../总需求进度表.md)
