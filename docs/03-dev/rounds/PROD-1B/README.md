Round ID: PROD-1B
Title: Order Hub PostgreSQL Implementation & Concurrency Proof（订单核心事务闭包：Schema + Pg 实现 + 并发实证；**intentionally not activated**）
Status: DONE
Depends On:
- PROD-1A（PostgreSQL 基础层：连接池 / withTransaction / 版本化迁移 / 种子与重置 / 健康检查 / 数据源开关，已 DONE）
- `docs/02-tech-design/architecture-rules.md` §2.4（仓储两种形态）/ §2.5（伪事务适用范围 / 半迁移禁令）
- `docs/02-tech-design/tech-stack.md` §11.1（`pg` 只允许出现在 `lib/data/pg/**`；结构变更只走版本化迁移；切换需事务闭包完整）
- `docs/02-tech-design/database-schema.md` C1–C10（尤其 C2 幂等键 → 唯一约束、C3 跨实体一致性同事务、C4 deadline 持久化、C6 金额快照、C8 `timestamptz`、C9 整数分）
- `docs/02-tech-design/directory-structure.md` §迁移四步（:204–212）与门槛（:211「全部参与实体迁完才允许切」）
- 本目录 `02-decisions.md` Q1（本轮范围裁定）
Goal: 把 W1 订单核心事务闭包（15 个事务入口 / 15 张写表）从 Mock / `globalThis` 原子模型，落地为 **PostgreSQL 真事务实现**：建表建约束、按仓储四步补 Pg 实现、把伪事务的原子区段重写为 `BEGIN → 锁/条件更新 → 业务闸 → 写入 → COMMIT`，并用并发实证证明「恰好一个成功」「重放不重复写入」。
  **本轮不改已冻结的订单 / 派单 / 履约 / 收益 / 退款业务规则，不是全库迁移。按 Q1 裁定，本轮不切数据源**：`DATA_SOURCE` 不设置，应用仍跑 Mock；`DATA_SOURCE=postgres` 在本轮**仍不是**可用的迁移验证模式，因为闭包尚未含管理端审计分支（见 02-decisions Q1 的 Final Execution Rule）。
Primary Domain: 数据访问层（`db/migrations/**`、`lib/data/pg/**`、`lib/data/*Repository.ts` 的 accessor 与写原语）
Primary State Transition: 无（不触碰任何业务状态机；仅替换同一批写入的持久化实现）
Started At: 2026-10-03
Development Completed At: 2026-10-05
Accepted At: 2026-10-05
Git Commit: 5acf616569d05aa3c553c366bde7b335f8dc65ce

---

## 一句话

**本轮把「订单核心事务」这一整块内存原子模型，翻译成 PostgreSQL 的真事务；但因为闭包边界上还挂着一根管理端审计的线，所以本轮只交付实现与实证，不扳开关。**

## 本轮的三个判断

**① 实测闭包 ≠ 候选清单，且它比预想的大。**
逐文件核对后，Order 的写闭包是 **15 张表 / 15 个事务入口**（详见 `02-decisions.md` Q1 的证据表）。它包含 admin refund、coupon、complaint、platform config —— 这四项在原指令的「不要扩 Scope」清单里。而 `admin_audit_entries` 作为 W1 成员，会在**切换时**级联另外 8 个管理端事务。
**处理方式**：闭包本身不拆（5 处规则一致禁止「一半 PG、一半 Mock」），但把「切换」这一步剥离出本轮。不切数据源 ⇒ 管理端审计那一层不进本轮 ⇒ 本轮范围收敛为**闭环的 15 表**。

**② 「不切数据源」不等于「不交付」，也**不是** BLOCKED、不是未完成——这是迁移阶段设计的一部分。**
本轮的可交付物是三样实打实的东西：**建好约束的表**、**同一接口的 Pg 实现**、**能证明并发正确的测试**。这三样都不需要扳开关就能验证——`pnpm test:pg` 直接打真库。
**⚠️ Pg 实现不得是 placeholder**：必须能被真实 PostgreSQL 测试证明（见 02-decisions Q1 的 Final Execution Rule 第 7 条），且**测试必须真连 `TEST_DATABASE_URL`，不得用 mock / stub 的 Pg client 假验证**。
扳开关的前置条件被写成文档化门槛：**全部 15 张表的写者 + 管理端审计的另外 8 个事务（全库 33 处 `writeAudit`，分布在 10 个 admin 事务文件）一并迁完**。

**②b 运行期状态（用户裁定，逐字）：**
> 「本轮结束后：当前应用 Order Hub 仍然使用完整 Mock 路径。不得出现 `Order Pg + AdminAudit Mock` 或任何其它 `half PG + half Mock` 事务。已有 PROD-1A favorite / suggestion 的独立 Pg vertical slice 不受影响。」

