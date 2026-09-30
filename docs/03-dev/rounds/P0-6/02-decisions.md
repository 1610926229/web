# P0-6 · 02-decisions.md

> 本文件是**追加历史**：决定改变时保留旧版本并标注 `SUPERSEDED`，不覆盖。
> 格式见 `docs/03-dev/development-workflow.md` §十九。

Round ID: P0-6
Requirement Check 执行时间: 2026-09-23

---

## 结论先行

**本轮不存在 `Status: OPEN` 的决策，不进入 `CLARIFYING`。**

> ⚠️ **一处曾经需要用户裁定的例外（见 D6 V1→V2→V3，现已裁定并兑现）**：
> `01-prompt.md` §十一 第 23 条要求「Admin / **Staff** 可以看到取消历史」。
> 首次交付时**只兑现了 Admin 那一半**——客服工作台不存在任何订单管理详情，
> 且 `canEnterAdminConsole()` 明确只放行 `admin`，客服进不了 `/admin`；
> 当时把它记为「待用户裁定的产品问题」。
> **用户在验收阶段明确裁定该需求已冻结、必须补齐**，因此本轮追加 D6 **V3**：
> 客服侧挂在会话 / 投诉 / 退款三个**既有**只读详情 DTO 上，**不新增任何 Staff 接口**。
> 该例外**已关闭**，本轮最终不存在未兑现的范围项。
>
> **当时的理由（保留备查，已被用户的裁定取代）**：首次交付时把客服侧落点判成歧义的
> （投诉详情 / 退款详情 / 新建客服订单页三选一，三种会得到不同的权限面貌），
> 按 §十四 认为 Claude 不得自行选定，因此把它当**未兑现的范围项**记进
> `03-delivery.md` 与 `04-acceptance.md`，等用户裁定「接受现状并后续补齐」还是「打回本轮补上」。
> ⚠️ **这个判断是错的，用户已经指出**：需求对客服「能看什么」是**冻结**的，
> 真正未定的只是**挂在哪一页**——那是技术组织，不是产品规则，本来就不该拿去问产品。
> 结论见 D6 **V3**。

`01-prompt.md` 与最新 `docs/01-requirements/`、`docs/02-tech-design/`
之间**不存在实质冲突**。下面 10 条（D1–D10）是本轮的执行口径，全部由
"需求文档 / 技术设计 / 现有源码事实" 三者可推出，因此**不构成向用户提问的理由**
（判定标准见 `development-workflow.md` §九：查询需求 + 技术设计 + 源码后仍有
两个以上合理方案、且会改变业务结果才算阻塞；这 10 条都只剩一个方案）。

---

## 一、Requirement Check（`development-workflow.md` §七 的 12 件事）

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 产品规则是否完整 | ✅ 完整 | BF-15「accepted 后允许实际打手主动取消」、EX-SERVICE-01、权限表 §6.4 / §7.1 |
| 2 | 前置状态是否明确 | ✅ `Order.status === "accepted"` 且 `Order.actualCompanionId === 当前 companionId` | `01-prompt.md` §2.1；权限表 §6.4 |
| 3 | 成功状态是否明确 | ✅ `Order: accepted → paid`、`actualCompanionId → null`；`Dispatch: accepted → public` + 重新冻结三个 public 字段 | `01-prompt.md` §2.3 / §四；BF-15 |
| 4 | 失败状态是否明确 | ✅ 非本人 → 404；本人但状态已不是 `accepted` → 400；重放 → 幂等成功且不产生第二次副作用 | D5、D1 |
| 5 | 权限是否明确 | ✅ 仅当前 `actualCompanion`；`companionId` 只能来自 `requireCompanion()` 的会话身份；`exclusiveCompanionId` **不构成**归属 | `01-prompt.md` §2.1 / §7.1；api-contract §2.9 |
| 6 | 金额是否明确 | ✅ **不涉及金额**：不退款、不罚款、不扣减收益、不进入人工售后 | `01-prompt.md` §一 / §十四；BF-15 |
| 7 | 幂等是否明确 | ✅ 见 **D1**（幂等键索引 + 状态双重保险） | api-contract §2.8 / §3.1；`companionDispatchTransaction` 头部注释 |
| 8 | 并发是否明确 | ✅ 见 **D1 / D3**：单一原子区段，区段内**不得出现 `await`**；重放不重复写、不重复通知、不刷新 deadline | `01-prompt.md` §十；项目伪事务惯例 |
| 9 | 通知是否明确 | ✅ 见 **D9**：复用现有 Notification 通道，`kind: "dispatch"`，一次成功取消只产生一条 | `01-prompt.md` §六；`lib/types/notification.ts:18` 已有 `"dispatch"` |
| 10 | 是否存在 `TBD — DO NOT INVENT` | ✅ 无 | 逐条比对 `docs/01-requirements/`、`docs/02-tech-design/` 后未命中 |
| 11 | 与现有架构规范是否冲突 | ✅ 不冲突 | 放置位置全部落在 `directory-structure.md` §8.1 A/C 已列路径内，见 **D8** |
| 12 | 是否与已有业务代码事实冲突 | ✅ 不冲突，但有 3 处必须同步的一致性清理 | 见 **D2 / D3 / D10** |

