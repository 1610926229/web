# P1-4 交付记录

Status: **AWAITING_ACCEPTANCE**
日期: 2026-09-29（夜间连续开发批次）
阻塞解除依据: 产品负责人裁定 §1–§10（逐条落点见 `02-decisions.md` §七）

> ⚠️ **本文件顶部已整体重写。** 原「BLOCKED 期交付记录」全文**原文保留在文末附录**，
> 它是同一轮次的历史状态，不改写、不删除（协议要求：历史记录只可批注）。

---

## 一、裁定 → 落点对照

| 裁定 | 内容摘要 | 落点 |
|---|---|---|
| §1 | 只有 `threshold`（满减）参与结算；`discount` / `gift` 保持**仅展示**；新增整数分字段 `thresholdAmount` / `discountAmount` | `lib/types/coupon.ts`（字段 + 领取快照）· `lib/constants/coupons.ts`（表单与文案）· `lib/services/checkout.ts`（非满减**显式拒绝**） |
| §2 | 门槛基数是 `originalAmount`；不满足 → **服务端显式拒绝**，不得静默改成 0 元继续下单；保证 `couponDiscountAmount <= originalAmount`、`actualPaidAmount >= 0` | `lib/services/checkout.ts`（唯一计算点，不读请求金额）· `lib/constants/orderAmount.ts`（夹取） |
| §3 | 只做**全场券**：不加指定商品/指定类目/黑白名单/scope DSL | 未新增任何 scope 字段（`lib/types/coupon.ts` 保持全场语义） |
| §4 | 一单最多一张券，**不叠加** | `lib/services/checkout.ts` 收单个 `couponClaimId`，无数组形态 |
| §5 | 同用户同券最多领 1 张；`unused → used` 只能核销一次；核销必须发生在**真实成功建单/支付**的原子流程里；preview 不消耗；下单/支付失败**不得永久 used** | `lib/data/couponRedemptionTransaction.ts`（新增）· `lib/data/mockPaymentRepository.ts`（`confirmPaymentRequest` 原子区段）· `app/api/orders/preview/route.ts`（只读试算） |
| §6 | 退款**不返还券**；退款金额严格以 `actualPaidAmount` 为基；不得按 `originalAmount` 超退 | `lib/services/refunds.ts` · `lib/data/directRefundTransaction.ts` · `lib/data/adminRefundTransaction.ts` |
| §7 | 保持现有发券方式 | 未改发券路径 |
| §8 | 保持 `validFrom` / `validTo` 绝对时间 | 未改有效期模型 |
| §9 | 订单至少冻结 `couponId` / `name` / `formKey` / `thresholdAmount` / `discountAmount` / `valueLabel` / `conditionLabel` + `couponDiscountAmount`；后台改券**不得**改变历史订单金额与展示 | `lib/types/order.ts`（`CouponSnapshot`）· `lib/constants/orderAmount.ts`（建单时取值） |
| §10 | `actualPaidAmount = originalAmount - couponDiscountAmount`；券不改变 `originalAmount` / `companionRateSnapshot`，不压低 `companionBaseIncome`；成本由平台承担（平台净额可为负、不夹零）；退款基数 = 实付；一单一退；通过退款后打手净额 = 0；`platform final net = actualPaidAmount - refundAmount` | `lib/constants/orderAmount.ts`（公式本已正确，本轮**未改公式**，改为加测试钉死） |

> **没有一处裁定是「看着像已经实现了」就跳过。** 上面每一行都对应至少一条自动化断言（见 §四）。

---

## 二、实现清单

> ⚠️ **归属说明**：本工作区同时含 P1-3 的未提交改动，`git diff` 无法按轮次归属文件。
> 下表是 **P1-4 的改动集**（按职责分组），不是 `git diff --stat` 的原文。

### 2.1 新增文件

| 文件 | 说明 |
|---|---|
| `lib/data/couponRedemptionTransaction.ts` | 券核销的**原子事务**：镜像既有先例 `lib/data/companionDispatchTransaction.ts`（`createDispatchForOrder()`）。核销点在 `confirmPaymentRequest(id, result, buildOrder)` 的**无 `await`** 原子区段内，排在派单之前 |
| `tests/couponCheckoutChain.test.mjs` | 端到端有券链路：**24 条**用例（含 §四 的 18 项要求 + 5 条超纲防线） |

### 2.2 逻辑与数据

| 文件 | 改动 |
|---|---|
| `lib/types/coupon.ts` | 新字段 `thresholdAmount` / `discountAmount`（整数分）；领取快照携带它们（D-P1-4-2：**领取即锁价**） |
| `lib/types/order.ts` | `CouponSnapshot`（§9 的 7 字段）· `OrderListItem` **删掉** `totalAmount`（见 §5.1） |
| `lib/constants/orderAmount.ts` | 券进入金额合成点：`couponDiscountAmount` 夹取到 `originalAmount`；公式本身按 §10 不动 |
| `lib/services/checkout.ts` | **服务端唯一计算点**：从领取快照取值、校验门槛 / 启用 / 有效期 / 归属，不满足即抛 400；**不从请求里读金额**（`couponDiscountAmount: 0` 的占位已移除） |
| `app/api/orders/preview/route.ts` | 只读试算：与 `create` 同源校验、同源文案，**不消耗券** |
| `app/api/orders/pay/route.ts` | 支付路径接入原子核销 |
| `lib/data/mockPaymentRepository.ts` | `buildOrderFromRequest` 内冻结券快照并核销；`buildOrder` 同步返回，抛错不留半成品 |
| `lib/services/orders.ts` | DTO 收敛（§5.1） |

### 2.3 消费口径修正（P1-4 激活的既存缺陷）

| 文件 | 改动 |
|---|---|
| `lib/constants/levels.ts` | `sumEffectiveSpend()` 原先累加**优惠前** `totalAmount`，改为 `actualPaidAmount`。函数自带的规则注释第 3 条与用户可见文案 `CONSUMPTION_CALCULATION_NOTICE`、`database-schema.md` 的 ConsumptionLevel 一节**都写着按实付计入**——代码与它自己的口径说明当场矛盾，接券前两者恒等所以看不出来 |

⚠️ 与 `database-schema.md:566-574` 那条**部分退款** TBD（`Σ max(0, actualPaidAmount − refundedAmount)`）是**两件事**，本轮**未触碰**：只解决「有券时读哪个字段」，部分退款是否按实退扣减仍未裁定，故不做任何 `refundedAmount` 扣减。已在函数注释里显式写明，避免下一个人把两件事并成一件。

### 2.4 退款详情两处「订单实付」

| 文件 | 改动 |
|---|---|
| `lib/services/refunds.ts` | `orderTotalAmount: order.totalAmount` → `order.actualPaidAmount` |
| `lib/constants/staffRefunds.ts` | 同上；该文件 `toStaffRefundDetail` 的窄 `order` 入参类型补 `actualPaidAmount: number` |
| `lib/types/refund.ts` | 用户侧 `orderTotalAmount` 补口径注释 |

两处字段名都叫「订单实付 / 原订单实付金额」，值原先取**优惠前**应付总额——有券时客服会拿着一个比用户实付更大的数去对账。

### 2.5 UI（展示一致，item 17）

| 文件 | 改动 |
|---|---|
| `components/checkout/CheckoutForm.tsx` | 结算页「原金额 / 优惠 / 实付」三行 |
| `app/(mobile)/orders/[id]/page.tsx` | 订单详情金额摘要（原价 + 券抵扣行） |
| `app/admin/(console)/orders/[id]/page.tsx` | 管理端金额摘要同口径 |
| `components/admin/AdminRefundConsole.tsx` · `components/admin/AdminRefundSections.tsx` | 退款基数显示实付 |
| `components/staff/StaffOrderDetailPanels.tsx` | 客服端金额摘要同口径 |
| `components/orders/OrderCard.tsx` · `components/admin/AdminOrderTable.tsx` · `components/staff/StaffOrderTable.tsx` · `components/staff/StaffOrderSummaryPanel.tsx` · `app/(mobile)/orders/[id]/refund/page.tsx` | 列表 / 卡片「实付」列原先读优惠前 `totalAmount`，改为读 `actualPaidAmount` |

**规则**：任何标着「实付 / 实收 / 实付金额」的展示位一律读 `actualPaidAmount`；「原价」一律读 `originalAmount`。