**②c Schema 纪律（用户裁定，逐字）：**
> 「只创建本轮 Pg implementation / test 真正需要的 schema。如果为了数据库 FK 必须引用一个尚未迁移的外部实体：先判断是否真的需要数据库 FK。**不得为了 FK 完整性把整个其它业务域顺手迁进来。** 业务上的外部 ID 可以在当前迁移阶段作为稳定 ID 存储，在最终闭包迁移阶段再补适当 FK，前提是**文档明确登记**。但：**任何属于本事务写闭包的实体不能用这个办法逃避迁移。**」

**②d 补记：事务入口边界审计（交付后补做，结论已落进实现）。**
上一版把 T3 / T4 / T5 / T6 / T7 一并推给下一轮，理由是「不在这两份清单里」——**这个理由不成立**。
判据应当是「该事务的**完整原子写集合**是否已全部属于本轮已建的 17 张表」。
按此重判：**T3 / T4 / T5 / T6 / T7 全部属于，本轮已补齐实现与真实 PostgreSQL 实证**；
**T8 / T14 / T15 可延期 PROD-1C**（闭包跨 `admin_audit_entries` 边界），
登记理由 `Pg implementation deferred because full atomic write closure crosses PROD-1B boundary`。
逐 Tx 的写集合与裁定表见 `03-delivery.md` §1.2。补齐过程中发现并修掉一处**加锁顺序成环**
（T10 / T11 的取锁顺序倒过来，全库统一为「`orders` 永远是第一把锁」，判定与写入一个字未改）。

**③ 验收标准放在「并发与约束」上，而不是「能连上库」。**
`EX-INFRA-03:1103` 已写明「**不能把 Node 单进程测试当成数据库原子性证明**」。本轮要证的四条：

| 要证的 | 靠什么证 |
|---|---|
| 两名打手抢同一单，**恰好一个成功** | 同一条 dispatch 行上的条件 `UPDATE` 影响行数判定 / `SELECT … FOR UPDATE`；N 并发实测 |
| 唯一性是**数据库**在管 | 绕过仓储直插重复行 → SQLSTATE `23505` |
| 重放**不产生**第二条完成 / 收益 / 冲回 / 通知 | 幂等键落成唯一约束 → 冲突回读既有结果（不用「先查再插」） |
| deadline 是**业务事实**，不靠读它才存在 | `timestamptz` 往返 + 快照字段随对象同表持久化（`api-contract.md:1009` 的迁移 TARGET） |

## 人工验收（2026-10-05）

**PROD-1B Manual Acceptance = PASSED**（详见 `04-acceptance.md`）。

| 组 | 内容 | 结论 |
|---|---|---|
| A | Runtime 未激活（不存在 half PG + half Mock） | PASS |
| B | T3 `sweepExpiredDispatchesPg`：catch-up / 幂等 / `refundedOrderIds` 不误报 / rollback | PASS |
| C | Accept Race：真库 8 并发抢同一单，恰好 1 人成功 | PASS |
| D | Cross-table Rollback：最复杂事务（T4，5 张表）最后一笔写入失败 → 整笔回滚 | PASS |
| E | Deferred Boundary：本轮已 Pg-ready 清单 / 延期 PROD-1C 清单与闭包原因 | PASS |

**Issues Found：无 BLOCKER / 无 MAJOR。** 两条 NOTE（`w1_probe_fail` 在进程外手工脚本下的残留；
验收期间手工写入的测试库业务数据已由随后的 `pnpm test:pg` 全量重置覆盖）经用户确认
**接受为非阻塞已知事项，本轮不返工**。收口时另更正 `04-acceptance.md` B3 的一处**文档勘误**
（引用的 CHECK 字面串改为逐字引用 `0004_orders_and_payments.sql:99`，语义等价，不涉及代码）。

**双门槛已满足，Round 状态 = `DONE`**：① 用户明确说「人工验收通过」；② 用户本人已完成 Git commit
（`5acf616569d05aa3c553c366bde7b335f8dc65ce`，`PROD-1B Order Hub PostgreSQL implementation and concurrency proof`）。
`Accepted At` = `2026-10-05`。Claude 全程**未执行任何 Git 写操作**，`DONE` 的判定依据是用户本人的提交事实。

## 档案

`01-prompt.md`（本轮指令）· `02-decisions.md`（裁定与执行口径，**含 Q1 范围裁定**）·
`03-delivery.md`（交付与验证）· `04-acceptance.md`（验收清单与人工验收记录）。

## 下一轮

本轮已于 **2026-10-05 收口为 `DONE`**（`HEAD = 5acf616`）。⚠️ `DONE` 覆盖的是**实现与实证**，
**不覆盖「切换」**：切数据源（以及管理端审计的另外 8 个事务）属于**下一轮 PROD-1C**，
前置条件见 `02-decisions.md` Q1。