---

## 二、本轮执行口径

### D1 — 幂等：同时保留「幂等键索引」与「状态即事实」

Status: CURRENT

**问题**：`api-contract.md:468` 要求取消接口「请求体必须包含取消原因**与幂等标识**」，
而 `lib/data/companionDispatchTransaction.ts` 头部有一整节「**为什么没有幂等键**」，
论证打手侧写操作应该用**状态本身**做幂等。两者是否冲突？

**裁定：不冲突，两条都要。**

依据分三层：

1. **两者说的不是同一件事。** `companionDispatchTransaction` 拒绝的是
   `lib/data/adminWriteSupport.ts` 的 `operationId` + **管理操作审计表**机制，
   理由原文是「那些表是管理操作审计，打手接单不是管理行为，往里写会让审计表
   变成一本什么都记的流水」。本轮同样**不得**使用 `adminWriteSupport`。
2. `api-contract.md` §2.8 明确列出**三种机制并存，按场景选择**，其中
   第一种「**幂等键索引**（各 store 的 `${userId}:${idempotencyKey}` → 记录 id）」
   的落点是**各 store 自己的索引**，与审计表无关。它用于「用户侧创建类接口」，
   而一次成功取消**恰好产生一条新记录**（`CompanionReleaseRecord`），
   形状吻合。
3. 现有仓库已有完全对应的现成机制，无需发明：
   `lib/constants/writes.ts` 的 `readIdempotencyKey()` +
   `IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/`，
   用户侧 8 个写接口（支付请求 / 退款 / 投诉 / 评价 / 反馈 / 领券 / 消息 / 入驻申请）
   全部用它，字段名统一为 `idempotencyKey`。

**执行口径**：

- 取消请求体必须含 `idempotencyKey`，用**现有** `readIdempotencyKey()` 校验
  （非法或缺省 → `BAD_REQUEST`，复用 `IDEMPOTENCY_KEY_MISSING_MESSAGE`）。
  **不自行发明**任何新的键格式或长度规则。
- 索引形如 `${companionId}:${idempotencyKey}` → `CompanionReleaseRecord.id`，
  落在退出历史仓储的 store 里（**不是**记录上的字段——`database-schema.md` T4
  与 `01-prompt.md` §三 都只给了 7 个字段，索引不是字段）。
- **读取次序**：先查幂等索引 → 命中即原样返回第一次的成功结果
  （`changed: false`），**不进入原子区段**；未命中才进入原子区段。
- **状态 Guard 同时保留**，且仍是真正的安全边界（与 `acceptDispatch` 一致：
  「键是调用方给的一个串，而状态是**事实**」）。键的作用只是让「同一打手连点两次」
  的第二次返回第一次的结果，而不是一个会让用户困惑的 404。
