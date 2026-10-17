# P1-4 决策与阻塞记录

Status: **BLOCKED → READY → IN_PROGRESS**（2026-09-29 产品负责人正式裁定，见 §七）
日期: 2026-09-29（夜间连续开发批次）· 2026-09-29 解除阻塞

> 📌 **§一 – §六 是「阻塞期」的记录，保留原样不改写**（它们如实记录了解除阻塞之前的状态与依据）。
> **解除阻塞的裁定与据此形成的设计决策在 §七**——两者冲突时**以 §七 为准**，
> 因为 §一–§六 的一切结论都建立在「营销规则未冻结」这个前提上，而该前提已被裁定取代。

---

## 一、结论

**P1-4 = BLOCKED。**

`cmd_p1-4.md` 的目标是「修复/补齐 Coupon 在**结算、下单、支付、订单快照**、退款、平台收入、打手收益中的一致性」。
Requirement Check 的结果是：这条链路的**前半段（结算 / 下单 / 支付 / 订单快照）根本没有实现，
而且权威需求把它明确标为「尚未接入」**；同时「券的适用范围、叠加与排他规则」被仓库自己写成了
**先决条件**——在它们被确认之前实现金额计算，被代码里写死为「提前替产品做了决定」。

因此本轮**不能**完成 Goal。按 `cmd_p1-4.md` 的 Requirement Check 条款
「未冻结的营销规则**不得自行发明**」与夜间防卡死规则第 1、2、4 条：不猜、标 BLOCKED、不修改争议业务代码。

**已冻结的部分**（券的成本由平台承担、券不改变原价与分账比例、平台净收入允许为负、
退款以实付为基数、P0-15 的一单一退与收益归零）**已核查确认成立，并补了一组回归测试**
（§五）——这部分不需要任何产品决定，也不改业务代码。

---

## 二、Requirement Check 原文证据

### 2.1 权威需求把「券接入结算」明确标为未实现

`docs/01-requirements/超哥电竞_业务流程表.md:164-172`（BF-04 金额域）：

```
优惠券接入后：

    actualPaidAmount = originalAmount - couponDiscountAmount

当前优惠券尚未正式接入 checkout 计算与核销。

状态：✅ 金额域已实现；优惠券接入 ⏳
```

同上文件 §18「优惠券」（`:989-1011`）：

```
# 18. 优惠券

优惠券成本由平台承担。

优惠券：
- 不改变 originalAmount；
- 不改变 companionRateSnapshot；
- 不降低 companionBaseIncome 的理论基础。

示例：原价 50 / 分账 80% / 优惠券 10 / 实际支付 40
      打手基础收益 = 40，平台基础净收入 = 0

状态：领取/展示有基础；正式 checkout 核销 ⏳。
```

→ 「⏳」在该仓库的约定是**尚未实现**（`CLAUDE.md`：「TARGET 一律标注 `NOT IMPLEMENTED` 的一律是**尚未实现**，
不得当作已有能力使用」）。也就是说：**金额域的公式已经就位，但「券进入结算」这件事在需求侧仍挂着。**

### 2.2 代码自己把「引入金额字段与核销」写成了先决条件

`lib/types/coupon.ts:6-14`（原文）：

```
 * ⚠️ 本阶段的优惠券是**展示用的 Mock 券面**，刻意不参与任何金额计算：
 * - 券面值（`valueLabel`）只是一句展示文案，不是可参与运算的数字，因此不存在
 *   「满减怎么算、能不能叠加、能不能与折扣同享」这类尚未确认的规则；
 * - 结算（P4）完全不读这里的数据，`lib/services/checkout.ts` 也不会引用本模块，
 *   所以领券不会让订单金额发生变化——这是本阶段最重要的一条边界。
 * 将来确认了券的适用范围、叠加与排他规则之后，再引入金额字段与核销逻辑；
 * 在那之前，任何「顺手算一下能减多少」的实现都是提前替产品做了决定。
```

`lib/services/coupons.ts:20-27` 第 4 条硬规则：

```
 * 4. **优惠券不参与结算**。本文件没有任何金额运算，也不引用订单 / 支付 / 结算模块：
 *    领券不会改变订单金额，也没有核销入口。券面值是展示文案。
```

→ **这两处不是「还没做」，而是「被主动禁掉了，等产品规则」**。它们是本轮最直接的阻塞依据：
我要实现的正是被这两段注释点名禁止的那件事。

### 2.3 券类型里**没有**任何可参与运算的数值

`lib/types/coupon.ts:16-30`：

```ts
export type CouponFormKey = "threshold" | "discount" | "gift";  // 只作为展示分类，不是计算规则
export type CouponSnapshot = { name; formKey; formLabel; valueLabel; conditionLabel; validFrom; validTo };
export type Coupon = CouponSnapshot & { id: string; enabled: boolean };
export type CouponClaimStatus = "unused" | "used";
export type CouponClaim = { id; userId; couponId; status; claimedAt; usedAt; snapshot };
```