---

## 三、门禁读数

> ⚠️ 以下是**交付前的中间读数**（reviewer 报告未回，尚未进入终局复跑）。reviewer 提出的
> BLOCKER / MAJOR 修完后，全套门禁会**重跑一遍**，届时在 §3.6 覆盖为终值。**在终值落下前，
> 不得把本节读作「已通过最终门禁」。**

### 3.1 类型检查

```
$ npx tsc --noEmit
（无输出，退出码 0）
```

### 3.2 全量测试（离线）

```
$ pnpm test
ℹ tests 1638
ℹ pass 1469
ℹ fail 0
ℹ cancelled 0
ℹ skipped 169
```

`skipped 169` 是需要 `APP_BASE_URL` 的 HTTP 冒烟批次，未起服务时按设计跳过——它们在 §3.5 的 production 全量里**不被跳过**。

### 3.3 Lint

```
$ pnpm lint
$ eslint
（无输出，退出码 0）
```

### 3.4 生产构建

```
$ pnpm build
✓ Compiled successfully in 2.6s
（112/112 静态页生成，退出码 0）
```

### 3.5 production 全量（`APP_BASE_URL` 已设，真实 `next start`）

```
$ APP_BASE_URL=http://localhost:3000 pnpm test
ℹ tests 1638
ℹ pass 1638
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

即 169 条 HTTP 用例**全部真实执行**且全绿。跑完后已确认端口释放：`netstat` 无 `:3000` `LISTENING`，`curl` 返回 `000`（连接被拒）。

> 本轮 production 首跑曾红 2 条，**两条都是我自己的回归**，且在离线模式**看不见**（那两条用例离线时被跳过）：
> `tests/adminProducts.test.mjs` 的 `quoted.totalAmount`（来自我把 `CheckoutPreview.totalAmount` 改名 `originalAmount`）、
> `tests/staff.test.mjs` 的 `detail.body.includes("totalAmount")`（来自我删掉 `StaffOrderSummary.totalAmount`）。
> 两条均按**断言侧**修正，未放宽任何断言。
>
> 另：`TaskStop` 停 `pnpm start` **两次都没杀掉子进程**（PID 14048、24732），
> 每次以 `taskkill //PID <n> //F` 收尾，并用 `netstat` + `curl` 双向确认端口已释放后才继续——否则下一轮会测到旧进程。

### 3.6 终局复跑（reviewer 修复后，**最终树**）

reviewer 报告回来（0 BLOCKER / 0 MAJOR / 2 MINOR / 3 NOTE）后按 §十 修完，全套门禁**重跑**：

| 门禁 | 命令 | 读数 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 退出码 0，无输出 |
| 全量测试（离线） | `pnpm test` | `tests 1638 · pass 1469 · fail 0 · skipped 169` |
| Lint | `pnpm lint` | `$ eslint` 无输出，退出码 0 |
| 生产构建 | `pnpm build` | 退出码 0 |
| production 全量 | `APP_BASE_URL=http://localhost:3000 pnpm test` | `tests 1638 · pass 1638 · fail 0 · skipped 0` |

停服后端口已释放：`netstat` 无 `:3000` `LISTENING`，`curl` 返回 `000`。
（本次 `pnpm start` 的子进程以 `taskkill //PID 2608 //F` 收尾——**又验证了一次** `TaskStop` 杀不干净子进程。）

**以上即 `03-delivery.md` 的最终门禁读数，本文件 §三 的中间读数已被本节覆盖。**

---

## 四、18 项测试要求的落点

| # | 要求 | 落点 |
|---|---|---|
| 1 | 无券 | `couponCheckoutChain` 「支付记录收的是实付而不是原价；无券链路两者相等（不回归）」· `couponMoneyChain` #15 |
| 2 | 有券 | `couponCheckoutChain` 「有券下单：preview 与 create 算出的金额逐字段一致，订单金额等于预估值」 |
| 3 | 实付计算 | `couponCheckoutChain` 「面额大过原价：抵扣夹到原价，实付为 0 而不是负数」· `couponMoneyChain` #2 |
| 4 | 优惠不压低 companion base income | `couponMoneyChain` #5（券 0 / 1000 / 3000 三次**显式相等**） |
| 5 | platform 承担优惠 | `couponMoneyChain` #1（§18 原始算例）· #6（平台净额为负且**不被夹零**） |
| 6 | 券修改不追溯历史订单 | `couponCheckoutChain` 「后台改券模板：已下单的金额与券展示一个字不变，新领取的券才用新值」 |
| 7 | disabled 券拒绝 | `couponCheckoutChain` 「已停用的券（领取后被后台停用）：preview 报原因、create 抛 400」 |
| 8 | 过期券拒绝 | 「已过期的券」「尚未开始的券」两条 |
| 9 | 门槛边界 | 「门槛边界：正好等于门槛可用、差 1 分被拒（两个入口都给同一句原因）」 |
| 10 | preview 与最终创建一致 | 同上两条（同源校验 + 同源文案，逐字段比对金额） |
| 11 | 退款不超过 actualPaidAmount | `couponMoneyChain` #12（退满通过、多退 1 分被拒） |
| 12 | 10 / 50 / 100% refund + coupon | `couponCheckoutChain` 三条（分别以实付为基） |
| 13 | approved refund 后 companion net = 0 | 同上三条 |
| 14 | platform net 正确 | 「有券订单 10% 退款…平台净收入 = 实付 − 退款额」 |
| 15 | DTO exact keys | 「券相关 DTO 的键集合精确固定：多一个少一个都要红」 |
| 16 | 金额整数分 | `couponMoneyChain` #8 · `adminOrders` 详情自洽用例 |
| 17 | checkout / order / admin 展示一致 | 「结算试算 / 订单详情 / 管理端退款详情给出的实付金额是同一个数」· 「退款详情两处「订单实付」读的也是实付」 |
| 18 | 无券链路不回归 | 同 #1 |

### 4.1 超出 18 项的额外防线

| 用例 | 守的是什么 |
|---|---|
| 「preview 反复试算不消耗券：领取记录仍是 unused，usedAt 仍是 null」 | §5 preview 不消耗 |
| 「支付成功那一刻才核销」 | §5 核销点必须在真实成功流程内 |
| 「支付失败 / 取消不核销券：券仍是 unused，可再次使用」 | §5 **不得永久 used** |
| 「同一张券只能成功核销一次」 | §5 一次性 |
| 「双花防线：同一张券建两笔待支付请求，第二笔支付成功被拒、不建单也不二次核销」 | 并发双花 |
| 「别人的券不能用」「不存在的 claimId 同样被拒」 | §5 归属校验 + 不泄露券面 |
| 「未达门槛的券仍出现在 availableCoupons 里（用户能看到还差多少）」 | §2 不合规 ≠ 不可见 |
| 「折扣券（非满减）不参与结算：两个入口都报「类型不支持」，**不按 0 元成交**」 | §1 显式拒绝、不静默归零 |
| 「结构：建单原子区段里不许出现 await，核销点必须在区段内且排在派单之前」 | 原子性**结构约束**（防未来有人塞进 await 打断原子区段） |

---

## 五、横向一致性扫描（本轮暴露并修掉的口径分叉）

### 5.1 DTO 里的「两个数」收敛成一个

`totalAmount`（优惠前）与 `actualPaidAmount`（实付）同时出现在同一个列表 DTO 里，等于给每个消费者
留一次**读错的机会**——已有 11 处展示位就是这么错的。做法是**删掉列表 DTO 里的
`totalAmount`**（它不是任何计算或展示的必需项），只留 `actualPaidAmount`；「原价」在需要它的
详情 DTO 里统一叫 `originalAmount`。

| 文件 | 改动 |
|---|---|
| `lib/types/order.ts` | `OrderListItem` 删 `totalAmount`（`OrderDetail` 仍带 `originalAmount` / `couponDiscountAmount` / `actualPaidAmount`） |
| `lib/services/orders.ts` | `toOrderListItem` 同步删 |
| `lib/types/staff.ts` | `StaffOrderListItem` / `StaffOrderSummary` 删 `totalAmount`（后者原注释谎称「留给详情页当原价」，而 `StaffOrderDetail` 自declares `originalAmount`） |
| `lib/constants/staff.ts` | `toStaffOrderSummary` / `toStaffOrderListItem` 同步删 |