- 键只在 `companionId`（来自会话）作用域内生效，因此**不可能**被用来重放他人的取消。

### D2 — 取消后 Order 的三个字段一起清空：`actualCompanionId` / `companion` / `acceptedAt`

Status: CURRENT

**问题**：`01-prompt.md` §2.3 只点名了 `Order.actualCompanionId = null`，
没有说 `companion`（履约快照）与 `acceptedAt` 怎么办。

**裁定：三个一起清空。** 三条独立证据指向同一结论：

1. **写入侧对称性**：`lib/data/mockPaymentRepository.ts:213` 的 `applyOrderAccepted()`
   恰好只写四个字段——`status` / `acceptedAt` / `actualCompanionId` / `companion`。
   逆向迁移若只回写其中一个，「接单是一次四字段的原子赋值、取消只回退其中一部分」
   就成了一条永远对不齐的不变量。
2. **技术设计把前两者定义为一个整体**：`database-schema.md:166` 的字段分组里
   `履约人 | actualCompanionId、companion（OrderCompanionSnapshot）` 是**同一组**，
   而 `acceptedAt` 在 `时间` 组。`01-prompt.md` §2.3 的原文是「当前**履约绑定**必须解除」
   ——「绑定」就是这一组。
3. **不清空会直接渲染出自相矛盾的界面**（`01-prompt.md` §四 对 Dispatch 明确要求
   「与当前接单状态绑定的字段如果继续保留会导致状态自相矛盾，应按现有模型进行一致性清理」，
   同一原则对 Order 同样成立）：
   - `lib/services/orders.ts:44` 的 `TIMELINE_SOURCE` 把 `acceptedAt` 直接变成
     用户可见的时间轴节点，`buildOrderTimeline` 只判「时间戳非 null」。残留的
     `acceptedAt` 会让一张已回到 `paid` 的订单在用户订单详情页上显示「已接单」；
   - `toOrderListItem()` 输出 `companion: order.companion`，`lib/types/order.ts`
     对该字段的注释是「未绑定时为 null，页面显示「等待接单」」。残留快照会让
     订单列表出现一个并不在履约的打手。

**执行口径**：退出后 `status = "paid"`、`actualCompanionId = null`、
`companion = null`、`acceptedAt = null`。「谁曾经接过这一单」由
`CompanionReleaseRecord` 保存（`01-prompt.md` §2.3 原文：历史交由最小退出历史记录保存）。

写入入口：`mockPaymentRepository` 新增一个**同步**逆向写入器（无 `await`），
与 `applyOrderAccepted` 对称，不由调用方直接拿 `Map`。
⚠️ 该写入器**只负责写**，合法性由伪事务在此之前判定（同一文件里
`applyOrderRefund` 的注释已经确立了这条分工）。

### D3 — Dispatch 一致性清理：清 `acceptedByCompanionId` / `acceptedAt`，保住 `exclusiveCompanionId`

Status: CURRENT

`lib/data/mockDispatchRepository.ts:139` 的 `applyDispatchToPublic(id, enteredAt, timeoutMinutes)`
目前写 `state` + 三个 public 字段 + `updatedAt`，**不清** `acceptedByCompanionId` / `acceptedAt`
（`lib/types/dispatch.ts:91-92`）。它此前唯一的调用点是专属池超时清扫，
那条路径上从来没人接过单，所以两个字段本来就是 `null`，漏清不可见。

一旦被取消复用，漏清就是 `01-prompt.md` §四 点名要避免的自相矛盾：
`state === "public"` 却留着 `acceptedByCompanionId`。

**执行口径**：把 `applyDispatchToPublic` 的写入补齐为同时清空
`acceptedByCompanionId: null` 与 `acceptedAt: null`——这也让该写入器的契约
变成它名字的字面意思（「回到公共池」= 当前没有人接）。
对既有超时清扫路径是 **no-op**（原值已是 `null`），因此不改变既有行为。

