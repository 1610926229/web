# Acceptance

Round: P0-6
Status: PENDING

> 编码完成时只生成 Checklist，**不提前写「验收通过」**（`development-workflow.md` §十七）。
> 全部做完请在「User Result」写明结果。

## Manual Acceptance Checklist

> 编号步骤 + 预期结果。**每条都可以当场做出来，不需要读代码以外的推断。**
> A / B / C 三组不用改任何代码；D 组需要先在 Mock 环境跑出一张订单。

### A. 四道自动闸门（先做这步）

1. `pnpm test`
   预期：`tests 1094` / `pass 978` / `fail 0` / `skipped 116`。
   ⚠️ `skipped 116` 是未设 `APP_BASE_URL` 时整组跳过的 HTTP 用例，**不是通过**。
2. 起一个**本轮构建**的服务：`pnpm build && pnpm start -p 3213`（建议用新端口，先
   `netstat -ano | grep LISTENING | grep -E ":(3210|3211|3212|3213)\b"` 确认空闲，避免测到上一轮残留进程），
   另开一个终端跑 `APP_BASE_URL=http://localhost:3213 pnpm test`
   预期：`tests 1094` / `pass 1094` / `fail 0` / **`skipped 0`**。
   做完请停掉该服务，并用 `netstat -ano | grep LISTENING | grep :3213` 确认端口已释放。
3. `pnpm typecheck`
   预期：无输出、退出码 0。
4. `pnpm lint`
   预期：无输出、退出码 0。（`next lint` 在 Next 16 已移除，这里走 ESLint CLI。）

### B. 六处交付物（对着文件看，不用跑）

5. `lib/constants/orders.ts:94` 的 `ORDER_TRANSITIONS`，逐行核对是否**恰好**是下面五条、
   顺序也一致，且终态写成空数组：
   `paid → accepted, refunded` / `accepted → paid, serving, refunded` /
   `serving → paid, completed, refunded` / `completed → refunded` / `refunded → []`
   ⚠️ 重点看 `accepted` 与 `serving` 两行的**第一条**出边都是 `paid`（回池边在首位）。
6. `grep -rn "applyDispatchToPublic" lib/`
   预期：**三个**命中——定义处 `lib/data/mockDispatchRepository.ts:154`、
   专属池超时清扫 `lib/data/companionDispatchTransaction.ts:433`、
   取消接单 `lib/data/companionOrderTransaction.ts:150`。
   即：回到公共池这个写入器**只有这两个业务出口**，取消接单没有另起一套回池逻辑。
7. `grep -n "await" lib/data/companionOrderTransaction.ts`
   预期：**5 处命中全部落在注释里**（第 25、28、135、231、248 行），
   没有任何一处是可执行的 `await`——这正是原子区段成立的前提。
8. `lib/data/mockPaymentRepository.ts:273` 的 `applyOrderAcceptanceReleased`
   预期：一次写四个字段，且都是「退回去」：
   `status: "paid"` / `acceptedAt: null` / `actualCompanionId: null` / `companion: null`。
   ⚠️ 若只清了 `actualCompanionId`，用户端时间轴会残留「已接单」节点。
9. `lib/data/mockDispatchRepository.ts:154` 的 `applyDispatchToPublic`
   预期：写入对象里含 `acceptedByCompanionId: null` 与 `acceptedAt: null`（第 169、170 行），
   且**不含** `exclusiveCompanionId` / `exclusiveEnteredAt` / `exclusiveDeadlineAt`
   这三个字段（它们必须原样保留——那是「用户当初指定的是谁」的历史事实）。
10. `grep -n "queryOrdersByCompanion" lib/data/mockPaymentRepository.ts`
    预期：过滤条件是 `order.actualCompanionId === companionId`，
    **不是** `exclusiveCompanionId`。后者是「用户指定了谁」，不是「现在谁在履约」。

### C. 三处文档同步不再自相矛盾