**删除安全性**：`tsc` 在这一点上是穷尽的——若存在消费方，删字段必然编译失败。零消费方已被类型检查证实。`api-contract.md` 未逐字段枚举这些 DTO，故无需改契约文档。

### 5.2 受影响的测试（全部按**断言侧**修正，未放宽任何一条）

`levels` · `rankingPeriods`（夹具补齐 `actualPaidAmount`——原夹具漏写**不报错**，金额会静默变 0）·
`adminRefunds` · `adminOrders` · `orders` · `staffOrders` · `staffReleaseHistory` · `refunds` ·
`staff` · `staffRefunds` · `adminProducts`（HTTP）· `couponMoneyChain` · `couponCheckoutChain`

---

## 六、红绿证伪（断言有杀伤力）

新增断言**首跑即全绿**（被验证的规则本来就是对的），所以必须另证它们**会红**，否则可能是一组恒真空断言。做法是**注入式探针**：临时把实现改成典型错误结论，确认对应断言变红，再还原。

| 探针 | 注入的错误 | 结果 |
|---|---|---|
| `resolveOrderMoneyDomain()` 第 3 步改成 `resolveCompanionRevenueBase(actualPaidAmount, …)` | 「优惠压低打手分成基数」 | `15 条里 5 条同时变红`（如 `冲回额与退款比例无关…3200 !== 4000`） |
| 用户侧 `lib/services/refunds.ts` 的 `orderTotalAmount` 改回 `order.totalAmount` | 拿优惠前原价充数 | 红，报文「用户端退款详情的「订单实付」必须是实付，不是优惠前原价」 |
| 客服侧 `lib/constants/staffRefunds.ts` 的同名字段改回 | 同上 | 红，报文「客服端退款详情的「原订单实付金额」必须是实付，不是优惠前原价」（**第二次探针**：首次探针被用户侧断言短路盖过，未真的验到客服侧，故重跑一次而不是宣称已覆盖） |

探针均已还原；还原后 `git diff` 对应文件无差异，全绿复现。

---

## 七、已知缺口与保留项（**不做成「已覆盖」的样子**）

| 项 | 状态 | 说明 |
|---|---|---|
| `buildOrderFromRequest` 里「核销成功 → 建单」之间的残余窗口 | **代码内已如实注释** | 位于**无 `await`** 的原子区段内，抛错不留半成品；但它不是真事务（Mock 存储无回滚）。**不宣称已消除**，只宣称已收窄到无 await 且被结构断言钉住 |
| React 组件行为（结算页三行渲染） | **手工验收** | `node --test` 不剥离 JSX，组件行为在测试框架外。**这是本轮唯一的验证方式缺口** |
| 「部分退款是否按实退扣减消费额」 | **未裁定（TBD）** | `database-schema.md:566-574` 的既存 TBD，本轮**刻意未碰**（见 §2.3） |
| 打手端订单详情「订单合计」 | **保留未改** | `app/companion/(console)/orders/[id]/page.tsx:279` 读优惠前 `totalAmount`。该值同时是打手的收入基数，改动属产品/UX 判断，**不在任何已裁定规则的覆盖范围内**——故保留并在验收文档里点出，而不是自己决定 |
| 真支付 / 微信退款 | 不适用 | 无真实支付通道（P1-4 明确不做） |

---

## 八、需要产品负责人**追认**的两处

实现时按最保守口径落地，两处都可低成本回退。详见 `04-acceptance.md`。

| # | 我的实现 | 若追认不通过则改为 |
|---|---|---|
| A | **停用的券不能再被使用**（结算时读**券模板当前**的 `enabled`）：领取时已启用的券，后台停用后即不可用 | 领取时已启用的券即使后来停用也仍可使用 |
| B | **以领取快照为准**定价（D-P1-4-2）：领取后后台改券额，已领的券按**领取时**的值抵 | 以券模板**当前**值为准 |

---

## 九、下一步

1. ~~等 reviewer 报告~~ → 已回，结论与处置见 §十。
2. `04-acceptance.md` 列出 §八 的两处追认项。
3. `总需求进度表.md` 的 P1-4 行由 `⛔ BLOCKED` 改为 `🟣 AWAITING_ACCEPTANCE`。
4. **停在 `AWAITING_ACCEPTANCE`——不自判 DONE。**

---

## 十、reviewer 审查结论与处置

审查范围：优惠券参与结算与金额域的全部改动。结论：**0 BLOCKER / 0 MAJOR / 2 MINOR / 3 NOTE**。

### 10.1 已修的 2 条 MINOR（死字段清理）

两条同一性质：**「优惠前原价」以 `totalAmount` 这第二个名字继续留在 DTO 里，而没有任何消费方**。它们不是行为缺陷，但与本轮确立的单名约定相悖，而且正是「拿原价充实付」的入口——该错误本轮已在用户端与客服端各出现过一次。因此按 §5.1 同样的口径**删字段**，而不是留一句注释。

| MINOR | 落点 | 处置 |
|---|---|---|
| 投诉订单摘要带没人读的 `totalAmount` | `lib/types/complaint.ts`（`AdminComplaintOrderSummary` / `StaffComplaintOrderSummary`）· `lib/constants/adminComplaints.ts` · `lib/constants/staffComplaints.ts`（Input 类型 + mapping）· `lib/services/adminComplaints.ts` · `lib/services/staffComplaints.ts` | 删字段，并把两处 `actualPaidAmount` 的注释改成**显式说明为何不带原价**（将来要显示原价请加 `originalAmount` 这个统一名字） |
| `toStaffRefundDetail` 入参仍要求 `totalAmount`，函数体已不读 | `lib/constants/staffRefunds.ts` | 从入参类型删掉，注释改为说明「刻意不要」及其理由 |

**删除安全性**：`npx tsc --noEmit` 在这一点上是穷尽的——若存在消费方，删字段必然编译失败；零消费方已被类型检查证实。唯一一条相关断言 `tests/adminComplaints.test.mjs:756` 原先断言 `typeof orderSummary.totalAmount === "number"`，改为断言 `actualPaidAmount` 是数字，并**加了一条反向断言**（`"totalAmount" in orderSummary === false`）把这次收敛钉住，防止将来被顺手加回来。

### 10.2 已修的 1 条 NOTE（注释与事实不符）

reviewer 指出 `lib/services/checkout.ts` 残留窗口那段注释把「可能抛错处」指到了 `normalizePlatformConfig()`，而后者是**兜底不抛**的。

**我独立复核过，没有只凭报告采信**：`lib/data/mockPlatformConfigRepository.ts:86-107` 的 `normalizePlatformConfig` 对四个时长字段一律走 `withTimeoutFallback` 回退默认值，`clonePlatformConfig` 做的是展开，`{...undefined}` / `{...null}` 在 JS 里都不抛。reviewer 说得对。

处置：**改注释，但两个方向都不夸大**——既不再声称那里会抛，也**不**反向升级成「窗口已关闭」。改后的注释写明：当前 mock 实现里这段**没有已知抛错点**（逐项列出为什么），而关不严是**架构性质**的（订单与券核销记录在两个存储上，没有跨存储事务），因此「当前没有已知抛错点」修饰的是**今天的实现**，不是一条不变量——将来任何一处引入异步（换真仓储、加一次 `await`）它就会失效。

### 10.3 未处置的 2 条 NOTE（记录在案）

| NOTE | 为何不动 |
|---|---|
| §7.2 的 A / B 两项仍是「待产品追认」，不是已裁定 | **这正是要交给产品的那件事**——已在 §八 与 `04-acceptance.md` 落条。代码行为一致、可低成本回退，注释也已标「待产品追认项」。由产品裁定，不由我改 |
| 已知缺陷（`refundedAmount` 为 0）在本批已修好 | reviewer 的**正面确认**，不是问题项：第三参 `applyOrderRefund(existing.orderId, at, refundAmount)` 已显式传入，10 / 50 / 100% 三条退款用例分别断言累计额与终态 |

### 10.4 reviewer 明确核对为「无问题」的项（供验收参考）

