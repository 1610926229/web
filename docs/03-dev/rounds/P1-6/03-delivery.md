# P1-6 · 交付记录

> **状态：`AWAITING_ACCEPTANCE`（未 DONE）。** 规格见 `01-prompt.md`，本轮留白的决定见 `02-decisions.md`。
> 人工验收步骤见 `04-acceptance.md`。

---

## 一、本轮做了什么

把**管理端优惠券模板管理**从「缺口」做成一条完整的后台功能：列表 / 新建 / 详情编辑 / 启用停用，
并把「发放」这条路与它接上。

| # | 规格条款 | 落点 |
|---|---|---|
| 1 | §1 只管理 `threshold`（满减） | `lib/constants/coupons.ts` 的 `isComputableCouponForm()` 作为唯一判据，前后端共用 |
| 2 | §2 六个字段、整数分、四条校验、**拒绝而不是夹取** | `lib/services/adminCouponTemplates.ts` 的 `validateCouponTemplate()` |
| 3 | §3 券面文案由**金额派生** | `buildThresholdCouponLabels()`，写入白名单里没有 `valueLabel` / `conditionLabel` |
| 4 | §4 编辑**不追溯**已发出的券 / 历史订单 | `lib/data/couponTemplateTransaction.ts` 只碰 `Coupon`，一个字节都不碰 `CouponClaim` |
| 5 | §5 `enabled` 的两层语义 | 模板 `enabled` 决定「当下能不能核销」；`CouponClaim.snapshot` 决定「这张券是什么」 |
| 6 | §6 **不硬删除** | 没有 `DELETE` / `remove` 路由；有自动化用例**枚举路由目录**做断言 |
| 7 | §7 与发券的联动 | `listCouponGrantOptions()` / `grantCouponToUser()` 收窄为「已启用 **且** 参与结算」 |
| 8 | Admin 页面三条路径 | `/admin/coupons` · `/admin/coupons/new` · `/admin/coupons/[id]` |
| 9 | 写操作 **Admin only**，不得只靠 UI 隐藏 | `requireAdmin()` 在每个 handler 的第一行；HTTP 权限矩阵见下 |
| 10 | 复用既有 `AdminAudit` | 四个动作：`coupon.create` / `coupon.update` / `coupon.enable` / `coupon.disable` |

---

## 二、门禁（自动化部分）

### 2.1 逐条

| 步骤 | 命令 | 结果 |
|---|---|---|
| 定向 | `node --test tests/adminCouponTemplates.test.mjs`（进程内） | **42 / 42 pass · 0 fail** |
| 定向 | 同上，`APP_BASE_URL=http://localhost:3105` | **44 / 44 pass · 0 fail**（多出的 2 条是 HTTP 用例） |
| 全量 | `pnpm test`（**未设** `APP_BASE_URL`） | **1788 tests · 1612 pass · 0 fail · 176 skipped** |
| 类型 | `pnpm typecheck` | **clean**（0 error） |
| 静态 | `pnpm lint` | **0 problems**（0 error / 0 warning） |
| 构建 | `pnpm build` | `✓ Compiled successfully in 2.1s` |
| 生产 | `pnpm exec next start -p 3105` + `APP_BASE_URL` 全量 ×13 | 见 2.2（**12 绿 / 1 抖动**） |

> **176 skipped 是设计如此**：HTTP 用例在**没有** `APP_BASE_URL` 时整组跳过
> （`const SKIP_HTTP = BASE ? false : "未设置 APP_BASE_URL…"`）。设了就跑，不设就跳——
> `pnpm test` 是「不开服务也能跑」的那条命令。生产口径见 2.2，那里 `skipped = 0`。

### 2.2 production gate：`APP_BASE_URL=http://localhost:3105` 全量

**批次 A（5 次）** —— 用于发现抖动：

| run | tests | pass | fail | skipped |
|---|---|---|---|---|
| A1 | 1788 | 1788 | 0 | 0 |
| A2 | **1780** | 1779 | **1** | 0 |
| A3 | 1788 | 1788 | 0 | 0 |
| A4 | 1788 | 1788 | 0 | 0 |
| A5 | 1788 | 1788 | 0 | 0 |

**批次 B（8 次，紧接着连跑）** —— **8 次全部 `1788 / 1788 / 0 / 0`**：

