# P0-6.1 — 打手工作台返回用户端 + 订单池「等待最久优先」

> 协议见 `docs/03-dev/development-workflow.md`。
> 本轮的**来源是 P0-6 / DEV-1 人工验收通过后发现的两个整改项**（2026-09-24 登记为 `NEEDS_FIX`），
> 不是新功能开发。P0-6 与 DEV-1 的历史验收结论（`DONE` / `PASSED`）**不得反向修改**。

Round ID: P0-6.1
Title: FIX-1 打手工作台返回用户端入口 · FIX-2 公共池 / 专属池按「当前池进入时间 ASC」排序
Status: AWAITING_ACCEPTANCE
Depends On: P0-6（accepted 取消 + 回池，`53481ea`）· P0-5（派单 / 接单，`77877e0`）· P0-5.5（订单状态迁移中央定义，`6bd10fc`）· P0-1（公共池超时可配置）· DEV-1（Mock Identity 切换）
Goal: 补齐打手工作台返回用户端的界面入口；把两张订单池的排序真值从「到点时刻」改为「进入**当前这个池子**的时刻」，使「等待最久优先」在公共池时长被后台改过之后仍然成立
Primary Domain: Companion 工作台导航 · Dispatch 池排序 · 派生 DTO 顺序契约
Primary State Transition: **无**（本轮不新增、不修改任何订单 / 派单状态迁移）
Started At: 2026-09-24
Development Completed At: 2026-09-24
Accepted At: 2026-09-24
Git Commit:

> ⚠️ **本轮不引入新的业务状态**：FIX-1 是界面导航，FIX-2 是**只读排序**。
> 派单状态机（`exclusive` / `public` / `accepted` / `timed_out`）、`accepted → serving`、
> 取消逻辑、超时业务规则、资格判定**一律不变**。

---

## 本轮范围（以 `01-prompt.md` 原文为准）

### FIX-1 打手工作台缺少返回用户端的入口

> 当前 `/companion` 进去之后没有任何回到普通用户界面的入口。User 与 Companion 共用同一个
> User Session，因此这里要补的是「界面导航」，**不是**退出登录、不是身份切换、不是第二套认证。

1. 在打手工作台**统一顶栏**上补一个明确的返回入口（文案 `← 返回用户端`），目标固定为用户端主入口 `/`；
2. 入口必须覆盖 `pool` / `exclusive` / `orders` / `orders/[id]`（以及概览页）——**不要每个页面各复制一个按钮**；
3. 点击后**同一个已登录用户保持登录**：会话 Cookie、Mock 身份、护航资格、用户端资料一个都不变；
4. 不得出现：logout、`/api/auth/logout`、清 Cookie、切换 Mock Identity、新建 Companion Auth、
   修改 User / Companion 共用 Session、修改护航资格、跳转到管理员 / 客服工作台。

### FIX-2 订单池排序改为「等待最久优先」

> 列表顶部 = 在当前池中等待最久的订单；越往下 = 越晚进入当前池。

5. 公共池排序真值 = **`publicPoolEnteredAt` ASC**；专属池排序真值 = **`exclusiveEnteredAt` ASC**；
6. 禁止：Map 插入顺序、seed 数组顺序、`Order.createdAt`、把 `publicDeadlineAt` 当主排序键、前端重排；
7. **重新回池用新时刻**：一张 09:00 创建、09:01 首次进入公共池、09:05 被 A 接单、10:30 被 A 取消后重新
   进入公共池的订单，必须按 **10:30** 这个「这一次进入」的时刻参与排序，**不是** `Order.createdAt`；
8. 时刻完全相同时使用**稳定的确定性 secondary key**（沿用既有 `dispatchId` 规则），
   不引入随机顺序、不引入复杂的第二套优先级算法；
9. 审查既有 `compareByDeadline`：不机械保留 deadline 排序；允许拆成语义清晰的 comparator；
   **不得大规模重构 `companionDispatch`**；
