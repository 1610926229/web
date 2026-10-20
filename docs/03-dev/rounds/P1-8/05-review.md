# P1-8 · 交付前审查

> 审查对象：`P1-8` 全部改动（工作区未提交状态）。
> 审查方式：**两名只读审查员并行**，各自一条轴，互不重复——
> ① 业务规则面（状态机 / 原因 / 重提 / 内容不可改 / 审计 / 权限 / 幂等并发 / 退款解耦 / `R2`）；
> ② 数据真值面（聚合口径 / 假数据退出 / 迁移与兼容 / 测试覆盖缺口）。
> 审查员**未修改任何文件**，全部结论由本轮负责人逐条复核后决定处置；**未采信「应该没问题」式的判断**。

## 结论

| 档 | 数量 |
|---|---|
| `BLOCKER` | **0** |
| `MAJOR` | **0** |
| `MINOR` | **6**（**6 条已全部处置**，见 §二） |
| `NOTE` | 3（已逐条记录，见 §三） |

**达到交付门槛：`0 BLOCKER` / `0 MAJOR`。**

---

## 一、已核实无问题（审查员明确查过的，不是「没查」）

| # | 检查项 | 结论 |
|---|---|---|
| 1 | **状态机（`D7`）** | `REVIEW_STATUS_TRANSITIONS` 恰好五条迁移，无多放行 / 少放行；`ReviewStatus` 独立于 `Order.status`，**未复用订单状态** |
| 2 | **动作可用性** | `canApplyReviewModeration` 同时校验**起点状态**与状态机：`approve` 与 `unhide` 虽同以 `approved` 为终点，起点被 `REVIEW_MODERATION_SOURCE_STATUS` 分开，因此对 `hidden` 点 `approve` 会 400（而不是记成一次「恢复公开」） |
| 3 | **原因必填（`D10`）** | trim 后空串在必填时被拒（只填空格过不了）；长度上限 200 与既有管理端审核意见一致；`approve`/`unhide` 的值**不落库** |
| 4 | **重新提交（`D9`）** | 同一条记录：id / 作者 / 订单 / 快照 / `createdAt` 全不动，只覆盖两个维度与凭证、清空上一轮驳回原因与审核人；并发下第二次重提因状态已非 `rejected` 被原子区段拒掉 |
| 5 | **管理员改不了内容（`D12`）** | 请求体的接收面只有 `idempotencyKey` 与 `reason`；写入面 `ReviewStatusPatch` 只含状态与两个原因字段——`productReview` / `companionReview` / `evidence` / `createdAt` / `updatedAt` **没有接收位置**，塞进来会被直接丢弃 |
| 6 | **`AdminAudit`（`D22`）** | 四个动作名齐全（`review.approve` / `reject` / `hide` / `unhide`），`AdminAuditTargetType` 含 `"review"`；每次**真实变更**写且只写一条；**空操作与幂等重放都不写第二条**；**未建第二套审计** |
| 7 | **审计隐私** | `toReviewAuditSnapshot` **不收**用户正文（`productReview.content` / `companionReview.content`），也不含 `userId` 与昵称；星级进（审核对象本身）、原因进（截断）——与退款 / 投诉快照同口径 |
| 8 | **权限（`D21`）** | 9 个 Route Handler 第一步全部是 `requireUser()` / `requireAdmin()`；服务层不 import `requireAdmin` / `getSessionUser` / `cookies` / `@/lib/auth`，身份只由参数传入；`app/api/companion/**` 与 `app/api/staff/**` 下**零**评价路由（grep 确认） |
| 9 | **公开侧只见 `approved`** | `buildReviewAggregate` 固定按 `status === "approved"` 过滤，**没有会话参数**，因此不存在「传了 userId 就能多看几条」的分支 |
| 10 | **幂等与并发** | `moderateReview` 的原子区段内**无任何 `await`**（重放检查 / 状态判定 / 落库 / 写审计全同步）；用户侧 `createReview` 的原子区段同样无 `await`，并有两套索引（`reviewIdByOrder` 业务键 + `reviewIdByKey` 幂等键） |
| 11 | **退款解耦（`D18`–`D20`）** | `canReviewOrder` 只看 `completedAt`，完全不看退款字段；退款链（`refunds.ts` / `adminRefunds.ts`）对 review 模式 grep **零命中**，不存在「退款映射成 `approved → hidden`」的路径；**未新增**「服务是否完成」类状态 |
| 12 | **`R2`（不删除）** | `OrderReview` 无任何删除方法，四个审核动作与重提全部是**原地改状态** |
| 13 | **聚合单源（`R3`）** | `buildReviewAggregate()` 的**生产**调用点全仓只有一个：`lib/services/reviewAggregates.ts:81`（其余出现处是定义、注释与测试）；外部只经 `loadReviewAggregate` / `loadReviewStatsFor`，调用方为 `catalog.ts` / `companions.ts` / `adminCompanions.ts`，**无绕过** |
| 14 | **聚合口径（`D14` / `D15`）** | 1 位小数；无公开评价给 `null`（**不是 0**）；`reviewCount` 数**维度**；最近最多 3 条 + 截断旗标正确 |
| 15 | **假数据退出（`D17`）** | `Companion` 实体已无 `rating` / `reviewCount` / `reviews`；**全仓确认没有任何地方再从实体读这三个字段**——管理端列表与详情、打手列表、搜索排序都已改走聚合 |
| 16 | **排序未被静默降级** | 打手列表默认排序读 `sortOrder`（不是评分），因此删掉 `rating` **没有**让排序退化成全相等 |
| 17 | **迁移（`R5`）** | 种子的 `build()` 逐条校验：订单存在、作者与订单归属一致、订单已完成且有 `completedAt`、至少一个维度、评打手时订单确有实际履约打手、提交时间晚于完成时间；`productId` / `specId` / 打手 / 快照**全部从订单派生**，未臆造；**没有**把旧的合并 `rating`/`content` 复制进两个维度 |
| 18 | **三条被改的既有断言** | 逐条认定属「**同一断言跟着入参/真值源搬家**」，**不是悄悄放宽**：① 管理端导航清单 13 → 14 个模块并新增 `/admin/reviews`（加法）；② `routes.test.mjs` 的 `toCompanionBase` 断言保留「一个定义 + 两处引用 = 3 次」的计数，只更新入参字面量；③ `adminCompanionManagement.test.mjs` 的「新护航没有评分」改成「实体字段不存在 + 聚合为 `null`」，**把 `averageRating` 改成 `0` 会立刻红**，即「`null` 与 0 分是两件事」这条要求被完整保住 |

