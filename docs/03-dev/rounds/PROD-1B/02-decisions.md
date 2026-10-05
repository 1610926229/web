# Decisions

Round: PROD-1B
记录: Claude 提出，产品负责人裁定

> 依据 `development-workflow.md` §十一 / §十二 / §十三。
> 每条 Q 的状态流转：`OPEN`（阻塞，停止开发）→ 用户答复 → `RESOLVED` + `Final Execution Rule`。
> **历史不删除**：后续若推翻某条，保留原文并改标 `SUPERSEDED`。

---

## Q1｜W1 实测闭包 ⊋ Phase 11 排除清单，两者不能同时成立

Status: RESOLVED

### Claude Question

Phase 1 逐文件核对（**未依据指令里的候选清单**）后，W1 的写闭包包含指令 Phase 11 明令**不迁移**的四项：
admin refund、coupon、complaint、platform config。而 Hard Rule 1、`architecture-rules.md` §2.5（:166–175）、
`tech-stack.md` §11.1、`database-schema.md` C5、`directory-structure.md` §迁移四步门槛（:211）
—— **五处独立表述一致禁止**「一半 PostgreSQL、一半 Mock store」。

按 Phase 13 的约定，这是无法由现有代码 / 已冻结规则 / PROD-1A 架构推导出的架构级问题，故提出并停止，等待裁定。

### Why This Is Blocking

`orders` 这一张表被 **15 个事务入口**写。其中 **T14/T15（`adminRefundTransaction`）是管理端退款**，
在**同一个无 `await` 区段内**写 7 个实体。因此：

- 若 `orders` 进 PostgreSQL、而 `adminRefundTransaction` 留 Mock → **同一张表两个住址**，
  或**同一个事务一半 PG 一半 Mock** —— 两条都被上述五处规则禁止。
- 若把 `adminRefundTransaction` 一并纳入 → 它同段的 `writeAudit` 把 `admin_audit_entries` 拉进闭包；
  而 `auditIdByOperationId` 同时是**全部管理操作的幂等落点**（`lib/data/adminWriteSupport.ts` 的
  `takeReplay` / `takeReplayForAction`），全库 `writeAudit` 共 **33 处、分布在 10 个 admin 事务文件**
  → 在**切换数据源**时会级联另外 8 个管理端事务（agreement / catalog / content / complaint /
  platformConfig / review / staff / couponTemplate）及其实体，闭包扩到 **≈28 张表**。

即：**「W1 订单核心闭包」在现有代码里不是一个小集合** —— 它要么是近乎全库，要么是零。
PROD-1A 之所以能选到 `favorite` / `suggestion` 做竖切片，正因为它们不参与任何管理端审计与资金事务；
**这个位置现在已经没有了。**

### Affected Areas

**W1 写实体（15 张表）**

`orders` · `payment_requests` · `payments` · `dispatch_records` · `completion_submissions` ·
`earnings` · `earning_adjustments` · `refund_requests` · `notifications` ·
`companion_accept_events` · `companion_release_records` · `companion_service_events` ·
`coupon_claims` · `admin_audit_entries` · `companions`

**W1 事务入口（15 个，逐 `applyOrder*` 调用点核对）**

