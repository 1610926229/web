# Acceptance

Round: PROD-1D
Status: **`AWAITING_ACCEPTANCE`**

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`lint` / `typecheck` / `build` / `pnpm test` / `pnpm test:pg` /
> 生产 `APP_BASE_URL` 全流程）已在 `03-delivery.md` §5 记录为**实测结果**，此处不重复。
> 这里只列**自动化测不到、或测了也需要人看一眼才敢信**的部分。
>
> ⚠️ 收口规则（`development-workflow.md` §十七）：`DONE` 需要**双门槛**——
> ① 产品负责人明确说「人工验收通过」；② 产品负责人**本人**完成 Git 提交。
> 本轮 Claude **未执行任何 Git 写操作**，交付时点因此只能是 `AWAITING_ACCEPTANCE`。

---

## 〇、验收前你需要知道的一件事

**本轮不切数据源。** 按指令 Phase 11「不激活 `DATA_SOURCE=postgres`」，
开关保持**不设置**，应用的真实业务路径仍然 **100% Mock**。

**所以你打开页面看，不会看到任何变化** —— 下单支付、退款审核、投诉处理、券模板增改，
行为与本轮之前**逐字相同**。**这不是漏做**，是本轮的裁定结果本身：
PROD-1D 交付的是 **T1 券核销闭包的 PostgreSQL 化 + 三组后台写闭包的 Pg 实现 + 实证**，不是切换。

本轮能验收的是**四样实打实的东西**：

1. **一条被消除的缝** —— Pg 建单不再把券核销写进 Mock（半迁移的**结构性**入口没了）；
2. **一个数据库级的互斥** —— 券的并发唯一性由写入语句上的 `AND status = 'unused'` 保证，
   不是「先读再判」；
3. **四组「业务写 + 审计」同生共死** —— 审计那一句 `INSERT` 故意失败，前面的业务写入**一条不留**；
4. **确定性并发实证** —— 四条红-绿证明，每条都能**亲自复做**。

**为什么不能现在就切**：`admin_audit_entries` 的 33 处写者里还有 **24 处**没迁完
（本轮后 9 / 33，见 `03-delivery.md` §6.3）。此时扳开关会踩中 Hard Rule 1（半 Pg 事务）。
激活门槛见 `03-delivery.md` §6.4 的 Q4。

---

## Manual Acceptance Checklist

> 建议分 **A 未激活 · B T1 券核销闭包（本轮核心）· C 三组后台写闭包 · D 并发红-绿 · E 迁移纪律 · F 文档** 六组。

### A. 先确认「没有激活」这件事是真的

- [ ] **A1** 应用没有打开 Pg 开关。跑 `grep -oE '^[A-Z_]+=' .env` ——
      **预期：只列出变量名，其中没有 `DATA_SOURCE=`**。
- [ ] **A2** 数据源仍是无条件 Mock。跑 `grep -n "getDataSource" -A 6 lib/data/source.ts` ——
      **预期：函数体里没有任何 `process.env` / 环境变量读取，无条件返回 `mockDataSource`**。
- [ ] **A3** 服务端调用链上没有一处指向本轮新写的 Pg 事务。
      跑 `grep -rn "lib/data/pg" app lib/services --include=*.ts --include=*.tsx` —— **预期：无输出**。
- [ ] **A4** 本轮新增的 Pg 入口只被测试引用。跑
      `grep -rn "confirmPaymentRequestPg\|applyAdminComplaintIntentPg\|updatePlatformConfigPg\|CouponTemplateEnabledPg\|CouponTemplatePg" lib app --include=*.ts`
      —— **预期：只有 `lib/data/pg/**` 的定义处，`lib/services` / `app` 无命中**。
- [ ] **A5** 业务链行为**零变化**。跑 `pnpm test`（不起服务）——**预期 `fail 0`**。
      ⚠️ 未设 `APP_BASE_URL` 时 HTTP 用例会 skip，这是正常跳过条件，不是本轮交付状态。