11. 下列位置此前写着「未实现 / 还没有清单门禁」，现在应改口为「已实现（P0-6）」：
    - `docs/02-tech-design/api-contract.md:446` —— 门禁清单**共五条**（原为两条）；
    - `docs/02-tech-design/architecture-rules.md:430` —— 同样五条，并点名负向门禁是 `/companion/orders/[id]/start`；
    - `docs/02-tech-design/directory-structure.md` §8.1 —— CURRENT / TARGET 已分开；
    - `docs/02-tech-design/database-schema.md` T4 —— 标题为「部分实现」。
    预期：四处都不再有「不存在 / 未实现」这类**现在时**说法（指 P0-6 范围内已落地的部分）。
12. `docs/03-dev/总需求进度表.md` 里 P0-6 一行
    预期：Status = `🟣 AWAITING_ACCEPTANCE`（**不是** `DONE`——本轮修复已完成、门禁已全绿，
    正在等你人工验收）；并注明「`DONE` 需用户本人说明验收通过 **且** 用户自行完成 Git 提交」。

### D. 一处端到端行为（可选，但最能看见整条链路）

需要先在 Mock 环境有一个**真实打手**。⚠️ **这一段在 DEV-1 之后变简单了**：预置数据里现在有
`u-1022`（夜航）/ `u-1023`（栖迟）两位**一启动就是有效打手**的用户，可以直接用；
下面第 13 步那条「先审核成打手」的老路仍然有效，只是不再是唯一的路。
（本句由 DEV-1 按事实更新——原句写「预置护航的 `userId` 全是 `null`，没有任何预置用户能进
打手工作台」，DEV-1 往种子里补了 `cp-10` / `cp-11` 之后这句话不再成立。**本轮的验收结论
与验收步骤本身一个字没改**，只改了这句已经不成立的事实描述。）

13. `pnpm dev` → `POST /api/auth/mock-login {"userId":"u-1002"}` →
    在后台通过 `ca-1002` 的护航申请 → 在 `/admin/companions/<id>` 上「恢复接单」（新护航默认 `available:false`）。
    （或用 DEV-1 的预置打手：`{"userId":"u-1022"}`，跳过「通过申请 / 恢复接单」两步。）
14. 以 u-1002 打开 `/companion/pool`。预期：卡片上的接单提示是**新版**文案，
    含「可提交原因取消接单」，且**不含**「不能自行退回」。
15. 接一单 → 打开 `/companion/orders`。
    预期：标题「我的订单」+ 说明句 + 一张卡片（订单号 / 已接单 / 商品 / 规格 / 游戏 / 大区 / 下单时间 / 接单时间）
    ⚠️ **卡片上没有金额、没有取消按钮**——金额不在打手端 DTO 里；按钮只长在详情页。
16. 点卡片进详情 → 点「取消接单」→ **不填原因直接点「确认取消接单」**。
    预期：红色报错「请填写取消接单的原因」，**不发请求**；输入只空格也报同样的错。
    ⚠️ 原因框**没有 `maxLength`、占位文字里没有任何字数提示**——需求只冻结了「非空」。
17. 点「再想想」→ 回到初始按钮态。再点开，填原因，**连点两下「确认取消接单」**。
    预期：只发一次请求，成功反馈出现。这一步同时验证幂等键（第二下拿到 `replayed`，不是报错）。
    ⚠️ **预期内的现象（不是 bug）**：此时页面上方状态区仍显示「已接单」，与下方的「取消成功」并存。
    原因是成功态只替换了取消面板那一段，而**刻意不调 `router.refresh()`**——取消之后服务端再查这一单会
    404，刷新会把整页变成「订单不存在」，让刚点完取消的人以为自己把单弄丢了。两害相权取其轻。
    （这一条由 reviewer 提出并确认为有意取舍，见 `03-delivery.md` §15.3 NOTE-2。）
18. 点「返回我的订单」。预期：这一单从列表消失（若没有别的单则显示「你还没有接过订单」），
    且**页面不会被刷成 404**。（取消后刻意不调 `router.refresh()`——否则刚点完取消的人会以为自己把单弄丢了。）