核销只发生在支付成功的原子区段内且只成功一次 · 失败 / 取消 / 试算不消耗券 · `actualPaidAmount === companionBaseIncome + clubNetIncome` 在有券输入下成立 · 优惠由平台承担且不压低打手基础收益 · 退款基数全面切到实付（含渠道实收 `Payment.amount`、累计消费、退款上限），无残留金额分叉 · 打手 DTO 不含券快照与实付 · 券的领取 / 试算 / 核销三处均按 `userId` 校验归属，且「查不到」与「不是我的」对外同一句话 · 原子区段无 `await` 且有结构断言钉住 · 18 项测试全部有覆盖且未见恒真断言。

---

## 十一、P1-4 **验收整改轮**（第二轮）交付记录

> **背景**：第一轮交付后 P1-4 停在 `AWAITING_ACCEPTANCE`，产品负责人**人工验收未通过**，
> 下发「验收整改」裁定书共 16 条（原文见 `01-prompt.md` **§二**，逐字保留）。
> 本轮**只做这 16 条**：不启动 `P1-6`，不碰 Scheduler / 微信 OAuth / 真支付 / 钱包 / 追偿 /
> chat retention，不篡改任何历史 Round 文档。⚠️ **全程禁止 Git 写操作**，故本轮改动同样**未提交**。
>
> 上面 §一–§十 与文末附录都是**第一轮**的记录，原样保留、一字未改。

### 11.1 一句话：缺陷的根因是「同一个判断被写了两遍」

人工现场看到的是「**账户里明明有可用的券，结算页却说没有可用优惠券**」。

根因不是券的数据坏了，而是**同一件事有两个实现**：账户页只看 `status` + 快照有效期，
结算页还额外看**券的形态**（只有满减券参与结算）、**模板当前是否启用**、**是否达到门槛**。
两处口径一旦分叉，用户就会同时看到两个互相矛盾的结论——而**两边各自都是「对」的**，
这正是它躲过了第一轮全部测试的原因：没有任何一条测试在问「这两个页面对同一张券的看法一致吗」。

修法不是「把账户页也补上那几个条件」——那会变成**第三遍**实现，下次再加一个条件就再分叉一次。
本轮把它收敛成**一个前置判定** `resolveCouponClaimGate()`（`lib/constants/coupons.ts:341`），
账户页与结算页**共用**它（`resolveCouponSettlementUsability()` 与 `resolveCouponApplication()`
都从它出发），因此两边**在结构上不可能**再给出不同结论。

这条收敛由一个**结构性**回归钉住（§十四）：它走**真实的 Service / Repository 选择链**
（`queryCouponsForUser` → `previewCheckout`），**不是**测一个纯函数。
理由很直接——纯函数测试在第一轮就已经全绿了，而缺陷照样出厂。

### 11.2 16 条裁定的落点

| 裁定 | 落点 | 关键实现选择 |
|---|---|---|
| **§一** 返券判据 = 订单**曾经**进入 accepted | `Order.everAcceptedAt`（`lib/types/order.ts`） | 写入用 `order.everAcceptedAt ?? input.at`（`mockPaymentRepository.ts:256`）⇒ **只写一次、永不清空**；它与会被清空的 `acceptedAt` 是两个字段，理由写在 `order.ts` 的字段注释里 |
| **§一.3** Staff 直接指定视为已被承接 | `replaceOrderCompanionByStaff`（`companionOrderTransaction.ts`） | ⚠️ **没有**复用排行榜的 `acceptedVia === "companion"`。换人路径照样写 `everAcceptedAt`；判据始终只有 `everAcceptedAt` 一个 |
| **§二** 归还只动 `status` / `usedAt` | `restoreCouponClaimForOrder(order)`（`couponRedemptionTransaction.ts:146`） | 入参类型是 `Pick<Order, "userId" \| "everAcceptedAt" \| "coupon">`——**签名里根本没有订单金额** ⇒ 结构上不可能改快照、`actualPaidAmount`、`couponDiscountAmount`。也**刻意不记 `restoredAt`**（会造出第二份「这张券什么时候变的」真值） |
| **§三** 返还是「恢复未使用资格」 | 判定仍走 `resolveCouponClaimGate` | 退回的券**不绕过** enabled / 有效期 / 门槛；「还回来了」不等于「现在能用」 |
| **§四** Admin 发券 | `lib/services/adminCoupons.ts` + 三个路由 + `/admin/coupons` + `AdminCouponGrantConsole.tsx` | 只列 **enabled** 模板（服务端过滤）；复用**同一份**券数据，**没有**第二套系统 |
| **§五** self-claim 一模板一次 / grant 可重复 / 凭 `couponClaimId` | `grantCouponToUser` 走**独立**幂等键 | checkout 只认 `couponClaimId`；每次发放生成**独立 Claim**，各自只能核销一次 |
| **§六** `source` 必填 + 最小审计 | `CouponClaim.source`（**必填**）、`grantedByAdminId` | `source` 是必填而非可选：可选字段会被**新**写入路径静默漏掉（与 P1-5 `acceptedVia` 同一课）。`grantedByAdminId` 为审计字段，**不进**用户端 DTO（有断言） |
| **§七** 按**当时**模板生成 snapshot | `createGrant` 取当前模板快照 | snapshot 决定「这张券**是什么**」；模板当前 `enabled` 决定「平台**现在**允不允许用」——两件事分开 |
| **§八** 账户 / 结算一致 | `resolveCouponClaimGate`（单点） | 见 11.1 |
| **§九** 账户页可用判据 | `OwnedCouponItem.settlementUsable` / `settlementReason` | `discount` / `gift` 一律标「暂不可用于结算」 |
| **§十** 未达门槛**展示但禁用** | `loadCheckoutCoupons` 保留 `threshold_not_met` 那一档（`lib/services/coupons.ts`） | 文案写明**差额**（`couponThresholdNotMetReason`）：「满 ¥100.00 可用，还差 ¥70.10」 |
| **§十一** 服务端只信 `couponClaimId` | `parseSelectionInput` 白名单 + `resolveCouponApplication` | 前端传 `discountAmount` / `thresholdAmount` / `couponDiscountAmount` **没有读取位置** |
| **§十二** 核销与建单同一原子区 / 退款**真的**成功才归还 | 沿用第一轮的 `couponRedemptionTransaction`（无 `await` 区段） | 三处调用点全部形如 `if (written.changed) restoreCouponClaimForOrder(written.previous)`——**先看写成功，再归还**，且传的是**退款前**那一份（否则读不到 `everAcceptedAt`） |
| **§十三 / §十四** 测试 | `tests/couponReturnAndGrant.test.mjs`，**43 条** | 见 11.6 |

### 11.3 新增 / 修改文件

**新增**

| 文件 | 职责 |
|---|---|
| `lib/services/adminCoupons.ts` | 发券的服务端：可发模板、找目标用户、发放（含幂等） |
| `app/api/admin/coupons/route.ts` · `.../grant/route.ts` · `.../grant-targets/route.ts` | 三个地址，**都没有**「撤销发放 / 编辑已发券 / 列出某人已持有券」——券一旦发出就是**用户的资产**，管理端不能悄悄改它或收回它（要收回只能等它过期或停用模板，那是「以后不能用」而不是「抹掉这一张」） |
| `app/admin/(console)/coupons/page.tsx` · `components/admin/AdminCouponGrantConsole.tsx` | 发券界面：选模板 + 选人，显示对方**已持有几张** |
| `tests/couponReturnAndGrant.test.mjs` | 本轮 43 条测试 |

**修改（第二轮新增的部分）**

`lib/constants/coupons.ts`（单点判定 + 账户页可用性 + 门槛文案）·
`lib/types/coupon.ts`（`CouponClaimSource` / `source` / `grantedByAdminId` / `settlementUsable` / `settlementReason`）·
`lib/data/couponRedemptionTransaction.ts`（归还实现）·
`lib/services/coupons.ts`（账户页与结算页的券加载）·
`lib/services/checkout.ts`（§十一 八项复查）·
`lib/services/adminHttp.ts` · `lib/constants/admin.ts`（导航与文案）·
`lib/data/{directRefund,adminRefund,companionDispatch}Transaction.ts`（三处归还调用点）·
`components/checkout/CheckoutForm.tsx` · `components/checkout/CouponSheet.tsx` · `app/(mobile)/checkout/page.tsx`