### B. T1 券核销闭包（**本轮最重要的一组**）

- [ ] **B1** 跑定向用例：
      `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env --import ./tests/alias-hook.mjs --test-concurrency=1 --test tests/pgCheckoutTransactions.test.mjs`
      —— **预期 `tests 17 / pass 17 / fail 0 / skipped 0`**。
- [ ] **B2** 确认副作用**真的**进了同一个事务（这是本轮存在的理由）。
      打开 `lib/data/pg/paymentRepository.ts`，找到 `confirmPaymentRequestPg`，读它的 `withTransaction` 闭包体：
      **要确认的是**「认领请求 → `redeemCouponClaimForOrderTx`（核销券）→ `insertOrder` →
      `insertDispatchForOrderTx`（派单）」**全在同一个 `(tx)` 闭包内**，且**没有一处**调用 Mock。
- [ ] **B3** 确认服务层不再承担写入。跑
      `grep -n "redeemCouponClaimForOrder\|createDispatchForOrder" lib/services/checkout.ts`
      —— **预期：无输出**（`buildOrderFromRequest` 已变纯函数，D1）。反过来，Mock 侧的副作用集中在
      `lib/data/checkoutCommitTransaction.ts`，且只被 `lib/data/mockPaymentRepository.ts` 调用。
- [ ] **B4** 确认探针盯上了两张新表：
      `grep -n "coupon_claims\|dispatch_records" tests/pgW1Transactions.test.mjs`
      —— **预期：出现在 `PROBED_TABLES` 里**（否则「核销之后失败会不会回滚」无法证伪，D7）。
- [ ] **B5** 读 `tests/pgCheckoutTransactions.test.mjs` 里标题以 **「回滚 ·」** 开头的用例。
      **要确认的是**：核销券**之后**让派单/支付写入失败，断言
      「`payment_requests` 仍 `pending`、`orders` / `payments` / `dispatch_records` 清零、
      **券回到 `unused`**」——**全部**回滚，不是只回滚一部分。

### C. 三组后台写闭包（业务写 + 审计同生共死）

- [ ] **C1** 三块各跑一次，**预期全绿**：

  | 命令（`--test` 换成对应文件） | 预期 |
  |---|---|
  | `tests/pgPlatformConfigTransactions.test.mjs` | `tests 11 / pass 11 / fail 0 / skipped 0` |
  | `tests/pgComplaintTransactions.test.mjs` | `tests 20 / pass 20 / fail 0 / skipped 0` |
  | `tests/pgCouponTemplateTransactions.test.mjs` | `tests 19 / pass 19 / fail 0 / skipped 0` |

- [ ] **C2** 三个文件里各读一条标题以 **「回滚 ·」** 开头的用例。**要确认的是**：
  审计 `INSERT` 被探针打失败后，业务写入（平台参数 4 字段 / 投诉状态与处理字段 / 券模板行）
  **回到原样**，且审计 0 行。**这是「审计与业务同生共死」的唯一保护网。**
- [ ] **C3** 确认审计走的是**事务内**写入、不是 commit 后补写。跑
      `grep -rn "appendAuditEntryTx\|writeAudit(" lib/data/pg/` —— **预期：Pg 侧只有
      `appendAuditEntryTx`，没有一处调用 Mock 的 `writeAudit`**（出现即半迁移）。
- [ ] **C4** 确认「共享而非复制」：跑
      `grep -n "PATCHABLE_FIELDS\|INTENT_TO_STATUS\|auditActionOf" lib/data/pg/platformConfigTransactions.ts lib/data/pg/complaintTransactions.ts`
      —— **预期：均为 `import … from "../adminPlatformConfigTransaction"` / `"../adminComplaintTransaction"`**，
      而不是在这里重新定义一份。