| # | 入口 | 位置 | 同段内的写实体 |
|---|---|---|---|
| T1 | `confirmPaymentRequest`（下单） | `mockPaymentRepository.ts` + `lib/services/checkout.ts:479,545` | payment_requests · payments · **orders** · dispatch_records · **coupon_claims** |
| T2 | `acceptDispatch` | `lib/data/companionDispatchTransaction.ts:302–328` | dispatch_records · **orders** · notifications · companion_accept_events |
| T3 | `sweepExpiredDispatches` | `:503–520` | dispatch_records · **orders** · **coupon_claims** · notifications |
| T4 | `cancelAcceptedOrder` → `releaseCurrentAssignment` | `lib/data/companionOrderTransaction.ts:257–309` | companion_release_records · **orders** · dispatch_records · notifications · completion_submissions |
| T5 | `startCompanionOrder` | `:519–550` | **orders** · companion_service_events |
| T6 | `releaseOrderByStaff` | 复用 `releaseCurrentAssignment` | 同 T4 |
| T7 | `replaceOrderCompanionByStaff` | 同上（`serving→paid→accepted` 一段内完成） | 同 T4 |
| T8 | `releaseOrdersForCompanion` ← `setCompanionFlags` | `:832` + `lib/data/adminCompanionTransaction.ts:557–575` | **orders** · dispatch_records · companion_release_records · notifications · **companions** · **admin_audit_entries** |
| T9 | `submitCompletion` | `lib/data/completionTransaction.ts:244` | completion_submissions |
| T10 | `approveCompletion` / `rejectCompletion` | `:352 / :423` | completion_submissions · **orders** · earnings · earning_adjustments · notifications |
| T11 | `sweepCompletionAutoApprovals` | `:483–490` | 同 T10 |
| T12 | `directRefundOrder` | `lib/data/directRefundTransaction.ts:266–296` | **orders** · **coupon_claims** · dispatch_records · notifications |
| T13 | `sweepMaturedEarnings` | `lib/data/earningTransaction.ts:334` | earnings |
| T14 | `approveRefund`（管理端退款通过） | `lib/data/adminRefundTransaction.ts:567–659` | **refund_requests** · **orders** · **earnings** · earning_adjustments · dispatch_records · **coupon_claims** · notifications · **admin_audit_entries** |
| T15 | `startReviewRefund` / `rejectRefund` | `:226–236 / :727–736` | refund_requests · **admin_audit_entries** |

**W1 事务内的外部只读 / 快照依赖**

| 实体 | 读取点 | 性质 |
|---|---|---|
| `complaints` | `lib/data/orderBlocking.ts:41–48`，被 `completionTransaction.ts:483`、`earningTransaction.ts:326` 在**写事务内**调用 | `orderBlocking.ts:32-33` 自带注释：真实 DB 实现里这两次读应与写入同一事务 |
| `refund_requests` | 同上 | 同事务读 |
| `platform_config` | `currentPlatformConfig()` 在 T3 / T10 / T11 内读超时与窗口快照 | 快照冻结（`database-schema.md` C4、`api-contract.md:1009`） |
| `coupons`（模板 `enabled`） | `lib/data/couponRedemptionTransaction.ts:59`，在 T1 原子段内 | 同事务读 |

### Known Facts

- 该规则共 **5 处**独立表述：Hard Rule 1（指令）· `architecture-rules.md` §2.5:166–175（并注明
  「上表列出的 16 个 `*Transaction.ts` 文件**全部**仍在 Mock 上」）· `tech-stack.md` §11.1 · `database-schema.md` C5:1388-1389 ·
  `directory-structure.md` :211–212。
- `directory-structure.md:201-202` 另有：「**不要**新建第二套 Order / Refund / Notification」。
- 指令 Phase 10 已预期「其余没有迁移，`DATA_SOURCE=postgres` 是迁移验证模式」。该模型自洽，
  但其成立隐含前提是「**W1 事务与未迁事务不共享 store**」—— 而 `orders` 恰好被 `adminRefundTransaction` 写。
  这是唯一的插销。
- 指令 Phase 11 的排除清单中，被闭包**必然**拉进来的：admin refund · coupon · complaint · platform config；
  仅因 `admin_audit_entries` 在**切换时**级联的：catalog · content · agreement · staff · qualification ·
  companionApplication · couponTemplate。
  **不被拉进来的**：chat/message · user · activity · withdrawal。

### Remaining Decision

在「闭包完整性」与「不扩 Scope」之间取舍。已列出的四条路径：

1. 交付 Schema + Pg 实现 + 并发实证，**暂不切数据源**
2. 按实测闭包整包迁（≈28 表）
3. 重定义 W1 为闭包完整的更小子集，Order 留待下一轮
4. 接受「管理端审计可最后写」这一处例外（与 Hard Rule 1 / C1 / §2.5 冲突，Claude **不建议**）

### User Answer

> **选择路径 1。正式裁定：PROD-1B 不切换 active datasource。**（2026-10-03，用户后续另行发来完整裁定文本）