10. 服务端是**唯一排序真值源**：客户端不得 `.sort(...)`，若存在前后端重复排序需收敛为服务端一处；
11. 以上各项的回归测试与技术设计文档同步。

---

## 本轮明确不做（`01-prompt.md` §十三）

`accepted → serving` · CompletionSubmission · 打手封禁回池 · 客服主动换人 · 退款新功能 ·
修改 Dispatch 状态模型 · 修改 timeout 业务规则 · 修改 P0-6 取消逻辑 · 开发账号体系 ·
重构整个 Companion 模块。

---

## 档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 本轮原始开发指令（**`docs/03-dev/rounds/cmd_p0-6.1.md` 的逐字副本**，`cmp` 校验一致） |
| `01-prompt-extended.md` | 同一轮更详细的早期长版指令（见下） |
| `02-decisions.md` | Requirement Check 结论与本轮最终执行口径 |
| `03-delivery.md` | 实现结果与验证 |
| `04-acceptance.md` | 人工验收 Checklist 与验收记录 |

> ⚠️ **本轮有两份指令文本，内容一致、详略不同**：
> 用户第一次给出的指令落盘时文件名被压成了 `docs03-devroundscmd_p0-6.1.md`（**GBK 编码**），
> 它是一份 19 节的**长版**；随后用户又在正确路径放了标准命名的 `cmd_p0-6.1.md`（UTF-8）**短版**。
> 按 `cmd_p0-6.1.md` §六「将本文件原样归档到 `01-prompt.md`」的要求，
> **`01-prompt.md` = 短版逐字副本**；长版保留为 `01-prompt-extended.md`（未删改）。
> 两份在业务规则上**没有冲突**，短版是长版的收敛表述；本轮实现以两者**并集**为准。

---

## 批次模式

本轮处于 **`cmd_batch_p0-6.1_to_p0-9.md`** 定义的连续批次中（P0-6.1 → P0-7 → P0-8 → P0-9）：

- 批次在每轮 `AWAITING_ACCEPTANCE` 且满足 batch §四 的 10 条继续条件后，
  **不等待用户逐轮确认，自动进入下一轮**；
- 四轮的 `User Result` / `Final Result` 一律保持 `PENDING`，由用户在 **P0-9 完成后一次性验收**；
  📌 **该统一验收已于 2026-09-24 完成，四轮全部 `PASSED`**（见下方「人工验收」一节）；
- ⚠️ 因此本轮**不会**出现 P0-6 / DEV-1 那样的「验收通过 + 用户本人提交」双门槛收口——
  它停在 `AWAITING_ACCEPTANCE`，等待批次结束后的统一验收。

---

## 人工验收（2026-09-24，批次统一验收）

> 📌 **验收已通过。** 用户本人于 **2026-09-24** 走完 `04-acceptance.md` 的 A–E 五组验收，
> 覆盖 FIX-1（工作台返回入口 + 会话保持）与 FIX-2（公共池 / 专属池排序 + 取消回池用新时刻），
> 并确认**全部通过**：`User Result = PASSED` / `Final Result = PASSED`，`Issues Found` 无。

| 项 | 值 |
|---|---|
| Accepted At | **2026-09-24** |
| User Result | **PASSED** |
| Final Result | **PASSED** |
| Git Commit | （**由用户本人提交**，待填） |
| Status | **仍为 `AWAITING_ACCEPTANCE`** |

> ⚠️ **为什么验收通过了状态还不是 `DONE`**：按 `development-workflow.md` §十七 的「DONE 双门槛」，
> 需要 ① 用户本人说明验收通过 **且** ② 用户本人完成 Git 提交。**② 尚未发生**——
> 整个批次（P0-6.1 → P0-9）的改动至今全部躺在工作区，Claude 全程**零 Git 写操作**。
> 用户本人提交之后，本轮的 Status 才改为 `DONE`。