**测试侧同步修改**（三处都是**门禁按设计生效**，不是放宽断言）：
`tests/admin.test.mjs`（接口清单 + 导航数组）· `tests/coupons.test.mjs`（DTO 键集合）·
`tests/couponCheckoutChain.test.mjs`（`CouponClaim` 键集合 + `source` 断言）

### 11.4 门禁读数（§十六 · 最终树）

| 步骤 | 命令 | 读数 |
|---|---|---|
| 定向 | `node --test tests/couponReturnAndGrant.test.mjs tests/couponCheckoutChain.test.mjs tests/coupons.test.mjs` | **85 / 85 pass · 0 fail · 0 skipped**（其中本轮文件 43 条） |
| 全量（离线） | `pnpm test` | **1744 · pass 1570 · fail 0 · skipped 174**（skipped = 需真实服务的 HTTP 组） |
| 类型 | `pnpm typecheck` | **exit 0** |
| Lint | `pnpm lint` | **exit 0**（无输出） |
| 构建 | `pnpm build` | **exit 0** |
| **production 全量** | `APP_BASE_URL=http://localhost:3105 pnpm test` | **1744 / 1744 pass · fail 0 · skipped 0** |

生产服务用 `taskkill //PID … //F //T` 杀干净后复核：`netstat` 该端口 **0 个 `LISTENING`**、`curl` 返回 **000**。

> ⚠️ 全量测试**会真的改内存 store**（真的下单、接单、退款、发券）。因此人工验收的读数
> **必须在重启后的干净进程上取**，否则看到的是测试跑完的残留状态。

### 11.5 红-绿证伪：3 个探针，确认断言**真的会红**

本轮的起点是「第一轮测试全绿、缺陷照样出厂」，所以**绿本身不算证据**。三个探针各自注入、
跑完**逐字节还原并 `diff` 复核**：

| # | 注入 | 结果 | 证明了什么 |
|---|---|---|---|
| 1 | 注释掉 `directRefundTransaction.ts` 的 `restoreCouponClaimForOrder(...)` | **7 条红** | 直退那条归还路径**真的**被覆盖，不是「碰巧绿」 |
| 2 | `loadCheckoutCoupons` 改成 `if (!application.applicable) continue;`（即**藏起**未达门槛的券） | **恰好 §十 那组红** | §十「展示但禁用」有判别力 |
| 3 | 从单点判定里拿掉 `isComputableCouponForm`（即退回「账户页不看形态」的旧口径） | **§十四 + 两条 §九 红** | **根因那一类缺陷**会被抓住——这正是第二轮存在的理由 |

### 11.6 测试清单（43 条，按裁定分组）

| 组 | 覆盖裁定 | 条数 |
|---|---|---|
| A. 退款返券 | §一 / §二 / §三 / §十二 | 13 |
| B. Admin 发券 | §四 – §七 | 10 |
| C. 账户 ↔ checkout 一致 | §八 / §九 / §十 / **§十四** | 8 |
| D. 服务端真值 + 原子性 | §十一 / §十二 / §十三.27 / .29 / .30 | 12 |

**两条刻意的设计选择**（写在文件头，供复核者直接质疑）：

1. **所有断言都走真实 Service / Repository 链**，不测纯函数。§十四 那条必须**同时**穿过
   `queryCouponsForUser` 与 `previewCheckout`，否则它测不到「两个页面是否一致」。
2. **时间钉在数据层**：`previewCheckout` / `createPaymentRequest` **没有 `now` 注入**
   （内部用 `new Date()`），因此测试通过 `patchClaim` 把有效期**放宽**来构造「在有效期内」，
   而不是去改系统时间或给生产代码加测试专用参数。

### 11.7 已知缺口与保留项（如实登记，**不做成「已覆盖」的样子**）

| 项 | 状态 | 说明 |
|---|---|---|
| `CouponClaim.source` 的「必填」保证在 `.mjs` 测试夹具里**不生效** | **已知缺口** | `.mjs` 不过 `tsc`，因此夹具构造 Claim 时漏写 `source` **不会**报错。生产代码六个构造点全部由编译期强制，**唯一**漏洞是测试自身 |
| `app/admin/(console)/` 下**没有 `loading.tsx`** | **既存缺陷（非本轮引入）** | 该目录的直接子页面出错时，React 无法在 shell 阶段恢复，错误边界渲染不出来，响应变成 500。今天受影响的是 `/admin/platform-config`；`/admin/coupons` 靠页面内 `try/catch` 规避（**这正是它带 try/catch 的唯一理由**，全仓其余页面都不带）。**未修**：修它会改到别的模块的加载边界，超出「只修 P1-4」 |
| 全仓**没有任何页面级 `metadata`** | **既存现象（非本轮引入）** | 与本轮无关，仅登记，不在本轮处理 |
| React 组件行为（发券界面的两个选择列、结算页券列表的渲染） | **只能人工验** | `node --test` 不剥离 JSX，这是本项目测试框架的固有边界（第一轮已登记过同一项） |
| ~~「部分退款会还券」~~ | ✅ **经查**不成立，**不登记** | 曾担心：never-accepted 的单做**部分**退款会还券、而订单还在服务中。**查证后不成立**：`DIRECT_REFUNDABLE_ORDER_STATUSES = ["paid","accepted"]` 那条**直退**路径**没有比例参数**（恒定全额），而带 `refundRatePercent` 的**审批**路径只对 `serving` / `completed` 开放——这两档**必然**已有 `everAcceptedAt`，因此**根本不会还券**。两条路互斥，场景不可达。此处记录**推理过程**而不是记录一个不存在的缺陷 |
| **验收项 5**（模板改动不追溯 · 模板 `disabled` 后不可核销）**没有 UI 复验入口** | ✅ **缺口已独立登记**（2026-09-30） | 本项目**没有 Admin Coupon Template 编辑 / 停用入口**，人工**无法**在界面上把模板改一次、再回来看 Claim 有没有被追溯。⚠️ **规则本身已实现并由自动化测试保护**（`CouponClaim.snapshot` 不受模板后续修改影响 · **当前** `Coupon.enabled` 决定**当前**是否允许核销），短缺的是**入口**而不是**能力**——两件事必须分开读。⚠️ 按裁定**不得并入 `P1-4` 扩大范围**：登记落点为 `总需求进度表.md` 的 `UNASSIGNED` · ⏳ `PLANNED` 行、`api-contract.md` 第四部分「TBD — DO NOT INVENT」，以及本文件 §十二 |

### 11.8 reviewer 结论与处置

审查为**独立只读复核**（未改任何文件、未做任何 Git 写操作），范围是整改轮的全部未提交改动，
逐条对照 `01-prompt.md` §一–§十六。结论：**0 BLOCKER · 0 MAJOR · 2 MINOR · 6 NOTE**。
reviewer 还在本机**独立复跑**了门禁（`pnpm test` 1744/1570/0/174 · `tsc --noEmit` exit 0 ·
`pnpm lint` exit 0），不是引用我的交付记录。

#### 已修：2 条 MINOR（都在我自己的测试文件里）

| MINOR | 落点 | 处置 |
|---|---|---|
| **恒真断言，永远不可能变红** | `tests/couponReturnAndGrant.test.mjs`（§十三.30 用例末行） | 原先写的是 `assert.equal(discount, order.couponDiscountAmount)`，而 `discount` 正是**从 `order` 上读出来的**，且 `order` 在本用例中**从未重新赋值**（退款后的读取写进了 `refunded`）——同一个表达式求值两次，**恒真**。改为 `assert.equal(refunded.couponDiscountAmount, discount)` |
| **断言可代数化简，信息量比看起来小** | 同一用例的「平台净收入」那条 | 两边同减 `refundedAmount`，**代数上退化为** `paid === refunded.actualPaidAmount`（即「退款不改实付」）。这条**本身是有意义的**，只是写法读起来像在验减法。**保留减法但换序 + 注释写明它退化成什么**，不假装它验了更多 |

**我独立复核了这条 MINOR，没有只凭报告采信。** 关键是判断 `order` 到底会不会被后续写入改掉：
`findOrderById`（`mockPaymentRepository.ts:184`）返回的是 **Map 里的活对象、不是克隆**，
而每一处写入都是 `const previous = { ...order }` 之后 `orders.set(id, { ...order, ...patch })`
——**换掉整个条目**，因此 `order` 这个引用**停在退款前那一份**。两处合起来才是「恒真」的完整理由。

