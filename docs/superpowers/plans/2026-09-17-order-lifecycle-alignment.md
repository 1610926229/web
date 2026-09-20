# 订单生命周期需求对齐整改计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「订单只能停在 `paid`、打手不存在」的现状，改造成需求文档要求的完整生命周期：派单（专属池 → 公共池 → 超时自动退款）→ 接单 → 开始服务 → 提交完成材料 → 客服审核 → 完成 → 资金冻结 48 小时 → 可提现。

**Architecture:** 不扩张 `OrderStatus`，而是按领域拆分——`Order` 承载履约主状态，`Dispatch` / `CompletionSubmission` / `Earning` 各自独立成仓储与状态机，共享同一套「无 `await` 原子区段 + 幂等键 + 管理端审计」写入模式。打手身份**不新建第四套独立身份**（D2 已否决），而是建立在既有 User Session 之上（`requireUser()` → 按 `userId` 查 `Companion`），既有 user / admin / staff 三套隔离不变。

**Tech Stack:** Next.js 16.3.4（App Router / Turbopack / 异步 `params`）、React 19.2.8、TypeScript 5、Tailwind CSS v4（CSS-first `@theme inline`）、pnpm 12.3.4、Node 24 内置测试运行器（`node --test`）。

**Spec:** 需求来源为 `陪玩护航交易平台订单生命周期需求确认文档_V1.7_含实例说明(1).docx`（正文标题仍写 V1.6）。该文档为**待确认稿**，其中 15 处歧义（C1–C15）已由产品方逐条裁定，裁定结果即本计划 §一 与 §二，**与文档原文冲突时以本计划为准**。**15 项全部冻结**（最后一项 R3 已于 2026-09-18 确认：V1 全部增值服务参与打手分账），见 §八。

---

## Global Constraints

以下约束对本计划**每一个任务**生效，不再逐条重复。

1. **金额一律为整数「分」**，且**只在服务端计算**。客户端提交的任何金额字段都必须被忽略，不得写入订单。
2. **所有写接口必须要求幂等键**，并在原子区段内先做重放检查（`takeReplay` / `takeReplayForAction` / `takeCreateReplay`），重放分支**只返回、不写任何东西**。
3. **原子区段内出现 `await` 就是 bug。** 区段标记为 `// —— 原子区段开始（无 await）——` / `// —— 原子区段结束 ——`；store 句柄在区段外取好，且**每次调用现取，绝不缓存**（测试会 `resetMockStore()` 换掉整份存储）。
4. **管理端审计只能由 `requireAdmin()` / `requireStaff()` 的会话身份产生**；请求体里的 actor 字段没有任何进入路径。
5. **`requireAdmin()` / `requireStaff()` / `requireUser()` / `requireCompanion()` 必须是路由处理器函数体的第一条语句。**
6. **接口清单门禁**：新增任何后台接口，必须同步扩充 `tests/admin.test.mjs` 的接口清单数组与 `test()` 标题；新增客服接口改 `tests/staff.test.mjs`；新增打手接口改 `tests/companion.test.mjs`。少一个、多一个、被改名都会让测试失败。
7. **Next.js 16：`params` / `searchParams` 是 Promise**，一律 `await props.params`；页面用全局生成的 `PageProps<'/route'>` / `LayoutProps<'/route'>`，不手写类型。改完跑 `pnpm typecheck`（它会先 `next typegen`）。
8. **测试只能用 `.mjs`**（tsconfig 的 `include` 覆盖 `**/*.ts`，但 JSX 不会被 Node 剥离，所以测试只覆盖非组件模块）。组件行为靠手工验收。
9. **不复制第二套 Order / Refund 仓储或服务。** 新领域新建文件，既有领域只做扩展。
10. **分阶段逐个授权**：一次只执行一个批次，做完停下等视觉验收，不得连续推进多个批次。
11. 本轮**不做**：存单、新评价系统、新活动系统、新会员系统、新营销系统、自动打手等级升级、独立预约系统。
12. 每个任务收尾必须 `pnpm test` + `pnpm typecheck` + `pnpm lint` 三者全绿再提交。
13. **时限判断一律基于 `deadline <= now`**，绝不基于「上次查询时间」。时限类 Service（`sweepExpiredDispatches` / `sweepMaturedEarnings`）必须写成**可重复调用、幂等**的业务入口，将来由后台调度器调用**同一套**，**不得重写第二套超时退款逻辑**。**金额一律整数分，全系统禁止浮点「元」金额。**

---

## 一、Requirement Conflict Scan —— 最终结论

| # | 原冲突 | 裁定 | 落点 |
|---|---|---|---|
| **C1** | §4 正文「1 小时无人接 → 自动退款」／§4 场景「1 小时 → 售后区」／§12 与 §20.3「5 小时 → 售后区」三处互斥 | **旧值全部作废。** 新规则：自**进入公共订单池**时刻起算，达到管理员配置时长仍无人接单 → 停止接取 → **自动全额退款**。**不生成售后案件** | P0-1 + P0-5 |
| **C2** | §6「只能放弃专属订单池中的订单」与 §3 的 10 分钟时间驱动退出并存 | **旧裁定作废（2026-09-19 产品重新确认）。** **不存在主动「不接 / 放弃」动作**：不设拒绝按钮、不设对应接口、不记拒绝字段。打手不想接就什么都不做，**专属池 10 分钟到点**系统自动转公共池。「不接」本身就是拒绝 | P0-5 |
| **C3** | §18「订单继续」与「禁止提交完成材料」自相矛盾 | **进入售后处理。** 被禁打手失去聊天 / 提交材料 / 操作订单的一切能力；**不提供**客服「替打手提交材料」入口；最终资金权限仍在管理员 | P1-4 |
| **C4** | §18 封禁后订单回公共池，计时是否沿用 | **重新计时**（否决原推荐）：`publicPoolEnteredAt = 当前时刻`，按该订单**保存的超时快照**算新的 `publicDeadlineAt`。原因：专属池 → accepted → 封禁的订单可能从未进过公共池，不存在可沿用的截止时间。同时**通知老板** | P1-4 |
| **C5** | §13「服务中的订单允许退款」与 §12「任意状态 → 售后区」 | **仅 `serving` 提供普通退款入口。** `paid` 走超时自动退款；`accepted` 走投诉；`completed` 走 48h 投诉期。四种状态各有出口，互不重叠 | P1-1 |
| **C6** | §19 把 4 个阶段都列为订单状态 | **领域拆分。** 不扩张 `OrderStatus` | P0-3…P0-8 |
| **C7** | `waiting_accept` 与 `paid` 的关系 | 由 **`Order.paid` + `Dispatch`** 表达，不新增状态 | P0-5 |
| **C8** | §10 删除聊天与投诉/退款保留的竞态 | **物理删除。** 48h 到期时检查是否存在投诉 / 退款 / 售后记录；完全无异常才删除。47:59 发起的投诉或退款**立即进入保留范围**，48h 任务不得删除。更换打手：新会话，旧聊天作为证据保留，新打手不可见 | P1-3 |
| **C9** | §17 消费累计时点未定义 | **支付成功时按实付累计**；退款按**实际退款金额**扣减；等级是派生值，**允许自然下降**，不做「曾经升级永不降级」 | P0-3 + P0-9 |
| **C10** | §13 任意比例退款的资金分摊未定义 | **已完全冻结**（公式、取整、命名、副本额度见 §二.6）。取整方式**已确认**：仅退款与打手冲正向下取整，俱乐部调整额由减法得出 | P1-1 |
| **C11** | §16「罚款金额」无任何规则 | **预留恒为 0**，本轮**无任何扣款操作**。「不接专属单」不是违规动作，自然不涉及罚款 | P0-8 |
| **C12** | §12「服务异常」未定义 | ⚠️ **残留**，不阻塞 P0，列入 §八 | P2 |
| **C13** | §12「失去普通投诉权限」暗示非普通通道 | ⚠️ **残留**，不阻塞 P0，列入 §八 | P2 |
| **C14** | §9「B/A/S 3/4/5」是固定还是可配 | ⚠️ **残留**。**P0-5 完全不实现并发上限**（不设常量、不计数），整个并发约束留给 P1-5 接入等级时一次做对 | P1-5 |
| **C15** | §14「打手收入 = 商品原价 × 分账比例」中「商品原价」的确切构成（是否含增值服务） | ✅ **已由产品确认（R3，2026-09-18）**：V1 全部增值服务**参与分账**，分账基数 = 商品金额 + 全部增值服务金额。由 `resolveCompanionRevenueBase()` 单独给出，与原价分开表达 | P0-3 |

---

## 二、目标领域模型

### 2.1 Order —— 履约主状态

```ts
export type OrderStatus = "paid" | "accepted" | "serving" | "completed" | "refunded";
```

**新增字段**（`lib/types/order.ts`）：

```ts
// —— 金额域（全部为「分」整数，服务端计算，下单时冻结）——
originalAmount: number;          // 用户这一单**优惠前的原始应付总金额** = 商品金额 + 全部增值服务金额
couponDiscountAmount: number;    // 优惠券抵扣；P0 恒 0，P1-6 接入
actualPaidAmount: number;        // 用户实付 = originalAmount - couponDiscountAmount
companionRateSnapshot: number;   // 分账比例快照，基点（1 bp = 0.01%），8000 = 80%
companionBaseIncome: number;     // 打手理论收入 = floor(分账基数 × rate / 10000)；分账基数见 R3
clubNetIncome: number;           // 俱乐部净收益 = actualPaidAmount - companionBaseIncome（**允许为负**）
refundedAmount: number;          // 累计已退金额；全额退款后 = actualPaidAmount
```

**语义变更：`companionId` 重命名为 `actualCompanionId`，且只在接单成功那一刻写入。** 下单时选的打手**不是**履约打手，移入 `Dispatch.exclusiveCompanionId`。

两个事实必须都能追溯，**绝不能用一个字段同时表达**：

| 事实 | 落点 | 谁写 |
|---|---|---|
| 用户**指定**过谁 | `Dispatch.exclusiveCompanionId` | 下单时 |
| 实际**接单**的是谁 | `Order.actualCompanionId` + `Dispatch.acceptedByCompanionId` | 接单成功的同一原子区段 |

例：用户指定 A → A 未接 → 转公共池 → B 接单 ⇒ **指定 A、实际 B，两者都可查**。管理端/客服订单详情必须同时显示这两行。

### 2.2 Dispatch —— 派单

```ts
export type DispatchState = "exclusive" | "public" | "accepted" | "timed_out";

export type DispatchRecord = {
  id: string;
  orderId: string;
  /**
   * 订单当前所在的位置。四种取值互斥，「在哪个池」与「有没有被接 / 有没有超时」
   * 是同一个事实，因此**只有一个字段**——再设一个 `poolType` 就会出现两个真值源，
   * 而它们分叉的那一天，页面会显示一个订单既在公共池又可被接单。
   *
   * 需求口径里的 `poolType ∈ {exclusive, public}` 就是这个字段在**未结束时**的两个取值。
   */
  state: DispatchState;

  /** 用户**指定**的打手；不指定时为 null，订单直接进公共池。历史事实，永不清空 */
  exclusiveCompanionId: string | null;

  /** 专属池的进入时刻（未指定打手时为 null） */
  exclusiveEnteredAt: string | null;
  /** 进入专属池时刻 + 专属池固定等待时长（10 分钟） */
  exclusiveDeadlineAt: string | null;

  /**
   * 公共池的进入时刻。**每次进入公共池都重写**：未指定打手是首次进入，
   * 专属池超时是第二次进入——两次都要用**那一刻**的平台配置重新冻结快照。
   */
  publicPoolEnteredAt: string | null;
  publicDeadlineAt: string | null;
  /** 进入公共池时冻结的配置快照（分钟）；改配置不影响已入池订单 */
  publicTimeoutMinutesSnapshot: number | null;

  acceptedByCompanionId: string | null;
  acceptedAt: string | null;
  timedOutAt: string | null;

  createdAt: string;
  updatedAt: string;
};
```