| cmd_p1-4.md 要求 | 现状 | 结论 |
|---|---|---|
| 券面额（参与运算的数） | `valueLabel` 是**展示文案**，无数值字段 | **缺** |
| 门槛 | `conditionLabel` 是**展示文案** | **缺** |
| 适用范围 | 需求 `couponSeed.ts` 自述「适用范围待确认」 | **缺** |
| 叠加 / 排他 | 无任何字段或规则 | **缺** |
| 使用次数 | `CouponClaimStatus` 只有 `unused/used`（领了没用），**没有「一单只能用一张」之外的任何次数规则** | **缺** |
| 有效期 | `validFrom` / `validTo` 有，且 `couponClaimability()` 已实现 | **有**（但只用于**领取**） |
| 启用 | `Coupon.enabled` 有，`couponClaimability()` 已实现 | **有**（但只用于**领取**） |

→ `CouponFormKey` 的分档本身就说明问题：**「满减」「折扣」「赠品」三种形态需要的金额语义各不相同**
（满减要「减多少」，折扣要「打几折」，赠品根本没有金额），
先决定用哪一种、再决定数值字段长什么样，**正是产品裁定的内容**。

### 2.4 结算前的最后一环：服务端把抵扣写死为 0

`lib/services/checkout.ts:236-245`：

```ts
    // P0 没有优惠券：抵扣恒为 0（P1 接入时，券的金额由服务端算，不从请求里读）
    couponDiscountAmount: 0,
```

→ 唯一的下单入口**不接受任何券参数**，`resolveOrderMoneyDomain()` 的 `couponDiscountAmount` 恒为 0。
「券快照」因此也无从谈起：订单上没有可冻结的券字段（`OrderMoneyDomain` 只有
`couponDiscountAmount` 这个**数字**，没有 coupon id / 展示信息 / 规则快照）。

### 2.5 已冻结、且**已经成立**的部分（本轮核查确认）

| 冻结规则（出处） | 现状 | 凭证 |
|---|---|---|
| `actualPaidAmount = originalAmount − couponDiscountAmount` | ✅ 已实现 | `lib/constants/orderAmount.ts:152-178` `resolveOrderMoneyDomain()` 第 1–2 步 |
| 券**不改变** `originalAmount` | ✅ 已实现 | 同上，`originalAmount` 由 `itemsAmount + addonsAmount` 独立算出 |
| 券**不改变** `companionRateSnapshot` | ✅ 已实现 | 快照直接取 `input.companionRateBp`，与券无关 |
| 券**不降低** `companionBaseIncome` 的理论基础 | ✅ 已实现 | `resolveCompanionRevenueBase(itemsAmount, addonsAmount)`（`:94-96`）**不接收**券参数 |
| `couponDiscountAmount >= 0` / `actualPaidAmount >= 0` | ✅ 由调用方保证 | 服务端常量 0（`checkout.ts:244`）；尚无其它写入点 |
| `clubNetIncome` **允许为负**（券由平台承担） | ✅ 已实现 | `resolveClubNetIncome()` 刻意不夹到 0，`orderAmount.ts:70-77` |
| 退款基数是 `actualPaidAmount` | ✅ 已实现 | `refundAmount = floor(actualPaidAmount × refundRateBp / 10000)`（P0-15） |
| 不得超退 | ✅ 已实现 | `mockPaymentRepository` 的 `refundedAmount >= actualPaidAmount` 短路闸 |
| approved refund 后 companion net 归零 | ✅ 已实现 | P0-15 §三（整笔 `companionReversalAmount`） |
| `platform final net = actualPaidAmount − refundAmount` | ✅ 已实现 | `lib/constants/refunds.ts:631` `platformNetIncome()`（P0-15 新增） |
| preview 与最终创建一致 | ✅ **结构性成立** | `previewCheckout()` 与下单**共用** `resolveMoneyDomainForSelection()`（`checkout.ts:236-256`） |

→ 结论：**账算得是对的，但没有任何一条在「有券」的输入下被验证过**
（§五说明这一点为什么值得补测试）。阻塞的不是公式，是**券本身**。

---

## 三、最小阻塞问题（需要产品负责人回答）

核心只有一问，其余是它的展开：