`exclusiveCompanionId` / `exclusiveEnteredAt` / `exclusiveDeadlineAt` **一律保留**：
`lib/types/dispatch.ts:62-68` 已经把 `exclusiveCompanionId` 定义为
「**历史事实**，不是当前状态……订单转公共池、被别人接走、甚至超时退款之后，
这个值都**保持不变**」。`01-prompt.md` §四 的要求与之一致。

### D4 — 取消资格只判 §2.1 两条，不引入 `isCompanionAcceptingOrders`

Status: CURRENT

`isCompanionAcceptingOrders()`（`lib/constants/companions.ts`）的语义是
「当前允不允许**接新的订单**」（`available`）。取消是**退出**，不是接单，
把它当门槛会得出「暂停接单的人无法退出自己已经接下的单」这个荒谬结论。

**执行口径**：取消资格恰好等于 `01-prompt.md` §2.1 的两条。
`requireCompanion()` 仍必须用（它保证「已登录 + 是打手 + 未被停用」，
且是 `companionId` 的唯一来源），且它已经会 403 掉被停用的账号——
这正是 `01-prompt.md` §十四 把「封禁回池」列为 out of scope 所对应的分工：
被停用者的订单回池属于**系统侧**后续 Round，不由本轮的主动取消入口承担。

### D5 — 失败语义：非本人 404，本人但状态已不是 `accepted` 400

Status: CURRENT

- **非本人实际履约的订单 → 404。** 依据 api-contract §2.9：
  「打手侧：`order.actualCompanionId` 决定谁能操作；非归属者的访问按 **404**
  （不泄露存在性）处理」，`01-prompt.md` §7.2 逐字重申。与
  `app/api/companion-applications/[id]/withdraw/route.ts` 头部注释里「不存在」与
  「存在但不是你的」走同一个 404 是同一套路。
- **是本人的单、但状态已不是 `accepted` → 400。** 覆盖 `serving` / `completed` /
  `refunded`，对应 `01-prompt.md` §十一 的第 17、18 条要求
  （serving 不得普通主动取消；终态不得被拉回 `paid`）。
  这里**必须抛错而不是幂等成功**：它不是重放，是「你点了一个此刻不该存在的按钮」。

### D6 — 客服 / 管理员可见路径：只加 `AdminOrderDetail.releaseHistory`

### Decision V1

Status: **SUPERSEDED**（被本轮内部的 V2 取代——V1 的一条前提经核查不成立）

**V1 的推理**：客服工作台没有订单页，而 `lib/types/admin.ts:27`
`AdminRole = "admin" | "customer_service" | "companion"` 含 `customer_service`，
因此推断「客服与管理员进的是同一个后台」，一次 `AdminOrderDetail.releaseHistory`
即可同时满足客服的「查看原因」与管理员的管理查看。

**V1 错在哪**：`AdminRole` 只描述**角色枚举**，不描述**准入**。
准入由 `lib/constants/admin.ts` 的 `canEnterAdminConsole(role)` 单独判定，
其实现是 `role === "admin"`——该文件头部把「**只有 `admin` 能进管理后台**」
写成三条边界的第一条，并说明这是刻意的（「将来新增角色时，新角色默认没有权限」）。
因此 `customer_service` **进不了 `/admin`**，V1 的落点对客服不可达。

### Decision V2

Status: **SUPERSEDED**（被 V3 取代——用户明确裁定客服侧可见性**属于本轮范围**，不再是待确认项）

**V2 裁定**：本轮**只**交付 `AdminOrderDetail.releaseHistory`（面向管理员）。
客服侧的可见入口**不在本轮实现**，作为**明确未兑现项**记录进 `03-delivery.md`
并在 `04-acceptance.md` 的人工验收清单里单独列出，交用户在验收时裁定。

**为什么不在本轮自行补一个客服入口**：