⚠️ **本轮没有「拒绝 / 放弃 / 不接」这条业务能力**：打手不想接，**什么都不做**即可——
专属池 10 分钟到点自动转公共池。因此类型里**没有** `declinedByCompanionIds` / `declinedAt`，
接口里没有 decline 路由，服务层没有放弃方法。「不接」本身就是拒绝。

`waiting_accept` 的两种形态：`Order.paid` + `Dispatch.state === "exclusive"`（专属池等待）／`"public"`（公共池等待）。

### 2.3 CompletionSubmission —— 完成材料

```ts
export type CompletionSubmissionStatus = "pending" | "approved" | "rejected";

export type CompletionSubmission = {
  id: string;
  orderId: string;
  companionId: string;
  evidenceNames: string[];   // 复用既有凭证文件名模式
  summary: string;           // 5~50 字
  status: CompletionSubmissionStatus;
  submittedAt: string;
  reviewedByStaffId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
};
```

审核驳回 → `Order` **保持 `serving`**，可再次提交。

### 2.4 Earning —— 打手收益

```ts
export type EarningStatus = "frozen" | "available" | "withdrawn" | "reversed";

export type Earning = {
  id: string;
  orderId: string;
  companionId: string;
  incomeAmount: number;     // 来自订单快照
  status: EarningStatus;
  frozenAt: string;
  /** 冻结到期 = 订单完成时刻 + 48h */
  availableAt: string | null;
  withdrawnAt: string | null;
  reversedAmount: number;   // 冲正累计（部分退款）
  fineAmount: number;       // ⚠️ 恒为 0，本轮无扣款操作
};
```

### 2.5 AfterSalesCase（P1 引入，P0 不建）

`OrderStatus` **不含**售后状态。售后是独立实体，P0 阶段不产生（超时自动退款不进售后）。P1-2 / P1-4 引入。

### 2.6 资金公式（已正式冻结）

**四个基数**（下单那一刻全部冻结为快照，之后改商品配置不影响历史订单）

```
originalAmount        用户这一单**优惠前的原始应付总金额** = 商品金额 + 全部增值服务金额
companionRateSnapshot 打手分账比例快照（基点）
actualPaidAmount      用户实付 = originalAmount − couponDiscountAmount
companionBaseIncome   = floor(分账基数 × companionRateSnapshot / 10000)；分账基数见 R3（已确认）
clubNetIncome         = actualPaidAmount − companionBaseIncome          ← 允许为负
```

> **「原价」与「分账基数」是两个概念。** 原价回答「这一单该收多少钱」，基数回答「其中哪些钱按比例分给打手」。
> R3 已确认（2026-09-18）当前 V1 两者数值相同，但那是 `resolveCompanionRevenueBase()` 给出的**结论**，不是原价的定义。
> **禁止把两者合并成一个表达式**，也禁止让 `originalAmount` 承担「哪些金额参与分账」的配置语义。

**优惠券规则**：成本**全部由俱乐部承担**，**不得**减少打手按商品原价算出的理论收入。

**恒等式（必须永远成立）**

```
actualPaidAmount = companionBaseIncome + clubNetIncome
```

**退款：管理员只输入一个 `refundRate`（0% ~ 100%），同一个比例同时作用于三方**

```
userRefundAmount     = floor(actualPaidAmount    × refundRate)
companionReversal    = floor(companionBaseIncome × refundRate)
clubIncomeAdjustment = userRefundAmount − companionReversal            ← 可能为负
```

**取整规则**：**只**对前两项向下取整，第三项由**减法**得出——因此

```
companionReversal + clubIncomeAdjustment === userRefundAmount      （严格成立，永远）
```

不要分别对三方独立取整后再相加。

**退款后余额**

```
companionFinalIncome = companionBaseIncome − companionReversal
clubFinalNetIncome   = clubNetIncome       − clubIncomeAdjustment
```

> 整数物化以本节为准。`companionBaseIncome × (1 − refundRate)` 是实数意义上的意图值；**不足 1 分的残差留在打手侧**（`floor` 舍掉的部分不被追缴）。

**⚠️ 命名约束**：`clubNetIncome × refundRate` **不得**命名为 `clubRefundAmount` 之类——它可能为负。统一用 `clubIncomeAdjustment`（收入调整额，可正可负）。

**验算**

| 场景 | `companionBaseIncome` | `clubNetIncome` | `refundRate` | `userRefundAmount` | `companionReversal` | `clubIncomeAdjustment` |
|---|---|---|---|---|---|---|
| 原价 50、8:2、无券 | 40 | 10 | 50% | 25 | 20 | 5 |
| 原价 50、券 10、实付 40 | 40 | 0 | 50% | 20 | 20 | 0 |
| 原价 50、券 30、实付 20 | 40 | **−20** | 50% | 10 | 20 | **−10** |

第三行的业务含义：俱乐部为优惠券保底补贴该单 20 元；退款一半后，最终补贴亏损 10 元。**负数是允许的业务事实**，不得因此下调打手理论收入。

**全系统禁止浮点「元」金额，一律整数「分」。**

### 2.7 PlatformConfig

```ts
export type PlatformConfig = {
  /** 公共订单池无人接单超时时长（分钟） */
  publicPoolTimeoutMinutes: number;
  updatedAt: string;
  updatedByAdminId: string | null;
};
```

---

## 三、架构决策（D1 有条件通过；D2 已否决；D3/D4/D5 通过）

### D1 超时推进机制 —— **有条件通过：`deadline` 驱动 + 惰性物化**

**语义（必须原样实现）**：订单一旦进入某个带时限的状态，就把**截止时刻**写成字段（`publicDeadlineAt` / `exclusiveDeadlineAt` / `settleAt`）。

- 达到 `deadlineAt` 即**已经超时**——订单**不再允许被接取**，应自动全额退款。
- 判定**一律基于 `deadline <= now`**，**绝不基于「上次查询时间」**。「没人来看，所以还没超时」是错的：金额与状态的真相由时间决定，不由有没有访问者决定。
- 惰性物化只是**把已经成立的超时事实写进存储**的手段，不是事实的来源。
- 因此 `sweepExpiredDispatches(now)` / `sweepMaturedEarnings(now)` **必须写成可重复调用、幂等**的业务入口。将来接入后台调度器时调用的是**同一套函数**——**严禁另写第二套超时退款逻辑**（见 Global Constraint #13）。

**⚠️ 真实支付上线前的阻塞项**：Mock 环境下惰性物化「总有人会触发」；真实生产不能依赖这一点（恶意用户静置订单即可让退款永远不发生、打手收益永远不解冻）。**接入后台定时调度器是真实支付上线的阻塞项**，详见 §九「技术债与生产阻塞项」TD-1。

### D2 ~~第 4 套独立身份~~ —— **已否决**

打手**不新建 Cookie、不新建开关、不做第二次登录**。`requireCompanion()` 建立在既有 `requireUser()` 之上：

```
requireUser() → User Session → userId
                            → 按 userId 查 Companion → 校验 enabled && removedAt === null
```

未绑定 Companion 的普通用户访问打手工作台 → 引导到一个明确的「你还不是打手」页面，**不是**再给一个登录入口。

> 注意：`StaffRole` / `ADMIN_ROLES` 里那个 `"companion"` 是**另一个概念**（管理后台的模块权限位），**保持不动**，不要与本决策的打手身份混淆。

### D3 打手登录门槛 = `Companion.enabled && removedAt === null` —— **通过**

与 `canStaffSignIn` 同形；`UserQualificationRecord` 保持为「发放依据的审计记录」，不作为第二处判据。

### D4 打手自身动作不进 admin 审计 —— **通过**

`Dispatch` / `CompletionSubmission` 实体字段本身就是业务证据（各自带时间戳与操作者 id）。

> **⚠️ 「不进入 Admin Audit」≠「不留业务证据」。** 打手动作必须在**自己的实体**上留下可追溯记录（谁、何时、做了什么），只是因为 `ActorRole` 刻意只有 `"admin" | "customer_service"` 两个值、且审计模块定位是「管理端写入」，才不写进那张表。**不得**因为不进审计就省略实体字段。

### D5 管理端/客服在打手域的动作仍走既有 admin 审计 —— **通过**

按需扩 `AdminAuditTargetType` 与 `AdminAuditAction`。

**关键区分：「管理员主动动作」才进 Admin Audit；「系统生命周期动作」不进。**

| 类别 | 例子 | 落点 |
|---|---|---|
| **管理员 / 客服主动的管理行为** → **进** Admin Audit | 封禁 / 解封打手、等级 B/A/S 调整、并发上限调整、平台参数（公共池超时）修改、商品分账比例修改、完成材料审核（通过 / 驳回）、售后处理、管理员退款裁决、管理员主动执行的资源管理动作（含物理删除） | `AdminAuditLog` |
| **打手自身业务动作** | 接单、开始服务、提交完成材料 | 各领域实体字段（`Dispatch` / `CompletionSubmission`），见 D4 |
| **系统自动生命周期动作** | **普通订单完成 48h 后聊天物理删除**、公共池超时自动退款、48h 冻结自动解冻 | **对应实体字段与业务记录**（如订单 `refundedAt` / `refundedAmount`、Earning 的 `availableAt` / 状态流转） |

> ⚠️ **不要为自动聊天清理写管理员审计记录。** 它没有 actor，不是管理行为；写进去会污染「谁做了什么」这条审计语义。可追溯性由会话记录本身的删除时间字段与订单/投诉/退款记录保证。

---

## 四、批次依赖图

```
                ┌──────────────────────────────────────────────────┐
                │  无依赖（可并行开工，但按编号顺序执行）              │
                ├──────────────────────────────────────────────────┤
   P0-1 平台参数配置 │ P0-2 通知写入能力 │ P0-3 金额域拆分 │ P0-4 打手工作台
                └───────┬──────────┬──────────┬─────────┬─────────┘
                        │          │          │         │
                        └──────────┴────┬─────┴─────────┘
                                        ▼
                                   P0-5 派单域  ←── 核心批次
                                        ▼
                                   P0-6 开始服务
                                        ▼
                             P0-7 完成材料 + 客服审核
                                        ▼
                                   P0-8 结算域
                                        ▼
                             P0-9 消费累计改按实付

  P1-1 退款限定 serving + 部分退款裁决   ← 依赖 P0-3 / P0-5
  P1-2 投诉 48h 窗口 + 三种处置 + AfterSalesCase  ← 依赖 P0-5
  P1-3 聊天打手角色 + 更换打手 + 保留/删除  ← 依赖 P0-5
  P1-4 打手封禁语义  ← 依赖 P0-5 / P0-7
  P1-5 打手等级 B/A/S + 并发上限  ← 依赖 P0-5
  P1-6 优惠券参与结算  ← 依赖 P0-3

  P2    售后聚合工作台 / 罚款 / 服务异常定义 / 平台参数扩展
```

---

## 五、批次总览