> **Q：优惠券从「展示券面」变成「能抵扣的钱」，它的具体规则是什么？**
>
> 1. **券形态与面额语义**：`threshold`(满减) / `discount`(折扣) / `gift`(赠品) 三种，
>    本轮先支持哪一种？各自的金额怎么表达（立减 X 分？打 X 折？X 折的基数是原价还是分账基数？）。
>    赠品券若参与，它减的是哪部分钱（还是完全不减钱）？
> 2. **门槛**：满减的「满」是多少？按 `originalAmount` 还是按某类商品金额？
>    未达门槛时是**拒绝使用**还是**不抵扣**？
> 3. **适用范围**：限定商品 / 类目 / 全场？`couponSeed.ts` 自述「适用范围待确认」，需要一句明确口径。
> 4. **叠加与排他**：一单能用几张券？能否与将来的其它优惠同享？
>    （`cmd_p1-4.md` 已写「券叠加（**除非已有需求明确**）」→ 当前需求未明确，因此需要答复。）
> 5. **使用限制**：一单一张以外还有没有限制（每用户每券一次？每人每天？）？
>    券在订单**取消/退款**后是否退回？退回的是「未使用」还是原状态？
> 6. **发券流程**：券从哪来——只有种子数据 / 管理员配置 / 用户领取？是否需要「一键领券」之外的发放入口？
>    （`cmd_p1-4.md` 的「不做」清单里没有排除它，但也没有需求，故需确认。）
> 7. **有效期时长规则**：现有 `validFrom/validTo` 是**逐券硬编码的日期**。
>    是否需要「领取后 N 天有效」这类相对规则？若是，属于本轮还是后续？
> 8. **券快照粒度**：订单上要冻结到什么程度——仅 `couponId` + 抵扣金额，
>    还是连同券面文案（`name/valueLabel/conditionLabel`）一起冻结？
>    （`cmd_p1-4.md` 说「至少核查 coupon id、展示信息（如需要）、discount amount、必要规则快照」——
>    「如需要」与「必要」两处措辞把粒度留给了产品。）

### 3.1 为什么不能「先按最简单的满减做出来」

- `lib/types/coupon.ts:13-14` 把这件事写成了**先决条件**：「将来确认了券的适用范围、叠加与排他规则之后，
  再引入金额字段与核销逻辑；**在那之前，任何「顺手算一下能减多少」的实现都是提前替产品做了决定**。」
- `lib/services/coupons.ts:20` 第 4 条硬规则「优惠券不参与结算」是**当前已交付并已被测试锁住**的行为
  （`tests/coupons.test.mjs`）。单方面打开它，等于同时推翻两处书面约定。
- 券的口径是**用户可见的金额**：改口径意味着已展示的「实付」会变。这不是「先搭架子回头改数字」。

因此本轮**不打开**这道闸，只把已冻结的部分钉牢（§五）。

---

## 四、本轮未改动的文件（「不修改有争议业务代码」的凭证）

业务代码**零改动**。以下文件在 2026-09-29 本批次中未修改：

```
lib/types/coupon.ts
lib/services/coupons.ts
lib/services/couponsHttp.ts
lib/constants/coupons.ts
lib/data/couponRepository.ts
lib/data/mockCouponRepository.ts
app/(mobile)/coupons/page.tsx
app/api/coupons/route.ts
app/api/coupons/[id]/claim/route.ts
lib/services/checkout.ts                       # checkout 仍写死 couponDiscountAmount: 0
lib/constants/orderAmount.ts
app/admin/(console)/refunds/[id]/page.tsx
```

`lib/services/checkout.ts:244` 的 `couponDiscountAmount: 0` **保持不变**——
它是「券尚未接入」这件事在代码里的唯一落点，本轮不碰。

---

## 五、已冻结子项的交付：一组「有券口径」的金额不变量测试

### 5.1 为什么值得补

核查时发现一个**真实的空白**：`resolveOrderMoneyDomain()` 是全站唯一的金额合成点，
但**全仓库没有任何一个测试用非零的 `couponDiscountAmount` 调用过它**：

```
$ grep -rn "couponDiscountAmount: *[1-9]" tests/
（无输出）
```

现有的 `tests/orderAmountSplit.test.mjs:97` 那条「券由平台承担」用例，
是**绕过合成点**、直接拿手写数字调 `resolveClubNetIncome(2000, 3200)` 验证的；
`resolveOrderMoneyDomain()` 只在 `couponDiscountAmount: 0` 下被调用过。

→ 也就是说：**「有券时账仍然对」这件事目前只是推论，不是被验证过的事实。**
而需求 §18 与 BF-05 早已把它冻死了（券不改变原价 / 不降低分账基数 / 平台承担成本 / 允许负净收入），
所以**补这组测试不需要任何产品决定**：它验证的全部是已冻结的规则。

### 5.2 cmd_p1-4.md 测试清单的逐项裁定