**并且做了红-绿证伪**（一条刚被指出是空防线的断言，不能只靠「改完是绿的」就说它现在有牙）：
临时在 `applyOrderRefund` 的写入对象里注入 `couponDiscountAmount: 0`（**故意破坏**
「退款不改抵扣额」），跑该用例 ⇒ **变红**：`AssertionError: 券的抵扣额不参与这条公式
actual: 0, expected: 1000`。⚠️ 注入前那条**旧写法在这个探针下会照样通过**——
这正是「空防线」的含义。随后**逐字节还原**并 `diff` 复核（探针字符串全树 0 处命中）。
修完后**重跑全部门禁**，读数与 §11.4 相同（`pnpm test` 1744/1570/0/174 ·
生产 `APP_BASE_URL` 全量 **1744 / 1744 / 0 / 0**）。

#### 未处置的 NOTE：都是**已登记项**，或**我复核后不同意**

| NOTE | 处置 |
|---|---|
| 核销 → 建单之间的残留窗口（无跨存储事务） | **第一轮已登记**（§七）。reviewer 核对属实并认同该登记，**列入 NOTE 而非缺陷**，因为它修饰的是**今天的 mock 实现**，换真仓储或加一次 `await` 即失效——这正是登记要说的 |
| 打手端订单详情仍显示优惠前 `totalAmount` | **第一轮已登记**（§七 第 4 项）。改动属产品 / UX 判断，不在任何已裁定规则覆盖内，**未自行决定** |
| `CouponClaim.source` 的必填在 `.mjs` 夹具里不生效 | **已登记**（§11.7） |
| `app/admin/(console)/` 直接子级无 `loading.tsx` | **已登记**（§11.7） |
| 还券不记 `restoredAt` | **我自行作出的技术决策**，已在 `couponRedemptionTransaction.ts:145-168` 注释论证（避免第二份「这张券什么时候变的」真值，`refundedAt` 已承载该信息）。reviewer 认同。**留作验收时请产品确认无额外审计诉求** |
| ⚠️ **部分退款（<100%）在「`paid` 且从未 accepted」的订单上也会还券** | ❌ **我复核后不同意它可达**，见下 |

#### ⚠️ 一处我与 reviewer 结论不同：那条部分退款的路径**做不出来**

reviewer 把「管理员批 50% 退款、订单从未被承接 ⇒ 券整张还回」列为需要产品当面确认的**字面结果**。
**方向我同意**（若它能发生，就是 §一 的字面结果），但**这条路径在本仓库不可达**，
因此它不是「今天的行为」，而是一个**做不出来的场景**：

- 带 `refundRatePercent` 的**审批**路径有硬闸：`assertRefundApprovalOrderStatus` 只放行
  `serving` / `completed`（`lib/constants/adminRefunds.ts:243-246`，产品裁定 2026-09-27）；
- 而 `paid` / `accepted` 走的是**直退**路径（`DIRECT_REFUNDABLE_ORDER_STATUSES`，
  `lib/constants/refunds.ts:285`），该路径**没有比例参数**（`directRefundOrder(orderId, at)`）
  ⇒ **恒定全额**，不存在「部分」；
- `serving` / `completed` **必然**已经过 `applyOrderAccepted` ⇒ `everAcceptedAt !== null`
  ⇒ `restoreCouponClaimForOrder` 第一行就 `return null`。

**两条路互斥**（`lib/constants/refunds.ts` 里那两个集合的注释正是这么写的）。因此**无需**为它加裁定。
我把它连同**推理过程**一并写进 §11.7 与 `04-acceptance.md` §7.5，**以免下一轮有人照着这个担忧
去「修」一个不存在的问题**——那会改动一个已被裁定冻结的判据。

#### reviewer 列出的「我无法判断的」三项，逐条回应

1. **§一 在部分退款上的产品意图** —— 见上：场景不可达，**不需要**问产品。
2. **`?mockError=` / `?mockDelay=` 查询串透传到管理页** —— 这是**既有的 Mock 调试约定**，
   全仓 8 个以上管理页同形（我复核过 `searchParams` 的透传是本仓库的固定写法），
   **接入真后端时随 Mock 一起删**。不构成缺陷，**不需要**裁定。
3. **打手端保留优惠前金额** —— **已登记**（第一轮 §七），属产品 / UX 口径，**留给验收时一并决定**。

---

---

## 十二、最终报告（`01-prompt.md` §十六 指定的 10 问）

> 本节是 `P1-4` 的**收口报告**，写在整改轮交付记录（§十一）之后、BLOCKED 附录之前。
> 每一问只给**结论 + 落点**；证据链在正文各节里，不在这里重复。
> ✅ **状态**：`P1-4` 已于 **2026-09-30** 由产品负责人正式裁定收口为 **`DONE`**
> （`Accepted At` 2026-09-30 · `Acceptance` PASSED · `Closing Commit` **`86c28c1`** ·
> `Evidence` 用户本人完成人工验收；裁定依据见 `04-acceptance.md` §8.4）。
> ⚠️ 本节及本轮其余**文档改动保持未提交**，等用户之后自行 `Git commit`。

### 1. 原「账户有券但 checkout 无券」的真实根因

**同一个判断被写了两遍。** 账户页只看 `status` + 快照有效期；结算页还额外看
**券的形态**（只有满减券参与结算）、**模板当前 `enabled`**、**是否达门槛**。
两边**各自都是「对」的**，所以第一轮**全部测试是绿的**却照样出厂——
**没有任何一条测试在问「这两个页面对同一张券的看法一致吗」**。

**修法不是给账户页也补上那几个条件**（那会变成第三遍实现，下次再加条件就再分叉一次），
而是收敛成**一个前置判定** `resolveCouponClaimGate()`（`lib/constants/coupons.ts`），
账户页与结算页**共用**它，因此**结构上不可能**再分叉。详见 §11.1。

### 2. 优惠券何时返还

**判据是「这张订单有没有**曾经**进入过 `accepted`」，不是退款比例，也不是退款那一刻的 `status`。**

- 订单**从未被承接**（`Order.everAcceptedAt` 为空）＋ 退款**实际成功** ⇒ **返还**：
  Claim 从 `used` 回到 `unused` 并**清空 `usedAt`**；
- 订单**曾经被承接** ⇒ **不返还**。

返还的是**未使用资格**，不是一张被作废的券——它**仍要**过 `enabled` / 有效期 / 门槛三道关，
因此「还回来了、但当时确实不可用」是**正确**结果，不是缺陷。
`restoreCouponClaimForOrder` 的入参签名里**根本没有订单金额**
（`Pick<Order, "userId" | "everAcceptedAt" | "coupon">`），所以它**结构上不可能**
改快照 / `actualPaidAmount` / `couponDiscountAmount`。

### 3. 为什么 `accepted → repool → paid` 后退款仍不返

因为「曾经」是一个**只写一次、永不清空**的历史事实，而 `acceptedAt` 是一个**会被清掉**的当前状态。

`accepted →`（打手主动取消 / 客服换人）`→ paid` 会清掉 `acceptedAt`，
但**不会**清掉 `everAcceptedAt`（写入用 `everAcceptedAt ?? input.at`）。
退款那一刻订单看起来是 `paid`，可「曾被承接」**已经发生过**。

⚠️ 因此判据**刻意不看退款瞬间的 `status`**——若看它，这一格会**错误地还券**。
⚠️ **没有**复用排行榜那套 `acceptedVia === "companion"` 判断（裁定 §一.3 明令禁止）：
客服**直接指定**也视为已被承接。验收步骤见 `04-acceptance.md` §七 R9。

### 4. Admin grant 数据模型

**没有第二套系统。** 发放**复用**同一份券数据：管理员发出去的是一条**普通的 `CouponClaim`**，
与用户自己领的**同一个类型、同一个仓储、同一个快照结构**，只是多一个来源字段
`source: "self_claim" | "admin_grant"`，以及**最小审计** `grantedByAdminId`。
**不建 Ledger、不建独立的「发放记录」表**（裁定 §六：不建复杂营销 Ledger）。

接口三个，全部 `await requireAdmin()` 打头：模板列表 / 用户搜索 / 发放。
⚠️ `grantedByAdminId` **不下发到用户侧 DTO**（已实测确认不泄漏）。

