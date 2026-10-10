# Acceptance

Round: P0-5.5
Status: PASSED

> 编码完成时只生成 Checklist，**不提前写「验收通过」**（`development-workflow.md` §十七）。

## Manual Acceptance Checklist

> 编号步骤 + 预期结果。**每条都可以当场做出来，不需要读代码以外的推断。**
> 全部做完请在最下方「User Result」写明结果。

### A. 四道自动闸门（先做这步）

1. `pnpm test`
   预期：`tests 1055` / `fail 0` / `skipped 111`。
   ⚠️ `skipped 111` 是未设 `APP_BASE_URL` 时整组跳过的 HTTP 用例，**不是通过**。
2. 起一个**本轮构建**的服务：`pnpm build && pnpm exec next start -p 3105`，另开一个终端跑
   `APP_BASE_URL=http://localhost:3105 pnpm test`
   预期：`tests 1055` / `pass 1055` / `fail 0` / **`skipped 0`**。
3. `pnpm typecheck`
   预期：无输出、退出码 0。
4. `pnpm lint`
   预期：无输出、退出码 0。（`next lint` 在 Next 16 已移除，这里走 ESLint CLI。）

### B. 四处交付物（对着文件看，不用跑）

5. `lib/constants/orders.ts:83` 的 `ORDER_TRANSITIONS`，逐行核对是否**恰好**是下面五条、
   顺序也一致，且终态写成空数组：
   `paid → accepted, refunded` / `accepted → serving, refunded` /
   `serving → completed, refunded` / `completed → refunded` / `refunded → []`
6. `grep -rn "canTransitionOrder" lib/ app/`
   预期：**只有 `lib/constants/orders.ts` 的定义处**，没有任何写入路径调用它。
   （这是本轮的有意形态：只交付中央定义，接入留给真正实现该迁移的那一轮。）
7. `lib/data/adminRefundTransaction.ts:247`
   预期：`applyOrderRefund(existing.orderId, ctx.at, order.actualPaidAmount)` ——
   第三个参数**在**，且金额取自 `order.actualPaidAmount`，**不是** `existing.amount`。
8. `lib/services/checkout.ts:143`
   预期：`if (!isCompanionAcceptingOrders(companion)) {` ——
   不再是内联的 `!isCompanionListed(companion) || !companion.available`。

### C. 文档同步不再自相矛盾

9. 下列三处此前都写着「打手端**没有**清单门禁 / `tests/companion.test.mjs` **不存在**」，
   现在应改口为「已建立（P0-5.5）」：
   - `docs/02-tech-design/architecture-rules.md`（末端检查清单第 4 条）
   - `docs/02-tech-design/directory-structure.md`（「接口清单门禁」那一类）
   - `docs/02-tech-design/api-contract.md`（§8 打手端门禁一段）
   预期：三处都不再有「不存在 / 没有门禁」这类**现在时**说法。

### D. 一处端到端行为（可选，但最能看见 Bug 被修好）

需要先把订单跑出来（Mock 环境，无真实支付）：

10. 手机端下单 → `POST /api/payments/mock-confirm` 完成模拟支付 →
    在订单详情「申请退款」。预期：申请成功、订单状态**不变**（退款申请不推进订单）。
11. 管理后台用「模拟管理员登录」登录 → 退款审核 → 通过。
    预期（这就是本轮修掉的 Bug）：订单变成**已退款**，且**累计已退 = 实付金额**。
    修复前这里是「已退款 + 累计已退 0 元」。
12. 刷新该退款申请详情页，看还能不能再次批准。
    预期：**批准入口已不可用**（申请已是终态）——即「已退款不能二次退款」在界面上也成立。
    ⚠️ 「重复请求被挡住、不重复累计、时间戳不被刷新」这一层**界面点不出来**
    （按钮已经没了），它由 `tests/adminRefunds.test.mjs` 直接对接口打重复请求覆盖。

> D 组的三步在 `tests/adminRefunds.test.mjs` 里已由真实 HTTP 请求端到端覆盖（见 A.2 那一轮）。
> 这里列出来，是为了让你能在浏览器里**亲眼看到**金额与状态同时到位，而不是只信测试结论。

## User Result

**PASSED** —— 用户人工验收通过，并已自行完成 Git commit。

（验收确认时间：2026-09-23。开发完成于 2026-09-21，人工验收在该日之后、
提交 `6bd10fc` 之前完成；记录中无精确时刻，故不记时分秒。）

## Issues Found

无。

## Rework

无。本 Round 未发生返工。

---

## 提交一致性核查（2026-09-23）