19. 手工把地址改成 `/companion/orders/<刚取消那单的 id>`，再改成 `/companion/orders/<别人的订单 id>`。
    预期：两者都是 **404**、**同一句话**「订单不存在或不可操作」，页面上没有任何能区分它们的信息。
20. 用模拟管理员打开 `/admin/orders/<刚取消那单的 id>`。
    预期：「履约退出历史」区出现一条（护航标识 / 主动取消接单 / 时间 / **原因原文**），
    同时上方「护航」区显示「还没有人接单」——这两块不矛盾（一个回答「现在是谁」，一个回答「之前是谁」）；
    本页**没有任何按钮**（取消历史是只读展示）。
21. 回头看用户端这一单的订单详情。预期：状态回到**等待接单**，且**时间轴上没有残留的「已接单」节点**
    （`acceptedAt` 已被清空）。这条直接验证 B.8 那个「只清一个字段」的坑没有踩。

### E. 客服侧的取消历史（上一版曾记为缺口，已按你的裁定补齐）

> **历史说明**：本清单上一版的 E 组是一个「请你裁定客服落点」的开放问题，
> 理由是本轮把客服入口判成了未定义的产品规则。
> **你在验收阶段明确裁定这不是待确认项**——客服可见性是最新需求已冻结的要求，
> P0-6 必须补齐才能进入人工验收。因此 E 组已改写为可当场执行的验收步骤，
> 原开放问题作废（过程记录见 `02-decisions.md` D6 V3；D6 V2 已标 SUPERSEDED）。

22. **客服在处理一张有取消历史的订单时，能看到这份历史。**
    前置：先按 D 组跑出一张「被打手 accepted 后主动取消」的订单（D.16–D.17）。

    三种进入方式**都要能看见**（这正是没有只挂会话页的原因）：

    a. **会话详情** `app/staff/(console)/conversations/[orderId]/page.tsx`
       预期：订单摘要区下方出现「履约退出历史（只读）」区，含条目。
    b. **投诉详情** `app/staff/(console)/complaints/[id]/page.tsx`
       ⚠️ 关键场景：**该投诉没有关联会话时**（`conversationOrderId` 为 `null`，
       「进入会话」入口不出现）——此时仍然要能看到取消历史。
       （这正是「只挂会话页」不成立的证据。）
    c. **退款详情** `app/staff/(console)/refunds/[id]/page.tsx`
       预期：同上，独立于会话入口。

23. **每条记录恰好只有四项，且不含内部字段。**
    预期：条目呈现 **原打手 / source（来源）/ reason（原因原文）/ createdAt（时间）**。
    ⚠️ 逐项确认**没有**出现：记录 id、actorId、平台净收入、分账比例、管理员内部备注、
    用户 userId、订单备注、游戏账号。
    （DTO 层就没这些字段——见 `lib/types/staff.ts` 的 `StaffCompanionReleaseEntry`。）

24. **只读，客服改不了。**
    预期：这三个页面上**没有任何按钮**能改动这条退出历史；本轮**没有新增任何 Staff API 路由**
    （`tests/staff.test.mjs` 的清单仍为 16 条），客服复用的是既有 `requireStaff()` 只读接口，
    结构上不存在写入口。

25. **用户端与打手端仍然看不到。**
    - 用户端订单详情：**没有**任何「谁曾接单后退出」的信息；
    - 打手端 `/companion/orders/[id]`：取消后由页面设计就 404，其余订单也看不到他人的退出记录；
    - `/admin/orders/[id]` 的「履约退出历史」仍是管理员专属（`canEnterAdminConsole` 未放宽）。

---

## User Result

PENDING —— 等待用户人工验收。

## Issues Found

（待验收后填写）

## Rework

（待验收后填写）

---

## Final Result

PENDING

## Git Commit

（待用户本人提交后填写）
