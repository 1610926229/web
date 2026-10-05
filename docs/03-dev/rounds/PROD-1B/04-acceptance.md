# Acceptance

Round: PROD-1B
Status: AWAITING_ACCEPTANCE（人工验收已通过 2026-10-05；**待用户自行完成 Git commit 后**方可转 `DONE`）

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`lint` / `typecheck` / `build` / `pnpm test` / `pnpm test:pg`）
> 在 `03-delivery.md` §5 记录为实测结果，不在此重复。这里只列**自动化测不到或不便覆盖**的部分。

---

## 〇、验收前你需要知道的一件事

**本轮不切数据源。** 按 `02-decisions.md` Q1 的裁定，`DATA_SOURCE` 保持**不设置**，
应用的真实业务路径仍然 **100% Mock**。

**所以你打开页面看，不会看到任何变化** —— 订单、派单、接单、完成、收益、退款的行为与本轮之前**逐字相同**。
**这不是漏做**，这是本轮的裁定结果本身（Round 的定义就是 `Order Hub PostgreSQL Implementation &
Concurrency Proof`，**intentionally not activated**）。

本轮能验收的是**三样实打实的东西**：

1. **表与约束** —— 17 张表真的建出来了，约束是**数据库**在管，不是 TypeScript 在管；
2. **Pg 实现** —— 13 个仓储 + 11 条真事务，接口与 Mock 逐方法一致（不是 placeholder）；
3. **并发实证** —— 打真库的测试证明「抢单恰好一人成功」「重放不重复写」「失败整笔回滚」。

**为什么不能现在就切**：17 张表之外还有 `admin_audit_entries` 没进 Pg，而 T8 / T14 / T15 的原子段里含
`writeAudit`。此时扳开关会同时踩中两条硬规则（同一张表两个住址 / 半 PG 半 Mock 事务）。
切换的前置条件是**下一轮 PROD-1C**：把管理端审计的另外 8 个事务写者一并迁完。

---

## Manual Acceptance Checklist

> 本轮人工验收按用户指定的**五组**执行：**A Runtime 未激活 · B T3 · C Accept Race ·
> D Cross-table Rollback · E Deferred Boundary**。逐组结果与证据见下方
> 《Manual Acceptance Record》。下列清单为验收步骤说明，被五组覆盖到的项目已勾选并注明对应组。

### A. 先确认「没有激活」这件事是真的

- [x] **A1** 应用没有打开 Pg 开关。
      跑 `grep -n "DATA_SOURCE" .env` —— **预期：没有任何输出**。
      （`.env` 里只有 `DATABASE_URL` 指向 `chaoge_esports_dev` 与 `TEST_DATABASE_URL` 指向 `chaoge_esports_test`。）
      ✅ 实测：`.env` 与 `.env.local` **均零命中**；只有 `.env.example:58-71` 有注释与空赋值 `DATA_SOURCE=`。

- [x] **A2** 业务代码碰不到 Pg 实现。
      `pnpm test:pg` 里的 `tests/pgConfig.test.mjs` 有一条**扫源码**的用例，
      断言「`pg` 只允许出现在 `lib/data/pg/**`；被列入的已知服务文件不得引驱动、不得引 `lib/data/pg`、
      不得自行读 `DATA_SOURCE`」。**预期：该文件全绿。**
      ⚠️ **该用例的覆盖范围是硬编码的四个文件**（`lib/services/favorites.ts`、`lib/services/suggestions.ts`、
      `lib/services/favoritesHttp.ts`、`lib/services/suggestionsHttp.ts`），
      **不是整个 `lib/services/**` 与 `app/**`**——「全绿」只证明这四个文件干净。
      更广的覆盖请手工复核：跑 `grep -rn "data/pg" lib/services app` —— 预期无输出。
      ✅ 实测：`pgConfig` 随 `pnpm test:pg` 132/132 全绿；手工复核扩到 `app/**`（`grep -rln "lib/data/pg\|data/pg/" app`）**零命中**；
      全仓读 `DATA_SOURCE` 的只有 PROD-1A 的 `favoriteRepository.ts` / `suggestionRepository.ts`（+ `pg/config.ts` 自身）。

