Round ID: PROD-1A
Title: PostgreSQL 基础层 + 竖切片（选型落地 / 连接与事务 / 版本化迁移 / 种子与重置 / 健康检查 / 两个仓储的真实现）
Status: AWAITING_ACCEPTANCE   # 2026-10-03 —— 已交付，门禁全绿，**等人工验收**。⚠️ 未 `DONE`，不得由 Claude 自行 `DONE`
Depends On:
- P0-15（仓储接口层已稳定，DB 实现才可能只是「再加一个实现」）
- `docs/02-tech-design/architecture-rules.md` §2.4（仓储两种形态）/ §2.5（伪事务适用范围的收窄）
- `docs/02-tech-design/tech-stack.md` §11.1（本轮新增：数据库与数据访问的已裁定口径）
Goal: 让项目**第一次拥有真正的持久化能力**，但**只打通路径、不做全量迁移**——建好连接、事务、版本化迁移、种子/重置、健康检查与数据源切换这六件事，并用 **1~2 个刻意挑选的仓储**证明「换实现不改上层」这句话是真的
Primary Domain: 数据访问基础设施（`lib/data/pg/**`、`db/migrations/**`、`lib/data/*Repository.ts` 的 accessor）
Primary State Transition: 无（不触碰任何业务状态机）
Started At: 2026-10-03
Development Completed At: 2026-10-03
Accepted At: ——（等用户人工验收）
Git Commit: ——（本轮**零 Git 写操作**，改动保留在工作区）

---

## 一句话

**本轮不迁业务，只建地基，并且用一个必须靠并发才能证明的性质来验收地基。**

选型已由产品负责人裁定：数据库 `PostgreSQL`、数据访问 `node-postgres (pg)` 直连、**不用 ORM**、
结构变更走**版本化 SQL 迁移文件**。本轮的产出是这套裁定在代码里的第一次落地。

## 本轮的三个判断

**① 竖切片不选 payment / refund。**
判据是「**不参与跨域资金事务** + 有真实读写 + 能验证唯一约束 + 能验证仓储接口 + 只迁它不会产生业务半持久化」。
`favorite` 与 `suggestion` 满足全部五条；`payment`/`refund` 一条都不满足。
**先迁最复杂的**看起来更「有说服力」，实际上会把「基础层对不对」和「资金逻辑对不对」两件事
搅在一起，一旦出问题无法归因。

**② 迁移纪律比迁移速度重要。**
分波次迁 PostgreSQL **允许**，但**禁止在某个跨域事务的参与实体只有一部分迁入时把该业务链切过去**。
判据是**事务闭包完整**：绝不允许「一半写 PostgreSQL、一半写 `globalThis` Mock store」。
在那之前，Mock 仍是合法的 active datasource。
**本轮交付后，绝大多数业务数据仍在内存里、重启即清空——这不是遗漏，是本轮 Scope 的边界**，
已同时登记为 `🔴 PRODUCTION_BLOCKER`。

**③ 验收标准放在「并发与守卫」上，而不是「能连上库」。**
「能连上」这件事，装完驱动半小时就能做到。本轮真正要证的四条：

| 要证的 | 靠什么证 |
|---|---|
| 唯一约束是**数据库**在管，不是应用在管 | 绕过仓储直接插重复行 → SQLSTATE `23505` |
| 并发下**不会**多写一条（即不靠「先查再插」） | 8 个并发请求各带自己的 id 打同一个业务键 → 恰好 1 行 |
| 破坏性操作**没有可走通的路径** | 传进「一旦被调用就抛错」的执行器，证明守卫在碰库**之前**拦下 |
| 两个实现给出**逐字段相同**的结果 | 同一段快照函数分别问 Mock 与 Pg，`deepEqual` 两份结果 |

## 门禁实测（本机真实输出，非转述）

| 命令 | 结果 |
|---|---|
| `pnpm lint` | **0 problems**（此前遗留在本轮的 3 条 warning 已清零） |
| `pnpm typecheck` | **exit 0** |
| `pnpm build` | **exit 0** |
| `pnpm test`（不起服务器） | **1915 total / 1701 pass / 0 fail / 214 skipped** |
| 生产 `APP_BASE_URL` + 测试库全量 | **1915 / 1915 pass / 0 fail / 0 skipped** |
| `pnpm test:pg` | **48 / 48**（17 纯逻辑常在 + 25 打真库 + 6 契约对照） |

## ⚠️ 交付时工作区并非干净

本轮开工时工作区**已经**带着此前几轮（P1-6 / P1-7 / P1-8）的未提交内容
（65 个已修改的受跟踪文件 + 多组未跟踪目录）。按 `development-workflow.md` §二十，
这里如实声明：**本轮的改动是叠加在这份既有脏状态之上的**，`03-delivery.md` 的文件清单
只列出**本轮真正碰过**的文件。请勿把整份工作区 diff 当作本轮的交付范围。

## 档案

`01-prompt.md`（本轮指令）· `02-decisions.md`（裁定与执行口径）· `03-delivery.md`（交付与验证）·
`04-acceptance.md`（验收清单）。

## 下一轮

⚠️ **不要自动开始下一轮。** 本轮停在 `AWAITING_ACCEPTANCE`。
