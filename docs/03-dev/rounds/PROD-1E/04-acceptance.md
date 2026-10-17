# Acceptance

Round: PROD-1E
Status: **`AWAITING_ACCEPTANCE`**

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`typecheck` / `lint` / `build` / `pnpm test` /
> `pnpm test:pg` / 生产全量）已在 `03-delivery.md` §3 记录为**实测结果**，此处不重复。
> 这里只列**自动化测不到、或测了也需要人看一眼才敢信**的部分。
>
> ⚠️ 收口规则（`development-workflow.md` §十七）：`DONE` 需要**双门槛**——
> ① 产品负责人明确说「人工验收通过」；② 产品负责人**本人**完成 Git 提交。
> 本轮 Claude **未执行任何 Git 写操作**，交付时点因此只能是 `AWAITING_ACCEPTANCE`。

---

## 〇、验收前你需要知道的一件事

**本轮与 PROD-1D 有一个根本差别：本轮交付的是「可以扳动的开关」，而不是「另一套代码」。**

- **默认**（`DATA_SOURCE` 不设置）：应用 100% Mock，打开页面**看不到任何变化**。
- **扳上去**（`DATA_SOURCE=postgres`）：核心业务**真的**跑在 PostgreSQL 上，缺任何一块实现就**拒绝启动**。

因此本轮的人工验收分成两类：

1. **数字类**（A / B / C）——`grep` 几下就能自己数出来，不需要跑起来；
2. **行为类**（D / E / F）——**真的把开关扳起来**跑一遍，去数据库里看行。

**建议顺序：A（确认默认没变）→ B/C（收口数字）→ D（扳开关跑真业务）→ E（fail-fast）→ F（回归）。**

---

## Manual Acceptance Checklist

### A. 先确认「默认仍然是 Mock」这件事是真的

- [ ] **A1** 环境里**没有** `DATA_SOURCE`。跑 `grep -oE '^[A-Z_]+=' .env .env.local | sort -u` ——
      **预期：只列出变量名，其中没有 `DATA_SOURCE`**（只有 `DATABASE_URL` / `TEST_DATABASE_URL` /
      若干 `ENABLE_MOCK_*`）。
- [ ] **A2** 判据是**调用时**读的，不是模块常量。跑
      `grep -n "DATA_SOURCE" lib/data/pg/config.ts` ——
      **预期：出现在 `isPostgresDataSourceEnabled()` 的函数体里，而不是文件顶层的 `const`。**
- [ ] **A3** 默认路径不碰 Pg。不起服务跑 `pnpm test` —— **预期 `fail 0`**（`03-delivery.md` §3.2）。

### B. 迁移纪律

- [ ] **B1** `0001`–`0009` **一字未动**。跑 `git status --short db/` ——
      **预期：只有 7 行 `?? db/migrations/00{10..16}_*.sql`，没有任何 `M`。**
- [ ] **B2** 迁移是**追加**的。跑 `ls db/migrations/` —— **预期 16 个文件，`0001`…`0016` 连续。**
- [ ] **B3** 测试库能迁到最新。跑 `pnpm db:migrate --target=test` 然后
      `pnpm db:health --target=test` —— **预期：报告 16 个版本已应用、库存活。**
      （`migrate` 幂等，可以反复跑。）

### C. 收口数字（**本轮的四条硬指标**）

- [ ] **C1 仓储 28/28**。跑 `grep -c "pickRepository(" lib/data/*Repository.ts | grep -v ":0"` ——
      **预期：28 个文件各 1 处**（`grep -c` 输出 28 行）。再跑
      `grep -n "CORE_REPOSITORY_COUNT = " lib/data/datasource.ts` —— **预期 `= 28`。**
- [ ] **C2 每个仓储都有 Pg 半边**。跑 `pnpm test:pg -- --test-name-pattern "核心仓储"`（见 D2 的跑法）——
      **预期：`每个核心仓储都有 Pg 实现（backing.pg !== null）` 通过。**
- [ ] **C3 Mock-only AdminAudit writer = 0**。跑
      `grep -rc "writeAudit(" lib/data/*Transaction.ts | grep -v ":0"` ——
      **预期：33 处（Mock 半边，**应当保留**，它是语义基线）。** 再跑
      `grep -rn "appendAuditEntryTx(" lib/data/pg/*.ts | grep -v "adminAuditRepository.ts" | wc -l` ——
      **预期 `33`**（Pg 半边，定义处那 1 行不算）。**两侧相等 ⇒ 没有只写 Mock 的审计写入者。**
- [ ] **C4 门面 53 个**。跑
      `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs --test tests/pgRoutingGates.test.mjs` ——
      **预期：4 条 + helper 正例全部通过**（(A) 会自己报出门面总数）。

