# Acceptance

Round: PROD-1C
Status: **`DONE`**（人工验收 2026-10-10 通过 + 用户本人 Git 提交 `a6d5ed7` 双门槛满足；
交付时点曾为 `AWAITING_ACCEPTANCE`，收口依据见文末《Manual Acceptance Record（2026-10-10）》）

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`lint` / `typecheck` / `build` / `pnpm test` / `pnpm test:pg`）
> 已在 `03-delivery.md` §4 记录为**实测结果**，此处不重复。这里只列
> **自动化测不到、或测了也需要人看一眼才敢信**的部分。
>
> ⚠️ 收口规则（`development-workflow.md` §十七）：`DONE` 需要**双门槛**——
> ① 产品负责人明确说「人工验收通过」；② 产品负责人**本人**完成 Git 提交。
> 本轮 Claude **未执行任何 Git 写操作**；交付时点因此只能是 `AWAITING_ACCEPTANCE`，
> 两个门槛于 2026-10-10 由产品负责人本人满足（见文末《Manual Acceptance Record（2026-10-10）》）。

---

## 〇、验收前你需要知道的一件事

**本轮不切数据源。** 按指令的 Phase 11「本轮不要自行切」，
`DATA_SOURCE` 保持**不设置**，应用的真实业务路径仍然 **100% Mock**。

**所以你打开页面看，不会看到任何变化** —— 退款审核、护航停用的行为与本轮之前**逐字相同**。
**这不是漏做**，这是本轮的裁定结果本身（PROD-1C 交付的是
**AdminAudit 的 PostgreSQL 持久化 + 三个延期事务的 Pg 实现 + 实证**，不是切换）。

本轮能验收的是**四样实打实的东西**：

1. **一张表** —— `admin_audit_entries` 真的建出来了，`operation_id` 的唯一约束
   就是幂等的落点，是**数据库**在管；
2. **三个 Pg 事务** —— T8 / T14 / T15，接口与 Mock 逐字段一致（不是 placeholder）；
3. **并发实证** —— 打真库的测试证明「两个管理员同时批同一笔退款，只出一次款」；
4. **回滚实证（本轮的核心）** —— 让**审计那一句 `INSERT` 故意失败**，
   断言它前面的**全部业务写入一条都没留下**。

**为什么不能现在就切**：`admin_audit_entries` 的 33 处写者里还有 **29 处**没迁完
（见 `03-delivery.md` §2）。此时扳开关会踩中 Hard Rule 1（半 Pg 事务）。
激活门槛见 `03-delivery.md` §3 的 Q4。

---

## Manual Acceptance Checklist

> 建议分 **A 未激活 · B 审计与业务的同生共死 · C 并发 · D 迁移纪律 · E 文档** 五组。

### A. 先确认「没有激活」这件事是真的

- [ ] **A1** 应用没有打开 Pg 开关。
      跑 `grep -n "DATA_SOURCE" .env` —— **预期：没有任何输出**。
      ✅ 已自查：`.env` 里只有 `DATABASE_URL`（dev 库）与 `TEST_DATABASE_URL`（test 库）。
- [ ] **A2** 审计仓储仍然返回 Mock。
      跑 `grep -n "return mockAdminAuditRepository" lib/data/adminAuditRepository.ts` —— **预期：有且仅有一行**。
- [ ] **A3** 服务端调用链上没有一处指向本轮新写的 Pg 事务。
      跑 `grep -rn "adminAuditTransactions" app lib/services lib/data --include=*.ts | grep -v "lib/data/pg/"` —— **预期：无输出**。
- [ ] **A4** 业务链行为**零变化**。跑 `pnpm test`（不起服务）——**预期 `fail 0`**。
      ⚠️ 不起服务时需 `APP_BASE_URL` 的 HTTP 用例会 skip，这是正常跳过条件，不是本轮交付状态。
- [ ] **A5** 页面行为与上一轮一致。
      起 `pnpm dev`，走一遍「管理员审核一笔退款（通过）」与「停用一位护航」——
      **预期：与 PROD-1B 之后一模一样**。

### B. 审计与业务的同生共死（**本轮最重要的一组**）

- [ ] **B1** 跑定向用例：
      `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env --import ./tests/alias-hook.mjs --test-concurrency=1 --test tests/pgAdminAuditTransactions.test.mjs`
      —— **预期 `tests 37 / pass 37 / fail 0 / skipped 0`**。
- [ ] **B2** 打开 `tests/pgAdminAuditTransactions.test.mjs`，找到标题以 **「回滚 ·」** 开头的 **5 条**用例，
      读它们的断言。**要确认的是**：这些断言在「实现其实没有用事务」时会**失败**。
      （最有力的证据是 `assert.rejects(..., /w1-probe/)` 后面那一串业务断言。）