1. `01-prompt.md` §九 把 scope 明确限定为「让**现有订单管理详情**能够看到最小取消历史」，
   并禁止「新做完整履约历史系统」。客服工作台**不存在任何订单管理详情**
   （`app/staff/` 只有投诉 / 会话 / 退款三组页面，`app/api/staff/` 下没有 `orders` 段），
   为它新建订单详情页属于 §九 明令排除的范围。
2. 即使只加一小段，**落点本身是歧义的**：客服能看到的订单摘要出现在
   `StaffComplaintDetail.orderSummary`（`lib/types/complaint.ts:282`）与
   `StaffRefundDetail` 两处，而这两处的契约都被刻意写得极薄
   （投诉那处原文：「只够回答「这一单是什么、现在到哪一步了」」）。
   选投诉详情、选退款详情、还是新建客服订单页——**三者会得到不同的界面与权限面貌**，
   属于 §九「什么必须先问用户」里「两个以上合理方案且会改变业务结果」的情形。
   按 `development-workflow.md` §十四「Sub-Agent 不得自行决策」，Claude 不替产品选定其一。
3. 权限表 §7.1 给的是一条**权限授予**（客服**可以**查看原因），不是一条
   「本轮必须提供界面」的排期指令；把它实现成哪个界面属于后续 Round 的范围决策。

**已落地的保护**：`tests/companionOrders.test.mjs` 里有一条具名用例
「缺口：客服端目前没有查看取消历史的入口」，把三条可达性事实（
`canEnterAdminConsole` 只放行 `admin`；`app/api/staff/` 无 `orders` 段；
`app/staff/**` 无任何 `.tsx` 渲染 `releaseHistory`）钉住。
**这条用例将来会红——那时应更新它，不是删掉它**：它存在的意义是让
「补齐客服侧入口」的那一轮必然看见这件事。

**问题**：`01-prompt.md` §九 说「只需要让现有**订单管理详情**能够看到最小取消历史」
（单数），§十一 第 23 条却写「Admin / **Staff** 可以看到取消历史」；
而 `docs/01-requirements/超哥电竞_用户权限表.md:423` 明确给了客服
「查看打手 accepted 后主动取消的原因、时间与原打手记录」这一权限。
客服工作台有没有订单详情？

**已查清的事实**：

- 客服工作台 `app/staff/` 只有 4 个业务页面：投诉列表/详情、会话列表/详情、
  退款列表/详情 + 控制台首页。**没有任何订单页面，也没有
  `app/api/staff/orders/**`**（`app/api/staff/` 下只有 `auth` / `complaints` /
  `conversations` / `refunds`）。
- **客服与管理员进的是同一个后台**：`lib/types/admin.ts:27`
  `AdminRole = "admin" | "customer_service" | "companion"`，
  `lib/services/adminAuth.ts` 用 `canEnterAdminConsole(role)` 统一判定。
- 全仓唯一的「订单管理详情」是 `app/admin/(console)/orders/[id]/page.tsx`，
  由 `lib/services/adminOrders.ts` 的 `getAdminOrderDetail()` 供数，
  DTO 是 `lib/types/order.ts:331` 的 `AdminOrderDetail`。

**执行口径**：在 `AdminOrderDetail` 上新增一个 `releaseHistory` 字段。
一次改动同时满足 §九（唯一存在的订单管理详情）、§十一.23（客服与管理员
都从这个后台看）、权限表 §7.1 的「查看原因」与权限矩阵第 104 行的
「客服：查看原因 / 管理员：管理查看」。

不改 `StaffComplaintOrderSummary`：`lib/types/complaint.ts:276-281` 把它的契约
明确限定为「只够回答「这一单是什么、现在到哪一步了」」，往里塞履约历史
属于 §九 明令禁止的「借机」扩大，且会把内部取消历史带进投诉详情的通用响应里。

### Decision V3

Status: **CURRENT**（用户于 2026-09-23 人工验收阶段明确裁定，取代 V2）