| # | 测试项 | 本轮 | 依据 |
|---|---|---|---|
| 1 | 无券 | ✅ 可交付 | 现状即无券；断言实付 = 原价 |
| 2 | **有券** | ⛔ **BLOCKED** | 下单入口不接受券（`checkout.ts:244` 常量 0），券无面额字段 |
| 3 | 实付计算 | ✅ 可交付 | `resolveOrderMoneyDomain()` 可直接喂非零券 |
| 4 | 优惠不压低 companion base income | ✅ 可交付 | 已冻结（BF-04/BF-05） |
| 5 | platform 承担优惠 | ✅ 可交付 | 已冻结（`clubNetIncome` 允许为负） |
| 6 | **券修改不追溯历史订单** | ⛔ **BLOCKED** | 订单上没有券快照可冻结——无「券」可改 |
| 7 | disabled 券拒绝 | ◐ **仅领取路径** | `couponClaimability()` 已实现且已测；**核销**路径不存在 |
| 8 | 过期券拒绝 | ◐ **仅领取路径** | 同上（`validFrom/validTo` + `now` 注入已就绪） |
| 9 | **门槛边界** | ⛔ **BLOCKED** | 门槛规则与数值字段均不存在 |
| 10 | preview 与最终创建一致 | ◐ **无券口径** | 两者共用同一函数，结构上一致；**有券**口径需等 Q1 |
| 11 | 退款不超过 actualPaidAmount | ✅ 可交付 | P0-15 已有，本轮补「有券基数」口径 |
| 12 | 10/50/100% refund + coupon | ✅ 可交付 | 退款公式以实付为基数，纯函数可喂非零券 |
| 13 | approved refund 后 companion net=0 | ✅ 可交付 | P0-15 已实现（避免重复：仅补有券口径的差异断言） |
| 14 | platform net 正确 | ✅ 可交付 | `platformNetIncome()` 已实现 |
| 15 | DTO exact keys | ✅ 可交付 | 无券口径 |
| 16 | 金额整数分 | ✅ 可交付 | 向下取整只在护航收益一处 |
| 17 | checkout/order/admin 展示一致 | ◐ **无券口径** | 「原金额 / 优惠 / 实付」三行展示 → BLOCKED（券恒 0，渲染它等于造一个永远为 0 的行） |
| 18 | 无券链路不回归 | ✅ 可交付 | |

→ 18 项里：**10 项可交付、4 项部分、4 项 BLOCKED**。
交付的部分全部落在**已冻结规则**上，不含任何产品裁定。

### 5.3 交付边界（必须说清）

- 这组测试**不改变任何业务行为**：不新增金额字段、不打开 checkout、不动券仓库。
- 它**不构成 P1-4 的完成**：Goal 里的「结算 / 下单 / 支付 / 订单快照」四项仍是零实现。
- 它的作用是：**当产品答复 §三 之后，接券的人不必先怀疑账算得对不对**——
  公式在有券输入下已经被钉住了。

---

## 六、夜间批次的处置（按 cmd_p1-4.md 与防卡死规则）

| 要求 | 执行 |
|---|---|
| 未冻结的营销规则不得自行发明 | ✅ 未写任何券的金额/门槛/适用范围逻辑 |
| 如某营销子规则未冻结，只将对应子项 BLOCKED | ✅ §5.2 逐项标注 |
| 不要让整批停止，继续 P1-5 | ✅ 已继续 |
| 不修改争议业务代码 | ✅ §四 |
| 不做新营销玩法 / 券叠加 / 会员 / 积分 / 钱包 / 真支付 | ✅ 未涉及 |
| 禁止 Git 写操作 | ✅ 未执行任何 Git 写命令 |

**解除阻塞的唯一条件**：产品负责人回答 §三 的八问（核心是 Q1 券形态与面额语义）。
答完之后 P1-4 可进 `IN_PROGRESS`，公式侧的基础设施（`resolveOrderMoneyDomain` 的券入参、
`couponClaimability` 的合法性判定、金额域恒等式测试）**都已就绪**。

---

## 七、产品裁定（2026-09-29）与据此形成的设计决策

**产品负责人已正式裁定 P1-4 的营销规则。** 裁定关闭了 §三 的全部八问，
因此「未冻结的营销规则」这一阻塞前提**不再成立**，P1-4 由 `BLOCKED` 进 `READY → IN_PROGRESS`。

### 7.0 裁定要点（原文十条，逐条对应下方决策）

| # | 裁定 |
|---|---|
| 1 | 只让 `threshold` 满减券参与 checkout / payment / order snapshot / refund；新增可计算字段 `thresholdAmount` / `discountAmount`（整数分）。`discount` / `gift` 继续只作展示，**不得自行补计算语义** |
| 2 | 门槛基数 = `originalAmount`；`originalAmount >= thresholdAmount` 才可用；抵扣 = `discountAmount`；必须保证 `couponDiscountAmount <= originalAmount` 且 `actualPaidAmount >= 0`；未达门槛**服务端明确拒绝**，不得静默按 0 元优惠继续下单 |
| 3 | 只支持**全场券**；不做指定商品/类目/黑白名单/scope DSL |
| 4 | 一单最多 1 张，券之间不可叠加；未来其它营销默认不与券叠加；本轮不建促销叠加系统 |
| 5 | 同一 User 对同一 Coupon 最多领一次；一张 `CouponClaim` `unused → used` **只能成功核销一次**；核销必须发生在**真实成功形成订单/支付结果的原子业务流程中**；preview 不消耗；下单/支付失败**不得**把券永久标记 used |
| 6 | 订单成功用券后，**退款不返还优惠券**；退款金额严格基于 `actualPaidAmount`，不得按 `originalAmount` 多退 |
| 7 | 发券方式保持现状（Mock seed / 已有管理员券配置 + 用户主动领取）；不加人工赠券/注册赠券/活动自动发券/定向发券 |
| 8 | 有效期继续用 `validFrom` / `validTo` 绝对有效期；不实现「领取后 N 天有效」 |
| 9 | 订单快照至少冻结 `couponId` / `name` / `formKey` / `thresholdAmount` / `discountAmount` / `valueLabel` / `conditionLabel`；并保留金额域的 `couponDiscountAmount`；**后台改券不得改变历史订单金额与历史券展示** |
| 10 | 经济规则保持：券不改变 `originalAmount` / 不改变 `companionRateSnapshot` / 不降低 `companionBaseIncome` 理论基础 / 成本由平台承担 / platform net 可为负；退款基于 `actualPaidAmount`、不得超退、一单一退、approved refund 后 companion net = 0、`platform final net = actualPaidAmount - refundAmount` |

