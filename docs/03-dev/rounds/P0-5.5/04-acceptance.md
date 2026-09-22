# Acceptance

Round: P0-5.5
Status: PENDING

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

待用户填写/确认。

## Issues Found

无 / 具体问题。

## Rework

如果发生返工，记录对应修改。历史只追加，不覆盖。

## Final Result

PENDING / PASSED / FAILED

## Git Commit

待用户自行提交后记录。