- [x] **A3** 订单业务链的行为**零变化**（Hard Rule 2 的观察面）。
      跑 `pnpm test`（**不起服务**）。**预期：`fail 0`**。
      这一组的用例全是打 Mock 的业务规则断言；它们一个都没改。
      ✅ 实测：`pnpm test`（不带 `.env`）1999 total / 1701 pass / **0 fail** / 298 skipped（298 为需 `APP_BASE_URL` 的 HTTP 用例，见 §5.2）。

- [x] **A4** 本轮**没有**改动已执行的迁移。
      `git status --short db/migrations/` —— **预期：只列出 `0003`~`0008` 为新增（`??`），
      `0001_favorites.sql` / `0002_suggestions.sql` 不出现**。
      ✅ 实测：恰好 `?? 0003`～`?? 0008` 六行，`0001` / `0002` 不出现。

### B. 表与约束（数据库真的在管唯一性）

- [x] **B1** 迁移能从零跑通且可重复。
      在一个**测试库**上跑 `pnpm db:reset`（仅允许作用于 `_test` 库；守卫会拒绝 dev / production），
      然后 `pnpm test:pg`。**预期：132 全绿、0 skipped。**
      ⚠️ 若本地测试库跑过**旧版** `0006_settlement.sql`，迁移运行器会因 checksum 不符而报错——
      先 `pnpm db:reset` 再跑即可（见 `03-delivery.md` §6.11）。
      ✅ 实测（验收收口时重跑）：`pnpm test:pg` → **132 pass / 0 fail / 0 skipped，exit 0**。

- [x] **B2** 唯一性不是应用层假装出来的。
      `tests/pgFoundation.test.mjs` 里有「**绕过仓储直插重复行 → SQLSTATE `23505`**」的断言：
      一条是 PROD-1A 的 `favorites_user_product_key`，一条是本轮的
      `dispatch_records_order_key`（一单一派单）与 `coupon_claims_self_claim_key`
      （一人一券，**部分**唯一索引）。两条 W1 断言都用 `INSERT … SELECT` 复制一条**真实预置行**、
      只换 `id`，因此冲突只可能来自索引本身。
      **预期：全绿。** 你不需要手工跑 SQL；只要确认这些用例**没有被 skip**
      （看输出里没有 `-` 号用例）。
      ✅ 实测：`pgFoundation` 随 132/132 全绿，全局 `skipped 0`。

- [x] **B3** 金额恒等式是 DB 约束。
      看 `db/migrations/0004_orders_and_payments.sql` 里 `orders` 的
      `CHECK (actual_paid_amount = companion_base_income + club_net_income)`。
      **预期：存在。**
      ✅ 实测：`0004_orders_and_payments.sql:99` 逐字存在。
      📌 **收口勘误**：本节原文引的是同一恒等式的**移项写法**（`club_net_income = actual_paid_amount - companion_base_income`），
      与迁移里的**实际字面串**不同，照着 grep 会找不到。语义完全等价，此处改为**逐字引用**。

- [x] **B4** 闭包外的引用**没有**被硬塞 FK。
      看 `db/migrations/0004_orders_and_payments.sql`：`orders.user_id` / `product_id` / `spec_id`
      应当是**纯文本列、没有 `REFERENCES`**（用户域与目录域本轮不迁，按裁定以稳定 ID 存）。
      闭包**内**的引用（`dispatch_records.order_id` 等）**应当有** `REFERENCES`。
      **预期：两者都符合。**
      ✅ 实测：`user_id`(30) / `product_id`(47) / `spec_id`(50) 均为 `text NOT NULL` 无 `REFERENCES`；
      闭包内 `FOREIGN KEY (actual_companion_id) REFERENCES companions (id)`(119)、
      `payment_requests` 的 `order_id`/`companion_id` FK(201/203)、`payment_transactions` 的 FK(235/237) 均在。

### C. Pg 实现与并发实证（本轮的核心）

- [x] **C1** 并发抢单**恰好一人成功**。
      跑 W1 那一支：
      ```
      node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env \
           --import ./tests/alias-hook.mjs --test-concurrency=1 \
           --test "tests/pgW1Transactions.test.mjs"
      ```
      **预期：66 用例全绿、0 fail、0 skipped。**
      其中「并发」那一条断言的是**恰好 1 个成功**，且是数据库层面保证的（条件 `UPDATE` 影响行数 / 行锁），
      不是「先查状态再更新」。
      ✅ 实测：66/66 全绿。另加一组**进程外 8 并发**实证（见 Record · C 组）：8 位打手抢同一派单 → `{ok:1, not-open:7}`，
      库内接单事件 1 条、赢家与返回值一致。