---

## 二、`MINOR` 的处置（6 条，全部已处理）

### `M1` · `approve` / `unhide` 实际会「读并校验」`reason`，与文档「不读原因」不符

> 出处：审查员 ①。`lib/services/adminReviews.ts` 对四个动作统一走了 `normalizeReviewReason`，
> 因此给 `approve` 塞一个超过 200 字的原因会得到 400「原因不能超过 200 个字符」，
> 而不是被忽略。与路由注释「请求体里给了 `reason` 也不会被写进任何字段」相矛盾。

**处置：已修。** 改为**只有需要原因的动作才解析这个字段**：
`REVIEW_MODERATION_REQUIRES_REASON[action]` 为假时**根本不读**它（传了不校验、不报错、也不落库）。
「不读」比「读了再丢」更省钱，也更难出错。

**新增回归用例**（带红绿验证）：`不需要原因的动作**根本不读** reason：通过带一个超长原因也照样通过（D10）`
——在没有修复时该用例**红**（返回 400），修复后**绿**。

### `M2` · `rejected → pending` 这条边在两处被写死，没有读状态机

> 出处：审查员 ①。状态机的注释声明 `REVIEW_STATUS_TRANSITIONS` 是「唯一真值源……不允许任何一处
> 自己写 `if (status === "pending")`」，但重提的起点在仓储原子区段与服务层预检里各硬编码了一次。

**处置：已修。** 两处都改为 `canTransitionReviewStatus(status, "pending")`。
当前语义**完全不变**（重提的起点就是 `rejected`），修的是「将来放宽状态机时这两处不会跟着变」。

**新增回归用例**：`重提只能从 rejected 出发：已通过的评价不能靠重提打回待审核（D9 / R2）`
——先断言 `pending` 时被拒，再 `approve` 后断言**仍然**被拒，并断言状态与内容一个字段都没被改回去。

### `M3` · 用户侧提交的幂等快路径不校验 `orderId`：同键换单会静默返回第一条结果

> 出处：审查员 ①。`findReviewByKey()` 命中后直接返回，不核对这条键当时对应的是不是本次请求的订单。
> **失败场景**：同一用户对订单 A 用键 K 提交成功后，再对订单 B 复用键 K → 返回 A 的评价，
> **B 永远评不上且没有任何报错**。管理端的 `takeReplayForAction` 对同一种情形报冲突，两边不对称。

**处置：已修。** 命中幂等键时比对 `byKey.orderId`，不一致 → **400 冲突**
（新增常量 `REVIEW_OPERATION_CONFLICT_MESSAGE`，文案与其它模块的冲突口径一致）。
「同键同单」仍然走重放路径，**不影响**正常重发。

**新增回归用例**（带红绿验证）：`提交的幂等键认单：同一个键用在另一张订单上是冲突，不是安静地返回第一张单的评价`
——未修时**红**，修后**绿**；并额外断言冲突**没有**在另一张单上写出任何东西（条数不变、
那张单上原有的评价原样还在），以及同键同单仍然是重放。

### `M4` · 打手卡片内联了评分格式化，并硬编码「暂无评分」字面量