| 批次 | 名称 | 新增文件 | 改动面 | 独立验收标志 |
|---|---|---|---|---|
| **P0-1** | 平台参数配置 | 11 | 后台侧栏 + 新模块 | 后台能改公共池超时分钟数并生效 |
| **P0-2** | 站内通知写入能力 | 0 | 通知模块 4 文件 | 能程序化写入一条通知并在「系统通知」看到 |
| **P0-3** | 金额域拆分 + 商品分账比例 | 4 | 订单/商品/结算页 | 订单详情显示原价/实付/打手收益三行 |
| **P0-4** | 打手工作台接入（基于 User Session） | 8 | 复用用户会话 | 已是打手的用户能进入空工作台；非打手被明确拒绝 |
| **P0-5** | **派单域** | 16 | 订单创建语义 + 打手工作台 | 下单 → 专属池 → 公共池 → 接单 / 超时退款 |
| **P0-6** | 开始服务 | 3 | 打手工作台 | 打手点「开始服务」后订单变护航中 |
| **P0-7** | 完成材料 + 客服审核 | 14 | 客服工作台 | 提交材料 → 客服通过 → 订单完成 |
| **P0-8** | 结算域 | 9 | 打手工作台 | 完成后进冻结，48h 后转可提现 |
| **P0-9** | 消费累计改按实付 | 0 | 等级模块 | 刚支付未完成的订单也计入消费 |
| **P1-1** | 退款限定 serving + 部分退款裁决 | 5 | 退款模块 | 只有护航中能申请；管理员可裁 50% |
| **P1-2** | 投诉 48h + 三种处置 | 8 | 投诉模块 | 超 48h 不能投诉；可换打手 |
| **P1-3** | 聊天打手角色 + 保留策略 | 6 | 消息模块 | 打手能发言；到期聊天被删 |
| **P1-4** | 打手封禁语义 | 3 | 护航管理 | 封禁时订单按状态分流处理 |
| **P1-5** | 打手等级 B/A/S + 并发上限 | 7 | 护航管理 | 管理员设等级后并发上限随之变化 |
| **P1-6** | 优惠券参与结算 | 3 | 结算页 + 订单 | 用券后实付减少、打手收益不变 |

---

## 六、逐批详述

### P0-1 平台参数配置

**目标**：管理员可修改「公共订单池无人接单超时时长」，订单进入公共池时冻结快照。

**新增文件**

| 路径 | 职责 |
|---|---|
| `lib/types/platformConfig.ts` | `PlatformConfig` 类型 |
| `lib/constants/platformConfig.ts` | 上下限常量、默认值、校验函数、Mock 提示文案 |
| `lib/mocks/fixtures/platformConfigSeed.ts` | 预置配置（默认 60 分钟） |
| `lib/data/platformConfigRepository.ts` | 接口 + `getPlatformConfigRepository()` |
| `lib/data/mockPlatformConfigRepository.ts` | `platformConfigStore()` / `readPlatformConfig()` / `writePlatformConfig()`（同步写原语） |
| `lib/data/adminPlatformConfigTransaction.ts` | 原子写入 + 幂等 + 审计 |
| `lib/services/adminPlatformConfig.ts` | 入参白名单解析 + 校验 + DTO |
| `app/api/admin/platform-config/route.ts` | `GET` 读取 / `PATCH` 修改（首行 `await requireAdmin()`） |
| `app/admin/(console)/platform-config/page.tsx` | 服务端首屏 |
| `components/admin/AdminPlatformConfigConsole.tsx` | 客户端表单 |
| `tests/platformConfig.test.mjs` | 单测 |

**修改文件**

| 路径 | 改动 |
|---|---|
| `lib/data/mockStore.ts` | `MockStoreName` 增 `"platformConfig"` |
| `lib/constants/admin.ts` | `ADMIN_NAV_ITEMS` 增 `{key:"platform-config", href:"/admin/platform-config", label:"平台参数"}` |
| `lib/services/adminHttp.ts` | 增 `fetchAdminPlatformConfig()` / `saveAdminPlatformConfig(idempotencyKey, patch)` |
| `lib/types/adminAudit.ts` | `AdminAuditTargetType` 增 `"platformConfig"`；`AdminAuditAction` 增 `"platformConfig.update"` |
| `lib/constants/adminAudit.ts` | 增 `"platformConfig.update"` 标签 + `toPlatformConfigAuditSnapshot()` |
| `tests/admin.test.mjs` | 清单数组增 `platform-config/route.ts`（1 条），并改 `test()` 标题 |

**数据结构**：见 §2.7。

**约束**：整数，`1 ≤ n ≤ 1440`（分钟）。非法值返回 `BAD_REQUEST`，不静默取默认值。

**测试**（`tests/platformConfig.test.mjs`）
- 默认值为 60
- `isValidPublicPoolTimeoutMinutes`：`0` / `1441` / `1.5` / `"60"` / `NaN` 全部为 `false`；`1` / `1440` 为 `true`
- PATCH 后 `getConfig()` 返回新值；再 PATCH 非法值返回失败且**旧值不变**
- 同 `operationId` 重放：第二次返回 `replayed: true`，且审计只有一条
- 仓储只读清单：`Object.keys(repository).sort()` 严格相等

**手工验收**
1. `ENABLE_MOCK_ADMIN=true ENABLE_MOCK_AUTH=true pnpm dev`
2. 进 `/admin`，侧栏出现「平台参数」
3. 把超时改成 `1`，保存 → 刷新页面仍是 `1`
4. 改成 `0` → 页面提示错误，且值仍是 `1`
5. 进 `/admin` 概览或其他页面再回来，值保持
6. 重启 dev server → 回到 `60`（内存存储的预期行为）

---

#### P0-1 任务分解（TDD）

- [ ] **Task 1: 平台参数类型与校验常量**

**Files:** Create `lib/types/platformConfig.ts`, `lib/constants/platformConfig.ts`, `tests/platformConfig.test.mjs`

**Interfaces — Produces:** `PlatformConfig`；`PUBLIC_POOL_TIMEOUT_MIN_MINUTES=1`、`PUBLIC_POOL_TIMEOUT_MAX_MINUTES=1440`、`PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES=60`、`PLATFORM_CONFIG_NOTICE`、`isValidPublicPoolTimeoutMinutes(value): value is number`

- [ ] Step 1: 写失败测试

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  isValidPublicPoolTimeoutMinutes,
} from "@/lib/constants/platformConfig";

test("公共池超时默认值是 60 分钟", () => {
  assert.equal(PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES, 60);
});

test("公共池超时只接受 1~1440 的整数分钟", () => {
  for (const bad of [0, -1, 1441, 1.5, Number.NaN, "60", null, undefined, {}]) {
    assert.equal(isValidPublicPoolTimeoutMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [1, 60, 1440]) {
    assert.equal(isValidPublicPoolTimeoutMinutes(good), true, `${good} 应当通过`);
  }
});
```

- [ ] Step 2: 跑测试确认失败 — `pnpm test tests/platformConfig.test.mjs`，预期 `Cannot find module`
- [ ] Step 3: 写实现（`lib/types/platformConfig.ts` 定义 §2.7 类型；`lib/constants/platformConfig.ts` 定义常量与 `isValidPublicPoolTimeoutMinutes`）
- [ ] Step 4: 跑测试确认通过
- [ ] Step 5: 提交

```bash
git add lib/types/platformConfig.ts lib/constants/platformConfig.ts tests/platformConfig.test.mjs
git commit -m "feat: 平台参数类型与校验常量"
```

- [ ] **Task 2: Mock 存储与仓储**

**Files:** Create `lib/mocks/fixtures/platformConfigSeed.ts`, `lib/data/platformConfigRepository.ts`, `lib/data/mockPlatformConfigRepository.ts`; Modify `lib/data/mockStore.ts`

**Interfaces — Consumes:** Task 1 的常量。**Produces:** `platformConfigStore()`, `readPlatformConfig(): PlatformConfig`, `writePlatformConfig(next): { previous, updated }`, `getPlatformConfigRepository()`

- [ ] Step 1: 写失败测试（追加到 `tests/platformConfig.test.mjs`）

```js
import { getPlatformConfigRepository } from "@/lib/data/platformConfigRepository";
import {
  mockPlatformConfigRepository,
  writePlatformConfig,
  readPlatformConfig,
} from "@/lib/data/mockPlatformConfigRepository";
import { resetMockStore } from "@/lib/data/mockStore";

test("仓储接口只有 getConfig", () => {
  assert.deepEqual(Object.keys(mockPlatformConfigRepository).sort(), ["getConfig"]);
});

test("写入后读回新值，且旧值被替换", async () => {
  resetMockStore("platformConfig");
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 60);

  const now = "2026-09-17T00:00:00.000Z";
  writePlatformConfig({ publicPoolTimeoutMinutes: 90, updatedAt: now, updatedByAdminId: "admin-1" });

  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 90);
  const viaRepository = await getPlatformConfigRepository().getConfig();
  assert.equal(viaRepository.publicPoolTimeoutMinutes, 90);
});
```

- [ ] Step 2: 跑测试确认失败
- [ ] Step 3: 实现三个文件；`mockStore.ts` 的 `MockStoreName` 增 `"platformConfig"`。`createStore()` 必须**深拷贝 seed**（`{ ...platformConfigSeed }`），否则测试间会互相污染
- [ ] Step 4: 跑测试确认通过
- [ ] Step 5: 提交

- [ ] **Task 3: 管理端原子写入与审计**

**Files:** Create `lib/data/adminPlatformConfigTransaction.ts`; Modify `lib/types/adminAudit.ts`, `lib/constants/adminAudit.ts`

**Interfaces — Consumes:** `AdminWriteContext`、`takeReplayForAction`、`writeAudit`（均在 `lib/data/adminWriteSupport.ts`）。**Produces:** `updatePlatformConfig(input, ctx): Promise<AdminPlatformConfigWriteResult>`

- [ ] Step 1: 写失败测试

```js
import { updatePlatformConfig } from "@/lib/data/adminPlatformConfigTransaction";
import { getAdminAuditRepository } from "@/lib/data/adminAuditRepository";

const ctx = {
  actorId: "admin-1",
  actorRole: "admin",
  actorName: "超级管理员",
  operationId: "op-pc-1",
  at: "2026-09-17T01:00:00.000Z",
};

test("修改平台参数写入审计", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updatePlatformConfig({ publicPoolTimeoutMinutes: 30 }, ctx);
  assert.equal(result.kind, "ok");
  assert.equal(result.changed, true);

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "platformConfig.update");
  assert.equal(audits[0].before.publicPoolTimeoutMinutes, 60);
  assert.equal(audits[0].after.publicPoolTimeoutMinutes, 30);
});

test("同一 operationId 重放不再写审计", async () => {
  const result = await updatePlatformConfig({ publicPoolTimeoutMinutes: 45 }, ctx);
  assert.equal(result.replayed, true);
  assert.equal(result.changed, false);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);
});
```

- [ ] Step 2: 跑测试确认失败
- [ ] Step 3: 实现。原子区段骨架**照抄** `lib/data/adminComplaintTransaction.ts:92-134` 的顺序：`takeReplayForAction` → `conflict` 短路 → 读当前值 → `replay` 分支只返回 → 校验 → `writePlatformConfig` → `writeAudit`。**区段内不得出现 `await`。**
- [ ] Step 4: 跑测试确认通过
- [ ] Step 5: 提交

- [ ] **Task 4: 服务层与路由**

**Files:** Create `lib/services/adminPlatformConfig.ts`, `app/api/admin/platform-config/route.ts`; Modify `tests/admin.test.mjs`

**Interfaces — Produces:** `getAdminPlatformConfig()`、`updateAdminPlatformConfig(adminId, adminName, body)`；路由 `GET` / `PATCH`。**Consumes:** Task 3 的 `updatePlatformConfig`。

- [ ] Step 1: 先改测试清单门禁（此时测试**必须失败**）

在 `tests/admin.test.mjs` 的清单数组里按字母序插入 `"platform-config/route.ts"`（位于 `orders/route.ts` 之后、`products/[id]/publish/route.ts` 之前），并把 `test()` 标题从「…+ 运营内容十九件」改为「…+ 运营内容十九件 + 平台参数一件」。

- [ ] Step 2: 跑 `pnpm test tests/admin.test.mjs`，预期 FAIL（少一个文件）
- [ ] Step 3: 实现服务与路由。路由文件：

```ts
import { requireAdmin } from "@/lib/api/adminRoute";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { getAdminPlatformConfig, updateAdminPlatformConfig } from "@/lib/services/adminPlatformConfig";