- [x] **C2** 「同一个事务」是真的同一条连接。
      同一份输出里，那条用例断言事务内**全部参与者**写下的 `pg_backend_pid()`
      （`TxHandle.connectionId`）**完全相同**。**预期：全绿。**
      ⚠️ 这条刻意用 `pg_backend_pid()` 实测而不是读代码相信——见 Q1 规则 8。
      ⚠️ 也请顺手确认：**测试里没有 fake / stub 的 pg client**（跑的时候是真连 `TEST_DATABASE_URL`）。
      ✅ 实测：T2 / T3 两条「同一条连接」用例全绿（DISTINCT `backend_pid` 长度 = 1）；测试文件只 `import pg` 驱动与真库执行器，无 fake client。

- [x] **C3** 失败是**整笔**回滚。
      同一份输出里，「中途强制失败」那一条断言回滚后 **业务表与通知表逐表行数与失败前相等**。
      **预期：全绿。**
      ✅ 实测：全部「中途失败」用例全绿；另做逐表实测（见 Record · D 组），五张参与表与基线**逐一相同**。

- [x] **C4** 数据是**真的落库**了，不是活在进程里。
      同一份输出里，「`closePool()` 之后重连」那一条断言数据仍在。**预期：全绿。**
      ✅ 实测：`T2 接单结果跨连接池重建依然在` 全绿。

- [x] **C5** Mock ↔ Pg 是**逐方法**等价的。
      跑 `pnpm test:pg` 里的 `tests/pgContract.test.mjs`。**预期：22 用例全绿。**
      该文件的分区可复算：**PROD-1A 6 条 + W1 读侧 10 条 + W1 写侧 6 条 = 22**
      （`grep -c "^test("` 得 22；读侧那 10 条覆盖 **13 组仓储**，即 `W1_PAIRS` 的 13 个键）。
      读侧与写侧都是**先比方法键集合、再逐字段比对**两侧返回。
      写侧那 6 条是评审整改补的：它们**真的写一行进去再读回来**，覆盖 12 个写方法；
      没有这一组，`INSERT` 列名与取值错位这一类错会在读侧测试下完全隐身
      （见 `03-delivery.md` §4.3 的红-绿实证）。
      并且**显式留了一条「已知差异」用例**（见 D1），而不是偷偷改到两边一致。
      ✅ 实测：`grep -c "^test(" tests/pgContract.test.mjs` = **22**，随 132/132 全绿。

### D. 三处「登记不修」（确认是「登记」而不是「偷偷改了」）

- [x] **D1** `queryCompanions({availability: ""})` 两侧口径不同。
      `tests/pgContract.test.mjs` 里有一条标题为
      「已知差异：queryCompanions 传空 availability 时两侧口径不同（登记，不修）」的用例。
      **预期：存在且绿。** 它同时钉住 Mock 与 Pg 两种行为。
      ⚠️ 确认 `lib/data/companionRepository.ts` 与 `lib/data/pg/companionRepository.ts` **都没有**被改成语义一致。
      ✅ 实测：用例存在于 `tests/pgContract.test.mjs:542` 且全绿；两侧仓储未被改成一致。

- [x] **D2** `dispatch_records.accepted_via` 仍可空。
      `db/migrations/0005_dispatch_and_fulfillment.sql` 中该列**没有** `NOT NULL`。
      **预期：保持可空**（`database-schema.md` 的 TARGET 要求 NOT NULL，但改它要动存量数据，违反 Hard Rule 2）。
      已登记在 `03-delivery.md` §6.4。
      ✅ 实测：`0005_dispatch_and_fulfillment.sql:44` 为 `accepted_via text,`（可空，仅有取值域 CHECK：`IN ('companion','staff')`）。

- [x] **D3** 需求文档 §17 的漂移**只登记、没改**。
      `git status --short docs/01-requirements/` —— **预期：无输出**（该目录本轮一个字都没动）。
      漂移内容见 `03-delivery.md` §6.10 与 `02-decisions.md` Q2。
      ✅ 实测：`git status --short docs/01-requirements/` **无输出**。

