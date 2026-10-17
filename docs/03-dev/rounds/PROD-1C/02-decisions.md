# 决策记录

Round: PROD-1C
记录人: Claude
记录时间: 2026-10-05

> 本文件记录本轮**实现过程中真正做过的判断**，以及每个判断的**判据**与**代价**。
> 未标注「用户裁定」的条目均为**按现有文档规则自动判定**，未新增产品决定。
> 凡涉及业务规则的疑点一律只**登记**（Hard Rule 3），不改代码。

---

## 0｜Requirement Check 结论

**0 unresolved blocking decisions** → 按授权「直接开始实现，不等我」。

核对方式：以**当前工作树里的真实代码**为唯一真值源（`lib/data/adminCompanionTransaction.ts`
的 `setCompanionFlags`、`lib/data/adminRefundTransaction.ts` 的三个入口、
`lib/data/adminWriteSupport.ts` 的 `takeReplay` 家族、`lib/data/pg/w1Transactions.ts` 的
读 / 锁 / 写原语），逐条比对而被迁移的事务要写的每一列、每一个判定、每一个返回分支。

**发现的唯一「疑似业务疑点」**：无。本轮未发现任何需要登记的业务规则冲突
（PROD-1B 已登记的 Q2「§17 比例冲回 vs P0-15 整笔冲回」在本轮范围内**没有新增证据**，
其结论仍按 PROD-1B `02-decisions.md` Q2 执行：代码取整笔，文档表述的修订单独立轮次处理）。

---

## D1｜幂等的两次读：早读只回答 `conflict`，锁后读才决定 replay / 写入

**来源**：Hard Rule 3（零漂移）与 Hard Rule 2（强一致）的交点。

### 问题

Mock 的 `takeReplay`（`lib/data/adminWriteSupport.ts`）在注释里明确规定：
**先查幂等账本，再查业务数据**——这个顺序决定了「同一个键复用到另一个对象上时
报 400」与「安静地返回另一个对象的结果」之间的差别。因此迁移时必须保住这个**顺序**，
不能改成「先看对象在不在、再看键用过没有」。

但直接把这一段翻译过来（先 `SELECT` 账本、没有再 `INSERT`）会在并发下留一个空档：
两个**同键**请求双双读到空账本，于是双双执行 —— 撞的不是「重放」，而是 `23505`
（`admin_audit_entries_operation_key`），整段事务回滚，两个请求都失败，
而正确结果是**第二个重放第一个的结果**。

### 裁定

每个被迁移的事务做**两次账本读**：

| 时机 | 读什么 | 只回答什么 | 为什么这一次读是安全的 |
|---|---|---|---|
| **加锁之前** | `readAuditEntryByOperationIdTx(tx, operationId)` | 仅 `conflict` | 一次 `conflict` 判定**不写任何东西**，因此「两个请求都读空」不会导致任何错误写入；它只是让复用键的请求**更早**被拒 |
| **加锁之后** | 同一个函数 | `replay` / `conflict`，并**决定是否写入** | 此时已经持有竞争行的排他锁，第二个事务看到的是第一个**已提交**的账本行 |

`takeReplayForActionTx`（即 `refineReplayByAction(evaluateReplay(...))`）在两处都走同一组纯函数
（`lib/data/adminWriteSupport.ts` 的 `evaluateReplay` / `refineReplayByAction`），
因此「什么算重放、什么算冲突」两个存储**只有一份实现**。

### 代价与验证

多一次 `SELECT`。换来的是 Mock 的错误优先级**逐条保留**。
并发正确性由 `tests/pgAdminAuditTransactions.test.mjs` 的四条并发用例实测
（T14 双通过 / T14 通过与拒绝并发 / T15 双开始审核 / T8 停用与订单完成并发），
全部为 `Promise.all` 真并发（每个 `await` 都是一个让出点）。

---

## D2｜加锁顺序：`orders` 永远是第一把竞争锁

**来源**：Phase 7 + PROD-1B 已建立的全库不变量「`orders` 是第一把锁」。

| 事务 | 加锁顺序 |
|---|---|
| T8 `setCompanionFlagsPg` | `companions` → `orders` → `dispatch_records` → `completion_submissions` |
| T14 `approveRefundPg` | `orders` → `refund_requests` → `earnings` → `dispatch_records` |
| T15 `startReviewRefundPg` / `rejectRefundPg` | `refund_requests`（唯一一把） |

**只锁真实竞争资源**：

- T8 必须锁 `companions` 行——它是这个动作**自己的目标**，两个管理员同时改同一位护航时
  必须有唯一的先后。