- [ ] **B3** 确认探针真的盯上了审计表：
      跑 `grep -n "admin_audit_entries" tests/pgW1Transactions.test.mjs` —— **预期：出现在 `PROBED_TABLES` 里**，
      且旁边有解释「不盯上它，『审计写不进去时业务写入是否回滚』这句话无法证伪」。
- [ ] **B4** 确认 Pg 侧没有偷偷用第二条连接：
      跑 `grep -n "getPgExecutor()" lib/data/pg/adminAuditTransactions.ts` —— **预期：恰好 4 处**，
      每处都是 `return getPgExecutor().withTransaction(async (tx) => {` 的入口形式。

### C. 并发

- [ ] **C1** 跑 `pnpm test:pg` —— **预期 `tests 170 / pass 170 / fail 0 / skipped 0`**。
- [ ] **C2** 承认一件事：`Promise.all` 在 Node 单线程里**确实是真并发**
      （每个 `await` 都是一个让出点，两个请求会真的交错在校验与写入之间）。
      若要更强的证据，可把 7 条「并发 ·」用例各跑 3 遍，看是否稳定。
- [ ] **C3**（**最重要的一条**）确认并发用例里有一组**同键**用例——
      两个请求带**相同** `operationId` 打同一笔退款，断言
      「恰好一个真正出款、恰好一个自认重放，钱只动一次」。
      **这是本轮核心设计（两读判定，D1）的唯一保护网**，
      独立复审的 MAJOR 就是「原来没有它」。
      **它已被红-绿证明可以失败**：把加锁后的权威读改成 `const replay = null as null;`，
      §B1 的命令会报 `★ 恰好一个自认重放 0 !== 1`（T8）与
      `第二个必须正常返回（重放），实际 invalid-transition`（T14）。
      证据见 `03-delivery.md` §4.5.1。**你可以亲自重做这个红-绿。**

### D. 迁移纪律

- [ ] **D1** `db/migrations/` 编号连续、无重复：`ls db/migrations/` —— **预期 `0001` … `0009`**。
- [ ] **D2** 旧迁移一个字节没改：`git diff --stat db/migrations/` —— **预期：只显示 `0009` 为未跟踪（`??`），`0001`–`0008` 无改动**。
- [ ] **D3** 安全守卫未被弱化：`pnpm test:pg` 里 `pgConfig` **17/17 全绿**（生产拒绝 seed/reset、非 `_test` 库拒绝 reset）。

### E. 文档

- [ ] **E1** 本目录五个文件齐全：`01-prompt.md` · `02-decisions.md` · `03-delivery.md` · `04-acceptance.md` · `README.md`。
- [ ] **E2** `03-delivery.md` §2 的 **33 处 `writeAudit` / 10 个文件**登记表与代码一致
      （可跑 `grep -rc "await writeAudit(" lib/data/*.ts` 抽查）。
- [ ] **E3** `03-delivery.md` §3 的 6 问若与产品负责人手里的清单不同，**请指出**——
      该节已显式声明这是按本仓门槛重建的。
- [ ] **E4** `03-delivery.md` §7 的独立复审结论（首轮 `0 BLOCKER / 1 MAJOR / 1 MINOR / 2 NOTE` →
      整改后回执 `0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE`）与
      §6 的两条 NOTE 登记读一遍。**要确认的是**：两条 NOTE 你接受作为「已知分歧、激活前再评估」，
      而不是现在就要修。若你要求现在修 NOTE 1，请明说（它需要 SAVEPOINT，风险面见 §6 第 5 条）。

---

## Manual Acceptance Record（2026-10-10）

> 本节原定的规则是「待产品负责人验收后填写，Claude 不得自行填写」。2026-10-10 产品负责人
> 明确裁定 **`PROD-1C Manual Acceptance = PASSED`**、并**授权 Claude 回填本节**，故此处由 Claude 代笔，
> 内容全部来自**当轮在真库（`TEST_DATABASE_URL` = `chaoge_esports_test`）实跑的命令输出**，不是复述文档。

产品负责人指定按**四组**做最短人工验收，四组全部通过。