export async function GET() {
  await requireAdmin();
  try {
    return ok(await getAdminPlatformConfig());
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  try {
    return ok(await updateAdminPlatformConfig(admin.id, admin.displayName, await readJsonBody(request)));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
```

- [ ] Step 4: 跑测试确认通过（含清单门禁）
- [ ] Step 5: 提交

- [ ] **Task 5: 后台页面**

**Files:** Create `app/admin/(console)/platform-config/page.tsx`, `components/admin/AdminPlatformConfigConsole.tsx`; Modify `lib/constants/admin.ts`, `lib/services/adminHttp.ts`

**Interfaces — Consumes:** `getAdminPlatformConfig`（服务端首屏）、`fetchAdminPlatformConfig` / `saveAdminPlatformConfig`（浏览器端）。

- [ ] Step 1: `lib/constants/admin.ts` 的 `ADMIN_NAV_ITEMS` 增 `{ key: "platform-config", href: "/admin/platform-config", label: "平台参数", description: "公共订单池超时等平台级规则" }`
- [ ] Step 2: `lib/services/adminHttp.ts` 增两个函数（照抄同文件既有 `fetchAdmin*` / `save*` 的写法：`apiGet` / `apiPatch` + `ApiError`）
- [ ] Step 3: 写页面（服务端组件，`export default async function AdminPlatformConfigPage()`，首屏取数后传给客户端组件）+ 表单组件（照 `components/admin/AdminAnnouncementForm.tsx` 的结构）
- [ ] Step 4: `pnpm typecheck` + `pnpm lint` 全绿
- [ ] Step 5: 手工验收（见上「手工验收」6 步）
- [ ] Step 6: 提交

---

### P0-2 站内通知写入能力

**目标**：补上「创建通知」的写入路径。现有模块只有读取与标记已读，全部通知来自 Seed。

**新增文件**：无（不新建通知模块，避免第二套）。

**修改文件**

| 路径 | 改动 |
|---|---|
| `lib/types/notification.ts` | `NotificationKind` 增 `"dispatch"`（派单相关） |
| `lib/constants/service.ts` | `NOTIFICATION_KIND_LABELS` 增 `dispatch` 标签 |
| `lib/data/notificationRepository.ts` | 接口增 `createNotification(input): Promise<Notification>` |
| `lib/data/mockNotificationRepository.ts` | 增**同步** `appendNotification(record): Notification`（供原子区段调用）+ `notificationStore()` |
| `lib/services/notifications.ts` | 增 `createNotificationForUser(input)` |

**关键约束**：`appendNotification` 必须是**同步**的，因为业务写入（订单超时退款、订单回公共池）发生在原子区段内，通知必须与之同段写入，否则会出现「订单退了但没通知」。

**测试**（`tests/notifications.test.mjs`）
- `appendNotification` 后 `listNotifications(userId)` 能查到，且归属正确（不串到别的用户）
- 通知的 `readAt` 初始为 `null`，未读数 +1
- `createNotification` 返回的记录 id 不与其他记录冲突
- 仓储只读清单检查（确保没有意外暴露删除/更新）

**手工验收**：`/service` → 「系统通知」标签，能看到通过代码写入的通知；点击后未读数减少。

---

### P0-3 金额域拆分 + 商品分账比例

**目标**：订单从「一个 `totalAmount`」拆成 §2.1 的金额域（原价 / 优惠券抵扣 / 实付 / 分账比例快照 / 打手理论收入 / 俱乐部净收益 / 累计已退），并把商品分账比例冻结进订单快照。

**新增文件**

| 路径 | 职责 |
|---|---|
| `lib/constants/orderAmount.ts` | 基点常量 + `resolveCompanionBaseIncome()` / `resolveClubNetIncome()` 纯函数 + **唯一的取整处** |
| `lib/constants/shareRatio.ts` | 分账比例校验（0~10000 整数基点） |
| `tests/orderAmountSplit.test.mjs` | 单测 |
| `tests/shareRatio.test.mjs` | 单测 |

**修改文件**

| 路径 | 改动 |
|---|---|
| `lib/types/order.ts` | 增 §2.1 的 7 个金额字段；`companionId` 改名为 `actualCompanionId`（见 P0-5） |
| `lib/types/catalog.ts` | 商品记录增 `companionRateBp: number` |
| `lib/mocks/fixtures/catalogSeed.ts` | 商品预置分账比例（默认 8000） |
| `lib/mocks/fixtures/orderSeed.ts` | 历史订单补金额域字段 |
| `lib/data/mockPaymentRepository.ts` | 订单创建时写入金额域快照 |
| `lib/services/checkout.ts` | `buildOrderFromRequest` 计算并冻结 `originalAmount` / `couponDiscountAmount`(=0) / `actualPaidAmount` / `companionRateSnapshot` / `companionBaseIncome` / `clubNetIncome` / `refundedAmount`(=0) |
| `lib/services/orders.ts` | `toOrderDetail` 增金额域字段 |
| 订单详情展示 | 在 `app/(mobile)/orders/[id]/page.tsx` 及其引用的客户端组件里显示「原价 / 实付 / 护航收益」三行 |
| 商品管理表单 | 在 `app/admin/(console)/products/**` 引用的表单组件里增分账比例输入（基点，UI 显示为百分比） |
| `tests/orders.test.mjs`、`tests/checkout.test.mjs` | 同步新字段 |

**核心函数（写进 `lib/constants/orderAmount.ts`）**

```ts
export const SHARE_RATIO_BP_MAX = 10000;   // 100.00%

/**
 * 打手理论收入 = floor(分账基数 × 比例快照 / 10000)。优惠券不降低本值（§2.6）
 * ⚠️ 第一个参数是**分账基数**，不是订单原价——两者当前数值相同，但那是规则的结果。
 */
export function resolveCompanionBaseIncome(companionRevenueBaseAmount: number, rateBp: number): number {
  return Math.floor((companionRevenueBaseAmount * rateBp) / SHARE_RATIO_BP_MAX);
}

/** 俱乐部净收益 = 用户实付 − 打手理论收入。**允许为负**（§2.6 第三行验算） */
export function resolveClubNetIncome(actualPaidAmount: number, companionBaseIncome: number): number {
  return actualPaidAmount - companionBaseIncome;
}
```

**R3 已确认（2026-09-18）：全部增值服务参与打手分账**

业务原则：**只要增值服务是由当前打手实际履约提供的，就属于该订单的服务收入**，应与商品主体一起按订单冻结的打手分账比例计算。V1 **不需要**「某些增值服务参与分账、某些不参与」的复杂配置；将来平台自己履约的收费项再单独扩展。

1. 在 `lib/constants/orderAmount.ts` 里定义**唯一**的求解函数：

```ts
/**
 * 参与分账的基数——与「订单原价」是两个概念。
 * R3 已确认（2026-09-18）：V1 的全部增值服务参与分账，因此基数 = 商品金额 + 全部增值服务金额。
 * 这条规则只写在这一处；产品若再次调整，改的是这个函数体与
 * tests/orderAmountSplit.test.mjs 里那一条用例。
 */
export function resolveCompanionRevenueBase(itemsAmount: number, addonsAmount: number): number {
  return itemsAmount + addonsAmount;
}
```

2. **`originalAmount` 必须是 `Order` 上真实存储的字段**，不得在读取时用 `resolveCompanionRevenueBase(...)` 现算——商品改价不影响历史订单。
3. **原价的构成独立于决策点**：`originalAmount = itemsAmount + addonsAmount` 是「优惠前应付总额」这条定义本身，**不得**写成 `resolveCompanionRevenueBase(...)` 的返回值。当前两者数值相同，但那是规则的结果；合并之后这个等式就变成代码事实，将来出现「进原价但不进基数」的收费项时改一处会同时改掉原价。
4. 用一条**明确的业务后果用例**锁定，防止回退成「增值服务 100% 归俱乐部」：

```js
test("R3 的业务后果：商品 3980 + 增值服务 1000、比例 80% → 护航 3984 / 平台 996", () => {
  const domain = resolveOrderMoneyDomain({
    itemsAmount: 3980, addonsAmount: 1000, companionRateBp: 8000, couponDiscountAmount: 0,
  });
  assert.equal(domain.originalAmount, 4980);
  assert.equal(domain.actualPaidAmount, 4980);
  assert.equal(domain.companionBaseIncome, 3984);   // 不是 3184
  assert.equal(domain.clubNetIncome, 996);          // 不是 1796
});
```

> 若有人绕过决策点直接改调用处，`tests/orderAmountSplit.test.mjs` 里的金额恒等式断言与上面这条业务后果用例会红。

**测试要点**
- **恒等式**：对 `实付 ∈ {1, 50, 100, 9999, 2000}` × `bp ∈ {0, 3333, 8000, 10000}`，`companionBaseIncome + clubNetIncome === actualPaidAmount` 恒成立
- 边界：`bp = 0` → 打手 0、俱乐部 = 实付；`bp = 10000` → 打手 = 原价、俱乐部 = 实付 − 原价（有券时**为负且被接受**）
- 取整：`原价 1、bp 3333` → `0`（不是 0.333）；`原价 50、bp 8000` → `40`
- **负数用例**：`实付 2000、原价 4000、bp 8000` → `companionBaseIncome = 3200`、`clubNetIncome = -1200`，断言**不抛错、不取绝对值、不被夹到 0**
- 下单后 `Order` 的金额域字段与 `previewCheckout` 的试算一致

**手工验收**：结算页下单 → 订单详情能看到「原价 ¥50 / 实付 ¥50 / 护航收益 ¥40」；到后台把该商品比例改成 70% → **旧订单仍是 ¥40**。

---

### P0-4 打手工作台接入（基于 User Session）

**目标**：**已是打手的用户**能从自己的用户会话直接进入打手工作台（空壳，无订单功能）。**不新建身份体系。**

**本批次明确「不做」的事**（D2 已否决，写在这里防止后来者重新引入）

- ❌ 不建 `lib/auth/companionSession.ts`
- ❌ 不建 Cookie `mock_companion_id`
- ❌ 不建开关 `ENABLE_MOCK_COMPANION`（`lib/config/env.ts` 保持现在 5 个开关）
- ❌ 不建 `app/companion/login/page.tsx`（打手没有独立登录页）
- ❌ 不建 `app/api/companion/auth/**`（没有登录 / 登出 / 会话接口——身份来自用户会话）

**新增文件**

| 路径 | 职责 |
|---|---|
| `lib/api/companionRoute.ts` | `requireCompanion(): Promise<CompanionSessionUser>`——见下方实现 |
| `lib/services/companionAccess.ts` | `resolveCompanionAccess(userId)` 纯查询 + `getCompanionWorkspaceView(userId)` |
| `lib/types/companionWorkspace.ts` | `CompanionSessionUser` / `CompanionAccessState` / `CompanionWorkspaceView` |
| `lib/constants/companionConsole.ts` | 工作台标题、导航项、`NOT_A_COMPANION` 提示文案（对齐 `lib/constants/staff.ts` 的写法） |
| `app/companion/(console)/layout.tsx` | 服务端解析访问态：`granted` → 渲染；否则渲染提示页 |
| `app/companion/(console)/page.tsx` | 工作台概览（P0 仅显示打手昵称与「后续开放」） |
| `components/companion/CompanionHeader.tsx` | 顶部导航（照 `components/staff/StaffHeader.tsx`，但**不含退出登录**——退出走用户端退出） |
| `tests/companionAccess.test.mjs` | 单测 |

**修改文件**

| 路径 | 改动 |
|---|---|
| 用户端「我的」页 | 若需要打手工作台入口，只加一个链接到 `/companion`；**不加登录入口、不加新开关** |

**核心实现（`lib/api/companionRoute.ts`）**

```ts
import { ApiError } from "@/lib/api/ApiError";
import { requireUser } from "@/lib/api/route";
import { getCompanionRepository } from "@/lib/data/companionRepository";
import type { CompanionSessionUser } from "@/lib/types/companionWorkspace";

/**
 * 打手身份 = 用户身份 + 一条有效的护航资料。
 *
 * **没有第二套会话**：先走既有的 requireUser() 拿到 userId，
 * 再按 userId 查 Companion（findCompanionByUser 已经排除 removedAt !== null 的记录），
 * 最后校验 enabled。未登录用户会在这里拿到 UNAUTHORIZED，与会话机制完全一致。
 */
export async function requireCompanion(): Promise<CompanionSessionUser> {
  const user = await requireUser();
  const companion = await getCompanionRepository().findCompanionByUser(user.id);
  if (!companion) throw new ApiError("FORBIDDEN", "你还不是护航，无法进入工作台");
  if (!companion.enabled) throw new ApiError("FORBIDDEN", "你的护航资格已下架，请联系管理员");
  return {
    userId: user.id,
    companionId: companion.id,
    displayName: companion.displayName,
    avatarUrl: companion.avatarUrl,
  };
}
```

> `findCompanionByUser` 的语义就是「一名用户最多关联一条**有效**护航（已移除的不算）」——它已经覆盖了 `removedAt`，这里**不要**再写一次 `removedAt === null` 判断，避免出现两个真值来源。

**页面行为**

| 访问者 | `/companion` 的表现 |
|---|---|
| 未登录（无用户会话） | `redirect("/login")`——**复用用户端登录页**，不新建登录页 |
| 已登录但不是打手 | 渲染「你还不是护航」提示页（含「如何成为护航」说明），**不是**再给一个登录入口 |
| 已登录、是打手但 `enabled = false` | 渲染「护航资格已下架」提示页 |
| 已登录、是打手且 `enabled = true` | 工作台概览 |

**测试**（`tests/companionAccess.test.mjs`）
- `resolveCompanionAccess`：无 Companion → `not-a-companion`；`enabled=false` → `disabled`；`removedAt !== null` → `not-a-companion`；正常 → `granted`
- **`findCompanionByUser` 已排除 removed 的回归断言**：软移除后 `resolveCompanionAccess` 必须返回 `not-a-companion`（若有人把 `findCompanionByUser` 改成含已移除，这条会红）
- **没有第二套身份的静态断言（负向门禁）**：全仓扫描确认**不存在**下列任一字符串 / 路径——
  - `ENABLE_MOCK_COMPANION`（环境开关）
  - `mock_companion_id`（独立 Cookie）
  - `companionSession`（独立会话模块）
  - `app/companion/login`（独立登录页）
  - `app/api/companion/auth`（独立认证接口）

  > ⚠️ **不要用 `readFlag(` 的调用总次数做门禁**——那会让以后新增任何无关环境开关时产生无意义失败。本门禁要保证的是「**打手能力建立在现有 User Session 之上**」，不是「环境变量开关数量恒定」。
- **隔离断言**：`lib/api/companionRoute.ts` 不得 import `staffSession` / `adminSession`

**手工验收**
1. `ENABLE_MOCK_AUTH=true pnpm dev`
2. 未登录访问 `/companion` → 跳用户登录页
3. 用**普通用户**（非打手）身份登录 → 访问 `/companion` → 看到「你还不是护航」提示页
4. 后台把某位打手关联到当前用户（审核通过），或用一个 `userId` 已关联打手的账号登录 → 访问 `/companion` → 进入工作台，看到打手昵称
5. 后台把该打手下架（`enabled=false`）→ 刷新 `/companion` → 看到「资格已下架」
6. **不存在的验证**：访问 `/companion/login` → **404**（本项目没有打手登录页）

---

### P0-5 派单域（核心批次）

**目标**：订单支付后进入派单；指定打手走专属池（固定 10 分钟），否则直接进公共池；专属池到点无人接 → **自动转公共池**（不是退款、不是售后、不是订单失败）；公共池达配置超时仍无人接 → **自动全额退款**；打手可接单，接单必须原子、必须防并发抢单、必须防过期抢单。

**⚠️ 本批次不做「拒绝 / 放弃 / 不接」**：打手不想接专属单时**什么都不做**，10 分钟到点系统自动转公共池。**没有** decline 接口、**没有**放弃按钮、**没有** `declinedByCompanionIds`。

**⚠️ 本批次不做并发上限**：`DEFAULT_MAX_CONCURRENT_ORDERS` 属于 **P1-5**（打手等级 B/A/S + 并发上限），本批次**不得提前实现**——不做常量、不做计数、不做 `concurrency-limit` 结果。

**⚠️ 本批次有一处破坏性语义变更**：订单创建时**不再**绑定打手。原「结算页选的陪玩」改存 `Dispatch.exclusiveCompanionId`。这会改动 `lib/services/checkout.ts`、订单 DTO、订单列表 UI 文案与多个既有测试。

**⚠️ 同时是一次改名**：`Order.companionId` → **`Order.actualCompanionId`**。名字必须体现「**实际接到这单的人**」，而不是「用户想要的人」。两个字段永远回答两个不同的问题：

| 问题 | 字段 | 写入时机 |
|---|---|---|
| 用户**指定**过谁 | `Dispatch.exclusiveCompanionId` | 下单时（结算页选项） |
| 实际**接单**的是谁 | `Order.actualCompanionId` + `Dispatch.acceptedByCompanionId` | 接单原子区段第 10 步 |

**两者必须始终由同一处写入，且永不允许各自漂移。** 典型场景：用户指定 A → A 未在 10 分钟内接单 → 进公共池 → B 接单。此时 `exclusiveCompanionId = A`、`actualCompanionId = B`，**两个事实都可查**，管理端与用户端都能看到「你要的 A 没接，实际是 B 服务的」。

**绝不**为了省事把 `exclusiveCompanionId` 复制进 `actualCompanionId`，也**绝不**因为 `actualCompanionId` 已写就把 `exclusiveCompanionId` 清空。

**新增文件**

| 路径 | 职责 |
|---|---|
| `lib/types/dispatch.ts` | §2.2 类型 + 打手端 DTO（`CompanionPoolItem` / `CompanionPoolDetail`） |
| `lib/constants/dispatch.ts` | `EXCLUSIVE_WAIT_MINUTES = 10`、状态标签、筛选解析 |
| `lib/data/dispatchRepository.ts` | 接口 + `getDispatchRepository()` |
| `lib/data/mockDispatchRepository.ts` | `dispatchStore()` + 同步原语（`createDispatchRecord` / `applyDispatchAccepted` / `applyDispatchToPublic` / `applyDispatchTimedOut`） |
| `lib/mocks/fixtures/dispatchSeed.ts` | 为既有历史订单补派单记录（见下「Seed 迁移」） |
| `lib/data/companionDispatchTransaction.ts` | **原子写入**：`acceptDispatch` / `sweepExpiredDispatches` |
| `lib/services/companionDispatch.ts` | 池列表 / 池详情 / 接单（含打手端 DTO 转换，**池内 DTO 不含 `gameAccountId` 与 `remark`**） |
| `lib/services/companionHttp.ts` | 浏览器端取数（`apiGet` / `apiPost`） |
| `app/api/companion/dispatches/route.ts` | `GET` 公共池 + 专属池列表 |
| `app/api/companion/dispatches/[id]/route.ts` | `GET` 池内详情 |
| `app/api/companion/dispatches/[id]/accept/route.ts` | `POST` 接单 |
| `app/companion/(console)/pool/page.tsx` | 公共池页 |
| `app/companion/(console)/exclusive/page.tsx` | 专属池页 |
| `components/companion/CompanionDispatchTable.tsx` | 池列表 |
| `components/companion/CompanionDispatchCard.tsx` | 池卡片 + 接单按钮（**没有放弃按钮**） |
| `tests/dispatch.test.mjs` | 状态机与原子性 |
| `tests/dispatchConcurrency.test.mjs` | 并发抢单 |

**修改文件**

| 路径 | 改动 |
|---|---|
| `lib/data/mockStore.ts` | `MockStoreName` 增 `"dispatch"` |
| `lib/services/checkout.ts` | `buildOrderFromRequest`：`actualCompanionId: null` / `companion: null`；改为调用 `companionDispatchTransaction.createDispatchForOrder()` 建立派单记录，并把结算页选的打手写进 `Dispatch.exclusiveCompanionId` |
| `lib/types/order.ts` | `companionId` **改名** `actualCompanionId`；更新「未绑定只允许出现在 `paid`」的注释语义 |
| `lib/services/orders.ts` | 用户端订单详情/列表增加「派单进度」摘要（当前在专属池还是公共池、剩余时间） |
| `lib/services/adminOrders.ts` 及管理端订单详情 DTO | 增 `exclusiveCompanion`（指定）/ `actualCompanion`（实际）两个字段——**两个都要给**，只给一个会让「指定了但被别人接了」这件事在后台不可见 |
| `lib/mocks/fixtures/orderSeed.ts` | 见「Seed 迁移」 |
| `lib/constants/admin.ts` | 若新增管理端派单视图则同步（本批次可不加） |
| `tests/orders.test.mjs` | `waiting` 判定改为「`paid` 且无 `actualCompanionId`」仍成立，但需补派单断言 |
| `tests/checkout.test.mjs` | 断言订单创建后 `actualCompanionId === null` 且存在对应 Dispatch（含正确的 `exclusiveCompanionId`） |

**本批次对外产出的签名**（后续批次按这些名字调用，不得改名）

```ts
// lib/data/companionDispatchTransaction.ts
export async function createDispatchForOrder(
  orderId: string, exclusiveCompanionId: string | null, at: string,
): Promise<DispatchRecord>;

export async function acceptDispatch(
  dispatchId: string, companionId: string, ctx: CompanionWriteContext,
): Promise<DispatchAcceptResult>;

/**
 * 同步、无 await；由各读取路径在取数前调用。
 *
 * 一次调用处理**两类到点**，两者结果完全不同：
 * - 专属池到点 → **转公共池**（重记 `publicPoolEnteredAt` / 快照 / `publicDeadlineAt`），订单**不退款**；
 * - 公共池到点 → 置 `timed_out` + **自动全额退款**。
 */
export function sweepExpiredDispatches(
  at: string,
): { movedToPublicDispatchIds: string[]; refundedOrderIds: string[] };
```

⚠️ **本轮没有 `declineExclusiveDispatch`**：需求明确「不接本身就是拒绝」，因此不提供任何
拒绝 / 放弃 / 退回公共池的接口与动作。

**原子接单（`acceptDispatch`）区段顺序**

```
取 store 句柄（区段外）
// —— 原子区段开始（无 await）——
1. takeReplayForAction(ctx, "dispatch.accept", "dispatch", dispatchId) → conflict 短路
2. 读 dispatch → 不存在 → { kind: "not-found" }
3. replay 分支 → 原样返回，不写
4. state 必须是 exclusive 或 public → 否则 { kind: "not-open", state }
5. 当前池的 deadline <= ctx.at → { kind: "expired" }  ← **不依赖 sweep 有没有跑**
6. 专属池：companionId 必须等于 exclusiveCompanionId → 否则 { kind: "not-eligible" }
7. 读 companion → enabled && removedAt === null → 否则 { kind: "companion-unavailable" }
8. 写 dispatch：state="accepted", acceptedByCompanionId, acceptedAt
9. 写 order：status="accepted", **actualCompanionId**, companion 快照, acceptedAt
10. 写通知给用户（appendNotification，同步）
// —— 原子区段结束 ——
```

第 5 步**必须在第 8 步之前**，而且判的是 `deadline`、不是 `state`：数据库里 `state` 还是
`public` 只是因为 sweep 还没跑，**这不代表还能抢**。业务事实由 deadline 决定。

**没有并发上限这一步**：`concurrency-limit` 属于 P1-5，本批次不实现。

**`actualCompanionId` 与 `acceptedByCompanionId` 只在第 8、9 步这一处同时写入**，
且两处都在同一个无 `await` 区段里——结构上不可能只写一边。

**并发抢单的验证方式**：Node 单线程 + 区段内无 `await` ⇒ 两个并发 `acceptDispatch` 必然串行执行，第二个进入时 `state` 已是 `"accepted"`，在第 4 步被拒。测试用 `Promise.all([accept(a), accept(b)])` 断言**恰好一个** `kind === "ok"`，另一个是 `{ kind: "not-open", state: "accepted" }`。

**超时清扫（`sweepExpiredDispatches`，同步、无 await）**

遍历 `state ∈ {exclusive, public}` 且**当前池的** deadline `<= at` 的记录，按池分流：

| 到点时所在池 | 处理 | 订单 |
|---|---|---|
| `exclusive` | `state = "public"`，**重记** `publicPoolEnteredAt = at`、`publicTimeoutMinutesSnapshot = 当时的平台配置`、`publicDeadlineAt = at + 快照`；`exclusiveCompanionId` / `exclusiveEnteredAt` / `exclusiveDeadlineAt` **原样保留** | **不动**，仍是 `paid`。**不退款** |
| `public` | `state = "timed_out"`，写 `timedOutAt` | `status = "refunded"`, `refundedAt`, `refundedAmount = actualPaidAmount` |

两种到点各写一条用户通知。返回 `{ movedToPublicDispatchIds, refundedOrderIds }`。

⚠️ **幂等**：函数只处理「当前池的 deadline 已到且 state 仍是那个池」的记录。
第二次调用时专属单已经是 `public`、公共单已经是 `timed_out`，因此**不会**重复转池、
重复退款、重复发通知。**连跑 20 次与跑 1 次结果完全相同**，而且与「上一次什么时候查」无关。

⚠️ **专属池到点不退款**：那只是「A 没接」，订单还在等人接，退钱就等于把一张还能成交的
订单作废。只有公共池到点（平台已给足时间、仍无人接）才退款。

⚠️ **通知幂等不靠随机 id**：通知写在**同一次状态迁移的原子区段内**，
而这条迁移每单至多发生一次（`exclusive→public`、`public→refunded`、`→accepted`），
因此「同一订单 + 同一业务事件」天然只写一条。重复 sweep 连迁移都不会发生，更不会写通知。

**调用点（惰性推进，见决策 D1）**：用户端订单列表/详情读取前、打手端池列表读取前、管理端订单列表读取前各调用一次。每次调用都在 `await` 之前同步完成。

**Seed 迁移**

`dispatchSeed.ts` 为既有的 `accepted` / `serving` / `completed` 历史订单补齐 Dispatch 记录，使数据自洽：
- `accepted` → `state: "accepted"`，`acceptedByCompanionId` = 订单原 `companionId`（迁移后即 `actualCompanionId`），`exclusiveCompanionId` 同值
- `serving` / `completed` → 同上，且 P0-7 落地后补 CompletionSubmission 记录
- `paid` → 按原 `companionId` 是否有值决定进 `exclusive` 还是 `public`（有值 → `exclusive` 且 `exclusiveCompanionId` 同值；无值 → `public`）

> 历史数据的 `exclusiveCompanionId === actualCompanionId` 是**存量事实**（这些单当初就直接绑定了人），不是规则。**不要**把这条写进任何生产逻辑或断言成不变量。

**测试要点**
- 状态机：`exclusive` 超 10 分钟 → `public`（**订单仍 `paid`、不退款**）；`public` 达配置 → `timed_out` + 订单 `refunded` + `refundedAmount === actualPaidAmount`
- **没有 decline**：仓库里不存在 `declineExclusiveDispatch` / decline 路由 / `declinedByCompanionIds`（负向扫描）
- 快照冻结：订单入公共池后改配置，其 `publicDeadlineAt` 不变；之后新入池的订单用新值
- **转池重新冻结**：专属超时转公共时，用的是**转池那一刻**的配置，不是专属阶段或更早的配置
- 专属池资格：非指定打手接单 → `{ kind: "not-eligible" }`
- 并发抢单：`Promise.all` 两个接单 → 恰好一个成功
- **过期不可抢**：deadline 已到但**尚未 sweep** 时接单 → `{ kind: "expired" }`（不依赖 sweep 是否跑过）
- **sweep 幂等**：连跑 20 次，退款只发生一次、通知只有一条、订单只变一次
- 池内 DTO **不含** `gameAccountId` / `remark`（键名断言）
- **无需改动即通过的语义**：订单进公共池、被 B 接单后，`Dispatch.exclusiveCompanionId` **仍是 A**（断言未被清空）
- **`actualCompanionId` 与 `acceptedByCompanionId` 永不漂移**：任何一次 `acceptDispatch` 之后，`order.actualCompanionId === dispatch.acceptedByCompanionId`（对 A 未接 → B 接 的完整路径断言）
- **不得复制**：指定 A 且 A 接单时，两者相等；指定 A 而 B 接单时，`exclusiveCompanionId !== actualCompanionId`——**断言这条路径下二者不相等**（如果有人图省事把指定值抄进实际值，这条会红）
- **管理端 DTO 两个字段都在**：`exclusiveCompanion` 与 `actualCompanion` 同时存在；在「指定 A、实际 B」的订单上分别断言为 A 与 B
- **自动退款不产生售后**：公共池超时退款后，售后 / 投诉记录数不变

**手工验收**
1. 把公共池超时配成 `1` 分钟
2. 不下单指定打手 → 支付 → 打手工作台「公共池」立刻看到该单，**看不到游戏账号与备注**
3. 另一个打手点接单 → 该单从池中消失；下单用户订单详情变「已接单」
3b. **指定打手未接的场景**：结算页指定 A → 等 10 分钟（或直接把 `EXCLUSIVE_WAIT_MINUTES` 临时改小）→ 订单**不退款**、自动进公共池 → B 接单 → 后台订单详情同时显示「指定：A」与「实际：B」
4. 再接一次 → 被拒（已被抢）
5. 重新下单，等 1 分钟刷新用户订单页 → 订单变「已退款」，且**没有**产生售后案件
6. 结算页指定打手 → 支付 → 只有该打手在「专属池」看到
7. 该打手**什么都不做**，等满 10 分钟 → 订单自动进公共池，进入公共池时按**当时的**配置重新计时；
   **确认页面上没有「不接 / 放弃 / 拒绝」按钮，接口里也没有对应路由**

---

### P0-6 开始服务

**目标**：`accepted → serving` 必须由当前打手点击「开始服务」触发，系统绝不自动推进。

**新增文件**：`app/api/companion/orders/[id]/start/route.ts`、`lib/services/companionOrders.ts`、`tests/companionOrders.test.mjs`

**修改文件**：`lib/types/order.ts`（无新字段，仅 `servingAt` 语义确认）、`components/companion/CompanionOrderCard.tsx`

**测试要点**
- 只有 `accepted` 可开始服务；`paid` / `serving` / `completed` / `refunded` 全部拒绝
- 只有 `order.actualCompanionId` 对应的打手能开始；其他打手 → 404（不泄露存在性）
- 重复调用同一 `operationId` → `replayed: true`，不重复写
- **不存在任何基于时间/备注/聊天自动推进的代码路径**：断言 `servingAt` 只能由该事务写入

**手工验收**：打手接单后订单仍是「已接单」→ 等几分钟 → 仍是「已接单」（不自动推进）→ 点「开始服务」→ 变「护航中」。

---

### P0-7 完成材料 + 客服审核

**目标**：打手提交截图 + 5~50 字说明，客服审核；通过 → `completed`；驳回 → 保持 `serving` 并记录驳回原因。

**新增文件**

| 路径 | 职责 |
|---|---|
| `lib/types/completion.ts` | §2.3 类型 |
| `lib/constants/completion.ts` | 摘要长度上下限（5 / 50）、状态标签、驳回原因最大长度 |
| `lib/data/completionRepository.ts` + `mockCompletionRepository.ts` | 仓储 + 同步写原语 |
| `lib/data/companionCompletionTransaction.ts` | 打手提交（原子） |
| `lib/data/adminCompletionTransaction.ts` | 客服审核通过 / 驳回（原子，**同时改 Order 状态**） |
| `lib/services/companionCompletions.ts` | 打手端提交 |
| `lib/services/staffCompletions.ts` | 客服端列表 / 详情 / 审核 |
| `lib/services/staffCompletionsHttp.ts` | 客服端浏览器取数 |
| `app/api/companion/orders/[id]/completion/route.ts` | `POST` 提交 |
| `app/api/staff/completions/route.ts` | `GET` 待审列表 |
| `app/api/staff/completions/[id]/route.ts` | `GET` 详情 |
| `app/api/staff/completions/[id]/approve/route.ts` | `POST` |
| `app/api/staff/completions/[id]/reject/route.ts` | `POST` |
| `tests/completions.test.mjs` | — |

**修改文件**：`lib/data/mockStore.ts`（+`"completion"`）、`lib/types/adminAudit.ts`（`AdminAuditTargetType` +`"completion"`，`AdminAuditAction` +`"completion.approve"` / `"completion.reject"`）、`lib/constants/adminAudit.ts`（标签 + 快照函数）、`components/staff/StaffHeader.tsx`（导航 +「完成审核」）、`tests/staff.test.mjs`（清单数组 +3 条，标题改为「…+ 投诉五件 + 完成审核三件」）、`lib/mocks/fixtures/orderSeed.ts`

**审核通过的原子区段包含三处写入**：`completion.status = "approved"` → `order.status = "completed"` + `completedAt` → P0-8 落地后还有 `earning` 建立 → 通知打手 → `writeAudit`。全部在同一无 `await` 区段内。

**测试要点**
- 摘要长度：4 字 → `BAD_REQUEST`；5 字 / 50 字 → 通过；51 字 → `BAD_REQUEST`
- 只有 `serving` 状态可提交；`accepted` / `completed` / `refunded` 拒绝
- 只有当前打手可提交
- 驳回后 `Order.status` 仍是 `serving`，且 `rejectReason` 有值
- 驳回后可再次提交（新记录，旧的保留为历史）
- 客服路由里**没有** `requireAdmin`；管理端能看但本批次不做审核入口（审核是客服动作）

**手工验收**
1. 打手在「护航中」订单点「提交完成材料」，填 3 字 → 报错；填「完成三局排位达到约定目标」+ 选截图 → 成功
2. 客服工作台「完成审核」出现该单 → 点「驳回」并填原因 → 打手端看到「已驳回 + 原因」，订单仍是「护航中」
3. 打手重新提交 → 客服点「通过」→ 订单变「已完成」，用户端时间轴出现「已完成」

---

### P0-8 结算域

**目标**：订单完成后打手收益进冻结，48 小时无投诉转可提现。

**新增文件**：`lib/types/earning.ts`、`lib/constants/earning.ts`、`lib/data/earningRepository.ts`、`lib/data/mockEarningRepository.ts`、`lib/data/earningTransaction.ts`（`createEarningForOrder` / `sweepMaturedEarnings`，均同步）、`lib/services/companionEarnings.ts`、`app/api/companion/earnings/route.ts`、`app/companion/(console)/earnings/page.tsx`、`tests/earnings.test.mjs`

**修改文件**：`lib/data/mockStore.ts`（+`"earning"`）、`lib/data/adminCompletionTransaction.ts`（审核通过时建立 Earning）、`components/companion/CompanionHeader.tsx`（导航 +「我的收益」）、`lib/mocks/fixtures/`

**资金四类**（对齐 §16）：总收入 = 所有 Earning 的 `incomeAmount` 之和；冻结 = `status === "frozen"` 之和；可提现 = `status === "available"` 之和；**罚款 = 恒 0**（本轮无扣款操作）。

**测试要点**
- 订单完成 → 生成一条 `frozen` Earning，`incomeAmount` 等于订单的 `companionBaseIncome`
- `availableAt = 完成时刻 + 48h`
- `sweepMaturedEarnings` 只推进到期记录，未到期不动
- `fineAmount` 恒为 0，且**仓储里没有任何可以减少 `incomeAmount` 的方法**（键名断言）
- 冻结期间**不可提现**：断言本批次不提供提现接口

**手工验收**：完成一单 → 打手「我的收益」显示总收入 +x、冻结 +x、可提现 0；把某条 Earning 的 `availableAt` 手工改成过去（或改系统时间）→ 刷新 → 转入可提现。

---

### P0-9 消费累计改按实付

**目标**：消费等级按**实付**在**支付成功时**累计，退款按实退金额扣减，等级允许自然下降。

**新增文件**：无。

**修改文件**：`lib/constants/levels.ts`、`tests/levels.test.mjs`。

**核心改动**：删除 `CONSUMPTION_ORDER_STATUS`，把 `sumEffectiveSpend` 改为

```ts
/** 有效消费 = Σ(实付 − 已退)；全额退款后自然归零，无需按状态特判 */
export function sumEffectiveSpend(orders: readonly Order[]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const order of orders) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    total += Math.max(0, Math.trunc(order.actualPaidAmount) - Math.trunc(order.refundedAmount));
  }
  return total;
}
```

`countEffectiveOrders` 改为「`actualPaidAmount - refundedAmount > 0` 的订单数」。

**测试改动**
- 删除 `tests/levels.test.mjs:91` 的 `CONSUMPTION_ORDER_STATUS === "completed"` 断言
- 新增：`paid` 状态订单计入；`refunded`（全额）不计入；部分退款计入余额
- 更新 `tests/levels.test.mjs:343` 的 `effectiveSpendAmount === 24060`（Seed 口径变化后需重算并写明推导）
- `tests/levels.test.mjs:543`「页面不得自己算消费金额」保持不变

**手工验收**：新用户下单支付 50 元 → 立刻进「我的 → 消费等级」看到累计 50（**订单还没完成**）；管理员全额退款 → 消费回落，等级随之下降。

---

### P1 批次

以下六个批次的**领域归属、文件清单与硬约束**已确定；详细 TDD 任务分解在该批次开工前单独落盘（与 P0 同样的写法），因为每个批次都依赖前序批次已落地的具体签名。

#### P1-1 退款限定 `serving` + 部分退款裁决

**改动**：`REFUNDABLE_ORDER_STATUSES` 由 `["paid","accepted","serving","completed"]` 收窄为 `["serving"]`；`RefundRequest` 增 `refundRate`（**整数，1 bp = 0.01%，0~10000**，与 `companionRateSnapshot` 同一表示法）/ `userRefundAmount` / `companionReversal` / `clubIncomeAdjustment`；`Order` 的 `refundedAmount` 累加至用户退款金额（全额时等于 `actualPaidAmount`）。

**修改文件**：`lib/constants/refunds.ts`（`REFUNDABLE_ORDER_STATUSES`、`canRequestRefund`）、`lib/types/refund.ts`、`lib/data/adminRefundTransaction.ts`（`approveRefund` 增 `refundRate` 入参并做 §2.6 换算）、`app/api/admin/refunds/[id]/approve/route.ts`、`components/admin/AdminRefundConsole.tsx`（比例输入）、`lib/services/refunds.ts`、`tests/refunds.test.mjs`、`tests/adminRefunds.test.mjs`。

**⚠️ `refundRate` 的数值表示（R1，已确认）**：**整数基点**，`0 ~ 10000`。`floor` 只在 `userRefundAmount` 与 `companionReversal` 两处使用，`clubIncomeAdjustment` 由**减法**得出（§2.6）。**不得**改用浮点百分比、**不得**三方各自独立取整。

**硬约束**：`requireAdmin()` 必须仍是 approve 路由的第一条语句；**客户端不得提交任何金额字段**，只能提交 `refundRate`，金额一律服务端换算。

**测试**：`canRequestRefund` 只对 `serving` 为真；`refundRate = 0` → 用户退款 0 且不写 `refundedAmount`；`refundRate = 10000` → 退款等于实付、订单转 `refunded`；`refundRate = 5000` 且 `50/8:2/无券` → 退款 25、打手冲正 20、俱乐部调整 5；`refundRate = 5000` 且 `券10/实付40` → 退款 20、打手冲正 20、俱乐部调整 0；**`refundRate = 5000` 且 `券30/原价50/实付20` → 退款 10、打手冲正 20、俱乐部调整 −10（断言为负且不抛错）**；恒等式 `userRefundAmount === companionReversal + clubIncomeAdjustment` 对全部边界成立（**用减法构造，禁止分别取整后相加**）；客服路由里**没有** approve。

**手工验收**：护航中订单出现「申请退款」，已接单/已完成订单**没有**该按钮（各有一个拒绝的提示路径）；管理员在退款详情输入 50% → 用户端看到退款金额与订单实付无关地按公式计算；把商品换成分账 80% + 10 元券再走一遍，验证打手冲正仍为 20。

#### P1-2 投诉 48 小时窗口 + 三种处置 + `AfterSalesCase`

**改动**：投诉创建校验窗口（`completed` 订单以 `completedAt` 起算 48h，其他状态不受限）；新增 `AfterSalesCase` 实体承载处置；处置由自由文本改为枚举（继续服务 / 更换打手 / 提交退款方案）。

**新增文件**：`lib/types/afterSales.ts`、`lib/constants/afterSales.ts`、`lib/data/afterSalesRepository.ts`、`lib/data/mockAfterSalesRepository.ts`、`lib/data/adminAfterSalesTransaction.ts`、`lib/services/adminAfterSales.ts`、`app/api/admin/after-sales/route.ts`、`app/api/admin/after-sales/[id]/route.ts`。

**修改文件**：`lib/data/mockStore.ts`（+`"afterSales"`）、`lib/services/complaints.ts`（窗口校验）、`lib/constants/complaints.ts`、`lib/types/adminAudit.ts`（+targetType `"afterSales"` 与对应 action）、`tests/admin.test.mjs`（+2 条）、`tests/complaints.test.mjs`。

**硬约束**：投诉结果文本仍**不得**出现免单 / 补偿 / 赔偿 / 退款 / 返现 / 赔付（沿用既有 `FORBIDDEN_RESULT_WORDS`）；「提交退款方案」是**创建退款申请**，不是直接退款——资金仍必须走 `requireAdmin()` 的 approve。

**测试**：`completedAt` 后 47:59 可投诉、48:01 不可；`pending` / `serving` 订单不受窗口限制；三种处置各自的副作用（继续服务不动订单、更换打手改 `Dispatch.acceptedByCompanionId` 并建新会话、提交退款方案生成一条 `pending` 退款申请）；处置枚举之外的取值被拒。

**手工验收**：完成一单 → 立刻可投诉；把该单 `completedAt` 改成 49 小时前 → 投诉入口消失；客服对一条投诉选「更换打手」→ 订单回到等待接单且新打手可见、旧打手不可见。

#### P1-3 聊天打手角色 + 更换打手 + 保留/删除策略

**改动**：`OrderConversationRecord` 增 `companionId`（会话归属）；打手可 `POST` 消息（`MessageSenderRole` 的 `"companion"` 由 Seed 专属变为真实可写）；更换打手时建新会话，旧会话保留为证据；普通订单完成满 48h 且无异常记录时**物理删除**聊天。

**新增文件**：`app/api/companion/conversations/route.ts`、`app/api/companion/conversations/[orderId]/route.ts`、`app/api/companion/conversations/[orderId]/messages/route.ts`、`lib/services/companionConversations.ts`、`lib/constants/chatRetention.ts`、`tests/chatRetention.test.mjs`。

**修改文件**：`lib/types/message.ts`、`lib/data/mockMessageRepository.ts`（增 `deleteConversation`）、`lib/services/conversations.ts`、`components/companion/CompanionHeader.tsx`（导航 +「订单沟通」）、`tests/companion.test.mjs`（清单 +3 条）。

**硬约束**：删除判定必须是**纯函数**（`shouldDeleteConversation(conversation, relatedRecords, at)`），以便直接测 47:59 / 48:00 / 48:01 三个边界；存在**任何**投诉 / 退款 / 售后记录（含已结案的）即**不得删除**；新打手读取旧会话必须返回 404，不得只靠前端隐藏。

**⚠️ 自动删除是系统生命周期动作，不进 Admin Audit**（见决策 D5）：到期清理没有 actor，不得写 `AdminAuditLog`。可追溯性由会话记录自身的删除时间字段 + 订单/投诉/退款记录保证。只有**管理员主动删除**某个会话才需要审计。

**测试**：纯函数三边界；47:59 发起退款 → 到期不被删；已删除的会话再次读取返回 404；新打手读旧会话 404；打手只能读写自己当前绑定订单的会话。

**手工验收**：打手在订单沟通里发一条消息 → 用户端能看到、且发送者显示为「护航」；走一次更换打手 → 新打手看不到旧消息；把某单的完成时间改成 49 小时前并刷新 → 普通订单的聊天消失，有退款记录的那单聊天仍在。

#### P1-4 打手封禁语义

**改动**：管理员禁用护航时按在途订单状态分流——未开始服务（`paid` / `accepted`）→ 订单解除绑定、**重新进入公共池并从当前时刻重新计时**（见 C4）、通知老板；已开始服务（`serving`）→ 转售后处理，被禁打手失去聊天 / 提交材料 / 操作订单的一切能力。

**修改文件**：`lib/data/adminCompanionTransaction.ts`、`lib/types/adminAudit.ts`（+targetType `"dispatch"` 与对应 action）、`lib/data/companionDispatchTransaction.ts`（增 `requeueOnCompanionBanned`）、`lib/services/adminCompanions.ts`、`tests/adminCompanions.test.mjs`。

**硬约束**：**不得**给客服「替打手提交完成材料」的入口；`serving` 订单在被禁后不得由该打手产生任何写入。

**测试**：禁用时 `accepted` 订单 → `Dispatch.state` 回 `public`、`publicPoolEnteredAt` 等于封禁时刻、`publicDeadlineAt` 按订单快照重算；禁用时 `serving` 订单 → 生成售后案件且订单状态不变；被禁打手对原订单调用接单 / 开始服务 / 提交材料 → 全部被拒；封禁写入审计。

**手工验收**：给打手接一单（未开始服务）→ 后台禁用该打手 → 订单立刻回到公共池且**重新开始计时**（不是沿用旧截止时间）、用户收到通知；再走一遍已开始服务的场景 → 订单进入售后，该打手的「提交完成材料」按钮消失且接口拒绝。

#### P1-5 打手等级 B/A/S + 并发上限

**改动**：`Companion` 增 `level: "B" | "A" | "S"`；**首次引入**并发上限（P0-5 刻意不做，见 C14），按等级映射（默认 B=3 / A=4 / S=5，见 R6）；管理端护航详情可设等级。

**修改文件**：`lib/types/companion.ts`、`lib/constants/companion.ts`、`lib/data/companionDispatchTransaction.ts`、`lib/services/adminCompanions.ts`、`components/admin/AdminCompanionForm.tsx`、`lib/mocks/fixtures/seed.ts`、`tests/adminCompanions.test.mjs`。

**硬约束**：等级**只**影响并发上限，**不得**引入自动升级（本轮明确不做）；`rankLabel`（展示用的「钻石打手」）与 `level` 是**两个不同概念**，不得合并。

**测试**：B/A/S 各自的上限生效；超过上限接单被拒且返回 `{ kind: "concurrency-limit", limit, active }`；改等级后**已接单**不受影响，仅影响后续接单；非法等级值被拒。

**手工验收**：把某打手设为 B 级（3 单）→ 接满 3 单后第 4 单被拒并提示；改成 S 级（5 单）→ 立刻能再接。

#### P1-6 优惠券参与结算

**改动**：结算页可选择已领取的券；`couponDiscountAmount` 落到订单，`actualPaidAmount = originalAmount - couponDiscountAmount`。

**修改文件**：`lib/services/checkout.ts`、`lib/types/order.ts`（字段已存在，本次开始写非零值）、结算页组件、`lib/services/coupons.ts`、`tests/coupons.test.mjs`。

**硬约束**：券**只**减少用户实付，**不得**改变 `companionBaseIncome`（分账基数始终是原价，§15）；券成本由俱乐部承担，即 `clubNetIncome` 相应减少。

**测试**：`原价 50 + 10 元券` → `actualPaidAmount = 40`、`companionBaseIncome` 仍为 `40`（与无券时逐位相同）、`clubNetIncome = 0`；`原价 50 + 30 元券` → `companionBaseIncome = 40`、`clubNetIncome = -20`（**负值断言**）；未领取 / 已过期 / 已使用的券不能用于结算；同一订单重复提交不同券不改变已创建订单的金额。

**手工验收**：领一张 10 元券 → 结算页勾选 → 实付变 40；下单后订单详情「实付 ¥40 / 护航收益 ¥40」；后台把商品比例从 80% 改成 70% → **该历史订单的护航收益仍是 ¥40**。

---

## 七、既有测试改动汇总

以下断言**主动锁定**了将被修改的旧规则，必须在对应批次同步更新——否则实现会被测试挡住。

| 文件:行 | 现断言 | 归属批次 |
|---|---|---|
| `tests/levels.test.mjs:91` | `CONSUMPTION_ORDER_STATUS === "completed"` | P0-9 |
| `tests/levels.test.mjs:343` | `effectiveSpendAmount === 24060` | P0-9 |
| `tests/orders.test.mjs:240-247` | `waiting` = `paid` 且无 companion | P0-5 |
| `tests/orders.test.mjs:258` | 需 companion 快照的四种状态 | P0-5 |
| `tests/refunds.test.mjs:358-371` | 四种状态均可申请退款 | P1-1 |
| `tests/refunds.test.mjs:93-112` | 遍历四个 `FREE_*_ORDER` 断言可退 | P1-1 |
| `tests/adminRefunds.test.mjs:102-137` | `ADMIN_REFUND_TRANSITIONS` 与允许动作 | P1-1 |
| `tests/tips.test.mjs:40` | `FORBIDDEN_KEY_PATTERN` 禁止 commission/settle 等键 | P0-8 起需评估（鸡腿与结算被判定为不同概念） |
| `tests/coupons.test.mjs:312-328` | 领券不改变订单金额 | P1-6 |
| `tests/admin.test.mjs:710-806` | 后台接口清单 60 条 | P0-1（+1）、后续批次 |
| `tests/staff.test.mjs:1246-1280` | 客服接口清单 16 条 | P0-7（+3） |
| `tests/checkout.test.mjs` | 订单创建后 `companionId` 等于结算页所选打手 | P0-5（改为 `actualCompanionId === null` + Dispatch 断言） |
| `tests/orders.test.mjs` | 同上，「已接单」订单的 `companion` 快照来源 | P0-5（改为 `actualCompanionId`） |

**新增清单门禁**：`tests/companion.test.mjs`——打手接口清单。⚠️ 本批次打手端**只新增 `app/api/companion/dispatches/**` 四个路由**（P0-4 明确不建 `app/api/companion/auth/**`），因此清单初始为 4 条 + 后续批次累计；写法与 `tests/staff.test.mjs` 同形。

**改名带来的全仓扫描**：`companionId` → `actualCompanionId` 是一次跨文件改名，收尾必须全仓 grep 确认**没有遗漏的旧名**，并确认 `CompletionSubmission.companionId` / `Earning.companionId` / `OrderConversationRecord.companionId` 这些**各自实体的自有字段没被误改**（它们本来就该叫 `companionId`）。

---

## 八、残留待确认

### 8.1 已确认（不再是待确认项）

| # | 问题 | 结论 |
|---|---|---|
| ~~R1~~ | **取整规则** | **已确认**：`userRefundAmount` 与 `companionReversal` **只这两项**向下取整；`clubIncomeAdjustment` 由**减法**得出。恒等式 `userRefundAmount === companionReversal + clubIncomeAdjustment` 严格成立。`refundRate` 用**整数基点**（0~10000），与 `companionRateSnapshot` 同一表示法。见 §2.6 |
| ~~R2~~ | **大额优惠券导致俱乐部收益为负** | **已确认**：**允许为负**。`clubNetIncome` / `clubIncomeAdjustment` 均可为负；不得夹到 0、不得取绝对值、不得因此下调打手理论收入。**命名约束**：统一叫 `clubIncomeAdjustment`，不得叫 `clubRefundAmount`。见 §2.6 第三行验算 |
| ~~R8~~ | **惰性推进的可接受性** | **已确认（有条件）**：接受「deadline 驱动 + 惰性物化」，但「到点必达」由**生产阻塞项**兜底——见 §九 TD-1 |

### 8.2 仍未确认（禁止自行假设）

| # | 问题 | 影响批次 | 本计划的处理方式 |
|---|---|---|---|
| **R3** | **增值服务是否参与分账**：分账基数的构成。文档只说「商品原价」 | P0-3 | ✅ **已确认（2026-09-18）**：**V1 的全部增值服务参与打手分账**——只要由当前打手实际履约提供，它就属于该订单的服务收入。决策点仍是唯一的 `resolveCompanionRevenueBase(itemsAmount, addonsAmount)`，现返回 `itemsAmount + addonsAmount`。**`originalAmount` 只表示「优惠前应付总额」，不承担分账配置语义**；两者当前数值相同是规则的结果，不是定义。将来平台自己履约的收费项进原价、不进基数 |
| **R4** | **「服务异常」的定义**：谁触发、什么条件、如何进入售后区 | P1-2 / P2 | 本轮不实现 |
| **R5** | **「非普通投诉通道」**：§12 暗示存在普通之外的通道 | P2 | 本轮不实现 |
| **R6** | **B/A/S 的 3/4/5 是固定还是管理员可配** | P1-5 | 本轮不确认；P1-5 开工前必须定 |
| **R7** | **打手侧是否需要统一的「操作史」查询**（跨 Dispatch / CompletionSubmission / Earning） | P2 | 本轮不做，见决策 D4 |
| **R9** | **打手工作台的用户端入口位置**（「我的」页哪个位置放链接；是否要做成申请入口） | P0-4 | 只加一个链接到 `/companion`，不加入口设计；位置按现有「我的」页布局惯例 |
| **R10** | **`Order.companion` 快照中是否要同时保留指定打手** | P0-5 | 快照只反映**实际接单人**；指定人经 `Dispatch.exclusiveCompanionId` 查。若产品要求快照里也显示指定人，需单独确认 |

---

## 九、技术债与生产阻塞项

| # | 项 | 性质 | 何时必须解决 |
|---|---|---|---|
| **TD-1** | **接入后台定时调度器**：`sweepExpiredDispatches(now)` / `sweepMaturedEarnings(now)` 目前只在**有人读取**时被调用。真实生产不能依赖这一点——恶意用户静置订单即可让超时退款永不发生、打手收益永不解冻 | **真实支付上线前阻塞项** | 真实支付上线前 |
| **TD-2** | **Mock 存储重启即失**：全部数据在 `globalThis` 上，dev server 重启清空。这是 Mock 层的既有性质，不是本计划引入的 | 既有技术债 | 接真实数据库时 |
| **TD-3** | **无真实支付渠道**：订单「已支付」由 `mock-confirm` 产生 | 既有技术债 | 接微信支付时 |
| **TD-4** | **提现未实现**：P0-8 只把收益推进到 `available`，没有提现入口 | 本轮范围外 | 后续立项 |

> **TD-1 的落地方式已经预留**：两个 sweep 函数都是**同步、幂等、可重复调用**的业务入口（Global Constraint #13），调度器只需按固定间隔调用**同一套函数**。**严禁**在调度器里另写一套超时退款逻辑——那会让两条路径的金额与状态判定迟早分叉。

---

## 十、执行方式与停止点

**批次执行规则**

1. **一次只做一个批次**（对应记忆中的「分阶段逐个授权」）。做完该批次后**停下**，输出改动清单与手工验收步骤，等视觉验收通过再进入下一批。
2. 每个批次收尾必须 `pnpm test` + `pnpm typecheck` + `pnpm lint` 三者全绿。
3. 涉及后台接口的批次，**必须**同批扩充 `tests/admin.test.mjs` 的清单数组与标题；涉及客服接口的同理改 `tests/staff.test.mjs`；涉及打手接口的改 `tests/companion.test.mjs`（**管理接口清单门禁**）。
4. 每个批次独立提交，提交信息用中文，不带署名尾行以外的多余内容。

**两个不可协商的收尾检查**

- **原子区段审计**：任何新增的「读取—判断—写入」事务，区段内**不得出现 `await`**（见 Global Constraints）。代码评审时逐段确认。
- **无第二套实现**：全仓 grep 确认没有第二套超时退款逻辑、没有第二套打手身份、没有第二套订单仓储、没有第二套退款系统。

**建议执行顺序**：`P0-1 → P0-2 → P0-3 → P0-4 → P0-5 → P0-6 → P0-7 → P0-8 → P0-9`

P0-1…P0-4 之间无依赖，可任意换序；**P0-5 是分水岭**，它之前是准备，它之后是主链路。

**分支策略**：当前在 `main`。开第一批前先建 `feat/order-lifecycle-alignment`，每批次在该分支上提交，验收通过后再考虑合并。

**本计划到此停止。代码零改动。** 等待明确回复「开始执行」后，从 P0-1 开始。