### 5. self-claim 与 admin-grant 如何共存

**两条规则不同，但共用同一份数据**：

| | self-claim | admin-grant |
|---|---|---|
| 幂等 | **同一用户 + 同一模板只能领一次**（`claimIdByCoupon` 业务唯一键） | **可重复发放**，每次生成**独立** Claim |
| 用途 | 用户在券包里自己领 | 管理员定向补偿 / 运营发放 |

因此 `checkout` **不能**用「用户 + 模板」反查 Claim——那样两次管理员发放会被认成同一张。
**前端只传 `couponClaimId`**，服务端按**这一个 id** 识别是哪一张。

### 6. Claim snapshot 与 current enabled 如何分工

**两个时间点，各管各的**：

- **`CouponClaim.snapshot`（领取那一刻冻结）** 管**金额与门槛**：
  后台改模板**不追溯**已领取的记录；
- **`Coupon.enabled`（当前值）** 管**此刻能不能核销**：
  模板停用后，旧 Claim **仍在券包里**，只是**不可用**。

这条分工**已经定死**，由本轮唯一的**前置判定** `resolveCouponClaimGate()` 实现。

⚠️ **这就是验收项 5**，而它**目前无法 UI 复验**：本项目**没有**券模板编辑 / 停用入口——
缺的是**入口**，不是**能力**。规则由自动化测试继续保护，缺口已**独立登记**
（§11.7 新增行 · `04-acceptance.md` §八 8.3），**不并入本轮**。

### 7. checkout 如何展示「有券但门槛不足」

**展示、禁用、并给出原因——不是隐藏。**

- 服务端的**八项复查**（裁定 §十一）**只信 `couponClaimId`**，
  **不信任**前端传的 `discountAmount` / `thresholdAmount` / `couponDiscountAmount`；
- 门槛不足时返回 `applicable: false` + `code: "threshold_not_met"` + 文案，
  由 `loadCheckoutCoupons()` 的那**一行**保留在列表里
  （`if (!application.applicable && application.code !== "threshold_not_met") continue;`）——
  **这一行就是裁定 §十**；
- 文案直接告诉用户**还差多少**：「满 ¥100.00 可用，还差 ¥70.10」——
  金额**一律走 `formatYuan`（恒两位小数）**，不再有第二个「去尾零」的口径。

### 8. 原子核销 / 退款返券如何保证

**「核销 + 建单」与「退款 + 返券」各自写在一段没有 `await` 的同步区段里**
（Node 单线程下这段即为原子）：

- **核销**：`lib/data/couponRedemptionTransaction.ts`，**只在支付成功那一刻**发生一次——
  试算不消耗、支付失败不作废、双花被拒（有专门的单测钉住）；
- **返券**：退款**实际成功**后，在同一段同步区段内把 Claim 改回 `unused` 并清 `usedAt`。

⚠️ **如实登记的架构边界**：「核销成功 → 建单」这一段**架构上关不严**——
订单与核销记录在**两个 Mock 存储**上，**没有跨存储事务**。本轮只把它**收窄到无 `await`**
并用**结构断言**钉住，**换真仓储时必须重新处理**（§11.7）。
⚠️ 另一处**经查不成立**的担忧（「部分退款也会还券」）也记在 §11.7，附完整推理，
以免下一轮有人照着这个担忧去「修」一个不存在的问题。

### 9. 测试与 reviewer 结果

- **定向**：`tests/couponReturnAndGrant.test.mjs` **43 条**（A 13 / B 10 / C 8 / D 12）
  ＋ 横向 `coupon` / `refund` / `checkout` / `admin` 组，**85 / 85 pass**；
- **门禁终值（最终树）**：`pnpm test` **1744 · pass 1570 · fail 0 · skipped 174** ·
  生产 `APP_BASE_URL` 全量 **1744 / 1744 pass · fail 0 · skipped 0** ·
  `typecheck` / `lint` / `build` 均 **exit 0**；
- **红-绿证伪 3 个探针**，最能说明问题的一条是：**从单一前置判定里拿掉形态检查
  ⇒ 裁定 §十四 与两条 §九 同时变红**——即**根因那一类缺陷会被抓住**，
  这正是第二轮存在的理由；
- **reviewer 独立只读复核：0 BLOCKER · 0 MAJOR · 2 MINOR · 6 NOTE**（§11.8）。
  两条 MINOR 都在**我自己的测试文件**里（一条恒真断言、一条代数上退化的断言），
  **均已修**并**逐条做了红-绿验证**（注入错误 ⇒ 断言真的变红 ⇒ 还原后 `diff` 为空）；
  未处置的 NOTE 都是**已登记项**或**我复核后不同意**——其中「部分退款会还券」那条
  **我不同意 reviewer 的怀疑**，并给出了该路径不可达的证明。
  **`BLOCKER = 0` · `MAJOR = 0` · `fail = 0` 的门槛已满足。**

### 10. 人工复验最短路径

> ⚠️ 人工复验**已于 2026-09-30 完成，结论 `PASSED`**（逐项见 `04-acceptance.md` §八 8.1 / 8.2）。
> 下面保留**最短路径**本身，供将来回归时复用。

`04-acceptance.md` **§七**（R1–R15），最短顺序是三段：

1. **R1 → R2 → R3 → R4**：账户页逐张记下可用性 → 结算页**必须给得出**那张券并真的减 ¥10.00
   → 改成 1 件后**仍在列表里但禁用**、并写明差额 → 反复切换**当场跟着变**。
   **R2 / R3 就是人工验收那个缺陷的回归。**
2. **R5 → R6 → R7 → R8 → R9**：券订单支付成功 → `paid` 单走**免审批直退** → 券回「未使用」
   且**可以再用** → 换一张**让打手接单后**退款**不返** → 再验「**曾经**」的边界
   （接单后主动取消回 `paid`，退款**仍然不返**）。
3. **R10 → R15**：`/admin/coupons` **只列 `enabled` 模板** → 搜用户并看到**持有数** →
   发给没领过的人 → **同模板再发一次仍允许**（两张独立可用）→ 过期模板给**警告不是拦截** →
   未登录访问 **401**。

**§7.4 是回归护栏**：第一轮已验过的几组（三行金额 · 不合规券**显式拒绝** ·
只在**支付成功那一刻**核销 · 四处「实付」同一个数 · 消费额按**实付**计入 · 权限与归属）
**若出现任何变化都是回归，直接记不通过**。

⚠️ **验收项 5 不在上面这条路径里**——**本项目没有券模板编辑 / 停用入口**，
人工**做不出来**；它由自动化测试保护，缺口已独立登记（§11.7 · §八 8.3）。

---

# 附录：BLOCKED 期交付记录（原文保留，不改写）

> 以下是本文件在 P1-4 处于 `BLOCKED` 时写的版本，记录的是**不依赖任何未冻结规则**的那部分工作。
> 它的结论在当时成立，现在读它必须注意：它说的「业务代码零改动」**仅指当时**——
> 阻塞解除后业务代码已全面改动。原文一字未改。

---

# P1-4 交付记录

Status: **BLOCKED**（核心目标未交付；本文件只记录**已冻结子项**的核查与测试交付）
日期: 2026-09-29（夜间连续开发批次）

> ⚠️ **本文件不是「完成」记录。** `cmd_p1-4.md` 的 Goal（券在**结算 / 下单 / 支付 / 订单快照**中的一致性）
> 一行代码都没写，理由与逐项裁定见 `02-decisions.md`。这里记录的是**不依赖任何未冻结规则**的那部分工作。

---

## 一、交付物清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `tests/couponMoneyChain.test.mjs` | **新增**（463 行 / 15 用例） | 「有券口径」的金额不变量回归保护 |

**业务代码零改动。** 具体地说，下面这些**一个字节都没改**：

```
lib/types/coupon.ts        lib/services/coupons.ts      lib/services/checkout.ts
lib/constants/coupons.ts   lib/data/couponRepository.ts lib/constants/orderAmount.ts
lib/data/mockCouponRepository.ts
app/(mobile)/coupons/page.tsx   app/api/coupons/route.ts   app/api/coupons/[id]/claim/route.ts
```