| 组 | 内容 | 结论 | 关键证据 |
|---|---|---|---|
| **A** | AdminAudit Atomicity（审计写失败 ⇒ 业务改动全部回滚） | **PASS** | 定向套件 `tests/pgAdminAuditTransactions.test.mjs` 真库 **37 / pass 37 / fail 0 / skipped 0**；4 个 `getPgExecutor().withTransaction(async (tx) => {` 入口（`:466 / :557 / :686 / :948`），无第二条连接；幂等落点是**数据库**约束 `0009` 的 `CONSTRAINT admin_audit_entries_operation_key UNIQUE (operation_id)`（`:88`）。**红-绿（亲自复做）**：摘掉 `lib/data/pg/executor.ts` 的 `BEGIN` → 5 条回滚用例**挂 4 条**，报错逐字符合预期（`★ 标志位回滚 actual: false, expected: true`、`★ 退款状态回滚 actual: 'approved', expected: 'pending'` ×2、`★ 状态回滚 actual: 'reviewing', expected: 'pending'`）；还原后 `sha256sum -c` 逐字节 OK |
| **B** | T14 Concurrency（两个管理员同时批同一笔退款） | **PASS** | 「同时通过」（`:822`）：恰好 1 个 `ok` / 1 个 `invalid-transition`；`refunded_amount` 只等于实付一次；`earning_adjustments` 1 条；`admin_audit_entries` 1 条；`reversed_amount` 只冲一次。「通过 vs 拒绝」（`:857`）：恰好 1 个赢、审计 1 条，且**两个分支都断言**——批了则 `order.status='refunded'` 且退足实付，驳回则订单状态与金额原样不动 ⇒ **无混合终态**。**红-绿（亲自复做，即本文档 §C3 预告的那一条）**：把锁后权威读 `takeReplayTx` 改成 `const entry = null as null;` → **3 条同键并发用例全挂**，报错为 `★ 恰好一个自认重放 0 !== 1`（T8）与 `第二个必须正常返回（重放），实际 invalid-transition`（T14）及 T15 同款；还原后 `sha256sum -c` 逐字节 OK |
| **C** | T8 Companion Release（停用护航的解除与状态清理） | **PASS** | 本轮 T8 用例（`:331` 起）断言：订单 → `paid`、`actual_companion_id` → `null`、`ever_accepted_at` **保留非空**、`serving_at` → `null`、`accepted_at` → `null`；派单回 `public` 且 `accepted_by_companion_id` → `null`；`companion_release_records` 恰 1 条、`source='companion_disabled'`、`actor_id='admin-1'`；1 条 `dispatch` 通知；1 条 `companion.disable` 审计；**已完成 / 已退款订单保留履约人**不受牵连。待审完成材料随解除作废：`:900` 用例断言 `completion_submissions.status='invalidated'` 且完成审核返回 `invalid-status`。重放不重复：`:1028` 同键 + `:815` `again.replayed===true`、审计仍 1 条、`writePids()` 为空 |
| **D** | Runtime Boundary（未激活 / 无半 Pg 半 Mock） | **PASS** | `.env` / `.env.local` **无 `DATA_SOURCE`**（仅 `.env.example` 有文档化的空值行），且**无任何代码写入该变量**；`isPostgresDataSourceEnabled()` 恰好 2 个消费者（`favoriteRepository.ts:73`、`suggestionRepository.ts:66`），其余 **26 个 accessor 硬返回 Mock**；`getAdminAuditRepository()` → `mockAdminAuditRepository`（全仓仅一行）；运行时 `writeAudit → appendAuditEntry → adminAuditStore()`（Mock），Pg 侧只复用纯函数 `buildAuditEntry` + `INSERT`、**只有测试引用**；`app/**` 与 `lib/services/**` **零** import `lib/data/pg/**`；5 个 `pg*.test.mjs` 全部 `TEST_DATABASE_URL` 门控，普通 `pnpm test` 下不贡献断言 |

**与本文档上方《Manual Acceptance Checklist》五组的对应关系**（两组编号不同，不是遗漏）：
A → 清单 **B**（同生共死）+ 清单 **A1–A4**（未激活）· B → 清单 **C**（并发）·
C → 清单 **B**（同生共死，T8 侧）+ 清单 **D**（迁移纪律）· D → 清单 **A**（未激活）+ 清单 **D**（迁移纪律）。
清单 **E**（文档）由本次收口时的文件清点覆盖：本目录 `01-prompt.md` · `02-decisions.md` · `03-delivery.md` ·
`04-acceptance.md` · `README.md` **五个文件齐全**。

### 收口核验（无残留）

临时用于红-绿的两处改动（`lib/data/pg/executor.ts`、`lib/data/pg/adminAuditTransactions.ts`）均已从备份还原，
`sha256sum -c` 与基线逐字节一致；还原后定向套件重跑 **37 / pass 37 / fail 0 / skipped 0**；
`git status --short` 与会话开始时逐行一致 ⇒ **本次验收对业务代码零改动、零残留**。