> 背景：用户完成人工验收后才执行 Git 提交，且提交时未逐项核对内容。
> 因此在关闭本 Round 前，先核查「已验收版本」与「已提交版本」是否一致。
>
> **结论：`P0-5.5 CAN CLOSE AS DONE`** —— 提交内容与已验收版本一致，
> 提交之后仅发生文档变化，**不需要重新人工验收**。

### 实现提交

```
6bd10fc0ed2575b12d5a6c2d44fd48cc95282caa
refactor: stabilize order lifecycle and companion API contracts
父提交：77877e0（P0-5「接单系统」）
```

`git log 77877e0..6bd10fc` 只有这一个 commit；`git reflog` 显示为一次普通 `commit:`，
无 `amend` / `rebase` / 中间态；`git stash list` 为空。

### 判定依据

1. 提交前工作区的 `git diff --stat` 为 **13 files changed, 736 insertions(+), 61 deletions(-)**；
   `git show --numstat 6bd10fc` 中**同名 13 个文件合计恰好 736 / 61**，且逐文件行数一一相等
   （`orders.ts` 49、`adminRefundTransaction` 31、`mockPaymentRepository` 10、`checkout.ts` 10、
   `api-contract` 19、`architecture-rules` 45、`database-schema` 32、`directory-structure` 9、
   `rounds/README` 8、`总需求进度表` 1、`adminRefunds.test` 158、`checkout.test` 260、`orders.test` 165）。
2. 提交前 3 个未跟踪文件以完全相同的行数入库（`companion.test.mjs` 289、`source-text.mjs` 54）。
3. 文件集合 1:1，无遗漏无多余：13 个已跟踪修改 + 5 份本 Round 档案 + 3 个新文件 = 21，
   与 `git show --stat` 完全吻合。
4. 在同一棵工作树上实测 `pnpm test` = `1055 / 944 pass / 0 fail / 111 skipped`，
   与提交前所测数字**逐位相同**。
5. 本轮四条核心交付在 `6bd10fc` 中逐项实存（见下）。

### 核心交付在提交中的实存证据

| 冻结范围 | 证据 |
|---|---|
| `ORDER_TRANSITIONS` + `canTransitionOrder` | `lib/constants/orders.ts:83` / `:100`，恰好五行、顺序一致、终态 `refunded: []` |
| 管理员全额退款 `refundedAmount` | `lib/data/adminRefundTransaction.ts:247` = `applyOrderRefund(existing.orderId, ctx.at, order.actualPaidAmount)` |
| Companion API route manifest gate | `tests/companion.test.mjs`（清单自检 + 逐条地址断言） |
| Checkout 复用 `isCompanionAcceptingOrders` | `lib/services/checkout.ts:143`（原内联判断已消除） |

另复核 A.6 的有意形态：`grep -rn "canTransitionOrder" lib/ app/ components/`
只命中 `lib/constants/orders.ts:100` 定义处，无任何写入路径调用。

### 一致性判定的认识论边界（诚实说明）

提交前的工作区从未 `git add` 过（当时 `git status` 为 ` M`，对象库中没有对应 blob），
也无 stash，因此**无法再做逐字节 diff 作为绝对证明**。上述判定建立在
「diffstat 精确对账 + 未跟踪文件行数一致 + 测试结果逐位相同 + 全部冻结交付物实存」之上——
这是当前可得的最强证据，但不是 hash 级证明。用户已就此结论明确表示接受。

### 已知的无害瑕疵

`docs/cmd.md`（1200 行，内容为 P0-6 的开发指令，**不属于 P0-5.5 范围**）
被一并提交进 `6bd10fc`。不影响任何功能，仅为史料归属不精确。
**不为此修改 Git 历史**；该文件的处置见其自身内容（已标记废弃）。

---

## 自动门禁重跑（2026-09-23，核查时执行）

工作区 `lib/`、`tests/` 与 `6bd10fc` 无差异，故结果对应该提交内容。

| 命令 | 结果 |
|---|---|
| `pnpm test` | `tests 1055` · `pass 944` · `fail 0` · `skipped 111` |
| `APP_BASE_URL=http://localhost:3106 pnpm test` | `tests 1055` · `pass 1055` · `fail 0` · **`skipped 0`** |
| `pnpm typecheck` | 通过（退出码 0） |
| `pnpm lint` | 通过（退出码 0） |
| `pnpm build` | 通过（退出码 0） |

> HTTP 那一轮起的是**本轮构建的**生产服务（`next start -p 3106`）后测得，
> 测试结束后已停止该进程并经 `netstat` 确认 3106 端口释放。
> 该组数字正好命中本清单 A.2 的预期（`1055 / 1055 / 0 / 0 skipped`）。

---

## Final Result

**PASSED**

## Git Commit

```
6bd10fc0ed2575b12d5a6c2d44fd48cc95282caa
refactor: stabilize order lifecycle and companion API contracts
```