### 7.1 设计决策

#### D-P1-4-1｜只有 `threshold` 参与结算；另外两种**显式拒绝**，不静默归零

`formKey !== "threshold"` 的券在结算时**被服务端拒绝**，报错文案说明「该券类型暂不支持抵扣」。
理由是裁定第 1 条同时说了两件事：「只让 threshold 参与」与「不得自行补计算语义」——
若对 `discount` / `gift` 静默按 0 元处理，用户会以为券生效了却一分没减，
那正好是裁定第 2 条禁止的「静默按 0 元优惠继续下单」的同一种坏形状。

#### D-P1-4-2｜两个新字段进 `CouponSnapshot`，不只进 `Coupon` ⇒ **领取即锁价**

裁定第 9 条的冻结清单里，`name` / `formKey` / `valueLabel` / `conditionLabel` **本来就是
`CouponSnapshot` 的四个字段**（`lib/types/coupon.ts:24-37`）。把 `thresholdAmount` /
`discountAmount` 放进**同一个形状**而不是只挂在 `Coupon` 上，于是「订单券快照」
= `CouponSnapshot` + `couponId`，是一处定义、自然导出，不是第二套拼装。

**推论（我认为这是裁定第 9 条的必然结果，但仍单独列出以便追认）**：
既然两个金额字段在领取快照上，**结算时的门槛判定与抵扣取值就以「领取那一刻的快照」为准**，
而不是读券模板的当前值。这与该类型既有的自述一致
（`lib/types/coupon.ts:23`：「领取那一刻的券面内容，之后券的文案改了不影响已领取的记录」）。
平台随后调低某张券的面额，**不追溯**已领取未使用的券。

> ⚠️ **这是我从裁定推导出来的、不是裁定明文的一处**。若产品口径是「以券模板当前值为准」
> （即改券立即影响已领取未使用的券），请指出——改法很小（取值改读券模板），但要现在定。

#### D-P1-4-3｜门槛基数是 `originalAmount`

裁定第 2 条明文。**不是**分账基数（`companionRevenueBaseAmount`）、**不是**实付。
三者当前数值相同，但 `lib/constants/orderAmount.ts:9-16` 明确把「原价」与「分账基数」
当作两个概念，因此这里显式用原价，并把「门槛看原价」写进测试。

#### D-P1-4-4｜抵扣 = `discountAmount`，但**夹到 `originalAmount`**

裁定第 2 条要求同时成立 `couponDiscountAmount <= originalAmount` 与 `actualPaidAmount >= 0`。
`min(discountAmount, originalAmount)` 是保证这两条**结构性成立**的最小手段：
不需要再在别处补一次判断，也不可能出现负数实付。
**它不是「静默归零」**：归零只发生在抵扣本身就为 0/负的坏数据上，而那时没有任何金额被减掉。

#### D-P1-4-5｜券不可用一律**服务端拒绝**，不降级

未达门槛 / 已停用 / 已过期 / 尚未开始 / 类型不可计算 —— 五种情况**全部拒绝下单**（400 带原因）。
裁定第 2 条只对「未达门槛」写明了拒绝，其余四种沿用同一形状：
让「券没生效」永远表现为一句明确的报错，而不是一张悄悄变贵的订单。

#### D-P1-4-6｜preview 与下单**共用同一个判定函数**；preview 不抛错、下单硬拒绝

cmd 测试第 10 条要求「preview 与最终创建一致」。做法是两者调用**同一个纯函数**
（`resolveCouponApplication`），因此判定不可能分叉。

**失败模式刻意不同**（与仓库既有惯例一致，见 `checkout.ts` 里「游戏 ID 只在正式下单校验」）：
preview 把判定结果**原样返回**给界面（`applicable` + `reason`），页面据此**禁止支付**并显示原因；
正式下单则**抛 400**。两者判的是同一件事，只是一个用来渲染、一个用来拦截。

#### D-P1-4-7｜一单一券