**用户的裁定（原文要点）**：客服可查看打手 accepted 后主动取消记录**已经是最新需求冻结项**，
不是待产品确认项；P0-6 **必须补齐 Staff 可见性后才能进入人工验收**。要求至少包括
**原打手 / 取消时间 / 取消原因**，且**客服只能查看履职需要的数据**。
用户同时明确了实现原则与**排除项**：采用当前架构下的最小实现，
**不引入完整客服订单管理系统**，**不扩大为复杂 Assignment**；
并给出优先顺序——若现有 staff detail DTO 已承载订单摘要，**优先在该 DTO 中加入最小 `releaseHistory`**；
只有「现有 staff 页面没有任何合理入口能够查看普通订单」时才允许新增最小读取能力，
且仍不得建设完整订单列表 / 搜索 / 管理模块。
用户另明确：**只**在「两个同样最小且产品语义不同」时才进 `CLARIFYING`，
**不要因为页面路径这类纯技术组织问题停下来问产品**。

**V3 与 V2 的分歧点**：V2 把「客服落点是投诉详情 / 退款详情 / 新建客服订单页三选一」
当成了必须由产品裁定的歧义。用户裁定的实际上是**能力边界**（客服必须能看到，
且只看到履职所需），而**落点属于技术组织**——因此 V3 自行选定，不再上交。

**V3 的执行口径**（最小实现，**不新增任何 API 路由**）：

1. 新增一个客服侧最小条目类型 `StaffCompanionReleaseEntry`
   （`lib/types/staff.ts`）：`companionId` / `companionName` / `source` /
   `sourceLabel` / `reason` / `createdAt`。
   **刻意不含**记录 `id` 与 `actorId`（内部字段，客服履职不需要），
   **不含任何金额**——平台净收入 / 分账 / 管理员备注 / 用户 `userId` / 订单备注 /
   游戏账号一律不进这三个 DTO。
2. 给**三个已经承载订单摘要的既有 DTO** 各加一个 `releaseHistory: StaffCompanionReleaseEntry[]`：
   `StaffOrderSummary`（会话详情）、`StaffComplaintOrderSummary`（投诉详情）、
   `StaffRefundDetail`（退款详情）。
3. 数据搭在上述接口**既有的 `requireStaff()` 鉴权**上——因此**不新增写入口、
   客服在结构上不可能修改 ReleaseRecord**，也**不影响 `tests/staff.test.mjs` 的 16 条接口清单**。
4. `CompanionReleaseRecord` 保持冻结的 7 字段**不变**：不为了显示名字而加打手名字快照，
   展示名由服务层按 `companionId` 现查、查不到回落到 id。
5. 渲染侧新建一个只读展示组件，挂在会话详情 / 投诉详情 / 退款详情三处。

**为什么是三个 DTO 而不是只挂会话页**：会话页是客服与订单之间的主界面，且已渲染完整订单摘要，
但它不是唯一入口——投诉详情与退款详情的「进入会话」入口在订单**没有沟通记录时是 `null`**，
只挂会话页会让这两个场景看不到。用户明确要求「在处理与某订单有关的**投诉 / 退款 / 会话**时」
都能查看，因此三处各自承载。

**V2 遗留保护的处置**：V2 留下的具名用例
「缺口：客服端目前没有查看取消历史的入口」（`tests/companionOrders.test.mjs`）
**按 V2 自己的预言变红了**——这正是它存在的意义。V3 已按「应更新它，不是删掉它」
改写为**正向断言**：客服侧现在必须能看到，且三条可达性事实（
`canEnterAdminConsole` 仍只放行 `admin`；客服侧仍无订单接口；`releaseHistory` 现在出现在
三个 staff DTO 上）逐条钉住。

### D7 — 打手「我的订单」列表/详情只按 `actualCompanionId` 归属

Status: CURRENT

`01-prompt.md` §7.1 已把这一点写成硬规则，此处只记录源码侧的落点，
供实现与 Reviewer 对照：