`lib/services/checkout.ts:244` 的 `couponDiscountAmount: 0` **保持原样**——
它是「券尚未接入结算」这件事在代码里的唯一落点。

---

## 二、这组测试补的是什么空白

核查时确认了一个**此前没有任何测试覆盖**的事实：

```
$ grep -rn "couponDiscountAmount: *[1-9]" tests/
（无输出）
```

`resolveOrderMoneyDomain()`（`lib/constants/orderAmount.ts:152`）是**全站唯一的订单金额合成点**
（`lib/services/checkout.ts` 的下单与 `lib/mocks/fixtures/orderSeed.ts` 的种子都调它），
但在此之前**没有任何测试用非零的 `couponDiscountAmount` 调用过它**。

现有的 `tests/orderAmountSplit.test.mjs:97`（用例名写着「券由平台承担」）是**绕过合成点**、
直接拿手写数字调 `resolveClubNetIncome(2000, 3200)` 验证负数分支的。

→ 也就是说：**「券进入合成点之后，整条金额链仍然成立」此前只是推论。**
本组测试把它变成了被验证的事实，而且验证的全部是**需求已冻结**的规则
（业务流程表 BF-04 / BF-05 / §18），**不含任何产品裁定**。

---

## 三、15 条用例与其保护的规则

| # | 用例 | 保护的规则 | 出处 |
|---|---|---|---|
| 1 | §18 原始算例：原价 5000 / 分账 80% / 券 1000 → 实付 4000、打手 4000、平台 0 | 需求 §18 的原文算例（元换算成**分**） | 业务流程表 §18 |
| 2 | 恒等式在有券时成立（6 组非零券） | `打手收益 + 平台净收入 === 实付`，且 `实付 === 原价 − 券` | BF-04 / BF-05 |
| 3 | 券不改变 `originalAmount` | §18「不改变 originalAmount」 | §18 |
| 4 | 券不改变 `companionRateSnapshot`（4 比例 × 4 券额） | §18「不改变 companionRateSnapshot」 | §18 |
| 5 | 券不降低打手基础收益（券 0 / 1000 / 3000 三次**显式相等**） | **优惠不转嫁给打手** | §18 / BF-05 |
| 6 | 券 2000 → 平台净收入 `=== -1200`，为负且**不被夹到 0** | BF-05「允许 `clubNetIncome < 0`」 | BF-05 |
| 7 | 极端：券 = 原价 → 实付 0、平台净收入 = −打手收益，不抛错 | 恒等式的边界外推 | BF-05 |
| 8 | 全部输出为整数分 | BF-05「全部金额以整数分计算」 | BF-05 |
| 9 | 退款基数 = 实付；100% 时精确等于实付 | P0-15 退款基数口径 | P0-15 |
| 10 | 冲回额与比例无关：退 10% 与退 100% 的 `companionReversalAmount` **相等** | P0-15 §三「整笔、不乘比例」 | P0-15 |
| 11 | 平台最终净收入 = 实付 − 退款额，100% 时为 0 | P0-15 §四 | P0-15 |
| 12 | 不得超退：退满通过，多退 1 分被拒 | P0-13 §一金额闸 | P0-13 |
| 13 | `isFullyRefunded` 的有券口径 | 「full refund 才进 refunded」 | P0-13 |
| 14 | `OrderMoneyDomain` 键集合**精确固定** | 防未来偷偷加/删字段 | 结构约束 |
| 15 | 无券口径不回归 | 既有行为 | 回归基线 |

---

## 四、验证

### 4.1 定点运行（新增文件）

```
$ node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs --test tests/couponMoneyChain.test.mjs
ℹ tests 15
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

### 4.2 全量 `pnpm test`

```
ℹ tests 1583
ℹ pass 1415
ℹ fail 0
ℹ cancelled 0
ℹ skipped 168
```

（1583 − 15 = 1568 为本批次开始前的既有用例数；`skipped 168` 是需要 `APP_BASE_URL` 的 HTTP 冒烟批次，
未起服务时自动跳过，与本改动无关——production 全量会在最终门禁里单独跑。）

> ⚠️ **2026-09-29 夜间批次终值覆盖（P1-3 交付后复核）**
>
> 上面那组读数是 P1-4 交付当时的**中间读数**，当时 P1-3 的用例还没落进 `tests/`。
> 整批任务收尾时按计划复跑，**本轮自身的结论不变**，数字变更全部来自 P1-3 新增的用例：
>
> | 读数 | P1-4 交付时（上方） | 夜间批次终值（P1-3 交付后） | 差值 |
> |---|---|---|---|
> | `tests` | 1583 | **1612** | +29 |
> | `pass` | 1415 | **1443** | +28 |
> | `fail` | 0 | **0** | 0 |
> | `skipped` | 168 | **169** | +1 |
>
> 差值逐项对得上：`1612 − 1583 = 29` 正是 `tests/aftersalesWorkbench.test.mjs` 的用例数
> （首版 25 条 → 交付前整改后 **29** 条）；`+28 pass / +1 skipped` 是其中 28 条纯逻辑用例通过、
> 1 条 HTTP 鉴权用例在未起服务时按设计跳过。该条在 production 全量里**不跳过**（见下）。
>
> **production 全量（`APP_BASE_URL` 已设，真实 `next start` 服务）终值**：
>
> ```
> ℹ tests 1612   ℹ pass 1612   ℹ fail 0   ℹ skipped 0
> ```
>
> 即 169 条 `APP_BASE_URL` 用例**全部真实执行**且全绿——P1-4 当初留的「production 全量在最终门禁里单独跑」
> 这一条已经兑现，不再是待办。上面那句「与本改动无关」的免责不再需要读者自行采信。

### 4.3 红绿验证（**这组测试真的会红**）

新增断言首跑即全绿——因为被验证的规则**本来就是对的**，这属于「特性固化」而非「修 bug」，
所以必须另外证明**这些断言有杀伤力**，否则它们可能是一组恒真的空断言。

注入式探针：把 `lib/constants/orderAmount.ts` 的 `resolveOrderMoneyDomain()` 第 3 步
从 `resolveCompanionRevenueBase(input.itemsAmount, input.addonsAmount)`
**临时改成** `resolveCompanionRevenueBase(actualPaidAmount, input.addonsAmount)`
——即「优惠压低打手分成基数」这个**最典型的错误结论**：

```
ℹ tests 15
ℹ pass 10
ℹ fail 5
```

失败样例原文（节选）：

```
✖ 冲回额与退款比例无关：同一笔实付下，退 10% 与退 100% 的 companionReversalAmount 相等
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  3200 !== 4000
```

→ **15 条里 5 条同时变红**，说明这组断言确实钉在公式上，不是装饰。

探针**已还原**，还原后 `git diff lib/constants/orderAmount.ts` 无内容差异，`15/15` 复绿。

---

## 五、这组测试**不能**替代什么（交付边界）

| 未覆盖 | 为什么 |
|---|---|
| 券参与下单 / 核销 | `checkout.ts` 仍写死 0；接入规则**未冻结**（`02-decisions.md` §三） |
| 门槛 / 适用范围 / 折扣率语义 / 叠加 / 使用次数 / 券快照 | 同上：这些规则**不存在**，为它们写断言等于替产品做决定 |
| 端到端「某订单真的产生非零券」 | 需要券先接入 checkout。⚠️ **接入之后必须补一条端到端用例**，本文件不能替代 |
| UI 呈现（结算页「原金额 / 优惠 / 实付」三行） | `node --test` 不剥离 JSX，组件行为测不到；且券恒为 0 时渲染这一行等于造一个永远为 0 的行 |

---

## 六、解除阻塞后要接着做的事（备忘）

1. 按产品答复实现券的数值语义与 `Coupon` 字段（或新建券规则表）。
2. `lib/services/checkout.ts` 打开 `couponDiscountAmount` 的服务端计算（**不从请求里读金额**）。
3. 订单上加券快照（粒度按产品答复），并补「后台改券不追溯历史订单」的用例。
4. 补端到端用例：下单产出非零券的订单 → 实付 / 打手收益 / 平台净收入 / 退款四项一起断言。
5. 结算页与订单详情的「原金额 / 优惠 / 实付」三行展示。

> **以上 5 条备忘现已全部兑现**——端到端用例即 `tests/couponCheckoutChain.test.mjs` 的 24 条。