- T14 必须锁 `orders` 行（金额闸与状态迁移都要读它）与 `refund_requests` 行（状态机）。
- T15 只锁 `refund_requests`：它一个字节都不写订单。
- **`orders` 与 `companions` 的读，凡是「只是读、不参与本次竞争」的一律走不加锁的
  `readCompanion` / 普通 `SELECT`**——`w1Transactions.ts` 里
  `readCompanion` 的注释已写明「给它上锁会让接单与改开关互相阻塞，而 Mock 从来没有这条互斥」。

**环检查（本轮新增路径）**：全库 `FOR UPDATE` 调用点两两核对后，
`companions` 只被 T8 这一条路径加锁，其余路径都只是**普通读** `companions`，
因此 `companions → orders` 这条边**不构成环**；`sweepMaturedEarningsPg` 只锁 `earnings`
且不等待其它锁。结论：无死锁环。

---

## D3｜共用判定抽进 `lib/constants/**`：这是本轮的**零漂移手段**，不是重构

**来源**：Hard Rule 1（闭包不得拆）+ Hard Rule 3（零漂移）。

Pg 侧要写同一组列，就必须有同一组规则。如果让 Pg 实现把判定再写一遍，
那天两条规则会各自演化——而它们决定的是**钱**。

因此把下面这些**纯函数**从 Mock 事务里原样搬到 `lib/constants/**`，Mock 与 Pg 同时引用：

| 常量模块 | 抽出的纯函数 | 原来住哪 |
|---|---|---|
| `lib/constants/adminRefunds.ts` | `resolveRefundReview` | `lib/data/mockRefundRepository.ts` 的 `applyRefundReview` |
| `lib/constants/earnings.ts` | `resolveEarningReversal` | `lib/data/mockEarningRepository.ts` 的 `applyEarningReversal` |
| `lib/constants/adminCompanions.ts` | `nextCompanionFlags` / `areCompanionFlagsUnchanged` / `companionFlagAction` / `CompanionFlagIntent` | `lib/data/adminCompanionTransaction.ts` |
| `lib/constants/refunds.ts` | `resolveCompanionRefundCopy` / `companionRefundNotificationHref` | `lib/data/adminRefundTransaction.ts` |
| `lib/data/adminWriteSupport.ts` | `evaluateReplay` / `refineReplayByAction` / `buildAuditEntry`（**拆出纯函数，读写分离**） | 原来的 `takeReplay` / `takeReplayForAction` / `writeAudit` 内联体 |

**关键纪律**：

- `lib/constants/**` 的改动是**纯新增**（`git diff --numstat`：211 增 / 0 删），
  没有一行既有常量被就地改写。
- 原模块保留同名导出（如 `adminCompanionTransaction.ts` 仍然 `export type { CompanionFlagIntent }`），
  服务层与测试的引用路径**一个都没变**。
- `writeAudit` **原样保留**（仍然写 Mock store）。Pg 侧**不调它**，改调 `buildAuditEntry`
  拿纯记录再 `INSERT`——否则 Pg 事务里会同时写进 Mock 账本，那正是本轮要消灭的「一半 Mock、一半 Pg」。

**零漂移的证据**：`pnpm test` 全量 2037 用例 `0 fail` `0 skipped`（Mock 行为未变），
`pnpm test:pg` 170 用例 `0 fail` `0 skipped`（Pg 行为达标）。

---

## D4｜`applyOrderRefundTx` 加宽返回值：给调用方**写入器亲眼看到的**前后订单

**来源**：审计快照必须记「这次写入造成的那个变化」。

改前返回 `{ changed }`；改后返回 `{ changed, previous, updated }`。

**为什么不能让调用方自己在外面再读一次**：并发下「事务开始时读到的订单」与
「写入瞬间的订单」可能不同，而审计的 `before.orderStatus` / `after.orderStatus`
必须与**这一次 UPDATE** 对应，否则审计记录会描述一件没发生过的事。

短路分支（已退满 / 已关闭）返回 `{ changed: false, previous: order, updated: null }`，
调用方统一写 `updated ?? previous`——这正是 Mock 里「`updated` 与 `previous` 是同一份」
那一步的等价翻译。`RETURNING` 让 `updated` 来自数据库自己，而不是本地拼装。

---

## D5｜本轮**不切数据源**（用户已在指令中裁定：Phase 11「本轮不要自行切」）

- `lib/data/adminAuditRepository.ts` 的 `getAdminAuditRepository()` **仍然返回 Mock**；
  `pgAdminAuditRepository` 这个常量**目前只有测试在引用**。
- `DATA_SOURCE` 在 `.env` 里**不设置** → 应用真实业务路径仍 100% Mock。
- PROD-1B 的 `13d` 激活门槛**尚未满足**（详见 `03-delivery.md` §3 的 Q4）。