### E. 文档与状态

- [x] **E1** `03-delivery.md` 的 §1/§2/§4/§5/§6/§8/§9 都是**实测内容**，没有留空模板。
- [x] **E2** §5 里贴的命令与输出是**真跑出来的**；包括那次因服务进程时钟跨过北京午夜而红的 6 条，
      以及重启服务后重跑的结果——**红的记录没有被删掉**。
- [x] **E3** `docs/03-dev/总需求进度表.md` 新增的 `PROD-1B` 行状态是
      **`⏳ AWAITING_ACCEPTANCE`**，**不是 ✅**（`development-workflow.md` §十八）。
      ✅ 实测：进度表 `PROD-1B` 行状态列仍为 `⏳ AWAITING_ACCEPTANCE`，收口时**只追加人工验收结论**，未改状态。
- [x] **E4** Round 状态是 `AWAITING_ACCEPTANCE`，**不是 `DONE`**。
      ✅ 实测：本文件 Status 与 `README.md` 的 `Status:` 均为 `AWAITING_ACCEPTANCE`。

---

## Manual Acceptance Record（2026-10-05）

用户指定按**五组**做最短人工验收，全部通过。证据来源为**当轮实测命令输出**（真连
`TEST_DATABASE_URL` = `chaoge_esports_test`），不是复述文档。

| 组 | 内容 | 结论 | 关键证据 |
|---|---|---|---|
| **A** | Runtime 未激活（不存在 half PG + half Mock） | **PASS** | `.env` / `.env.local` 无 `DATA_SOURCE`；`grep -rln "lib/data/pg\|data/pg/" app` 零命中；`grep -rn "acceptDispatchPg\|sweepExpiredDispatchesPg" lib app`（排除 `w1Transactions.ts` 自身）零命中——11 条 Pg 事务**只被测试文件引用**；订单域三个 accessor 各 0 处 `DATA_SOURCE`（只有 PROD-1A 的 favorite / suggestion 有分支） |
| **B** | T3 `sweepExpiredDispatchesPg` 的 catch-up / 幂等 / `refundedOrderIds` 不误报 / rollback | **PASS** | 7 用例全绿。「一次追平」：`deadline = AT-(cfg+30)` 时一次调用 `movedToPublic=[dsp]` 且 `refunded=[order]`，终态 `timed_out_at = 专属到点+cfg`。「重复清扫」：第二遍两个数组均空且 `writePids()=[]`（探针证明**一个字节未写**）。「已出过款」：`refunded_amount=1` 的单再扫 → `refundedOrderIds=[]`、金额不变、不发第二条通知（判据是「出过款」而非状态）。「中途失败」：`failWritesOn('notifications')` 后派单仍 `public`、订单仍 `paid`、`refunded_amount=0`。「同一条连接」：写入 pid 去重长度 = 1 |
| **C** | Accept Race（真库并发抢单） | **PASS** | 8 位打手 `Promise.all` 抢 `dsp-ord-seed-1001-01` → `{ok:1, not-open:7}`；库内接单事件 **1 条**、通知 1 条、`orders.actual_companion_id` 与 `dispatch.accepted_by_companion_id` 均为赢家 `cp-1`。机制为**数据库行锁**（`SELECT … FOR UPDATE` 先锁 `orders` 再锁 `dispatch_records`，持锁后才判状态写入），**不是 SELECT-before-INSERT**；另用两条真实连接做裸 SQL 对照：A 条件 UPDATE `rowCount=1`，B 同条件 UPDATE 500ms 未返回（被锁挡住），A 回滚后 B 才拿到结果，两边回滚后库无残留。唯一性另有 `dispatch_records_order_key` / `completion_submissions_pending_order_key` / `companion_release_records_idempotency_key` / `companion_service_events(order_id, companion_id, serving_at)` 兜底 |
| **D** | Cross-table Rollback（最复杂事务的最后一笔写入失败） | **PASS** | 选 T4 `cancelAcceptedOrderPg`（5 张参与表）。先由成功路径的 `w1_write_log` 定序：`completion_submissions → companion_release_records → orders → dispatch_records → notifications`，确认**最后一笔是 `notifications`**；`failWritesOn('notifications')` 后抛 `w1-probe: 拒绝写入 notifications`，随即逐表比对，五张参与表与基线**逐一相同**（`orders` 仍 accepted、派单仍 accepted 且 `public_pool_entered_at` 原值、完成材料仍 `pending` 且 `invalidated_at=null`、退出历史 0 条、通知 0 条）；**事务内写日志残留 0 条**——连前四笔触发探针写入的日志行也被一并回滚，证明它们与最后一笔确在同一事务。**无半写状态** |
| **E** | Deferred Boundary（`deferred != forgotten`） | **PASS** | **本轮已 Pg-ready**：T1（`pgPaymentRepository.createPaymentRequest`/`confirmPaymentRequest`）· T2 · T3 · T4 · T5 · T6 · T7 · T9 · T10 · T11 · T12 · T13——共 11 个 `w1Transactions` 入口 + T1 仓储内实现，**完整原子写集合全部落在本轮 17 张表内**。**延期 PROD-1C**：T8 `releaseOrdersForCompanion`（← `setCompanionFlags`）· T14 `approveRefund`/`rejectRefund` · T15 `startReviewRefund`；三者原因同一句并已登记 **`Pg implementation deferred because full atomic write closure crosses PROD-1B boundary`**——其原子段内必须**同时**写 `admin_audit_entries`（源码已核实：`adminRefundTransaction.ts` 三个原子区段 202/449/704 内的 `writeAudit` 位于 236/659/736，`adminCompanionTransaction.ts` 的 T8 路径同理），而该表不在本轮 17 张表内；拆开写违反 Hard Rule 1，顺手迁入违反 Q1 规则 10。三条均已写入 `03-delivery.md` §1.2 / §6.8、`README.md` ②d、`总需求进度表.md`，并写明是 **PROD-1C 的前置条件** |