用户给出的理由（逐字要点）：实测证明 Order Hub 的完整写闭包会经 `admin_audit` 继续级联到
admin refund / coupon / complaint / platform config 以及其它管理端事务，最终接近全库范围。
不能为了让 PROD-1B 本轮「可切换」而：① 扩大成约 28 表的全库迁移；② 违反 Phase 11 scope；
③ 把 AdminAudit 降级成事务外 best-effort；④ 产生 half PG / half Mock transaction。

**本轮重新定义（逐字）**：

> 「正式名称可调整为：`PROD-1B — Order Hub PostgreSQL Implementation & Concurrency Proof`。
> 含义：**完成 PostgreSQL 实现与可靠性证明，但 intentionally not activated。**
> 这不是 BLOCKED，也不是未完成。**这是迁移阶段设计的一部分。**」

### Final Execution Rule

**以下为可执行规则，Agent 以本条为规则来源。**

1. **本轮交付物 = 三样**，缺一不可：
   - `db/migrations/0003+`：为上面 **15 张表**建表建约束（编号自 `0003` 起，**不修改**已执行的 `0001` / `0002`）；
   - `lib/data/pg/<实体>Repository.ts`：按 `directory-structure.md` §迁移四步（:204–212）为 W1 实体补
     `createXxxRepository(db: PgQueryable)` 工厂，返回**同一个接口**；
   - PostgreSQL 实证测试：parity / persistence / accept race / rollback / completion·earning·refund 幂等 /
     event uniqueness / `timestamptz` 往返 / cross-repository 同事务。

2. **本轮范围 = 15 张表的写闭包，不含管理端审计级联。**
   T14 / T15 的 Pg 实现**包含在本轮**（它们写 `orders`，是闭包成员）；
   但**另外 8 个管理端事务**（agreement / catalog / content / complaint / platformConfig / review / staff / couponTemplate）
   **不进本轮** —— 它们与 `orders` 的唯一联系是共享 `admin_audit_entries` 这一张表，
   而该联系**只在切换数据源时才咬人**，本轮不切。

   > ⚠️ **执行澄清（Claude 补注于 2026-10-05，不改动上面的裁定文字）**：本条第 2 句与下面的
   > **13b** 曾看起来互相打架，实际是「**本轮是否产出 T14/T15 的 Pg 实现**」这一点上前后收紧过。
   > **以 13b 为准**：T14 / T15（以及 T8）的原子段含 `writeAudit`，而 `admin_audit_entries` 按规则 10
   > 本轮不进 Pg，因此它们**本轮不产出任何 Pg 事务实现**——包括不可激活的版本也不产出，
   > 因为它们写 `orders`，半个原子段就是 Hard Rule 1 明令禁止的形态。
   > 本轮实际产出的 Pg 事务入口清单见 `03-delivery.md` §1.2。

3. **`DATA_SOURCE` 本轮保持不设置。** 应用默认仍跑 Mock。
   `DATA_SOURCE=postgres` 在本轮**仍不是**可用的迁移验证模式 —— 因为闭包尚未含管理端审计分支。
   此事实**必须**写进 `03-delivery.md` 的 Known Limitations。

4. **Hard Rule 1 不破。** 本轮不上线任何「PG + Mock 混写」的业务链。Pg 实现**只被测试驱动**，
   不进入应用的 active 写入路径。

5. **切换数据源的前置条件（下一轮的入口条件）**：15 张表的**全部写者** +
   `admin_audit_entries` 的**全部 33 个写者所在的 10 个文件**中的另外 8 个一并迁完。
   未满足前，`DATA_SOURCE=postgres` 不得被声明为可用。

6. **不得改变任何已冻结业务规则**（Hard Rule 2）。本轮是对同一批写入的**等价翻译**，
   `pnpm test`（Mock 全量）必须零回归。

7. **Pg 实现不得是 placeholder**（用户逐字）：

   > 「即使暂不激活，本轮 Pg 实现不能是 placeholder。必须能够通过**真实 PostgreSQL** 测试证明：
   > Repository contract parity · transaction commit · rollback · concurrent accept exactly one winner ·
   > duplicate accept idempotency · completion idempotency · earning uniqueness / idempotency ·
   > relevant event uniqueness · deadline roundtrip · Pg persistence after process restart ·
   > **all W1 transaction participants share the same pg client**。」

