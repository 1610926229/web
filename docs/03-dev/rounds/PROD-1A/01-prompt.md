# PROD-1A · 原始指令档案

Round: PROD-1A
Received At: 2026-10-03（跨会话；裁定在下述会话中下达并延续到本轮执行）
Source: User（产品负责人裁定）+ 本轮执行指令

---

## ⚠️ 关于本文件完整性的一则如实声明

`development-workflow.md` §六 要求把提示词**原样**保存、不得总结改写。
本轮的实际情形是：**裁定与指令是在上一段会话中下达的**，执行时上下文已被压缩，
**逐字原文不在本文件作者的可见范围内**（完整会话记录见
`C:\Users\16109\.claude\projects\D--vs-------web\7ebd94a8-4b7f-46c5-993d-d45ae84c6a1c.jsonl`）。

因此本文件按下面的约定编写，**请勿把它当成逐字誊本**：

- 凡以 **`「」` 包裹的句子**，是**当时被明确引用的裁定原文**（在会话摘要中以引文形式留存）；
- 其余为**范围与要点的忠实记录**，语义不变，但**不是**原话；
- **不补写**任何当时没说过的话。宁可留下一处标注，也不要伪造一份看起来完整的原始档案。

这与协议 §十九 的取向一致：档案的价值在于记录真实过程，包括记录本身的缺口。

---

## 一、数据库与数据访问的裁定（逐条）

1. **数据库**：`PostgreSQL`。`「MySQL 不再作为本项目当前候选。」`
   → 要求：**更新所有仍写着 `PostgreSQL / MySQL TBD` 的文档状态。**

2. **数据访问层**：`node-postgres (pg)`。**不使用 ORM**——明确排除 Prisma 与 Drizzle。给的理由（五条）：

   > 「(1) 已有稳定的 Repository 接口层；(2) DB 实现只需要成为新的 Repository 实现；
   > (3) 项目核心难点是跨实体数据库事务，不是 CRUD 生成；(4) 原生 SQL 让事务 / 唯一约束 /
   > 锁语义保持显式；(5) 避免在一个基本能跑的项目上再叠一层 ORM 的 schema / DSL / 生成器抽象。」

3. **迁移**：`「使用：versioned SQL migration files。不要使用运行时 CREATE TABLE IF NOT EXISTS
   代替正式 migration。」`

4. **迁移策略（本轮最重的长期约束）**：W1/W2/W3/W4 分波次开发 PostgreSQL 实现**是允许的**，但：

   > **「禁止在一个跨域事务的参与实体只有一部分迁入 PostgreSQL 时，将该业务链切换到 PostgreSQL。」**

   原则表述为：**「开发可以分波次，active datasource 的切换必须满足事务闭包完整。」**
   迁移期间 Mock 可以继续作为 active datasource。
   **不得**出现 **「同一个业务事务一半写 PostgreSQL、一半写 globalThis Mock store」** 的运行模式。

5. **时间列类型（C8）**：`「timestamptz + 驱动层统一转 ISO」`
   —— 列类型 `timestamptz`（内部存 UTC）；在 `lib/data/pg` 初始化处用 `pg.types.setTypeParser`
   把 `1184` 全局改成返回 ISO 字符串；**仓储边界零改动**、字符串字典序比较原样成立；
   代价是一次模块级全局覆盖。

## 二、PROD-1A 的 16 项 Scope

（1）`pg` 依赖；（2）PostgreSQL Pool；（3）`DATABASE_URL`；（4）明确 dev/test/production 连接策略；
（5）`withTransaction(async tx => …)`；（6）TxHandle / PgClient 抽象；（7）版本化 SQL 迁移运行器；
（8）迁移记账表；（9）dev/test 种子运行器；（10）测试库重置；（11）**生产禁止 seed / reset**；
（12）数据源选择；（13）数据库健康检查；（14）**选 1~2 个事务耦合最低的仓储**做竖切片；
（15）验证「普通仓储」与「事务内仓储」复用**同一个接口**；
（16）验证唯一约束冲突 / 回滚 / 提交。

**明确不在本轮**：`「不要在 PROD-1A 大规模迁 24 个业务 store。」`
其余排除项：微信 OAuth · 微信支付 · 提现 · Redis · Docker 强制化 · ORM · 调度器正式实现。
其中 **`「惰性 sweep / scheduler 单独登记为后续 production blocker，不遗忘。」`**

## 三、竖切片的挑选纪律

> 「选择『不参与复杂跨域资金事务；有真实 read + write；能验证唯一约束；能验证 Repository interface；
> 不会因为只迁它就产生业务半持久化』的 1~2 个实体。**不要为了方便直接选最复杂的 payment/refund。**」

## 四、必须证明的测试矩阵（6 组）

| 组 | 要证明的 |
|---|---|
| Connection | `DATABASE_URL` 缺失 → fail-fast；库不可达 → 清楚的错误 |
| Migration | 空库 → 最新；重复执行幂等；顺序固定 |
| Transaction | 提交 → 写入全在；中途抛错 → 全部回滚；同一事务用同一条连接 |
| Constraint | 唯一约束由**数据库**强制；并发冲突**不得**依赖「先 SELECT 再 INSERT」；冲突后能读回 / 能翻译错误 |
| Seed | dev/test 可种；重置确定；**生产不能种、不能重置** |
| Compatibility | 不改写 Route / Service；仓储接口保持契约；**Mock 与 Pg 在同一份契约测试上给出相同结果** |

## 五、过程纪律

- `「完成 Requirement Check 后，如果存在真正的架构 BLOCKING 决策，一次性列出。否则直接实现 PROD-1A。」`
- **`「禁止任何 Git 写操作。」`**（`add` / `commit` / `push` / `reset` / `restore` / `checkout` / `rebase` / `amend`）
- **`「不得删除断言、skip、retry 或放宽业务要求。」`**
- `P1-8` **不得**由 Claude 自行标 `DONE`，保持 `AWAITING_ACCEPTANCE`。
- 未经用户明确授权，不得删除既有项目文件。