`CheckoutSelection` 只有一个 `couponClaimId` 字段（选填）。裁定第 4 条：
一单最多 1 张、券之间不可叠加。**不建**任何叠加/互斥框架——裁定明令本轮不建促销叠加系统。

#### D-P1-4-8｜核销发生在**支付成功的原子区段内**

裁定第 5 条的三个约束一起决定了位置：

- 「核销必须发生在真实成功形成订单/支付结果的**原子业务流程**中」
  ⇒ 与 `buildOrder` 同一段同步代码（`mockPaymentRepository.confirmPaymentRequest` 的原子区段）。
  该区段已有先例：订单与派单在那里同时诞生（`checkout.ts:296-302` 明确拒绝「分两步」）。
- 「preview 不消耗」⇒ preview 是纯读，不写任何状态。
- 「下单/支付失败不得把券永久标记 used」⇒ 核销只在 `status === "success"` 的分支里发生；
  失败/取消分支不碰券。重复确认走的是「已是终态就直接返回」的早退路径，**因此天然不会二次核销**。

#### D-P1-4-9｜原子区段在**建单之前**复查券仍可用

否则存在一个真实的双花窗口：用户对同一张券创建**两笔**待支付请求（不同幂等键），
两笔都支付成功 ⇒ 同一张券被核销两次，违反裁定第 5 条「只能成功核销一次」。

做法：`status === "success"` 分支中，**在调用 `buildOrder` 之前**复查该 claim 仍为 `unused`
且属于该请求的用户；不可用则**抛错**。抛错点在任何 `set` 之前，因此不会留下半成品状态。
（`buildOrder` 不是纯函数——它会写派单记录——所以检查必须在它之前，不能之后。）

#### D-P1-4-10｜`Payment.amount` 必须是**实付**（⚠️ 顺带修掉一处既有隐患）

`lib/data/mockPaymentRepository.ts` 现在写的是 `amount: request.totalAmount`。
接入券之后 `totalAmount` 是**原价**，用它当支付金额就等于**按原价扣款却给优惠**。
改为「实付」= `totalAmount − couponDiscountAmount`。无券时两者相等，因此无券链路零变化。

#### D-P1-4-11｜订单券快照形状

```ts
type OrderCouponSnapshot = {
  claimId: string;          // 被核销的那张 claim（见下）
  couponId: string;         // 裁定第 9 条要求
  name: string;
  formKey: CouponFormKey;
  thresholdAmount: number | null;
  discountAmount: number;
  valueLabel: string;
  conditionLabel: string;
};
```

裁定第 9 条说「**至少**冻结」上列字段，因此这里多一个 `claimId`——
它是「这一单消耗了哪张券」的**唯一可追溯键**，`Order.coupon` 有了它才回答得了
「这张券被哪一单用掉了」。不放金额以外的运营字段，保持最小。

#### D-P1-4-12｜退款不退券

裁定第 6 条。实现上是「**什么都不做**」：退款路径不读券、不写 claim，
券保持 `used`。退款金额继续 = `floor(actualPaidAmount × refundRateBp / 10000)`（P0-15），
**不引入** `originalAmount` 参与退款公式的任何一处。测试要钉住「退款后 claim 仍是 used」
与「退款额以上限 actualPaidAmount 封顶」。

#### D-P1-4-13｜经济规则零变化

裁定第 10 条。`resolveCompanionRevenueBase()` **不接收**券参数（`orderAmount.ts:94`），
因此「券不降低打手理论基础」是**结构性**的，不靠调用方自觉。
`clubNetIncome` 继续不夹到 0（`orderAmount.ts:67-72`）。本轮**不修改**这两处。

#### D-P1-4-14｜三处**用户可见**的「券不参与结算」文案必须改（否则变成假话）

| 位置 | 现在写的 | 处理 |
|---|---|---|
| `lib/constants/coupons.ts` `COUPON_MOCK_NOTICE` | 「优惠券当前**不参与结算**，领取后不会改变订单金额，也不能核销」 | **必须改写**——它是渲染在领券页上的用户可见文案，本轮起为假 |
| `lib/types/coupon.ts:6-14` 头注释 | 「刻意不参与任何金额计算……任何『顺手算一下能减多少』都是提前替产品做了决定」 | 改写为新的边界：**只有 `threshold` 参与**，另两种仍不参与 |
| `lib/services/coupons.ts:32` 硬规则第 4 条 | 「**优惠券不参与结算**。本文件没有任何金额运算」 | 该文件确实仍不做金额运算，但话要改准：金额在结算服务里算 |

⚠️ 头两条是**用户看得见的字**，不是内部注释：留着就是让界面骗人。

### 7.2 需要产品负责人**追认**的两处（我已按上述口径实现，可低成本回退）

| # | 我采用的 | 另一种可能 | 影响面 |
|---|---|---|---|
| A | **停用的券不能再被使用**（结算时读**券模板当前**的 `enabled`） | 领取时已启用的券，即使后来停用也仍可使用 | 一个 if 的分支 + 对应测试 |
| B | **以领取快照为准**定价（见 D-P1-4-2） | 以券模板当前值为准（改券立即影响未使用的已领取券） | 取值来源换一处 + 对应测试 |