- [ ] **C5** 确认投诉写者与订单读者读**同一个 Pg 真值**。读
      `tests/pgComplaintTransactions.test.mjs` 标题含 **「跨域」** 的用例——
      **要确认的是**它走的是**真实公开入口**（订单侧的阻塞读者），不是自己写 SQL 模拟读者口径。

### D. 并发红-绿（**你可以亲自复做**）

- [ ] **D1** 券双花 → 同券并发用例**有判别力**。读
      `tests/pgCheckoutTransactions.test.mjs` 标题含 **「同券并发」** 的用例，确认它同时做了
      `warmPool(2)` **和**在 `coupon_claims` 上挂了 `pg_sleep` 触发器（裸 `Promise.all` 跑冷池
      会**假绿**——本轮实测踩到过，说明写在用例上方）。
      **复做**：把 `lib/data/pg/w1Transactions.ts` 里核销语句的 `AND status = 'unused'` **删掉**，
      重跑 §B1 —— **预期变红 `恰好一个赢家（两个都成功 = 双花）2 !== 1`**；还原后复绿。
- [ ] **D2** 投诉行锁 → 三条并发用例**有判别力**。读
      `tests/pgComplaintTransactions.test.mjs` 的 `withWideLockWindow()` 与三条「并发 ·」用例。
      **复做**：把 `lib/data/pg/complaintRepository.ts` 的 `lockComplaintTx` 里 `FOR UPDATE` **删掉**，
      重跑 §C1 第二行 —— **预期三条并发用例全红 `★ 恰好一个真正迁移了状态 2 !== 1`**；还原后复绿。
      （这三条用例最初只做了预热、判别力偏弱，是本轮 reviewer 的 NOTE 1，**已修**。）
- [ ] **D3** 承认一件事：`Promise.all` 在 Node 单线程里**确实是真并发**
      （每个 `await` 都是一个让出点）。若要更强证据，可把四条并发用例各跑 3 遍看是否稳定。

### E. 迁移纪律

- [ ] **E1** `ls db/migrations/` —— **预期 `0001` … `0009`**，编号连续、无重复、**无本轮新增**。
- [ ] **E2** 旧迁移一个字节没改：`git status --short db/` —— **预期：无输出**。
- [ ] **E3** 本轮撑窗用的 `pg_sleep` 触发器**不是** schema 的一部分：
      `grep -rn "sleep_probe\|sleep_trg" db/` —— **预期：无输出**（它只存在于 `tests/*.mjs` 内）。

### F. 文档

- [ ] **F1** 本目录五个文件齐全：`01-prompt.md` · `02-decisions.md` · `03-delivery.md` · `04-acceptance.md` · `README.md`。
- [ ] **F2** `03-delivery.md` §6.3 的 **33 处 `writeAudit` / 10 文件**登记表与代码一致
      （可跑 `grep -rc "writeAudit(" lib/data/*.ts | grep -v ":0"` 抽查）。
- [ ] **F3** `03-delivery.md` §6.4 的 6 问若与产品负责人手里的清单不同，**请指出**——
      该节已显式声明这是按本仓门槛重建的。
- [ ] **F4** 读 `03-delivery.md` §7 的 reviewer 结论（`0 BLOCKER / 0 MAJOR / 0 MINOR / 2 NOTE`）
      与两条 NOTE 的处置：**NOTE 1 已修**，**NOTE 2（函数级循环依赖）有意保留**。
      **要确认的是**你接受 NOTE 2 作为「已知项、激活前再评估」，而不是现在就要修。
      若你要求现在修，请明说（它需要把 `createDispatchForOrder` 抽到叶子模块，属范围外重构）。

---

## Manual Acceptance Record

> ⚠️ 本节按协议由**产品负责人验收后填写**，Claude **不得自行填写**。
> 需满足双门槛：① 你明确说「人工验收通过」；② 你**本人**完成 Git 提交。
> 届时状态才由 `AWAITING_ACCEPTANCE` 推进为 `DONE`。

（待产品负责人填写）