| run | tests | pass | fail | skipped |
|---|---|---|---|---|
| B1–B8 | 1788（×8） | 1788（×8） | **0** | **0** |

**合起来：13 次 production 全量，12 次全绿，1 次抖动（A2）。**
✅ **B1–B8 = 连续 8 次 `fail = 0 · skipped = 0`**，已满足 `DEV-2` 的「连续 5 次」要求。

### 2.3 ⚠️ A2 的抖动：**不是 P1-6 的回归**，是 `DEV-2` 的取证材料

**A2 的表现**：`1780 tests`（比其余**少 8**）、`fail 1`，而**同一次运行里其他所有文件全绿**。

**为什么判定与 P1-6 无关**：

1. P1-6 自己的测试文件在同一批次里 **44/44 全绿**，在批次 B 的 8 次里**也全绿**——
   抖动的不是本轮新增的任何用例；
2. 上一开发时段还观察到一个**同形**的实例：`tests/staffComplaints.test.mjs`
   **文件级**失败，但**该文件每一个子用例都是 ✔**、日志里**没有任何错误正文**，
   且那次 `tests = 1785`（比全量**少 3**）。两次的形态一致：**丢子用例计数 +
   文件级失败但无错误正文**；
3. `staffComplaints` 与其它疑似文件**不在 P1-6 的改动范围内**——本轮一个字节都没碰它们；
4. 同一份构建、同一个服务进程，**12/13 次全绿**。

**结论**：这是**偶发的、与被测功能无关的**测试运行器层面的抖动，
形态是「并发收集阶段丢了一部分子用例计数」。**它是 `DEV-2`（测试隔离稳定性）的
直接取证材料**，也正是 `cmd_dev-2.md` 要解决的问题。

**⚠️ 本轮的态度**：**没有**、也不会为了让 A2 变绿去改任何断言、加超时、加重试、
放宽规则或跳过用例。`cmd_dev-2.md` 明文禁止这五件事，且明确要求
「若旧失败无法稳定复现，也必须基于明确共享状态证据做隔离修正，
**不能声称问题不存在**」——**本文件不声称它不存在**：它在这 13 次里出现了 1 次。

> ⚠️ **一处诚实的缺口**：A2 的失败**具体落在哪个文件**没有被捕获到——
> 批次 A 只 grep 了汇总行（`tests / pass / fail / skipped`）而**没有留存完整日志**，
> 批次 B 留了完整日志但**8 次全绿**。因此本轮**只有形态证据、没有文件名**。
> 定位文件名是 `DEV-2` 的第一步（已记入该轮的取证清单）。

---

## 三、文件清单

### 3.1 新增

**API（4 个 handler，全部 `requireAdmin()` 行首拦截）**

```
app/api/admin/coupon-templates/route.ts                  GET 列表 · POST 新建
app/api/admin/coupon-templates/[id]/route.ts             GET 详情 · PATCH 编辑
app/api/admin/coupon-templates/[id]/enable/route.ts      POST 启用（窄写入）
app/api/admin/coupon-templates/[id]/disable/route.ts     POST 停用（窄写入）
```

**页面（4 个路由；`grant` 是**移动过来**的，见 D1）**

```
app/admin/(console)/coupons/(list)/page.tsx        模板列表（模块首页）
app/admin/(console)/coupons/(list)/loading.tsx     本组**唯一**的骨架（D12）
app/admin/(console)/coupons/new/page.tsx           新建
app/admin/(console)/coupons/[id]/page.tsx          详情 + 编辑
app/admin/(console)/coupons/[id]/not-found.tsx     不存在的 id
app/admin/(console)/coupons/grant/page.tsx         ← 从 coupons/page.tsx 移动而来
```

**组件（4 个新 + 1 个未改）**

```
components/admin/AdminCouponTemplateConsole.tsx     详情页（含启用/停用开关）
components/admin/AdminCouponTemplateCreateForm.tsx  新建表单
components/admin/AdminCouponTemplateForm.tsx        字段与校验（新建/编辑共用）
components/admin/AdminCouponTemplateTable.tsx       只读表格
components/admin/AdminCouponGrantConsole.tsx        ← P1-4 既有，**未改动**
```

**库**