> 出处：审查员 ②。`components/companions/CompanionCard.tsx` 自己写了一遍
> `rating === null ? "暂无评分" : rating.toFixed(1)`，而唯一真值源是 `formatAverageRating()`。
> 商品侧与打手侧「同一段代码」（`R3`）在这里破了口子。

**处置：已修。** 改用 `formatAverageRating(companion.rating)`。
当前输出与共享函数**字节级一致**，因此这不是行为修复，而是把第二份拷贝去掉。

### `M5` · 一条用例的名字宣称了 `D4` 的负向命题，但数据触发不到那一半

> 出处：审查员 ②。`tests/reviews.test.mjs`「打手维度认实际履约打手，**不认指定打手**」
> 实际只证了「认实际履约」。**核实**：预置里**没有**「指定 A、实际 B、且已完成」的订单，
> 因此「不认指定打手」无法被任何数据触发。

**处置：已加固（不改测试名，补上它宣称的那一半）。**
`Order` 实体上**根本没有** `exclusiveCompanionId`（它在 `Dispatch` 上），且评价写入路径抄的是
`order.companion`——也就是说这条不变量在数据模型上是**结构性**成立的，唯一能出错的地方是
**评价写入路径改去读派单记录**。因此新增用例
`评价的打手快照只来自订单实体：整条写入路径都不读派单记录（D4 / R5）`：
对 `lib/services/reviews.ts` 与 `lib/data/mockReviewRepository.ts` **去掉注释后**扫源码，
断言其中不出现 `exclusiveCompanionId` / `dispatchRepository` / `getDispatchRepository`，
并补上正向断言（快照等于订单实体上的那一位打手）。

⚠️ **没有**为了造反例而新增订单预置：那会改动 `u-1001` 等用户的订单数与消费累计，
连带打破 `bossStats` 的既有断言与 `P1-7` 的验收基线——**为一条 `MINOR` 制造一批 `MAJOR`**。
把「能不能触发」换成「能不能写错」，是这里更精准的覆盖方式。

### `M6` · `api-contract.md` §12.10 混进了优惠券小节的整段注释

> 出处：审查员 ②。§12.10「评价审核」的表格与注释后面，跟着一段讲
> 「六个模板接口」「已停用券、已过期券」「启停只有 `enable`/`disable`」「路径为什么不是
> `/api/admin/coupons`」的文字——它们是 §12.9 的尾巴，被夹在了评价小节里。
> 下一个读文档的人会以为**评价审核有启停接口**。

**处置：已修。** 那段文字移回 §12.9 表格之后（它本来的位置），§12.10 只留评价自己的内容。

---

## 三、`NOTE`（记录在案，不做改动）

### `N1` · 「已经是目标状态」的豁免会吞掉一次新填的原因

对一条**已经** `rejected` 的评价再执行一次 `reject`（目标态 = 当前态），走的是「已是目标状态」
分支：`changed:false`、**不写** `rejectReason`、**不写审计**。因此管理员**无法通过「再驳回一次」
更换驳回原因**。

**不改，理由**：`D7` 冻结的状态机里**没有** `rejected → rejected` 这条边，所以这不是一次合法迁移；
把它当「空操作」与本仓既有的 `setCouponTemplateEnabled` 口径一致（对已经是目标状态的再操作不是错误）。
若产品**确需**「重驳改原因」，那是一条新裁定，需要新增一个动作或明确允许该迁移——
**不属本轮**，也不由开发自行发明。已在 `04-acceptance.md` §C 记下，供验收时判断。

### `N2` · `applyStatusSync` 的文档注释引用了一个它刻意不用的函数

`lib/data/adminReviewTransaction.ts` 的模块注释里有一句「`applyReviewStatus` 的入参
（`ReviewStatusPatch`）里根本没有这些字段的位置」，而该文件的实现**刻意不走**
`mockReviewRepository.applyReviewStatus`（因为它是 `async`，`await` 会让出执行权、原子性当场消失）。
结论没错（写入面确实被类型收窄到只含审核字段），但**引用的函数名不是这里实际用的那个**。
⚠️ 核实：`ReviewStatusPatch` 这个类型本身仍然在 `reviewRepository.ts` 里、并被
`mockReviewRepository.applyReviewStatus` 使用，因此**不是**死类型。

### `N3` · 空态文案「这件商品还没有公开评价。」「这位陪玩还没有公开评价。」刻意不合并

两句话分别写在 `ProductReviews` 与 `ReviewAggregatePanel` 里，没有进
`lib/constants/reviews.ts`。**这是有意的**：商品与陪玩不是一回事，合并成一条常量必然会产生
「商品页说『这位陪玩…』」的错配。**不是遗漏。**

---

## 四、审查后的门禁复算

⚠️ 审查后有 5 处代码改动（`M1`–`M5`）。**门禁全部重跑**，数字见 `03-delivery.md` §3。
两条新增的回归用例做了**红绿验证**：先确认「不修就红」，再确认「修了就绿」——
**没有**把「我写了回归测试」当成「回归测试有效」。