8. **测试必须真连数据库**（用户逐字）：

   > 「测试必须真实连接 `TEST_DATABASE_URL`。**不得通过 mock/stub Pg client 假验证。**」

   推论：断言「同一事务 = 同一条连接」必须用 `TxHandle.connectionId`（即 `pg_backend_pid()`）实测，
   而不是读代码相信——这是 `lib/data/pg/executor.ts:34-42` 已经写下的用法。

9. **Schema 纪律**（用户逐字）：

   > 「只创建本轮 Pg implementation / test 真正需要的 schema。如果为了数据库 FK 必须引用一个
   > 尚未迁移的外部实体：先判断是否真的需要数据库 FK。**不得为了 FK 完整性把整个其它业务域顺手迁进来。**
   > 业务上的外部 ID 可以在当前迁移阶段作为稳定 ID 存储，在最终闭包迁移阶段再补适当 FK，
   > 前提是**文档明确登记**。但：**任何属于本事务写闭包的实体不能用这个办法逃避迁移。**」

   推论：闭包内的 15 张表之间该建的 FK **必须建**；闭包外的引用（如 `users.id`、`coupons.id`、
   商品/目录 ID）**以稳定 ID 存储、不建 FK**，并逐条登记进 `03-delivery.md`。

10. **AdminAudit 维持既有强事务语义**（用户逐字）：

    > 「维持既有强事务语义。**禁止采用方案 4。** 不得把 `admin_audit` 改为 commit 后 best-effort。
    > 如果某事务要求 Audit 与业务写原子提交，则在**真正 activation 前**必须完整迁入同一 PostgreSQL transaction。」

    即：`admin_audit_entries` **在本轮不进 Pg**，因此 T8 的 Pg 版本不得被当作可激活实现——
    它是下一轮的前置条件之一。

11. **后续轮次规划**（用户逐字）：

    > 「PROD-1B 完成后，根据本轮得到的真实 dependency graph 规划 `PROD-1C / PROD-1D ...`，
    > 逐步补齐剩余 PostgreSQL transaction closure。只有当某条真实业务链的**完整写闭包全部 Pg-ready** 后，
    > 该链才允许切换到 PostgreSQL。最终全核心闭包完成后，再执行整体 `DATA_SOURCE=postgres` activation。」

12. **不选路径 2 / 3 / 4**（用户逐字：「因此：不选 2 · 不选 3 · 不选 4 · 按方案 1 继续。」）