两处裁定都没有明文。我按「更保守、且与仓库既有快照惯例一致」的方向选了左边，
并在 `04-acceptance.md` 里列为待追认项。**若口径相反，改动都很小。**

### 7.2.1 产品追认（2026-09-29）：A / B **两处都按现状正式确认**

> 本节是**批注**：上面 §7.2 的原文一字未改，它是当时的记录。追认的结论记在这里。

产品负责人 2026-09-29 对本轮 §六 的两处待追认项给出正式裁定：

| # | 裁定 | 状态 |
|---|---|---|
| A | **停用的券不能再使用**——结算时读的是券模板**当前**的 `enabled` | ✅ **追认**（RESOLVED） |
| B | **已领取券以领取时的 `CouponSnapshot` 定价**——改券不影响已领取的券 | ✅ **追认**（RESOLVED） |

原话：「**A / B 不需要统一成同一个时间语义。这是正式产品规则。**」

这句话是本条追认里**唯一需要被后来人读懂的部分**：A 看的是「**现在**还能不能用」，
B 看的是「**当初**答应减多少」。两者不是同一个时间语义，而这**不是**疏忽——
「这张券此刻有没有效」本来就该问当下，「这张券能减多少钱」本来就该问当初。
把两者统一到同一个时点，反而会在另一头出错。

因此本轮**不再因 A / B 修改任何代码**：

- `lib/services/checkout.ts` 的可用性判定与 `CouponSnapshot` 定价取值**保持原样**；
- 相关测试**保持原样**（它们钉的正是上面这两条）；
- P1-4 的状态**保持 `AWAITING_ACCEPTANCE`**，等待人工 UI 验收——追认解除的是
  这两条**口径上的待定**，不是把本轮标成 DONE。

`04-acceptance.md` 的 §六 同批改为「已追认」，不再读作待办。

### 7.3 §三 八问的逐条关闭

| 问 | 由裁定第几条关闭 |
|---|---|
| 1 券形态与面额语义 | 第 1 条（只有 threshold；两个整数字段） |
| 2 门槛 | 第 2 条（基数是 originalAmount；未达门槛拒绝） |
| 3 适用范围 | 第 3 条（全场券，不做 scope） |
| 4 叠加与排他 | 第 4 条（一单一张，不叠加） |
| 5 使用限制 | 第 5 条（每用户每券一次；核销一次；核销位置）+ 第 6 条（退款不退券） |
| 6 发券流程 | 第 7 条（保持现状） |
| 7 有效期时长规则 | 第 8 条（绝对有效期，不做领取后 N 天） |
| 8 券快照粒度 | 第 9 条（七字段清单 + 金额域 couponDiscountAmount） |

**§三 已无 OPEN 项。** §5.2 里标 ⛔ BLOCKED 的四项（有券 / 券快照 / 门槛边界 / 有券展示）
与标 ◐ 的四项自本裁定起解除，回到 `cmd_p1-4.md` 的 18 项全清单。

---

# 八、验收整改轮（2026-09-29）

人工验收的结论是 **P1-4 暂不通过**，并**新增了一批正式产品规则**。
原始指令逐字保存在 `01-prompt.md` 的「追加：P1-4 验收整改轮原始指令」一节
（协议 §六：原始档案不加工）。本节只记录**规范化后的可执行规则**与**我自行作出的技术决策**。

## 8.1 被本轮推翻的旧决定

### D-P1-4-12｜「退款不退券」

### Decision V1（2026-09-29 首次交付）

退款一律不退券——券已经核销，退款只退钱。

Status: **SUPERSEDED**

### Decision V2（2026-09-29 验收整改轮）

**退款是否返券，由「订单历史上是否曾经被承接」单独决定**，与退款比例、退款瞬间的
`Order.status` 都无关。

| 订单历史 | 退款后 |
|---|---|
| **从未**进入 `accepted` | **返券**：原 `CouponClaim` `used → unused`，清 `usedAt` |
| **曾经**进入 `accepted` | **不返券** |

`accepted` 的判定**不看来源**：打手自己接的、客服直接指定/换人的，**都算**被承接。
因此**不得**复用 P1-5 排行榜的 `acceptedVia === "companion"` 来判断返券
（指令 §一.3 明文）。

Status: **CURRENT**

> ⚠️ V1 是**错的**，不是「当时不得已」：它把「券核销了」当成「券用掉了」，
> 而一张从未被任何人承接、钱又全额退回的订单，用户并没有因此得到任何服务。
> 保留这段历史是因为它确实交付过，且首次验收的 E 组用例是按 V1 写的。

## 8.2 本轮形成的可执行规则