**验收期间重跑的门禁（当前最终树）**：`pnpm test:pg` **132 pass / 0 fail / 0 skipped，exit 0**。

---

## User Result

**人工验收通过（2026-10-05）。**

- A Runtime：**PASS**
- B T3：**PASS**
- C Accept Race：**PASS**
- D Cross-table Rollback：**PASS**
- E Deferred Boundary：**PASS**
- Issues Found：**无 BLOCKER / 无 MAJOR**
- Final Result：**PASSED**

## Issues Found

**无 BLOCKER、无 MAJOR。**

两条 NOTE，用户**接受为非阻塞已知事项，不要求本轮返工**（不改代码）：

1. `failWritesOn` 会把标记留在测试库直到下一次 `beforeEach` 的 `resetDatabase`
   （`lib/data/pg/reset.ts:81-89` 按系统目录 TRUNCATE，连测试自建对象一起清），
   因此**测试套件自身隔离无问题**；但**进程外**手工脚本若不先清 `w1_probe_fail`，
   会撞上残留的「拒绝写入 notifications」标记（本轮验收中首次 8 并发尝试即因此失败，清掉后复现通过）。
2. 验收期间的手工实证写入过测试库业务数据（`ord-seed-1001-01`），
   已由随后重跑的 `pnpm test:pg`（`beforeEach` 重置 + 重新预置）覆盖，测试库现处干净状态。

**收口时的文档勘误（不涉及代码）**：本文件 B3 原文引用的 CHECK 字面串为移项写法，
与 `0004_orders_and_payments.sql:99` 的实际写法不同，已改为逐字引用（语义等价）。

## Rework

无需返工。

## Final Result

**PASSED**（人工验收，2026-10-05）

⚠️ **Round 状态仍为 `AWAITING_ACCEPTANCE`**。按协议 §四 / §十七，只有
① 用户明确说「人工验收通过」**且** ② 用户已自行完成 Git commit，才可转 `DONE`。
**当前只满足 ①**；`Git Commit` 待用户提交后填写。Claude 未执行任何 Git 写操作，也不会自行标记 `DONE`。

## Git Commit

（待用户提交后填写）

---

## ⚠️ 附：DONE 的双重门槛（协议 §四 / §十七）

```
① 用户明确说「人工验收通过」
② 用户已自行完成 Git commit（提供 hash 或明确表示提交完成）
```

**两个条件同时满足**才可以把状态改为 `DONE` 并记录 `Git Commit`。
缺任何一个，Round 都停在 `AWAITING_ACCEPTANCE`。
**Claude 不执行任何 Git 写操作，也无权自行标记 `DONE`。**