13. **本轮实测范围（由规则 1–12 直接推导，未新增产品决定）**

    **13a. 本轮建表清单 = 17 张。** 判据有两条，缺一不可：
    - **写参与者**：属于订单写闭包，且其写事务在本轮可完整 PG 化；
    - **事务内读参与者**：被某个**写事务**在事务内读取，因而必须与写入同库
      （`lib/data/orderBlocking.ts:32-33` 自带注释已把这条写成硬要求）。

    | # | 表 | 角色 | 依据 |
    |---|---|---|---|
    | 1 | `orders` | 写 | — |
    | 2 | `payment_requests` | 写 | T1 |
    | 3 | `payments` | 写 | T1 |
    | 4 | `dispatch_records` | 写 | T2/T3/T4/T12 |
    | 5 | `completion_submissions` | 写 | T4/T9/T10/T11 |
    | 6 | `earnings` | 写 | T10/T13 |
    | 7 | `earning_adjustments` | 写 | T10 |
    | 8 | `refund_requests` | 写（用户侧申请）+ **事务内读** | `createRefundRequest`；T10/T11 经 `orderBlocking` 读 |
    | 9 | `notifications` | 写 | T2/T3/T4/T12/T10 |
    | 10 | `companion_accept_events` | 写 | T2 |
    | 11 | `companion_release_records` | 写 | T4 |
    | 12 | `companion_service_events` | 写 | T5 |
    | 13 | `coupon_claims` | 写 | T1/T3/T12 |
    | 14 | `companions` | **事务内读** | T2 的 `isCompanionAcceptingOrders` / 禁自接单 Guard 读它 |
    | 15 | `complaints` | **事务内读** | T10/T11 经 `orderBlocking` 读；`orderBlocking.ts:32-33` 明写须同事务 |
    | 16 | `platform_config` | **事务内读** | T3/T10/T11 读超时与窗口快照 |
    | 17 | `coupon_templates` | **事务内读** | T1 内经 `redeemCouponClaimForOrder`（`couponRedemptionTransaction.ts:59`）读模板 `enabled` |

    ⚠️ 第 14–17 张是**只读叶子表**：本轮**不要求**它们的 Pg 写者到位（其写者多为非 W1 的管理端事务）。
    它们进 PG 的唯一理由是「写事务的读必须与写同库」。**这属于用户规则 9 允许的范围
    （不是「为了 FK 完整性」），但必须逐条登记**——已登记于此与 `03-delivery.md`。

    **13b. 本轮不进 Pg（留给 PROD-1C）**：
    - `admin_audit_entries`（规则 10）；
    - 因而 **T8**（`setCompanionFlags` → `releaseOrdersForCompanion`）、**T14**（`approveRefund`）、
      **T15**（`startReviewRefund` / `rejectRefund`）**本轮不产出可激活的 Pg 事务** ——
      它们的原子段含 `writeAudit`，按 Hard Rule 1 不得拆。
    - 另外 8 个管理端事务（agreement / catalog / content / complaint / platformConfig / review / staff / couponTemplate）。

    **13c. FK 策略**（用户规则 9）：
    - **闭包内**的引用一律建真 FK（`dispatch_records.order_id` → `orders` 等）；
    - **闭包外**的引用（`users.id`、商品/目录 ID）**以稳定 ID 文本存储、不建 FK**，逐条登记待最终闭包阶段补；
    - ⚠️ **不得**用本策略让闭包内的表逃避迁移。

    **13d. 切换前置条件（PROD-1C 入口）**：
    17 张表的全部写者 + `admin_audit_entries` 的全部 33 处写者（10 个文件中的另外 8 个）
    一并迁完，`DATA_SOURCE=postgres` 才允许被声明为可用。

---

## Q2｜需求文档 §17 的比例冲回公式 vs P0-15 的整笔冲回

Status: RESOLVED（**按优先级自动裁定，未新增产品决定**）

### Claude Question

`docs/01-requirements/超哥电竞_业务流程表.md` §17（:928–985）仍写着按比例的冲回公式
`companionReversal = floor(companionBaseIncome × refundRate)`，并注明
「状态：规则已冻结；真正 Earning / 退款联动 ⏳」。
而 **P0-15** 已改为「冲回额**恒等于** `companionBaseIncome` 整笔，与退款比例无关」
（权限表 7.3:461 · `EX-REFUND-03:582–592` · `EX-REFUND-05:661–672` · `api-contract.md §3.7`）。

### Why This Is Blocking

表面上是两处需求冲突。但业务流程表**自己在 :7 规定了优先级**：
「最新明确产品决定 > 当前订单生命周期整改方案 > V1.7 需求文档 > 现有代码行为」。
P0-15 是更晚的明确产品决定，故 §17 已被取代。**代码已是正确一侧**（`applyEarningReversal` 取整笔）。

### Affected Areas

仅影响文档表述。`lib/data/earningTransaction.ts` 与 `lib/data/adminRefundTransaction.ts` 的冲减逻辑**不动**。

### Known Facts

- 用户指令 Hard Rule 2 明令：「本轮不得"顺手优化"这些业务。发现旧逻辑疑似有问题：**登记，不擅自改**。」
- 故此处**只登记、不改任何代码、不改需求文档**（需求文档的修订单独立轮次处理）。

### User Answer

（无需用户裁定 —— 按文档自身优先级规则即可判定。）

### Final Execution Rule

**P0-15 整笔冲回为唯一有效规则。** 本轮**不修改** `业务流程表.md §17`，
**不修改**任何冲减/退款金额代码。仅在 `03-delivery.md` 的 Known Limitations 中登记该处文档漂移。