- 列表查询必须**以 `actualCompanionId` 为查询条件**（沿用 `queryOrders` 那种
  「当条件而不是过滤器」的写法），不是「查出来再比对」；
- `exclusiveCompanionId === 当前 companionId` **绝不等于**订单归本人
  （`lib/types/order.ts:344-352` 记录了它「用户指定」的语义，
  `lib/data/mockDispatchRepository.ts` 里的 `exclusiveCompanionId` 在回池后也不清）；
- 详情必须**服务端重新校验**，不能只靠列表入口隐藏；
- DTO **不得**复用 `AdminOrderDetail` 或 `OrderDetail`：`OrderDetail` 带
  `clubNetIncome` 之外的平台金额域与售后摘要，`AdminOrderDetail` 带
  `exclusiveCompanion`、`refundSummary`、`complaintSummary` 等管理员信息。
  按 §7.3 的清单**显式挑字段**新建 Companion 订单 DTO。

### D8 — 新增文件放置位置已由技术设计冻结，不新增目录

Status: CURRENT

`docs/02-tech-design/directory-structure.md` §8.1 A/C 已逐条列出本轮所有落点，
实现时直接照落，不再自行选址：`lib/types/order.ts`、`lib/types/companionRelease.ts`、
`lib/constants/orders.ts`、`lib/data/companionReleaseRepository.ts`、
`lib/data/mockCompanionReleaseRepository.ts`、`lib/data/companionOrderTransaction.ts`、
`lib/services/companionOrders.ts`、`lib/services/companionHttp.ts`、
`app/api/companion/orders/**`、`app/companion/(console)/orders/**`、
`components/companion/*Order*.tsx`。

### D9 — 通知：复用现有通道，`kind: "dispatch"`，一次成功取消一条

Status: CURRENT

`lib/types/notification.ts:18` 的 `NotificationKind` 已含 `"dispatch"`
（used by 接单成功 / 专属池超时 / 公共池超时三条既有通知），本轮**不新增 kind**。

沿用 `lib/data/companionDispatchTransaction.ts` 已经确立的两步式：
先在原子区段**之外**用 `parseNotificationInput()` 组好并**校验**通知
（`lib/constants/service.ts`，要求 `userId`/`title`/`summary`/`body` trim 后非空，
`href` 为 null 或以 `/` 开头且不含 `?`），区段内只做不会失败的
`appendNotification()` + `newNotificationId()`。

⚠️ 通知的 `userId` 是**下单用户**，不是打手。文案落点：
`lib/constants/dispatch.ts` 新增一条常量（该文件已是派单域全部文案的唯一出处）。
不新建第二套 Notification 仓储，不在页面里伪造通知，不只 toast。

### D10 — `COMPANION_ACCEPT_NOTICE` 在本轮后成为错误事实，必须同步

Status: CURRENT

`lib/constants/dispatch.ts` 现有：

```
COMPANION_ACCEPT_NOTICE = "接单后由你负责这一单，不能自行退回。无法履约请联系用户或客服。"
```

本轮之后「不能自行退回」**不再成立**。这条文案是打手在公共池页面上、点接单前
看到的承诺语，留着它等于在页面上承诺一条已被需求改掉的规则。
`01-prompt.md` §八 要求页面上出现「取消接单」入口，两者并存会自相矛盾。

**执行口径**：改为准确表达新规则的措辞（接单后负责，但尚未开始服务前可提交原因取消），
并同步 `tests/` 中引用该常量的断言（若有）。

---

## 三、明确判为**非阻塞**的观察项（不需要用户裁定）