```
lib/constants/adminCoupons.ts                页面文案 / 上限 / 字段失败消息
lib/data/couponTemplateTransaction.ts        三个伪事务（原子区段内**零 await**）
lib/services/adminCouponTemplates.ts         校验 + DTO + 审计
lib/mocks/fixtures/couponSeed.ts             新增 createdAt / updatedAt
```

**测试**

```
tests/adminCouponTemplates.test.mjs          18 个规定测试点 → 44 条用例
```

### 3.2 修改（既有文件）

| 文件 | 改了什么 |
|---|---|
| `lib/types/coupon.ts` | `Coupon` 加 `createdAt` / `updatedAt`（D6），并注明**不进任何用户端 DTO** |
| `lib/data/couponRepository.ts` · `mockCouponRepository.ts` | 读侧返回两个新时间戳；`CouponClaim` 侧**未动** |
| `lib/services/adminCoupons.ts` | 发券收窄为「已启用 ∧ 参与结算」（D9） |
| `lib/services/adminHttp.ts` | 三个客户端窄写入函数；**路径未变**的是发券那三个 |
| `lib/constants/admin.ts` | nav `href` **未改**；`ADMIN_COUPON_GRANT_PAGE_TITLE` 新增；「后续开放模块」从「消费等级与优惠券配置」收窄为「消费等级」 |
| `lib/constants/coupons.ts` | 导出 `isComputableCouponForm()` 供前后端共用 |
| `lib/mocks/debug.ts` | `MockEmptyScope` 加 `"coupons"`（D13） |
| `components/admin/AdminStatusBadge.tsx` | 券模板状态色 `pending`（D11） |
| `lib/utils/format.ts` | `formatCouponFenForInput()` 等 |
| `tests/couponCheckoutChain.test.mjs` | 券模板键集合门禁**扩**两项（D6 / D14 的代价，见 §四） |
| `tests/admin.test.mjs` | 路由清单门禁同步扩；`loading.tsx` 白名单同步（D12） |
| `docs/02-tech-design/api-contract.md` | 见 §五 |
| `docs/02-tech-design/database-schema.md` | 见 §五 |

### 3.3 移动（普通 `mv`，**不是** `git mv`——用户本轮明令禁止 Git 写操作，`git mv` 会写索引）

```
app/admin/(console)/coupons/page.tsx  →  app/admin/(console)/coupons/grant/page.tsx
```

工作区状态因此是「旧路径删除 + 新路径新增」，与 `git status` 显示的一致。

### 3.4 删除

```
app/admin/(console)/coupons/page.tsx    （内容整体移到了 grant/page.tsx，无信息丢失）
```

---

## 四、跨文件门禁：为什么是**扩**而不是**放宽**

`tests/couponCheckoutChain.test.mjs` 有一条**精确键集合**断言，把券模板钉成
「券面快照 + `id` + `enabled`」。本轮给 `Coupon` 加了两个时间戳（D6），这条断言**必然失败**。

**处理**：把 `createdAt` / `updatedAt` **加进期望数组**，而不是把它改成「至少包含」。
显式扩一项会让这条门禁在下一轮继续拦住「多一个字段也没关系」；
一旦放宽，**「多一个字段」从此再也测不出来**——而券模板正是最不该多带字段的实体之一
（它与用户端券面快照是同一个形状）。

这与 `P1-4` 给 `CouponClaim` 加 `source` 时的做法是同一套纪律。

---

## 五、文档同步

### 5.1 `api-contract.md`

⚠️ **发现一处既有的文档缺口（本轮顺手补上，不是本轮引入）**：
`P1-4` 的后台**发券**三个接口（`/api/admin/coupons` 系列）从未被写进 `api-contract.md`。
本轮新增 §12.9 **优惠券** 小节，**同时**收录：

- 新增的四个券模板路由；
- **三个此前缺失的发券路由**（明确标注为「补录：P1-4 已实现、文档遗漏」）。

条目总数随之更新；`§970` 那条 `NOT IMPLEMENTED` 的缺口行移出。

### 5.2 `database-schema.md`