---

## User Result

**人工验收通过（2026-10-10）。**

- A AdminAudit Atomicity：**PASS**
- B T14 Concurrency：**PASS**
- C T8 Companion Release：**PASS**
- D Runtime Boundary：**PASS**
- Issues Found：**无 BLOCKER / 无 MAJOR**（1 MINOR + 2 NOTE，均为非阻塞，见下）
- Final Result：**PASSED**

## Issues Found

**无 BLOCKER、无 MAJOR。** 以下三条均为**非阻塞**、**本轮不返工**（不改代码）：

1. **MINOR（测试强度）** — `回滚 · T8 退出历史写不进去` 在「摘掉 `BEGIN`」这一变异下**不具区分度**：
   该用例要证伪的那次写失败（`companion_release_records`）排在标志位写**之前**，此刻尚无已提交内容可回滚，
   去掉事务它照样绿。5 条回滚探针里只有 4 条真正具备判别力。**建议**在激活前给该用例补一条
   排在失败写**之前**的已提交写入。
2. **NOTE** — `accepted_via` **未在本轮 T8 用例里复断言**。代码确实清它（`lib/data/pg/w1Transactions.ts:1497`，
   与 `accepted_by_companion_id` 同批置 NULL），且该路径由 `tests/pgW1Transactions.test.mjs`
   （`:1418 / :1694 / :1823 / :1979`）证明——属**证据链复用**，不是缺口。
3. **NOTE** — T14 并发用例未直接断言**通知条数**；「不重复通知」由「输的一方返回 `invalid-transition`、
   根本没进写路径」间接推出。单飞行路径的通知在 `:625` 有直断。

**另（非本轮范围、已知 P0）**：T1 券核销闭包缺口**依然存在**（Pg `confirmPaymentRequest` 无 `coupon_claims` 写、
核销仍落 Mock），已在 `rounds/AUDIT-PG-1/README.md` §十 10.1 登记并并入暂定 `PROD-1D`。本轮未触碰。

**独立复审**（`reviewer-agent`，只读）：首轮 `0 BLOCKER / 1 MAJOR / 1 MINOR / 2 NOTE` → 整改后回执确认
`0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE`；两条 NOTE 经产品负责人确认**接受为非阻塞已知项、不要求返工**。

## Rework

无需返工。

## Final Result

**PASSED**（人工验收，2026-10-10）· **Round Status = `DONE`**

按协议 §四 / §十七的**双门槛**：

| 门槛 | 状态 | 依据 |
|---|---|---|
| ① 产品负责人明确说「人工验收通过」 | ✅ 满足 | 2026-10-10 产品负责人裁定 `PROD-1C Manual Acceptance = PASSED`，A–D 四组全 PASS，Issues Found 无 BLOCKER / 无 MAJOR |
| ② 产品负责人本人完成 Git commit | ✅ 满足 | `a6d5ed7de058837e08d5c6d2b1c66091ba16615a`（`PROD-1C AdminAudit closure and deferred`，2026-10-10 22:39:58 +0800） |

**两个条件同时满足 → 状态由 `AWAITING_ACCEPTANCE` 推进为 `DONE`。**
Claude **未执行任何 Git 写操作**；commit 由产品负责人本人完成，hash 取自仓库实际提交记录（只读 `git show` 核验）。

## Git Commit

`a6d5ed7de058837e08d5c6d2b1c66091ba16615a`（short `a6d5ed7`）
`PROD-1C AdminAudit closure and deferred` — 2026-10-10 22:39:58 +0800

只读核验：`git show --name-status a6d5ed7` 确认该提交含本轮全部交付物
（`db/migrations/0009_admin_audit_entries.sql` · `lib/data/pg/adminAuditRepository.ts` ·
`lib/data/pg/adminAuditTransactions.ts` · `tests/pgAdminAuditTransactions.test.mjs` ·
`docs/03-dev/rounds/PROD-1C/` 五文件 · `docs/03-dev/rounds/AUDIT-PG-1/README.md` 及本轮修改的
`lib/constants/**` / `lib/data/**` / `tests/**`），提交时工作区已干净。

---

## ⚠️ 附：DONE 的双重门槛（协议 §四 / §十七）

```
① 产品负责人明确说「人工验收通过」
② 产品负责人本人完成 Git commit（提供 hash 或明确表示提交完成）
```

**两个条件同时满足**才可以把状态改为 `DONE` 并记录 `Git Commit`；
缺任何一个，Round 都停在 `AWAITING_ACCEPTANCE`。
**Claude 不执行任何 Git 写操作，也无权自行标记 `DONE`。**