**没有出现任何半 Pg 事务**：T8 / T14 / T15 的 Pg 实现是**新增的独立入口**
（`lib/data/pg/adminAuditTransactions.ts`），服务端调用链上没有任何一处指向它们。

---

## D6｜`admin_audit_entries` 的两处「**刻意不加**」

### 不 `action` / `target_type` 枚举 CHECK

`AdminAuditAction` 有 30 余个取值、`AdminAuditTargetType` 有 14 个，且**会长**。
加 CHECK 意味着每加一个后台动作都要开一次迁移，而 TypeScript 的类型联合已经是唯一真值源、
Mock 侧从来没有这条校验。收益为零（写错的取值在编译期就进不来），成本是持续的。

⚠️ 这与本仓其它表的做法**不矛盾**：`refund_requests.decision` 的 CHECK 挡的是
「金额算错了」这类**数值不变式**——类型说 `number`，说不出
`floor(实付 × 比例 / 10000)`。枚举取值的形状交给类型。

### 不加 `(actor_id, action, target_type, target_id)` 唯一约束

那位管理员**可以**对同一个目标反复做同一个动作：停用 → 启用 → 再停用，
三次的 `actor_id` / `target_type` / `target_id` / `action` 可以完全一样。
加这条唯一约束等于**改业务规则**（Hard Rule 3 禁止），而不是加固持久化。

**真正该唯一的轴只有一条：幂等键。**

---

## D7｜审计写入**不写 `ON CONFLICT DO NOTHING`**（比 Mock 更严，是刻意的）

- Mock 的 `appendAuditEntry` 在同一个 `operation_id` 第二次到达时会**覆盖**索引指向。
- PostgreSQL 侧**必须拒绝**（`23505` → 整段回滚）。

**理由**：一次审计被另一条记录顶掉，等于把「当时发生了什么」改写成另一件事。
业务侧的幂等判定如果漏了一次，那是应该当场炸出来的 bug，而不是被 `DO NOTHING` 静默吞掉。
这与 `notifications` 的写入纪律是同一条（见 `w1Transactions.ts` 的 `appendNotification` 注释）。

---

## D8｜`admin_audit_entries` 进测试探针名单 `PROBED_TABLES`

`tests/pgW1Transactions.test.mjs` 的探针名单加了两张表：`companion_release_records`、
`companion_service_events`（T8 的批量解除要写它们），以及 **`admin_audit_entries`**。

**为什么必须盯上审计表**：本轮的**全部理由**是「审计失败必须回滚业务改动」。
不把审计表纳入探针，「审计写不进去时业务写入是否回滚」这句话在测试里**无法证伪**。
断言落在 `tests/pgAdminAuditTransactions.test.mjs`（那三个事务的宿主文件）。

⚠️ 探针对象（`w1_write_log` / `w1_probe_fail` / `w1_probe_trg`）是**测试库里的对象**，
不构成任何业务 schema；`resetDatabase()` 清它们的数据，`dropDatabaseObjects()` 连对象一起删。

---

## D9｜`admin_audit_entries` **不进种子**（保持 `EMPTY_HUB_TABLES`）

与 Mock 侧的立场一致（`mockAdminAuditRepository.ts` 注释：「平台刚上线时本来就没有人操作过，
凭空造几条『某人做过某事』的审计，比空着更容易误导」）。
`tests/pgFoundation.test.mjs` 的 `ALL_TABLES` 与 `EMPTY_HUB_TABLES` 因此都把它列进去，
并且每个测试用例的 `beforeEach` 都从**空账本**开始——这也让「一条动作恰好产生一条审计」
的断言不会与种子数据混淆。

---

## 未决 / 留给下一轮

| 事项 | 状态 | 出处 |
|---|---|---|
| 切换 `DATA_SOURCE=postgres` | **未做**（本轮明令不切） | D5 / `03-delivery.md` §3 |
| 其余 8 个管理端事务 + `adminCompanionTransaction` 剩余 5 处 `writeAudit` | **未迁**（登记见 `03-delivery.md` §2） | PROD-1B `13d` |
| 需求文档 §17 的按比例冲回表述与 P0-15 的冲突 | **未改**（PROD-1B 已登记，独立轮次处理） | PROD-1B `02-decisions.md` Q2 |
| 用户端可见 `companionRateBp` | **未改**（已知上线前技术债） | 既有登记 |
| `restoreCouponClaimForOrderTx` 在 approve 路径上实际是 no-op | **保留**（Mock 等价翻译，见 D3） | `03-delivery.md` §1.4 |

**本轮无 OPEN 决策阻塞交付。**