| # | 观察 | 为什么不阻塞 |
|---|---|---|
| N1 | `api-contract.md:468` 标注 `requireCompanion`（预期），路径 `/api/companion/orders/[id]/cancel` | 「预期」只是标记该接口尚未实现；本轮实现后即为 CURRENT，同时按门禁要求扩充 `tests/companion.test.mjs` 清单 |
| N2 | `01-prompt.md` §2.2 未给 reason 长度规则 | 需求确实未冻结，且 prompt 已明令「不要自行创造 5～50、10～200 等长度规则」。只做 trim + 空串拒绝 |
| N3 | `Dispatch.state` 是否需要一个新枚举值表示「回池过」 | 不需要。`state = "public"` 已足够表达当前事实，`publicPoolEnteredAt` 会在每次进入公共池时重写（`lib/types/dispatch.ts:75-80` 已把这条语义写死）；新增枚举值属于 §十四 禁止的「复杂 Assignment 系统」 |
| N4 | 取消后 `Order.companionBaseIncome` / `companionRateSnapshot` / `refundedAmount` 是否要动 | 不动。前两者在 `lib/services/checkout.ts:223/443` 下单时即冻结，与谁接单无关；`refundedAmount` 在 §十四 明令 out of scope（本轮不退款） |
| N5 | 被停用的打手无法取消自己的 `accepted` 订单 | 见 D4：这是 `requireCompanion()` 的既有行为，对应「封禁回池由系统侧处理」这一已确认分工（§十四 / 需求表「enabled=false 时 accepted/serving 都回公共池」属于后续 Round）。本轮**不**为此放宽守卫 |
| N6 | `OrderDispatchProgress` 是否需要改 | 不需要。`lib/types/order.ts:186` 定义它「只有还在等人接的订单有这一项（`paid` 且未被人接走）」。取消后订单恰好回到 `paid` + Dispatch 回到 `public` + deadline 已重冻，该摘要块**自动**以正确内容重新出现 |
| N7 | 回池后其他打手能否看到并接单 | 已由现有代码保证，无需新增逻辑：`lib/services/companionDispatch.ts:114` 的 `order.status !== "paid"` 过滤在取消后成立；`state === "public"` + 未来 deadline 使 `toDispatchProgress` 返回非 null；`acceptDispatch` 的既定 Guard 不变 |

---

## 四、本轮 scope 边界（重申 `01-prompt.md` §十四，不扩不缩）

`serving → paid` 虽然进入**结构**状态机（D-§五 TARGET 表），但本轮
**不提供任何入口**：不实现封禁回池、不实现客服换人、不提供 serving 普通主动取消。
`canTransitionOrder()` 只表达结构许可，**不代替领域 Guard**——
结构表允许不等于该动作有入口，这条在 `lib/constants/orders.ts:83-101` 的既有注释里
已经写明，本轮实现必须继续遵守。

---

## 五、决策状态汇总

| ID | 主题 | Status |
|---|---|---|
| D1 | 幂等：幂等键索引 + 状态双重保险，不使用 `adminWriteSupport` | CURRENT |
| D2 | 取消后清空 `actualCompanionId` / `companion` / `acceptedAt` | CURRENT |
| D3 | `applyDispatchToPublic` 补齐清空接单绑定；保住 `exclusiveCompanionId` | CURRENT |
| D4 | 取消资格只判 §2.1 两条，不引入 `isCompanionAcceptingOrders` | CURRENT |
| D5 | 非本人 404，本人但非 `accepted` 400 | CURRENT |
| D6 | 客服/管理员可见路径 = `AdminOrderDetail.releaseHistory` | V1 SUPERSEDED → V2 SUPERSEDED → **V3 CURRENT**（客服侧挂在会话 / 投诉 / 退款三个**既有**只读详情 DTO 上，**不新增任何 Staff 接口**；用户已于验收阶段裁定客服可见性属本轮范围） |
| D7 | Companion 订单归属只按 `actualCompanionId`，DTO 最小化 | CURRENT |
| D8 | 文件放置照 `directory-structure.md` §8.1，不新增目录 | CURRENT |
| D9 | 通知复用现有通道，`kind: "dispatch"`，一次成功取消一条 | CURRENT |
| D10 | 同步 `COMPANION_ACCEPT_NOTICE`（已不再成立的事实） | CURRENT |

**无 `Status: OPEN` 的决策 → 允许进入业务编码。**