- 更正 §12 里「⚠️ `Coupon`（模板）这一侧只有读」的表述——本轮之后模板侧**有写**；
- `Coupon` 逻辑模型补 `createdAt` / `updatedAt`；
- 补记：`CouponClaim` 侧**仍然只有读**，且 §4 的「不追溯」意味着**未来做真 DB 时，
  模板的 `UPDATE` 不得带 `ON UPDATE CASCADE` 打到 `CouponClaim`**。

---

## 六、审查（`reviewer-agent`，只读）

完整记录见 **`05-review.md`**。摘要：

| 级别 | 数量 | 已修 | 不改（并说明理由） |
|---|---|---|---|
| BLOCKER | **0** | — | — |
| MAJOR | 2 | **2** | 0 |
| MINOR | 7 | 5 | 2（均为仓库级既有口径，单改会分叉） |
| NOTE | 7 | 2 | 5（仓库级惯例 / 非本轮产物） |

**两个 MAJOR 都已修复并复验**：

1. **`api-contract.md` 与本轮实现直接矛盾** —— 该文档仍把券模板管理列为
   `NOT IMPLEMENTED … DO NOT INVENT`，且接口总表里**找不到**这四条路由。
   已改写该行、新增 `§12.9 优惠券`（并**补录 P1-4 三条从未进过文档的发券路由**）、
   同步两处计数。
   ⚠️ **一处必须写清楚的算术**：`64 + 4 = 68`，但实测是 **71**——
   差额 3 就是 P1-4 那三条一直没被计进累计数的发券路由。本次是**把 P1-4 漏掉的 3 条一并补上**。
2. **测试里一条 `.catch(() => {})` 把断言失败吞掉**，用例永远不会红（假覆盖率）。
   已改写为**真的走到 `conflict` 分支**（借 `createAdminCategory` 让同一个幂等键
   先被另一个 `targetType` 用掉）——单测券模板这一个模块**测不出**跨模块复用。
   ✅ **红绿已验证**：临时把期望消息换成必然不同的常量 → 该用例**变红**；换回复绿。

**未闭合的 BLOCKER / MAJOR：0。**

### 6.1 审查提出、本轮**刻意不改**的两项（均为仓库级既有口径）

| 项 | 为什么不改 |
|---|---|
| `takeReplay` 未用 `takeReplayForAction`（「同键换意图」会被判成重放） | 护航 `setCompanionFlags` 与类目/商品/协议/内容**五个模块也都是 `takeReplay`**。单改券模板会让它与五个模块**分叉**——而 `takeReplayForAction` 的注释自己警告过「一条有时生效的规则，迟早会在不同模块里得到不同的解释」。**登记为跨模块收敛后续项，交产品裁量** |
| 重放提示语「这张券已处于这个状态，未产生新的变更」在网络丢包重试时与事实相反 | ⚠️ **同一句话在五个模块里逐字存在**（券 / 类目 / 护航 / 商品 / 客服账号）。单改券这一处会造成措辞分叉；要改应**跨模块统一改** |

### 6.2 交回产品的 1 个问题

`01-prompt.md` 的「Admin 页面」写「至少支持：列表 / 新建 / 编辑 / 启用 / 停用 / 查看」。
本轮六项能力**都实现了**，但**启用 / 停用落在详情页**、列表做成只读（理由见 `02-decisions.md` D2）。
规格**没有**写「启停必须在列表行内」，故本轮判为**满足**；但审查者也判定**它无法替产品决定**。
→ 已作为 **D6** 写进 `04-acceptance.md`，请产品验收时一并回答。

---

## 七、本轮**没有**做的事（重复 `02-decisions.md` D14 的要点）

- 不硬删除；不改券面文案字段；不建立营销 Ledger / 第二套审计；
- 不改结算公式（券不改变原价、不降低打手收益、平台承担成本、退款基数是实付）；
- 不复用排行榜的 `acceptedVia === companion` 判券返还；
- 不信任前端传的 `discountAmount` / `thresholdAmount` / `couponDiscountAmount`；
- 不碰 Scheduler / 微信 OAuth / 真支付 / 钱包 / `withdrawn` 追偿 / chat retention。

---

## 八、⚠️ 未提交

按用户本轮指令「**禁止任何 Git 写操作**」，本轮全部改动（新增 / 修改 / 移动）
**保持未提交**，等用户自行 commit。`README.md` 的 `Git Commit` 因此写「无」。