### D. 把开关扳起来：让应用**真的**跑在 PostgreSQL 上 ⭐

> 这一段是 PROD-1D 做不到的——上一轮「打开页面看不到任何变化」，
> **本轮你能看到行真的写进了 PostgreSQL。**

- [ ] **D1 准备一个可用状态**（测试库是一次性的，随便点）：
      ```bash
      pnpm db:migrate --target=test
      pnpm db:reset   --target=test     # 可选：从干净状态开始
      pnpm db:seed    --target=test
      ```
      ⚠️ 打印脚本**不会**回显连接串。
- [ ] **D2 以 `postgres` 数据源启动**（**不打印**任何变量值）：
      ```bash
      set -a; . ./.env; set +a
      DATA_SOURCE=postgres DATABASE_URL="$TEST_DATABASE_URL" pnpm start -- -p 3000
      ```
      **预期：启动日志里出现一行**
      `[datasource] 启动自检通过：全部核心仓储都有 Pg 实现（DATA_SOURCE=postgres）`，
      并且它出现在**任何请求之前**。
- [ ] **D3 打一批真实业务动作**：浏览器 <http://localhost:3000> 走一遍
      「下单 → 支付 → 接单 → 开始服务 → 提交完成材料」，客服端审核通过。
- [ ] **D4 去数据库里看行**（这才是「真的跑在 Pg 上」的证据）：
      ```bash
      set -a; . ./.env; set +a
      psql "$TEST_DATABASE_URL" -c "select id, status, original_amount, actual_paid_amount, actual_companion_id from orders order by created_at desc limit 5"
      psql "$TEST_DATABASE_URL" -c "select id, status, actual_paid_amount from orders where actual_companion_id is not null"
      psql "$TEST_DATABASE_URL" -c "select count(*) from dispatch_records"
      psql "$TEST_DATABASE_URL" -c "select count(*) from earnings"
      ```
      **预期：你刚才的操作在库里能查到**，金额是**整数分**，状态与页面一致。
- [ ] **D5 重启即回到预置**：Ctrl-C 后再起，`select count(*) from orders` 回到预置条数
      —— 因为预置数据是**每次启动时**写进去的（`seedDatabase`），**不是**内存里攒的。

### E. fail-fast：缺实现就**拒绝启动**（不是静默用 Mock）

- [ ] **E1 语义**（自动化已覆盖，跑一遍看名字就懂）：
      ```bash
      node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs \
        --test tests/datasourceActivation.test.mjs
      ```
      **预期 17 条全过**，重点看这三条：
      `fail-fast：postgres 模式下取用一个没有 Pg 实现的仓储会抛错，而不是返回 Mock` ·
      `Mock 模式下 pg: null 是合法状态：照常返回 Mock，不抛错` ·
      `清单条数与 CORE_REPOSITORY_COUNT 不符时抛错（漏登记一行的兜底）`。
- [ ] **E2 启动期**（人工看一眼）：临时把 `lib/data/runtime.ts` 清单里任意一条的 `pg` 改成 `null`，
      用 D2 的命令启动 —— **预期：进程退出，日志出现
      `Error: An error occurred while loading instrumentation hook: …`，端口无人监听。**
      改回来再启动，恢复正常。**（这一步只是看现象，不要提交这个改动。）**

### F. 回归四条命令

- [ ] **F1** `pnpm typecheck` —— 预期 0 error。
- [ ] **F2** `pnpm lint` —— 预期 0 error / 0 warning。
- [ ] **F3** `pnpm build` —— 预期 exit 0。
- [ ] **F4 生产全量（一条不跳）**：需要**两个**服务同时在线——Mock 模式（`:3100`）与真库模式（`:3101`），
      命令见 `03-delivery.md` §3.5 ——
      **预期 `tests 2127 / pass 2127 / fail 0 / skipped 0`。**
      （只起 Mock 服务时是 `2123 pass / 4 skipped`，少的正是那 4 条真库用例。）

### G. 文档

- [ ] **G1** `docs/03-dev/rounds/PROD-1E/` 下五个文件齐备（`README` / `01-prompt` / `02-decisions` /
      `03-delivery` / `04-acceptance`），`README` 的状态是 `AWAITING_ACCEPTANCE`。
- [ ] **G2** `03-delivery.md` §6 的九条登记项你认可（都不是 blocker）。
- [ ] **G3** 工作区**没有任何 Git 提交**（`git log --oneline -1` 仍是 `d73ffa2`），
      全部改动等你本人一次性 review + commit。

---

## 验收结论（回填区）

- 人工验收结果：**（待产品负责人回填）**
- 发现的问题：**（待回填）**
- 是否返工：**（待回填）**
- Git 提交：**（待产品负责人本人完成后回填 commit hash）**
