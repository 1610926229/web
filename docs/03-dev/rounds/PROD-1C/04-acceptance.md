# Acceptance

Round: PROD-1C
Status: **`AWAITING_ACCEPTANCE`**（尚未人工验收；Claude 不得自行置 `DONE`）

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`lint` / `typecheck` / `build` / `pnpm test` / `pnpm test:pg`）
> 已在 `03-delivery.md` §4 记录为**实测结果**，此处不重复。这里只列
> **自动化测不到、或测了也需要人看一眼才敢信**的部分。
>
> ⚠️ 收口规则（`development-workflow.md` §十七）：`DONE` 需要**双门槛**——
> ① 产品负责人明确说「人工验收通过」；② 产品负责人**本人**完成 Git 提交。
> 本轮 Claude **未执行任何 Git 写操作**，因此当前只能是 `AWAITING_ACCEPTANCE`。

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

## Manual Acceptance Record

> 待产品负责人验收后填写。Claude **不得**自行填写本节。

| 项 | 结果 | 备注 |
|---|---|---|
| A 未激活 | ⏳ 待验收 | |
| B 同生共死 | ⏳ 待验收 | |
| C 并发 | ⏳ 待验收 | |
| D 迁移纪律 | ⏳ 待验收 | |
| E 文档 | ⏳ 待验收 | |
| **Issues Found** | ⏳ | BLOCKER / MAJOR / MINOR 待记录 |
| **User Result** | ⏳ | PASSED / FAILED |
| **Accepted At** | ⏳ | |

**双门槛**：① 产品负责人明确说「人工验收通过」；② 产品负责人本人完成 Git 提交。
两者都满足后，状态才由 `AWAITING_ACCEPTANCE` 推进为 `DONE`。
