Round ID: PROD-1C
Title: AdminAudit Closure + Deferred Transactions（管理审计写闭包 + PROD-1B 延期事务 T8 / T14 / T15 的 Pg 实现与实证；**intentionally not activated**）
Status: AWAITING_ACCEPTANCE
Depends On:
- PROD-1B（Order Hub PostgreSQL Implementation & Concurrency Proof，已 DONE）——尤其其 `02-decisions.md` Q1 §13b/§13d（延期清单与切换前置条件）
- PROD-1A（PostgreSQL 基础层，已 DONE）——`withTransaction` / 版本化迁移 / 种子与重置 / 安全守卫
- `docs/02-tech-design/architecture-rules.md` §2.5（伪事务适用范围 / **半迁移禁令**）
- `docs/02-tech-design/tech-stack.md` §11.1（`pg` 只允许出现在 `lib/data/pg/**`；结构变更只走版本化迁移）
- 本轮 `02-decisions.md` D1–D9
Goal: 把 PROD-1B 因 `admin_audit_entries` 边界而延期的三个管理端事务（**T8** `setCompanionFlags` / **T14** `approveRefund` + `rejectRefund` / **T15** `startReviewRefund`）迁到 **PostgreSQL 真事务**，并正式建立 `AdminAudit` 的 PostgreSQL 持久化。
  **核心不变式：审计失败必须回滚业务改动。**
  **本轮不改任何已冻结的业务规则，不切数据源**：`DATA_SOURCE` 不设置，`getAdminAuditRepository()` 仍返回 Mock；
  激活门槛（PROD-1B §13d）**未满足**——33 处 `writeAudit` 中还有 29 处未迁。
Primary Domain: 数据访问层（`db/migrations/**`、`lib/data/pg/**`、`lib/data/adminWriteSupport.ts` 的读写分离、`lib/constants/**` 的纯函数共用）
Primary State Transition: 无（不触碰任何业务状态机；仅替换同一批写入的持久化实现）
Started At: 2026-10-05
Development Completed At: 2026-10-05
Accepted At: —
Git Commit: —

---

## 一句话

**本轮把卡在「管理审计」这根线上的三个事务从内存原子模型翻译成 PostgreSQL 真事务，
并第一次证明「审计写不进去，业务改动一条都留不下来」——但仍然不扳开关。**

## 本轮的三个判断

**① 审计不是日志，它是这三个事务的参与者。**
PROD-1B 把 T8 / T14 / T15 延期，理由是它们的原子写集合跨过了 `admin_audit_entries` 边界。
这条边界的实质是：`operation_id` 上的唯一约束**就是幂等本身**（`takeReplay` 家族读它来判「这件事做过了没有」），
而业务改动与它的那一条审计必须**同生共死**。因此这张表既写又读，不是「顺手记一笔」。
`db/migrations/0009_admin_audit_entries.sql` 的注释把这三条理由逐条写了下来。

**② 保真的难点在**判定顺序**，不在 SQL。**
Mock 的 `takeReplay` 要求**先查幂等账本、后查业务数据**——这个顺序决定了
「同一个键复用到另一个对象上时报 400」与「安静地返回另一个对象的结果」之间的差别。
直接翻译会在并发下留下空档：两个同键请求双双读到空账本、双双执行，撞的不是「重放」而是 `23505`。
**处理方式**：两次读——加锁前一次**只回答 `conflict`**（安全，因为冲突判定不写任何东西），
加锁后一次回答 `replay`/`conflict` 并**决定是否写入**。判定逻辑本身两个存储**只有一份实现**
（`lib/data/adminWriteSupport.ts` 的 `evaluateReplay` / `refineReplayByAction`）。见 `02-decisions.md` D1。

**③ 零漂移的手段是**把规则抽出去**，而不是「照着抄一遍」。**
Pg 侧要写同一组列，就必须有同一组规则。因此把 `resolveRefundReview` / `resolveEarningReversal` /
`nextCompanionFlags` / `resolveCompanionRefundCopy` 等纯函数从 Mock 事务里搬到 `lib/constants/**`，
两边共用。`lib/constants/**` 的改动是**纯新增**（211 增 / 0 删），原模块保留同名导出，
服务层与测试的引用路径**一个都没变**。见 `02-decisions.md` D3。

## 实证（本轮的实际交付证据）

| 要证的 | 靠什么证 | 结果 |
|---|---|---|
| 同一批业务规则在真事务里仍成立（判定顺序 / 金额 / 幂等 / 状态机） | 37 条打真库的等价用例（其中 3 条**同键并发**） | ✅ |
| **审计失败 ⇒ 业务写入全部回滚** | 5 条「最后一笔写入失败」探针（审计表 / 退出历史 / 收益明细） | ✅ |
| 两个管理员同时批同一笔退款，**只出一次款** | 7 条 `Promise.all` 真并发用例 | ✅ |
| 全程同一条连接、同一提交点 | 探针记录 `pg_backend_pid()`，断言一次事务里 pid 唯一 | ✅ |

`tests/pgAdminAuditTransactions.test.mjs` · `pnpm test:pg` = **170 / 0 fail / 0 skipped**
· `pnpm test`（生产 `APP_BASE_URL` 全量）= **2037 / 0 fail / 0 skipped**
· `typecheck` / `lint` / `build` 均 exit 0。详见 `03-delivery.md` §4。

**独立复审（`reviewer-agent`，只读）：首轮 `1 MAJOR / 1 MINOR / 2 NOTE` → 整改后回执确认
`0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE`**。MAJOR（并发用例没有保护两读设计）已补 3 条同键用例
并留红-绿证据，MINOR 已修，两条 NOTE 作为已知分歧登记（`03-delivery.md` §6 / §7）。

## 本轮**没有**做的事

不切数据源 · 不迁其余 29 处 `writeAudit` · 不改任何业务规则 · 不用 `SERIALIZABLE` ·
不改 `0001`–`0008` 任何 migration · 不改历史轮次记录 · **零 Git 写操作**。

## 档案

`01-prompt.md`（本轮指令与三条 Hard Rule）· `02-decisions.md`（D1–D9 与判据）·
`03-delivery.md`（交付 · **33 处写者登记** · **激活就绪报告（6 问）** · 验证证据）·
`04-acceptance.md`（人工验收清单，**待验收**）。

## 下一轮

激活 `DATA_SOURCE=postgres` 的门槛（PROD-1B `02-decisions.md` Q1 §13d 逐字）：

> 17 张表的全部写者 + `admin_audit_entries` 的全部 33 处写者（10 个文件中的另外 8 个）
> 一并迁完，`DATA_SOURCE=postgres` 才允许被声明为可用。

本轮已迁 **4 / 33**；剩余清单与逐文件计数见 `03-delivery.md` §2。