| # | 规则 | 指令出处 |
|---|---|---|
| R1 | 返券判据 = `Order.everAcceptedAt !== null`（唯一判据） | §一 |
| R2 | 返券**只恢复已有 Claim**，**不得新建**一张重复券 | §一.1 |
| R3 | 原订单的 `coupon` 快照、`actualPaidAmount`、`couponDiscountAmount` **一个都不许动** | §一.1 / §二 |
| R4 | 返还是「**未使用资格**」：仍须过 `enabled` / `validTo` / `thresholdAmount` 三道当前合法性 | §三 |
| R5 | Admin 可向**指定 User** 发放指定 `enabled` 模板的券 | §四 |
| R6 | self-claim 的「一模板一次」**只约束 `source = self_claim`**；Admin grant 不受限、可重复发 | §五 / §六 |
| R7 | 每次 grant 生成**独立 Claim**，各自 `unused → used` 且只能核销一次 ⇒ checkout 必须按 **`couponClaimId`** 识别 | §五 |
| R8 | `source = "self_claim" \| "admin_grant"` + 最小审计 `grantedByAdminId` | §六 |
| R9 | snapshot 决定「这张券是什么」；当前 `enabled` 决定「平台现在允不允许用」 | §七 |
| R10 | 账户页只有「`unused` ∧ `formKey === threshold` ∧ 快照在有效期 ∧ 模板当前 `enabled`」才是**可用于结算**；`discount` / `gift` 可展示但须写「暂不可用于结算」 | §九 |
| R11 | checkout：达门槛 → 可选；未达门槛 → **展示但禁用 + 写明还差多少**；真正没有任何可参与结算的 Claim 才显示「暂无可用优惠券」 | §十 |
| R12 | 服务端仍是最终真值：八项复查，**只信前端传的 `couponClaimId`** | §十一 |
| R13 | 核销与建单同一同步原子区段；**退款实际成功之后**才恢复 Claim | §十二 |

## 8.3 我自行作出的技术决策（不改变业务结果，不请示）

### T1｜「曾经被承接」用一个**从不清空**的 `Order.everAcceptedAt` 落库

**问题**：`Order.acceptedAt` 在回公共池时会被 `applyOrderAcceptanceReleased()` 清成 `null`
（那条清空本身是对的，见它的注释：残留会让 `paid` 单在用户端渲染成「已接单」）。
派单记录上的 `acceptedByCompanionId` / `acceptedVia` 同样被 `applyDispatchToPublic()` 清空。
`CompanionAcceptEvent` 按 §一.3 明令不得用于此判断。

**结论**：既有字段**没有一个**能回答「历史上是否曾经被承接」——这不是「懒得找」，
是四个候选逐条排除后的结果：

| 候选 | 为什么不能用 |
|---|---|
| `Order.acceptedAt` | 回池即清空 |
| `Dispatch.acceptedByCompanionId` / `acceptedVia` | 回池即清空 |
| `CompanionAcceptEvent` | §一.3 明令不得复用；且客服直换根本不写它 |
| `CompanionReleaseRecord` | 只在**退出履约**时写一条：当前处于 `accepted` / `serving` / `completed` 的单**一条都没有** |

因此新增 `Order.everAcceptedAt: string | null`，由 `applyOrderAccepted()` 写
`order.everAcceptedAt ?? input.at`（`??` 就是「只写第一次」），
**任何路径都不清空**。它是 R1 的唯一判据。

### T2｜不设 `grantedAt`，`claimedAt` 就是发放时刻

指令 §六 举例写的是「`claimedAt` / `grantedAt`」。两个字段记同一件事会造出**第二份真值**
（本仓库在 P0-15 已经为 `platformBorneAmount` 立过这条规矩）。
因此只保留既有的 `claimedAt`（它就是这张 Claim 的产生时刻，两种来源通用），
另加**只有它有意义的那一项**审计字段 `grantedByAdminId`。

### T3｜账户页与 checkout 共用**同一个**前置判定函数，不写第二个口径

§八 的根因就是「两处各有一套可用性口径」。修法不是把两套口径调成一致，
而是**只留一套**：把 `resolveCouponApplication()` 拆成
「前置闸（used / disabled / not_started / expired / unsupported_form / invalid_data）」
+「门槛闸」。账户页只用前置闸（它没有订单金额），checkout 用两段。
这样「账户说可用、checkout 说不可用」在结构上不可能再出现。

### T4｜未达门槛的展示复用既有 `threshold_not_met` 通道，不新增字段

`loadCheckoutCoupons()` 本就保留 `applicable + threshold_not_met` 两类，
只是文案不够明确。本轮只改文案（写明「还差多少」），选择链不变。

### T5｜`source` 是**必填**字段

与 P1-5 的 `acceptedVia` 同一课：可选字段会被新写入路径静默漏掉。
必填之后，任何一处新增的 Claim 构造点**编译期**就必须声明来源。
`.mjs` 测试夹具不受类型检查，是这条保证唯一的漏洞（登记在 03-delivery.md 已知局限）。
